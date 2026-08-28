import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AccessLinkKind } from "../../shared/auth";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { checkRateLimit, requestIdentifier } from "../lib/rate-limit";
import { requireSessionAuth } from "./middleware";
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
  hasUsers,
} from "./service";
import {
  destroySession,
  establishSession,
  readSessionFromContext,
} from "./session";
import {
  clearChallengeCookie,
  getChallengeId,
  setChallengeCookie,
} from "./webauthn";
import {
  browserLoginTransaction,
} from "../oidc/transaction";
import { deleteAvatar, uploadAvatar } from "./avatar";
import { accountApiTokenRoutes } from "./api-token-routes";
import { accountSessionRoutes } from "./session-routes";
import {
  deferWebhookTask,
  queueUserWebhookEvent,
} from "../webhooks/service";
import { AuthRequestError } from "./errors";
import { OidcError } from "../oidc/errors";
import { completeOidcLogin } from "./oidc-login";

function authFailure(c: Parameters<typeof apiError>[0], error: unknown) {
  if (error instanceof AuthRequestError) {
    return apiError(c, error.status, error.code, error.message);
  }
  if (error instanceof OidcError && error.status < 500) {
    return apiError(c, 400, "WEBAUTHN_FAILED", error.message);
  }
  throw error;
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
        if (!(error instanceof AuthRequestError)) throw error;
        return apiError(c, 404, "NOT_FOUND", error.message);
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
          await establishSession(db, c, userId);
          if (kind === "invitation") {
            deferWebhookTask(
              (task) => c.executionCtx.waitUntil(task),
              (eventId) => queueUserWebhookEvent(
                c.env,
                "user.joined",
                userId,
                eventId,
              ),
            );
          }
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
    const [installed, session] = await Promise.all([
      hasUsers(db),
      readSessionFromContext(c),
    ]);
    return c.json({
      ok: true as const,
      needsBootstrap: !installed,
      authenticated: Boolean(session),
      sessionVersion: session?.authTime.getTime() ?? null,
      user: session?.user ?? null,
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
        await establishSession(db, c, userId);
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
          const oidcLogin = await completeOidcLogin(
            db,
            c,
            result.userId,
            result.oidcRequestId,
          );
          return c.json({
            ok: true as const,
            ...oidcLogin,
          });
        }
        await establishSession(db, c, result.userId);
        return c.json({
          ok: true as const,
          redirectTo: null,
        });
      } catch (error) {
        return authFailure(c, error);
      }
    },
  )
  .route("/invitation", accessLinkRoutes("invitation"))
  .route("/recovery", accessLinkRoutes("recovery"))
  .route("/sessions", accountSessionRoutes)
  .route("/api-tokens", accountApiTokenRoutes)
  .post("/avatar", requireSessionAuth, (c) => uploadAvatar(c))
  .delete("/avatar", requireSessionAuth, (c) => deleteAvatar(c))
  .post(
    "/logout",
    requireSessionAuth,
    zValidator("json", z.object({
      pushEndpoint: z.url().max(4_096).optional(),
    })),
    async (c) => {
      await destroySession(createDb(c.env.DB), c, {
        sessionId: c.get("sessionId"),
        userId: c.get("user").id,
        pushEndpoint: c.req.valid("json").pushEndpoint,
      });
      return c.json({ ok: true as const });
    },
  );
