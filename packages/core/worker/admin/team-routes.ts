import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";

import { createDb } from "../db/client";
import type { Database } from "../db/client";
import { mailboxes, teamMembers, teams, users } from "../db/schema";
import type { AppEnv } from "../env";
import { nonEmptyBatch } from "../lib/batch";
import type { BatchStatement } from "../lib/batch";
import { apiError } from "../lib/http";
import { createId } from "../lib/ids";
import { zValidator } from "../lib/validator";
import { insertOidcAudit } from "../oidc/service";
import { revokeLostOidcAccess } from "../sso/access";
import {
  deferWebhookTask,
  mailboxWebhookData,
  queueMailboxWebhookEvent,
} from "../webhooks/service";
import { announceMailboxAccessChanged } from "./mailbox-routes";
import { hasKnownUserIds } from "./records";
import { personTeamsSchema, teamInputSchema } from "./schemas";
import { userTargetRefusal } from "./target-guard";

async function teamMailboxIds(db: Database, teamIds: readonly string[]) {
  const rows = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(inArray(mailboxes.teamId, [...teamIds]));

  return rows.map((row) => row.id);
}

/**
 * Changing who is on a team acts on each person added, removed or whose
 * send rights change, as `/teams/person/:id` does; a team for everyone
 * covers administrators, so only they may make one or end it.
 */
async function membershipRefusal(
  c: Context<AppEnv>,
  db: Database,
  userIds: Iterable<string>,
  coversEveryone: boolean
) {
  if (coversEveryone && c.get("user").role !== "admin") {
    return apiError(
      c,
      403,
      "FORBIDDEN",
      "Only administrators can change a team for everyone"
    );
  }

  const refusals = await Promise.all(
    [...new Set(userIds)].map((userId) => userTargetRefusal(c, db, userId))
  );

  const refusal = refusals.find(Boolean);

  return refusal
    ? apiError(c, refusal.status, refusal.code, refusal.message)
    : null;
}

/** Who is on a team now, with their send rights; an everyone team keeps no rows. */
async function currentMembers(db: Database, teamId: string) {
  const rows = await db
    .select({ userId: teamMembers.userId, canSend: teamMembers.canSend })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));

  return new Map(rows.map((row) => [row.userId, row.canSend]));
}

/** Team membership is mailbox access: announce the change for each team mailbox. */
async function announceMailboxAccess(
  c: Context<AppEnv>,
  db: Database,
  mailboxIds: string[]
) {
  const changed = await Promise.all(
    mailboxIds.map((id) => mailboxWebhookData(db, id))
  );

  for (const mailbox of changed) {
    if (!mailbox) continue;
    deferWebhookTask(
      (task) => c.executionCtx.waitUntil(task),
      (eventId) =>
        queueMailboxWebhookEvent(c.env, "mailbox.updated", mailbox, eventId)
    );
  }
}

/** An "everyone" team keeps no member rows: its membership is the workspace. */
function memberRows(
  teamId: string,
  input: {
    everyone: boolean;
    members: { userId: string; canSend: boolean }[];
  },
  now: Date
) {
  return (input.everyone ? [] : input.members).map((member) => ({
    teamId,
    userId: member.userId,
    canSend: member.canSend,
    createdAt: now,
  }));
}

export const teamAdminRoutes = new Hono<AppEnv>()
  .post("/teams", zValidator("json", teamInputSchema), async (c) => {
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);

    if (
      !(await hasKnownUserIds(
        db,
        input.members.map((member) => member.userId)
      ))
    ) {
      return apiError(c, 400, "BAD_REQUEST", "Unknown team member");
    }

    const id = createId("team");
    const now = new Date();
    const members = memberRows(id, input, now);

    try {
      await db.batch([
        db.insert(teams).values({
          id,
          name: input.name,
          slug: input.slug,
          description: input.description,
          everyone: input.everyone,
          createdByUserId: c.get("user").id,
          createdAt: now,
          updatedAt: now,
        }),
        ...(members.length ? [db.insert(teamMembers).values(members)] : []),
        insertOidcAudit(db, {
          eventType: "team.created",
          actorUserId: c.get("user").id,
          detail: { teamId: id },
        }),
      ]);
    } catch {
      return apiError(c, 409, "CONFLICT", "Team handle is already in use");
    }

    return c.json({ ok: true as const, teamId: id }, 201);
  })
  .patch("/teams/:id", zValidator("json", teamInputSchema), async (c) => {
    const input = c.req.valid("json");
    const teamId = c.req.param("id");
    const db = createDb(c.env.DB);

    if (
      !(await hasKnownUserIds(
        db,
        input.members.map((member) => member.userId)
      ))
    ) {
      return apiError(c, 400, "BAD_REQUEST", "Unknown team member");
    }

    const [team] = await db
      .select({ id: teams.id, everyone: teams.everyone })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);

    if (!team) return apiError(c, 404, "NOT_FOUND", "Team not found");
    const now = new Date();
    const members = memberRows(teamId, input, now);
    const before = await currentMembers(db, teamId);
    const after = new Map(members.map((row) => [row.userId, row.canSend]));

    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
      (userId) => before.get(userId) !== after.get(userId)
    );

    const refused = await membershipRefusal(
      c,
      db,
      changed,
      team.everyone !== input.everyone
    );

    if (refused) return refused;

    try {
      await db.batch([
        db
          .update(teams)
          .set({
            name: input.name,
            slug: input.slug,
            description: input.description,
            everyone: input.everyone,
            updatedAt: now,
          })
          .where(eq(teams.id, teamId)),
        db.delete(teamMembers).where(eq(teamMembers.teamId, teamId)),
        ...(members.length ? [db.insert(teamMembers).values(members)] : []),
        insertOidcAudit(db, {
          eventType: "team.updated",
          actorUserId: c.get("user").id,
          detail: { teamId },
        }),
      ]);
    } catch {
      return apiError(c, 409, "CONFLICT", "Team handle is already in use");
    }

    await announceMailboxAccess(c, db, await teamMailboxIds(db, [teamId]));
    await announceMailboxAccessChanged(c.env, (task) =>
      c.executionCtx.waitUntil(task)
    );
    // Team membership is also access to SSO apps.
    await revokeLostOidcAccess(c.env);

    return c.json({ ok: true as const });
  })
  /** Puts one person on exactly these teams; Everyone needs no membership. */
  .put(
    "/teams/person/:userId",
    zValidator("json", personTeamsSchema),
    async (c) => {
      const { teamIds } = c.req.valid("json");
      const userId = c.req.param("userId");
      const db = createDb(c.env.DB);

      const [person] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (!person) return apiError(c, 404, "NOT_FOUND", "User not found");

      const wanted = teamIds.length
        ? await db
            .select({ id: teams.id, everyone: teams.everyone })
            .from(teams)
            .where(inArray(teams.id, teamIds))
        : [];

      if (wanted.length !== teamIds.length) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown team");
      }

      if (wanted.some((team) => team.everyone)) {
        return apiError(
          c,
          400,
          "BAD_REQUEST",
          "Everyone already includes every active person"
        );
      }

      const current = (
        await db
          .select({ teamId: teamMembers.teamId })
          .from(teamMembers)
          .where(eq(teamMembers.userId, userId))
      ).map((row) => row.teamId);

      const added = teamIds.filter((id) => !current.includes(id));
      const removed = current.filter((id) => !teamIds.includes(id));

      if (!added.length && !removed.length) {
        return c.json({ ok: true as const });
      }

      const now = new Date();
      const statements: BatchStatement[] = [];

      if (removed.length) {
        statements.push(
          db
            .delete(teamMembers)
            .where(
              and(
                eq(teamMembers.userId, userId),
                inArray(teamMembers.teamId, removed)
              )
            )
        );
      }

      if (added.length) {
        statements.push(
          db.insert(teamMembers).values(
            added.map((teamId) => ({
              teamId,
              userId,
              canSend: true,
              createdAt: now,
            }))
          )
        );
      }

      for (const teamId of [...added, ...removed]) {
        statements.push(
          insertOidcAudit(db, {
            eventType: "team.updated",
            actorUserId: c.get("user").id,
            detail: { teamId },
          })
        );
      }

      const batch = nonEmptyBatch(statements);

      if (batch) await db.batch(batch);
      await announceMailboxAccess(
        c,
        db,
        await teamMailboxIds(db, [...added, ...removed])
      );

      if (removed.length) {
        await announceMailboxAccessChanged(c.env, (task) =>
          c.executionCtx.waitUntil(task)
        );
      }

      await revokeLostOidcAccess(c.env);

      return c.json({ ok: true as const });
    }
  )
  .delete("/teams/:id", async (c) => {
    const db = createDb(c.env.DB);
    const teamId = c.req.param("id");

    const [team] = await db
      .select({ id: teams.id, everyone: teams.everyone })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);

    if (!team) return apiError(c, 404, "NOT_FOUND", "Team not found");

    const refused = await membershipRefusal(
      c,
      db,
      (await currentMembers(db, teamId)).keys(),
      team.everyone
    );

    if (refused) return refused;

    if ((await teamMailboxIds(db, [teamId])).length > 0) {
      return apiError(
        c,
        409,
        "CONFLICT",
        "Move the team's mailboxes to another team or delete them first"
      );
    }

    await db.batch([
      db.delete(teams).where(eq(teams.id, teamId)),
      insertOidcAudit(db, {
        eventType: "team.deleted",
        actorUserId: c.get("user").id,
        detail: { teamId },
      }),
    ]);
    await revokeLostOidcAccess(c.env);

    return c.json({ ok: true as const });
  });
