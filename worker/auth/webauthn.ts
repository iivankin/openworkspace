import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { AccessLinkKind } from "../../shared/auth";
import { and, eq, gt, lte } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Database } from "../db/client";
import { authChallenges, passkeyCredentials, users } from "../db/schema";
import type { AppEnv } from "../env";
import { base64UrlToBytes, bytesToBase64Url } from "../lib/crypto";
import { createId } from "../lib/ids";
import { getRelyingParty } from "../lib/http";
import { CHALLENGE_COOKIE, CHALLENGE_TTL_MS } from "./constants";

type ChallengeKind =
  | "bootstrap"
  | AccessLinkKind
  | "authentication";

type ChallengePayload = Record<string, unknown>;

function challengeCookieOptions(request: Request, expires?: Date) {
  return {
    httpOnly: true,
    sameSite: "Strict" as const,
    secure: new URL(request.url).protocol === "https:",
    path: "/api/auth",
    expires,
  };
}

export function setChallengeCookie(
  c: Context<AppEnv>,
  challengeId: string,
  expiresAt: Date,
) {
  setCookie(
    c,
    CHALLENGE_COOKIE,
    challengeId,
    challengeCookieOptions(c.req.raw, expiresAt),
  );
}

export function clearChallengeCookie(c: Context<AppEnv>) {
  deleteCookie(
    c,
    CHALLENGE_COOKIE,
    challengeCookieOptions(c.req.raw),
  );
}

export function getChallengeId(c: Context<AppEnv>) {
  return getCookie(c, CHALLENGE_COOKIE);
}

export function deleteExpiredChallenges(db: Database, now = new Date()) {
  return db.delete(authChallenges).where(lte(authChallenges.expiresAt, now));
}

async function saveChallenge(
  db: Database,
  request: Request,
  input: {
    challenge: string;
    kind: ChallengeKind;
    userId?: string;
    accessLinkId?: string;
    payload?: ChallengePayload;
  },
) {
  const id = createId("chl");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  const { origin, rpId } = getRelyingParty(request);
  await deleteExpiredChallenges(db, now);
  await db.insert(authChallenges).values({
    id,
    challenge: input.challenge,
    kind: input.kind,
    // Bootstrap allocates a user id before the users row exists; D1 enforces the
    // FK, so keep the column null and carry the id in payload instead.
    userId: input.kind === "bootstrap" ? undefined : input.userId,
    accessLinkId: input.accessLinkId,
    payload: input.payload,
    rpId,
    origin,
    expiresAt,
  });
  return { id, expiresAt, origin, rpId };
}

export async function consumeChallenge(
  db: Database,
  challengeId: string | undefined,
  kind: ChallengeKind,
) {
  if (!challengeId) throw new Error("Passkey ceremony has expired");
  const [challenge] = await db
    .delete(authChallenges)
    .where(
      and(
        eq(authChallenges.id, challengeId),
        eq(authChallenges.kind, kind),
        gt(authChallenges.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!challenge) {
    // An expired or wrong-kind cookie cannot be reused and does not need to
    // remain in D1 after the failed ceremony.
    await db.delete(authChallenges).where(eq(authChallenges.id, challengeId));
    throw new Error("Passkey ceremony has expired");
  }
  return challenge;
}

export async function beginRegistration(
  db: Database,
  request: Request,
  input: {
    kind: "bootstrap" | AccessLinkKind;
    userId: string;
    userName: string;
    userDisplayName: string;
    accessLinkId?: string;
    payload?: ChallengePayload;
  },
) {
  const { rpId } = getRelyingParty(request);
  const existing = await db
    .select({
      id: passkeyCredentials.credentialId,
      transports: passkeyCredentials.transports,
    })
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.userId, input.userId));

  const options = await generateRegistrationOptions({
    rpName: "OpenWorkspace",
    rpID: rpId,
    userID: new TextEncoder().encode(input.userId),
    userName: input.userName,
    userDisplayName: input.userDisplayName,
    attestationType: "none",
    supportedAlgorithmIDs: [-7, -257],
    excludeCredentials: existing.map((credential) => ({
      id: credential.id,
      transports: credential.transports as
        | AuthenticatorTransportFuture[]
        | undefined,
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });
  const saved = await saveChallenge(db, request, {
    challenge: options.challenge,
    kind: input.kind,
    userId: input.userId,
    accessLinkId: input.accessLinkId,
    payload: input.payload,
  });
  return { options, challenge: saved };
}

export async function finishRegistration(
  challenge: typeof authChallenges.$inferSelect,
  response: RegistrationResponseJSON,
) {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: challenge.origin,
    expectedRPID: challenge.rpId,
    requireUserVerification: true,
    supportedAlgorithmIDs: [-7, -257],
  });
  if (!verification.verified) throw new Error("Passkey could not be verified");

  const { credential } = verification.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: bytesToBase64Url(credential.publicKey),
    counter: credential.counter,
    transports:
      credential.transports ?? response.response.transports ?? undefined,
    deviceType: verification.registrationInfo.credentialDeviceType,
    backedUp: verification.registrationInfo.credentialBackedUp,
  };
}

export async function beginAuthentication(
  db: Database,
  request: Request,
  payload?: ChallengePayload,
) {
  const { rpId } = getRelyingParty(request);
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    userVerification: "required",
  });
  const saved = await saveChallenge(db, request, {
    challenge: options.challenge,
    kind: "authentication",
    payload,
  });
  return { options, challenge: saved };
}

export async function finishAuthentication(
  db: Database,
  challenge: typeof authChallenges.$inferSelect,
  response: AuthenticationResponseJSON,
) {
  const [stored] = await db
    .select({
      credentialId: passkeyCredentials.credentialId,
      userId: passkeyCredentials.userId,
      publicKey: passkeyCredentials.publicKey,
      counter: passkeyCredentials.counter,
      transports: passkeyCredentials.transports,
    })
    .from(passkeyCredentials)
    .innerJoin(users, eq(passkeyCredentials.userId, users.id))
    .where(
      and(
        eq(passkeyCredentials.credentialId, response.id),
        eq(users.status, "active"),
      ),
    )
    .limit(1);
  if (!stored) {
    throw new Error("This passkey is unavailable or the account is disabled");
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: challenge.origin,
    expectedRPID: challenge.rpId,
    requireUserVerification: true,
    credential: {
      id: stored.credentialId,
      publicKey: new Uint8Array(base64UrlToBytes(stored.publicKey)),
      counter: stored.counter,
      transports: stored.transports as
        | AuthenticatorTransportFuture[]
        | undefined,
    },
  });
  if (!verification.verified) throw new Error("Passkey could not be verified");

  await db
    .update(passkeyCredentials)
    .set({
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: new Date(),
    })
    .where(eq(passkeyCredentials.credentialId, stored.credentialId));
  return stored.userId;
}
