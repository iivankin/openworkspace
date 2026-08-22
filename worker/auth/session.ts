import { and, eq, gt, lte } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createDb, type Database } from "../db/client";
import { sessions, users } from "../db/schema";
import type { AppEnv } from "../env";
import { hashToken, randomToken } from "../lib/crypto";
import { createId } from "../lib/ids";
import { SESSION_COOKIE } from "./constants";

function cookieOptions(request: Request, expires?: Date) {
  const secure = new URL(request.url).protocol === "https:";
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure,
    path: "/",
    expires,
  };
}

function sessionExpiresAt(c: Context<AppEnv>, createdAt: Date) {
  const ttlDays = Number.parseInt(c.env.SESSION_TTL_DAYS, 10) || 30;
  return new Date(createdAt.getTime() + ttlDays * 24 * 60 * 60 * 1_000);
}

export async function createSession(
  db: Database,
  c: Context<AppEnv>,
  userId: string,
) {
  const session = await newSession(c, userId);
  const currentToken = getCookie(c, SESSION_COOKIE);
  const currentTokenHash = currentToken ? await hashToken(currentToken) : null;

  if (currentTokenHash) {
    await db.batch([
      db.delete(sessions).where(lte(sessions.expiresAt, session.row.createdAt)),
      db.delete(sessions).where(eq(sessions.tokenHash, currentTokenHash)),
      db.insert(sessions).values(session.row),
    ]);
  } else {
    await db.batch([
      db.delete(sessions).where(lte(sessions.expiresAt, session.row.createdAt)),
      db.insert(sessions).values(session.row),
    ]);
  }
  setSessionCookie(c, session.token, session.row.expiresAt);
}

async function newSession(
  c: Context<AppEnv>,
  userId: string,
  createdAt = new Date(),
) {
  const bearer = await newBearerToken();
  return {
    token: bearer.token,
    row: {
      id: createId("ses"),
      tokenHash: bearer.tokenHash,
      userId,
      expiresAt: sessionExpiresAt(c, createdAt),
      userAgent: c.req.header("user-agent") ?? null,
      createdAt,
    },
  };
}

async function newBearerToken() {
  const token = randomToken();
  const tokenHash = await hashToken(token);
  return { token, tokenHash };
}

function setSessionCookie(c: Context<AppEnv>, token: string, expiresAt: Date) {
  setCookie(c, SESSION_COOKIE, token, cookieOptions(c.req.raw, expiresAt));
}

export async function reauthenticateSession(
  db: Database,
  c: Context<AppEnv>,
  userId: string,
) {
  const currentToken = getCookie(c, SESSION_COOKIE);
  const currentTokenHash = currentToken ? await hashToken(currentToken) : null;
  const [currentSession] = currentTokenHash
    ? await db
      .select({
        id: sessions.id,
        userId: sessions.userId,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .where(and(
        eq(sessions.tokenHash, currentTokenHash),
        gt(sessions.expiresAt, new Date()),
      ))
      .limit(1)
    : [];
  const createdAt = new Date(Math.max(
    Date.now(),
    (currentSession?.createdAt.getTime() ?? 0) + 1,
  ));
  if (currentTokenHash && currentSession?.userId === userId) {
    const replacement = await newBearerToken();
    const expiresAt = sessionExpiresAt(c, createdAt);
    const [updated] = await db
      .update(sessions)
      .set({
        tokenHash: replacement.tokenHash,
        createdAt,
        expiresAt,
        userAgent: c.req.header("user-agent") ?? null,
      })
      .where(and(
        eq(sessions.id, currentSession.id),
        eq(sessions.tokenHash, currentTokenHash),
      ))
      .returning({ id: sessions.id });
    if (!updated) {
      throw new Error("Session changed during authentication; try again");
    }
    await db.delete(sessions).where(lte(sessions.expiresAt, createdAt));
    setSessionCookie(c, replacement.token, expiresAt);
    return;
  }

  const replacement = await newSession(c, userId, createdAt);
  if (currentTokenHash) {
    await db.batch([
      db.delete(sessions).where(lte(sessions.expiresAt, createdAt)),
      db.insert(sessions).values(replacement.row),
      db.delete(sessions).where(eq(sessions.tokenHash, currentTokenHash)),
    ]);
  } else {
    await db.batch([
      db.delete(sessions).where(lte(sessions.expiresAt, createdAt)),
      db.insert(sessions).values(replacement.row),
    ]);
  }
  setSessionCookie(c, replacement.token, replacement.row.expiresAt);
}

export async function readSessionFromContext(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  const db = createDb(c.env.DB);
  const tokenHash = await hashToken(token);
  const [row] = await db
    .select({
      sessionId: sessions.id,
      id: users.id,
      name: users.name,
      avatarUrl: users.avatarUrl,
      role: users.role,
      status: users.status,
      authTime: sessions.createdAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        gt(sessions.expiresAt, new Date()),
        eq(users.status, "active"),
      ),
    )
    .limit(1);

  if (!row) return null;
  const { authTime, sessionId, ...user } = row;
  return { id: sessionId, user, authTime, tokenHash };
}

export async function destroySession(db: Database, c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await db
      .delete(sessions)
      .where(eq(sessions.tokenHash, await hashToken(token)));
  }
  deleteCookie(c, SESSION_COOKIE, cookieOptions(c.req.raw));
}
