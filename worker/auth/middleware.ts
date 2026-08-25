import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { authenticateAccountApiToken, bearerToken } from "./api-tokens";
import { readSessionFromContext } from "./session";

export const requireSessionAuth = createMiddleware<AppEnv>(async (c, next) => {
  const session = await readSessionFromContext(c);
  if (!session) return apiError(c, 401, "UNAUTHORIZED", "Sign in is required");
  c.set("user", session.user);
  c.set("authKind", "session");
  c.set("sessionId", session.id);
  c.set("sessionTokenHash", session.tokenHash);
  await next();
});

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const session = await readSessionFromContext(c);
  if (session) {
    c.set("user", session.user);
    c.set("authKind", "session");
    c.set("sessionId", session.id);
    c.set("sessionTokenHash", session.tokenHash);
    await next();
    return;
  }

  const rawToken = bearerToken(c.req.raw);
  const identity = rawToken
    ? await authenticateAccountApiToken(c.env.DB, rawToken)
    : null;
  if (!identity) {
    c.header("www-authenticate", 'Bearer realm="OpenWorkspace API"');
    return apiError(c, 401, "UNAUTHORIZED", "Authentication is required");
  }
  c.set("user", identity.user);
  c.set("authKind", "api-token");
  c.set("sessionId", identity.tokenId);
  c.set("sessionTokenHash", identity.tokenHash);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "admin") {
    return apiError(c, 403, "FORBIDDEN", "Administrator access is required");
  }
  await next();
});

export const verifySameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    await next();
    return;
  }

  const origin = c.req.header("origin");
  // Non-browser clients do not automatically carry ambient cookies. Browsers
  // do, so their state-changing requests must prove they are same-origin.
  if (origin && origin !== new URL(c.req.url).origin) {
    return apiError(c, 403, "FORBIDDEN", "Cross-origin request rejected");
  }
  await next();
});
