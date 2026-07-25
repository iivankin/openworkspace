import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import type { AccessLinkKind } from "../../shared/auth";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { checkRateLimit, requestIdentifier } from "../lib/rate-limit";
import { requireAuth } from "./middleware";
import {
  authenticationResponseSchema,
  bootstrapInputSchema,
  loginOptionsSchema,
  registrationResponseSchema,
} from "./schemas";
import {
  beginAccessLinkRegistration,
  beginBootstrap,
  beginLogin,
  finishAccessLinkRegistration,
  finishBootstrap,
  finishLogin,
  getAccessLinkPreview,
  hasInstallation,
} from "./service";
import {
  createSession,
  destroySession,
  readSessionUserFromContext,
  replaceSession,
} from "./session";
import {
  clearChallengeCookie,
  getChallengeId,
  setChallengeCookie,
} from "./webauthn";
import {
  authenticateLoginTransaction,
  browserLoginTransaction,
  clearLoginTransactionCookie,
} from "../oidc/transaction";
import { deleteAvatar, uploadAvatar } from "./avatar";

function authFailure(c: Parameters<typeof apiError>[0], error: unknown) {
  const message = error instanceof Error ? error.message : "Passkey request failed";
  const conflict = message.includes("already set up");
  return apiError(
    c,
    conflict ? 409 : 400,
    conflict ? "CONFLICT" : "WEBAUTHN_FAILED",
    message,
  );
}

async function rateLimitAuth(c: Context<AppEnv>) {
  const rate = await checkRateLimit(c.env.DB, {
    action: "passkey-login",
    identifier: requestIdentifier(c.req.raw),
    limit: 30,
    windowMs: 60_000,
  });
  if (rate.allowed) return null;
  c.header("retry-after", String(rate.retryAfterSeconds));
  return c.json(
    {
      ok: false as const,
      error: {
        code: "RATE_LIMITED",
        message: "Too many authentication attempts",
      },
    },
    429,
  );
}

function accessLinkRoutes(kind: AccessLinkKind) {
  const label = kind === "invitation" ? "Invitation" : "Recovery link";
  return new Hono<AppEnv>()
    .get("/:token", async (c) => {
      try {
        const accessLink = await getAccessLinkPreview(
          createDb(c.env.DB),
          c.req.param("token"),
          kind,
        );
        return c.json({
          ok: true as const,
          accessLink,
        });
      } catch (error) {
        return apiError(
          c,
          404,
          "NOT_FOUND",
          error instanceof Error ? error.message : `${label} not found`,
        );
      }
    })
    .post("/:token/options", async (c) => {
      try {
        const result = await beginAccessLinkRegistration(
          createDb(c.env.DB),
          c.req.raw,
          c.req.param("token"),
          kind,
        );
        setChallengeCookie(c, result.challenge.id, result.challenge.expiresAt);
        return c.json({ ok: true as const, options: result.options });
      } catch (error) {
        return authFailure(c, error);
      }
    })
    .post(
      "/:token/verify",
      zValidator("json", registrationResponseSchema),
      async (c) => {
        try {
          const db = createDb(c.env.DB);
          const userId = await finishAccessLinkRegistration(
            db,
            getChallengeId(c),
            c.req.valid("json"),
            kind,
          );
          clearChallengeCookie(c);
          await createSession(db, c, userId);
          return c.json({ ok: true as const });
        } catch (error) {
          return authFailure(c, error);
        }
      },
    );
}

export const authRoutes = new Hono<AppEnv>()
  .get("/state", async (c) => {
    const db = createDb(c.env.DB);
    const [installed, user] = await Promise.all([
      hasInstallation(db),
      readSessionUserFromContext(c),
    ]);
    return c.json({
      ok: true as const,
      needsBootstrap: !installed,
      authenticated: Boolean(user),
      user,
      mockAuthEnabled: c.env.ALLOW_MOCK_AUTH === "true",
    });
  })
  .post("/bootstrap/options", zValidator("json", bootstrapInputSchema), async (c) => {
    try {
      const result = await beginBootstrap(
        createDb(c.env.DB),
        c.req.raw,
        c.req.valid("json"),
      );
      setChallengeCookie(c, result.challenge.id, result.challenge.expiresAt);
      return c.json({ ok: true as const, options: result.options });
    } catch (error) {
      return authFailure(c, error);
    }
  })
  .post(
    "/bootstrap/verify",
    zValidator("json", registrationResponseSchema),
    async (c) => {
      try {
        const db = createDb(c.env.DB);
        const userId = await finishBootstrap(
          db,
          getChallengeId(c),
          c.req.valid("json"),
        );
        clearChallengeCookie(c);
        await createSession(db, c, userId);
        return c.json({ ok: true as const });
      } catch (error) {
        return authFailure(c, error);
      }
    },
  )
  .post("/login/options", zValidator("query", loginOptionsSchema), async (c) => {
    const limited = await rateLimitAuth(c);
    if (limited) return limited;
    try {
      const db = createDb(c.env.DB);
      const { oidcRequestId } = c.req.valid("query");
      if (oidcRequestId) {
        await browserLoginTransaction(db, c, oidcRequestId);
      }
      const result = await beginLogin(db, c.req.raw, oidcRequestId);
      setChallengeCookie(c, result.challenge.id, result.challenge.expiresAt);
      return c.json({ ok: true as const, options: result.options });
    } catch (error) {
      return authFailure(c, error);
    }
  })
  .post(
    "/login/verify",
    zValidator("json", authenticationResponseSchema),
    async (c) => {
      const limited = await rateLimitAuth(c);
      if (limited) return limited;
      try {
        const db = createDb(c.env.DB);
        const result = await finishLogin(
          db,
          getChallengeId(c),
          c.req.valid("json"),
        );
        clearChallengeCookie(c);
        if (result.oidcRequestId) {
          const transaction = await authenticateLoginTransaction(
            db,
            result.oidcRequestId,
            result.userId,
          );
          await replaceSession(db, c, result.userId);
          clearLoginTransactionCookie(c, result.oidcRequestId);
          return c.json({ ok: true as const, ...transaction });
        }
        await createSession(db, c, result.userId);
        return c.json({ ok: true as const, redirectTo: null });
      } catch (error) {
        return authFailure(c, error);
      }
    },
  )
  .route("/invitation", accessLinkRoutes("invitation"))
  .route("/recovery", accessLinkRoutes("recovery"))
  .post("/avatar", requireAuth, (c) => uploadAvatar(c))
  .delete("/avatar", requireAuth, (c) => deleteAvatar(c))
  .post("/logout", requireAuth, async (c) => {
    await destroySession(createDb(c.env.DB), c);
    return c.json({ ok: true as const });
  });
