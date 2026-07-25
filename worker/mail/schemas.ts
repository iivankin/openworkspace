import { z } from "zod";
import {
  mailboxStates,
  MAX_COMPOSER_ATTACHMENT_BYTES,
  MAX_COMPOSER_ATTACHMENT_COUNT,
  MAX_MAIL_RECIPIENTS,
  replyActionModes,
} from "../../shared/mail";
import { emailSchema } from "../auth/schemas";
import { dedupeRecipientFields, recipientCount } from "./recipients";

export const folderSchema = z.string().trim().min(1).max(80);

export const mailboxQuerySchema = z.object({
  mailboxId: z.string().min(1),
});

export const remoteProxyQuerySchema = mailboxQuerySchema.extend({
  url: z.string().trim().min(1).max(4_096),
});

export const conversationListQuerySchema = mailboxQuerySchema.extend({
  folder: folderSchema.default("inbox"),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().trim().min(1).max(512).optional(),
  search: z.string().trim().max(200).optional(),
});

export const mailboxStateSchema = z.enum(mailboxStates);

export const createUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  size: z.number().int().positive().max(MAX_COMPOSER_ATTACHMENT_BYTES),
});

const outboundAttachmentSchema = z.object({
  uploadId: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^upl_[a-f0-9]{32}$/u, "Attachment upload id is invalid"),
});

const outboundRequestFields = {
  requestId: z.uuid(),
  mailboxId: z.string().min(1),
  bodyText: z.string().max(500_000).default(""),
  bodyHtml: z.string().max(1_000_000).optional(),
  attachments: z
    .array(outboundAttachmentSchema)
    .max(MAX_COMPOSER_ATTACHMENT_COUNT)
    .default([])
    .refine(
      (attachments) =>
        new Set(attachments.map((file) => file.uploadId)).size === attachments.length,
      { message: "Duplicate attachment uploads are not allowed" },
    ),
};

const recipientFields = {
  to: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
  cc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
  bcc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
};

export const composeSchema = z
  .object({
    ...outboundRequestFields,
    ...recipientFields,
    replyTo: emailSchema.optional(),
    subject: z.string().trim().max(998).default(""),
  })
  .transform((value) => ({
    ...value,
    ...dedupeRecipientFields(value),
  }))
  .refine(
    (value) => recipientCount(value) > 0,
    { message: "Add at least one recipient in To, Cc, or Bcc" },
  )
  .refine(
    (value) => recipientCount(value) <= MAX_MAIL_RECIPIENTS,
    { message: `An email can have at most ${MAX_MAIL_RECIPIENTS} recipients across To, Cc, and Bcc` },
  );

export const replySchema = z.object({
  ...outboundRequestFields,
  mode: z.enum(replyActionModes),
  cc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).optional(),
  bcc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
});

export const forwardSchema = z
  .object({
    ...outboundRequestFields,
    ...recipientFields,
    replyTo: emailSchema.optional(),
  })
  .transform((value) => ({
    ...value,
    ...dedupeRecipientFields(value),
  }))
  .refine(
    (value) => recipientCount(value) > 0,
    { message: "Add at least one recipient in To, Cc, or Bcc" },
  )
  .refine(
    (value) => recipientCount(value) <= MAX_MAIL_RECIPIENTS,
    { message: `An email can have at most ${MAX_MAIL_RECIPIENTS} recipients across To, Cc, and Bcc` },
  );

export const updateConversationSchema = z
  .object({
    mailboxState: mailboxStateSchema.optional(),
    folderId: z.string().min(1).nullable().optional(),
  })
  .refine((value) => value.mailboxState !== undefined || value.folderId !== undefined, {
    message: "No changes supplied",
  });
