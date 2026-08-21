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

export const MAX_COMPOSER_ATTACHMENT_BYTES = 500_000_000;
export const MAX_COMPOSER_ATTACHMENT_COUNT = 10;
export const MAX_MAIL_RECIPIENTS = 50;
export const EMAIL_SERVICE_MAX_BYTES = 5 * 1024 * 1024;
export const MIME_FIXED_OVERHEAD_BYTES = 128 * 1024;
export const LINKED_ATTACHMENT_TEXT_PREFIX = "openworkspace-attachment:";

const EMAIL_LOCAL_PART =
  /^[A-Za-z0-9_+'-]+(?:\.[A-Za-z0-9_+'-]+)*$/u;
const EMAIL_DOMAIN_LABEL =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const EMAIL_TOP_LEVEL_DOMAIN = /^[A-Za-z]{2,63}$/u;

const INLINE_COMPOSER_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * Preserve the transport-significant local part while canonicalizing the
 * case-insensitive domain.
 */
export function normalizeExternalEmailAddress(value: string) {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0 || separator === trimmed.length - 1) return trimmed;
  return `${trimmed.slice(0, separator)}@${trimmed.slice(separator + 1).toLocaleLowerCase("en-US")}`;
}

export function isValidExternalEmailAddress(value: string) {
  if (value.length > 254) return false;
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator !== value.indexOf("@")) return false;
  const localPart = value.slice(0, separator);
  const domain = value.slice(separator + 1);
  if (
    localPart.length > 64
    || domain.length > 253
    || !EMAIL_LOCAL_PART.test(localPart)
  ) {
    return false;
  }
  const labels = domain.split(".");
  return labels.length >= 2
    && labels.every((label) => EMAIL_DOMAIN_LABEL.test(label))
    && EMAIL_TOP_LEVEL_DOMAIN.test(labels.at(-1)!);
}

export function isComposerInlineImageContentType(value: string) {
  const mediaType = value.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US")
    ?? "";
  return INLINE_COMPOSER_IMAGE_TYPES.has(mediaType);
}

export function linkedAttachmentTextToken(uploadId: string) {
  return `[[${LINKED_ATTACHMENT_TEXT_PREFIX}${uploadId}]]`;
}

export function composerAttachmentLimitError(
  attachments: ReadonlyArray<{ size: number }>,
) {
  if (attachments.length > MAX_COMPOSER_ATTACHMENT_COUNT) {
    return `Use at most ${MAX_COMPOSER_ATTACHMENT_COUNT} attachments`;
  }
  const totalBytes = attachments.reduce(
    (total, attachment) => total + attachment.size,
    0,
  );
  if (totalBytes > MAX_COMPOSER_ATTACHMENT_BYTES) {
    return `Attachments are limited to ${Math.floor(MAX_COMPOSER_ATTACHMENT_BYTES / 1_000_000)} MB per message`;
  }
  return null;
}

type ComposerAttachmentSize = {
  id: string;
  size: number;
};

function byteLength(value: string | undefined) {
  return value ? new TextEncoder().encode(value).byteLength : 0;
}

function base64EncodedSize(size: number) {
  return 4 * Math.ceil(size / 3);
}

/**
 * Email Service applies its size limit after MIME serialization. Keep this
 * shared so the composer can preview the same attachment/link decision the
 * Worker will make when the message is submitted.
 */
export function attachmentsRequiringDownloadLinks(input: {
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments: ComposerAttachmentSize[];
}) {
  const bodyBytes = byteLength(input.subject)
    + byteLength(input.bodyText)
    + byteLength(input.bodyHtml);
  let estimatedBytes = MIME_FIXED_OVERHEAD_BYTES
    + base64EncodedSize(bodyBytes)
    + input.attachments.reduce(
      (total, attachment) => total + base64EncodedSize(attachment.size) + 2_048,
      0,
    );
  const linked = new Set<string>();
  if (estimatedBytes <= EMAIL_SERVICE_MAX_BYTES) return linked;

  for (
    const attachment of [...input.attachments]
      .sort((left, right) => right.size - left.size)
  ) {
    linked.add(attachment.id);
    estimatedBytes -= base64EncodedSize(attachment.size) + 2_048;
    if (estimatedBytes <= EMAIL_SERVICE_MAX_BYTES) break;
  }
  return linked;
}

export function baseSubject(subject: string) {
  return subject.replace(/^(?:(?:re|fwd):\s*)+/giu, "");
}

export function replySubject(subject: string) {
  return `Re: ${baseSubject(subject)}`;
}

export function forwardSubject(subject: string) {
  return `Fwd: ${baseSubject(subject)}`;
}
