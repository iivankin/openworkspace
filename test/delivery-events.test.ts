import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../worker/db/client";
import { mailboxes } from "../worker/db/schema";
import { consumeDeliveryEvents } from "../worker/mail/delivery-events";
import { mailboxStub } from "../worker/mailbox";

function queueBatch(body: unknown) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    ack,
    retry,
    batch: {
      queue: "openworkspace-delivery-events",
      messages: [{
        id: crypto.randomUUID(),
        timestamp: new Date(),
        body,
        attempts: 1,
        ack,
        retry,
      }],
      metadata: {
        metrics: {
          backlogCount: 1,
          backlogBytes: 1,
        },
      },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } satisfies MessageBatch<unknown>,
  };
}

describe("Email Service delivery events", () => {
  it("updates one recipient idempotently by Cloudflare message ID", async () => {
    const bootstrap = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
      }),
    );
    expect(bootstrap.status).toBe(200);
    await bootstrap.json();

    const [mailbox] = await createDb(env.DB)
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.address, "admin@example.test"))
      .limit(1);
    const stub = mailboxStub(env, mailbox!.id);
    await stub.insertEmail({
      id: "msg_delivery_event",
      conversationId: "conv_delivery_event",
      direction: "outgoing",
      messageIdHeader: "cf-message-123",
      fromJson: [{ address: "admin@example.test", name: "Admin" }],
      toJson: [{ address: "recipient@example.net", name: null }],
      subject: "Delivery event",
      timelineAt: new Date(),
      transportState: "submitted",
    });

    const event = {
      type: "cf.email.sending.message.delivered",
      source: { type: "email.sending", domain: "example.test" },
      payload: {
        eventId: "event-delivered-1",
        messageId: "cf-message-123",
        sender: "admin@example.test",
        recipient: "recipient@example.net",
        subject: "Delivery event",
        terminal: true,
        delivery: {
          status: "delivered",
          provider: "example",
          smtpStatusCode: "250",
          smtpResponse: "250 OK",
        },
      },
      metadata: {
        accountId: "account",
        eventSubscriptionId: "subscription",
        eventSchemaVersion: 1,
        eventTimestamp: "2026-07-23T12:00:00.000Z",
      },
    };
    const first = queueBatch(event);
    await consumeDeliveryEvents(first.batch, env);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(first.retry).not.toHaveBeenCalled();

    const duplicate = queueBatch(event);
    await consumeDeliveryEvents(duplicate.batch, env);
    expect(duplicate.ack).toHaveBeenCalledOnce();
    const stored = await stub.getEmail("msg_delivery_event");
    expect(stored?.deliveryStatusJson).toEqual([expect.objectContaining({
      recipient: "recipient@example.net",
      status: "delivered",
      eventId: "event-delivered-1",
      smtpCode: "250",
    })]);
  });
});
