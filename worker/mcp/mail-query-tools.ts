import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AccountApiClient, apiPath } from "./account-client";
import {
  runBinaryResourceTool,
  runResourceLinkTool,
  runTool,
} from "./results";
import { entityIdSchema, mailboxIdSchema, mailboxInputSchema } from "./schemas";

const MAX_RESOURCE_CHUNK_BYTES = 4_000_000;

const binaryResourceInputSchema = z.object({
  mailboxId: mailboxIdSchema,
  messageId: entityIdSchema,
  offsetBytes: z.number().int().min(0).default(0),
  maxBytes: z.number().int().min(1).max(MAX_RESOURCE_CHUNK_BYTES)
    .default(MAX_RESOURCE_CHUNK_BYTES),
});

const attachmentLinkResponseSchema = z.object({
  ok: z.literal(true),
  attachment: z.object({
    id: z.string(),
    filename: z.string(),
    contentType: z.string(),
    size: z.number().int().nonnegative(),
    url: z.url(),
    expiresAt: z.number().int().positive(),
  }),
});

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function registerMailQueryTools(server: McpServer, api: AccountApiClient) {
  server.registerTool(
    "list_mailboxes",
    {
      title: "List mailboxes",
      description: "List mailboxes available to the current account, including send access and unread counts.",
      annotations: readOnly,
    },
    () => runTool(() => api.json("/mail/mailboxes")),
  );

  server.registerTool(
    "list_folders",
    {
      title: "List mailbox folders",
      description: "List system and custom folders with total and unread counts.",
      inputSchema: mailboxInputSchema,
      annotations: readOnly,
    },
    ({ mailboxId }) => runTool(() =>
      api.json(`/mail/mailboxes/${encodeURIComponent(mailboxId)}/folders`)
    ),
  );

  server.registerTool(
    "list_conversations",
    {
      title: "List or search conversations",
      description: "List a cursor-paginated mailbox folder. Supports search and unread-only filtering.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        folder: z.string().trim().min(1).max(80).default("inbox"),
        limit: z.number().int().min(1).max(50).default(25),
        cursor: z.string().trim().min(1).max(512).optional(),
        search: z.string().trim().max(200).optional(),
        unreadOnly: z.boolean().default(false),
      }),
      annotations: readOnly,
    },
    (input) => runTool(() => api.json(apiPath("/mail/conversations", {
      mailboxId: input.mailboxId,
      folder: input.folder,
      limit: input.limit,
      cursor: input.cursor,
      search: input.search,
      unreadOnly: input.unreadOnly ? "true" : undefined,
    }))),
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Get conversation",
      description: "Read a cursor-paginated conversation page, including bodies, attachment metadata, delivery state, and read receipts. The first page contains the newest messages; continue with nextCursor to load older messages.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        conversationId: entityIdSchema,
        limit: z.number().int().min(1).max(25).default(25),
        cursor: z.string().trim().min(1).max(512).optional(),
      }),
      annotations: readOnly,
    },
    ({ mailboxId, conversationId, limit, cursor }) => runTool(() => api.json(apiPath(
      `/mail/conversations/${encodeURIComponent(conversationId)}`,
      { mailboxId, limit, cursor },
    ))),
  );

  server.registerTool(
    "suggest_recipients",
    {
      title: "Suggest recipients",
      description: "Find recent recipients known to a mailbox.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        query: z.string().trim().max(200).default(""),
        limit: z.number().int().min(1).max(12).default(8),
      }),
      annotations: readOnly,
    },
    ({ mailboxId, query, limit }) => runTool(() => api.json(apiPath(
      `/mail/mailboxes/${encodeURIComponent(mailboxId)}/recipient-suggestions`,
      { q: query, limit },
    ))),
  );

  server.registerTool(
    "get_message_authentication",
    {
      title: "Get message authentication",
      description: "Get Cloudflare SPF, DKIM, DMARC, and spam results for an incoming message when available.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        messageId: entityIdSchema,
      }),
      annotations: readOnly,
    },
    ({ mailboxId, messageId }) => runTool(() => api.json(apiPath(
      `/mail/messages/${encodeURIComponent(messageId)}/authentication`,
      { mailboxId },
    ))),
  );

  server.registerTool(
    "get_original_message",
    {
      title: "Read original message",
      description: "Read the raw RFC 822 message as an embedded .eml resource. Large messages are returned in chunks; continue with nextOffsetBytes until it is null.",
      inputSchema: binaryResourceInputSchema,
      annotations: readOnly,
    },
    ({ mailboxId, messageId, offsetBytes, maxBytes }) =>
      runBinaryResourceTool({
        action: () => api.binary(apiPath(
          `/mail/messages/${encodeURIComponent(messageId)}/original`,
          { mailboxId },
        ), { offsetBytes, maxBytes }),
        uri: `openworkspace://mail/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}/original.eml#bytes=${offsetBytes}`,
        mimeType: "message/rfc822",
        fallbackFilename: `${messageId}.eml`,
      }),
  );

  server.registerTool(
    "get_attachment_download_url",
    {
      title: "Get attachment download URL",
      description: "Return a private R2 download link that expires after 15 minutes. Treat the URL as a temporary bearer credential.",
      inputSchema: z.object({
        mailboxId: mailboxIdSchema,
        messageId: entityIdSchema,
        attachmentId: entityIdSchema,
      }),
      annotations: readOnly,
    },
    ({ mailboxId, messageId, attachmentId }) => runResourceLinkTool(async () => {
      const response = attachmentLinkResponseSchema.parse(await api.json(
        apiPath(
          `/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/download-url`,
          { mailboxId },
        ),
      ));
      return {
        structuredContent: response,
        resource: {
          type: "resource_link",
          uri: response.attachment.url,
          name: response.attachment.filename,
          title: response.attachment.filename,
          description: "Temporary private attachment download",
          mimeType: response.attachment.contentType,
          size: response.attachment.size,
        },
      };
    }),
  );
}
