import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { createDb } from "../db/client";
import { users } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import {
  demoMailboxConversationState,
  demoMailboxEmails,
  demoMailboxFolders,
} from "../mailbox/demo";
import { mailboxStub } from "../mailbox";
import { provisionBootstrapAccount } from "./personal-account";
import { mockBootstrapSchema, mockLoginSchema } from "./schemas";
import { establishSession } from "./session";
import {
  browserLoginTransaction,
} from "../oidc/transaction";
import { OidcError } from "../oidc/errors";
import { AuthRequestError } from "./errors";
import { hasUsers } from "./service";
import { completeOidcLogin } from "./oidc-login";
import { completeSamlLogin } from "./saml-login";
import { SamlError } from "../saml/errors";
import { browserSamlTransaction } from "../saml/transaction";

function assertMockEnabled(c: { env: AppEnv["Bindings"] }) {
  return c.env.ALLOW_MOCK_AUTH === "true";
}

function mockAuthFailure(c: Context<AppEnv>, error: unknown) {
  if (error instanceof AuthRequestError) {
    return apiError(c, error.status, error.code, error.message);
  }
  if (error instanceof OidcError && error.status < 500) {
    return apiError(c, 400, "WEBAUTHN_FAILED", error.message);
  }
  if (error instanceof SamlError && error.status < 500) {
    return apiError(c, 400, "WEBAUTHN_FAILED", error.message);
  }
  throw error;
}

export const mockAuthRoutes = new Hono<AppEnv>()
  .post("/bootstrap", zValidator("json", mockBootstrapSchema), async (c) => {
    if (!assertMockEnabled(c)) {
      return apiError(c, 404, "NOT_FOUND", "Not found");
    }
    const db = createDb(c.env.DB);
    const input = c.req.valid("json");
    const userId = createId("usr");
    const mailboxId = createId("mbx");
    const now = new Date();
    if (await hasUsers(db)) {
      return apiError(c, 409, "CONFLICT", "Account is already set up");
    }
    await provisionBootstrapAccount(db, {
      userId,
      mailboxId,
      name: input.name,
      email: input.email,
      role: "admin",
      status: "active",
      createdByUserId: userId,
      now,
    });
    try {
      await establishSession(db, c, userId);
      return c.json({ ok: true as const });
    } catch (error) {
      return mockAuthFailure(c, error);
    }
  })
  .post("/login", zValidator("json", mockLoginSchema), async (c) => {
    if (!assertMockEnabled(c)) {
      return apiError(c, 404, "NOT_FOUND", "Not found");
    }
    const db = createDb(c.env.DB);
    const input = c.req.valid("json");
    try {
      if (input.oidcRequestId) {
        await browserLoginTransaction(db, c, input.oidcRequestId);
      }
      if (input.samlRequestId) {
        await browserSamlTransaction(db, c, input.samlRequestId);
      }
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, input.userId),
            eq(users.status, "active"),
          ),
        )
        .limit(1);
      if (!user) return apiError(c, 404, "NOT_FOUND", "User not found");
      if (user.id === "usr_demo_admin") {
        await Promise.all(
          ["mbx_demo_personal", "mbx_demo_support"].map((mailboxId) =>
            mailboxStub(c.env, mailboxId).seedMailbox(
              demoMailboxFolders(mailboxId),
              demoMailboxEmails(mailboxId),
              demoMailboxConversationState(mailboxId),
            ),
          ),
        );
      }
      if (input.oidcRequestId) {
        const oidcLogin = await completeOidcLogin(
          db,
          c,
          user.id,
          input.oidcRequestId,
        );
        return c.json({
          ok: true as const,
          ...oidcLogin,
        });
      }
      if (input.samlRequestId) {
        const samlLogin = await completeSamlLogin(
          db,
          c,
          user.id,
          input.samlRequestId,
        );
        return c.json({
          ok: true as const,
          ...samlLogin,
        });
      }
      await establishSession(db, c, user.id);
      return c.json({
        ok: true as const,
        redirectTo: null,
      });
    } catch (error) {
      return mockAuthFailure(c, error);
    }
  });
