import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const issuer = "http://example.test";

describe("OIDC endpoint rate limiting", () => {
  it("limits failed client authentication before expensive token work", async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await exports.default.fetch(
        new Request(`${issuer}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: `unknown-${attempt}`,
          }),
        }),
      );
      expect(response.status).toBe(401);
      await response.body?.cancel();
    }

    const limited = await exports.default.fetch(
      new Request(`${issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "unknown-limited",
        }),
      }),
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(await limited.json()).toMatchObject({
      error: "temporarily_unavailable",
    });
  });
});
