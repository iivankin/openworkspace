import type { Database } from "../db/client";
import {
  domains,
  mailboxMembers,
  mailboxes,
  passkeyCredentials,
  users,
} from "../db/schema";
import { createId, emailDomain, mailboxAddressParts } from "../lib/ids";

type PersonalAccountInput = {
  userId: string;
  mailboxId: string;
  domainId: string;
  name: string;
  email: string;
  role: "admin" | "member";
  status: "invited" | "active";
  avatarUrl?: string | null;
  createdByUserId: string;
  now: Date;
};

export function personalAccountRecords(input: PersonalAccountInput) {
  return {
    user: {
      id: input.userId,
      name: input.name,
      avatarUrl: input.avatarUrl,
      role: input.role,
      status: input.status,
      createdAt: input.now,
      updatedAt: input.now,
    },
    mailbox: {
      id: input.mailboxId,
      localPart: mailboxAddressParts(input.email).localPart,
      domainId: input.domainId,
      displayName: input.name,
      ownerUserId: input.userId,
      isPrimary: true,
      createdByUserId: input.createdByUserId,
      createdAt: input.now,
      updatedAt: input.now,
    },
    membership: {
      mailboxId: input.mailboxId,
      userId: input.userId,
      canSend: true,
      createdAt: input.now,
    },
  };
}

export async function provisionBootstrapAccount(
  db: Database,
  input: Omit<PersonalAccountInput, "domainId"> & {
    credential?: typeof passkeyCredentials.$inferInsert;
  },
) {
  const domainId = createId("dom");
  const account = personalAccountRecords({ ...input, domainId });
  const base = [
    db.insert(users).values(account.user),
    db.insert(domains).values({
      id: domainId,
      name: emailDomain(input.email),
      isPrimary: true,
      createdByUserId: input.userId,
      createdAt: input.now,
      updatedAt: input.now,
    }),
    db.insert(mailboxes).values(account.mailbox),
    db.insert(mailboxMembers).values(account.membership),
  ] as const;
  if (input.credential) {
    await db.batch([
      ...base,
      db.insert(passkeyCredentials).values(input.credential),
    ]);
  } else {
    await db.batch(base);
  }
  return account;
}
