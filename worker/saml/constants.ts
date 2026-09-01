export const SAML_CLOCK_SKEW_MS = 10 * 60 * 1000;
export const SAML_REQUEST_TTL_MS = 10 * 60 * 1000;

export function samlReplayCleanupBefore(now: Date) {
  return new Date(now.getTime() - SAML_CLOCK_SKEW_MS);
}
