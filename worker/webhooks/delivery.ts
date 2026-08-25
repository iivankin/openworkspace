import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { webhookEventTypes } from "../../shared/webhooks";
import { createDb } from "../db/client";
import {
  domains,
  mailboxes,
  webhookDeliveries,
  webhookEndpoints,
} from "../db/schema";
import { mailboxAddressSql, mailboxKind } from "../db/mailboxes";
import { hashToken } from "../lib/crypto";
import { mailboxStub } from "../mailbox";
import type { Email } from "../mailbox/schema";
import type {
  WebhookDeliveryJob,
  WebhookDispatchJob,
  WebhookEventSource,
} from "./service";
import { cleanupExpiredWebhookDeliveries } from "./service";

const MAX_DELIVERY_ATTEMPTS = 5;
const RESPONSE_EXCERPT_BYTES = 2_048;

class WebhookHttpError extends Error {
  constructor(
    readonly responseStatus: number,
    readonly responseBody: string,
  ) {
    super(`Endpoint returned HTTP ${responseStatus}`);
    this.name = "WebhookHttpError";
  }
}

const webhookSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("email"),
    mailboxId: z.string().min(1),
    messageId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("data"),
    data: z.record(z.string(), z.unknown()),
  }),
]);

const webhookDispatchJobSchema = z.object({
  type: z.literal("dispatch"),
  eventId: z.string().min(1),
  eventType: z.union([z.enum(webhookEventTypes), z.literal("webhook.test")]),
  occurredAt: z.number().int().nonnegative(),
  source: webhookSourceSchema,
  endpointId: z.string().min(1).optional(),
});

const webhookDeliveryJobSchema = z.object({
  type: z.literal("deliver"),
  deliveryId: z.string().min(1),
});

const webhookQueueJobSchema = z.discriminatedUnion("type", [
  webhookDispatchJobSchema,
  webhookDeliveryJobSchema,
]);

function publicEmail(email: Email, bodyHtml: string | null) {
  return {
    id: email.id,
    conversationId: email.conversationId,
    direction: email.direction,
    from: email.fromJson,
    to: email.toJson,
    cc: email.ccJson,
    bcc: email.bccJson,
    replyTo: email.replyToJson,
    subject: email.subject,
    body: {
      text: email.bodyText,
      html: bodyHtml,
    },
    attachments: email.attachmentsJson.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      contentId: attachment.contentId,
      disposition: attachment.disposition,
    })),
    authentication: email.authenticationResultsJson,
    aiClassification: email.aiClassificationJson,
    transportState: email.transportState,
    transportError: email.transportError,
    deliveryStatuses: email.deliveryStatusJson,
    occurredAt: email.timelineAt.toISOString(),
  };
}

async function eventData(env: Env, source: WebhookEventSource) {
  if (source.kind === "data") return source.data;
  const [mailbox, email] = await Promise.all([
    createDb(env.DB)
      .select({
        id: mailboxes.id,
        address: mailboxAddressSql,
        displayName: mailboxes.displayName,
        ownerUserId: mailboxes.ownerUserId,
      })
      .from(mailboxes)
      .innerJoin(domains, eq(mailboxes.domainId, domains.id))
      .where(eq(mailboxes.id, source.mailboxId))
      .limit(1)
      .then((rows) => rows[0]
        ? { ...rows[0], kind: mailboxKind(rows[0].ownerUserId) }
        : null),
    mailboxStub(env, source.mailboxId).getEmail(source.messageId),
  ]);
  if (!mailbox || !email) throw new Error("Webhook email no longer exists");
  const htmlObject = email.bodyHtmlR2Key
    ? await env.MAIL_STORAGE.get(email.bodyHtmlR2Key)
    : null;
  return {
    mailbox,
    email: publicEmail(email, htmlObject ? await htmlObject.text() : null),
  };
}

async function deliveryId(eventId: string, endpointId: string) {
  const digest = await hashToken(`${eventId}\0${endpointId}`);
  return `whd_${digest.slice(0, 40)}`;
}

async function dispatch(
  env: Env,
  job: WebhookDispatchJob,
) {
  const db = createDb(env.DB);
  const endpointRows = job.endpointId
    ? await db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, job.endpointId))
    : await db
      .select()
      .from(webhookEndpoints);
  const subscribed = endpointRows.filter((endpoint) =>
    job.eventType === "webhook.test"
      ? endpoint.id === job.endpointId
      : endpoint.enabled && endpoint.events.includes(job.eventType)
  );
  if (!subscribed.length) return;

  const deliveries = await Promise.all(subscribed.map(async (endpoint) => ({
    id: await deliveryId(job.eventId, endpoint.id),
    webhookId: endpoint.id,
    eventId: job.eventId,
    eventType: job.eventType,
    source: job.source as unknown as Record<string, unknown>,
    createdAt: new Date(job.occurredAt),
  })));
  const inserts = deliveries.map((delivery) =>
    db.insert(webhookDeliveries).values(delivery).onConflictDoNothing()
  );
  await db.batch([inserts[0]!, ...inserts.slice(1)]);
  await env.WEBHOOKS.sendBatch(deliveries.map((delivery) => ({
    body: {
      type: "deliver",
      deliveryId: delivery.id,
    } satisfies WebhookDeliveryJob,
  })));
  try {
    // Retention is housekeeping; a cleanup failure must not retry a dispatch
    // after its delivery jobs have already been queued.
    await cleanupExpiredWebhookDeliveries(db);
  } catch (error) {
    console.error("Could not clean up expired webhook deliveries", error);
  }
}

async function hmacSignature(secret: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function responseExcerpt(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < RESPONSE_EXCERPT_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = RESPONSE_EXCERPT_BYTES - length;
      const value = chunk.value.subarray(0, remaining);
      chunks.push(value);
      length += value.byteLength;
      if (value.byteLength < chunk.value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function deliver(
  env: Env,
  job: WebhookDeliveryJob,
  attempt: number,
) {
  const db = createDb(env.DB);
  const [record] = await db
    .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints })
    .from(webhookDeliveries)
    .innerJoin(
      webhookEndpoints,
      eq(webhookDeliveries.webhookId, webhookEndpoints.id),
    )
    .where(eq(webhookDeliveries.id, job.deliveryId))
    .limit(1);
  if (!record || record.delivery.status !== "pending") return;
  const [claimed] = await db
    .update(webhookDeliveries)
    .set({ attempts: attempt, lastAttemptAt: new Date() })
    .where(and(
      eq(webhookDeliveries.id, job.deliveryId),
      eq(webhookDeliveries.status, "pending"),
      lt(webhookDeliveries.attempts, attempt),
    ))
    .returning({ id: webhookDeliveries.id });
  if (!claimed) return;

  const isTest = record.delivery.eventType === "webhook.test";
  const stillSubscribed = record.endpoint.events.some(
    (event) => event === record.delivery.eventType,
  );
  if (!isTest && (!record.endpoint.enabled || !stillSubscribed)) {
    await db
      .update(webhookDeliveries)
      .set({
        status: "failed",
        error: record.endpoint.enabled
          ? "Webhook endpoint no longer subscribes to this event"
          : "Webhook endpoint is disabled",
      })
      .where(and(
        eq(webhookDeliveries.id, job.deliveryId),
        eq(webhookDeliveries.status, "pending"),
        eq(webhookDeliveries.attempts, attempt),
      ));
    return;
  }

  const parsedSource = webhookSourceSchema.safeParse(record.delivery.source);
  if (!parsedSource.success) throw new Error("Webhook event source is invalid");
  const payload = JSON.stringify({
    id: record.delivery.eventId,
    type: record.delivery.eventType,
    createdAt: record.delivery.createdAt.toISOString(),
    data: await eventData(env, parsedSource.data),
  });
  const timestamp = Math.floor(Date.now() / 1_000).toString();
  const signature = await hmacSignature(
    record.endpoint.signingSecret,
    timestamp,
    payload,
  );
  const response = await fetch(record.endpoint.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "OpenWorkspace-Webhooks/1.0",
      "x-openworkspace-delivery": record.delivery.id,
      "x-openworkspace-event": record.delivery.eventType,
      "x-openworkspace-timestamp": timestamp,
      "x-openworkspace-signature": `sha256=${signature}`,
    },
    body: payload,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const excerpt = await responseExcerpt(response);
  if (!response.ok) {
    throw new WebhookHttpError(response.status, excerpt);
  }
  await db
    .update(webhookDeliveries)
    .set({
      status: "delivered",
      attempts: attempt,
      responseStatus: response.status,
      responseBody: excerpt || null,
      error: null,
      lastAttemptAt: new Date(),
      deliveredAt: new Date(),
    })
    .where(and(
      eq(webhookDeliveries.id, job.deliveryId),
      eq(webhookDeliveries.status, "pending"),
      eq(webhookDeliveries.attempts, attempt),
    ));
}

async function recordFailure(
  env: Env,
  deliveryIdValue: string,
  attempt: number,
  error: unknown,
) {
  const final = attempt >= MAX_DELIVERY_ATTEMPTS;
  const responseStatus = error instanceof WebhookHttpError
    ? error.responseStatus
    : null;
  const responseBody = error instanceof WebhookHttpError
    ? error.responseBody || null
    : null;
  const updated = await createDb(env.DB)
    .update(webhookDeliveries)
    .set({
      status: final ? "failed" : "pending",
      attempts: attempt,
      responseStatus,
      responseBody,
      error: (error instanceof Error ? error.message : "Delivery failed").slice(0, 2_000),
      lastAttemptAt: new Date(),
    })
    .where(and(
      eq(webhookDeliveries.id, deliveryIdValue),
      eq(webhookDeliveries.status, "pending"),
      eq(webhookDeliveries.attempts, attempt),
    ))
    .returning({ id: webhookDeliveries.id });
  return final || updated.length === 0;
}

export async function consumeWebhooks(
  batch: MessageBatch<unknown>,
  env: Env,
) {
  // A delivery materializes the complete email body from R2. Keep deliveries
  // sequential so a queue batch cannot hold several large payloads in memory.
  for (const message of batch.messages) {
    const parsed = webhookQueueJobSchema.safeParse(message.body);
    if (!parsed.success) {
      console.error("Ignoring invalid webhook job", parsed.error);
      message.ack();
      continue;
    }
    try {
      if (parsed.data.type === "dispatch") {
        await dispatch(env, parsed.data);
      } else {
        await deliver(env, parsed.data, message.attempts);
      }
      message.ack();
    } catch (error) {
      console.error("Could not process webhook job", error);
      if (
        parsed.data.type === "deliver"
        && await recordFailure(
          env,
          parsed.data.deliveryId,
          message.attempts,
          error,
        )
      ) {
        message.ack();
        continue;
      }
      message.retry({
        delaySeconds: Math.min(3_600, 10 * (2 ** Math.max(0, message.attempts - 1))),
      });
    }
  }
}
