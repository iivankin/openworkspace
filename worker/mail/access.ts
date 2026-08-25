import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { domains, mailboxMembers, mailboxes } from "../db/schema";
import { mailboxAddressSql, mailboxKind } from "../db/mailboxes";

export async function getMailboxAccess(
  db: Database,
  userId: string,
  mailboxId: string,
) {
  const [access] = await db
    .select({
      id: mailboxes.id,
      address: mailboxAddressSql,
      displayName: mailboxes.displayName,
      ownerUserId: mailboxes.ownerUserId,
      cloudflareZoneId: domains.cloudflareZoneId,
      canSend: mailboxMembers.canSend,
    })
    .from(mailboxMembers)
    .innerJoin(mailboxes, eq(mailboxMembers.mailboxId, mailboxes.id))
    .innerJoin(domains, eq(mailboxes.domainId, domains.id))
    .where(
      and(
        eq(mailboxMembers.userId, userId),
        eq(mailboxMembers.mailboxId, mailboxId),
      ),
    )
    .limit(1);
  return access ? { ...access, kind: mailboxKind(access.ownerUserId) } : null;
}
