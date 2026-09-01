import { Buffer } from "node:buffer";
import {
  SAML_AUTHN_CONTEXT_UNSPECIFIED,
  samlNameIdFormatUris,
  SAML_NAMESPACES,
  type SamlNameIdFormat,
} from "../../shared/saml";
import { createId } from "../lib/ids";
import type { SamlConfiguration } from "./configuration";
import { signSamlElement } from "./signature";
import { escapeXml } from "./xml";

const ASSERTION_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";
const RESPONDER = "urn:oasis:names:tc:SAML:2.0:status:Responder";

type SamlResponseApplication = {
  entityId: string;
  acsUrl: string;
  nameIdFormat: SamlNameIdFormat;
  emailAttributeName: string;
  nameAttributeName: string;
  groupsAttributeName: string | null;
  signResponse: boolean;
};

type SamlIdentity = {
  nameId: string;
  name: string;
  email: string;
  groups: string[];
};

function attribute(name: string, values: string[]) {
  if (!name || values.length === 0) return "";
  return `<saml:Attribute Name="${escapeXml(name)}">`
    + values.map((value) =>
      `<saml:AttributeValue>${escapeXml(value)}</saml:AttributeValue>`
    ).join("")
    + `</saml:Attribute>`;
}

export function buildSamlResponse(input: {
  configuration: SamlConfiguration;
  application: SamlResponseApplication;
  identity: SamlIdentity;
  authTime: Date;
  transactionId: string;
  spRequestId: string | null;
  requestedSpNameQualifier: string | null;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const notBefore = new Date(now.getTime() - CLOCK_SKEW_MS).toISOString();
  const notOnOrAfter = new Date(now.getTime() + ASSERTION_TTL_MS).toISOString();
  const issueInstant = now.toISOString();
  const responseId = createId("samlres");
  const assertionId = createId("samlassert");
  const issuer = escapeXml(input.configuration.entityId);
  const audience = escapeXml(input.application.entityId);
  const acsUrl = escapeXml(input.application.acsUrl);
  const inResponseTo = input.spRequestId
    ? ` InResponseTo="${escapeXml(input.spRequestId)}"`
    : "";
  const spNameQualifier = input.requestedSpNameQualifier
    ? ` SPNameQualifier="${escapeXml(input.requestedSpNameQualifier)}"`
    : "";
  const attributes = [
    attribute(input.application.emailAttributeName, [input.identity.email]),
    attribute(input.application.nameAttributeName, [input.identity.name]),
    input.application.groupsAttributeName
      ? attribute(input.application.groupsAttributeName, input.identity.groups)
      : "",
  ].join("");

  let xml = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<samlp:Response xmlns:samlp="${SAML_NAMESPACES.protocol}" xmlns:saml="${SAML_NAMESPACES.assertion}" ID="${responseId}" Version="2.0" IssueInstant="${issueInstant}" Destination="${acsUrl}"${inResponseTo}>`
    + `<saml:Issuer>${issuer}</saml:Issuer>`
    + `<samlp:Status><samlp:StatusCode Value="${SUCCESS}"/></samlp:Status>`
    + `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant}">`
    + `<saml:Issuer>${issuer}</saml:Issuer>`
    + `<saml:Subject>`
    + `<saml:NameID Format="${samlNameIdFormatUris[input.application.nameIdFormat]}"${spNameQualifier}>${escapeXml(input.identity.nameId)}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="${BEARER}">`
    + `<saml:SubjectConfirmationData Recipient="${acsUrl}" NotOnOrAfter="${notOnOrAfter}"${inResponseTo}/>`
    + `</saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">`
    + `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>`
    + `</saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${input.authTime.toISOString()}" SessionIndex="${escapeXml(input.transactionId)}">`
    + `<saml:AuthnContext><saml:AuthnContextClassRef>${SAML_AUTHN_CONTEXT_UNSPECIFIED}</saml:AuthnContextClassRef></saml:AuthnContext>`
    + `</saml:AuthnStatement>`
    + `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>`
    + `</saml:Assertion></samlp:Response>`;

  xml = signSamlElement(xml, {
    localName: "Assertion",
    id: assertionId,
    configuration: input.configuration,
  });
  if (input.application.signResponse) {
    xml = signSamlElement(xml, {
      localName: "Response",
      id: responseId,
      configuration: input.configuration,
    });
  }
  return Buffer.from(xml, "utf8").toString("base64");
}

export function buildSamlErrorResponse(input: {
  configuration: SamlConfiguration;
  acsUrl: string;
  spRequestId: string;
  statusCode: string;
  message: string;
  now?: Date;
}) {
  const responseId = createId("samlres");
  const issuer = escapeXml(input.configuration.entityId);
  const acsUrl = escapeXml(input.acsUrl);
  let xml = `<?xml version="1.0" encoding="UTF-8"?>`
    + `<samlp:Response xmlns:samlp="${SAML_NAMESPACES.protocol}" xmlns:saml="${SAML_NAMESPACES.assertion}" ID="${responseId}" Version="2.0" IssueInstant="${(input.now ?? new Date()).toISOString()}" Destination="${acsUrl}" InResponseTo="${escapeXml(input.spRequestId)}">`
    + `<saml:Issuer>${issuer}</saml:Issuer>`
    + `<samlp:Status>`
    + `<samlp:StatusCode Value="${RESPONDER}">`
    + `<samlp:StatusCode Value="${escapeXml(input.statusCode)}"/>`
    + `</samlp:StatusCode>`
    + `<samlp:StatusMessage>${escapeXml(input.message)}</samlp:StatusMessage>`
    + `</samlp:Status></samlp:Response>`;
  xml = signSamlElement(xml, {
    localName: "Response",
    id: responseId,
    configuration: input.configuration,
  });
  return Buffer.from(xml, "utf8").toString("base64");
}

export function samlPostResponse(input: {
  acsUrl: string;
  samlResponse: string;
  relayState: string | null;
}) {
  const relay = input.relayState === null
    ? ""
    : `<input type="hidden" name="RelayState" value="${escapeXml(input.relayState)}">`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Continue</title></head>`
    + `<body><form id="saml-response" method="post" action="${escapeXml(input.acsUrl)}">`
    + `<input type="hidden" name="SAMLResponse" value="${input.samlResponse}">${relay}`
    + `<noscript><button type="submit">Continue</button></noscript></form>`
    + `<script>document.getElementById("saml-response").submit()</script></body></html>`;
  const acsOrigin = new URL(input.acsUrl).origin;
  return new Response(html, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'unsafe-inline'; form-action ${acsOrigin}; base-uri 'none'; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
