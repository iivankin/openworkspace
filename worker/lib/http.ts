import type { Context } from "hono";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "NOT_READY"
  | "UNAUTHORIZED"
  | "WEBAUTHN_FAILED"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "BAD_GATEWAY";

export function apiError(
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502,
  code: ApiErrorCode,
  message: string,
) {
  return c.json({ ok: false as const, error: { code, message } }, status);
}

export function getRelyingParty(request: Request) {
  const url = new URL(request.url);
  return { origin: url.origin, rpId: url.hostname };
}
