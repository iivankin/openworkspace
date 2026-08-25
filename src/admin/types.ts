import type { api, SuccessfulResponse } from "@/lib/api";
import type { WebhookEventType } from "../../shared/webhooks";

type AdminStateResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.admin.state.$get>>
>;

export type AdminMailbox = AdminStateResponse["mailboxes"][number];
export type AdminUser = AdminStateResponse["users"][number];
export type MailboxMemberPermission = AdminMailbox["members"][number];

export type InvitationInput = {
  name: string;
  email: string;
};

export type UpdateUserInput = Pick<AdminUser, "name"> & {
  status?: "active" | "disabled";
};

export type AdminGroup = AdminStateResponse["groups"][number];
export type AdminOidcClient = AdminStateResponse["oidcClients"][number];

type AdminWebhooksResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.admin.webhooks.$get>>
>;

export type AdminWebhook = AdminWebhooksResponse["webhooks"][number];
export type AdminWebhookDelivery = AdminWebhooksResponse["deliveries"][number];

export type WebhookInput = {
  name: string;
  url: string;
  events: WebhookEventType[];
  enabled: boolean;
};

export type CreateMailboxInput = {
  displayName: string;
  address: string;
  members: MailboxMemberPermission[];
};

export type UpdateMailboxInput = Pick<
  CreateMailboxInput,
  "displayName" | "members"
>;
