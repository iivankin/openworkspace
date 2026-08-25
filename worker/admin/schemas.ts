import { z } from "zod";
import {
  oidcAccessPolicies,
  oidcClientTypes,
  oidcScopes,
} from "../../shared/oidc";
import { emailSchema } from "../auth/schemas";
import {
  isAllowedOidcRedirectUri,
  normalizeAllowedOidcOrigin,
} from "../oidc/validation";

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

export const createInvitationSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
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

export const globalAiProcessingSchema = z.object({
  enabled: z.boolean(),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  role: z.enum(["admin", "member"]).optional(),
}).refine(
  (input) => input.name !== undefined
    || input.status !== undefined
    || input.role !== undefined,
  "Provide at least one user change",
);

const uniqueStrings = <T extends z.ZodType<string>>(schema: T, max = 20) =>
  z.array(schema).max(max).refine(
    (values) => new Set(values).size === values.length,
    "Values must be unique",
  );

const redirectUriSchema = z.url().max(2048).refine(
  isAllowedOidcRedirectUri,
  "Redirect URI must use HTTPS, except HTTP loopback addresses, and have no fragment",
);

const originSchema = z.url().max(2048).transform((value, context) => {
  const origin = normalizeAllowedOidcOrigin(value);
  if (!origin) {
    context.addIssue({
      code: "custom",
      message: "Origin must be HTTPS or an HTTP loopback origin without a path",
    });
    return z.NEVER;
  }
  return origin;
});

const oidcClientSchema = z.object({
  name: z.string().trim().min(2).max(80),
  clientType: z.enum(oidcClientTypes),
  accessPolicy: z.enum(oidcAccessPolicies),
  redirectUris: uniqueStrings(redirectUriSchema).min(1),
  postLogoutRedirectUris: uniqueStrings(redirectUriSchema),
  allowedOrigins: uniqueStrings(originSchema),
  allowedScopes: uniqueStrings(z.enum(oidcScopes), oidcScopes.length).refine(
    (scopes) => scopes.includes("openid"),
    "The openid scope is required",
  ),
  trusted: z.boolean(),
  enabled: z.boolean(),
  assignedUserIds: uniqueStrings(z.string().min(1), 100),
  exposedGroupIds: uniqueStrings(z.string().min(1), 100),
});

export const createOidcClientSchema = oidcClientSchema;
export const updateOidcClientSchema = oidcClientSchema;

export const groupInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  description: z.string().trim().max(240).nullable(),
  memberIds: uniqueStrings(z.string().min(1), 100),
});
