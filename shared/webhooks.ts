export const webhookEventTypes = [
  "email.received",
  "email.sent",
  "user.joined",
  "user.updated",
  "mailbox.created",
  "mailbox.updated",
  "mailbox.deleted",
] as const;

export type WebhookEventType = (typeof webhookEventTypes)[number];

export const webhookDeliveryStatuses = [
  "pending",
  "delivered",
  "failed",
] as const;

export type WebhookDeliveryStatus =
  (typeof webhookDeliveryStatuses)[number];
