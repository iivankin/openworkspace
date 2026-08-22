import { DurableObject } from "cloudflare:workers";
import { and, asc, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/mailbox/migrations.js";
import {
  MAILBOX_REALTIME_UPDATE,
  type MailboxPushJob,
  type MailboxRealtimeClientMessage,
} from "../../shared/mail";
import {
  inboundMessageId,
  MissingRawMimeError,
  prepareInboundEmail,
  prepareUnprocessableInboundEmail,
  UnprocessableInboundEmailError,
} from "../mail/inbound";
import { prepareOutboundDelivery } from "../mail/outbound-delivery";
import {
  suggestParticipants,
  type ParticipantSource,
} from "../mail/participants";
import { buildEmailSearchQuery } from "../mail/search";
import {
  customFolderVisibilityPredicate,
  systemFolderDefinitions,
  systemFolderPredicates,
  type MailboxState,
  type SystemFolderType,
} from "./folder-model";
import {
  conversations,
  emailReadStates,
  emails,
  folders,
  pendingInbound,
  type Email,
  type FolderRecord,
  type NewEmail,
  type NewFolder,
  type PendingInbound,
} from "./schema";
import type { RecipientDeliveryStatus } from "./model";
import { createDb } from "../db/client";
import {
  mailboxMembers,
  sessions,
  users,
} from "../db/schema";

const schema = {
  conversations,
  emailReadStates,
  emails,
  folders,
  pendingInbound,
};
type MailboxDatabase = DrizzleSqliteDODatabase<typeof schema>;
const INBOUND_ALARM_BATCH_SIZE = 1;
const MAX_INBOUND_RETRY_DELAY_MS = 60 * 60 * 1000;
const MAX_INBOUND_RETRY_AGE_MS = 24 * 60 * 60 * 1000;
const PRESENCE_TTL_MS = 60_000;

type MailboxSocketAttachment = {
  userId: string;
  sessionId: string;
  sessionTokenHash: string;
  visibility: "visible" | "hidden";
  presenceUpdatedAt: number;
};

function socketAttachment(socket: WebSocket): MailboxSocketAttachment | null {
  const value = socket.deserializeAttachment();
  if (!value || typeof value !== "object") return null;
  const attachment = value as Partial<MailboxSocketAttachment>;
  if (
    typeof attachment.userId !== "string"
    || typeof attachment.sessionId !== "string"
    || typeof attachment.sessionTokenHash !== "string"
    || !["visible", "hidden"].includes(attachment.visibility ?? "")
    || typeof attachment.presenceUpdatedAt !== "number"
  ) {
    return null;
  }
  return attachment as MailboxSocketAttachment;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function inboundRetryDelay(attempts: number) {
  return Math.min(
    MAX_INBOUND_RETRY_DELAY_MS,
    5_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 10),
  );
}

export type ConversationUpdate = {
  mailboxState?: MailboxState;
  folderId?: string | null;
};

export type ConversationCursorPosition = {
  timelineAt: number;
  emailId: string;
};

export type ConversationListItem = {
  email: Email;
  messageCount: number;
  unreadCount: number;
};

export type SubmitOutgoingResult = {
  outcome: "inserted" | "existing" | "conflict";
  email: Email;
};

export type InboundDeliveryInput = {
  id: string;
  mailboxId: string;
  rawObjectKey: string;
  envelopeFrom: string;
  envelopeTo: string;
  receivedAt: number;
};

export type FolderListItem = {
  id: string;
  name: string;
  kind: "system" | "custom";
  systemType: SystemFolderType | null;
  sortOrder: number;
  totalCount: number;
  unreadCount: number;
};

type MailFolder =
  | (FolderRecord & { kind: "custom"; systemType: null })
  | {
      id: string;
      name: string;
      kind: "system";
      systemType: SystemFolderType;
      sortOrder: number;
    };

type ConversationRow = {
  email_id: string;
  timeline_at: number;
  message_count: number;
  unread_count: number;
};

type FolderCountRow = {
  total_count: number;
  unread_count: number;
};

export type FolderCounts = {
  totalCount: number;
  unreadCount: number;
};

function folderMembership(folder: MailFolder) {
  if (folder.kind === "custom") {
    return {
      predicate: `
        c.folder_id = ?
        and ${customFolderVisibilityPredicate}
      `,
      bindings: [folder.id],
    };
  }
  return {
    predicate: systemFolderPredicates[folder.systemType],
    bindings: [],
  };
}

export type TransportUpdate = {
  state: Email["transportState"];
  messageIdHeader?: string;
  error?: string | null;
};

export class MailboxDO extends DurableObject<Env> {
  private readonly db: MailboxDatabase;
  private readonly state: DurableObjectState;
  private readonly bindings: Env;
  private recentParticipantSources: ParticipantSource[] | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = ctx;
    this.bindings = env;
    this.db = drizzle(ctx.storage, { schema });
    ctx.blockConcurrencyWhile(() => migrate(this.db, migrations));
  }

  fetch(request: Request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const userId = request.headers.get("x-openworkspace-user-id");
    const sessionId = request.headers.get("x-openworkspace-session-id");
    const sessionTokenHash = request.headers.get("x-openworkspace-session-token-hash");
    if (!userId || !sessionId || !sessionTokenHash) {
      return new Response("Authentication required", { status: 401 });
    }
    const requestedVisibility = request.headers.get("x-openworkspace-visibility");
    const visibility = requestedVisibility === "hidden" ? "hidden" : "visible";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      userId,
      sessionId,
      sessionTokenHash,
      visibility,
      presenceUpdatedAt: Date.now(),
    } satisfies MailboxSocketAttachment);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    if (message !== "visible" && message !== "hidden") return;
    const visibility: MailboxRealtimeClientMessage = message;
    const attachment = socketAttachment(socket);
    if (!attachment) return;
    socket.serializeAttachment({
      ...attachment,
      visibility,
      presenceUpdatedAt: Date.now(),
    } satisfies MailboxSocketAttachment);
  }

  webSocketClose(socket: WebSocket, code: number, reason: string) {
    socket.close(code, reason);
  }

  webSocketError(socket: WebSocket) {
    socket.close(1011, "Realtime connection failed");
  }

  async visibleUserIds() {
    const now = Date.now();
    const sockets = await this.authorizedSockets();
    return [...new Set(sockets.flatMap(({ attachment }) =>
      attachment.visibility === "visible"
        && now - attachment.presenceUpdatedAt <= PRESENCE_TTL_MS
        ? [attachment.userId]
        : []
    ))];
  }

  async suppressedPushUserIds(messageId: string, candidateUserIds: string[]) {
    const candidates = new Set(candidateUserIds);
    if (!candidates.size) return [];
    const readUsers = this.db
      .select({ userId: emailReadStates.userId })
      .from(emailReadStates)
      .where(and(
        eq(emailReadStates.emailId, messageId),
        inArray(emailReadStates.userId, [...candidates]),
      ))
      .all();
    const visibleUsers = await this.visibleUserIds();
    return [...new Set([
      ...readUsers.map((row) => row.userId),
      ...visibleUsers.filter((userId) => candidates.has(userId)),
    ])];
  }

  private async authorizedSockets() {
    const sockets = this.state.getWebSockets().flatMap((socket) => {
      const attachment = socketAttachment(socket);
      if (attachment) return [{ socket, attachment }];
      socket.close(1008, "Realtime authorization expired");
      return [];
    });
    if (!sockets.length) return sockets;

    const mailboxId = this.state.id.name;
    if (!mailboxId) {
      for (const { socket } of sockets) socket.close(1008, "Mailbox identity is unavailable");
      return [];
    }
    const sessionIds = [...new Set(
      sockets.map(({ attachment }) => attachment.sessionId),
    )];
    const validSessions = await createDb(this.bindings.DB)
      .select({
        id: sessions.id,
        tokenHash: sessions.tokenHash,
        userId: sessions.userId,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.userId, sessions.userId),
          eq(mailboxMembers.mailboxId, mailboxId),
        ),
      )
      .where(and(
        inArray(sessions.id, sessionIds),
        gt(sessions.expiresAt, new Date()),
        eq(users.status, "active"),
      ));
    const validSessionsById = new Map(
      validSessions.map((session) => [session.id, session]),
    );
    return sockets.flatMap(({ socket, attachment }) => {
      const session = validSessionsById.get(attachment.sessionId);
      if (
        session?.userId === attachment.userId
        && session.tokenHash === attachment.sessionTokenHash
      ) {
        return [{ socket, attachment }];
      }
      socket.close(1008, "Realtime authorization expired");
      return [];
    });
  }

  private async broadcastUpdate() {
    let sockets: Awaited<ReturnType<MailboxDO["authorizedSockets"]>>;
    try {
      sockets = await this.authorizedSockets();
    } catch {
      try {
        sockets = await this.authorizedSockets();
      } catch (error) {
        // Closing forces clients to reconnect and refresh instead of silently
        // losing the only invalidation now that there is no polling fallback.
        for (const socket of this.state.getWebSockets()) {
          socket.close(1011, "Realtime authorization is temporarily unavailable");
        }
        throw error;
      }
    }
    for (const { socket } of sockets) {
      try {
        socket.send(MAILBOX_REALTIME_UPDATE);
      } catch {
        socket.close(1011, "Could not deliver realtime event");
      }
    }
  }

  private publishUpdate() {
    this.state.waitUntil(this.broadcastUpdate().catch((error) => {
      console.error("Could not authorize realtime delivery", error);
    }));
  }

  private queueIncomingNotification(email: Email) {
    if (email.direction !== "incoming") return;
    const sender = email.fromJson[0];
    const job: MailboxPushJob = {
      type: "dispatch",
      mailboxId: this.state.id.name ?? "unknown-mailbox",
      conversationId: email.conversationId,
      messageId: email.id,
      occurredAt: Date.now(),
      sender: sender?.name || sender?.address || "Unknown sender",
      subject: email.subject,
    };
    return this.bindings.PUSH_NOTIFICATIONS.send(job);
  }

  private retryStoredInboundNotification(
    job: PendingInbound,
    now: number,
    error: unknown,
  ) {
    if (now - job.receivedAt.getTime() >= MAX_INBOUND_RETRY_AGE_MS) {
      this.db.delete(pendingInbound).where(eq(pendingInbound.id, job.id)).run();
      console.error(`Stopped retrying notification for inbound delivery ${job.id}`, error);
      return;
    }
    const attempts = job.attempts + 1;
    this.db
      .update(pendingInbound)
      .set({
        attempts,
        nextAttemptAt: new Date(now + inboundRetryDelay(attempts)),
      })
      .where(eq(pendingInbound.id, job.id))
      .run();
    console.error(`Could not queue notification for inbound delivery ${job.id}`, error);
  }

  private async finishStoredInbound(
    job: PendingInbound,
    email: Email,
    now: number,
    announce: boolean,
  ) {
    if (announce) this.publishUpdate();
    try {
      await this.queueIncomingNotification(email);
      this.db.delete(pendingInbound).where(eq(pendingInbound.id, job.id)).run();
    } catch (error) {
      this.retryStoredInboundNotification(job, now, error);
    }
  }

  listConversations(
    userId: string,
    folderId: string,
    limit: number,
    cursor: ConversationCursorPosition | null,
    search: string | undefined,
  ) {
    const folder = this.getFolder(folderId);
    if (!folder) return null;
    const membership = folderMembership(folder);
    const searchQuery = search ? buildEmailSearchQuery(search) : undefined;
    if (search && !searchQuery) return { items: [], next: null };

    const predicates = [membership.predicate];
    const bindings: Array<string | number> = [...membership.bindings];
    if (searchQuery) {
      // Folder membership belongs to the conversation, while a match can be in
      // any message in that conversation.
      predicates.push(`c.id in (
        select conversation_id
        from email_search
        where email_search match ?
      )`);
      bindings.push(searchQuery);
    }
    if (cursor) {
      predicates.push(
        "(c.timeline_at < ? or (c.timeline_at = ? and c.latest_email_id < ?))",
      );
      bindings.push(cursor.timelineAt, cursor.timelineAt, cursor.emailId);
    }
    bindings.push(limit + 1);

    const rows = this.state.storage.sql.exec<ConversationRow>(`
      select
        c.latest_email_id as email_id,
        c.timeline_at,
        (
          select count(*)
          from emails message
          where message.conversation_id = c.id
        ) as message_count,
        (
          select count(*)
          from emails message
          where message.conversation_id = c.id
            and message.direction = 'incoming'
            and not exists (
              select 1
              from email_read_states read_state
              where read_state.user_id = ?
                and read_state.email_id = message.id
            )
        ) as unread_count
      from conversations c
      where ${predicates.join(" and ")}
      order by c.timeline_at desc, c.latest_email_id desc
      limit ?
    `, userId, ...bindings).toArray();

    const pageRows = rows.slice(0, limit);
    const emailIds = pageRows.map((row) => row.email_id);
    const emailRows = emailIds.length
      ? this.db.select().from(emails).where(inArray(emails.id, emailIds)).all()
      : [];
    const emailsById = new Map(emailRows.map((email) => [email.id, email]));
    const items = pageRows.flatMap((row): ConversationListItem[] => {
      const email = emailsById.get(row.email_id);
      return email
        ? [{
            email,
            messageCount: Number(row.message_count),
            unreadCount: Number(row.unread_count),
          }]
        : [];
    });
    const last = pageRows.at(-1);
    return {
      items,
      next: rows.length > limit && last
        ? { timelineAt: Number(last.timeline_at), emailId: last.email_id }
        : null,
    };
  }

  getFolder(id: string): MailFolder | null {
    const system = systemFolderDefinitions.find((folder) => folder.id === id);
    if (system) {
      return {
        ...system,
        kind: "system",
      };
    }
    const custom = this.db
      .select()
      .from(folders)
      .where(eq(folders.id, id))
      .all()[0];
    return custom ? { ...custom, kind: "custom", systemType: null } : null;
  }

  getEmail(id: string) {
    return this.db.select().from(emails).where(eq(emails.id, id)).all()[0] ?? null;
  }

  getEmailByMessageId(messageIdHeader: string) {
    return this.db
      .select()
      .from(emails)
      .where(eq(emails.messageIdHeader, messageIdHeader))
      .orderBy(desc(emails.timelineAt))
      .all()[0] ?? null;
  }

  getConversation(conversationId: string) {
    return this.db
      .select()
      .from(emails)
      .where(eq(emails.conversationId, conversationId))
      .orderBy(asc(emails.timelineAt), asc(emails.id))
      .all();
  }

  getConversationSnapshot(conversationId: string) {
    const conversation = this.db
      .select({
        mailboxState: conversations.mailboxState,
        folderId: conversations.folderId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .all()[0];
    if (!conversation) return null;
    return {
      mailboxState: conversation.mailboxState,
      folderId: conversation.folderId,
      messages: this.getConversation(conversationId),
      readStates: this.db
        .select({
          emailId: emailReadStates.emailId,
          userId: emailReadStates.userId,
          readAt: emailReadStates.readAt,
        })
        .from(emailReadStates)
        .innerJoin(emails, eq(emailReadStates.emailId, emails.id))
        .where(eq(emails.conversationId, conversationId))
        .orderBy(asc(emailReadStates.readAt))
        .all(),
    };
  }

  getAttachment(emailId: string, attachmentId: string) {
    const email = this.getEmail(emailId);
    return email?.attachmentsJson.find((file) => file.id === attachmentId) ?? null;
  }

  suggestRecipients(ownAddress: string, query: string, limit: number) {
    this.recentParticipantSources ??= this.db
      .select({
        fromJson: emails.fromJson,
        toJson: emails.toJson,
        ccJson: emails.ccJson,
        bccJson: emails.bccJson,
      })
      .from(emails)
      .orderBy(desc(emails.timelineAt), desc(emails.id))
      .limit(500)
      .all();
    return suggestParticipants(
      this.recentParticipantSources,
      ownAddress,
      query,
      limit,
    );
  }

  listFolders(userId: string): FolderListItem[] {
    const customFolders = this.db
      .select()
      .from(folders)
      .orderBy(asc(folders.sortOrder), asc(folders.name))
      .all();

    const mailFolders: MailFolder[] = [
      ...systemFolderDefinitions.map((folder) => ({
        ...folder,
        kind: "system" as const,
      })),
      ...customFolders.map((folder) => ({
        ...folder,
        kind: "custom" as const,
        systemType: null,
      })),
    ];

    return mailFolders.map((folder): FolderListItem => {
      const counts = this.countFolder(userId, folder);
      return {
        ...folder,
        ...counts,
      };
    }).sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.name.localeCompare(right.name),
    );
  }

  getFolderCounts(userId: string, folderId: string): FolderCounts | null {
    const folder = this.getFolder(folderId);
    return folder ? this.countFolder(userId, folder) : null;
  }

  private countFolder(userId: string, folder: MailFolder): FolderCounts {
    const membership = folderMembership(folder);
    const counts = this.state.storage.sql.exec<FolderCountRow>(`
      select
        count(*) as total_count,
        coalesce(sum((
          select count(*)
          from emails message
          where message.conversation_id = c.id
            and message.direction = 'incoming'
            and not exists (
              select 1
              from email_read_states read_state
              where read_state.user_id = ?
                and read_state.email_id = message.id
            )
        )), 0) as unread_count
      from conversations c
      where ${membership.predicate}
    `, userId, ...membership.bindings).one();
    return {
      totalCount: Number(counts.total_count),
      unreadCount: Number(counts.unread_count),
    };
  }

  setMessageRead(userId: string, emailId: string, isRead: boolean) {
    const email = this.getEmail(emailId);
    if (!email) return false;
    if (isRead) {
      const readAt = new Date();
      this.db
        .insert(emailReadStates)
        .values({ userId, emailId, readAt })
        .onConflictDoUpdate({
          target: [emailReadStates.userId, emailReadStates.emailId],
          set: { readAt },
        })
        .run();
    } else {
      this.db
        .delete(emailReadStates)
        .where(and(
          eq(emailReadStates.userId, userId),
          eq(emailReadStates.emailId, emailId),
        ))
        .run();
    }
    this.publishUpdate();
    return true;
  }

  setConversationRead(userId: string, conversationId: string, isRead: boolean) {
    const conversation = this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .all()[0];
    if (!conversation) return false;

    if (isRead) {
      this.state.storage.sql.exec(`
        insert into email_read_states (user_id, email_id, read_at)
        select ?, id, ?
        from emails
        where conversation_id = ? and direction = 'incoming'
        on conflict (user_id, email_id) do update set read_at = excluded.read_at
      `, userId, Date.now(), conversationId);
    } else {
      this.state.storage.sql.exec(`
        delete from email_read_states
        where user_id = ? and email_id = (
          select id
          from emails
          where conversation_id = ? and direction = 'incoming'
          order by timeline_at desc, id desc
          limit 1
        )
      `, userId, conversationId);
    }
    this.publishUpdate();
    return true;
  }

  async enqueueInbound(input: InboundDeliveryInput) {
    const receivedAt = new Date(input.receivedAt);
    if (Number.isNaN(receivedAt.getTime())) {
      throw new Error("Inbound delivery has an invalid receipt time");
    }
    if (this.state.id.name && this.state.id.name !== input.mailboxId) {
      throw new Error("Inbound delivery targeted the wrong mailbox object");
    }

    // Schedule first so a committed row can never be stranded without a wake-up.
    await this.scheduleAlarm(Date.now());
    const messageId = inboundMessageId(input.id);
    const queued = this.db.transaction((tx) => {
      const existing = tx
        .select({ id: emails.id })
        .from(emails)
        .where(eq(emails.id, messageId))
        .all()[0];
      if (existing) return false;

      const result = tx
        .insert(pendingInbound)
        .values({
          id: input.id,
          rawObjectKey: input.rawObjectKey,
          envelopeFrom: input.envelopeFrom,
          envelopeTo: input.envelopeTo,
          receivedAt,
          nextAttemptAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: pendingInbound.id })
        .all();
      return result.length > 0;
    });
    return { messageId, queued };
  }

  insertEmail(email: NewEmail) {
    this.db.insert(emails).values(email).onConflictDoNothing().run();
    this.recentParticipantSources = null;
    return this.getEmail(email.id);
  }

  async submitOutgoing(email: NewEmail) {
    return this.state.blockConcurrencyWhile(async () => {
      if (email.direction !== "outgoing" || email.transportState !== "unconfirmed") {
        throw new Error("Only unconfirmed outgoing messages can be submitted");
      }
      if (!email.requestFingerprint) {
        throw new Error("An outgoing request fingerprint is required");
      }
      const submission = this.db.transaction((tx): SubmitOutgoingResult => {
        const existing = tx
          .select()
          .from(emails)
          .where(eq(emails.id, email.id))
          .all()[0];
        if (existing) {
          const sameRequest = existing.direction === "outgoing"
            && existing.requestFingerprint === email.requestFingerprint;
          return {
            outcome: sameRequest ? "existing" : "conflict",
            email: existing,
          };
        }

        tx.insert(emails).values(email).run();
        const inserted = tx
          .select()
          .from(emails)
          .where(eq(emails.id, email.id))
          .all()[0];
        if (!inserted) throw new Error("Outgoing message was not persisted");
        return { outcome: "inserted", email: inserted };
      });
      if (submission.outcome !== "inserted") return submission;
      this.recentParticipantSources = null;
      const result = {
        ...submission,
        email: await this.deliverOutgoing(submission.email.id),
      };
      this.publishUpdate();
      return result;
    });
  }

  async resendOutgoing(id: string) {
    return this.state.blockConcurrencyWhile(async () => {
      const result = this.db
        .update(emails)
        .set({
          transportState: "unconfirmed",
          messageIdHeader: null,
          transportError: null,
          deliveryStatusJson: [],
        })
        .where(and(
          eq(emails.id, id),
          eq(emails.direction, "outgoing"),
          inArray(emails.transportState, ["failed", "unconfirmed"]),
        ))
        .returning({ id: emails.id })
        .all();
      if (!result.length) return null;
      const email = await this.deliverOutgoing(id);
      this.publishUpdate();
      return email;
    });
  }

  seedMailbox(
    folderValues: NewFolder[],
    emailValues: NewEmail[],
    conversationValues: Array<{
      id: string;
      mailboxState?: MailboxState;
      folderId?: string | null;
    }> = [],
  ) {
    this.db.transaction((tx) => {
      for (const folder of folderValues) {
        tx.insert(folders).values(folder).onConflictDoNothing().run();
      }
      for (const email of emailValues) {
        tx.insert(emails).values(email).onConflictDoNothing().run();
      }
      for (const conversation of conversationValues) {
        tx.update(conversations)
          .set({
            mailboxState: conversation.mailboxState,
            folderId: conversation.folderId,
          })
          .where(eq(conversations.id, conversation.id))
          .run();
      }
    });
    this.recentParticipantSources = null;
    return { folders: folderValues.length, emails: emailValues.length };
  }

  updateConversation(conversationId: string, update: ConversationUpdate) {
    const values: ConversationUpdate = {};
    if (update.mailboxState !== undefined) values.mailboxState = update.mailboxState;
    if (update.folderId !== undefined) values.folderId = update.folderId;
    if (!Object.keys(values).length) return 0;

    const result = this.db
      .update(conversations)
      .set(values)
      .where(eq(conversations.id, conversationId))
      .returning({ id: conversations.id })
      .all();
    if (result.length) {
      this.publishUpdate();
    }
    return result.length;
  }

  updateTransport(id: string, update: TransportUpdate) {
    const result = this.db
      .update(emails)
      .set({
        transportState: update.state,
        messageIdHeader: update.messageIdHeader,
        transportError: update.error,
      })
      .where(and(eq(emails.id, id), eq(emails.direction, "outgoing")))
      .returning({ id: emails.id })
      .all();
    return result.length > 0;
  }

  recordDeliveryStatus(
    messageIdHeader: string,
    status: RecipientDeliveryStatus,
  ) {
    const email = this.getEmailByMessageId(messageIdHeader);
    if (!email || email.direction !== "outgoing") return "not_found" as const;
    const existing = email.deliveryStatusJson.find(
      (item) => item.recipient === status.recipient,
    );
    if (existing?.eventId === status.eventId) return "duplicate" as const;
    if (existing && existing.eventAt > status.eventAt) return "stale" as const;

    const next = [
      ...email.deliveryStatusJson.filter(
        (item) => item.recipient !== status.recipient,
      ),
      status,
    ];
    this.db
      .update(emails)
      .set({ deliveryStatusJson: next })
      .where(eq(emails.id, email.id))
      .run();
    this.publishUpdate();
    return "updated" as const;
  }

  async alarm() {
    const now = Date.now();
    await this.processInboundJobs(now);
    await this.scheduleRemainingWork();
  }

  private async processInboundJobs(now: number) {
    const jobs = this.db
      .select()
      .from(pendingInbound)
      .where(lte(pendingInbound.nextAttemptAt, new Date(now)))
      .orderBy(asc(pendingInbound.nextAttemptAt), asc(pendingInbound.receivedAt))
      // MIME parsing can be memory-heavy; the next due row schedules a quick
      // follow-up, so one delivery per wake keeps peak memory bounded.
      .limit(INBOUND_ALARM_BATCH_SIZE)
      .all();
    for (const job of jobs) {
      const messageId = inboundMessageId(job.id);
      const existing = this.getEmail(messageId);
      if (existing) {
        await this.finishStoredInbound(job, existing, now, false);
        continue;
      }

      try {
        const email = await prepareInboundEmail({
          env: this.bindings,
          mailboxId: this.state.id.name ?? "unknown-mailbox",
          job,
          resolveParent: (inReplyTo, references) =>
            this.resolveParent(inReplyTo, references),
        });
        const stored = this.insertEmail(email);
        if (!stored) {
          throw new Error("Parsed inbound email was not persisted");
        }
        await this.finishStoredInbound(job, stored, now, true);
      } catch (error) {
        if (error instanceof UnprocessableInboundEmailError) {
          const fallback = prepareUnprocessableInboundEmail({
            job,
            reason: error.message,
            rawMimeR2Key: job.rawObjectKey,
          });
          const stored = this.insertEmail(fallback);
          if (!stored) {
            throw new Error("Inbound fallback email was not persisted", {
              cause: error,
            });
          }
          await this.finishStoredInbound(job, stored, now, true);
          console.error(`Stored fallback for inbound delivery ${job.id}`, error);
          continue;
        }
        if (now - job.receivedAt.getTime() >= MAX_INBOUND_RETRY_AGE_MS) {
          const fallback = prepareUnprocessableInboundEmail({
            job,
            reason: "Message processing remained unavailable for 24 hours",
            rawMimeR2Key: error instanceof MissingRawMimeError
              ? null
              : job.rawObjectKey,
          });
          const stored = this.insertEmail(fallback);
          if (!stored) {
            throw new Error("Inbound infrastructure fallback was not persisted", {
              cause: error,
            });
          }
          await this.finishStoredInbound(job, stored, now, true);
          console.error(
            `Stored infrastructure fallback for inbound delivery ${job.id}`,
            error,
          );
          continue;
        }
        const attempts = job.attempts + 1;
        this.db
          .update(pendingInbound)
          .set({
            attempts,
            nextAttemptAt: new Date(now + inboundRetryDelay(attempts)),
          })
          .where(eq(pendingInbound.id, job.id))
          .run();
        console.error(`Could not ingest inbound delivery ${job.id}`, error);
      }
    }
  }

  private async scheduleRemainingWork() {
    const nextInbound = this.db
      .select({ nextAttemptAt: pendingInbound.nextAttemptAt })
      .from(pendingInbound)
      .orderBy(asc(pendingInbound.nextAttemptAt))
      .limit(1)
      .all()[0];
    if (nextInbound) {
      await this.scheduleAlarm(
        Math.max(Date.now() + 1_000, nextInbound.nextAttemptAt.getTime()),
      );
    }
  }

  private async deliverOutgoing(id: string) {
    const message = this.getEmail(id);
    if (
      !message
      || message.direction !== "outgoing"
      || message.transportState !== "unconfirmed"
    ) {
      throw new Error("Unconfirmed outgoing message was not found");
    }
    let delivery: Awaited<ReturnType<typeof prepareOutboundDelivery>>;
    try {
      delivery = await prepareOutboundDelivery(this.bindings, message);
    } catch (error) {
      this.updateTransport(message.id, {
        state: "failed",
        error: errorMessage(error),
      });
      const failed = this.getEmail(id);
      if (!failed) throw new Error("Failed message was not persisted");
      return failed;
    }
    try {
      const result = await this.bindings.EMAIL.send(delivery);
      this.updateTransport(message.id, {
        state: "submitted",
        messageIdHeader: result.messageId,
        error: null,
      });
    } catch (error) {
      this.updateTransport(message.id, {
        state: "unconfirmed",
        error: errorMessage(error),
      });
    }
    const delivered = this.getEmail(id);
    if (!delivered) throw new Error("Submitted message was not persisted");
    return delivered;
  }

  private async scheduleAlarm(at: number) {
    const current = await this.state.storage.getAlarm();
    if (current === null || current > at) await this.state.storage.setAlarm(at);
  }

  /**
   * Message-ID is intentionally non-unique. Ordered header arrays decide which
   * locally known copy is the parent; References fall back newest-to-oldest.
   */
  resolveParent(inReplyTo: string[], references: string[]) {
    const candidates = [...new Set([...inReplyTo, ...references])];
    if (!candidates.length) return null;
    const rows = this.db
      .select()
      .from(emails)
      .where(inArray(emails.messageIdHeader, candidates))
      .orderBy(desc(emails.timelineAt))
      .all();
    const byMessageId = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (row.messageIdHeader && !byMessageId.has(row.messageIdHeader)) {
        byMessageId.set(row.messageIdHeader, row);
      }
    }
    for (const messageId of inReplyTo) {
      const row = byMessageId.get(messageId);
      if (row) return row;
    }
    for (const messageId of references.toReversed()) {
      const row = byMessageId.get(messageId);
      if (row) return row;
    }
    return null;
  }
}

export function mailboxStub(env: Env, mailboxId: string) {
  return env.MAILBOX.getByName(mailboxId);
}
