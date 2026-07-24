export {
  mailboxStates,
  type MailboxState,
} from "../../shared/mail";

export const systemFolderTypes = [
  "inbox",
  "sent",
  "archive",
  "spam",
  "trash",
] as const;
export type SystemFolderType = (typeof systemFolderTypes)[number];

export const systemFolderPredicates: Record<SystemFolderType, string> = {
  inbox: "c.has_incoming = 1 and c.mailbox_state = 'active'",
  sent: "c.has_outgoing = 1 and c.mailbox_state <> 'trash'",
  archive: "c.mailbox_state = 'archive'",
  spam: "c.mailbox_state = 'spam'",
  trash: "c.mailbox_state = 'trash'",
};

export const customFolderVisibilityPredicate =
  "c.mailbox_state not in ('spam', 'trash')";

/**
 * System folders are views over conversations, not stored folder records.
 * Only user-defined classification folders live in SQLite.
 */
export const systemFolderDefinitions = [
  { id: "inbox", name: "Inbox", systemType: "inbox", sortOrder: 0 },
  { id: "sent", name: "Sent", systemType: "sent", sortOrder: 1_000 },
  { id: "archive", name: "Archive", systemType: "archive", sortOrder: 1_010 },
  { id: "spam", name: "Spam", systemType: "spam", sortOrder: 1_020 },
  { id: "trash", name: "Trash", systemType: "trash", sortOrder: 1_030 },
] as const satisfies ReadonlyArray<{
  id: string;
  name: string;
  systemType: SystemFolderType;
  sortOrder: number;
}>;
