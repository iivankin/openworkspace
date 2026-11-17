/**
 * Where a mailbox keeps a message's raw MIME (`rawMimeR2Key`): received mail
 * under its delivery or import id, sent mail under its message id.
 */
export function rawMessageKey(mailboxId: string, id: string) {
  return `mailboxes/${mailboxId}/raw/${id}.eml`;
}

/** A mailbox owns, and may delete, only what it keeps under its own prefix. */
export function mailboxOwnsObject(mailboxId: string, key: string) {
  return key.startsWith(`mailboxes/${mailboxId}/`);
}

/** The mailbox whose prefix holds `key`, if it is a mailbox's object. */
export function objectMailboxId(key: string) {
  return /^mailboxes\/([^/]+)\//u.exec(key)?.[1] ?? null;
}
