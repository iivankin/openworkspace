import type { Folder, Mailbox, MailFolder } from "./types";

export function mailboxForRoute(
  mailboxId: string | undefined,
  mailboxes: Mailbox[],
) {
  return mailboxes.find((mailbox) => mailbox.id === mailboxId)
    ?? mailboxes[0];
}

export function resolveMailLocation(
  mailboxId: string | undefined,
  params: URLSearchParams,
  mailboxes: Mailbox[],
  folders: MailFolder[] | undefined,
) {
  const requestedMailbox = mailboxes.find(
    (mailbox) => mailbox.id === mailboxId,
  );
  const mailbox = mailboxForRoute(mailboxId, mailboxes);
  const requestedFolder = (params.get("folder") as Folder | null) ?? "inbox";
  const ready = Boolean(mailbox && folders);
  const folderExists = folders?.some((folder) => folder.id === requestedFolder)
    ?? false;
  const folder = folders && !folderExists ? "inbox" : requestedFolder;
  const conversationId = requestedMailbox && folderExists
    ? params.get("conversation") ?? undefined
    : undefined;
  const canonicalParams = new URLSearchParams();
  canonicalParams.set("folder", folder);
  if (conversationId) canonicalParams.set("conversation", conversationId);

  return {
    mailbox,
    folder,
    conversationId,
    ready,
    canonicalParams,
  };
}
