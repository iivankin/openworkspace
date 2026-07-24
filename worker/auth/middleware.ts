import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { readSessionUserFromContext } from "./session";

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const user = await readSessionUserFromContext(c);
  if (!user) return apiError(c, 401, "UNAUTHORIZED", "Sign in is required");
  c.set("user", user);
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
