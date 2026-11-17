/**
 * Where a mailbox keeps a message's raw MIME (`rawMimeR2Key`): received mail
 * under its delivery or import id, sent mail under its message id.
 */
export function rawMessageKey(mailboxId: string, id: string) {
  return `mailboxes/${mailboxId}/raw/${id}.eml`;
}
