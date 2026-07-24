import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  baseSubject,
  forwardSubject,
  MAX_MAIL_RECIPIENTS,
  replySubject,
} from "../../shared/mail";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import { mailboxMembers, mailboxes } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import { mailboxStub } from "../mailbox";
import type { Email } from "../mailbox/schema";
import { getMailboxAccess } from "./access";
import {
  decodeConversationCursor,
  encodeConversationCursor,
} from "./conversation-cursor";
import { ComposerAttachmentLimitError } from "./outbound";
import {
  OutgoingRequestConflictError,
  submitOutgoing,
} from "./outbound-service";
import {
  hasNewRecipients,
  shouldDetachOutboundReply,
} from "./outbound-threading";
import { participantLabels } from "./participants";
import { dedupeRecipientFields, recipientCount } from "./recipients";
import { buildReplyPlan, canReplyFrom } from "./reply-plan";
import {
  composeSchema,
  conversationListQuerySchema,
  forwardSchema,
  mailboxQuerySchema,
  replySchema,
  updateConversationSchema,
} from "./schemas";

const SAFE_INLINE_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function mediaType(contentType: string) {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function toMessageSummary(email: Email) {
  const from = email.fromJson[0] ?? { address: "unknown@invalid", name: null };
  return {
    id: email.id,
    conversationId: email.conversationId,
    direction: email.direction,
    fromAddress: from.address,
    fromName: from.name,
    toAddresses: email.toJson.map((item) => item.address),
    ccAddresses: email.ccJson.map((item) => item.address),
    bccAddresses: email.bccJson.map((item) => item.address),
    replyToAddresses: email.replyToJson.map((item) => item.address),
    subject: email.subject,
    preview: email.preview,
    transportState: email.transportState,
    transportError: email.transportError,
    deliveryStatuses: email.deliveryStatusJson,
    timelineAt: email.timelineAt,
  };
}

function toMessageDetail(email: Email, ownAddress: string) {
  return {
    ...toMessageSummary(email),
    bodyText: email.bodyText,
    quotedText: email.quotedText,
    hasHtmlBody: Boolean(email.bodyHtmlR2Key),
    hasOriginal: Boolean(email.rawMimeR2Key),
    attachments: email.attachmentsJson.map((file) => ({
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
      contentId: file.contentId,
      disposition: file.disposition,
    })),
    replyPlan: buildReplyPlan(ownAddress, email),
  };
}

function conversationLabel(ownAddress: string, latest: Email) {
  const labels = participantLabels(
    [...latest.fromJson, ...latest.toJson, ...latest.ccJson],
    ownAddress,
  );
  if (!labels.length) return latest.fromJson[0]?.name || latest.fromJson[0]?.address || "Unknown sender";
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 3).join(", ")} +${labels.length - 3}`;
}

function conversationSubject(subject: string) {
  return baseSubject(subject) || "(no subject)";
}

function outboundTransportState(email: Email) {
  if (email.transportState === "received") {
    throw new Error("Outgoing message has an inbound transport state");
  }
  return email.transportState;
}

async function accessibleMailbox(
  env: Env,
  userId: string,
  mailboxId: string,
  permission: "read" | "send",
) {
  const access = await getMailboxAccess(createDb(env.DB), userId, mailboxId);
  if (!access || (permission === "send" && !access.canSend)) return null;
  return access;
}

function outgoingResponse(email: Email, detached: boolean) {
  return {
    ok: true as const,
    messageId: email.id,
    conversationId: email.conversationId,
    transportState: outboundTransportState(email),
    transportError: email.transportError,
    detached,
    externalizedAttachments: email.attachmentsJson.filter(
      (file) => file.delivery === "download_link",
    ).length,
  };
}

function outgoingFailure(
  c: Parameters<typeof apiError>[0],
  error: unknown,
) {
  if (error instanceof ComposerAttachmentLimitError) {
    return apiError(c, 400, "BAD_REQUEST", error.message);
  }
  if (error instanceof OutgoingRequestConflictError) {
    return apiError(c, 409, "CONFLICT", error.message);
  }
  throw error;
}

export const mailRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/mailboxes", async (c) => {
    const rows = await createDb(c.env.DB)
      .select({
        id: mailboxes.id,
        address: mailboxes.address,
        displayName: mailboxes.displayName,
        kind: mailboxes.kind,
        canSend: mailboxMembers.canSend,
      })
      .from(mailboxMembers)
      .innerJoin(mailboxes, eq(mailboxMembers.mailboxId, mailboxes.id))
      .where(eq(mailboxMembers.userId, c.get("user").id))
      .orderBy(mailboxes.kind, mailboxes.displayName);

    return c.json({ ok: true as const, mailboxes: rows });
  })
  .get("/mailboxes/:id/folders", async (c) => {
    const mailboxId = c.req.param("id");
    const access = await accessibleMailbox(
      c.env,
      c.get("user").id,
      mailboxId,
      "read",
    );
    if (!access) {
      return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
    }
    const storedFolders = await mailboxStub(c.env, mailboxId).listFolders();
    return c.json({
      ok: true as const,
      folders: storedFolders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        kind: folder.kind,
        systemType: folder.systemType,
      })),
    });
  })
  .get("/conversations", zValidator("query", conversationListQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const access = await accessibleMailbox(c.env, c.get("user").id, query.mailboxId, "read");
    if (!access) {
      return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
    }
    const cursor = query.cursor ? decodeConversationCursor(query.cursor) : null;
    if (query.cursor && !cursor) {
      return apiError(c, 400, "BAD_REQUEST", "Conversation cursor is invalid");
    }
    const page = await mailboxStub(c.env, query.mailboxId).listConversations(
      query.folder,
      query.limit,
      cursor,
      query.search,
    );
    if (!page) return apiError(c, 404, "NOT_FOUND", "Folder not found");
    return c.json({
      ok: true as const,
      conversations: page.items.map((item) => ({
        ...toMessageSummary(item.email),
        subject: conversationSubject(item.email.subject),
        conversationLabel: conversationLabel(
          access.address,
          item.email,
        ),
      })),
      nextCursor: page.next ? encodeConversationCursor(page.next) : null,
    });
  })
  .get(
    "/conversations/:id",
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const access = await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read");
      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const snapshot = await mailboxStub(c.env, mailboxId)
        .getConversationSnapshot(c.req.param("id"));
      if (!snapshot) return apiError(c, 404, "NOT_FOUND", "Conversation not found");
      return c.json({
        ok: true as const,
        mailboxState: snapshot.mailboxState,
        folderId: snapshot.folderId,
        messages: snapshot.messages.map((email) => toMessageDetail(email, access.address)),
      });
    },
  )
  .patch(
    "/conversations/:id",
    zValidator("query", mailboxQuerySchema),
    zValidator("json", updateConversationSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const input = c.req.valid("json");
      const updated = await mailboxStub(c.env, mailboxId).updateConversation(
        c.req.param("id"),
        {
          mailboxState: input.mailboxState,
          folderId: input.folderId,
        },
      );
      if (!updated) return apiError(c, 404, "NOT_FOUND", "Conversation not found");
      return c.json({ ok: true as const });
    },
  )
  .get(
    "/messages/:messageId/html",
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const message = await mailboxStub(c.env, mailboxId)
        .getEmail(c.req.param("messageId"));
      if (!message?.bodyHtmlR2Key) {
        return apiError(c, 404, "NOT_FOUND", "HTML body not found");
      }
      const object = await c.env.MAIL_STORAGE.get(message.bodyHtmlR2Key);
      if (!object) return apiError(c, 404, "NOT_FOUND", "HTML body is missing");
      return new Response(object.body, {
        headers: {
          "cache-control": "private, no-store",
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    },
  )
  .get(
    "/messages/:messageId/original",
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const message = await mailboxStub(c.env, mailboxId)
        .getEmail(c.req.param("messageId"));
      if (!message?.rawMimeR2Key) {
        return apiError(c, 404, "NOT_FOUND", "Original message not found");
      }
      const object = await c.env.MAIL_STORAGE.get(message.rawMimeR2Key);
      if (!object) {
        return apiError(c, 404, "NOT_FOUND", "Original message is missing");
      }
      return new Response(object.body, {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(`${message.id}.eml`)}`,
          "content-type": "text/plain; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
    },
  )
  .get(
    "/messages/:messageId/attachments/:attachmentId",
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const file = await mailboxStub(c.env, mailboxId).getAttachment(
        c.req.param("messageId"),
        c.req.param("attachmentId"),
      );
      if (!file) return apiError(c, 404, "NOT_FOUND", "Attachment not found");
      const object = await c.env.MAIL_STORAGE.get(file.r2Key);
      if (!object) return apiError(c, 404, "NOT_FOUND", "Attachment data is missing");
      return new Response(object.body, {
        headers: {
          "cache-control": "private, no-store",
          "content-type": file.contentType,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
          "x-content-type-options": "nosniff",
        },
      });
    },
  )
  .get(
    "/messages/:messageId/attachments/:attachmentId/inline",
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const file = await mailboxStub(c.env, mailboxId).getAttachment(
        c.req.param("messageId"),
        c.req.param("attachmentId"),
      );
      const contentType = file ? mediaType(file.contentType) : "";
      if (
        !file?.contentId
        || !SAFE_INLINE_IMAGE_TYPES.has(contentType)
      ) {
        return apiError(c, 404, "NOT_FOUND", "Inline image not found");
      }
      const object = await c.env.MAIL_STORAGE.get(file.r2Key);
      if (!object) {
        return apiError(c, 404, "NOT_FOUND", "Inline image data is missing");
      }
      return new Response(object.body, {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
          "content-type": contentType,
          "cross-origin-resource-policy": "same-origin",
          "x-content-type-options": "nosniff",
        },
      });
    },
  )
  .post(
    "/messages/:id/send-again",
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const access = await accessibleMailbox(c.env, c.get("user").id, mailboxId, "send");
      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }
      const stub = mailboxStub(c.env, mailboxId);
      const message = await stub.getEmail(c.req.param("id"));
      if (!message || message.direction !== "outgoing") {
        return apiError(c, 404, "NOT_FOUND", "Outgoing message not found");
      }
      const resent = await stub.resendOutgoing(message.id);
      if (!resent) {
        return apiError(c, 409, "CONFLICT", "Only failed or unconfirmed messages can be sent again");
      }
      return c.json({
        ok: true as const,
        messageId: resent.id,
        transportState: outboundTransportState(resent),
        transportError: resent.transportError,
      });
    },
  )
  .post("/messages", zValidator("json", composeSchema), async (c) => {
    const input = c.req.valid("json");
    const access = await accessibleMailbox(c.env, c.get("user").id, input.mailboxId, "send");
    if (!access) return apiError(c, 403, "FORBIDDEN", "Send access is required");
    try {
      const submission = await submitOutgoing({
        env: c.env,
        requestUrl: c.req.url,
        compose: input,
        conversationId: createId("conv"),
        related: null,
        forwarded: null,
        includeRelatedContext: false,
        fromAddress: access.address,
        fromName: access.displayName,
      });
      return c.json(
        outgoingResponse(submission.email, false),
        submission.inserted ? 201 : 200,
      );
    } catch (error) {
      return outgoingFailure(c, error);
    }
  })
  .post(
    "/messages/:id/replies",
    zValidator("json", replySchema),
    async (c) => {
      const input = c.req.valid("json");
      const access = await accessibleMailbox(
        c.env,
        c.get("user").id,
        input.mailboxId,
        "send",
      );
      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }
      const stub = mailboxStub(c.env, input.mailboxId);
      const parent = await stub.getEmail(c.req.param("id"));
      if (!parent) {
        return apiError(c, 404, "NOT_FOUND", "Reply source was not found");
      }
      if (!canReplyFrom(parent)) {
        return apiError(
          c,
          409,
          "NOT_READY",
          "Wait until the parent message has a confirmed Message-ID",
        );
      }
      const plan = buildReplyPlan(access.address, parent);
      const action = plan.actions.find((candidate) => candidate.mode === input.mode);
      if (!action) {
        return apiError(c, 400, "BAD_REQUEST", "Reply mode is not available");
      }
      const recipients = dedupeRecipientFields({
        to: action.to,
        cc: input.cc ?? action.cc,
        bcc: input.bcc,
      });
      if (recipientCount(recipients) > MAX_MAIL_RECIPIENTS) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          `An email can have at most ${MAX_MAIL_RECIPIENTS} recipients across To, Cc, and Bcc`,
        );
      }
      const detached = shouldDetachOutboundReply({
        ownAddress: access.address,
        plan,
        to: recipients.to,
        cc: recipients.cc,
      });
      const history = await stub.getConversation(parent.conversationId);
      const includeRelatedContext = hasNewRecipients({
        ownAddress: access.address,
        history,
        ...recipients,
      });
      try {
        const submission = await submitOutgoing({
          env: c.env,
          requestUrl: c.req.url,
          compose: {
            requestId: input.requestId,
            mailboxId: input.mailboxId,
            ...recipients,
            subject: replySubject(parent.subject),
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml,
            attachments: input.attachments,
          },
          conversationId: detached ? createId("conv") : parent.conversationId,
          related: parent,
          forwarded: null,
          includeRelatedContext,
          fromAddress: access.address,
          fromName: access.displayName,
        });
        return c.json(
          outgoingResponse(submission.email, detached),
          submission.inserted ? 201 : 200,
        );
      } catch (error) {
        return outgoingFailure(c, error);
      }
    },
  )
  .post(
    "/messages/:id/forward",
    zValidator("json", forwardSchema),
    async (c) => {
      const input = c.req.valid("json");
      const access = await accessibleMailbox(
        c.env,
        c.get("user").id,
        input.mailboxId,
        "send",
      );
      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }
      const source = await mailboxStub(c.env, input.mailboxId)
        .getEmail(c.req.param("id"));
      if (!source) {
        return apiError(c, 404, "NOT_FOUND", "Forwarded message was not found");
      }
      try {
        const submission = await submitOutgoing({
          env: c.env,
          requestUrl: c.req.url,
          compose: {
            ...input,
            subject: forwardSubject(source.subject),
          },
          conversationId: createId("conv"),
          related: null,
          forwarded: source,
          includeRelatedContext: false,
          fromAddress: access.address,
          fromName: access.displayName,
        });
        return c.json(
          outgoingResponse(submission.email, false),
          submission.inserted ? 201 : 200,
        );
      } catch (error) {
        return outgoingFailure(c, error);
      }
    },
  );
