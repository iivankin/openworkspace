import type { z } from "zod";
import {
  attachmentsRequiringDownloadLinks,
  composerAttachmentLimitError,
  isComposerInlineImageContentType,
} from "../../shared/mail";
import { hashToken, randomToken } from "../lib/crypto";
import type { StoredAttachment } from "../mailbox/model";
import type { Email, NewEmail } from "../mailbox/schema";
import {
  appendForwardedMessage,
  contextForNewRecipient,
  escapeHtml,
  externalizeLinkedInlineImages,
  htmlWithQuotedContext,
  resolveLinkedAttachmentPlaceholders,
  textWithQuotedContext,
} from "./outbound-content";
import {
  address,
  replyThreadHeaders,
} from "./rfc";
import type { composeSchema } from "./schemas";
import {
  copyComposerUploadToMessage,
  loadComposerUpload,
  loadComposerUploadMetadata,
  UploadValidationError,
} from "./uploads";

const DOWNLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type OutgoingMessageInput = z.infer<typeof composeSchema> & {
  /** Set by the route from the authenticated session. */
  userId: string;
};
type PreparedAttachment = StoredAttachment & {
  downloadUrl: string | null;
  sourceUploadId?: string;
  sourceUploadKey?: string;
};

export class ComposerAttachmentLimitError extends Error {}

type OutgoingAttachmentDraft = Pick<
  OutgoingMessageInput,
  | "attachments"
  | "bodyHtml"
  | "bodyText"
  | "mailboxId"
  | "subject"
  | "userId"
>;

export async function discardPreparedObjects(env: Env, storageKeys: string[]) {
  if (!storageKeys.length) return;
  try {
    await env.MAIL_STORAGE.delete(storageKeys);
  } catch (error) {
    // Attempt-scoped keys cannot corrupt the winning idempotent request.
    console.error("Could not remove unused outgoing mail objects", error);
  }
}

export async function outgoingRequestFingerprint(compose: OutgoingMessageInput) {
  const { userId: _, ...payload } = compose;
  return hashToken(`outgoing-request-v2\0${JSON.stringify(payload)}`);
}

export { attachmentsRequiringDownloadLinks };

export function withDownloadLinks(
  bodyText: string,
  bodyHtml: string | undefined,
  attachments: PreparedAttachment[],
  expiresAt: Date,
) {
  const positioned = resolveLinkedAttachmentPlaceholders({
    bodyText,
    bodyHtml,
    attachments: attachments.map((attachment) => ({
      uploadId: attachment.sourceUploadId ?? null,
      filename: attachment.filename,
      downloadUrl: attachment.downloadUrl,
    })),
  });
  const links = attachments.filter(
    (attachment): attachment is PreparedAttachment & { downloadUrl: string } =>
      attachment.downloadUrl !== null,
  );
  if (!links.length) {
    return {
      bodyText: positioned.bodyText,
      bodyHtml: positioned.bodyHtml,
    };
  }

  const expiry = expiresAt.toISOString().slice(0, 10);
  const fallbackTextLinks = links.filter(
    (attachment) =>
      !attachment.sourceUploadId
      || !positioned.textPlacedUploadIds.has(attachment.sourceUploadId),
  );
  const textBlock = fallbackTextLinks.length
    ? [
        `Attachments (download links expire ${expiry}):`,
        ...fallbackTextLinks.map((attachment) =>
          `- ${attachment.filename}: ${attachment.downloadUrl}`
        ),
      ].join("\n")
    : "";
  const nextText = textBlock
    ? `${positioned.bodyText.trimEnd()}${positioned.bodyText.trimEnd() ? "\n\n" : ""}${textBlock}`
    : positioned.bodyText;
  if (!positioned.bodyHtml) {
    return { bodyText: nextText, bodyHtml: positioned.bodyHtml };
  }

  const inlineImagePlacements = new Set(
    links.flatMap((attachment) =>
      attachment.disposition === "inline"
        && attachment.contentId
        && positioned.bodyHtml!.includes(`cid:${attachment.contentId}`)
        ? [attachment.id]
        : []
    ),
  );
  const nextHtml = externalizeLinkedInlineImages(positioned.bodyHtml, links);
  const fallbackHtmlLinks = links.filter(
    (attachment) =>
      (
        !attachment.sourceUploadId
        || !positioned.htmlPlacedUploadIds.has(attachment.sourceUploadId)
      )
      && !inlineImagePlacements.has(attachment.id),
  );
  if (!fallbackHtmlLinks.length) {
    return { bodyText: nextText, bodyHtml: nextHtml };
  }

  const htmlBlock = [
    `<p>Attachments (download links expire ${escapeHtml(expiry)}):</p>`,
    "<ul>",
    ...fallbackHtmlLinks.map((attachment) =>
      `<li><a href="${escapeHtml(attachment.downloadUrl)}">${escapeHtml(attachment.filename)}</a></li>`,
    ),
    "</ul>",
  ].join("");
  return { bodyText: nextText, bodyHtml: `${nextHtml}${htmlBlock}` };
}

export async function messageIdForRequest(mailboxId: string, requestId: string) {
  return `msg_${await hashToken(`${mailboxId}:${requestId}`)}`;
}

async function loadPreparedComposerAttachments(input: {
  env: Env;
  compose: OutgoingAttachmentDraft;
  storagePrefix: string;
  finalized: boolean;
}) {
  const loadUpload = input.finalized
    ? loadComposerUpload
    : loadComposerUploadMetadata;
  return Promise.all(
    input.compose.attachments.map(async (file, index) => {
      try {
        const upload = await loadUpload({
          env: input.env,
          mailboxId: input.compose.mailboxId,
          userId: input.compose.userId,
          uploadId: file.uploadId,
        });
        if (
          file.disposition === "inline"
          && !isComposerInlineImageContentType(upload.contentType)
        ) {
          throw new UploadValidationError(
            "Inline images must be PNG, JPEG, GIF, or WebP",
          );
        }
        return {
          id: `att_${index + 1}`,
          sourceUploadId: file.uploadId,
          sourceUploadKey: upload.r2Key,
          r2Key: `${input.storagePrefix}/attachments/att_${index + 1}`,
          filename: upload.filename,
          contentType: upload.contentType,
          size: upload.size,
          contentId: file.contentId ?? null,
          disposition: file.disposition,
          delivery: "attached" as const,
          downloadTokenHash: null,
          downloadExpiresAt: null,
          downloadUrl: null,
        } satisfies PreparedAttachment;
      } catch (error) {
        if (error instanceof UploadValidationError) {
          throw new ComposerAttachmentLimitError(error.message);
        }
        throw error;
      }
    }),
  );
}

function planOutgoingAttachments(input: {
  compose: OutgoingAttachmentDraft;
  uploaded: PreparedAttachment[];
  forwarded: Email | null;
  related: Email | null;
  includeRelatedContext: boolean;
}) {
  // Forwarded files reuse immutable source objects. Their delivery mode and
  // download tokens are recalculated for the new message.
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
  const attachments = [...input.uploaded, ...forwardedAttachments];
  const limitError = composerAttachmentLimitError(attachments);
  if (limitError) throw new ComposerAttachmentLimitError(limitError);
  const forwardedContent = appendForwardedMessage(
    input.compose.bodyText,
    input.compose.bodyHtml,
    input.forwarded,
  );
  const quotedText = input.includeRelatedContext && input.related
    ? contextForNewRecipient(input.related)
    : null;
  const linkedIds = attachmentsRequiringDownloadLinks({
    subject: input.compose.subject,
    bodyText: textWithQuotedContext(forwardedContent.bodyText, quotedText),
    bodyHtml: forwardedContent.bodyHtml
      ? htmlWithQuotedContext(forwardedContent.bodyHtml, quotedText)
      : undefined,
    attachments,
  });
  return {
    attachments,
    forwardedContent,
    linkedIds,
    quotedText,
  };
}

export async function preflightOutgoingAttachments(input: {
  env: Env;
  compose: OutgoingAttachmentDraft;
  forwarded: Email | null;
  related: Email | null;
  includeRelatedContext: boolean;
}) {
  const uploaded = await loadPreparedComposerAttachments({
    env: input.env,
    compose: input.compose,
    storagePrefix: "preflight",
    finalized: false,
  });
  const plan = planOutgoingAttachments({
    ...input,
    uploaded,
  });
  return {
    externalizedAttachments: plan.linkedIds.size,
    linkedUploadIds: uploaded.flatMap((attachment) =>
      plan.linkedIds.has(attachment.id) && attachment.sourceUploadId
        ? [attachment.sourceUploadId]
        : []
    ),
  };
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

  const uploaded = await loadPreparedComposerAttachments({
    env: input.env,
    compose,
    storagePrefix,
    finalized: true,
  });
  const plan = planOutgoingAttachments({
    compose,
    uploaded,
    forwarded: input.forwarded,
    related,
    includeRelatedContext: input.includeRelatedContext,
  });
  const {
    forwardedContent,
    linkedIds,
    quotedText,
  } = plan;
  const attachments: PreparedAttachment[] = await Promise.all(
    plan.attachments.map(async (file) => {
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
  // The stored body is the authored content only. Quoted context is persisted
  // separately and added to the transport payload at delivery time.
  const storedBodyHtml = content.bodyHtml;
  const bodyHtmlR2Key = storedBodyHtml
    ? `${storagePrefix}/body.html`
    : null;

  const storageKeys = [
    ...attachments.flatMap((file) =>
      file.sourceUploadKey ? [file.r2Key] : []
    ),
    ...(bodyHtmlR2Key ? [bodyHtmlR2Key] : []),
  ];
  const writes = [
    ...attachments.flatMap((file) => {
      if (!file.sourceUploadKey) return [];
      return [
        copyComposerUploadToMessage({
          env: input.env,
          sourceKey: file.sourceUploadKey,
          destinationKey: file.r2Key,
          contentType: file.contentType,
        }),
      ];
    }),
    ...(bodyHtmlR2Key && storedBodyHtml
      ? [input.env.MAIL_STORAGE.put(bodyHtmlR2Key, storedBodyHtml, {
          httpMetadata: { contentType: "text/html; charset=utf-8" },
        })]
      : []),
  ];
  const writeResults = await Promise.allSettled(writes);
  const failedWrite = writeResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failedWrite) {
    await discardPreparedObjects(input.env, storageKeys);
    throw failedWrite.reason;
  }

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
    preview: content.bodyText
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 220),
    bodyText: content.bodyText,
    quotedText,
    bodyHtmlR2Key,
    attachmentsJson: attachments.map(
      ({
        downloadUrl: _,
        sourceUploadId: __,
        sourceUploadKey: ___,
        ...file
      }) => file,
    ),
    listId: continuedList?.listId ?? null,
    listPostAddress: continuedList?.listPostAddress ?? null,
    timelineAt: input.now,
    transportState: "unconfirmed",
    deliveryStatusJson: [],
  };
  return {
    email,
    externalizedAttachments: linkedIds.size,
    // Only attempt-scoped objects may be deleted on rollback. Forwarded
    // attachments reuse immutable source keys and must not be removed.
    storageKeys,
    composerUploadIds: uploaded.flatMap((file) =>
      file.sourceUploadId ? [file.sourceUploadId] : []
    ),
  };
}
