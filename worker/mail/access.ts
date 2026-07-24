import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { mailboxMembers, mailboxes } from "../db/schema";

export async function getMailboxAccess(
  db: Database,
  userId: string,
  mailboxId: string,
) {
  const [access] = await db
    .select({
      id: mailboxes.id,
      address: mailboxes.address,
      displayName: mailboxes.displayName,
      kind: mailboxes.kind,
      canSend: mailboxMembers.canSend,
    })
    .from(mailboxMembers)
    .innerJoin(mailboxes, eq(mailboxMembers.mailboxId, mailboxes.id))
    .where(
      and(
        eq(mailboxMembers.userId, userId),
        eq(mailboxMembers.mailboxId, mailboxId),
      ),
    )
    .limit(1);
  return access ?? null;
}
