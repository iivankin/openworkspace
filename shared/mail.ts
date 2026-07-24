export const mailboxStates = ["active", "archive", "spam", "trash"] as const;
export type MailboxState = (typeof mailboxStates)[number];

export const transportStates = [
  "received",
  "unconfirmed",
  "submitted",
  "failed",
] as const;
export type TransportState = (typeof transportStates)[number];

export const replyActionModes = [
  "reply",
  "reply_all",
  "continue",
  "reply_list",
] as const;
export type ReplyActionMode = (typeof replyActionModes)[number];

export type ReplyAction = {
  mode: ReplyActionMode;
  label: string;
  to: string[];
  cc: string[];
};

export type ReplyPlan = {
  defaultMode: ReplyActionMode;
  isGroup: boolean;
  participants: string[];
  actions: ReplyAction[];
};

export const deliveryStatuses = [
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "rejected",
  "complained",
] as const;
export type DeliveryStatusName = (typeof deliveryStatuses)[number];

export type RecipientDeliveryStatus = {
  recipient: string;
  status: DeliveryStatusName;
  eventId: string;
  eventAt: number;
  smtpCode: string | null;
  detail: string | null;
};

export const MAX_COMPOSER_ATTACHMENT_BYTES = 20_000_000;
export const MAX_COMPOSER_ATTACHMENT_COUNT = 10;
export const MAX_MAIL_RECIPIENTS = 50;

export function baseSubject(subject: string) {
  return subject.replace(/^(?:(?:re|fwd):\s*)+/giu, "");
}

export function replySubject(subject: string) {
  return `Re: ${baseSubject(subject)}`;
}

export function forwardSubject(subject: string) {
  return `Fwd: ${baseSubject(subject)}`;
}
