export function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * Preserve the RFC local part used for transport while canonicalizing the
 * case-insensitive domain. Provider-specific local-part rules do not belong
 * here because they can change the destination of an external message.
 */
export function normalizeEmail(value: string): string {
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf("@");
  if (separator <= 0 || separator === trimmed.length - 1) return trimmed;
  return `${trimmed.slice(0, separator)}@${trimmed.slice(separator + 1).toLocaleLowerCase("en-US")}`;
}

/**
 * Addresses provisioned in this installation use one explicit,
 * case-insensitive mailbox namespace. Keep this policy separate from external
 * transport normalization.
 */
export function normalizeMailboxAddress(value: string): string {
  return normalizeEmail(value).toLocaleLowerCase("en-US");
}

export function emailDomain(value: string): string {
  return normalizeEmail(value).split("@").at(-1) ?? "";
}
