import {
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  importJWK,
  SignJWT,
  type JWK,
  type JWTPayload,
} from "jose";
import type { AppEnv } from "../env";
import { createId } from "../lib/ids";
import { ID_TOKEN_TTL_SECONDS } from "./constants";
import { OidcError } from "./errors";

type OidcConfig = {
  issuer: string;
  privateJwk: JWK & { kid: string };
  publicJwks: { keys: JWK[] };
};

let cached:
  | {
      source: string;
      previous: string | undefined;
      issuer: string | undefined;
      config: OidcConfig;
      key: CryptoKey;
      verifyKeys: Map<string, CryptoKey>;
    }
  | undefined;

export function oidcIssuer(env: AppEnv["Bindings"]) {
  const configured = env.OIDC_ISSUER?.trim();
  if (!configured) {
    throw new OidcError(
      "temporarily_unavailable",
      "OIDC issuer is not configured",
      503,
    );
  }
  const url = new URL(configured);
  if (
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && env.ALLOW_MOCK_AUTH !== "true")
  ) {
    throw new OidcError(
      "server_error",
      "OIDC issuer must be an HTTPS origin without a path",
      500,
    );
  }
  return url.origin;
}

async function loadConfig(env: AppEnv["Bindings"]) {
  const source = env.OIDC_SIGNING_PRIVATE_JWK;
  if (!source) {
    throw new OidcError(
      "temporarily_unavailable",
      "OIDC signing key is not configured",
      503,
    );
  }
  if (
    cached?.source === source &&
    cached.previous === env.OIDC_PREVIOUS_PUBLIC_JWKS &&
    cached.issuer === env.OIDC_ISSUER
  ) {
    return cached;
  }

  let parsed: JWK;
  try {
    parsed = JSON.parse(source) as JWK;
  } catch {
    throw new OidcError("server_error", "OIDC signing key is invalid", 500);
  }
  if (parsed.kty !== "RSA" || !parsed.d) {
    throw new OidcError(
      "server_error",
      "OIDC signing key must be a private RSA JWK",
      500,
    );
  }
  const kid = parsed.kid ?? await calculateJwkThumbprint(parsed);
  const privateJwk = { ...parsed, alg: "RS256", use: "sig", kid };
  const key = await importJWK(privateJwk, "RS256");
  if (!(key instanceof CryptoKey)) {
    throw new OidcError("server_error", "OIDC signing key is invalid", 500);
  }

  const publicJwk = publicOnly(privateJwk);
  const verifyKey = await importJWK(publicJwk, "RS256");
  if (!(verifyKey instanceof CryptoKey)) {
    throw new OidcError("server_error", "OIDC verification key is invalid", 500);
  }
  let previousKeys: JWK[] = [];
  if (env.OIDC_PREVIOUS_PUBLIC_JWKS) {
    try {
      const previous = JSON.parse(env.OIDC_PREVIOUS_PUBLIC_JWKS) as {
        keys?: JWK[];
      };
      previousKeys = Array.isArray(previous.keys)
        ? await Promise.all(previous.keys.map(normalizePreviousPublicJwk))
        : [];
    } catch {
      throw new OidcError(
        "server_error",
        "Previous OIDC JWKS is invalid",
        500,
      );
    }
  }

  const config: OidcConfig = {
    issuer: oidcIssuer(env),
    privateJwk,
    publicJwks: { keys: [publicJwk, ...previousKeys] },
  };
  const verifyKeys = new Map<string, CryptoKey>([[kid, verifyKey]]);
  for (const previousKey of previousKeys) {
    if (!previousKey.kid || verifyKeys.has(previousKey.kid)) {
      throw new OidcError(
        "server_error",
        "Previous OIDC JWKS contains a duplicate or missing kid",
        500,
      );
    }
    const imported = await importJWK(previousKey, "RS256");
    if (!(imported instanceof CryptoKey)) {
      throw new OidcError("server_error", "Previous OIDC JWKS is invalid", 500);
    }
    verifyKeys.set(previousKey.kid, imported);
  }
  cached = {
    source,
    previous: env.OIDC_PREVIOUS_PUBLIC_JWKS,
    issuer: env.OIDC_ISSUER,
    config,
    key,
    verifyKeys,
  };
  return cached;
}

function publicOnly(jwk: JWK) {
  const publicJwk = { ...jwk } as JWK & Record<string, unknown>;
  for (const field of ["d", "p", "q", "dp", "dq", "qi", "oth"]) {
    delete publicJwk[field];
  }
  return publicJwk;
}

async function normalizePreviousPublicJwk(jwk: JWK) {
  const publicJwk = publicOnly(jwk);
  if (
    publicJwk.kty !== "RSA" ||
    !publicJwk.n ||
    !publicJwk.e
  ) {
    throw new OidcError(
      "server_error",
      "Previous OIDC keys must be public RSA JWKs",
      500,
    );
  }
  return {
    ...publicJwk,
    alg: "RS256",
    use: "sig",
    kid: publicJwk.kid ?? await calculateJwkThumbprint(publicJwk),
  };
}

export async function publicJwks(env: AppEnv["Bindings"]) {
  return (await loadConfig(env)).config.publicJwks;
}

export async function signIdToken(
  env: AppEnv["Bindings"],
  input: {
    clientId: string;
    userId: string;
    authTime: Date;
    nonce?: string | null;
    claims: Record<string, unknown>;
  },
) {
  const loaded = await loadConfig(env);
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    ...input.claims,
    auth_time: Math.floor(input.authTime.getTime() / 1_000),
    amr: ["webauthn"],
    ...(input.nonce ? { nonce: input.nonce } : {}),
  })
    .setProtectedHeader({
      alg: "RS256",
      kid: loaded.config.privateJwk.kid,
      typ: "JWT",
    })
    .setIssuer(loaded.config.issuer)
    .setSubject(input.userId)
    .setAudience(input.clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + ID_TOKEN_TTL_SECONDS)
    .setJti(createId("jwt"))
    .sign(loaded.key);
}

export async function claimsFromIdTokenHint(
  env: AppEnv["Bindings"],
  idToken: string,
) {
  const loaded = await loadConfig(env);
  try {
    const header = decodeProtectedHeader(idToken);
    const verificationKey = header.kid
      ? loaded.verifyKeys.get(header.kid)
      : undefined;
    if (!verificationKey) {
      throw new Error("Unknown signing key");
    }
    const verified = await compactVerify(idToken, verificationKey, {
      algorithms: ["RS256"],
    });
    const payload = JSON.parse(
      new TextDecoder().decode(verified.payload),
    ) as JWTPayload;
    if (
      payload.iss !== loaded.config.issuer ||
      typeof payload.sub !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp <= payload.iat
    ) {
      throw new Error("Invalid ID token claims");
    }
    const clientId = typeof payload.aud === "string"
      ? payload.aud
      : Array.isArray(payload.aud) && payload.aud.length === 1
        ? payload.aud[0]
        : undefined;
    if (clientId) {
      return { clientId, subject: payload.sub };
    }
  } catch {
    throw new OidcError("invalid_request", "id_token_hint is invalid");
  }
  throw new OidcError("invalid_request", "id_token_hint has an invalid audience");
}
