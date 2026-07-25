import { env } from "cloudflare:workers";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../worker/env";
import {
  claimsFromIdTokenHint,
  publicJwks,
} from "../worker/oidc/keys";

describe("OIDC signing key rotation", () => {
  it("publishes retained public keys without private material", async () => {
    const { publicKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const previous = {
      ...await exportJWK(publicKey),
      alg: "RS256",
      use: "sig",
      kid: "previous-key",
    };
    const bindings = {
      ...env,
      OIDC_PREVIOUS_PUBLIC_JWKS: JSON.stringify({ keys: [previous] }),
    } as AppEnv["Bindings"];
    const jwks = await publicJwks(bindings);

    expect(jwks.keys).toHaveLength(2);
    expect(jwks.keys.map((key) => key.kid)).toContain("previous-key");
    expect(jwks.keys.every((key) => !key.d)).toBe(true);
  });

  it("accepts an expired logout hint signed by a retained key", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const previous = {
      ...await exportJWK(publicKey),
      alg: "RS256",
      use: "sig",
      kid: "retained-key",
    };
    const bindings = {
      ...env,
      OIDC_PREVIOUS_PUBLIC_JWKS: JSON.stringify({ keys: [previous] }),
    } as AppEnv["Bindings"];
    const now = Math.floor(Date.now() / 1_000);
    const hint = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: previous.kid })
      .setIssuer("http://example.test")
      .setSubject("usr_logout")
      .setAudience("cli_logout")
      .setIssuedAt(now - 600)
      .setExpirationTime(now - 300)
      .sign(privateKey);

    await expect(claimsFromIdTokenHint(bindings, hint)).resolves.toEqual({
      clientId: "cli_logout",
      subject: "usr_logout",
    });
  });
});
