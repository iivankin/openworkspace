import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashToken, randomToken } from "../worker/lib/crypto";

const issuer = "http://example.test";

async function body<T>(response: Response) {
  const value = await response.json<T>();
  expect(response.status, JSON.stringify(value)).toBeLessThan(400);
  return value;
}

describe("OIDC user lifecycle", () => {
  it("revokes browser and OIDC access when an admin disables a user", async () => {
    const bootstrap = await exports.default.fetch(
      new Request(`${issuer}/api/auth/mock/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Lifecycle Admin",
          email: "lifecycle-admin@example.test",
        }),
      }),
    );
    const adminCookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0]!;
    await body(bootstrap);
    const invitation = await body<{ accessLink: { userId: string } }>(
      await exports.default.fetch(
        new Request(`${issuer}/api/admin/invitations`, {
          method: "POST",
          headers: {
            cookie: adminCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Lifecycle User",
            email: "lifecycle-user@example.test",
          }),
        }),
      ),
    );
    const userId = invitation.accessLink.userId;
    await env.DB.prepare(
      "UPDATE users SET status = 'active' WHERE id = ?",
    ).bind(userId).run();
    const login = await exports.default.fetch(
      new Request(`${issuer}/api/auth/mock/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      }),
    );
    const userCookie = login.headers.get("set-cookie")?.split(";", 1)[0]!;
    await body(login);

    const client = await body<{ clientId: string }>(
      await exports.default.fetch(
        new Request(`${issuer}/api/admin/oidc-clients`, {
          method: "POST",
          headers: {
            cookie: adminCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Lifecycle app",
            clientType: "public",
            accessPolicy: "selected_users",
            redirectUris: ["https://lifecycle.example.test/callback"],
            postLogoutRedirectUris: [],
            allowedOrigins: [],
            allowedScopes: ["openid", "email"],
            trusted: true,
            enabled: true,
            assignedUserIds: [userId],
            exposedGroupIds: [],
          }),
        }),
      ),
    );
    const verifier = randomToken(48);
    const authorize = new URL(`${issuer}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: "https://lifecycle.example.test/callback",
      scope: "openid email",
      code_challenge: await hashToken(verifier),
      code_challenge_method: "S256",
    }).toString();
    const authorization = await exports.default.fetch(
      new Request(authorize, {
        headers: { cookie: userCookie },
        redirect: "manual",
      }),
    );
    const code = new URL(
      authorization.headers.get("location")!,
    ).searchParams.get("code")!;
    const tokens = await body<{ access_token: string }>(
      await exports.default.fetch(
        new Request(`${issuer}/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: client.clientId,
            code,
            redirect_uri: "https://lifecycle.example.test/callback",
            code_verifier: verifier,
          }),
        }),
      ),
    );
    const recovery = await body<{ accessLink: { url: string } }>(
      await exports.default.fetch(
        new Request(`${issuer}/api/admin/users/${userId}/access-link`, {
          method: "POST",
          headers: { cookie: adminCookie },
        }),
      ),
    );

    await body(
      await exports.default.fetch(
        new Request(`${issuer}/api/admin/users/${userId}`, {
          method: "PATCH",
          headers: {
            cookie: adminCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Lifecycle User",
            status: "disabled",
          }),
        }),
      ),
    );

    const authState = await body<{ authenticated: boolean }>(
      await exports.default.fetch(
        new Request(`${issuer}/api/auth/state`, {
          headers: { cookie: userCookie },
        }),
      ),
    );
    expect(authState.authenticated).toBe(false);
    const userinfo = await exports.default.fetch(
      new Request(`${issuer}/oauth/userinfo`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      }),
    );
    expect(userinfo.status).toBe(401);
    const recoveryPreview = await exports.default.fetch(
      new URL(recovery.accessLink.url).pathname.replace(
        "/recover/",
        `${issuer}/api/auth/recovery/`,
      ),
    );
    expect(recoveryPreview.status).toBe(404);
    const disabledRecovery = await exports.default.fetch(
      new Request(`${issuer}/api/admin/users/${userId}/access-link`, {
        method: "POST",
        headers: { cookie: adminCookie },
      }),
    );
    expect(disabledRecovery.status).toBe(400);
    const silent = new URL(authorize);
    silent.searchParams.set("prompt", "none");
    const denied = await exports.default.fetch(
      new Request(silent, {
        headers: { cookie: userCookie },
        redirect: "manual",
      }),
    );
    expect(
      new URL(denied.headers.get("location")!).searchParams.get("error"),
    ).toBe("login_required");
  });
});
