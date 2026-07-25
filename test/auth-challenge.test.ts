import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  consumeChallenge,
  deleteExpiredChallenges,
} from "../worker/auth/webauthn";
import { createDb } from "../worker/db/client";
import { authChallenges } from "../worker/db/schema";

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
  it("stores bootstrap challenges without a users FK row", async () => {
    const response = await exports.default.fetch(
      new Request("http://example.test/api/auth/bootstrap/options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Bootstrap Admin",
          email: "bootstrap@example.test",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: true };
    expect(body.ok).toBe(true);

    const db = createDb(env.DB);
    const rows = await db.select().from(authChallenges);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("bootstrap");
    expect(rows[0]?.userId).toBeNull();
    expect(rows[0]?.payload).toMatchObject({
      name: "Bootstrap Admin",
      email: "bootstrap@example.test",
      userId: expect.stringMatching(/^usr_/),
    });
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
});
