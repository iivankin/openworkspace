import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { adminRoutes } from "./admin/routes";
import { verifySameOrigin } from "./auth/middleware";
import { mockAuthRoutes } from "./auth/mock";
import { authRoutes } from "./auth/routes";
import { createDb } from "./db/client";
import { mailboxes } from "./db/schema";
import type { AppEnv } from "./env";
import { mailDownloadRoutes } from "./mail/downloads";
import { consumeDeliveryEvents } from "./mail/delivery-events";
import { inboundDeliveryId } from "./mail/inbound-delivery";
import { mailRoutes } from "./mail/routes";
import { mailboxStub } from "./mailbox";
import {
  oidcConsentRoutes,
  oidcLoginRoutes,
  oidcLogoutRoutes,
  oidcRoutes,
  wellKnownRoutes,
} from "./oidc/routes";
export { MailboxDO } from "./mailbox";
import { normalizeMailboxAddress } from "./lib/ids";

const app = new Hono<AppEnv>()
  .use("/api/*", verifySameOrigin)
  .get("/api/health", (c) => c.json({ ok: true as const }))
  .route("/api/auth", authRoutes)
  .route("/api/auth/mock", mockAuthRoutes)
  .route("/api/oidc/consent", oidcConsentRoutes)
  .route("/api/oidc/login", oidcLoginRoutes)
  .route("/api/oidc/logout", oidcLogoutRoutes)
  .route("/api/downloads", mailDownloadRoutes)
  .route("/api/mail", mailRoutes)
  .route("/api/admin", adminRoutes)
  .route("/.well-known", wellKnownRoutes)
  .route("/oauth", oidcRoutes)
  .notFound((c) =>
    c.json(
      { ok: false as const, error: { code: "NOT_FOUND", message: "Not found" } },
      404,
    ),
  )
  .onError((error, c) => {
    console.error(error);
    return c.json(
      {
        ok: false as const,
        error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
      },
      500,
    );
  });

export type AppType = typeof app;

export default {
  fetch: app.fetch,
  async email(message, env) {
    const receivedAt = Date.now();
    const recipient = normalizeMailboxAddress(message.to);
    const [mailbox] = await createDb(env.DB)
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.address, recipient))
      .limit(1);
    if (!mailbox) {
      message.setReject(`Mailbox ${recipient} does not exist`);
      return;
    }

    const raw = await new Response(message.raw).arrayBuffer();
    const deliveryId = await inboundDeliveryId({
      mailboxId: mailbox.id,
      envelopeFrom: message.from,
      envelopeTo: message.to,
      raw,
    });
    const objectKey = `mailboxes/${mailbox.id}/raw/${deliveryId}.eml`;
    await mailboxStub(env, mailbox.id).enqueueInbound({
      id: deliveryId,
      mailboxId: mailbox.id,
      rawObjectKey: objectKey,
      envelopeFrom: message.from,
      envelopeTo: message.to,
      receivedAt,
    });
    await env.MAIL_STORAGE.put(
      objectKey,
      raw,
      { httpMetadata: { contentType: "message/rfc822" } },
    );
  },
  queue: consumeDeliveryEvents,
} satisfies ExportedHandler<Env>;
