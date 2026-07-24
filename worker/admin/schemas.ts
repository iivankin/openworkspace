import { z } from "zod";
import { emailSchema } from "../auth/schemas";

const mailboxMemberSchema = z.object({
  userId: z.string().min(1),
  canSend: z.boolean(),
});

const mailboxMembersSchema = z
  .array(mailboxMemberSchema)
  .min(1, "Choose at least one user")
  .max(100)
  .refine(
    (members) =>
      new Set(members.map((member) => member.userId)).size === members.length,
    { message: "A user may only be assigned once" },
  );

const avatarUrlSchema = z.url().max(2048).nullable();

export const createInvitationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
  avatarUrl: avatarUrlSchema.default(null),
});

export const createMailboxSchema = z.object({
  address: emailSchema,
  displayName: z.string().trim().min(2).max(80),
  members: mailboxMembersSchema,
});

export const updateMailboxSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  members: mailboxMembersSchema,
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(80),
  avatarUrl: avatarUrlSchema,
});
