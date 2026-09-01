import { generateKeyPairSync } from "node:crypto";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { oidcIssuer, publicJwks } from "../worker/oidc/keys";
import {
  isAllowedOidcRedirectUri,
  normalizeAllowedOidcOrigin,
} from "../worker/oidc/validation";

describe("OIDC URL validation", () => {
  it("only permits HTTP as the mock issuer protocol", () => {
    expect(oidcIssuer({
      IDENTITY_PROVIDER_ORIGIN: "http://idp.example.test",
      ALLOW_MOCK_AUTH: "true",
    })).toBe("http://idp.example.test");
    expect(() => oidcIssuer({
      IDENTITY_PROVIDER_ORIGIN: "ftp://idp.example.test",
      ALLOW_MOCK_AUTH: "true",
    })).toThrow(/Identity provider origin/u);
  });

  it("only permits HTTPS and HTTP loopback URLs", () => {
    expect(isAllowedOidcRedirectUri("https://app.example.test/callback")).toBe(
      true,
    );
    expect(isAllowedOidcRedirectUri("http://127.0.0.1:4321/callback")).toBe(
      true,
    );
    expect(isAllowedOidcRedirectUri("http://[::1]:4321/callback")).toBe(true);
    expect(isAllowedOidcRedirectUri("ftp://localhost/callback")).toBe(false);
    expect(isAllowedOidcRedirectUri("javascript://localhost/callback")).toBe(
      false,
    );
    expect(isAllowedOidcRedirectUri("https://app.example.test/callback#code"))
      .toBe(false);
  });

  it("normalizes safe browser origins without accepting null origins", () => {
    expect(normalizeAllowedOidcOrigin("https://APP.example.test")).toBe(
      "https://app.example.test",
    );
    expect(normalizeAllowedOidcOrigin("http://localhost:5173")).toBe(
      "http://localhost:5173",
    );
    expect(normalizeAllowedOidcOrigin("custom://localhost")).toBeNull();
    expect(normalizeAllowedOidcOrigin("https://user@example.test")).toBeNull();
  });

  it("rejects OIDC RSA signing keys smaller than 2048 bits", async () => {
    const privateJwk = generateKeyPairSync("rsa", {
      modulusLength: 1_024,
    }).privateKey.export({ format: "jwk" });

    await expect(publicJwks({
      ...env,
      OIDC_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
    })).rejects.toThrow(/at least 2048 bits/u);
  });

  it("rejects previous OIDC RSA keys smaller than 2048 bits", async () => {
    const publicJwk = generateKeyPairSync("rsa", {
      modulusLength: 1_024,
    }).publicKey.export({ format: "jwk" });

    await expect(publicJwks({
      ...env,
      OIDC_PREVIOUS_PUBLIC_JWKS: JSON.stringify({ keys: [publicJwk] }),
    })).rejects.toThrow(/at least 2048 bits/u);
  });
});
