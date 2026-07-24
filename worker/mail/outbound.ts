import type { z } from "zod";
import { MAX_COMPOSER_ATTACHMENT_BYTES } from "../../shared/mail";
import { hashToken, randomToken } from "../lib/crypto";
import type { StoredAttachment } from "../mailbox/model";
import type { Email, NewEmail } from "../mailbox/schema";
import {
  appendForwardedMessage,
  contextForNewRecipient,
  escapeHtml,
  htmlWithQuotedContext,
  textWithQuotedContext,
} from "./outbound-content";
import {
  address,
  replyThreadHeaders,
} from "./rfc";
import type { composeSchema } from "./schemas";

const EMAIL_SERVICE_MAX_BYTES = 5 * 1024 * 1024;
const MIME_FIXED_OVERHEAD_BYTES = 128 * 1024;
const DOWNLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type OutgoingMessageInput = z.infer<typeof composeSchema>;
type AttachmentSize = Pick<StoredAttachment, "id" | "size">;

type PreparedAttachment = StoredAttachment & {
  content?: Uint8Array;
  downloadUrl: string | null;
};

export class ComposerAttachmentLimitError extends Error {}

export async function outgoingRequestFingerprint(compose: OutgoingMessageInput) {
  return hashToken(`outgoing-request-v1\0${JSON.stringify(compose)}`);
}

function byteLength(value: string | undefined) {
  return value ? new TextEncoder().encode(value).byteLength : 0;
}

function base64EncodedSize(size: number) {
  return 4 * Math.ceil(size / 3);
}

/**
 * Email Service applies its 5 MiB limit after MIME serialization. We reserve
 * space for headers and boundaries, then remove the largest attachments until
 * the conservative encoded-size estimate fits.
 */
export function attachmentsRequiringDownloadLinks(input: {
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments: AttachmentSize[];
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

  for (const attachment of [...input.attachments].sort((left, right) => right.size - left.size)) {
    linked.add(attachment.id);
    estimatedBytes -= base64EncodedSize(attachment.size) + 2_048;
    if (estimatedBytes <= EMAIL_SERVICE_MAX_BYTES) break;
  }
  return linked;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function withDownloadLinks(
  bodyText: string,
  bodyHtml: string | undefined,
  attachments: PreparedAttachment[],
  expiresAt: Date,
) {
  const links = attachments.filter(
    (attachment): attachment is PreparedAttachment & { downloadUrl: string } =>
      attachment.downloadUrl !== null,
  );
  if (!links.length) return { bodyText, bodyHtml };

  const expiry = expiresAt.toISOString().slice(0, 10);
  const textBlock = [
    `Attachments (download links expire ${expiry}):`,
    ...links.map((attachment) => `- ${attachment.filename}: ${attachment.downloadUrl}`),
  ].join("\n");
  const nextText = `${bodyText.trimEnd()}${bodyText.trimEnd() ? "\n\n" : ""}${textBlock}`;
  if (!bodyHtml) return { bodyText: nextText, bodyHtml };

  const htmlBlock = [
    `<p>Attachments (download links expire ${escapeHtml(expiry)}):</p>`,
    "<ul>",
    ...links.map((attachment) =>
      `<li><a href="${escapeHtml(attachment.downloadUrl)}">${escapeHtml(attachment.filename)}</a></li>`,
    ),
    "</ul>",
  ].join("");
  return { bodyText: nextText, bodyHtml: `${bodyHtml}${htmlBlock}` };
}

export async function messageIdForRequest(mailboxId: string, requestId: string) {
  return `msg_${await hashToken(`${mailboxId}:${requestId}`)}`;
}

export async function prepareOutgoingEmail(input: {
  env: Env;
  requestUrl: string;
  compose: OutgoingMessageInput;
  requestFingerprint: string;
  id: string;
  conversationId: string;
  related: Email | null;
  forwarded: Email | null;
  includeRelatedContext: boolean;
  fromAddress: string;
  fromName: string;
  now: Date;
}) {
  const { compose, id, related } = input;
  const storageAttempt = randomToken();
  const storagePrefix = `mailboxes/${compose.mailboxId}/messages/${id}/attempts/${storageAttempt}`;
  const expiresAt = new Date(input.now.getTime() + DOWNLOAD_TTL_MS);
  const decoded: PreparedAttachment[] = compose.attachments.map((file, index) => {
    const content = decodeBase64(file.contentBase64);
    return {
      id: `att_${index + 1}`,
      content,
      r2Key: `${storagePrefix}/attachments/att_${index + 1}`,
      filename: file.filename,
      contentType: file.contentType,
      size: content.byteLength,
      contentId: null,
      disposition: "attachment" as const,
      delivery: "attached" as const,
      downloadTokenHash: null,
      downloadExpiresAt: null,
      downloadUrl: null,
    };
  });
  if (
    decoded.reduce((total, file) => total + file.size, 0)
      > MAX_COMPOSER_ATTACHMENT_BYTES
  ) {
    throw new ComposerAttachmentLimitError("Attachments exceed the 20 MB composer limit");
  }

  // A forwarded attachment can reuse its immutable R2 object. Delivery mode
  // and public token are recalculated for the new message.
  const forwardedAttachments: PreparedAttachment[] = (
    input.forwarded?.attachmentsJson ?? []
  ).map((file, index) => ({
    ...file,
    id: `fwd_att_${index + 1}`,
    contentId: null,
    disposition: "attachment",
    delivery: "attached",
    downloadTokenHash: null,
    downloadExpiresAt: null,
    downloadUrl: null,
  }));
  const allFiles = [...decoded, ...forwardedAttachments];
  const forwardedContent = appendForwardedMessage(
    compose.bodyText,
    compose.bodyHtml,
    input.forwarded,
  );
  const quotedText = input.includeRelatedContext && related
    ? contextForNewRecipient(related)
    : null;
  const linkedIds = attachmentsRequiringDownloadLinks({
    subject: compose.subject,
    bodyText: textWithQuotedContext(forwardedContent.bodyText, quotedText),
    bodyHtml: forwardedContent.bodyHtml
      ? htmlWithQuotedContext(forwardedContent.bodyHtml, quotedText)
      : undefined,
    attachments: allFiles,
  });
  const attachments: PreparedAttachment[] = await Promise.all(
    allFiles.map(async (file) => {
      if (!linkedIds.has(file.id)) return file;
      const token = `${compose.mailboxId}.${id}.${file.id}.${randomToken()}`;
      return {
        ...file,
        delivery: "download_link" as const,
        downloadTokenHash: await hashToken(token),
        downloadExpiresAt: expiresAt.getTime(),
        downloadUrl: new URL(
          `/api/downloads/mail/${encodeURIComponent(token)}`,
          input.requestUrl,
        ).toString(),
      };
    }),
  );
  const content = withDownloadLinks(
    forwardedContent.bodyText,
    forwardedContent.bodyHtml,
    attachments,
    expiresAt,
  );
  const finalBodyHtml = content.bodyHtml
    ? htmlWithQuotedContext(content.bodyHtml, quotedText)
    : undefined;
  const bodyHtmlR2Key = finalBodyHtml
    ? `${storagePrefix}/body.html`
    : null;
  await Promise.all([
    ...attachments.flatMap((file) => file.content ? [
      input.env.MAIL_STORAGE.put(file.r2Key, file.content, {
        httpMetadata: { contentType: file.contentType },
      }),
    ] : []),
    ...(bodyHtmlR2Key && finalBodyHtml
      ? [input.env.MAIL_STORAGE.put(bodyHtmlR2Key, finalBodyHtml, {
          httpMetadata: { contentType: "text/html; charset=utf-8" },
        })]
      : []),
  ]);

  const from = address(input.fromAddress, input.fromName);
  const to = compose.to.map((value) => address(value));
  const cc = compose.cc.map((value) => address(value));
  const bcc = compose.bcc.map((value) => address(value));
  const replyTo = compose.replyTo ? [address(compose.replyTo)] : [];
  const threadHeaders = related
    ? replyThreadHeaders(related)
    : { inReplyTo: [], references: [] };
  const continuedList = related?.conversationId === input.conversationId
    ? related
    : null;
  const email: NewEmail = {
    id,
    requestFingerprint: input.requestFingerprint,
    conversationId: input.conversationId,
    direction: "outgoing",
    messageIdHeader: null,
    inReplyToJson: threadHeaders.inReplyTo,
    referencesJson: threadHeaders.references,
    fromJson: [from],
    replyToJson: replyTo,
    toJson: to,
    ccJson: cc,
    bccJson: bcc,
    subject: compose.subject || "(no subject)",
    preview: (compose.bodyText || forwardedContent.bodyText)
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 220),
    bodyText: content.bodyText,
    quotedText,
    bodyHtmlR2Key,
    attachmentsJson: attachments.map(({ content: _, downloadUrl: __, ...file }) => file),
    listId: continuedList?.listId ?? null,
    listPostAddress: continuedList?.listPostAddress ?? null,
    timelineAt: input.now,
    transportState: "unconfirmed",
    deliveryStatusJson: [],
  };
  return {
    email,
    externalizedAttachments: linkedIds.size,
    storageKeys: [
      ...attachments.flatMap((file) => file.content ? [file.r2Key] : []),
      ...(bodyHtmlR2Key ? [bodyHtmlR2Key] : []),
    ],
  };
}
