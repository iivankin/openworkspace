import {
  apiError,
  can,
  createDb,
  mailboxes,
  requireAuth,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";

import { createDestinations, destinationStatuses } from "./email-routing";

async function forwardAddress(db: D1Database, mailboxId: string) {
  const [row] = await createDb(db)
    .select({
      ownerUserId: mailboxes.ownerUserId,
      delivery: mailboxes.delivery,
      forwardTo: mailboxes.forwardTo,
    })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId))
    .limit(1);

  return row ?? null;
}

/**
 * Core's `mailboxSaved` hook: a forward's destinations that Email Routing
 * doesn't know yet are added, and Cloudflare emails each its confirmation.
 */
export async function addForwardDestinations(env: Env, mailboxId: string) {
  const address = await forwardAddress(env.DB, mailboxId);

  if (address?.delivery === "forward" && address.forwardTo?.length) {
    await createDestinations(env, address.forwardTo);
  }
}

/**
 * A forward's saved destinations, if the signed-in person manages the
 * address: null when it doesn't exist, false when they may not manage it.
 */
async function managedForward(c: Context<AppEnv>, mailboxId: string) {
  const address = await forwardAddress(c.env.DB, mailboxId);

  if (!address) return null;

  if (!can(c, address.ownerUserId ? "manage_people" : "manage_teams")) {
    return false;
  }

  return address.delivery === "forward" ? (address.forwardTo ?? []) : [];
}

const notFound = "Address not found";
const forbidden = "You do not have permission to manage this address";

/**
 * A forward's saved destinations for the address editor under People or
 * Teams, which only people who manage that address see: whether each
 * confirmed Cloudflare's email, or is missing from Email Routing because
 * adding it failed. Saving the address in the editor adds missing ones
 * again (POST), so a failure shows there instead of only in the logs.
 */
export const forwardDestinationRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/:mailboxId", async (c) => {
    const forwardTo = await managedForward(c, c.req.param("mailboxId"));

    if (forwardTo === null) return apiError(c, 404, "NOT_FOUND", notFound);

    if (forwardTo === false) return apiError(c, 403, "FORBIDDEN", forbidden);

    const statuses = forwardTo.length ? await destinationStatuses(c.env) : null;

    return c.json({
      ok: true as const,
      /** False in local development, where there is no Email Routing. */
      connected: statuses !== null || !forwardTo.length,
      destinations: forwardTo.map((email) => ({
        email,
        /** Null when Email Routing isn't connected. */
        status: statuses
          ? (statuses.get(email.toLowerCase()) ?? ("missing" as const))
          : null,
      })),
    });
  })
  .post("/:mailboxId", async (c) => {
    const forwardTo = await managedForward(c, c.req.param("mailboxId"));

    if (forwardTo === null) return apiError(c, 404, "NOT_FOUND", notFound);

    if (forwardTo === false) return apiError(c, 403, "FORBIDDEN", forbidden);

    try {
      await createDestinations(c.env, forwardTo);
    } catch (error) {
      console.error("Could not add forward destinations", error);

      return apiError(
        c,
        502,
        "BAD_GATEWAY",
        "Cloudflare didn't add the forward destinations; save again to retry"
      );
    }

    return c.json({ ok: true as const });
  });
