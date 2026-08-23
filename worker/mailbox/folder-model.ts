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

function inboxDistributionPredicate(conversationAlias: string) {
  return `${conversationAlias}.has_incoming = 1 and ${conversationAlias}.mailbox_state = 'active'`;
}

const systemFolderPredicateBuilders: Record<
  SystemFolderType,
  (conversationAlias: string) => string
> = {
  inbox: inboxDistributionPredicate,
  sent: (alias) => `${alias}.has_outgoing = 1 and ${alias}.mailbox_state <> 'trash'`,
  archive: (alias) => `${alias}.mailbox_state = 'archive'`,
  spam: (alias) => `${alias}.mailbox_state = 'spam'`,
  trash: (alias) => `${alias}.mailbox_state = 'trash'`,
};

export function systemFolderPredicate(
  systemType: SystemFolderType,
  conversationAlias: string,
) {
  return systemFolderPredicateBuilders[systemType](conversationAlias);
}

export function customFolderPredicate(conversationAlias: string) {
  return inboxDistributionPredicate(conversationAlias);
}

export function folderAggregateJoinPredicate(
  folderAlias: string,
  conversationAlias: string,
) {
  const custom = `(
    ${folderAlias}.kind = 'custom'
    and ${conversationAlias}.folder_id = ${folderAlias}.id
    and ${customFolderPredicate(conversationAlias)}
  )`;
  const system = systemFolderTypes.map((systemType) => `(
    ${folderAlias}.system_type = '${systemType}'
    and ${systemFolderPredicate(systemType, conversationAlias)}
  )`);
  return [custom, ...system].join("\n or ");
}

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
