import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  consumeChallenge,
  deleteExpiredChallenges,
  recordPasskeyUse,
} from "../worker/auth/webauthn";
import { createDb } from "../worker/db/client";
import {
  authChallenges,
  passkeyCredentials,
  users,
} from "../worker/db/schema";

function challenge(id: string, expiresAt: Date) {
  return {
    id,
    challenge: `nonce-${id}`,
    kind: "authentication" as const,
    rpId: "example.test",
    origin: "https://example.test",
    expiresAt,
  };
}

describe("WebAuthn challenges", () => {
  it("returns independent bootstrap challenges without a shared cookie", async () => {
    const request = () => new Request(
      "http://example.test/api/auth/bootstrap/options",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Bootstrap Admin",
          email: "bootstrap@example.test",
        }),
      },
    );
    const responses = await Promise.all([
      exports.default.fetch(request()),
      exports.default.fetch(request()),
    ]);
    const bodies = await Promise.all(responses.map(async (response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      return response.json<{ ok: true; challengeId: string }>();
    }));
    expect(bodies[0].challengeId).not.toBe(bodies[1].challengeId);

    const db = createDb(env.DB);
    const rows = await db.select().from(authChallenges);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.kind).toBe("bootstrap");
      expect(row.userId).toBeNull();
      expect(row.payload).toMatchObject({
        name: "Bootstrap Admin",
        email: "bootstrap@example.test",
        userId: expect.stringMatching(/^usr_/),
      });
    }
  });

  it("atomically consumes and deletes a valid challenge", async () => {
    const db = createDb(env.DB);
    const id = "chl_delete_after_consume";
    await db.insert(authChallenges).values(challenge(id, new Date(Date.now() + 60_000)));

    const consumed = await consumeChallenge(db, id, "authentication");

    expect(consumed.id).toBe(id);
    expect(await db.select().from(authChallenges).where(eq(authChallenges.id, id))).toEqual([]);
    await expect(consumeChallenge(db, id, "authentication")).rejects.toThrow(
      "Passkey ceremony has expired",
    );
  });

  it("deletes an expired challenge when it is presented", async () => {
    const db = createDb(env.DB);
    const id = "chl_delete_after_expiry";
    await db.insert(authChallenges).values(challenge(id, new Date(Date.now() - 1_000)));

    await expect(consumeChallenge(db, id, "authentication")).rejects.toThrow(
      "Passkey ceremony has expired",
    );
    expect(await db.select().from(authChallenges).where(eq(authChallenges.id, id))).toEqual([]);
  });

  it("removes abandoned expired challenges during cleanup", async () => {
    const db = createDb(env.DB);
    const id = "chl_delete_during_cleanup";
    await db.insert(authChallenges).values(challenge(id, new Date(Date.now() - 1_000)));

    await deleteExpiredChallenges(db);

    expect(await db.select().from(authChallenges).where(eq(authChallenges.id, id))).toEqual([]);
  });

  it("never decreases a passkey counter when updates complete out of order", async () => {
    const db = createDb(env.DB);
    const userId = "usr_counter_race";
    const credentialId = "credential_counter_race";
    await db.insert(users).values({
      id: userId,
      name: "Counter Race",
      role: "member",
      status: "active",
    });
    await db.insert(passkeyCredentials).values({
      credentialId,
      userId,
      publicKey: "unused",
      counter: 1,
      deviceType: "singleDevice",
      backedUp: false,
    });

    await Promise.all([
      recordPasskeyUse(db, credentialId, 10),
      recordPasskeyUse(db, credentialId, 5),
    ]);

    const [credential] = await db.select({ counter: passkeyCredentials.counter })
      .from(passkeyCredentials)
      .where(eq(passkeyCredentials.credentialId, credentialId));
    expect(credential?.counter).toBe(10);
  });
});
