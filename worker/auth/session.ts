import {
  and,
  desc,
  eq,
  exists,
  gt,
  lte,
  ne,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createDb, type Database } from "../db/client";
import { pushSubscriptions, sessions, users } from "../db/schema";
import type { AppEnv } from "../env";
import { hashToken, randomToken } from "../lib/crypto";
import { createId } from "../lib/ids";
import { cloudflareClientIp } from "../lib/request";
import { SESSION_COOKIE } from "./constants";
import { AuthRequestError } from "./errors";

const MAX_SESSIONS = 10;
// D1 owns the shorter renewable lease. The long browser cookie avoids rotating
// a bearer from ordinary requests, so a slow response cannot restore an older
// token after a fresh sign-in.
const BROWSER_COOKIE_TTL_MS = 400 * 24 * 60 * 60 * 1_000;

export type SessionCommitInput = {
  authenticatedAt: Date;
  sessionId: string;
  sessionTokenHash: string;
};

export type SessionAtomicAction = {
  precondition: SQL;
  commit: BatchItem<"sqlite">;
  assertCommitted: (result: unknown) => void;
};

export type SessionAtomicActionFactory = (
  input: SessionCommitInput,
) => SessionAtomicAction;

function cookieOptions(request: Request, expires?: Date) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: new URL(request.url).protocol === "https:",
    path: "/",
    expires,
  };
}

function sessionTtlMs(c: Context<AppEnv>) {
  const ttlDays = Number.parseInt(c.env.SESSION_TTL_DAYS, 10) || 30;
  return ttlDays * 24 * 60 * 60 * 1_000;
}

function sessionExpiresAt(c: Context<AppEnv>, from: Date) {
  return new Date(from.getTime() + sessionTtlMs(c));
}

function requestLocation(request: Request) {
  const part = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const cf = request.cf;
  const values = [
    part(cf?.city),
    part(cf?.region),
    part(cf?.country) ?? part(request.headers.get("cf-ipcountry")),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(values)].join(", ") || null;
}

function sessionExists(
  db: Database,
  sessionId: string,
  tokenHash: string,
) {
  return exists(
    db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(
        eq(sessions.id, sessionId),
        eq(sessions.tokenHash, tokenHash),
      )),
  );
}

function insertSession(
  db: Database,
  values: {
    id: string;
    userId: string;
    tokenHash: string;
    userAgent: string | null;
    location: string | null;
    ipAddress: string | null;
    expiresAt: Date;
    createdAt: Date;
  },
  condition?: SQL,
) {
  if (!condition) {
    return db.insert(sessions).values(values).returning({ id: sessions.id });
  }
  // The conditional insert and the optional OIDC state transition execute in
  // one D1 batch. A consumed login transaction therefore cannot mint a session.
  return db.insert(sessions).select(sql`
    select
      ${values.id},
      ${values.userId},
      ${values.tokenHash},
      ${values.userAgent},
      ${values.location},
      ${values.ipAddress},
      ${values.expiresAt.getTime()},
      ${values.createdAt.getTime()}
    where ${condition}
  `).returning({ id: sessions.id });
}

function pruneUserSessions(
  db: Database,
  userId: string,
  protectedSessionId: string,
  protectedTokenHash: string,
) {
  const newestOtherSessions = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(
      eq(sessions.userId, userId),
      ne(sessions.id, protectedSessionId),
    ))
    .orderBy(desc(sessions.createdAt), desc(sessions.id))
    .limit(MAX_SESSIONS - 1);
  return db.delete(sessions).where(and(
    eq(sessions.userId, userId),
    ne(sessions.id, protectedSessionId),
    sessionExists(db, protectedSessionId, protectedTokenHash),
    notInArray(sessions.id, newestOtherSessions),
  ));
}

function insertedRow(result: unknown) {
  return Array.isArray(result) && result.length > 0;
}

export async function establishSession(
  db: Database,
  c: Context<AppEnv>,
  userId: string,
  atomicActionFactory?: SessionAtomicActionFactory,
) {
  const authenticatedAt = new Date();
  const previousToken = getCookie(c, SESSION_COOKIE);
  const previousTokenHash = previousToken ? await hashToken(previousToken) : null;
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const sessionId = createId("ses");
  const atomicAction = atomicActionFactory?.({
    authenticatedAt,
    sessionId,
    sessionTokenHash: tokenHash,
  });
  const currentSession = sessionExists(db, sessionId, tokenHash);
  const writes: BatchItem<"sqlite">[] = [
    insertSession(db, {
      id: sessionId,
      userId,
      tokenHash,
      userAgent: c.req.header("user-agent") ?? null,
      location: requestLocation(c.req.raw),
      ipAddress: cloudflareClientIp(c.req.raw),
      expiresAt: sessionExpiresAt(c, authenticatedAt),
      createdAt: authenticatedAt,
    }, atomicAction?.precondition),
  ];
  if (previousTokenHash) {
    writes.push(
      db.delete(sessions).where(and(
        eq(sessions.tokenHash, previousTokenHash),
        ne(sessions.id, sessionId),
        currentSession,
      )),
    );
  }
  writes.push(pruneUserSessions(db, userId, sessionId, tokenHash));
  if (atomicAction) writes.push(atomicAction.commit);

  const results = await db.batch(
    writes as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
  );
  if (!insertedRow(results[0])) {
    throw new AuthRequestError("Authentication changed; try again");
  }
  if (atomicAction) atomicAction.assertCommitted(results.at(-1));

  setCookie(
    c,
    SESSION_COOKIE,
    token,
    cookieOptions(
      c.req.raw,
      new Date(authenticatedAt.getTime() + BROWSER_COOKIE_TTL_MS),
    ),
  );
  return { authenticatedAt };
}

export async function readSessionFromContext(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  const db = createDb(c.env.DB);
  const tokenHash = await hashToken(token);
  const now = new Date();
  const [row] = await db
    .select({
      sessionId: sessions.id,
      id: users.id,
      name: users.name,
      avatarUrl: users.avatarUrl,
      role: users.role,
      status: users.status,
      authTime: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(
      eq(sessions.tokenHash, tokenHash),
      gt(sessions.expiresAt, now),
      eq(users.status, "active"),
    ))
    .limit(1);
  if (!row) return null;

  const { authTime, expiresAt, sessionId, ...user } = row;
  const ttlMs = sessionTtlMs(c);
  if (expiresAt.getTime() <= now.getTime() + ttlMs / 2) {
    await db
      .update(sessions)
      .set({ expiresAt: sessionExpiresAt(c, now) })
      .where(and(
        eq(sessions.id, sessionId),
        eq(sessions.tokenHash, tokenHash),
        gt(sessions.expiresAt, now),
        lte(sessions.expiresAt, new Date(now.getTime() + ttlMs / 2)),
      ));
  }
  return { id: sessionId, user, authTime, tokenHash };
}

export async function destroySession(
  db: Database,
  c: Context<AppEnv>,
  identity: {
    sessionId: string;
    userId: string;
    pushEndpoint?: string;
  },
) {
  const writes: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db.delete(sessions).where(and(
      eq(sessions.id, identity.sessionId),
      eq(sessions.userId, identity.userId),
    )),
  ];
  if (identity.pushEndpoint) {
    writes.push(
      db.delete(pushSubscriptions).where(and(
        eq(pushSubscriptions.endpoint, identity.pushEndpoint),
        eq(pushSubscriptions.userId, identity.userId),
      )),
    );
  }
  await db.batch(writes);
  clearAuthCookies(c);
}

export function clearAuthCookies(c: Context<AppEnv>) {
  deleteCookie(c, SESSION_COOKIE, cookieOptions(c.req.raw));
}
