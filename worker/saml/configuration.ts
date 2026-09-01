import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from "node:crypto";
import type { AppEnv } from "../env";
import {
  identityProviderOrigin,
  IdentityProviderOriginError,
} from "../lib/identity-provider-origin";
import { isSupportedSamlRsaKey } from "./credentials";
import { SamlError } from "./errors";

export type SamlConfiguration = {
  origin: string;
  entityId: string;
  metadataUrl: string;
  ssoUrl: string;
  certificatePem: string;
  certificateBody: string;
  additionalCertificateBodies: string[];
  privateKeyPem: string;
};

let cached:
  | {
      originSource: string;
      privateKeySource: string;
      certificateSource: string;
      additionalCertificatesSource: string;
      certificateValidFrom: number;
      certificateValidTo: number;
      configuration: SamlConfiguration;
    }
  | undefined;

export function samlPublicUrls(
  env: Pick<
    AppEnv["Bindings"],
    "IDENTITY_PROVIDER_ORIGIN" | "ALLOW_MOCK_AUTH"
  >,
) {
  try {
    const origin = identityProviderOrigin(env);
    return {
      origin,
      entityId: new URL("/saml/metadata", origin).toString(),
      metadataUrl: new URL("/saml/metadata", origin).toString(),
      ssoUrl: new URL("/saml/sso", origin).toString(),
    };
  } catch (error) {
    if (!(error instanceof IdentityProviderOriginError)) throw error;
    throw new SamlError(error.message, error.reason === "missing" ? 503 : 500);
  }
}

function pemCertificates(source: string) {
  const certificates = source.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu,
  ) ?? [];
  const remainder = source.replace(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu,
    "",
  ).trim();
  if (source && (certificates.length === 0 || remainder)) {
    throw new Error("Additional SAML certificates must be a PEM bundle");
  }
  return certificates;
}

function validatedCertificate(source: string) {
  const certificate = new X509Certificate(source);
  if (!isSupportedSamlRsaKey(certificate.publicKey)) {
    throw new Error(
      "SAML signing certificates must use RSA keys of at least 2048 bits",
    );
  }
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  return {
    certificate,
    body: certificate.raw.toString("base64"),
    validFrom,
    validTo,
  };
}

export function samlConfiguration(env: AppEnv["Bindings"]): SamlConfiguration {
  const originSource = env.IDENTITY_PROVIDER_ORIGIN?.trim() ?? "";
  const privateKeySource = env.SAML_SIGNING_PRIVATE_KEY?.trim() ?? "";
  const certificateSource = env.SAML_SIGNING_CERTIFICATE?.trim() ?? "";
  const additionalCertificatesSource =
    env.SAML_ADDITIONAL_SIGNING_CERTIFICATES?.trim() ?? "";
  const now = Date.now();
  if (
    cached?.originSource === originSource
    && cached.privateKeySource === privateKeySource
    && cached.certificateSource === certificateSource
    && cached.additionalCertificatesSource === additionalCertificatesSource
    && cached.certificateValidFrom <= now
    && cached.certificateValidTo > now
  ) {
    return cached.configuration;
  }
  if (!privateKeySource || !certificateSource) {
    throw new SamlError("SAML signing key and certificate are not configured", 503);
  }

  let certificateValidFrom: number;
  let certificateValidTo: number;
  let certificateBody: string;
  let additionalCertificateBodies: string[];
  try {
    const privateKey = createPrivateKey(privateKeySource);
    const current = validatedCertificate(certificateSource);
    const certificate = current.certificate;
    if (!isSupportedSamlRsaKey(privateKey)) {
      throw new Error(
        "SAML signing credentials must use RSA keys of at least 2048 bits",
      );
    }
    const privatePublic = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    const certificatePublic = certificate.publicKey.export({
      format: "der",
      type: "spki",
    });
    if (!privatePublic.equals(certificatePublic)) {
      throw new Error("Certificate does not match the private key");
    }
    if (current.validFrom > now || current.validTo <= now) {
      throw new Error("SAML signing certificate must be currently valid");
    }
    const additional = pemCertificates(additionalCertificatesSource)
      .map(validatedCertificate);
    certificateValidFrom = current.validFrom;
    certificateValidTo = current.validTo;
    certificateBody = current.body;
    additionalCertificateBodies = [...new Set(
      additional
        .map((item) => item.body)
        .filter((body) => body !== certificateBody),
    )];
  } catch {
    throw new SamlError("SAML signing key or certificate is invalid", 500);
  }

  const urls = samlPublicUrls(env);
  const configuration = {
    ...urls,
    privateKeyPem: privateKeySource,
    certificatePem: certificateSource,
    certificateBody,
    additionalCertificateBodies,
  };
  cached = {
    originSource,
    privateKeySource,
    certificateSource,
    additionalCertificatesSource,
    certificateValidFrom,
    certificateValidTo,
    configuration,
  };
  return configuration;
}
