import { describe, expect, it } from "vitest";
import {
  isAllowedOidcRedirectUri,
  normalizeAllowedOidcOrigin,
} from "../worker/oidc/validation";

describe("OIDC URL validation", () => {
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
});
