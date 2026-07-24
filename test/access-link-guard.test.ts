import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../worker/db/client";
import { accessLinkClaims, accessLinks, users } from "../worker/db/schema";

describe("access-link claims", () => {
  it("rejects claims after revocation or expiry", async () => {
    const db = createDb(env.DB);
    const suffix = crypto.randomUUID();
    const userId = `usr_guard_${suffix}`;
    const now = new Date();
    await db.insert(users).values({
      id: userId,
      name: "Recovery guard",
      role: "member",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(accessLinks).values([
      {
        id: `lnk_consumed_${suffix}`,
        kind: "recovery",
        userId,
        tokenHash: `consumed_${suffix}`,
        createdByUserId: userId,
        expiresAt: new Date(now.getTime() + 60_000),
        consumedAt: now,
        createdAt: now,
      },
      {
        id: `lnk_expired_${suffix}`,
        kind: "recovery",
        userId,
        tokenHash: `expired_${suffix}`,
        createdByUserId: userId,
        expiresAt: new Date(now.getTime() - 1_000),
        createdAt: now,
      },
      {
        id: `lnk_active_${suffix}`,
        kind: "recovery",
        userId,
        tokenHash: `active_${suffix}`,
        createdByUserId: userId,
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
      },
    ]);

    for (const state of ["consumed", "expired"] as const) {
      await expect(db.insert(accessLinkClaims).values({
        accessLinkId: `lnk_${state}_${suffix}`,
        userId,
        credentialId: `credential_${state}_${suffix}`,
        claimedAt: now,
      })).rejects.toThrow();
      expect(await db
        .select()
        .from(accessLinkClaims)
        .where(eq(accessLinkClaims.accessLinkId, `lnk_${state}_${suffix}`)))
        .toEqual([]);
    }

    await expect(db.insert(accessLinkClaims).values({
      accessLinkId: `lnk_active_${suffix}`,
      userId,
      credentialId: `credential_active_${suffix}`,
      claimedAt: now,
    })).resolves.toBeDefined();
  });
});
