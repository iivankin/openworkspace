export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
export const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
export const ID_TOKEN_TTL_SECONDS = 5 * 60;
export const ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const MAX_GROUP_CLAIMS = 100;
export const MAX_SCOPE_COUNT = 10;

export const OIDC_ISSUER_PATHS = {
  authorization: "/oauth/authorize",
  token: "/oauth/token",
  userinfo: "/oauth/userinfo",
  revocation: "/oauth/revoke",
  logout: "/oauth/logout",
  jwks: "/.well-known/jwks.json",
} as const;
