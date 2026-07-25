import {
  and,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { OidcScope } from "../../shared/oidc";
import type { Database } from "../db/client";
import {
  groupMembers,
  identityGroups,
  mailboxes,
  oidcAccessTokens,
  oidcAuditEvents,
  oidcAuthorizationCodes,
  oidcAuthorizationRequests,
  oidcClientAssignments,
  oidcClientGroupClaims,
  oidcClients,
  oidcGrants,
  oidcRefreshTokens,
  users,
} from "../db/schema";
import type { AppEnv } from "../env";
import { hashToken, randomToken } from "../lib/crypto";
import { createId } from "../lib/ids";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  AUTHORIZATION_REQUEST_TTL_MS,
  MAX_GROUP_CLAIMS,
  REFRESH_TOKEN_TTL_MS,
} from "./constants";
import { OidcError } from "./errors";
import { signIdToken } from "./keys";

export type OidcClient = typeof oidcClients.$inferSelect;

export async function findEnabledClient(db: Database, clientId: string) {
  const [client] = await db
    .select()
    .from(oidcClients)
    .where(and(eq(oidcClients.id, clientId), eq(oidcClients.enabled, true)))
    .limit(1);
  if (!client) throw new OidcError("invalid_request", "Unknown OIDC client");
  return client;
}

export async function assertUserCanUseClient(
  db: Database,
  client: OidcClient,
  userId: string,
) {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.status, "active")))
    .limit(1);
  if (!user) throw new OidcError("access_denied", "User account is not active", 403);
  if (client.accessPolicy === "all_active_users") return;

  const [assignment] = await db
    .select({ userId: oidcClientAssignments.userId })
    .from(oidcClientAssignments)
    .where(
      and(
        eq(oidcClientAssignments.clientId, client.id),
        eq(oidcClientAssignments.userId, userId),
      ),
    )
    .limit(1);
  if (!assignment) {
    throw new OidcError(
      "access_denied",
      "You are not assigned to this application",
      403,
    );
  }
}

export function validateRequestedScopes(
  client: OidcClient,
  requested: string[],
): OidcScope[] {
  const unique = [...new Set(requested)];
  if (!unique.includes("openid")) {
    throw new OidcError("invalid_scope", "The openid scope is required");
  }
  if (
    unique.some((scope) => !client.allowedScopes.includes(scope))
  ) {
    throw new OidcError(
      "invalid_scope",
      "One or more requested scopes are not allowed",
    );
  }
  return unique as OidcScope[];
}

export async function hasGrant(
  db: Database,
  clientId: string,
  userId: string,
  scopes: string[],
) {
  const [grant] = await db
    .select({ scopes: oidcGrants.scopes })
    .from(oidcGrants)
    .where(
      and(
        eq(oidcGrants.clientId, clientId),
        eq(oidcGrants.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(grant && scopes.every((scope) => grant.scopes.includes(scope)));
}

export async function createAuthorizationRequest(
  db: Database,
  input: {
    clientId: string;
    userId: string;
    redirectUri: string;
    scopes: string[];
    state?: string | null;
    nonce?: string | null;
    codeChallenge: string;
    authTime: Date;
  },
) {
  const id = createId("req");
  const now = new Date();
  await db.insert(oidcAuthorizationRequests).values({
    id,
    ...input,
    status: "awaiting_consent",
    forceConsent: true,
    state: input.state ?? null,
    nonce: input.nonce ?? null,
    expiresAt: new Date(now.getTime() + AUTHORIZATION_REQUEST_TTL_MS),
    createdAt: now,
  });
  return id;
}

export async function getAuthorizationRequest(
  db: Database,
  requestId: string,
  userId: string,
) {
  const [request] = await db
    .select({
      id: oidcAuthorizationRequests.id,
      clientId: oidcAuthorizationRequests.clientId,
      clientName: oidcClients.name,
      scopes: oidcAuthorizationRequests.scopes,
      expiresAt: oidcAuthorizationRequests.expiresAt,
    })
    .from(oidcAuthorizationRequests)
    .innerJoin(
      oidcClients,
      eq(oidcAuthorizationRequests.clientId, oidcClients.id),
    )
    .where(
      and(
        eq(oidcAuthorizationRequests.id, requestId),
        eq(oidcAuthorizationRequests.userId, userId),
        eq(oidcAuthorizationRequests.status, "awaiting_consent"),
        gt(oidcAuthorizationRequests.expiresAt, new Date()),
        eq(oidcClients.enabled, true),
      ),
    )
    .limit(1);
  if (!request) {
    throw new OidcError(
      "invalid_request",
      "Authorization request is invalid or expired",
    );
  }
  return request;
}

export async function finishAuthorizationRequest(
  db: Database,
  input: {
    requestId: string;
    userId: string;
    approved: boolean;
  },
) {
  const [request] = await db
    .delete(oidcAuthorizationRequests)
    .where(
      and(
        eq(oidcAuthorizationRequests.id, input.requestId),
        eq(oidcAuthorizationRequests.userId, input.userId),
        eq(oidcAuthorizationRequests.status, "awaiting_consent"),
        gt(oidcAuthorizationRequests.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!request) {
    throw new OidcError(
      "invalid_request",
      "Authorization request is invalid or expired",
    );
  }

  if (!input.approved) {
    await insertOidcAudit(db, {
      eventType: "authorization.denied",
      subjectUserId: input.userId,
      clientId: request.clientId,
    });
    return authorizationErrorRedirect(
      request.redirectUri,
      "access_denied",
      request.state,
    );
  }
  if (!request.authTime) {
    throw new OidcError(
      "invalid_request",
      "Authorization request has no authentication time",
    );
  }

  const client = await findEnabledClient(db, request.clientId);
  if (!client.redirectUris.includes(request.redirectUri)) {
    throw new OidcError(
      "invalid_request",
      "The registered redirect URI has changed",
    );
  }
  const scopes = validateRequestedScopes(client, request.scopes);
  await assertUserCanUseClient(db, client, input.userId);
  const now = new Date();
  const [existingGrant] = await db
    .select({ scopes: oidcGrants.scopes })
    .from(oidcGrants)
    .where(
      and(
        eq(oidcGrants.clientId, request.clientId),
        eq(oidcGrants.userId, input.userId),
      ),
    )
    .limit(1);
  const grantedScopes = [
    ...new Set([...(existingGrant?.scopes ?? []), ...scopes]),
  ];
  await db
    .insert(oidcGrants)
    .values({
      clientId: request.clientId,
      userId: input.userId,
      scopes: grantedScopes,
      grantedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [oidcGrants.clientId, oidcGrants.userId],
      set: { scopes: grantedScopes, updatedAt: now },
    });
  const redirectTo = await issueAuthorizationCode(db, {
    ...request,
    scopes,
    userId: input.userId,
    authTime: request.authTime,
  });
  await insertOidcAudit(db, {
    eventType: "authorization.approved",
    subjectUserId: input.userId,
    clientId: request.clientId,
    detail: { scopes: grantedScopes },
  });
  return redirectTo;
}

export async function authenticatedAuthorizationRequest(
  db: Database,
  requestId: string,
  userId: string,
) {
  const [request] = await db
    .select()
    .from(oidcAuthorizationRequests)
    .where(
      and(
        eq(oidcAuthorizationRequests.id, requestId),
        eq(oidcAuthorizationRequests.userId, userId),
        eq(oidcAuthorizationRequests.status, "authenticated"),
        gt(oidcAuthorizationRequests.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!request?.userId || !request.authTime) {
    throw new OidcError(
      "invalid_request",
      "Authorization transaction is invalid or expired",
    );
  }
  return {
    ...request,
    userId: request.userId,
    authTime: request.authTime,
  };
}

export async function resumeAuthorizationRequest(
  db: Database,
  request: Awaited<ReturnType<typeof authenticatedAuthorizationRequest>>,
) {
  const client = await findEnabledClient(db, request.clientId);
  if (!client.redirectUris.includes(request.redirectUri)) {
    throw new OidcError(
      "invalid_request",
      "The registered redirect URI has changed",
    );
  }
  await assertUserCanUseClient(db, client, request.userId);
  validateRequestedScopes(client, request.scopes);
  const existingGrant = await hasGrant(
    db,
    client.id,
    request.userId,
    request.scopes,
  );
  if (!request.forceConsent && (client.trusted || existingGrant)) {
    const [consumed] = await db
      .delete(oidcAuthorizationRequests)
      .where(
        and(
          eq(oidcAuthorizationRequests.id, request.id),
          eq(oidcAuthorizationRequests.status, "authenticated"),
        ),
      )
      .returning({ id: oidcAuthorizationRequests.id });
    if (!consumed) {
      throw new OidcError(
        "invalid_request",
        "Authorization transaction was already used",
      );
    }
    return issueAuthorizationCode(db, request);
  }

  const [continued] = await db
    .update(oidcAuthorizationRequests)
    .set({ status: "awaiting_consent" })
    .where(
      and(
        eq(oidcAuthorizationRequests.id, request.id),
        eq(oidcAuthorizationRequests.status, "authenticated"),
      ),
    )
    .returning({ id: oidcAuthorizationRequests.id });
  if (!continued) {
    throw new OidcError(
      "invalid_request",
      "Authorization transaction was already used",
    );
  }
  return `/oidc/consent/${encodeURIComponent(request.id)}`;
}

export async function issueAuthorizationCode(
  db: Database,
  input: {
    clientId: string;
    userId: string;
    redirectUri: string;
    scopes: string[];
    state?: string | null;
    nonce?: string | null;
    codeChallenge: string;
    authTime: Date;
  },
) {
  const code = randomToken();
  const now = new Date();
  await db.insert(oidcAuthorizationCodes).values({
    tokenHash: await hashToken(code),
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
    nonce: input.nonce ?? null,
    codeChallenge: input.codeChallenge,
    authTime: input.authTime,
    expiresAt: new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS),
    createdAt: now,
  });
  const target = new URL(input.redirectUri);
  target.searchParams.set("code", code);
  if (input.state) target.searchParams.set("state", input.state);
  return target.toString();
}

export function authorizationErrorRedirect(
  redirectUri: string,
  code: string,
  state?: string | null,
  description?: string,
) {
  const target = new URL(redirectUri);
  target.searchParams.set("error", code);
  if (state) target.searchParams.set("state", state);
  if (description) target.searchParams.set("error_description", description);
  return target.toString();
}

export async function exchangeAuthorizationCode(
  db: Database,
  env: AppEnv["Bindings"],
  input: {
    code: string;
    client: OidcClient;
    redirectUri: string;
    codeVerifier: string;
  },
) {
  const tokenHash = await hashToken(input.code);
  const [authorizationCode] = await db
    .select()
    .from(oidcAuthorizationCodes)
    .where(
      and(
        eq(oidcAuthorizationCodes.tokenHash, tokenHash),
        eq(oidcAuthorizationCodes.clientId, input.client.id),
      ),
    )
    .limit(1);
  if (!authorizationCode) {
    throw new OidcError("invalid_grant", "Authorization code is invalid or expired");
  }
  if (authorizationCode.usedAt) {
    await revokeAuthorizationCodeIssuance(db, authorizationCode);
    throw new OidcError("invalid_grant", "Authorization code was already used");
  }
  if (authorizationCode.expiresAt <= new Date()) {
    throw new OidcError("invalid_grant", "Authorization code is invalid or expired");
  }
  if (authorizationCode.redirectUri !== input.redirectUri) {
    throw new OidcError("invalid_grant", "Redirect URI does not match");
  }
  if (!input.client.redirectUris.includes(input.redirectUri)) {
    throw new OidcError("invalid_grant", "Redirect URI is no longer registered");
  }
  if (await hashToken(input.codeVerifier) !== authorizationCode.codeChallenge) {
    throw new OidcError("invalid_grant", "PKCE verification failed");
  }
  const scopes = validateRequestedScopes(input.client, authorizationCode.scopes);
  await assertUserCanUseClient(db, input.client, authorizationCode.userId);
  const prepared = await prepareTokenSet(db, env, {
    client: input.client,
    userId: authorizationCode.userId,
    scopes,
    authTime: authorizationCode.authTime,
    nonce: authorizationCode.nonce,
  });
  const [consumed] = await db.batch([
    db
      .update(oidcAuthorizationCodes)
      .set({
        usedAt: prepared.now,
        issuedAccessTokenHash: prepared.accessTokenValues.tokenHash,
        issuedRefreshFamilyId: prepared.accessTokenValues.familyId,
      })
      .where(
        and(
          eq(oidcAuthorizationCodes.tokenHash, tokenHash),
          eq(oidcAuthorizationCodes.clientId, input.client.id),
          isNull(oidcAuthorizationCodes.usedAt),
          gt(oidcAuthorizationCodes.expiresAt, prepared.now),
        ),
      )
      .returning({ tokenHash: oidcAuthorizationCodes.tokenHash }),
    conditionalTokenInsert(db, {
      table: "access",
      values: prepared.accessTokenValues,
      from: "authorization_code",
      codeHash: tokenHash,
      accessTokenHash: prepared.accessTokenValues.tokenHash,
    }),
    ...(prepared.refreshTokenValues
      ? [conditionalTokenInsert(db, {
        table: "refresh",
        values: prepared.refreshTokenValues,
        from: "authorization_code",
        codeHash: tokenHash,
        accessTokenHash: prepared.accessTokenValues.tokenHash,
      })]
      : []),
  ]);
  if (consumed.length === 0) {
    const [current] = await db
      .select()
      .from(oidcAuthorizationCodes)
      .where(eq(oidcAuthorizationCodes.tokenHash, tokenHash))
      .limit(1);
    if (current?.usedAt) {
      await revokeAuthorizationCodeIssuance(db, current);
      throw new OidcError("invalid_grant", "Authorization code was already used");
    }
    throw new OidcError("invalid_grant", "Authorization code is invalid or expired");
  }
  await recordTokenUsage(db, {
    clientId: input.client.id,
    userId: authorizationCode.userId,
    scopes,
    now: prepared.now,
  });
  return prepared.response;
}

async function identityClaims(
  db: Database,
  input: {
    clientId: string;
    userId: string;
    scopes: string[];
  },
) {
  const [identity] = await db
    .select({
      name: users.name,
      avatarUrl: users.avatarUrl,
      email: mailboxes.address,
    })
    .from(users)
    .innerJoin(mailboxes, eq(mailboxes.personalOwnerId, users.id))
    .where(
      and(
        eq(users.id, input.userId),
        eq(users.status, "active"),
        eq(mailboxes.kind, "personal"),
      ),
    )
    .limit(1);
  if (!identity) {
    throw new OidcError("invalid_grant", "User identity is unavailable");
  }

  const claims: Record<string, unknown> = {};
  if (input.scopes.includes("profile")) {
    claims.name = identity.name;
    if (identity.avatarUrl) claims.picture = identity.avatarUrl;
  }
  if (input.scopes.includes("email")) {
    claims.email = identity.email;
    claims.email_verified = true;
  }
  if (input.scopes.includes("groups")) {
    const rows = await db
      .select({ slug: identityGroups.slug })
      .from(groupMembers)
      .innerJoin(
        oidcClientGroupClaims,
        and(
          eq(oidcClientGroupClaims.groupId, groupMembers.groupId),
          eq(oidcClientGroupClaims.clientId, input.clientId),
        ),
      )
      .innerJoin(identityGroups, eq(identityGroups.id, groupMembers.groupId))
      .where(eq(groupMembers.userId, input.userId))
      .orderBy(identityGroups.slug)
      .limit(MAX_GROUP_CLAIMS + 1);
    if (rows.length > MAX_GROUP_CLAIMS) {
      throw new OidcError(
        "server_error",
        "Group claim exceeds the configured limit",
        500,
      );
    }
    claims.groups = rows.map((row) => row.slug);
  }
  return claims;
}

type PreparedRefreshTokenValues = {
  tokenHash: string;
  familyId: string;
  clientId: string;
  userId: string;
  scopes: string[];
  authTime: Date;
  expiresAt: Date;
  createdAt: Date;
};

async function prepareTokenSet(
  db: Database,
  env: AppEnv["Bindings"],
  input: {
    client: OidcClient;
    userId: string;
    scopes: string[];
    authTime: Date;
    nonce?: string | null;
    familyId?: string;
  },
) {
  const claims = await identityClaims(db, {
    clientId: input.client.id,
    userId: input.userId,
    scopes: input.scopes,
  });
  const idToken = await signIdToken(env, {
    clientId: input.client.id,
    userId: input.userId,
    authTime: input.authTime,
    nonce: input.nonce,
    claims,
  });
  const now = new Date();
  const accessToken = randomToken();
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TOKEN_TTL_MS);
  const familyId = input.familyId ?? createId("fam");
  const accessTokenValues = {
    tokenHash: await hashToken(accessToken),
    familyId,
    clientId: input.client.id,
    userId: input.userId,
    scopes: input.scopes,
    authTime: input.authTime,
    expiresAt: accessExpiresAt,
    createdAt: now,
  };

  let refreshToken: string | undefined;
  let refreshTokenValues: PreparedRefreshTokenValues | undefined;
  if (input.scopes.includes("offline_access")) {
    refreshToken = randomToken();
    refreshTokenValues = {
      tokenHash: await hashToken(refreshToken),
      familyId,
      clientId: input.client.id,
      userId: input.userId,
      scopes: input.scopes,
      authTime: input.authTime,
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      createdAt: now,
    };
  }

  return {
    now,
    accessTokenValues,
    refreshTokenValues,
    response: {
      token_type: "Bearer" as const,
      access_token: accessToken,
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1_000),
      id_token: idToken,
      scope: input.scopes.join(" "),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
    },
  };
}

function accessTokenSelectColumns(
  values: Awaited<ReturnType<typeof prepareTokenSet>>["accessTokenValues"],
) {
  return {
    tokenHash: sql<string>`${values.tokenHash}`.as("token_hash"),
    familyId: sql<string>`${values.familyId}`.as("family_id"),
    clientId: sql<string>`${values.clientId}`.as("client_id"),
    userId: sql<string>`${values.userId}`.as("user_id"),
    scopes: sql<string[]>`${JSON.stringify(values.scopes)}`.as("scopes"),
    authTime: sql<Date>`${values.authTime.getTime()}`.as("auth_time"),
    expiresAt: sql<Date>`${values.expiresAt.getTime()}`.as("expires_at"),
    createdAt: sql<Date>`${values.createdAt.getTime()}`.as("created_at"),
  };
}

function refreshTokenSelectColumns(
  values: NonNullable<
    Awaited<ReturnType<typeof prepareTokenSet>>["refreshTokenValues"]
  >,
) {
  return {
    tokenHash: sql<string>`${values.tokenHash}`.as("token_hash"),
    familyId: sql<string>`${values.familyId}`.as("family_id"),
    clientId: sql<string>`${values.clientId}`.as("client_id"),
    userId: sql<string>`${values.userId}`.as("user_id"),
    scopes: sql<string[]>`${JSON.stringify(values.scopes)}`.as("scopes"),
    authTime: sql<Date>`${values.authTime.getTime()}`.as("auth_time"),
    expiresAt: sql<Date>`${values.expiresAt.getTime()}`.as("expires_at"),
    usedAt: sql<Date | null>`NULL`.as("used_at"),
    revokedAt: sql<Date | null>`NULL`.as("revoked_at"),
    replacedByTokenHash: sql<string | null>`NULL`.as("replaced_by_token_hash"),
    createdAt: sql<Date>`${values.createdAt.getTime()}`.as("created_at"),
  };
}

function conditionalTokenInsert(
  db: Database,
  input:
    | {
      table: "access";
      values: Awaited<ReturnType<typeof prepareTokenSet>>["accessTokenValues"];
      from: "refresh_rotation";
      previousTokenHash: string;
      replacementTokenHash: string;
    }
    | {
      table: "refresh";
      values: NonNullable<
        Awaited<ReturnType<typeof prepareTokenSet>>["refreshTokenValues"]
      >;
      from: "refresh_rotation";
      previousTokenHash: string;
      replacementTokenHash: string;
    }
    | {
      table: "access";
      values: Awaited<ReturnType<typeof prepareTokenSet>>["accessTokenValues"];
      from: "authorization_code";
      codeHash: string;
      accessTokenHash: string;
    }
    | {
      table: "refresh";
      values: NonNullable<
        Awaited<ReturnType<typeof prepareTokenSet>>["refreshTokenValues"]
      >;
      from: "authorization_code";
      codeHash: string;
      accessTokenHash: string;
    },
) {
  const source = input.from === "refresh_rotation"
    ? oidcRefreshTokens
    : oidcAuthorizationCodes;
  const gate: SQL = input.from === "refresh_rotation"
    ? and(
      eq(oidcRefreshTokens.tokenHash, input.previousTokenHash),
      eq(oidcRefreshTokens.replacedByTokenHash, input.replacementTokenHash),
    )!
    : and(
      eq(oidcAuthorizationCodes.tokenHash, input.codeHash),
      eq(oidcAuthorizationCodes.issuedAccessTokenHash, input.accessTokenHash),
      ...(input.table === "refresh"
        ? [eq(
          oidcAuthorizationCodes.issuedRefreshFamilyId,
          input.values.familyId,
        )]
        : []),
    )!;

  if (input.table === "access") {
    return db.insert(oidcAccessTokens).select(
      db.select(accessTokenSelectColumns(input.values)).from(source).where(gate),
    );
  }
  return db.insert(oidcRefreshTokens).select(
    db.select(refreshTokenSelectColumns(input.values)).from(source).where(gate),
  );
}

async function revokeAuthorizationCodeIssuance(
  db: Database,
  code: {
    clientId: string;
    issuedAccessTokenHash: string | null;
    issuedRefreshFamilyId: string | null;
  },
) {
  if (code.issuedRefreshFamilyId) {
    await revokeTokenFamily(db, code.issuedRefreshFamilyId);
    return;
  }
  if (code.issuedAccessTokenHash) {
    await db
      .delete(oidcAccessTokens)
      .where(
        and(
          eq(oidcAccessTokens.tokenHash, code.issuedAccessTokenHash),
          eq(oidcAccessTokens.clientId, code.clientId),
        ),
      );
  }
}

async function revokeTokenFamily(db: Database, familyId: string) {
  await db.batch([
    db
      .update(oidcRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(oidcRefreshTokens.familyId, familyId)),
    db
      .delete(oidcAccessTokens)
      .where(eq(oidcAccessTokens.familyId, familyId)),
  ]);
}

async function recordTokenUsage(
  db: Database,
  input: {
    clientId: string;
    userId: string;
    scopes: string[];
    now: Date;
  },
) {
  try {
    await db.batch([
      db
        .update(oidcClients)
        .set({ lastUsedAt: input.now, updatedAt: input.now })
        .where(eq(oidcClients.id, input.clientId)),
      insertOidcAudit(db, {
        eventType: "token.issued",
        subjectUserId: input.userId,
        clientId: input.clientId,
        detail: { scopes: input.scopes },
      }),
    ]);
  } catch (error) {
    console.error("Could not record OIDC token usage", error);
  }
}

export async function exchangeRefreshToken(
  db: Database,
  env: AppEnv["Bindings"],
  input: {
    refreshToken: string;
    client: OidcClient;
  },
) {
  const tokenHash = await hashToken(input.refreshToken);
  const [stored] = await db
    .select()
    .from(oidcRefreshTokens)
    .where(
      and(
        eq(oidcRefreshTokens.tokenHash, tokenHash),
        eq(oidcRefreshTokens.clientId, input.client.id),
      ),
    )
    .limit(1);
  if (!stored) throw new OidcError("invalid_grant", "Refresh token is invalid");
  if (stored.expiresAt <= new Date()) {
    throw new OidcError("invalid_grant", "Refresh token is expired");
  }
  if (stored.usedAt || stored.revokedAt) {
    await revokeTokenFamily(db, stored.familyId);
    throw new OidcError(
      "invalid_grant",
      "Refresh token reuse was detected",
    );
  }

  await assertUserCanUseClient(db, input.client, stored.userId);
  validateRequestedScopes(input.client, stored.scopes);
  const prepared = await prepareTokenSet(db, env, {
    client: input.client,
    userId: stored.userId,
    scopes: stored.scopes,
    authTime: stored.authTime,
    familyId: stored.familyId,
  });
  if (!prepared.refreshTokenValues) {
    throw new OidcError(
      "server_error",
      "Refresh token scopes cannot produce a replacement",
      500,
    );
  }
  const replacementTokenHash = prepared.refreshTokenValues.tokenHash;
  const [consumed] = await db.batch([
    db
      .update(oidcRefreshTokens)
      .set({
        usedAt: prepared.now,
        replacedByTokenHash: replacementTokenHash,
      })
      .where(
        and(
          eq(oidcRefreshTokens.tokenHash, tokenHash),
          isNull(oidcRefreshTokens.usedAt),
          isNull(oidcRefreshTokens.revokedAt),
          isNull(oidcRefreshTokens.replacedByTokenHash),
          gt(oidcRefreshTokens.expiresAt, prepared.now),
        ),
      )
      .returning({ tokenHash: oidcRefreshTokens.tokenHash }),
    conditionalTokenInsert(db, {
      table: "access",
      values: prepared.accessTokenValues,
      from: "refresh_rotation",
      previousTokenHash: tokenHash,
      replacementTokenHash,
    }),
    conditionalTokenInsert(db, {
      table: "refresh",
      values: prepared.refreshTokenValues,
      from: "refresh_rotation",
      previousTokenHash: tokenHash,
      replacementTokenHash,
    }),
  ]);
  if (consumed.length === 0) {
    const [current] = await db
      .select()
      .from(oidcRefreshTokens)
      .where(eq(oidcRefreshTokens.tokenHash, tokenHash))
      .limit(1);
    if (!current || current.expiresAt <= new Date()) {
      throw new OidcError("invalid_grant", "Refresh token is expired");
    }
    await revokeTokenFamily(db, current.familyId);
    throw new OidcError("invalid_grant", "Refresh token was already used");
  }
  await recordTokenUsage(db, {
    clientId: input.client.id,
    userId: stored.userId,
    scopes: stored.scopes,
    now: prepared.now,
  });
  return prepared.response;
}

export async function userInfoForAccessToken(
  db: Database,
  rawToken: string,
) {
  const [token] = await db
    .select({
      clientId: oidcAccessTokens.clientId,
      userId: oidcAccessTokens.userId,
      scopes: oidcAccessTokens.scopes,
    })
    .from(oidcAccessTokens)
    .where(
      and(
        eq(oidcAccessTokens.tokenHash, await hashToken(rawToken)),
        gt(oidcAccessTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!token) throw new OidcError("invalid_token", "Access token is invalid", 401);
  const client = await findEnabledClient(db, token.clientId);
  await assertUserCanUseClient(db, client, token.userId);
  return {
    client,
    claims: {
      sub: token.userId,
      ...(await identityClaims(db, token)),
    },
  };
}

export async function revokeToken(
  db: Database,
  rawToken: string,
  clientId: string,
) {
  const tokenHash = await hashToken(rawToken);
  const [refresh] = await db
    .select({
      familyId: oidcRefreshTokens.familyId,
      userId: oidcRefreshTokens.userId,
    })
    .from(oidcRefreshTokens)
    .where(
      and(
        eq(oidcRefreshTokens.tokenHash, tokenHash),
        eq(oidcRefreshTokens.clientId, clientId),
      ),
    )
    .limit(1);
  if (refresh) {
    await revokeTokenFamily(db, refresh.familyId);
  } else {
    await db
      .delete(oidcAccessTokens)
      .where(
        and(
          eq(oidcAccessTokens.tokenHash, tokenHash),
          eq(oidcAccessTokens.clientId, clientId),
        ),
      );
  }
  await insertOidcAudit(db, {
    eventType: "token.revoked",
    clientId,
  });
}

export async function cleanupExpiredOidcArtifacts(db: Database) {
  const now = new Date();
  const usedCodeRetentionCutoff = new Date(
    now.getTime() - REFRESH_TOKEN_TTL_MS,
  );
  await db.batch([
    db
      .delete(oidcAuthorizationRequests)
      .where(lte(oidcAuthorizationRequests.expiresAt, now)),
    db
      .delete(oidcAuthorizationCodes)
      .where(
        or(
          and(
            isNull(oidcAuthorizationCodes.usedAt),
            lte(oidcAuthorizationCodes.expiresAt, now),
          ),
          and(
            isNotNull(oidcAuthorizationCodes.usedAt),
            lte(oidcAuthorizationCodes.usedAt, usedCodeRetentionCutoff),
          ),
        ),
      ),
    db
      .delete(oidcAccessTokens)
      .where(lte(oidcAccessTokens.expiresAt, now)),
    db
      .delete(oidcRefreshTokens)
      .where(lte(oidcRefreshTokens.expiresAt, now)),
  ]);
}

type OidcAuditInput = {
  eventType: string;
  actorUserId?: string | null;
  subjectUserId?: string | null;
  clientId?: string | null;
  detail?: Record<string, unknown>;
};

export function insertOidcAudit(db: Database, input: OidcAuditInput) {
  return db.insert(oidcAuditEvents).values({
    id: createId("evt"),
    eventType: input.eventType,
    actorUserId: input.actorUserId ?? null,
    subjectUserId: input.subjectUserId ?? null,
    clientId: input.clientId ?? null,
    detail: input.detail,
  });
}
