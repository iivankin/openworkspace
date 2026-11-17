/** Types, constants and helpers shared by MailboxDO (index.ts) and its modules. */
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { z } from "zod";

import type { DRAFTS_FOLDER_ID } from "../../shared/folder-order";
import type { MailboxRealtimeClientMessage } from "../../shared/mail";
import type { SenderBlock } from "../../shared/mail-feedback";
import { headerValues } from "../../shared/mail-headers";
import { MAX_IMPORTED_TEXT_CHARACTERS } from "../../shared/mail-import";
import type { ImportPlacement } from "../../shared/mail-import";
import { rawHeaderText } from "../mail/inbound";
import {
  customFolderPredicate,
  folderAggregateJoinPredicate,
  systemFolderPredicate,
} from "./folder-model";
import type { MailboxState, SystemFolderType } from "./folder-model";
import type { MailboxDO } from "./index";
import {
  conversations,
  emailReadStates,
  emails,
  folders,
  mailboxAiConfiguration,
  mailRules,
  pendingInbound,
  pendingObjectDeletions,
  senders,
  unsubscriptions,
} from "./schema";
import type {
  AutoReplySettings,
  Draft,
  Email,
  FolderRecord,
  MailRule,
  PendingInbound,
} from "./schema";

export const schema = {
  conversations,
  emailReadStates,
  emails,
  folders,
  mailboxAiConfiguration,
  mailRules,
  pendingInbound,
  pendingObjectDeletions,
  senders,
  unsubscriptions,
};

export type MailboxDatabase = DrizzleSqliteDODatabase<typeof schema>;

/** The change counter whose inbox counts D1 has (see `syncInboxCounts`). */
export const COUNTS_VERSION_KEY = "inboxCountsVersion";
export const INBOUND_ALARM_BATCH_SIZE = 1;
export const OBJECT_DELETION_ALARM_BATCH_SIZE = 100;
export const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

/** A raw copy not yet in the mail archive waits for the hourly archive retry. */
export const ARCHIVE_WAIT_MS = 60 * 60 * 1000;
export const MAX_INBOUND_RETRY_AGE_MS = 24 * 60 * 60 * 1000;

/** Attempts a delivery may end without an outcome (alarm killed) before it is stored unparsed. */
export const MAX_UNFINISHED_INBOUND_ATTEMPTS = 3;

export const ALARM_WAKE_DELAY_MS = 1000;

export const DAY_MS = 24 * 60 * 60 * 1000;

export type AutoReplyInput = Omit<
  AutoReplySettings,
  "id" | "updatedBy" | "updatedAt"
>;

/** Bounds one emptying or retention pass, so a huge Trash can't hold the object. */
export const RETENTION_BATCH_SIZE = 100;

export const PRESENCE_TTL_MS = 60_000;
export const AI_CONFIGURATION_ID = "default";

/** Per person and mailbox; a runaway client can't fill the mailbox's storage. */
export const MAX_DRAFTS_PER_USER = 200;

/** Set while imported mail has not been announced (counts, realtime, JMAP state). */
export const IMPORT_PENDING_KEY = "import:pending";

/**
 * Custom folders imports created, until a restored settings line or the
 * person orders them.
 */
export const IMPORTED_FOLDERS_KEY = "imported-folders";

/** How long imported mail may wait to be announced when the importer does not finish. */
export const IMPORT_ANNOUNCE_DELAY_MS = 15_000;

/** Browser sessions, authorized against their session on every update. */
export const SESSION_SOCKET_TAG = "session";

/** JMAP EventSource streams held by the Worker; they receive the new state. */
export const JMAP_SOCKET_TAG = "jmap";

/** What a browser session sends: whether its tab is visible. */
export const visibilitySchema = z.enum([
  "visible",
  "hidden",
]) satisfies z.ZodType<MailboxRealtimeClientMessage>;

/** Who a session socket belongs to; it survives hibernation with the socket. */
export const socketAttachmentSchema = z.object({
  userId: z.string(),
  sessionId: z.string(),
  sessionTokenHash: z.string(),
  visibility: visibilitySchema,
  presenceUpdatedAt: z.number(),
});

export type MailboxSocketAttachment = z.output<typeof socketAttachmentSchema>;

/** A session socket's attachment; null for other sockets (JMAP streams carry none). */
export function socketAttachment(
  socket: WebSocket
): MailboxSocketAttachment | null {
  const attachment = socketAttachmentSchema.safeParse(
    socket.deserializeAttachment()
  );

  return attachment.success ? attachment.data : null;
}

export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

export function retryDelay(attempts: number) {
  return Math.min(
    MAX_RETRY_DELAY_MS,
    5000 * 2 ** Math.min(Math.max(attempts - 1, 0), 10)
  );
}

/**
 * The folder a conversation is listed in, as the app names it: its custom
 * folder or Inbox while active, else Archive, Spam or Trash.
 */
export function conversationFolder(place: {
  mailboxState: MailboxState;
  folderId: string | null;
}) {
  if (place.mailboxState !== "active") return place.mailboxState;

  return place.folderId ?? "inbox";
}

/** Whether a delivery has been retried for as long as it may be. */
export function isPastRetryAge(job: PendingInbound, now: number) {
  return now - job.receivedAt.getTime() >= MAX_INBOUND_RETRY_AGE_MS;
}

export function stringListJson(values: string[]) {
  return JSON.stringify([...new Set(values)]);
}

export type DraftInput = Omit<Draft, "userId" | "version" | "updatedAt">;

/** A mailbox's settings in a backup: `backupSettings()` less its drafts. */
export type MailboxBackupSettings = Omit<
  ReturnType<MailboxDO["backupSettings"]>,
  "drafts"
>;

export type SaveDraftResult =
  | { status: "saved"; draft: Draft }
  | { status: "conflict"; draft: Draft | null }
  | { status: "limit" };

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
  hasIncoming: boolean;
  /** The person has a reply draft in this conversation. */
  hasDraft: boolean;
};

/** A page of a folder's list: conversations, or in Drafts the person's drafts. */
export type ConversationPage = {
  items: ConversationListItem[];
  drafts: Draft[];
  next: ConversationCursorPosition | null;
  version: number;
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
  /** Set when this is a member's copy of mail to a workspace mailing list. */
  listAddress?: string;
  receivedAt: number;
};

/** A message's ids in the mailbox it was backed up from. */
export type ImportOriginal = { emailId: string; conversationId: string };

export type ImportMessageInput = {
  /** The import's delivery id: the message is stored as `inboundMessageId(importId)`. */
  importId: string;
  /** Where the route stored the raw message. */
  rawObjectKey: string;
  /** The mailbox's own address, which tells sent mail from received. */
  mailboxAddress: string;
  /** When the message was received; the Date header (then now) without one. */
  receivedAt: number | null;
  placement: ImportPlacement;
  /** A custom folder (by name, created when missing) for a message in the Inbox. */
  folderName: string | null;
  /** The people a received message is read for. */
  seenBy: string[];
  /** The conversation the importer's thread key names; null threads by Message-ID headers. */
  conversationId: string | null;
  /**
   * The ids the message and its conversation had in this mailbox (a
   * backup's): the message still here is a duplicate, and its conversation
   * still here takes it instead of `conversationId`.
   */
  original: ImportOriginal | null;
  /** Null decides by the From address. */
  direction: "incoming" | "outgoing" | null;
};

export type ImportMessageResult =
  | {
      status: "imported";
      id: string;
      conversationId: string;
      /** Why the requested folder was not used, if it was not. */
      folderSkipped: "limit" | "invalid" | null;
    }
  | { status: "duplicate"; id: string; conversationId: string }
  | { status: "unprocessable"; reason: string };

export function clampText(value: string | null | undefined) {
  return value && value.length > MAX_IMPORTED_TEXT_CHARACTERS
    ? value.slice(0, MAX_IMPORTED_TEXT_CHARACTERS)
    : (value ?? null);
}

/** The Date header of a raw message, in ms, if it parses. */
export function headerDate(rawMime: ArrayBuffer) {
  const value = headerValues(rawHeaderText(rawMime), "date")[0];
  const time = value ? Date.parse(value) : Number.NaN;

  return Number.isFinite(time) ? time : null;
}

export type FolderListItem = {
  id: string;
  name: string;
  kind: "system" | "custom";
  systemType: SystemFolderType | typeof DRAFTS_FOLDER_ID | null;
  sortOrder: number;
  totalCount: number;
  unreadCount: number;
};

export type MailFolder =
  | (FolderRecord & { kind: "custom"; systemType: null })
  | {
      id: string;
      name: string;
      kind: "system";
      systemType: SystemFolderType;
      sortOrder: number;
    };

export type ConversationRow = {
  email_id: string;
  timeline_at: number;
  message_count: number;
  unread_count: number;
  has_incoming: number;
};

export type ConversationSnapshotCountRow = {
  message_count: number;
  unread_count: number;
};

export type FolderCountRow = {
  total_count: number;
  unread_count: number;
};

export type FolderListRow = {
  id: string;
  name: string;
  kind: "system" | "custom";
  system_type: SystemFolderType | null;
  sort_order: number;
  total_count: number;
  unread_count: number;
};

export type FolderCounts = {
  totalCount: number;
  unreadCount: number;
};

export function folderMembership(folder: MailFolder) {
  if (folder.kind === "custom") {
    return {
      predicate: `
        c.folder_id = ?
        and ${customFolderPredicate("c")}
      `,
      bindings: [folder.id],
    };
  }

  return {
    predicate: systemFolderPredicate(folder.systemType, "c"),
    bindings: [],
  };
}

export const FOLDER_AGGREGATE_JOIN_PREDICATE = folderAggregateJoinPredicate(
  "folder",
  "conversation"
);

export type TransportUpdate = {
  state: Email["transportState"];
  messageIdHeader?: string;
  error?: string | null;
};

export const MAX_RULES = 100;
export const RULE_TEST_SCAN = 500;

export function ruleView(rule: MailRule) {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    match: rule.match,
    conditions: rule.conditionsJson,
    actions: rule.actionsJson,
    stopProcessing: rule.stopProcessing,
    updatedAt: rule.updatedAt.getTime(),
  };
}

export type InboundScreening = {
  block: SenderBlock | null;
  trusted: boolean;
};

export const LIKE_ESCAPE = (value: string) =>
  value.replaceAll(/[\\%_]/gu, (char) => `\\${char}`);

/** SQL predicate on a lowercased address expression for a block pattern. */
export function blockPatternPredicate(expression: string, pattern: string) {
  if (!pattern.startsWith("@")) {
    return { sql: `${expression} = ?`, bindings: [pattern] };
  }

  const domain = LIKE_ESCAPE(pattern.slice(1));

  return {
    sql: `(${expression} like ? escape '\\' or ${expression} like ? escape '\\')`,
    bindings: [`%@${domain}`, `%.${domain}`],
  };
}

/**
 * What the mailbox's modules work with: its database and storage, its
 * bindings, and the Durable Object's own steps they trigger.
 */
export type MailboxContext = {
  db: MailboxDatabase;
  state: DurableObjectState;
  env: Env;
  /** Tells open clients (realtime, JMAP) the mailbox changed. */
  publishUpdate: () => void;
  announceJmapState: (push?: boolean) => void;
  scheduleAlarm: (at: number) => Promise<void>;
  scheduleRetention: () => void;
  getEmail: (id: string) => Email | null;
  resolveParent: (inReplyTo: string[], references: string[]) => Email | null;
  /** Participant suggestions are read again after a change. */
  forgetParticipants: () => void;
};
