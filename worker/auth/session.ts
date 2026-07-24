import { and, eq, gt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createDb, type Database } from "../db/client";
import { sessions, users } from "../db/schema";
import type { AppEnv, SessionUser } from "../env";
import { hashToken, randomToken } from "../lib/crypto";
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

export async function createSession(
  db: Database,
  c: Context<AppEnv>,
  userId: string,
) {
  const token = randomToken();
  const tokenHash = await hashToken(token);
  const ttlDays = Number.parseInt(c.env.SESSION_TTL_DAYS, 10) || 30;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({
    tokenHash,
    userId,
    expiresAt,
    userAgent: c.req.header("user-agent") ?? null,
  });
  setCookie(c, SESSION_COOKIE, token, cookieOptions(c.req.raw, expiresAt));
}

export async function readSessionUserFromContext(c: Context<AppEnv>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  const db = createDb(c.env.DB);
  const tokenHash = await hashToken(token);
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      avatarUrl: users.avatarUrl,
      role: users.role,
      status: users.status,
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

  return row ?? null;
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
