import {
  apiError,
  oauthScope,
  requireAdmin,
  requireAuth,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { WORKSPACE_SCOPE } from "@open-workspace/core/shared";
import { Hono } from "hono";

import { archiveStatus, runArchiveTick } from "./archive";

/** Administration → Mail archive, at /api/mail/archive: administrators only, like backups. */
export const mailArchiveRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .use("*", oauthScope(WORKSPACE_SCOPE))
  .use("*", requireAdmin)
  .get("/", async (c) =>
    c.json({ ok: true as const, ...(await archiveStatus(c.env)) })
  )
  /** Archive now: every open entry, without waiting for its backoff. */
  .post("/run", (c) => {
    if (!c.env.MAIL_ARCHIVE) {
      return apiError(
        c,
        409,
        "NOT_READY",
        "The mail archive is off: deploy with Email({ archive: { years } })"
      );
    }

    c.executionCtx.waitUntil(runArchiveTick(c.env, new Date(), true));

    return c.json({ ok: true as const }, 202);
  });
