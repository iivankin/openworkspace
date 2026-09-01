import { Buffer } from "node:buffer";
import { sign, X509Certificate } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import { env, exports } from "cloudflare:workers";
import { SignedXml } from "xml-crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  SAML_AUTHN_CONTEXT_UNSPECIFIED,
  SAML_BINDINGS,
  SAML_NAMESPACES,
  samlNameIdFormatUris,
} from "../shared/saml";
import { samlConfiguration } from "../worker/saml/configuration";
import { samlMetadata } from "../worker/saml/metadata";

const origin = "http://example.test";

async function successfulJson<T>(response: Response) {
  const body = await response.json<T>();
  expect(response.status, JSON.stringify(body)).toBeLessThan(400);
  return body;
}

function sessionCookie(response: Response) {
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

function responseCookie(response: Response, name: string) {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  return values
    .map((value) => value.split(";", 1)[0]!)
    .find((value) => value.startsWith(`${name}=`));
}

function samlTransactionCookieName(requestId: string) {
  return `op_saml_${requestId}`;
}

function samlResponseXml(html: string) {
  const encoded = html.match(/name="SAMLResponse" value="([^"]+)"/u)?.[1];
  expect(encoded).toBeTruthy();
  return Buffer.from(encoded!, "base64").toString("utf8");
}

function samlNameId(xml: string) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  return document
    .getElementsByTagNameNS(SAML_NAMESPACES.assertion, "NameID")
    .item(0)
    ?.textContent;
}

function expectValidSignature(xml: string, localName: "Response" | "Assertion") {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const root = document.documentElement;
  if (!root) throw new Error("SAML response has no document element");
  const signedElement = localName === "Response"
    ? root
    : root.getElementsByTagNameNS(SAML_NAMESPACES.assertion, "Assertion").item(0);
  expect(signedElement).toBeTruthy();
  const signature = Array.from(signedElement!.childNodes).find((node) =>
    node.nodeType === 1
    && node.namespaceURI === SAML_NAMESPACES.signature
    && node.localName === "Signature"
  );
  expect(signature).toBeTruthy();
  const verifier = new SignedXml({
    publicCert: env.SAML_SIGNING_CERTIFICATE,
    getCertFromKeyInfo: () => null,
  });
  verifier.loadSignature(signature as unknown as Node);
  expect(verifier.checkSignature(xml)).toBe(true);
  expect(verifier.getSignedReferences()).toHaveLength(1);
}

function authnRequest(input: {
  id: string;
  issuer: string;
  acsUrl: string;
  destination?: string | null;
  forceAuthn?: boolean;
  isPassive?: boolean;
  nameIdPolicy?: {
    format?: string;
    allowCreate?: boolean;
    spNameQualifier?: string;
  };
  requestedAuthnContext?: {
    comparison?: "exact" | "minimum" | "maximum" | "better";
    classRefs: string[];
  };
}) {
  const destination = input.destination === null
    ? ""
    : ` Destination="${input.destination ?? `${origin}/saml/sso`}"`;
  const forceAuthn = input.forceAuthn === undefined
    ? ""
    : ` ForceAuthn="${input.forceAuthn}"`;
  const isPassive = input.isPassive === undefined
    ? ""
    : ` IsPassive="${input.isPassive}"`;
  const nameIdPolicy = input.nameIdPolicy
    ? `<samlp:NameIDPolicy${input.nameIdPolicy.format ? ` Format="${input.nameIdPolicy.format}"` : ""}${input.nameIdPolicy.allowCreate === undefined ? "" : ` AllowCreate="${input.nameIdPolicy.allowCreate}"`}${input.nameIdPolicy.spNameQualifier ? ` SPNameQualifier="${input.nameIdPolicy.spNameQualifier}"` : ""}/>`
    : "";
  const requestedAuthnContext = input.requestedAuthnContext
    ? `<samlp:RequestedAuthnContext Comparison="${input.requestedAuthnContext.comparison ?? "exact"}">${input.requestedAuthnContext.classRefs.map((reference) => `<saml:AuthnContextClassRef>${reference}</saml:AuthnContextClassRef>`).join("")}</samlp:RequestedAuthnContext>`
    : "";
  const xml = `<samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.protocol}" xmlns:saml="${SAML_NAMESPACES.assertion}" ID="${input.id}" Version="2.0" IssueInstant="${new Date().toISOString()}"${destination}${forceAuthn}${isPassive} AssertionConsumerServiceURL="${input.acsUrl}" ProtocolBinding="${SAML_BINDINGS.post}"><saml:Issuer>${input.issuer}</saml:Issuer>${nameIdPolicy}${requestedAuthnContext}</samlp:AuthnRequest>`;
  return deflateRawSync(Buffer.from(xml, "utf8")).toString("base64");
}

async function samlFixture(suffix: string) {
  const email = `saml-${suffix}@example.test`;
  const bootstrap = await exports.default.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "SAML Admin",
        email,
      }),
    }),
  );
  const cookie = sessionCookie(bootstrap);
  await successfulJson(bootstrap);
  const state = await successfulJson<{
    users: Array<{ id: string }>;
    samlProvider: { configured: boolean; entityId: string };
  }>(
    await exports.default.fetch(
      new Request(`${origin}/api/admin/state`, { headers: { cookie } }),
    ),
  );
  const userId = state.users[0]!.id;
  const groupSlug = `engineering-${suffix}`;
  const group = await successfulJson<{ groupId: string }>(
    await exports.default.fetch(
      new Request(`${origin}/api/admin/groups`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Engineering",
          slug: groupSlug,
          description: null,
          memberIds: [userId],
        }),
      }),
    ),
  );
  const entityId = `https://${suffix}.service.example.test/saml/metadata`;
  const acsUrl = `https://${suffix}.service.example.test/saml/acs`;
  const applicationInput = {
    name: "Example service",
    entityId,
    acsUrl,
    nameIdFormat: "email",
    accessPolicy: "selected_users",
    emailAttributeName: "email",
    nameAttributeName: "name",
    groupsAttributeName: "groups",
    signResponse: true,
    requireSignedAuthnRequests: false,
    spSigningCertificate: null,
    allowIdpInitiated: true,
    enabled: true,
    assignedUserIds: [userId],
    exposedGroupIds: [group.groupId],
  } as const;
  const application = await successfulJson<{ applicationId: string }>(
    await exports.default.fetch(
      new Request(`${origin}/api/admin/saml-applications`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(applicationInput),
      }),
    ),
  );

  return {
    cookie,
    state,
    userId,
    email,
    groupSlug,
    entityId,
    acsUrl,
    applicationInput,
    application,
  };
}

describe("SAML identity provider", () => {
  let fixture!: Awaited<ReturnType<typeof samlFixture>>;

  beforeAll(async () => {
    fixture = await samlFixture("suite");
  });

  it("publishes metadata and issues signed SP- and IdP-initiated assertions", async () => {
    const {
      cookie,
      state,
      userId,
      email,
      groupSlug,
      entityId,
      acsUrl,
      application,
    } = fixture;
    expect(state.samlProvider).toMatchObject({
      configured: true,
      entityId: `${origin}/saml/metadata`,
    });

    const metadata = await exports.default.fetch(`${origin}/saml/metadata`);
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("content-type")).toContain(
      "application/samlmetadata+xml",
    );
    const metadataXml = await metadata.text();
    expect(metadataXml).toContain(`entityID="${origin}/saml/metadata"`);
    expect(metadataXml).toContain("X509Certificate");
    const adminState = await successfulJson<{
      samlApplications: Array<Record<string, unknown> & { id: string }>;
    }>(
      await exports.default.fetch(
        new Request(`${origin}/api/admin/state`, { headers: { cookie } }),
      ),
    );
    const applicationSummary = adminState.samlApplications.find(
      (candidate) => candidate.id === application.applicationId,
    );
    expect(applicationSummary).toBeTruthy();
    expect(applicationSummary).not.toHaveProperty("spSigningCertificate");
    expect(
      await successfulJson<{ spSigningCertificate: string | null }>(
        await exports.default.fetch(
          new Request(
            `${origin}/api/admin/saml-applications/${application.applicationId}`,
            { headers: { cookie } },
          ),
        ),
      ),
    ).toMatchObject({ spSigningCertificate: null });

    const requestId = "_request_123";
    const ssoUrl = new URL(`${origin}/saml/sso`);
    ssoUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({ id: requestId, issuer: entityId, acsUrl }),
    );
    ssoUrl.searchParams.set("RelayState", "return-to-dashboard");
    const sso = await exports.default.fetch(
      new Request(ssoUrl, { headers: { cookie }, redirect: "manual" }),
    );
    const html = await sso.text();
    expect(sso.status, html).toBe(200);
    expect(html).toContain(`action="${acsUrl}"`);
    expect(html).toContain('name="RelayState" value="return-to-dashboard"');
    const xml = samlResponseXml(html);
    expect(xml).toContain(`InResponseTo="${requestId}"`);
    expect(xml).toContain(`>${email}</saml:NameID>`);
    expect(xml).toContain(`<saml:AttributeValue>${groupSlug}</saml:AttributeValue>`);
    expectValidSignature(xml, "Response");
    expectValidSignature(xml, "Assertion");

    const signedOutRequestId = "_request_signed_out";
    const signedOutUrl = new URL(`${origin}/saml/sso`);
    signedOutUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({ id: signedOutRequestId, issuer: entityId, acsUrl }),
    );
    const signedOut = await exports.default.fetch(
      new Request(signedOutUrl, { redirect: "manual" }),
    );
    expect(signedOut.status).toBe(302);
    const loginLocation = signedOut.headers.get("location")!;
    expect(loginLocation).toMatch(/^\/saml\/login\/samlreq_/u);
    const transactionId = loginLocation.split("/").at(-1)!;
    const transactionCookie = responseCookie(
      signedOut,
      samlTransactionCookieName(transactionId),
    );
    expect(transactionCookie).toBeTruthy();
    const parallelUrl = new URL(`${origin}/saml/sso`);
    parallelUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_request_parallel_signed_out",
        issuer: entityId,
        acsUrl,
      }),
    );
    const parallel = await exports.default.fetch(
      new Request(parallelUrl, { redirect: "manual" }),
    );
    const parallelLocation = parallel.headers.get("location")!;
    const parallelTransactionId = parallelLocation.split("/").at(-1)!;
    const parallelTransactionCookie = responseCookie(
      parallel,
      samlTransactionCookieName(parallelTransactionId),
    );
    expect(parallelTransactionCookie).toBeTruthy();
    expect(parallelTransactionCookie).not.toBe(transactionCookie);
    const transactionCookies =
      `${transactionCookie}; ${parallelTransactionCookie}`;
    const loginPreview = await successfulJson<{
      transaction: { applicationName: string };
    }>(
      await exports.default.fetch(
        new Request(`${origin}/api/saml/login/${transactionId}`, {
          headers: { cookie: transactionCookies },
        }),
      ),
    );
    expect(loginPreview.transaction.applicationName).toBe("Example service");
    const parallelPreview = await successfulJson<{
      transaction: { applicationName: string };
    }>(
      await exports.default.fetch(
        new Request(`${origin}/api/saml/login/${parallelTransactionId}`, {
          headers: { cookie: transactionCookies },
        }),
      ),
    );
    expect(parallelPreview.transaction.applicationName).toBe("Example service");
    const login = await exports.default.fetch(
      new Request(`${origin}/api/auth/mock/login`, {
        method: "POST",
        headers: {
          cookie: transactionCookies,
          "content-type": "application/json",
        },
        body: JSON.stringify({ userId, samlRequestId: transactionId }),
      }),
    );
    const completed = await successfulJson<{ redirectTo: string }>(login);
    expect(completed.redirectTo).toBe(`/saml/resume/${transactionId}`);
    const resumedSession = responseCookie(login, "op_session");
    expect(resumedSession).toBeTruthy();
    const resumed = await exports.default.fetch(
      new Request(new URL(completed.redirectTo, origin), {
        headers: { cookie: resumedSession! },
      }),
    );
    expect(resumed.status).toBe(200);
    const resumedXml = samlResponseXml(await resumed.text());
    expect(resumedXml).toContain(`InResponseTo="${signedOutRequestId}"`);
    expectValidSignature(resumedXml, "Assertion");

    const replay = await exports.default.fetch(
      new Request(ssoUrl, { headers: { cookie }, redirect: "manual" }),
    );
    expect(replay.status).toBe(409);
    expect(await replay.text()).toContain("already been used");

    const launch = await exports.default.fetch(
      new Request(`${origin}/saml/launch/${application.applicationId}`, {
        headers: { cookie },
      }),
    );
    expect(launch.status).toBe(200);
    const launchXml = samlResponseXml(await launch.text());
    expect(launchXml).not.toContain("InResponseTo=");
    expectValidSignature(launchXml, "Response");
    expectValidSignature(launchXml, "Assertion");

    await env.DB.prepare(
      "UPDATE saml_applications SET access_policy = ? WHERE id = ?",
    ).bind("unexpected_policy", application.applicationId).run();
    const invalidPolicyLaunch = await exports.default.fetch(
      new Request(`${origin}/saml/launch/${application.applicationId}`, {
        headers: { cookie },
      }),
    );
    await env.DB.prepare(
      "UPDATE saml_applications SET access_policy = ? WHERE id = ?",
    ).bind("selected_users", application.applicationId).run();
    expect(invalidPolicyLaunch.status).toBe(500);
    expect(await invalidPolicyLaunch.text()).toContain(
      "SAML application access policy is invalid",
    );
  });

  it("handles requested authentication contexts and passive requests", async () => {
    const { cookie, entityId, acsUrl } = fixture;

    const unsupportedContextUrl = new URL(`${origin}/saml/sso`);
    unsupportedContextUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_unsupported_authn_context",
        issuer: entityId,
        acsUrl,
        requestedAuthnContext: {
          classRefs: [
            "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
          ],
        },
      }),
    );
    unsupportedContextUrl.searchParams.set("RelayState", "unsupported-context");
    const unsupportedContext = await exports.default.fetch(
      new Request(unsupportedContextUrl, { headers: { cookie } }),
    );
    expect(unsupportedContext.status).toBe(200);
    const unsupportedContextHtml = await unsupportedContext.text();
    expect(unsupportedContextHtml).toContain(`action="${acsUrl}"`);
    expect(unsupportedContextHtml).toContain(
      'name="RelayState" value="unsupported-context"',
    );
    const unsupportedContextXml = samlResponseXml(unsupportedContextHtml);
    expect(unsupportedContextXml).toContain(
      "urn:oasis:names:tc:SAML:2.0:status:Responder",
    );
    expect(unsupportedContextXml).toContain(
      "urn:oasis:names:tc:SAML:2.0:status:NoAuthnContext",
    );
    expect(unsupportedContextXml).not.toContain("<saml:Assertion");
    expectValidSignature(unsupportedContextXml, "Response");

    const supportedContextUrl = new URL(`${origin}/saml/sso`);
    supportedContextUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_supported_authn_context",
        issuer: entityId,
        acsUrl,
        requestedAuthnContext: {
          classRefs: [SAML_AUTHN_CONTEXT_UNSPECIFIED],
        },
      }),
    );
    const supportedContext = await exports.default.fetch(
      new Request(supportedContextUrl, { headers: { cookie } }),
    );
    expect(supportedContext.status).toBe(200);
    expect(samlResponseXml(await supportedContext.text())).toContain(
      `<saml:AuthnContextClassRef>${SAML_AUTHN_CONTEXT_UNSPECIFIED}</saml:AuthnContextClassRef>`,
    );

    const passiveUrl = new URL(`${origin}/saml/sso`);
    passiveUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_passive_with_session",
        issuer: entityId,
        acsUrl,
        isPassive: true,
      }),
    );
    const passive = await exports.default.fetch(
      new Request(passiveUrl, { headers: { cookie } }),
    );
    expect(passive.status).toBe(200);
    const passiveXml = samlResponseXml(await passive.text());
    expect(passiveXml).toContain("urn:oasis:names:tc:SAML:2.0:status:Success");
    expectValidSignature(passiveXml, "Assertion");

    const passiveSignedOutUrl = new URL(`${origin}/saml/sso`);
    passiveSignedOutUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_passive_without_session",
        issuer: entityId,
        acsUrl,
        isPassive: true,
      }),
    );
    const passiveSignedOut = await exports.default.fetch(passiveSignedOutUrl);
    expect(passiveSignedOut.status).toBe(200);
    const passiveSignedOutXml = samlResponseXml(await passiveSignedOut.text());
    expect(passiveSignedOutXml).toContain(
      "urn:oasis:names:tc:SAML:2.0:status:NoPassive",
    );
    expect(passiveSignedOutXml).not.toContain("<saml:Assertion");
    expectValidSignature(passiveSignedOutXml, "Response");
  });

  it("enforces application access and email NameID policies", async () => {
    const {
      cookie,
      entityId,
      acsUrl,
      applicationInput,
    } = fixture;

    const qualifiedNameIdUrl = new URL(`${origin}/saml/sso`);
    qualifiedNameIdUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_matching_sp_qualifier",
        issuer: entityId,
        acsUrl,
        nameIdPolicy: {
          format: samlNameIdFormatUris.email,
          spNameQualifier: entityId,
        },
      }),
    );
    const qualifiedNameId = await exports.default.fetch(
      new Request(qualifiedNameIdUrl, { headers: { cookie } }),
    );
    expect(qualifiedNameId.status).toBe(200);
    expect(samlResponseXml(await qualifiedNameId.text())).toContain(
      `SPNameQualifier="${entityId}"`,
    );

    const unsupportedQualifierUrl = new URL(`${origin}/saml/sso`);
    unsupportedQualifierUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_unsupported_sp_qualifier",
        issuer: entityId,
        acsUrl,
        nameIdPolicy: {
          format: samlNameIdFormatUris.email,
          spNameQualifier: "https://different.example.test/saml/metadata",
        },
      }),
    );
    const unsupportedQualifier = await exports.default.fetch(
      new Request(unsupportedQualifierUrl, { headers: { cookie } }),
    );
    expect(unsupportedQualifier.status).toBe(200);
    const unsupportedQualifierXml = samlResponseXml(
      await unsupportedQualifier.text(),
    );
    expect(unsupportedQualifierXml).toContain(
      "urn:oasis:names:tc:SAML:2.0:status:InvalidNameIDPolicy",
    );
    expect(unsupportedQualifierXml).not.toContain("<saml:Assertion");
    expectValidSignature(unsupportedQualifierXml, "Response");

    const unassignedEntityId = "https://unassigned.example.test/saml/metadata";
    const unassignedAcsUrl = "https://unassigned.example.test/saml/acs";
    await successfulJson(
      await exports.default.fetch(
        new Request(`${origin}/api/admin/saml-applications`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            ...applicationInput,
            name: "Unassigned service",
            entityId: unassignedEntityId,
            acsUrl: unassignedAcsUrl,
            assignedUserIds: [],
          }),
        }),
      ),
    );
    const unassignedUrl = new URL(`${origin}/saml/sso`);
    unassignedUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_unassigned_user",
        issuer: unassignedEntityId,
        acsUrl: unassignedAcsUrl,
      }),
    );
    const unassigned = await exports.default.fetch(
      new Request(unassignedUrl, { headers: { cookie } }),
    );
    expect(unassigned.status).toBe(200);
    const unassignedXml = samlResponseXml(await unassigned.text());
    expect(unassignedXml).toContain(
      "urn:oasis:names:tc:SAML:2.0:status:RequestDenied",
    );
    expect(unassignedXml).not.toContain("<saml:Assertion");
    expectValidSignature(unassignedXml, "Response");
  });

  it("issues stable persistent NameIDs and enforces AllowCreate", async () => {
    const { cookie, userId, applicationInput } = fixture;

    const persistentApplications = await Promise.all(
      ["one", "two", "three", "four"].map(async (suffix) => successfulJson<{ applicationId: string }>(
        await exports.default.fetch(
          new Request(`${origin}/api/admin/saml-applications`, {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({
              ...applicationInput,
              name: `Persistent service ${suffix}`,
              entityId: `https://persistent-${suffix}.example.test/saml/metadata`,
              acsUrl: `https://persistent-${suffix}.example.test/saml/acs`,
              nameIdFormat: "persistent",
            }),
          }),
        ),
      )),
    );
    await successfulJson(
      await exports.default.fetch(
        new Request(
          `${origin}/api/admin/saml-applications/${persistentApplications[3]!.applicationId}`,
          {
            method: "PATCH",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({
              ...applicationInput,
              name: "Persistent service four",
              entityId: "https://persistent-four-renamed.example.test/saml/metadata",
              acsUrl: "https://persistent-four-renamed.example.test/saml/acs",
              nameIdFormat: "persistent",
            }),
          },
        ),
      ),
    );
    const persistentNameIds: string[] = [];
    for (const persistentApplication of persistentApplications.slice(0, 2)) {
      const persistentLaunch = await exports.default.fetch(
        new Request(`${origin}/saml/launch/${persistentApplication.applicationId}`, {
          headers: { cookie },
        }),
      );
      expect(persistentLaunch.status).toBe(200);
      persistentNameIds.push(samlNameId(samlResponseXml(await persistentLaunch.text()))!);
    }
    const repeatedLaunch = await exports.default.fetch(
      new Request(`${origin}/saml/launch/${persistentApplications[0]!.applicationId}`, {
        headers: { cookie },
      }),
    );
    expect(persistentNameIds[0]).toMatch(/^samlsub_[a-f0-9]{32}$/u);
    expect(persistentNameIds[0]).not.toBe(userId);
    expect(persistentNameIds[0]).not.toBe(persistentNameIds[1]);
    expect(samlNameId(samlResponseXml(await repeatedLaunch.text())))
      .toBe(persistentNameIds[0]);

    const entityIdChange = await exports.default.fetch(
      new Request(
        `${origin}/api/admin/saml-applications/${persistentApplications[0]!.applicationId}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            ...applicationInput,
            name: "Persistent service one",
            entityId: "https://persistent-one-renamed.example.test/saml/metadata",
            acsUrl: "https://persistent-one.example.test/saml/acs",
            nameIdFormat: "persistent",
          }),
        },
      ),
    );
    expect(entityIdChange.status).toBe(409);
    expect(await entityIdChange.text()).toContain(
      "cannot change after a persistent NameID has been issued",
    );

    const persistentEntityId = "https://persistent-three.example.test/saml/metadata";
    const persistentAcsUrl = "https://persistent-three.example.test/saml/acs";
    async function persistentSpRequest(requestId: string, allowCreate: boolean) {
      const url = new URL(`${origin}/saml/sso`);
      url.searchParams.set(
        "SAMLRequest",
        authnRequest({
          id: requestId,
          issuer: persistentEntityId,
          acsUrl: persistentAcsUrl,
          nameIdPolicy: {
            format: samlNameIdFormatUris.persistent,
            allowCreate,
          },
        }),
      );
      return exports.default.fetch(new Request(url, { headers: { cookie } }));
    }

    const creationDenied = await persistentSpRequest(
      "_persistent_creation_denied",
      false,
    );
    expect(creationDenied.status).toBe(200);
    const creationDeniedXml = samlResponseXml(await creationDenied.text());
    expect(creationDeniedXml).toContain(
      "urn:oasis:names:tc:SAML:2.0:status:InvalidNameIDPolicy",
    );
    expect(creationDeniedXml).not.toContain("<saml:Assertion");
    expectValidSignature(creationDeniedXml, "Response");
    const creationAllowed = await persistentSpRequest(
      "_persistent_creation_allowed",
      true,
    );
    expect(creationAllowed.status).toBe(200);
    const createdNameId = samlNameId(
      samlResponseXml(await creationAllowed.text()),
    );
    const existingAllowed = await persistentSpRequest(
      "_persistent_existing_allowed",
      false,
    );
    expect(existingAllowed.status).toBe(200);
    expect(samlNameId(samlResponseXml(await existingAllowed.text())))
      .toBe(createdNameId);

    const unconstrainedUrl = new URL(`${origin}/saml/sso`);
    unconstrainedUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({
        id: "_persistent_without_name_id_policy",
        issuer: "https://persistent-four-renamed.example.test/saml/metadata",
        acsUrl: "https://persistent-four-renamed.example.test/saml/acs",
      }),
    );
    const unconstrained = await exports.default.fetch(
      new Request(unconstrainedUrl, { headers: { cookie } }),
    );
    expect(unconstrained.status).toBe(200);
    expect(samlNameId(samlResponseXml(await unconstrained.text())))
      .toMatch(/^samlsub_[a-f0-9]{32}$/u);
  });

  it("requires valid Redirect signatures when configured", async () => {
    const {
      cookie,
      applicationInput,
    } = fixture;
    const entityId = "https://signed.service.example.test/saml/metadata";
    const acsUrl = "https://signed.service.example.test/saml/acs";
    await successfulJson(
      await exports.default.fetch(
        new Request(`${origin}/api/admin/saml-applications`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            ...applicationInput,
            name: "Signed request service",
            entityId,
            acsUrl,
            requireSignedAuthnRequests: true,
            spSigningCertificate: env.SAML_SIGNING_CERTIFICATE,
          }),
        }),
      ),
    );
    const unsignedUrl = new URL(`${origin}/saml/sso`);
    unsignedUrl.searchParams.set(
      "SAMLRequest",
      authnRequest({ id: "_unsigned_request", issuer: entityId, acsUrl }),
    );
    const unsigned = await exports.default.fetch(
      new Request(unsignedUrl, { headers: { cookie } }),
    );
    expect(unsigned.status).toBe(400);

    const signedParameters = new URLSearchParams();
    signedParameters.set(
      "SAMLRequest",
      authnRequest({ id: "_signed_request", issuer: entityId, acsUrl }),
    );
    signedParameters.set(
      "SigAlg",
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    );
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(signedParameters.toString()),
      env.SAML_SIGNING_PRIVATE_KEY,
    ).toString("base64");
    signedParameters.set("Signature", signature);
    const signed = await exports.default.fetch(
      new Request(`${origin}/saml/sso?${signedParameters}`, {
        headers: { cookie },
      }),
    );
    expect(signed.status, await signed.clone().text()).toBe(200);
    expectValidSignature(samlResponseXml(await signed.text()), "Assertion");

    const missingDestinationParameters = new URLSearchParams();
    missingDestinationParameters.set(
      "SAMLRequest",
      authnRequest({
        id: "_signed_without_destination",
        issuer: entityId,
        acsUrl,
        destination: null,
      }),
    );
    missingDestinationParameters.set(
      "SigAlg",
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    );
    missingDestinationParameters.set(
      "Signature",
      sign(
        "RSA-SHA256",
        Buffer.from(missingDestinationParameters.toString()),
        env.SAML_SIGNING_PRIVATE_KEY,
      ).toString("base64"),
    );
    const missingDestination = await exports.default.fetch(
      new Request(`${origin}/saml/sso?${missingDestinationParameters}`, {
        headers: { cookie },
      }),
    );
    expect(missingDestination.status).toBe(400);
    expect(await missingDestination.text()).toContain("must include Destination");
  });

  it("rejects XML-invalid RelayState at both SAML entry points", async () => {
    const {
      cookie,
      entityId,
      acsUrl,
      application,
    } = fixture;
    const spInitiated = new URL(`${origin}/saml/sso`);
    spInitiated.searchParams.set(
      "SAMLRequest",
      authnRequest({ id: "_invalid_relay_state", issuer: entityId, acsUrl }),
    );
    spInitiated.searchParams.set("RelayState", "before\0after");

    const [spResponse, idpResponse] = await Promise.all([
      exports.default.fetch(new Request(spInitiated, { headers: { cookie } })),
      exports.default.fetch(new Request(
        `${origin}/saml/launch/${application.applicationId}?RelayState=before%00after`,
        { headers: { cookie } },
      )),
    ]);

    expect(spResponse.status).toBe(400);
    expect(await spResponse.text()).toContain("RelayState is invalid");
    expect(idpResponse.status).toBe(400);
    expect(await idpResponse.text()).toContain("RelayState is invalid");
  });

  it("publishes only the validated certificate from a PEM chain", () => {
    const certificate = new X509Certificate(env.SAML_SIGNING_CERTIFICATE);
    const configuration = samlConfiguration({
      ...env,
      SAML_SIGNING_CERTIFICATE:
        `${env.SAML_SIGNING_CERTIFICATE}\n${env.SAML_SIGNING_CERTIFICATE}`,
    });

    expect(configuration.certificateBody).toBe(
      certificate.raw.toString("base64"),
    );
    expect(samlConfiguration({
      ...env,
      SAML_ADDITIONAL_SIGNING_CERTIFICATES: env.SAML_SIGNING_CERTIFICATE,
    }).additionalCertificateBodies).toEqual([]);
  });

  it("publishes additional signing certificates during rotation", () => {
    const configuration = samlConfiguration(env);
    const metadata = samlMetadata({
      ...configuration,
      additionalCertificateBodies: ["next-certificate"],
    });

    expect(metadata.match(/<md:KeyDescriptor use="signing">/gu)).toHaveLength(2);
    expect(metadata).toContain(
      "<ds:X509Certificate>next-certificate</ds:X509Certificate>",
    );
  });

  it("revalidates a cached signing certificate after it expires", () => {
    samlConfiguration(env);
    const certificate = new X509Certificate(env.SAML_SIGNING_CERTIFICATE);
    const now = vi.spyOn(Date, "now").mockReturnValue(
      Date.parse(certificate.validTo) + 1,
    );
    try {
      expect(() => samlConfiguration(env)).toThrow(
        "SAML signing key or certificate is invalid",
      );
    } finally {
      now.mockRestore();
    }
  });

  it("maps an invalid mock SAML continuation to a client error", async () => {
    const response = await exports.default.fetch(
      new Request(`${origin}/api/auth/mock/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "usr_missing",
          samlRequestId: "samlreq_missing",
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: {
        code: "WEBAUTHN_FAILED",
        message: "SAML login transaction is not bound to this browser",
      },
    });
  });

  it("returns HTTP 429 when the SAML rate limit is exceeded", async () => {
    let response: Response | undefined;
    for (let attempt = 0; attempt <= 60; attempt += 1) {
      response = await exports.default.fetch(
        new Request(`${origin}/saml/sso`, {
          headers: { "x-forwarded-for": "203.0.113.250" },
        }),
      );
      if (response.status === 429) break;
    }
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBeTruthy();
  });
});
