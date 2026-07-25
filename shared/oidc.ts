export const oidcScopes = [
  "openid",
  "profile",
  "email",
  "groups",
  "offline_access",
] as const;

export type OidcScope = (typeof oidcScopes)[number];

export const oidcClientTypes = ["public", "confidential"] as const;
export type OidcClientType = (typeof oidcClientTypes)[number];

export const oidcAccessPolicies = [
  "all_active_users",
  "selected_users",
] as const;
export type OidcAccessPolicy = (typeof oidcAccessPolicies)[number];
