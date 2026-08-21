import { DurableObject } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { drizzle, type DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import migrations from "../../drizzle/mailbox/migrations.js";
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
  emails,
  folders,
  pendingInbound,
  type Email,
  type FolderRecord,
  type NewEmail,
  type NewFolder,
} from "./schema";
import type { RecipientDeliveryStatus } from "./model";

const schema = { conversations, emails, folders, pendingInbound };
type MailboxDatabase = DrizzleSqliteDODatabase<typeof schema>;
const INBOUND_ALARM_BATCH_SIZE = 1;
const MAX_INBOUND_RETRY_DELAY_MS = 60 * 60 * 1000;
const MAX_INBOUND_RETRY_AGE_MS = 24 * 60 * 60 * 1000;

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

  listConversations(
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
        c.timeline_at
      from conversations c
      where ${predicates.join(" and ")}
      order by c.timeline_at desc, c.latest_email_id desc
      limit ?
    `, ...bindings).toArray();

    const pageRows = rows.slice(0, limit);
    const emailIds = pageRows.map((row) => row.email_id);
    const emailRows = emailIds.length
      ? this.db.select().from(emails).where(inArray(emails.id, emailIds)).all()
      : [];
    const emailsById = new Map(emailRows.map((email) => [email.id, email]));
    const items = pageRows.flatMap((row): ConversationListItem[] => {
      const email = emailsById.get(row.email_id);
      return email ? [{ email }] : [];
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

  listFolders(): FolderListItem[] {
    const customFolders = this.db
      .select()
      .from(folders)
      .orderBy(asc(folders.sortOrder), asc(folders.name))
      .all();

    return [
      ...systemFolderDefinitions.map((folder) => ({
        ...folder,
        kind: "system" as const,
      })),
      ...customFolders.map((folder) => ({
        ...folder,
        kind: "custom" as const,
        systemType: null,
      })),
    ].sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.name.localeCompare(right.name),
    );
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
      return {
        ...submission,
        email: await this.deliverOutgoing(submission.email.id),
      };
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
      return this.deliverOutgoing(id);
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
      if (this.getEmail(messageId)) {
        this.db.delete(pendingInbound).where(eq(pendingInbound.id, job.id)).run();
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
        if (!this.insertEmail(email)) {
          throw new Error("Parsed inbound email was not persisted");
        }
        this.db.delete(pendingInbound).where(eq(pendingInbound.id, job.id)).run();
      } catch (error) {
        if (error instanceof UnprocessableInboundEmailError) {
          const fallback = prepareUnprocessableInboundEmail({
            job,
            reason: error.message,
            rawMimeR2Key: job.rawObjectKey,
          });
          if (!this.insertEmail(fallback)) {
            throw new Error("Inbound fallback email was not persisted", {
              cause: error,
            });
          }
          this.db.delete(pendingInbound).where(eq(pendingInbound.id, job.id)).run();
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
          if (!this.insertEmail(fallback)) {
            throw new Error("Inbound infrastructure fallback was not persisted", {
              cause: error,
            });
          }
          this.db.delete(pendingInbound).where(eq(pendingInbound.id, job.id)).run();
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
