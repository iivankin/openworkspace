import { X509Certificate } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";
import {
  samlApplicationAssignments,
  samlApplicationGroupClaims,
  samlApplications,
  samlAuthnRequests,
} from "../db/schema";
import { createDb } from "../db/client";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import { isSupportedSamlRsaKey } from "../saml/credentials";
import {
  createSamlApplicationSchema,
  updateSamlApplicationSchema,
} from "./schemas";
import { hasKnownGroupIds, hasKnownUserIds } from "./records";

const ENTITY_ID_IMMUTABLE_DB_ERROR = "SAML_ENTITY_ID_IMMUTABLE";

function isImmutableEntityIdError(error: unknown) {
  return error instanceof Error
    && error.message.includes(ENTITY_ID_IMMUTABLE_DB_ERROR);
}

function validCertificate(value: string | null) {
  if (!value) return null;
  try {
    const certificate = new X509Certificate(value);
    return isSupportedSamlRsaKey(certificate.publicKey)
      ? certificate.toString()
      : null;
  } catch {
    return null;
  }
}

async function validateReferences(
  db: ReturnType<typeof createDb>,
  input: { assignedUserIds: string[]; exposedGroupIds: string[] },
) {
  const [knownUsers, knownGroups] = await Promise.all([
    hasKnownUserIds(db, input.assignedUserIds),
    hasKnownGroupIds(db, input.exposedGroupIds),
  ]);
  if (!knownUsers) return "Unknown assigned user";
  if (!knownGroups) return "Unknown exposed group";
  return null;
}

export const samlApplicationAdminRoutes = new Hono<AppEnv>()
  .get("/saml-applications/:id", async (c) => {
    const [application] = await createDb(c.env.DB)
      .select({
        spSigningCertificate: samlApplications.spSigningCertificate,
      })
      .from(samlApplications)
      .where(eq(samlApplications.id, c.req.param("id")))
      .limit(1);
    if (!application) {
      return apiError(c, 404, "NOT_FOUND", "SAML application not found");
    }
    return c.json({ ok: true as const, ...application });
  })
  .post(
    "/saml-applications",
    zValidator("json", createSamlApplicationSchema),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const referenceError = await validateReferences(db, input);
      if (referenceError) return apiError(c, 400, "BAD_REQUEST", referenceError);
      const certificate = validCertificate(input.spSigningCertificate);
      if (input.spSigningCertificate && !certificate) {
        return apiError(c, 400, "BAD_REQUEST", "Service-provider certificate is invalid");
      }

      const id = createId("sapp");
      const now = new Date();
      const assignmentInsert = input.assignedUserIds.length > 0
        ? db.insert(samlApplicationAssignments).values(
          input.assignedUserIds.map((userId) => ({
            applicationId: id,
            userId,
            createdAt: now,
          })),
        )
        : null;
      const groupClaimInsert = input.exposedGroupIds.length > 0
        ? db.insert(samlApplicationGroupClaims).values(
          input.exposedGroupIds.map((groupId) => ({ applicationId: id, groupId })),
        )
        : null;
      try {
        await db.batch([
          db.insert(samlApplications).values({
            id,
            name: input.name,
            entityId: input.entityId,
            acsUrl: input.acsUrl,
            nameIdFormat: input.nameIdFormat,
            accessPolicy: input.accessPolicy,
            emailAttributeName: input.emailAttributeName,
            nameAttributeName: input.nameAttributeName,
            groupsAttributeName: input.groupsAttributeName,
            signResponse: input.signResponse,
            requireSignedAuthnRequests: input.requireSignedAuthnRequests,
            spSigningCertificate: certificate,
            allowIdpInitiated: input.allowIdpInitiated,
            enabled: input.enabled,
            createdByUserId: c.get("user").id,
            createdAt: now,
            updatedAt: now,
          }),
          ...(assignmentInsert ? [assignmentInsert] : []),
          ...(groupClaimInsert ? [groupClaimInsert] : []),
        ]);
      } catch (error) {
        const [conflict] = await db
          .select({ id: samlApplications.id })
          .from(samlApplications)
          .where(eq(samlApplications.entityId, input.entityId))
          .limit(1);
        if (conflict) {
          return apiError(c, 409, "CONFLICT", "SAML Entity ID is already registered");
        }
        throw error;
      }
      return c.json({ ok: true as const, applicationId: id }, 201);
    },
  )
  .patch(
    "/saml-applications/:id",
    zValidator("json", updateSamlApplicationSchema),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const applicationId = c.req.param("id");
      const [application] = await db
        .select({ id: samlApplications.id })
        .from(samlApplications)
        .where(eq(samlApplications.id, applicationId))
        .limit(1);
      if (!application) {
        return apiError(c, 404, "NOT_FOUND", "SAML application not found");
      }
      const referenceError = await validateReferences(db, input);
      if (referenceError) return apiError(c, 400, "BAD_REQUEST", referenceError);
      const certificate = validCertificate(input.spSigningCertificate);
      if (input.spSigningCertificate && !certificate) {
        return apiError(c, 400, "BAD_REQUEST", "Service-provider certificate is invalid");
      }

      const now = new Date();
      const assignmentInsert = input.assignedUserIds.length > 0
        ? db.insert(samlApplicationAssignments).values(
          input.assignedUserIds.map((userId) => ({
            applicationId,
            userId,
            createdAt: now,
          })),
        )
        : null;
      const groupClaimInsert = input.exposedGroupIds.length > 0
        ? db.insert(samlApplicationGroupClaims).values(
          input.exposedGroupIds.map((groupId) => ({ applicationId, groupId })),
        )
        : null;
      try {
        await db.batch([
          db.update(samlApplications).set({
            name: input.name,
            entityId: input.entityId,
            acsUrl: input.acsUrl,
            nameIdFormat: input.nameIdFormat,
            accessPolicy: input.accessPolicy,
            emailAttributeName: input.emailAttributeName,
            nameAttributeName: input.nameAttributeName,
            groupsAttributeName: input.groupsAttributeName,
            signResponse: input.signResponse,
            requireSignedAuthnRequests: input.requireSignedAuthnRequests,
            spSigningCertificate: certificate,
            allowIdpInitiated: input.allowIdpInitiated,
            enabled: input.enabled,
            updatedAt: now,
          }).where(eq(samlApplications.id, applicationId)),
          db.delete(samlApplicationAssignments).where(
            eq(samlApplicationAssignments.applicationId, applicationId),
          ),
          db.delete(samlApplicationGroupClaims).where(
            eq(samlApplicationGroupClaims.applicationId, applicationId),
          ),
          db.delete(samlAuthnRequests).where(
            and(
              eq(samlAuthnRequests.applicationId, applicationId),
              ne(samlAuthnRequests.status, "responded"),
            ),
          ),
          ...(assignmentInsert ? [assignmentInsert] : []),
          ...(groupClaimInsert ? [groupClaimInsert] : []),
        ]);
      } catch (error) {
        if (isImmutableEntityIdError(error)) {
          return apiError(
            c,
            409,
            "CONFLICT",
            "SAML Entity ID cannot change after a persistent NameID has been issued",
          );
        }
        const [conflict] = await db
          .select({ id: samlApplications.id })
          .from(samlApplications)
          .where(and(
            eq(samlApplications.entityId, input.entityId),
            ne(samlApplications.id, applicationId),
          ))
          .limit(1);
        if (conflict) {
          return apiError(c, 409, "CONFLICT", "SAML Entity ID is already registered");
        }
        throw error;
      }
      return c.json({ ok: true as const });
    },
  )
  .delete("/saml-applications/:id", async (c) => {
    const db = createDb(c.env.DB);
    const applicationId = c.req.param("id");
    const removed = await db
      .delete(samlApplications)
      .where(eq(samlApplications.id, applicationId))
      .returning({ id: samlApplications.id });
    if (removed.length === 0) {
      return apiError(c, 404, "NOT_FOUND", "SAML application not found");
    }
    return c.json({ ok: true as const });
  });
