import { exports } from "cloudflare:workers";
import { importJWK, jwtVerify, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import { hashToken, randomToken } from "../worker/lib/crypto";

const issuer = "http://example.test";
const redirectUri = "https://app.example.test/callback";

async function json<T>(response: Response) {
  const body = await response.json<T>();
  expect(response.status, JSON.stringify(body)).toBeLessThan(400);
  return body;
}

describe("OIDC provider", () => {
  it("issues, filters, rotates, revokes, and discovers standards endpoints", async () => {
    const bootstrap = await exports.default.fetch(
      new Request(`${issuer}/api/auth/mock/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "OIDC Admin",
          email: "oidc-admin@example.test",
        }),
      }),
    );
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    await json(bootstrap);

    const adminState = await json<{
      users: Array<{ id: string; status: string }>;
    }>(
      await exports.default.fetch(
        new Request(`${issuer}/api/admin/state`, {
          headers: { cookie: cookie! },
        }),
      ),
    );
    const userId = adminState.users[0]!.id;

    const visibleGroup = await json<{ groupId: string }>(
      await exports.default.fetch(
        new Request(`${issuer}/api/admin/groups`, {
          method: "POST",
          headers: {
            cookie: cookie!,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Grafana administrators",
            slug: "grafana-admins",
            description: null,
            memberIds: [userId],
          }),
        }),
      ),
    );
    await json(
      await exports.default.fetch(
        new Request(`${issuer}/api/admin/groups`, {
          method: "POST",
          headers: {
            cookie: cookie!,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Finance",
            slug: "finance",
            description: null,
            memberIds: [userId],
          }),
        }),
      ),
    );

    const clientInput = {
      name: "Grafana",
      clientType: "confidential",
      accessPolicy: "selected_users",
      redirectUris: [redirectUri],
      postLogoutRedirectUris: ["https://app.example.test/logout"],
      allowedOrigins: [],
      allowedScopes: [
        "openid",
        "profile",
        "email",
        "groups",
        "offline_access",
      ],
      trusted: true,
      enabled: true,
      assignedUserIds: [userId],
      exposedGroupIds: [visibleGroup.groupId],
    };
    const registered = await json<{
      clientId: string;
      clientSecret: string;
    }>(
      await exports.default.fetch(
        new Request(`${issuer}/api/admin/oidc-clients`, {
          method: "POST",
          headers: {
            cookie: cookie!,
            "content-type": "application/json",
          },
          body: JSON.stringify(clientInput),
        }),
      ),
    );
    expect(registered.clientSecret).toMatch(/^owsec_/u);

    const discovery = await json<{
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      jwks_uri: string;
      code_challenge_methods_supported: string[];
    }>(
      await exports.default.fetch(
        `${issuer}/.well-known/openid-configuration`,
      ),
    );
    expect(discovery).toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
    });
    const jwks = await json<{ keys: JWK[] }>(
      await exports.default.fetch(discovery.jwks_uri),
    );
    expect(jwks.keys[0]).not.toHaveProperty("d");

    const verifier = randomToken(48);
    const authorize = new URL(discovery.authorization_endpoint);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", registered.clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set(
      "scope",
      "openid profile email groups offline_access",
    );
    authorize.searchParams.set("state", "state-value");
    authorize.searchParams.set("nonce", "nonce-value");
    authorize.searchParams.set("code_challenge", await hashToken(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    const unregisteredRedirect = new URL(authorize);
    unregisteredRedirect.searchParams.set(
      "redirect_uri",
      "https://evil.example.test/callback",
    );
    const rejectedRedirect = await exports.default.fetch(
      new Request(unregisteredRedirect, {
        headers: { cookie: cookie! },
        redirect: "manual",
      }),
    );
    expect(rejectedRedirect.status).toBe(400);
    expect(rejectedRedirect.headers.get("location")).toBeNull();

    const authorization = await exports.default.fetch(
      new Request(authorize, {
        headers: { cookie: cookie! },
        redirect: "manual",
      }),
    );
    expect(authorization.status).toBe(302);
    const callback = new URL(authorization.headers.get("location")!);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("state-value");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    const invalidClient = await exports.default.fetch(
      new Request(discovery.token_endpoint, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${registered.clientId}:wrong-secret`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: tokenBody,
      }),
    );
    expect(invalidClient.status).toBe(401);
    const invalidVerifier = await exports.default.fetch(
      new Request(discovery.token_endpoint, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          ...Object.fromEntries(tokenBody),
          code_verifier: randomToken(48),
        }),
      }),
    );
    expect(invalidVerifier.status).toBe(400);
    expect(await invalidVerifier.json()).toMatchObject({
      error: "invalid_grant",
    });
    const token = await json<{
      access_token: string;
      refresh_token: string;
      id_token: string;
      token_type: string;
    }>(
      await exports.default.fetch(
        new Request(discovery.token_endpoint, {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: tokenBody,
        }),
      ),
    );
    expect(token.token_type).toBe("Bearer");
    const signingKey = await importJWK(jwks.keys[0]!, "RS256");
    const verified = await jwtVerify(token.id_token, signingKey, {
      issuer,
      audience: registered.clientId,
    });
    expect(verified.payload).toMatchObject({
      sub: userId,
      nonce: "nonce-value",
      email: "oidc-admin@example.test",
      email_verified: true,
      groups: ["grafana-admins"],
    });
    expect(verified.payload.groups).not.toContain("finance");

    const userinfo = await json<{
      sub: string;
      groups: string[];
    }>(
      await exports.default.fetch(
        new Request(`${issuer}/oauth/userinfo`, {
          headers: { authorization: `Bearer ${token.access_token}` },
        }),
      ),
    );
    expect(userinfo).toMatchObject({
      sub: userId,
      groups: ["grafana-admins"],
    });

    await json(
      await exports.default.fetch(
        new Request(
          `${issuer}/api/admin/groups/${visibleGroup.groupId}`,
          {
            method: "PATCH",
            headers: {
              cookie: cookie!,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              name: "Grafana administrators",
              slug: "grafana-admins",
              description: null,
              memberIds: [],
            }),
          },
        ),
      ),
    );
    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    });
    const rotated = await json<{
      access_token: string;
      refresh_token: string;
      id_token: string;
    }>(
      await exports.default.fetch(
        new Request(discovery.token_endpoint, {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: refreshBody,
        }),
      ),
    );
    expect(
      (
        await jwtVerify(rotated.id_token, signingKey, {
          issuer,
          audience: registered.clientId,
        })
      ).payload.groups,
    ).toEqual([]);
    const reused = await exports.default.fetch(
      new Request(discovery.token_endpoint, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: refreshBody,
      }),
    );
    expect(reused.status).toBe(400);
    expect(
      (
        await exports.default.fetch(
          new Request(`${issuer}/oauth/userinfo`, {
            headers: { authorization: `Bearer ${rotated.access_token}` },
          }),
        )
      ).status,
    ).toBe(401);
    const familyRevoked = await exports.default.fetch(
      new Request(discovery.token_endpoint, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: rotated.refresh_token,
        }),
      }),
    );
    expect(familyRevoked.status).toBe(400);

    const reuseVerifier = randomToken(48);
    const reuseAuthorize = new URL(authorize);
    reuseAuthorize.searchParams.set("code_challenge", await hashToken(reuseVerifier));
    const reuseAuthorization = await exports.default.fetch(
      new Request(reuseAuthorize, {
        headers: { cookie: cookie! },
        redirect: "manual",
      }),
    );
    expect(reuseAuthorization.status).toBe(302);
    const reuseCode = new URL(reuseAuthorization.headers.get("location")!)
      .searchParams.get("code")!;
    const reuseTokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code: reuseCode,
      redirect_uri: redirectUri,
      code_verifier: reuseVerifier,
    });
    const reuseTokens = await json<{
      access_token: string;
      refresh_token: string;
    }>(
      await exports.default.fetch(
        new Request(discovery.token_endpoint, {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: reuseTokenBody,
        }),
      ),
    );
    expect(
      (
        await exports.default.fetch(
          new Request(`${issuer}/oauth/userinfo`, {
            headers: { authorization: `Bearer ${reuseTokens.access_token}` },
          }),
        )
      ).status,
    ).toBe(200);
    const codeReplay = await exports.default.fetch(
      new Request(discovery.token_endpoint, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: reuseTokenBody,
      }),
    );
    expect(codeReplay.status).toBe(400);
    expect(await codeReplay.json()).toMatchObject({ error: "invalid_grant" });
    expect(
      (
        await exports.default.fetch(
          new Request(`${issuer}/oauth/userinfo`, {
            headers: { authorization: `Bearer ${reuseTokens.access_token}` },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await exports.default.fetch(
          new Request(discovery.token_endpoint, {
            method: "POST",
            headers: {
              authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: reuseTokens.refresh_token,
            }),
          }),
        )
      ).status,
    ).toBe(400);

    const revokeVerifier = randomToken(48);
    const revokeAuthorize = new URL(authorize);
    revokeAuthorize.searchParams.set(
      "code_challenge",
      await hashToken(revokeVerifier),
    );
    const revokeAuthorization = await exports.default.fetch(
      new Request(revokeAuthorize, {
        headers: { cookie: cookie! },
        redirect: "manual",
      }),
    );
    const revokeCode = new URL(revokeAuthorization.headers.get("location")!)
      .searchParams.get("code")!;
    const revokeTokens = await json<{ access_token: string }>(
      await exports.default.fetch(
        new Request(discovery.token_endpoint, {
          method: "POST",
          headers: {
            authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: revokeCode,
            redirect_uri: redirectUri,
            code_verifier: revokeVerifier,
          }),
        }),
      ),
    );
    const revocation = await exports.default.fetch(
      new Request(`${issuer}/oauth/revoke`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${registered.clientId}:${registered.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: revokeTokens.access_token }),
      }),
    );
    expect(revocation.status).toBe(200);
    expect(
      (
        await exports.default.fetch(
          new Request(`${issuer}/oauth/userinfo`, {
            headers: { authorization: `Bearer ${revokeTokens.access_token}` },
          }),
        )
      ).status,
    ).toBe(401);

    await json(
      await exports.default.fetch(
        new Request(
          `${issuer}/api/admin/oidc-clients/${registered.clientId}`,
          {
            method: "PATCH",
            headers: {
              cookie: cookie!,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              ...clientInput,
              assignedUserIds: [],
            }),
          },
        ),
      ),
    );
    const denied = await exports.default.fetch(
      new Request(authorize, {
        headers: { cookie: cookie! },
        redirect: "manual",
      }),
    );
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.get("location")!).searchParams.get("error"))
      .toBe("access_denied");

    const logout = new URL(`${issuer}/oauth/logout`);
    logout.searchParams.set("client_id", registered.clientId);
    logout.searchParams.set("id_token_hint", "not-a-jwt");
    logout.searchParams.set(
      "post_logout_redirect_uri",
      "https://evil.example.test/logout",
    );
    const logoutChallenge = await exports.default.fetch(
      new Request(logout, {
        headers: { cookie: cookie! },
        redirect: "manual",
      }),
    );
    expect(logoutChallenge.status).toBe(302);
    const confirmLocation = new URL(logoutChallenge.headers.get("location")!);
    expect(confirmLocation.pathname).toBe("/oidc/logout");
    expect(confirmLocation.searchParams.get("client_id")).toBe(
      registered.clientId,
    );
    expect(
      await json<{ authenticated: boolean }>(
        await exports.default.fetch(
          new Request(`${issuer}/api/auth/state`, {
            headers: { cookie: cookie! },
          }),
        ),
      ),
    ).toMatchObject({ authenticated: true });

    const confirmed = await exports.default.fetch(
      new Request(`${issuer}/api/oidc/logout`, {
        method: "POST",
        headers: {
          cookie: cookie!,
          "content-type": "application/json",
          origin: issuer,
        },
        body: JSON.stringify({
          client_id: registered.clientId,
          id_token_hint: "not-a-jwt",
          post_logout_redirect_uri: "https://evil.example.test/logout",
        }),
      }),
    );
    const confirmedBody = await json<{ redirectTo: string }>(confirmed);
    expect(confirmedBody.redirectTo).toBe(`${issuer}/`);
    expect(confirmed.headers.get("set-cookie")).toContain("op_session=");
    const cleared = confirmed.headers.get("set-cookie")?.split(";", 1)[0];
    expect(
      await json<{ authenticated: boolean }>(
        await exports.default.fetch(
          new Request(`${issuer}/api/auth/state`, {
            headers: { cookie: cleared ?? cookie! },
          }),
        ),
      ),
    ).toMatchObject({ authenticated: false });
  });

});
