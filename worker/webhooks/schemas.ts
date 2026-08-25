import { z } from "zod";
import { webhookEventTypes } from "../../shared/webhooks";

const webhookUrlSchema = z.url().max(2048).transform((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      message: "Webhook URL must use HTTPS",
    });
    return z.NEVER;
  }
  if (url.username || url.password || url.hash) {
    context.addIssue({
      code: "custom",
      message: "Webhook URL cannot contain credentials or a fragment",
    });
    return z.NEVER;
  }
  return url.toString();
});

const webhookEventsSchema = z
  .array(z.enum(webhookEventTypes))
  .min(1, "Choose at least one event")
  .max(webhookEventTypes.length)
  .refine(
    (events) => new Set(events).size === events.length,
    "Events must be unique",
  );

export const webhookEndpointInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  url: webhookUrlSchema,
  events: webhookEventsSchema,
  enabled: z.boolean(),
});

export type WebhookEndpointInput = z.infer<typeof webhookEndpointInputSchema>;
