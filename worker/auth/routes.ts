import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { AccessLinkKind } from "../../shared/auth";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { requireAuth } from "./middleware";
import {
  authenticationResponseSchema,
  bootstrapInputSchema,
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
} from "./session";
import {
  clearChallengeCookie,
  getChallengeId,
  setChallengeCookie,
} from "./webauthn";

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
  .post("/login/options", async (c) => {
    try {
      const result = await beginLogin(createDb(c.env.DB), c.req.raw);
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
      try {
        const db = createDb(c.env.DB);
        const userId = await finishLogin(
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
  .route("/invitation", accessLinkRoutes("invitation"))
  .route("/recovery", accessLinkRoutes("recovery"))
  .post("/logout", requireAuth, async (c) => {
    await destroySession(createDb(c.env.DB), c);
    return c.json({ ok: true as const });
  });
