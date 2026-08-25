import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";
import { isValidExternalEmailAddress } from "../../shared/mail";
import { normalizeEmail } from "../lib/ids";

export const emailSchema = z
  .string()
  .refine(isValidExternalEmailAddress, "Enter a valid email address")
  .max(254)
  .transform(normalizeEmail);

export const bootstrapInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: emailSchema,
});

function isCredentialResponse(value: unknown): value is { id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string"
  );
}

export const registrationResponseSchema = z.custom<RegistrationResponseJSON>(
  isCredentialResponse,
  "Invalid passkey registration response",
);

export const authenticationResponseSchema =
  z.custom<AuthenticationResponseJSON>(
    isCredentialResponse,
    "Invalid passkey authentication response",
  );

export const mockBootstrapSchema = bootstrapInputSchema;
export const loginOptionsSchema = z.object({
  oidcRequestId: z.string().min(1).optional(),
});
export const mockLoginSchema = z.object({
  userId: z.string().min(1),
  oidcRequestId: z.string().min(1).optional(),
});

export const createAccountApiTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
