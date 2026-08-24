import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
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
import { provisionInstallationAccount } from "./personal-account";
import { mockBootstrapSchema, mockLoginSchema } from "./schemas";
import { createSession, reauthenticateSession } from "./session";
import {
  authenticateLoginTransaction,
  browserLoginTransaction,
  clearLoginTransactionCookie,
} from "../oidc/transaction";

function assertMockEnabled(c: { env: AppEnv["Bindings"] }) {
  return c.env.ALLOW_MOCK_AUTH === "true";
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
    try {
      await provisionInstallationAccount(db, {
        userId,
        mailboxId,
        name: input.name,
        email: input.email,
        role: "admin",
        status: "active",
        createdByUserId: userId,
        now,
      });
    } catch {
      return apiError(c, 409, "CONFLICT", "Installation is already set up");
    }
    await createSession(db, c, userId);
    return c.json({ ok: true as const });
  })
  .post("/login", zValidator("json", mockLoginSchema), async (c) => {
    if (!assertMockEnabled(c)) {
      return apiError(c, 404, "NOT_FOUND", "Not found");
    }
    const db = createDb(c.env.DB);
    const input = c.req.valid("json");
    if (input.oidcRequestId) {
      await browserLoginTransaction(db, c, input.oidcRequestId);
    }
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, c.req.valid("json").userId),
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
      const transaction = await authenticateLoginTransaction(
        db,
        input.oidcRequestId,
        user.id,
      );
      await reauthenticateSession(db, c, user.id);
      clearLoginTransactionCookie(c, input.oidcRequestId);
      return c.json({ ok: true as const, ...transaction });
    }
    await createSession(db, c, user.id);
    return c.json({ ok: true as const, redirectTo: null });
  });
