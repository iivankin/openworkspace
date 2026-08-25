import { mailboxStub } from "../mailbox";

async function deleteMailboxObjects(bucket: R2Bucket, mailboxId: string) {
  const prefix = `mailboxes/${mailboxId}/`;
  while (true) {
    const page = await bucket.list({ prefix, limit: 1_000 });
    const keys = page.objects.map((object) => object.key);
    if (!keys.length) return;
    await bucket.delete(keys);
  }
}

export async function deleteMailboxStorage(env: Env, mailboxId: string) {
  await Promise.all([
    mailboxStub(env, mailboxId).deleteMailboxData(),
    deleteMailboxObjects(env.MAIL_STORAGE, mailboxId),
  ]);
}
