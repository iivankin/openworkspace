import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../worker/db/client";
import { mailboxAddressSql } from "../worker/db/mailboxes";
import { domains, mailboxes, webhookDeliveries } from "../worker/db/schema";
import { mailboxStub } from "../worker/mailbox";
import { deferEmailSentWebhook } from "../worker/mail/outbound-service";
import { consumeWebhooks } from "../worker/webhooks/delivery";
import {
  deferWebhookTask,
  queueWebhookEvent,
  type WebhookDeliveryJob,
  type WebhookDispatchJob,
} from "../worker/webhooks/service";

function queueBatch(body: unknown, attempts = 1) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    ack,
    retry,
    batch: {
      queue: "openworkspace-webhooks-test",
      messages: [{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        body,
        attempts,
        ack,
        retry,
      }],
      metadata: {
        metrics: { backlogCount: 1, backlogBytes: 1 },
      },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } satisfies MessageBatch<unknown>,
  };
}

function webhookEnv(
  sendBatch: (messages: MessageSendRequest<WebhookDeliveryJob>[]) => Promise<void>,
) {
  return {
    DB: env.DB,
    MAIL_STORAGE: env.MAIL_STORAGE,
    MAILBOX: env.MAILBOX,
    WEBHOOKS: { sendBatch },
  } as unknown as Env;
}

async function bootstrapAdmin() {
  const response = await exports.default.fetch(
    new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Webhook Admin",
        email: "webhooks@example.test",
      }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  return cookie!;
}

describe("account webhooks", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await bootstrapAdmin();
  });

  it("queues email.sent only after submission and isolates queue failures", async () => {
    const send = vi.fn(async () => {
      throw new Error("Queue unavailable");
    });
    const deferred: Promise<unknown>[] = [];
    const defer = (task: Promise<unknown>) => deferred.push(task);
    const webhookEnv = {
      WEBHOOKS: { send },
    } as unknown as Env;

    deferEmailSentWebhook({
      env: webhookEnv,
      mailboxId: "mbx_webhook_state",
      email: {
        id: "msg_submitted",
        timelineAt: new Date("2026-08-24T12:00:00.000Z"),
        transportState: "submitted",
      },
      defer,
    });
    deferEmailSentWebhook({
      env: webhookEnv,
      mailboxId: "mbx_webhook_state",
      email: {
        id: "msg_unconfirmed",
        timelineAt: new Date("2026-08-24T12:00:00.000Z"),
        transportState: "unconfirmed",
      },
      defer,
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(deferred).toHaveLength(1);
      await expect(deferred[0]).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps one event ID across queue ingress retries", async () => {
    const jobs: WebhookDispatchJob[] = [];
    const send = vi.fn(async (job: WebhookDispatchJob) => {
      jobs.push(job);
      if (jobs.length < 3) throw new Error("Queue unavailable");
    });
    const deferred: Promise<unknown>[] = [];
    deferWebhookTask(
      (task) => deferred.push(task),
      (eventId) => queueWebhookEvent({
        WEBHOOKS: { send },
      } as unknown as Env, {
        eventId,
        eventType: "user.updated",
        occurredAt: 1,
        source: { kind: "data", data: { user: { id: "usr_retry" } } },
      }),
    );

    await expect(deferred[0]).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(3);
    expect(new Set(jobs.map((job) => job.eventId)).size).toBe(1);
  });

  it("requires HTTPS and only reveals the signing secret on creation", async () => {
    const invalid = await exports.default.fetch(
      new Request("http://example.test/api/admin/webhooks", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Insecure",
          url: "http://hooks.example.test/openworkspace",
          events: ["email.received"],
          enabled: true,
        }),
      }),
    );
    expect(invalid.status).toBe(400);

    const created = await exports.default.fetch(
      new Request("http://example.test/api/admin/webhooks", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Automation",
          url: "https://hooks.example.test/openworkspace",
          events: ["user.joined"],
          enabled: true,
        }),
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<{
      signingSecret: string;
      webhook: { id: string };
    }>();
    expect(createdBody.signingSecret).toMatch(/^whsec_/u);

    const listed = await exports.default.fetch(
      new Request("http://example.test/api/admin/webhooks", {
        headers: { cookie: adminCookie },
      }),
    );
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).toContain(createdBody.webhook.id);
    expect(listedText).not.toContain(createdBody.signingSecret);
    expect(listedText).not.toContain("signingSecret");
  });

  it("fans out subscribed events and signs a payload with text and HTML bodies", async () => {
    const created = await exports.default.fetch(
      new Request("http://example.test/api/admin/webhooks", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Mail processor",
          url: "https://hooks.example.test/mail",
          events: ["email.received"],
          enabled: true,
        }),
      }),
    );
    const createdBody = await created.json<{
      signingSecret: string;
      webhook: { id: string };
    }>();
    const [mailbox] = await createDb(env.DB)
      .select({ id: mailboxes.id, address: mailboxAddressSql })
      .from(mailboxes)
      .innerJoin(domains, eq(mailboxes.domainId, domains.id))
      .limit(1);
    expect(mailbox).toBeTruthy();
    const messageId = "msg_webhook_body";
    const htmlKey = `mailboxes/${mailbox!.id}/messages/${messageId}/body.html`;
    await env.MAIL_STORAGE.put(htmlKey, "<p>Hello from HTML</p>");
    await mailboxStub(env, mailbox!.id).seedMailbox([], [{
      id: messageId,
      conversationId: "conv_webhook_body",
      direction: "incoming",
      fromJson: [{ address: "sender@example.net", name: "Sender" }],
      toJson: [{ address: mailbox!.address, name: null }],
      subject: "Webhook body",
      bodyText: "Hello from text",
      bodyHtmlR2Key: htmlKey,
      timelineAt: new Date("2026-08-24T10:00:00.000Z"),
      transportState: "received",
    }]);

    const sendBatch = vi.fn(async (
      _messages: MessageSendRequest<WebhookDeliveryJob>[],
    ) => undefined);
    const dispatchJob: WebhookDispatchJob = {
      type: "dispatch",
      eventId: "evt_webhook_body",
      eventType: "email.received",
      occurredAt: Date.now(),
      source: { kind: "email", mailboxId: mailbox!.id, messageId },
    };
    const dispatchBatch = queueBatch(dispatchJob);
    await consumeWebhooks(dispatchBatch.batch, webhookEnv(sendBatch));
    expect(dispatchBatch.ack).toHaveBeenCalledOnce();
    expect(sendBatch).toHaveBeenCalledOnce();
    const deliveryJob = sendBatch.mock.calls[0]![0][0]!.body;

    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body);
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("error");
      expect(JSON.parse(body)).toMatchObject({
        id: "evt_webhook_body",
        type: "email.received",
        data: {
          email: {
            subject: "Webhook body",
            body: {
              text: "Hello from text",
              html: "<p>Hello from HTML</p>",
            },
          },
        },
      });
      const timestamp = headers.get("x-openworkspace-timestamp");
      const signature = headers.get("x-openworkspace-signature");
      expect(timestamp).toMatch(/^\d+$/u);
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(createdBody.signingSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const expected = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${timestamp}.${body}`),
      );
      const expectedHex = [...new Uint8Array(expected)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      expect(signature).toBe(`sha256=${expectedHex}`);
      return new Response("accepted", { status: 202 });
    });
    vi.stubGlobal("fetch", request);
    try {
      const deliveryBatch = queueBatch(deliveryJob);
      const duplicateBatch = queueBatch(deliveryJob);
      await Promise.all([
        consumeWebhooks(deliveryBatch.batch, webhookEnv(sendBatch)),
        consumeWebhooks(duplicateBatch.batch, webhookEnv(sendBatch)),
      ]);
      expect(deliveryBatch.ack).toHaveBeenCalledOnce();
      expect(deliveryBatch.retry).not.toHaveBeenCalled();
      expect(duplicateBatch.ack).toHaveBeenCalledOnce();
      expect(duplicateBatch.retry).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }

    const [delivery] = await createDb(env.DB)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, createdBody.webhook.id))
      .limit(1);
    expect(delivery).toMatchObject({
      status: "delivered",
      responseStatus: 202,
      attempts: 1,
    });
  });

  it("records the HTTP status and response body after a failed delivery", async () => {
    const created = await exports.default.fetch(
      new Request("http://example.test/api/admin/webhooks", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Failing endpoint",
          url: "https://hooks.example.test/failing",
          events: ["email.received"],
          enabled: true,
        }),
      }),
    );
    const createdBody = await created.json<{ webhook: { id: string } }>();
    const sendBatch = vi.fn(async (
      _messages: MessageSendRequest<WebhookDeliveryJob>[],
    ) => undefined);
    const dispatchBatch = queueBatch({
      type: "dispatch",
      eventId: "evt_webhook_failure",
      eventType: "webhook.test",
      occurredAt: Date.now(),
      endpointId: createdBody.webhook.id,
      source: { kind: "data", data: { message: "Failure test" } },
    } satisfies WebhookDispatchJob);
    await consumeWebhooks(dispatchBatch.batch, webhookEnv(sendBatch));
    const deliveryJob = sendBatch.mock.calls[0]![0][0]!.body;

    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("rate limited", { status: 429 })
    ));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const deliveryBatch = queueBatch(deliveryJob, 5);
      await consumeWebhooks(deliveryBatch.batch, webhookEnv(sendBatch));
      expect(deliveryBatch.ack).toHaveBeenCalledOnce();
      expect(deliveryBatch.retry).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      vi.unstubAllGlobals();
    }

    const [delivery] = await createDb(env.DB)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, createdBody.webhook.id))
      .limit(1);
    expect(delivery).toMatchObject({
      status: "failed",
      attempts: 5,
      responseStatus: 429,
      responseBody: "rate limited",
      error: "Endpoint returned HTTP 429",
    });

    const lateRequest = vi.fn(async () => new Response("unexpected"));
    vi.stubGlobal("fetch", lateRequest);
    try {
      const duplicateBatch = queueBatch(deliveryJob);
      await consumeWebhooks(duplicateBatch.batch, webhookEnv(sendBatch));
      expect(duplicateBatch.ack).toHaveBeenCalledOnce();
      expect(duplicateBatch.retry).not.toHaveBeenCalled();
      expect(lateRequest).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }

    const [unchangedDelivery] = await createDb(env.DB)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, delivery!.id))
      .limit(1);
    expect(unchangedDelivery).toMatchObject({
      status: "failed",
      attempts: 5,
      responseStatus: 429,
    });
  });

  it("does not deliver an event after the endpoint unsubscribes from it", async () => {
    const created = await exports.default.fetch(
      new Request("http://example.test/api/admin/webhooks", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Changing subscription",
          url: "https://hooks.example.test/changing",
          events: ["email.received"],
          enabled: true,
        }),
      }),
    );
    const createdBody = await created.json<{
      webhook: { id: string };
    }>();
    const sendBatch = vi.fn(async (
      _messages: MessageSendRequest<WebhookDeliveryJob>[],
    ) => undefined);
    const dispatchBatch = queueBatch({
      type: "dispatch",
      eventId: "evt_webhook_unsubscribed",
      eventType: "email.received",
      occurredAt: Date.now(),
      endpointId: createdBody.webhook.id,
      source: { kind: "data", data: { message: "Should not be sent" } },
    } satisfies WebhookDispatchJob);
    await consumeWebhooks(dispatchBatch.batch, webhookEnv(sendBatch));
    const deliveryJob = sendBatch.mock.calls[0]![0][0]!.body;

    const updated = await exports.default.fetch(
      new Request(
        `http://example.test/api/admin/webhooks/${createdBody.webhook.id}`,
        {
          method: "PUT",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({
            name: "Changing subscription",
            url: "https://hooks.example.test/changing",
            events: ["email.sent"],
            enabled: true,
          }),
        },
      ),
    );
    expect(updated.status).toBe(200);

    const request = vi.fn(async () => new Response("unexpected"));
    vi.stubGlobal("fetch", request);
    try {
      const deliveryBatch = queueBatch(deliveryJob);
      await consumeWebhooks(deliveryBatch.batch, webhookEnv(sendBatch));
      expect(deliveryBatch.ack).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }

    const [delivery] = await createDb(env.DB)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, createdBody.webhook.id))
      .limit(1);
    expect(delivery).toMatchObject({
      status: "failed",
      error: "Webhook endpoint no longer subscribes to this event",
    });
  });
});
