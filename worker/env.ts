import type { User } from "./db/schema";

export type SessionUser = Pick<
  User,
  "id" | "name" | "avatarUrl" | "role" | "status"
>;

export type OidcBindings = {
  OIDC_ISSUER?: string;
  OIDC_SIGNING_PRIVATE_JWK?: string;
  OIDC_PREVIOUS_PUBLIC_JWKS?: string;
};

export type AppEnv = {
  Bindings: Env & OidcBindings;
  Variables: {
    user: SessionUser;
  };
};
