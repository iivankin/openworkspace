import { zValidator } from "@hono/zod-validator";
import { and, eq, exists, notExists } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "../db/client";
import { domains, mailboxes } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import { createDomainSchema, updateDomainSchema } from "./schemas";

export const domainAdminRoutes = new Hono<AppEnv>()
  .post(
    "/domains",
    zValidator("json", createDomainSchema),
    async (c) => {
      const db = createDb(c.env.DB);
      const input = c.req.valid("json");
      const id = createId("dom");
      const now = new Date();
      try {
        await db.insert(domains).values({
          id,
          name: input.name,
          cloudflareZoneId: input.cloudflareZoneId,
          isPrimary: false,
          createdByUserId: c.get("user").id,
          createdAt: now,
          updatedAt: now,
        });
      } catch {
        return apiError(c, 409, "CONFLICT", "Domain is already configured");
      }
      return c.json({ ok: true as const, domainId: id }, 201);
    },
  )
  .patch(
    "/domains/:id",
    zValidator("json", updateDomainSchema),
    async (c) => {
      const db = createDb(c.env.DB);
      const domainId = c.req.param("id");
      const input = c.req.valid("json");
      const now = new Date();
      if (input.isPrimary) {
        const targetExists = exists(
          db
            .select({ id: domains.id })
            .from(domains)
            .where(eq(domains.id, domainId)),
        );
        const [, updated] = await db.batch([
          db
            .update(domains)
            .set({ isPrimary: false, updatedAt: now })
            .where(and(eq(domains.isPrimary, true), targetExists)),
          db
            .update(domains)
            .set({
              isPrimary: true,
              ...(input.cloudflareZoneId !== undefined
                ? { cloudflareZoneId: input.cloudflareZoneId }
                : {}),
              updatedAt: now,
            })
            .where(eq(domains.id, domainId))
            .returning({ id: domains.id }),
        ]);
        if (updated.length === 0) {
          return apiError(c, 404, "NOT_FOUND", "Domain not found");
        }
      } else {
        const [updated] = await db
          .update(domains)
          .set({
            cloudflareZoneId: input.cloudflareZoneId,
            updatedAt: now,
          })
          .where(eq(domains.id, domainId))
          .returning({ id: domains.id });
        if (!updated) {
          return apiError(c, 404, "NOT_FOUND", "Domain not found");
        }
      }
      return c.json({ ok: true as const });
    },
  )
  .delete("/domains/:id", async (c) => {
    const db = createDb(c.env.DB);
    const domainId = c.req.param("id");
    const [deleted] = await db
      .delete(domains)
      .where(and(
        eq(domains.id, domainId),
        eq(domains.isPrimary, false),
        notExists(
          db
            .select({ id: mailboxes.id })
            .from(mailboxes)
            .where(eq(mailboxes.domainId, domainId)),
        ),
      ))
      .returning({ id: domains.id });
    if (deleted) return c.json({ ok: true as const, domainId });

    const [domain] = await db
      .select({ isPrimary: domains.isPrimary })
      .from(domains)
      .where(eq(domains.id, domainId))
      .limit(1);
    if (!domain) return c.json({ ok: true as const, domainId });
    if (domain.isPrimary) {
      return apiError(c, 409, "CONFLICT", "Primary domain cannot be deleted");
    }
    return apiError(c, 409, "CONFLICT", "Delete this domain's mailboxes first");
  });
