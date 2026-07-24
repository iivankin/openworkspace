import type { Database } from "../db/client";
import {
  installations,
  mailboxMembers,
  mailboxes,
  passkeyCredentials,
  users,
} from "../db/schema";
import { emailDomain, normalizeMailboxAddress } from "../lib/ids";
import { INSTALLATION_ID } from "./constants";

type PersonalAccountInput = {
  userId: string;
  mailboxId: string;
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
      address: normalizeMailboxAddress(input.email),
      displayName: input.name,
      kind: "personal" as const,
      personalOwnerId: input.userId,
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

export async function provisionInstallationAccount(
  db: Database,
  input: PersonalAccountInput & {
    credential?: typeof passkeyCredentials.$inferInsert;
  },
) {
  const account = personalAccountRecords(input);
  const base = [
    db.insert(users).values(account.user),
    db.insert(installations).values({
      id: INSTALLATION_ID,
      domain: emailDomain(input.email),
      ownerUserId: input.userId,
      createdAt: input.now,
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
