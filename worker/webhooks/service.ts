import { desc, eq, lt } from "drizzle-orm";
import type { WebhookEventType } from "../../shared/webhooks";
import { createDb, type Database } from "../db/client";
import {
  webhookDeliveries,
  webhookEndpoints,
  mailboxMembers,
  mailboxes,
  users,
} from "../db/schema";
import { randomToken } from "../lib/crypto";
import { createId } from "../lib/ids";
import type { WebhookEndpointInput } from "./schemas";

const MAX_WEBHOOK_ENDPOINTS = 20;
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const WEBHOOK_ENQUEUE_ATTEMPTS = 3;

export const WEBHOOK_QUEUE = "openworkspace-webhooks";

export class WebhookEndpointLimitError extends Error {}

export type WebhookEventSource =
  | {
      kind: "email";
      mailboxId: string;
      messageId: string;
    }
  | {
      kind: "data";
      data: Record<string, unknown>;
    };

export type WebhookDispatchJob = {
  type: "dispatch";
  eventId: string;
  eventType: WebhookEventType | "webhook.test";
  occurredAt: number;
  source: WebhookEventSource;
  endpointId?: string;
};

export type WebhookDeliveryJob = {
  type: "deliver";
  deliveryId: string;
};

export type WebhookQueueJob = WebhookDispatchJob | WebhookDeliveryJob;

export function cleanupExpiredWebhookDeliveries(db: Database) {
  return db
    .delete(webhookDeliveries)
    .where(lt(
      webhookDeliveries.createdAt,
      new Date(Date.now() - DELIVERY_RETENTION_MS),
    ));
}

function publicEndpoint(endpoint: typeof webhookEndpoints.$inferSelect) {
  const { signingSecret: _signingSecret, ...publicFields } = endpoint;
  return publicFields;
}

function signingSecret() {
  return `whsec_${randomToken()}`;
}

export async function listWebhookSettings(db: Database) {
  await cleanupExpiredWebhookDeliveries(db);
  const [endpoints, deliveries] = await Promise.all([
    db.select().from(webhookEndpoints).orderBy(webhookEndpoints.name),
    db
      .select({
        id: webhookDeliveries.id,
        webhookId: webhookDeliveries.webhookId,
        eventId: webhookDeliveries.eventId,
        eventType: webhookDeliveries.eventType,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        responseStatus: webhookDeliveries.responseStatus,
        responseBody: webhookDeliveries.responseBody,
        error: webhookDeliveries.error,
        lastAttemptAt: webhookDeliveries.lastAttemptAt,
        deliveredAt: webhookDeliveries.deliveredAt,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(50),
  ]);
  return {
    webhooks: endpoints.map(publicEndpoint),
    deliveries,
  };
}

export async function createWebhookEndpoint(
  db: Database,
  createdByUserId: string,
  input: WebhookEndpointInput,
) {
  const existing = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints);
  if (existing.length >= MAX_WEBHOOK_ENDPOINTS) {
    throw new WebhookEndpointLimitError(
      `An account can have at most ${MAX_WEBHOOK_ENDPOINTS} webhook endpoints`,
    );
  }
  const secret = signingSecret();
  const now = new Date();
  const endpoint = {
    id: createId("whk"),
    ...input,
    signingSecret: secret,
    createdByUserId,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(webhookEndpoints).values(endpoint);
  return { webhook: publicEndpoint(endpoint), signingSecret: secret };
}

export async function updateWebhookEndpoint(
  db: Database,
  id: string,
  input: WebhookEndpointInput,
) {
  const [endpoint] = await db
    .update(webhookEndpoints)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(webhookEndpoints.id, id))
    .returning();
  return endpoint ? publicEndpoint(endpoint) : null;
}

export async function deleteWebhookEndpoint(db: Database, id: string) {
  const deleted = await db
    .delete(webhookEndpoints)
    .where(eq(webhookEndpoints.id, id))
    .returning({ id: webhookEndpoints.id });
  return deleted.length > 0;
}

export async function rotateWebhookSecret(db: Database, id: string) {
  const secret = signingSecret();
  const [endpoint] = await db
    .update(webhookEndpoints)
    .set({ signingSecret: secret, updatedAt: new Date() })
    .where(eq(webhookEndpoints.id, id))
    .returning();
  return endpoint
    ? { webhook: publicEndpoint(endpoint), signingSecret: secret }
    : null;
}

export function queueWebhookEvent(
  env: Env,
  input: Omit<WebhookDispatchJob, "type">,
) {
  return env.WEBHOOKS.send({
    type: "dispatch",
    ...input,
  } satisfies WebhookDispatchJob);
}

export function deferWebhookTask(
  defer: (task: Promise<unknown>) => void,
  task: (eventId: string) => Promise<unknown>,
) {
  const eventId = createId("evt");
  defer(
    (async () => {
      for (let attempt = 1; attempt <= WEBHOOK_ENQUEUE_ATTEMPTS; attempt += 1) {
        try {
          await task(eventId);
          return;
        } catch (error) {
          if (attempt === WEBHOOK_ENQUEUE_ATTEMPTS) {
            // Queue ingress stays isolated from the operation that produced the
            // event, but brief producer failures get more than one chance.
            console.error("Could not queue webhook event", error);
          }
        }
      }
    })(),
  );
}

async function userWebhookData(db: Database, userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      status: users.status,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      email: mailboxes.address,
    })
    .from(users)
    .leftJoin(mailboxes, eq(mailboxes.personalOwnerId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  return user
    ? {
        ...user,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
      }
    : null;
}

export async function queueUserWebhookEvent(
  env: Env,
  eventType: "user.joined" | "user.updated",
  userId: string,
  eventId: string,
) {
  const user = await userWebhookData(createDb(env.DB), userId);
  if (!user) return;
  await queueWebhookEvent(env, {
    eventId,
    eventType,
    occurredAt: Date.now(),
    source: { kind: "data", data: { user } },
  });
}

export async function mailboxWebhookData(db: Database, mailboxId: string) {
  const [mailbox, members] = await Promise.all([
    db
      .select({
        id: mailboxes.id,
        address: mailboxes.address,
        displayName: mailboxes.displayName,
        kind: mailboxes.kind,
        createdAt: mailboxes.createdAt,
        updatedAt: mailboxes.updatedAt,
      })
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({
        userId: mailboxMembers.userId,
        canSend: mailboxMembers.canSend,
      })
      .from(mailboxMembers)
      .where(eq(mailboxMembers.mailboxId, mailboxId)),
  ]);
  return mailbox
    ? {
        ...mailbox,
        createdAt: mailbox.createdAt.toISOString(),
        updatedAt: mailbox.updatedAt.toISOString(),
        members,
      }
    : null;
}

export async function queueMailboxWebhookEvent(
  env: Env,
  eventType: "mailbox.created" | "mailbox.updated" | "mailbox.deleted",
  mailbox: NonNullable<Awaited<ReturnType<typeof mailboxWebhookData>>>,
  eventId: string,
) {
  await queueWebhookEvent(env, {
    eventId,
    eventType,
    occurredAt: Date.now(),
    source: { kind: "data", data: { mailbox } },
  });
}

export function queueWebhookTest(env: Env, endpointId: string) {
  const now = Date.now();
  return queueWebhookEvent(env, {
    eventId: createId("evt"),
    eventType: "webhook.test",
    occurredAt: now,
    endpointId,
    source: {
      kind: "data",
      data: {
        message: "OpenWorkspace webhook test",
        sentAt: new Date(now).toISOString(),
      },
    },
  });
}

export function emailWebhookEventId(
  eventType: "email.received" | "email.sent",
  mailboxId: string,
  messageId: string,
) {
  return `evt_${eventType.replace(".", "_")}_${mailboxId}_${messageId}`;
}
