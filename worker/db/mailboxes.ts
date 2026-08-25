import { and, eq, sql } from "drizzle-orm";
import { domains, mailboxes } from "./schema";
import { mailboxAddressParts } from "../lib/ids";

export const mailboxAddressSql =
  sql<string>`${mailboxes.localPart} || '@' || ${domains.name}`;

// Personal mailboxes sort before shared mailboxes without persisting a
// duplicated kind column. Primary ordering is applied separately by callers.
export const mailboxKindOrderSql =
  sql<number>`${mailboxes.ownerUserId} IS NULL`;

export function mailboxAddress(localPart: string, domain: string) {
  return `${localPart}@${domain}`;
}

export function mailboxKind(ownerUserId: string | null) {
  return ownerUserId ? "personal" as const : "shared" as const;
}

export function mailboxAddressPredicate(address: string) {
  const parts = mailboxAddressParts(address);
  return and(
    eq(mailboxes.domainId, domains.id),
    eq(mailboxes.localPart, parts.localPart),
    eq(domains.name, parts.domain),
  );
}
