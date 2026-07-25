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

export type R2S3Bindings = {
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
};

export type AppEnv = {
  Bindings: Env & OidcBindings & R2S3Bindings;
  Variables: {
    user: SessionUser;
  };
};
