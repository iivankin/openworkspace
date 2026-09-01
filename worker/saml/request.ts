import { Buffer } from "node:buffer";
import { verify } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import {
  SAML_AUTHN_CONTEXT_UNSPECIFIED,
  SAML_BINDINGS,
  SAML_NAMESPACES,
} from "../../shared/saml";
import { SAML_CLOCK_SKEW_MS } from "./constants";
import { SamlError, SamlStatusError } from "./errors";
import { isValidXmlCharacters } from "./xml";

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RELAY_STATE_BYTES = 80;
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const XML_ID = /^[A-Za-z_][A-Za-z0-9._-]{0,255}$/u;
const MAX_AUTHN_CONTEXT_REFS = 20;

type AuthnContextComparison = "exact" | "minimum" | "maximum" | "better";

export function parseRelayState(url: URL) {
  const values = url.searchParams.getAll("RelayState");
  const relayState = values[0] ?? null;
  if (
    values.length > 1
    || (relayState !== null && (
      Buffer.byteLength(relayState, "utf8") > MAX_RELAY_STATE_BYTES
      || !isValidXmlCharacters(relayState)
    ))
  ) {
    throw new SamlError("RelayState is invalid");
  }
  return relayState;
}

export type ParsedSamlAuthnRequest = {
  id: string;
  issuer: string;
  destination: string | null;
  acsUrl: string | null;
  protocolBinding: string | null;
  requestedNameIdFormat: string | null;
  requestedSpNameQualifier: string | null;
  allowNameIdCreation: boolean;
  requestedAuthnContext: {
    comparison: AuthnContextComparison;
    classRefs: string[];
  } | null;
  forceAuthn: boolean;
  isPassive: boolean;
  relayState: string | null;
};

function strictBase64(value: string, label: string) {
  const compact = value.replace(/\s+/gu, "");
  if (
    compact.length === 0
    || compact.length > MAX_REQUEST_BYTES * 2
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)
    || compact.length % 4 === 1
  ) {
    throw new SamlError(`${label} is not valid base64`);
  }
  return Buffer.from(compact, "base64");
}

type XmlElement = Node & {
  namespaceURI: string | null;
  localName: string | null;
  textContent: string | null;
  getAttribute(name: string): string | null;
};

function directChild(element: XmlElement, namespace: string, localName: string) {
  const matches: XmlElement[] = [];
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType !== 1) continue;
    const child = node as unknown as XmlElement;
    if (child.namespaceURI === namespace && child.localName === localName) {
      matches.push(child);
    }
  }
  if (matches.length > 1) {
    throw new SamlError(`AuthnRequest contains multiple ${localName} elements`);
  }
  return matches[0] ?? null;
}

function elementChildren(element: XmlElement) {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === 1)
    .map((node) => node as unknown as XmlElement);
}

function booleanAttribute(value: string | null, label: string) {
  if (!value || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new SamlError(`${label} must be a boolean`);
}

function parseXml(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new SamlError("SAMLRequest must not contain a document type or entity declaration");
  }
  try {
    return new DOMParser({
      onError: () => {
        throw new Error("Invalid XML");
      },
    }).parseFromString(xml, "application/xml");
  } catch {
    throw new SamlError("SAMLRequest contains invalid XML");
  }
}

function parseRequestedAuthnContext(root: XmlElement) {
  const requested = directChild(
    root,
    SAML_NAMESPACES.protocol,
    "RequestedAuthnContext",
  );
  if (!requested) return null;

  const comparison = requested.getAttribute("Comparison") || "exact";
  if (!(["exact", "minimum", "maximum", "better"] as string[]).includes(comparison)) {
    throw new SamlError("RequestedAuthnContext Comparison is invalid");
  }
  const children = elementChildren(requested);
  const classRefs = children.filter((child) =>
    child.namespaceURI === SAML_NAMESPACES.assertion
    && child.localName === "AuthnContextClassRef"
  );
  const declarationRefs = children.filter((child) =>
    child.namespaceURI === SAML_NAMESPACES.assertion
    && child.localName === "AuthnContextDeclRef"
  );
  if (classRefs.length + declarationRefs.length !== children.length) {
    throw new SamlError("RequestedAuthnContext contains an unsupported element");
  }
  if (declarationRefs.length > 0) {
    throw new SamlError("AuthnContext declaration references are not supported");
  }
  if (classRefs.length === 0 || classRefs.length > MAX_AUTHN_CONTEXT_REFS) {
    throw new SamlError("RequestedAuthnContext class references are invalid");
  }
  const values = classRefs.map((reference) => reference.textContent?.trim() ?? "");
  if (values.some((value) => !value || value.length > 2_048)) {
    throw new SamlError("RequestedAuthnContext class reference is invalid");
  }
  return {
    comparison: comparison as AuthnContextComparison,
    classRefs: values,
  };
}

export function parseRedirectAuthnRequest(url: URL): ParsedSamlAuthnRequest {
  if (url.searchParams.getAll("SAMLRequest").length !== 1) {
    throw new SamlError("Exactly one SAMLRequest is required");
  }
  const encoded = url.searchParams.get("SAMLRequest")!;
  let xml: string;
  try {
    const compressed = strictBase64(encoded, "SAMLRequest");
    xml = inflateRawSync(compressed, {
      maxOutputLength: MAX_REQUEST_BYTES,
    }).toString("utf8");
  } catch (error) {
    if (error instanceof SamlError) throw error;
    throw new SamlError("SAMLRequest is not a valid Redirect binding payload");
  }
  if (Buffer.byteLength(xml, "utf8") > MAX_REQUEST_BYTES) {
    throw new SamlError("SAMLRequest is too large");
  }

  const document = parseXml(xml);
  const root = document.documentElement as unknown as XmlElement;
  if (
    root.namespaceURI !== SAML_NAMESPACES.protocol
    || root.localName !== "AuthnRequest"
  ) {
    throw new SamlError("SAMLRequest must contain a SAML 2.0 AuthnRequest");
  }
  if (root.getAttribute("Version") !== "2.0") {
    throw new SamlError("Only SAML 2.0 AuthnRequest messages are supported");
  }
  const id = root.getAttribute("ID");
  if (!id || !XML_ID.test(id)) throw new SamlError("AuthnRequest ID is invalid");
  const issueInstantRaw = root.getAttribute("IssueInstant");
  const issueInstant = new Date(issueInstantRaw ?? "");
  if (
    !issueInstantRaw
    || !Number.isFinite(issueInstant.getTime())
    || Math.abs(Date.now() - issueInstant.getTime()) > SAML_CLOCK_SKEW_MS
  ) {
    throw new SamlError("AuthnRequest IssueInstant is invalid or outside the allowed clock skew");
  }
  const isPassive = booleanAttribute(root.getAttribute("IsPassive"), "IsPassive");

  const issuerElement = directChild(
    root,
    SAML_NAMESPACES.assertion,
    "Issuer",
  );
  const issuer = issuerElement?.textContent?.trim();
  if (!issuer || issuer.length > 2_048) {
    throw new SamlError("AuthnRequest Issuer is missing or invalid");
  }
  if (directChild(root, SAML_NAMESPACES.assertion, "Subject")) {
    throw new SamlError("AuthnRequest Subject is not supported");
  }
  const nameIdPolicy = directChild(
    root,
    SAML_NAMESPACES.protocol,
    "NameIDPolicy",
  );
  const requestedAuthnContext = parseRequestedAuthnContext(root);
  const relayState = parseRelayState(url);

  return {
    id,
    issuer,
    destination: root.getAttribute("Destination") || null,
    acsUrl: root.getAttribute("AssertionConsumerServiceURL") || null,
    protocolBinding: root.getAttribute("ProtocolBinding") || null,
    requestedNameIdFormat: nameIdPolicy?.getAttribute("Format") || null,
    requestedSpNameQualifier:
      nameIdPolicy?.getAttribute("SPNameQualifier") || null,
    allowNameIdCreation: nameIdPolicy === null || booleanAttribute(
      nameIdPolicy.getAttribute("AllowCreate"),
      "NameIDPolicy AllowCreate",
    ),
    requestedAuthnContext,
    forceAuthn: booleanAttribute(root.getAttribute("ForceAuthn"), "ForceAuthn"),
    isPassive,
    relayState,
  };
}

function rawQueryValue(url: URL, name: string) {
  let queryParts: Array<{ name: string; value: string }>;
  try {
    queryParts = url.search
      .slice(1)
      .split("&")
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        const rawName = separator === -1 ? part : part.slice(0, separator);
        const rawValue = separator === -1 ? "" : part.slice(separator + 1);
        return {
          name: decodeURIComponent(rawName.replace(/\+/gu, "%20")),
          value: rawValue,
        };
      });
  } catch {
    throw new SamlError("SAML Redirect query encoding is invalid");
  }
  const matches = queryParts.filter((part) => part.name === name);
  if (matches.length !== 1) throw new SamlError(`Exactly one ${name} is required`);
  return matches[0]!.value;
}

export function verifyRedirectAuthnRequest(
  url: URL,
  application: {
    requireSignedAuthnRequests: boolean;
    spSigningCertificate: string | null;
  },
) {
  const signatureFieldsPresent = ["SigAlg", "Signature"].some((name) =>
    url.searchParams.has(name)
  );
  if (!application.requireSignedAuthnRequests && !signatureFieldsPresent) return false;
  if (!application.spSigningCertificate) {
    throw new SamlError("The application has no certificate for AuthnRequest verification");
  }
  if (
    url.searchParams.getAll("SigAlg").length !== 1
    || url.searchParams.getAll("Signature").length !== 1
    || url.searchParams.get("SigAlg") !== RSA_SHA256
  ) {
    throw new SamlError("AuthnRequest must use an RSA-SHA256 Redirect signature");
  }

  const request = rawQueryValue(url, "SAMLRequest");
  const relay = url.searchParams.has("RelayState")
    ? `&RelayState=${rawQueryValue(url, "RelayState")}`
    : "";
  const signatureAlgorithm = rawQueryValue(url, "SigAlg");
  const signed = `SAMLRequest=${request}${relay}&SigAlg=${signatureAlgorithm}`;
  const signature = strictBase64(url.searchParams.get("Signature")!, "Signature");
  try {
    if (!verify("RSA-SHA256", Buffer.from(signed), application.spSigningCertificate, signature)) {
      throw new SamlError("AuthnRequest signature is invalid");
    }
  } catch (error) {
    if (error instanceof SamlError) throw error;
    throw new SamlError("AuthnRequest signature could not be verified");
  }
  return true;
}

export function validateAuthnRequestForApplication(
  request: ParsedSamlAuthnRequest,
  application: {
    entityId: string;
    acsUrl: string;
    nameIdFormatUri: string;
  },
  ssoUrl: string,
  signed: boolean,
) {
  if (signed && !request.destination) {
    throw new SamlError("Signed AuthnRequest messages must include Destination");
  }
  if (request.destination && request.destination !== ssoUrl) {
    throw new SamlError("AuthnRequest Destination does not match this IdP");
  }
  if (request.acsUrl && request.acsUrl !== application.acsUrl) {
    throw new SamlError("AuthnRequest ACS URL is not registered for this application");
  }
  if (request.protocolBinding && request.protocolBinding !== SAML_BINDINGS.post) {
    throw new SamlError("Only the HTTP-POST SAML response binding is supported");
  }
  if (
    request.requestedSpNameQualifier
    && request.requestedSpNameQualifier !== application.entityId
  ) {
    throw new SamlStatusError(
      "The requested SPNameQualifier is not supported",
      "urn:oasis:names:tc:SAML:2.0:status:InvalidNameIDPolicy",
    );
  }
  if (
    request.requestedNameIdFormat
    && request.requestedNameIdFormat
      !== "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified"
    && request.requestedNameIdFormat !== application.nameIdFormatUri
  ) {
    throw new SamlStatusError(
      "The requested NameID format is not configured for this application",
      "urn:oasis:names:tc:SAML:2.0:status:InvalidNameIDPolicy",
    );
  }
  if (
    request.requestedAuthnContext
    && (
      request.requestedAuthnContext.comparison !== "exact"
      || !request.requestedAuthnContext.classRefs.includes(
        SAML_AUTHN_CONTEXT_UNSPECIFIED,
      )
    )
  ) {
    throw new SamlStatusError(
      "The requested authentication context is not supported",
      "urn:oasis:names:tc:SAML:2.0:status:NoAuthnContext",
    );
  }
}
