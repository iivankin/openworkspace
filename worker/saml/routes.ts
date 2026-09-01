import { Hono, type Context } from "hono";
import { readSessionFromContext } from "../auth/session";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { checkRateLimit, requestIdentifier } from "../lib/rate-limit";
import { samlConfiguration, type SamlConfiguration } from "./configuration";
import { SamlError, SamlStatusError, samlError } from "./errors";
import { samlMetadata } from "./metadata";
import {
  parseRedirectAuthnRequest,
  parseRelayState,
  type ParsedSamlAuthnRequest,
  validateAuthnRequestForApplication,
  verifyRedirectAuthnRequest,
} from "./request";
import {
  assertUserCanUseSamlApplication,
  findSamlApplicationByEntityId,
  findSamlApplicationById,
  issueSamlTransaction,
} from "./service";
import {
  browserSamlTransaction,
  createSamlTransaction,
  setSamlTransactionCookie,
} from "./transaction";
import { buildSamlErrorResponse, samlPostResponse } from "./response";

function publicSamlError(c: Context<AppEnv>, error: unknown) {
  const normalized = samlError(error);
  c.header("cache-control", "no-store");
  return c.text(normalized.message, normalized.status);
}

async function rateLimitSaml(c: Context<AppEnv>) {
  const rate = await checkRateLimit(c.env.DB, {
    action: "saml-sso",
    identifier: requestIdentifier(c.req.raw),
    limit: 60,
    windowMs: 60_000,
  });
  if (rate.allowed) return;
  c.header("retry-after", String(rate.retryAfterSeconds));
  throw new SamlError("Too many SAML authentication attempts", 429);
}

function samlStatusPostResponse(input: {
  configuration: SamlConfiguration;
  application: { acsUrl: string };
  request: Pick<ParsedSamlAuthnRequest, "id" | "relayState">;
  error: SamlStatusError;
}) {
  return samlPostResponse({
    acsUrl: input.application.acsUrl,
    samlResponse: buildSamlErrorResponse({
      configuration: input.configuration,
      acsUrl: input.application.acsUrl,
      spRequestId: input.request.id,
      statusCode: input.error.statusCode,
      message: input.error.message,
    }),
    relayState: input.request.relayState,
  });
}

export const samlLoginRoutes = new Hono<AppEnv>().get("/:id", async (c) => {
  try {
    const transaction = await browserSamlTransaction(
      createDb(c.env.DB),
      c,
      c.req.param("id"),
    );
    return c.json({
      ok: true as const,
      transaction: { applicationName: transaction.applicationName },
    });
  } catch (error) {
    const normalized = samlError(error);
    if (normalized.status >= 500) throw error;
    const status = normalized.status === 403
      ? 403
      : normalized.status === 409
        ? 409
        : 400;
    return apiError(c, status, "BAD_REQUEST", normalized.message);
  }
});

export const samlRoutes = new Hono<AppEnv>()
  .get("/metadata", (c) => {
    try {
      const metadata = samlMetadata(samlConfiguration(c.env));
      c.header("cache-control", "public, max-age=3600");
      return c.body(metadata, 200, { "content-type": "application/samlmetadata+xml" });
    } catch (error) {
      return publicSamlError(c, error);
    }
  })
  .get("/sso", async (c) => {
    try {
      await rateLimitSaml(c);
      const configuration = samlConfiguration(c.env);
      const url = new URL(c.req.url);
      const request = parseRedirectAuthnRequest(url);
      const db = createDb(c.env.DB);
      const application = await findSamlApplicationByEntityId(db, request.issuer);
      const signed = verifyRedirectAuthnRequest(url, application);
      try {
        validateAuthnRequestForApplication(
          request,
          application,
          configuration.ssoUrl,
          signed,
        );
      } catch (error) {
        if (!(error instanceof SamlStatusError)) throw error;
        return samlStatusPostResponse({
          configuration,
          application,
          request,
          error,
        });
      }
      const session = await readSessionFromContext(c);
      if (request.isPassive && (!session || request.forceAuthn)) {
        return samlStatusPostResponse({
          configuration,
          application,
          request,
          error: new SamlStatusError(
            "The principal cannot be authenticated passively",
            "urn:oasis:names:tc:SAML:2.0:status:NoPassive",
          ),
        });
      }
      const transaction = await createSamlTransaction(db, {
        applicationId: application.id,
        spRequestId: request.id,
        acsUrl: application.acsUrl,
        relayState: request.relayState,
        requestedSpNameQualifier: request.requestedSpNameQualifier,
        allowNameIdCreation: request.allowNameIdCreation,
        ...session && !request.forceAuthn
          ? { authenticated: { userId: session.user.id, authTime: session.authTime } }
          : {},
      });
      if (session && !request.forceAuthn) {
        return await issueSamlTransaction(
          db,
          c.env,
          transaction.id,
          session.user.id,
        );
      }
      setSamlTransactionCookie(c, transaction);
      return c.redirect(`/saml/login/${encodeURIComponent(transaction.id)}`);
    } catch (error) {
      return publicSamlError(c, error);
    }
  })
  .get("/launch/:id", async (c) => {
    try {
      await rateLimitSaml(c);
      samlConfiguration(c.env);
      const db = createDb(c.env.DB);
      const application = await findSamlApplicationById(db, c.req.param("id"));
      if (!application.allowIdpInitiated) {
        throw new SamlError("IdP-initiated sign-in is disabled for this application", 403);
      }
      const relayState = parseRelayState(new URL(c.req.url));
      const session = await readSessionFromContext(c);
      if (session) {
        await assertUserCanUseSamlApplication(db, application, session.user.id);
      }
      const transaction = await createSamlTransaction(db, {
        applicationId: application.id,
        spRequestId: null,
        acsUrl: application.acsUrl,
        relayState,
        requestedSpNameQualifier: null,
        allowNameIdCreation: true,
        ...(session
          ? { authenticated: { userId: session.user.id, authTime: session.authTime } }
          : {}),
      });
      if (session) {
        return await issueSamlTransaction(
          db,
          c.env,
          transaction.id,
          session.user.id,
        );
      }
      setSamlTransactionCookie(c, transaction);
      return c.redirect(`/saml/login/${encodeURIComponent(transaction.id)}`);
    } catch (error) {
      return publicSamlError(c, error);
    }
  })
  .get("/resume/:id", async (c) => {
    try {
      const session = await readSessionFromContext(c);
      if (!session) throw new SamlError("Authentication is required", 403);
      return await issueSamlTransaction(
        createDb(c.env.DB),
        c.env,
        c.req.param("id"),
        session.user.id,
      );
    } catch (error) {
      return publicSamlError(c, error);
    }
  });
