import { eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { domains, identityGroups, users } from "../db/schema";
import { emailDomain } from "../lib/ids";

export async function hasKnownUserIds(db: Database, ids: string[]) {
  if (ids.length === 0) return true;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, ids));
  return rows.length === ids.length;
}

export async function hasKnownGroupIds(db: Database, ids: string[]) {
  if (ids.length === 0) return true;
  const rows = await db
    .select({ id: identityGroups.id })
    .from(identityGroups)
    .where(inArray(identityGroups.id, ids));
  return rows.length === ids.length;
}

export async function domainForAddress(db: Database, address: string) {
  const [domain] = await db
    .select({ id: domains.id, name: domains.name })
    .from(domains)
    .where(eq(domains.name, emailDomain(address)))
    .limit(1);
  return domain ?? null;
}
