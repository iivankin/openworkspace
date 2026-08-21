import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import {
  baseSubject,
  isComposerInlineImageContentType,
} from "../../shared/mail";
import { requireAuth } from "../auth/middleware";
import { createDb } from "../db/client";
import { mailboxMembers, mailboxes, users } from "../db/schema";
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
import {
  ComposerAttachmentLimitError,
  preflightOutgoingAttachments,
} from "./outbound";
import {
  OutgoingRequestConflictError,
  submitOutgoing,
} from "./outbound-service";
import {
  OutgoingContextError,
  resolveForwardContext,
  resolveReplyContext,
} from "./outgoing-context";
import { participantLabels } from "./participants";
import { buildReplyPlan } from "./reply-plan";
import {
  attachmentPreflightSchema,
  composeSchema,
  conversationListQuerySchema,
  createUploadSchema,
  forwardSchema,
  mailboxQuerySchema,
  messageReadSchema,
  recipientSuggestionQuerySchema,
  remoteProxyQuerySchema,
  replySchema,
  uploadIdSchema,
  updateConversationSchema,
} from "./schemas";
import {
  assertProxyableRemoteUrl,
  fetchProxiedRemoteMedia,
} from "./remote-proxy";
import { checkRateLimit } from "../lib/rate-limit";
import {
  createComposerUploadIntent,
  discardComposerUploads,
  finalizeComposerUpload,
  storeComposerUploadContent,
  UploadValidationError,
} from "./uploads";

function mediaType(contentType: string) {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function requestContentLength(value: string | undefined) {
  return value === undefined ? undefined : Number(value);
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

function toMessageDetail(
  email: Email,
  ownAddress: string,
  bodyHtml: string | null,
  readReceipt: {
    isRead: boolean;
    viewedBy: Array<{
      userId: string;
      name: string;
      readAt: Date;
    }>;
  },
) {
  return {
    ...toMessageSummary(email),
    bodyText: email.bodyText,
    quotedText: email.quotedText,
    bodyHtml,
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
    ...readReceipt,
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
  if (
    error instanceof ComposerAttachmentLimitError
    || error instanceof UploadValidationError
  ) {
    return apiError(c, 400, "BAD_REQUEST", error.message);
  }
  if (error instanceof OutgoingRequestConflictError) {
    return apiError(c, 409, "CONFLICT", error.message);
  }
  if (error instanceof OutgoingContextError) {
    return apiError(c, error.status, error.code, error.message);
  }
  throw error;
}

export const mailRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/mailboxes", async (c) => {
    const userId = c.get("user").id;
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
      .where(eq(mailboxMembers.userId, userId))
      .orderBy(mailboxes.kind, mailboxes.displayName);

    const rowsWithUnreadCounts = await Promise.all(rows.map(async (mailbox) => {
      const inbox = await mailboxStub(c.env, mailbox.id)
        .getFolderCounts(userId, "inbox");
      return {
        ...mailbox,
        unreadCount: inbox?.unreadCount ?? 0,
      };
    }));

    return c.json({ ok: true as const, mailboxes: rowsWithUnreadCounts });
  })
  .post(
    "/uploads",
    zValidator("query", mailboxQuerySchema),
    zValidator("json", createUploadSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const body = c.req.valid("json");
      const user = c.get("user");
      const access = await accessibleMailbox(c.env, user.id, mailboxId, "send");
      if (!access) return apiError(c, 403, "FORBIDDEN", "Send access is required");

      const rate = await checkRateLimit(c.env.DB, {
        action: "mail-upload",
        identifier: user.id,
        limit: 30,
        windowMs: 60_000,
      });
      if (!rate.allowed) {
        c.header("retry-after", String(rate.retryAfterSeconds));
        return apiError(c, 429, "RATE_LIMITED", "Too many attachment uploads");
      }

      try {
        const upload = await createComposerUploadIntent({
          env: c.env,
          requestOrigin: new URL(c.req.url).origin,
          mailboxId,
          userId: user.id,
          filename: body.filename,
          contentType: body.contentType,
          size: body.size,
        });
        return c.json({ ok: true as const, upload }, 201);
      } catch (error) {
        return outgoingFailure(c, error);
      }
    },
  )
  .put(
    "/uploads/content",
    zValidator(
      "query",
      mailboxQuerySchema.extend({
        uploadId: uploadIdSchema,
      }),
    ),
    async (c) => {
      const { mailboxId, uploadId } = c.req.valid("query");
      const user = c.get("user");
      const access = await accessibleMailbox(c.env, user.id, mailboxId, "send");
      if (!access) return apiError(c, 403, "FORBIDDEN", "Send access is required");
      try {
        await storeComposerUploadContent({
          env: c.env,
          mailboxId,
          userId: user.id,
          uploadId,
          body: c.req.raw.body,
          contentType: c.req.header("content-type") ?? undefined,
          contentLength: requestContentLength(
            c.req.header("content-length") ?? undefined,
          ),
        });
        return c.json({ ok: true as const });
      } catch (error) {
        return outgoingFailure(c, error);
      }
    },
  )
  .post(
    "/uploads/:id/complete",
    zValidator("param", z.object({ id: uploadIdSchema })),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const { id: uploadId } = c.req.valid("param");
      const user = c.get("user");
      const access = await accessibleMailbox(c.env, user.id, mailboxId, "send");
      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }
      try {
        const upload = await finalizeComposerUpload({
          env: c.env,
          mailboxId,
          userId: user.id,
          uploadId,
          defer: (task) => c.executionCtx.waitUntil(task),
        });
        return c.json({ ok: true as const, upload });
      } catch (error) {
        return outgoingFailure(c, error);
      }
    },
  )
  .delete(
    "/uploads/:id",
    zValidator("param", z.object({ id: uploadIdSchema })),
    zValidator("query", mailboxQuerySchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const user = c.get("user");
      const access = await accessibleMailbox(c.env, user.id, mailboxId, "send");
      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }
      const { id: uploadId } = c.req.valid("param");
      await discardComposerUploads({
        env: c.env,
        mailboxId,
        userId: user.id,
        uploadIds: [uploadId],
      });
      return c.json({ ok: true as const });
    },
  )
  .get(
    "/mailboxes/:id/recipient-suggestions",
    zValidator("query", recipientSuggestionQuerySchema),
    async (c) => {
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
      const query = c.req.valid("query");
      return c.json({
        ok: true as const,
        suggestions: await mailboxStub(c.env, mailboxId).suggestRecipients(
          access.address,
          query.q,
          query.limit,
        ),
      });
    },
  )
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
    const storedFolders = await mailboxStub(c.env, mailboxId).listFolders(
      c.get("user").id,
    );
    return c.json({
      ok: true as const,
      folders: storedFolders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        kind: folder.kind,
        systemType: folder.systemType,
        totalCount: folder.totalCount,
        unreadCount: folder.unreadCount,
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
      c.get("user").id,
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
        messageCount: item.messageCount,
        unreadCount: item.unreadCount,
        isUnread: item.unreadCount > 0,
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
      const readerIds = [...new Set(
        snapshot.readStates.map((readState) => readState.userId),
      )];
      const readers = readerIds.length
        ? await createDb(c.env.DB)
          .select({ id: users.id, name: users.name })
          .from(mailboxMembers)
          .innerJoin(users, eq(mailboxMembers.userId, users.id))
          .where(and(
            eq(mailboxMembers.mailboxId, mailboxId),
            inArray(mailboxMembers.userId, readerIds),
          ))
        : [];
      const readerById = new Map(readers.map((reader) => [reader.id, reader]));
      const readStatesByEmail = new Map<
        string,
        typeof snapshot.readStates
      >();
      for (const readState of snapshot.readStates) {
        const states = readStatesByEmail.get(readState.emailId) ?? [];
        states.push(readState);
        readStatesByEmail.set(readState.emailId, states);
      }
      const currentUserId = c.get("user").id;
      const messages = await Promise.all(snapshot.messages.map(async (email) => {
        const object = email.bodyHtmlR2Key
          ? await c.env.MAIL_STORAGE.get(email.bodyHtmlR2Key)
          : null;
        const readStates = readStatesByEmail.get(email.id) ?? [];
        return toMessageDetail(
          email,
          access.address,
          object ? await object.text() : null,
          {
            isRead: readStates.some(
              (readState) => readState.userId === currentUserId,
            ),
            viewedBy: readStates.flatMap((readState) => {
              const reader = readerById.get(readState.userId);
              return reader
                ? [{
                    userId: reader.id,
                    name: reader.name,
                    readAt: readState.readAt,
                  }]
                : [];
            }),
          },
        );
      }));
      return c.json({
        ok: true as const,
        mailboxState: snapshot.mailboxState,
        folderId: snapshot.folderId,
        messages,
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
  .patch(
    "/conversations/:id/read",
    zValidator("query", mailboxQuerySchema),
    zValidator("json", messageReadSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const user = c.get("user");
      if (!await accessibleMailbox(c.env, user.id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const updated = await mailboxStub(c.env, mailboxId).setConversationRead(
        user.id,
        c.req.param("id"),
        c.req.valid("json").isRead,
      );
      if (!updated) return apiError(c, 404, "NOT_FOUND", "Conversation not found");
      return c.json({ ok: true as const });
    },
  )
  .patch(
    "/messages/:id/read",
    zValidator("query", mailboxQuerySchema),
    zValidator("json", messageReadSchema),
    async (c) => {
      const { mailboxId } = c.req.valid("query");
      const user = c.get("user");
      if (!await accessibleMailbox(c.env, user.id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      const updated = await mailboxStub(c.env, mailboxId).setMessageRead(
        user.id,
        c.req.param("id"),
        c.req.valid("json").isRead,
      );
      if (!updated) return apiError(c, 404, "NOT_FOUND", "Message not found");
      return c.json({ ok: true as const });
    },
  )
  .get(
    "/remote",
    zValidator("query", remoteProxyQuerySchema),
    async (c) => {
      const { mailboxId, url } = c.req.valid("query");
      if (!await accessibleMailbox(c.env, c.get("user").id, mailboxId, "read")) {
        return apiError(c, 403, "FORBIDDEN", "Mailbox access is required");
      }
      try {
        assertProxyableRemoteUrl(url);
      } catch (error) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          error instanceof Error ? error.message : "Remote URL is invalid",
        );
      }
      const limited = await checkRateLimit(c.env.DB, {
        action: "mail-remote-proxy",
        identifier: c.get("user").id,
        limit: 120,
        windowMs: 60_000,
      });
      if (!limited.allowed) {
        return apiError(
          c,
          429,
          "RATE_LIMITED",
          "Too many remote content requests. Try again shortly.",
        );
      }
      try {
        const remote = await fetchProxiedRemoteMedia(url);
        return new Response(remote.body, {
          headers: {
            "cache-control": "private, max-age=3600",
            "content-type": remote.contentType,
            "content-disposition": "inline",
            "cross-origin-resource-policy": "same-origin",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return apiError(
          c,
          502,
          "BAD_GATEWAY",
          error instanceof Error ? error.message : "Remote content unavailable",
        );
      }
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
        || !isComposerInlineImageContentType(contentType)
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
  .post(
    "/attachment-preflight",
    zValidator("json", attachmentPreflightSchema),
    async (c) => {
      const input = c.req.valid("json");
      const user = c.get("user");
      const access = await accessibleMailbox(
        c.env,
        user.id,
        input.mailboxId,
        "send",
      );
      if (!access) {
        return apiError(c, 403, "FORBIDDEN", "Send access is required");
      }
      const rate = await checkRateLimit(c.env.DB, {
        action: "mail-attachment-preflight",
        identifier: `${user.id}:${input.mailboxId}`,
        limit: 120,
        windowMs: 60_000,
      });
      if (!rate.allowed) {
        c.header("retry-after", String(rate.retryAfterSeconds));
        return apiError(
          c,
          429,
          "RATE_LIMITED",
          "Too many attachment checks",
        );
      }

      try {
        let subject = input.kind === "compose" ? input.subject : "";
        let related: Email | null = null;
        let forwarded: Email | null = null;
        let includeRelatedContext = false;
        if (input.kind === "forward") {
          const context = await resolveForwardContext({
            env: c.env,
            mailboxId: input.mailboxId,
            sourceEmailId: input.sourceEmailId,
          });
          forwarded = context.source;
          subject = context.subject;
        } else if (input.kind === "reply") {
          const context = await resolveReplyContext({
            env: c.env,
            mailboxId: input.mailboxId,
            ownAddress: access.address,
            sourceEmailId: input.sourceEmailId,
            mode: input.mode,
            cc: input.cc,
            bcc: input.bcc,
          });
          related = context.source;
          subject = context.subject;
          includeRelatedContext = context.includeRelatedContext;
        }
        const result = await preflightOutgoingAttachments({
          env: c.env,
          compose: {
            mailboxId: input.mailboxId,
            userId: user.id,
            subject,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml,
            attachments: input.attachments,
          },
          related,
          forwarded,
          includeRelatedContext,
        });
        return c.json({ ok: true as const, ...result });
      } catch (error) {
        return outgoingFailure(c, error);
      }
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
        compose: {
          ...input,
          userId: c.get("user").id,
        },
        conversationId: createId("conv"),
        related: null,
        forwarded: null,
        includeRelatedContext: false,
        fromAddress: access.address,
        fromName: access.displayName,
        defer: (task) => c.executionCtx.waitUntil(task),
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
      try {
        const context = await resolveReplyContext({
          env: c.env,
          mailboxId: input.mailboxId,
          ownAddress: access.address,
          sourceEmailId: c.req.param("id"),
          mode: input.mode,
          cc: input.cc,
          bcc: input.bcc,
        });
        const submission = await submitOutgoing({
          env: c.env,
          requestUrl: c.req.url,
          compose: {
            requestId: input.requestId,
            mailboxId: input.mailboxId,
            userId: c.get("user").id,
            ...context.recipients,
            subject: context.subject,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml,
            attachments: input.attachments,
          },
          conversationId: context.detached
            ? createId("conv")
            : context.source.conversationId,
          related: context.source,
          forwarded: null,
          includeRelatedContext: context.includeRelatedContext,
          fromAddress: access.address,
          fromName: access.displayName,
          defer: (task) => c.executionCtx.waitUntil(task),
        });
        return c.json(
          outgoingResponse(submission.email, context.detached),
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
      try {
        const context = await resolveForwardContext({
          env: c.env,
          mailboxId: input.mailboxId,
          sourceEmailId: c.req.param("id"),
        });
        const submission = await submitOutgoing({
          env: c.env,
          requestUrl: c.req.url,
          compose: {
            ...input,
            userId: c.get("user").id,
            subject: context.subject,
          },
          conversationId: createId("conv"),
          related: null,
          forwarded: context.source,
          includeRelatedContext: false,
          fromAddress: access.address,
          fromName: access.displayName,
          defer: (task) => c.executionCtx.waitUntil(task),
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
