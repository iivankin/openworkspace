import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { oidcScopes } from "../../shared/oidc";
import { requireAuth } from "../auth/middleware";
import {
  destroySession,
  readSessionFromContext,
} from "../auth/session";
import { createDb, type Database } from "../db/client";
import { oidcClients } from "../db/schema";
import type { AppEnv } from "../env";
import { hashToken } from "../lib/crypto";
import {
  checkRateLimit,
  requestIdentifier,
} from "../lib/rate-limit";
import {
  MAX_SCOPE_COUNT,
  OIDC_ISSUER_PATHS,
} from "./constants";
import { OidcError, oidcError } from "./errors";
import {
  claimsFromIdTokenHint,
  oidcIssuer,
  publicJwks,
} from "./keys";
import {
  assertUserCanUseClient,
  authenticatedAuthorizationRequest,
  authorizationErrorRedirect,
  cleanupExpiredOidcArtifacts,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  findEnabledClient,
  finishAuthorizationRequest,
  getAuthorizationRequest,
  hasGrant,
  issueAuthorizationCode,
  resumeAuthorizationRequest,
  revokeToken,
  userInfoForAccessToken,
  validateRequestedScopes,
  type OidcClient,
} from "./service";
import {
  browserLoginTransaction,
  createLoginTransaction,
  setLoginTransactionCookie,
} from "./transaction";
import { isAllowedOidcRedirectUri } from "./validation";

function endpoint(issuer: string, path: string) {
  return new URL(path, issuer).toString();
}

function noStore(c: Context<AppEnv>) {
  c.header("cache-control", "no-store");
  c.header("pragma", "no-cache");
}

async function enforceRateLimit(
  c: Context<AppEnv>,
  input: {
    action: string;
    identifier: string;
    limit: number;
    message: string;
  },
) {
  const rate = await checkRateLimit(c.env.DB, {
    action: input.action,
    identifier: input.identifier,
    limit: input.limit,
    windowMs: 60_000,
  });
  if (rate.allowed) return;
  c.header("retry-after", String(rate.retryAfterSeconds));
  throw new OidcError("temporarily_unavailable", input.message, 429);
}

function scheduleOidcCleanup(c: Context<AppEnv>, db: Database) {
  if (crypto.getRandomValues(new Uint8Array(1))[0]! >= 4) return;
  c.executionCtx.waitUntil(
    cleanupExpiredOidcArtifacts(db).catch((error: unknown) => {
      console.error("OIDC cleanup failed", error);
    }),
  );
}

function errorJson(c: Context<AppEnv>, error: unknown) {
  const normalized = oidcError(error);
  noStore(c);
  if (normalized.code === "invalid_client") {
    c.header("www-authenticate", 'Basic realm="OIDC token endpoint"');
  }
  return c.json(
    {
      error: normalized.code,
      error_description: normalized.message,
    },
    normalized.status,
  );
}

function validateRedirect(client: OidcClient, redirectUri: string | null) {
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    throw new OidcError(
      "invalid_request",
      "redirect_uri is not registered for this client",
    );
  }
  return redirectUri;
}

function parseAuthorizationParameters(url: URL, client: OidcClient) {
  const redirectUri = validateRedirect(
    client,
    url.searchParams.get("redirect_uri"),
  );
  const state = url.searchParams.get("state");
  if (!isAllowedOidcRedirectUri(redirectUri)) {
    throw new OidcError(
      "invalid_request",
      "redirect_uri must use HTTPS or HTTP on a loopback address",
    );
  }
  if (url.searchParams.get("response_type") !== "code") {
    throw new OidcError(
      "unsupported_response_type",
      "Only response_type=code is supported",
    );
  }
  const requestedScopes = (url.searchParams.get("scope") ?? "")
    .split(/\s+/u)
    .filter(Boolean);
  if (requestedScopes.length > MAX_SCOPE_COUNT) {
    throw new OidcError("invalid_scope", "Too many scopes were requested");
  }
  const scopes = validateRequestedScopes(client, requestedScopes);
  const codeChallenge = url.searchParams.get("code_challenge");
  if (
    !codeChallenge ||
    !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge) ||
    url.searchParams.get("code_challenge_method") !== "S256"
  ) {
    throw new OidcError(
      "invalid_request",
      "PKCE with code_challenge_method=S256 is required",
    );
  }
  const prompts = new Set(
    (url.searchParams.get("prompt") ?? "").split(/\s+/u).filter(Boolean),
  );
  if (
    [...prompts].some(
      (prompt) => !["none", "login", "consent"].includes(prompt),
    ) ||
    (prompts.has("none") && prompts.size > 1)
  ) {
    throw new OidcError("invalid_request", "Unsupported prompt value");
  }
  const maxAgeRaw = url.searchParams.get("max_age");
  if (maxAgeRaw !== null && !/^\d+$/u.test(maxAgeRaw)) {
    throw new OidcError(
      "invalid_request",
      "max_age must be a non-negative integer",
    );
  }
  const maxAge = maxAgeRaw === null ? undefined : Number(maxAgeRaw);
  if (maxAge !== undefined && (!Number.isSafeInteger(maxAge) || maxAge < 0)) {
    throw new OidcError(
      "invalid_request",
      "max_age must be a non-negative integer",
    );
  }
  return {
    redirectUri,
    state,
    scopes,
    codeChallenge,
    nonce: url.searchParams.get("nonce"),
    prompts,
    maxAge,
  };
}

async function authenticateClient(
  db: Database,
  request: Request,
  body: Record<string, string | File>,
) {
  let clientId =
    typeof body.client_id === "string" ? body.client_id : undefined;
  let secret: string | undefined;
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Basic ")) {
    try {
      const decoded = atob(authorization.slice(6));
      const separator = decoded.indexOf(":");
      if (separator < 0) throw new Error("separator");
      clientId = decodeURIComponent(decoded.slice(0, separator));
      secret = decodeURIComponent(decoded.slice(separator + 1));
    } catch {
      throw new OidcError("invalid_client", "Client authentication is invalid", 401);
    }
  }
  if (!clientId) {
    throw new OidcError("invalid_client", "client_id is required", 401);
  }
  let client: OidcClient;
  try {
    client = await findEnabledClient(db, clientId);
  } catch {
    throw new OidcError("invalid_client", "Client authentication failed", 401);
  }
  if (client.clientType === "confidential") {
    if (!secret || !client.secretHash) {
      throw new OidcError("invalid_client", "Client authentication failed", 401);
    }
    const providedHash = await hashToken(secret);
    if (!constantTimeEqual(providedHash, client.secretHash)) {
      throw new OidcError("invalid_client", "Client authentication failed", 401);
    }
  } else if (secret || authorization) {
    throw new OidcError(
      "invalid_client",
      "Public clients must not use a client secret",
      401,
    );
  }
  return client;
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function allowClientOrigin(c: Context<AppEnv>, client: OidcClient) {
  const origin = c.req.header("origin");
  if (!origin || !client.allowedOrigins.includes(origin)) return;
  c.header("access-control-allow-origin", origin);
  c.header("vary", "Origin");
}

export const wellKnownRoutes = new Hono<AppEnv>()
  .get("/openid-configuration", async (c) => {
    try {
      const issuer = oidcIssuer(c.env);
      c.header("cache-control", "public, max-age=300");
      return c.json({
        issuer,
        authorization_endpoint: endpoint(
          issuer,
          OIDC_ISSUER_PATHS.authorization,
        ),
        token_endpoint: endpoint(issuer, OIDC_ISSUER_PATHS.token),
        userinfo_endpoint: endpoint(issuer, OIDC_ISSUER_PATHS.userinfo),
        revocation_endpoint: endpoint(issuer, OIDC_ISSUER_PATHS.revocation),
        end_session_endpoint: endpoint(issuer, OIDC_ISSUER_PATHS.logout),
        jwks_uri: endpoint(issuer, OIDC_ISSUER_PATHS.jwks),
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: oidcScopes,
        claims_supported: [
          "sub",
          "iss",
          "aud",
          "exp",
          "iat",
          "auth_time",
          "nonce",
          "amr",
          "name",
          "picture",
          "email",
          "email_verified",
          "groups",
        ],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: [
          "client_secret_basic",
          "none",
        ],
        code_challenge_methods_supported: ["S256"],
      });
    } catch (error) {
      return errorJson(c, error);
    }
  })
  .get("/jwks.json", async (c) => {
    try {
      c.header("cache-control", "public, max-age=300, stale-while-revalidate=300");
      return c.json(await publicJwks(c.env));
    } catch (error) {
      return errorJson(c, error);
    }
  });

export const oidcRoutes = new Hono<AppEnv>()
  .get("/authorize/resume/:id", async (c) => {
    noStore(c);
    let redirectUri: string | undefined;
    let state: string | null | undefined;
    try {
      const session = await readSessionFromContext(c);
      if (!session) {
        throw new OidcError(
          "login_required",
          "The authenticated browser session is unavailable",
        );
      }
      const db = createDb(c.env.DB);
      const request = await authenticatedAuthorizationRequest(
        db,
        c.req.param("id"),
        session.user.id,
      );
      redirectUri = request.redirectUri;
      state = request.state;
      if (session.authTime.getTime() < request.authTime.getTime()) {
        throw new OidcError(
          "login_required",
          "The browser session predates the re-authentication transaction",
        );
      }
      return c.redirect(await resumeAuthorizationRequest(db, request));
    } catch (error) {
      const normalized = oidcError(error);
      if (redirectUri) {
        return c.redirect(
          authorizationErrorRedirect(
            redirectUri,
            normalized.code,
            state,
            normalized.message,
          ),
        );
      }
      return errorJson(c, normalized);
    }
  })
  .get("/authorize", async (c) => {
    noStore(c);
    const url = new URL(c.req.url);
    const state = url.searchParams.get("state");
    let redirectUri: string | undefined;
    try {
      await enforceRateLimit(c, {
        action: "oidc-authorize",
        identifier: requestIdentifier(c.req.raw),
        limit: 60,
        message: "Too many authorization requests",
      });
      const clientId = url.searchParams.get("client_id");
      if (!clientId) throw new OidcError("invalid_request", "client_id is required");
      const db = createDb(c.env.DB);
      scheduleOidcCleanup(c, db);
      const client = await findEnabledClient(db, clientId);
      redirectUri = validateRedirect(client, url.searchParams.get("redirect_uri"));
      const parameters = parseAuthorizationParameters(url, client);
      const session = await readSessionFromContext(c);
      const needsReauthentication =
        parameters.prompts.has("login") ||
        parameters.maxAge !== undefined &&
          session !== null &&
          (
            parameters.maxAge === 0 ||
            Date.now() - session.authTime.getTime() >
              parameters.maxAge * 1_000
          );

      if (!session || needsReauthentication) {
        if (parameters.prompts.has("none")) {
          return c.redirect(
            authorizationErrorRedirect(
              parameters.redirectUri,
              "login_required",
              parameters.state,
            ),
          );
        }
        const transaction = await createLoginTransaction(db, {
          clientId: client.id,
          redirectUri: parameters.redirectUri,
          scopes: parameters.scopes,
          state: parameters.state,
          nonce: parameters.nonce,
          codeChallenge: parameters.codeChallenge,
          forceConsent: parameters.prompts.has("consent"),
        });
        setLoginTransactionCookie(c, transaction);
        return c.redirect(
          `/oidc/login/${encodeURIComponent(transaction.id)}`,
        );
      }
      await assertUserCanUseClient(db, client, session.user.id);
      const existingGrant = await hasGrant(
        db,
        client.id,
        session.user.id,
        parameters.scopes,
      );
      const forceConsent = parameters.prompts.has("consent");
      if (parameters.prompts.has("none") && !client.trusted && !existingGrant) {
        return c.redirect(
          authorizationErrorRedirect(
            parameters.redirectUri,
            "consent_required",
            parameters.state,
          ),
        );
      }
      if (!forceConsent && (client.trusted || existingGrant)) {
        return c.redirect(
          await issueAuthorizationCode(db, {
            clientId: client.id,
            userId: session.user.id,
            redirectUri: parameters.redirectUri,
            scopes: parameters.scopes,
            state: parameters.state,
            nonce: parameters.nonce,
            codeChallenge: parameters.codeChallenge,
            authTime: session.authTime,
          }),
        );
      }
      const requestId = await createAuthorizationRequest(db, {
        clientId: client.id,
        userId: session.user.id,
        redirectUri: parameters.redirectUri,
        scopes: parameters.scopes,
        state: parameters.state,
        nonce: parameters.nonce,
        codeChallenge: parameters.codeChallenge,
        authTime: session.authTime,
      });
      return c.redirect(`/oidc/consent/${requestId}`);
    } catch (error) {
      const normalized = oidcError(error);
      if (redirectUri) {
        return c.redirect(
          authorizationErrorRedirect(
            redirectUri,
            normalized.code,
            state,
            normalized.message,
          ),
        );
      }
      return errorJson(c, normalized);
    }
  })
  .on("OPTIONS", ["/token", "/userinfo", "/revoke"], async (c) => {
    const origin = c.req.header("origin");
    if (origin) {
      const [allowed] = await createDb(c.env.DB)
        .select({ id: oidcClients.id })
        .from(oidcClients)
        .where(
          and(
            eq(oidcClients.enabled, true),
            sql`EXISTS (
              SELECT 1 FROM json_each(${oidcClients.allowedOrigins})
              WHERE json_each.value = ${origin}
            )`,
          ),
        )
        .limit(1);
      if (allowed) {
        c.header("access-control-allow-origin", origin);
        c.header("access-control-allow-methods", "POST, OPTIONS");
        c.header(
          "access-control-allow-headers",
          "authorization, content-type",
        );
        c.header("access-control-max-age", "600");
        c.header("vary", "Origin");
      }
    }
    return c.body(null, 204);
  })
  .post("/token", async (c) => {
    try {
      await enforceRateLimit(c, {
        action: "oidc-token-ip",
        identifier: requestIdentifier(c.req.raw),
        limit: 60,
        message: "Too many token requests",
      });
      const body = await c.req.parseBody();
      const db = createDb(c.env.DB);
      const client = await authenticateClient(db, c.req.raw, body);
      allowClientOrigin(c, client);
      await enforceRateLimit(c, {
        action: "oidc-token-client",
        identifier: `${requestIdentifier(c.req.raw)}:${client.id}`,
        limit: 120,
        message: "Too many token requests",
      });
      scheduleOidcCleanup(c, db);
      const grantType =
        typeof body.grant_type === "string" ? body.grant_type : "";
      if (grantType === "authorization_code") {
        const code = typeof body.code === "string" ? body.code : "";
        const redirectUri =
          typeof body.redirect_uri === "string" ? body.redirect_uri : "";
        const codeVerifier =
          typeof body.code_verifier === "string" ? body.code_verifier : "";
        if (
          !code ||
          !redirectUri ||
          !/^[A-Za-z0-9\-._~]{43,128}$/u.test(codeVerifier)
        ) {
          throw new OidcError(
            "invalid_request",
            "code, redirect_uri and a valid code_verifier are required",
          );
        }
        noStore(c);
        return c.json(
          await exchangeAuthorizationCode(db, c.env, {
            code,
            client,
            redirectUri,
            codeVerifier,
          }),
        );
      }
      if (grantType === "refresh_token") {
        const refreshToken =
          typeof body.refresh_token === "string" ? body.refresh_token : "";
        if (!refreshToken) {
          throw new OidcError("invalid_request", "refresh_token is required");
        }
        noStore(c);
        return c.json(
          await exchangeRefreshToken(db, c.env, { refreshToken, client }),
        );
      }
      throw new OidcError(
        "unsupported_grant_type",
        "Only authorization_code and refresh_token are supported",
      );
    } catch (error) {
      return errorJson(c, error);
    }
  })
  .on(["GET", "POST"], "/userinfo", async (c) => {
    try {
      const authorization = c.req.header("authorization");
      if (!authorization?.startsWith("Bearer ")) {
        throw new OidcError("invalid_token", "Bearer access token is required", 401);
      }
      noStore(c);
      const userinfo = await userInfoForAccessToken(
        createDb(c.env.DB),
        authorization.slice(7),
      );
      allowClientOrigin(c, userinfo.client);
      return c.json(userinfo.claims);
    } catch (error) {
      c.header("www-authenticate", 'Bearer realm="OIDC userinfo"');
      return errorJson(c, error);
    }
  })
  .post("/revoke", async (c) => {
    try {
      await enforceRateLimit(c, {
        action: "oidc-revoke-ip",
        identifier: requestIdentifier(c.req.raw),
        limit: 60,
        message: "Too many revocation requests",
      });
      const body = await c.req.parseBody();
      const db = createDb(c.env.DB);
      const client = await authenticateClient(db, c.req.raw, body);
      allowClientOrigin(c, client);
      await enforceRateLimit(c, {
        action: "oidc-revoke-client",
        identifier: `${requestIdentifier(c.req.raw)}:${client.id}`,
        limit: 120,
        message: "Too many revocation requests",
      });
      const token = typeof body.token === "string" ? body.token : "";
      if (token) await revokeToken(db, token, client.id);
      noStore(c);
      return c.body(null, 200);
    } catch (error) {
      return errorJson(c, error);
    }
  })
  .get("/logout", async (c) => {
    noStore(c);
    const db = createDb(c.env.DB);
    const session = await readSessionFromContext(c);
    const query = {
      clientId: c.req.query("client_id") ?? undefined,
      idTokenHint: c.req.query("id_token_hint") ?? undefined,
      postLogoutRedirectUri:
        c.req.query("post_logout_redirect_uri") ?? undefined,
      state: c.req.query("state") ?? undefined,
    };

    const resolved = await resolveLogoutRequest(c.env, db, session, query);
    if (resolved.kind === "error") return errorJson(c, resolved.error);
    if (resolved.kind === "confirm") {
      const confirm = new URL("/oidc/logout", oidcIssuer(c.env));
      for (const [key, value] of Object.entries({
        client_id: query.clientId,
        id_token_hint: query.idTokenHint,
        post_logout_redirect_uri: query.postLogoutRedirectUri,
        state: query.state,
      })) {
        if (value) confirm.searchParams.set(key, value);
      }
      return c.redirect(confirm.toString());
    }

    if (resolved.destroySession) await destroySession(db, c);
    return c.redirect(resolved.redirectTo);
  });

export const oidcLogoutRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .post(
    "/",
    zValidator(
      "json",
      z.object({
        client_id: z.string().optional(),
        id_token_hint: z.string().optional(),
        post_logout_redirect_uri: z.string().optional(),
        state: z.string().optional(),
      }),
    ),
    async (c) => {
      try {
        const body = c.req.valid("json");
        const db = createDb(c.env.DB);
        const session = await readSessionFromContext(c);
        if (!session) {
          throw new OidcError("login_required", "Authentication required", 401);
        }
        const resolved = await resolveLogoutRequest(c.env, db, session, {
          clientId: body.client_id,
          idTokenHint: body.id_token_hint,
          postLogoutRedirectUri: body.post_logout_redirect_uri,
          state: body.state,
        }, { confirmed: true });
        if (resolved.kind === "error") throw resolved.error;
        if (resolved.kind !== "complete") {
          throw new OidcError(
            "server_error",
            "Logout confirmation could not be completed",
            500,
          );
        }
        await destroySession(db, c);
        return c.json({
          ok: true as const,
          redirectTo: resolved.redirectTo,
        });
      } catch (error) {
        const normalized = oidcError(error);
        return c.json(
          {
            ok: false as const,
            error: { code: normalized.code, message: normalized.message },
          },
          normalized.status,
        );
      }
    },
  );

async function resolveLogoutRequest(
  env: AppEnv["Bindings"],
  db: Database,
  session: Awaited<ReturnType<typeof readSessionFromContext>>,
  query: {
    clientId?: string;
    idTokenHint?: string;
    postLogoutRedirectUri?: string;
    state?: string;
  },
  options: { confirmed?: boolean } = {},
): Promise<
  | { kind: "complete"; redirectTo: string; destroySession: boolean }
  | { kind: "confirm" }
  | { kind: "error"; error: OidcError }
> {
  let clientId = query.clientId;
  let sessionBoundHint = false;

  if (query.idTokenHint) {
    let hint: Awaited<ReturnType<typeof claimsFromIdTokenHint>> | undefined;
    try {
      hint = await claimsFromIdTokenHint(env, query.idTokenHint);
    } catch {
      hint = undefined;
    }
    if (hint) {
      if (clientId && clientId !== hint.clientId) {
        return {
          kind: "error",
          error: new OidcError(
            "invalid_request",
            "client_id does not match id_token_hint",
          ),
        };
      }
      if (session && session.user.id !== hint.subject) {
        return {
          kind: "error",
          error: new OidcError(
            "invalid_request",
            "id_token_hint does not belong to the current session",
          ),
        };
      }
      clientId = hint.clientId;
      sessionBoundHint = Boolean(session && session.user.id === hint.subject);
    }
  }

  const home = new URL("/", oidcIssuer(env)).toString();
  let redirectTo = home;
  if (query.postLogoutRedirectUri && clientId) {
    try {
      const client = await findEnabledClient(db, clientId);
      if (client.postLogoutRedirectUris.includes(query.postLogoutRedirectUri)) {
        const target = new URL(query.postLogoutRedirectUri);
        if (query.state) target.searchParams.set("state", query.state);
        redirectTo = target.toString();
      }
    } catch {
      // Keep the OP home redirect when the registered logout URI is unavailable.
    }
  }

  if (!session) {
    return { kind: "complete", redirectTo, destroySession: false };
  }
  if (options.confirmed || sessionBoundHint) {
    return { kind: "complete", redirectTo, destroySession: true };
  }
  return { kind: "confirm" };
}

export const oidcConsentRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/:id", async (c) => {
    try {
      const request = await getAuthorizationRequest(
        createDb(c.env.DB),
        c.req.param("id"),
        c.get("user").id,
      );
      return c.json({ ok: true as const, request });
    } catch (error) {
      const normalized = oidcError(error);
      return c.json(
        {
          ok: false as const,
          error: { code: normalized.code, message: normalized.message },
        },
        normalized.status,
      );
    }
  })
  .post("/:id", zValidator("json", z.object({ approved: z.boolean() })), async (c) => {
    try {
      const body = c.req.valid("json");
      const redirectTo = await finishAuthorizationRequest(createDb(c.env.DB), {
        requestId: c.req.param("id"),
        userId: c.get("user").id,
        approved: body.approved,
      });
      return c.json({ ok: true as const, redirectTo });
    } catch (error) {
      const normalized = oidcError(error);
      return c.json(
        {
          ok: false as const,
          error: { code: normalized.code, message: normalized.message },
        },
        normalized.status,
      );
    }
  });

export const oidcLoginRoutes = new Hono<AppEnv>()
  .get("/:id", async (c) => {
    try {
      const transaction = await browserLoginTransaction(
        createDb(c.env.DB),
        c,
        c.req.param("id"),
      );
      return c.json({
        ok: true as const,
        transaction: {
          id: transaction.id,
          clientName: transaction.clientName,
          expiresAt: transaction.expiresAt,
        },
      });
    } catch (error) {
      const normalized = oidcError(error);
      return c.json(
        {
          ok: false as const,
          error: { code: normalized.code, message: normalized.message },
        },
        normalized.status,
      );
    }
  });
