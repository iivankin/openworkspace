import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { SessionUser } from "../env";
import { createDb, type Database } from "../db/client";
import { accountApiTokens, users } from "../db/schema";
import { hashToken, randomToken } from "../lib/crypto";
import { createId } from "../lib/ids";

const API_TOKEN_PREFIX = "mcp_";
const MAX_API_TOKENS_PER_USER = 20;
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1_000;

export type AccountApiIdentity = {
  tokenId: string;
  tokenHash: string;
  user: SessionUser;
};

export class AccountApiTokenLimitError extends Error {}

export function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/iu);
  const token = match?.[1]?.trim();
  return token || null;
}

export async function authenticateAccountApiToken(
  binding: D1Database,
  rawToken: string,
): Promise<AccountApiIdentity | null> {
  if (!rawToken.startsWith(API_TOKEN_PREFIX) || rawToken.length > 100) return null;
  const tokenHash = await hashToken(rawToken);
  const db = createDb(binding);
  const [identity] = await db
    .select({
      tokenId: accountApiTokens.id,
      lastUsedAt: accountApiTokens.lastUsedAt,
      id: users.id,
      name: users.name,
      avatarUrl: users.avatarUrl,
      role: users.role,
      status: users.status,
    })
    .from(accountApiTokens)
    .innerJoin(users, eq(accountApiTokens.userId, users.id))
    .where(and(
      eq(accountApiTokens.tokenHash, tokenHash),
      eq(users.status, "active"),
    ))
    .limit(1);
  if (!identity) return null;

  const now = new Date();
  if (
    !identity.lastUsedAt
    || now.getTime() - identity.lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS
  ) {
    try {
      await db
        .update(accountApiTokens)
        .set({ lastUsedAt: now })
        .where(and(
          eq(accountApiTokens.id, identity.tokenId),
          or(
            isNull(accountApiTokens.lastUsedAt),
            lt(
              accountApiTokens.lastUsedAt,
              new Date(now.getTime() - LAST_USED_WRITE_INTERVAL_MS),
            ),
          ),
        ));
    } catch (error) {
      // Usage telemetry must never turn a valid credential into an outage.
      console.error("Could not update account API token usage", error);
    }
  }

  const { tokenId, lastUsedAt: _lastUsedAt, ...user } = identity;
  return { tokenId, tokenHash, user };
}

export async function createAccountApiToken(
  db: Database,
  userId: string,
  name: string,
) {
  const existing = await db
    .select({ id: accountApiTokens.id })
    .from(accountApiTokens)
    .where(eq(accountApiTokens.userId, userId));
  if (existing.length >= MAX_API_TOKENS_PER_USER) {
    throw new AccountApiTokenLimitError(
      `An account can have at most ${MAX_API_TOKENS_PER_USER} API tokens`,
    );
  }

  const token = `${API_TOKEN_PREFIX}${randomToken()}`;
  const row = {
    id: createId("tok"),
    userId,
    name,
    tokenHash: await hashToken(token),
    tokenPrefix: token.slice(0, 12),
    createdAt: new Date(),
  };
  await db.insert(accountApiTokens).values(row);
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt,
    token,
  };
}
