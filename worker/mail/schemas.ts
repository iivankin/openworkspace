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

export const MAX_ATTACHMENT_BASE64_LENGTH = 4 * Math.ceil(
  MAX_COMPOSER_ATTACHMENT_BYTES / 3,
);

export function decodedBase64Size(value: string) {
  if (!value.length) return 0;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export const folderSchema = z.string().trim().min(1).max(80);

export const mailboxQuerySchema = z.object({
  mailboxId: z.string().min(1),
});

export const conversationListQuerySchema = mailboxQuerySchema.extend({
  folder: folderSchema.default("inbox"),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().trim().min(1).max(512).optional(),
  search: z.string().trim().max(200).optional(),
});

export const mailboxStateSchema = z.enum(mailboxStates);

const outboundAttachmentSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255),
  contentBase64: z
    .string()
    .max(MAX_ATTACHMENT_BASE64_LENGTH)
    .refine(
      (value) =>
        value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(value),
      { message: "Attachment content is not valid base64" },
    ),
});

const outboundRequestFields = {
  requestId: z.uuid(),
  mailboxId: z.string().min(1),
  bodyText: z.string().max(500_000).default(""),
  bodyHtml: z.string().max(1_000_000).optional(),
  attachments: z
    .array(outboundAttachmentSchema)
    .max(MAX_COMPOSER_ATTACHMENT_COUNT)
    .default([]),
};

const recipientFields = {
  to: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
  cc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
  bcc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
};

function attachmentBytes(input: {
  attachments: Array<{ contentBase64: string }>;
}) {
  return input.attachments.reduce(
    (total, attachment) => total + decodedBase64Size(attachment.contentBase64),
    0,
  );
}

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
  )
  .refine(
    (value) => attachmentBytes(value) <= MAX_COMPOSER_ATTACHMENT_BYTES,
    { message: "Attachments exceed the 20 MB composer limit" },
  );

export const replySchema = z
  .object({
    ...outboundRequestFields,
    mode: z.enum(replyActionModes),
    cc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).optional(),
    bcc: z.array(emailSchema).max(MAX_MAIL_RECIPIENTS).default([]),
  })
  .refine(
    (value) => attachmentBytes(value) <= MAX_COMPOSER_ATTACHMENT_BYTES,
    { message: "Attachments exceed the 20 MB composer limit" },
  );

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
  )
  .refine(
    (value) => attachmentBytes(value) <= MAX_COMPOSER_ATTACHMENT_BYTES,
    { message: "Attachments exceed the 20 MB composer limit" },
  );

export const updateConversationSchema = z
  .object({
    mailboxState: mailboxStateSchema.optional(),
    folderId: z.string().min(1).nullable().optional(),
  })
  .refine((value) => value.mailboxState !== undefined || value.folderId !== undefined, {
    message: "No changes supplied",
  });
