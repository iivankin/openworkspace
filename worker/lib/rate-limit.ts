import { hashToken } from "./crypto";

export async function checkRateLimit(
  db: D1Database,
  input: {
    action: string;
    identifier: string;
    limit: number;
    windowMs: number;
  },
) {
  const now = Date.now();
  const windowEndsAt = now + input.windowMs;
  const key = `${input.action}:${await hashToken(input.identifier)}`;
  const row = await db
    .prepare(
      `INSERT INTO rate_limit_buckets ("key", "count", "window_ends_at")
       VALUES (?, 1, ?)
       ON CONFLICT ("key") DO UPDATE SET
         "count" = CASE
           WHEN "window_ends_at" <= ? THEN 1
           ELSE "count" + 1
         END,
         "window_ends_at" = CASE
           WHEN "window_ends_at" <= ? THEN excluded."window_ends_at"
           ELSE "window_ends_at"
         END
       RETURNING "count", "window_ends_at" AS "windowEndsAt"`,
    )
    .bind(key, windowEndsAt, now, now)
    .first<{ count: number; windowEndsAt: number }>();
  if (!row) return { allowed: false, retryAfterSeconds: 1 };

  if (crypto.getRandomValues(new Uint8Array(1))[0]! < 8) {
    await db
      .prepare('DELETE FROM "rate_limit_buckets" WHERE "window_ends_at" <= ?')
      .bind(now)
      .run();
  }
  return {
    allowed: row.count <= input.limit,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((row.windowEndsAt - now) / 1_000),
    ),
  };
}

export function requestIdentifier(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ??
    "unknown"
  );
}
