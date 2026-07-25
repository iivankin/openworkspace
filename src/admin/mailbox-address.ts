/** Keep only the local-part; pasted full addresses drop the host. */
export function mailboxLocalPart(value: string) {
  const trimmed = value.trim();
  const separator = trimmed.indexOf("@");
  if (separator >= 0) return trimmed.slice(0, separator).trim();
  return trimmed;
}

export function mailboxAddress(localPart: string, domain: string) {
  return `${mailboxLocalPart(localPart)}@${domain}`;
}
