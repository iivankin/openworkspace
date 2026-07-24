import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import type { AccessLinkKind } from "../../shared/auth";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { createDb, type Database } from "../db/client";
import {
  accessLinks,
  installations,
  mailboxMembers,
  mailboxes,
  users,
} from "../db/schema";
import type { AppEnv } from "../env";
import { randomToken, hashToken } from "../lib/crypto";
import { apiError } from "../lib/http";
import { createId, emailDomain, normalizeMailboxAddress } from "../lib/ids";
import {
  INSTALLATION_ID,
  INVITATION_TTL_MS,
  RECOVERY_TTL_MS,
} from "../auth/constants";
import { personalAccountRecords } from "../auth/personal-account";
import {
  createInvitationSchema,
  createMailboxSchema,
  updateMailboxSchema,
  updateUserSchema,
} from "./schemas";

type MailboxMemberInput = {
  userId: string;
  canSend: boolean;
};

async function hasKnownUsers(db: Database, members: MailboxMemberInput[]) {
  const ids = members.map((member) => member.userId);
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, ids));
  return rows.length === ids.length;
}

async function installationDomain(db: Database) {
  const [installation] = await db
    .select({ domain: installations.domain })
    .from(installations)
    .where(eq(installations.id, INSTALLATION_ID))
    .limit(1);
  return installation?.domain ?? null;
}

async function prepareAccessLink(input: {
  kind: AccessLinkKind;
  userId: string;
  createdByUserId: string;
  requestUrl: string;
  now: Date;
}) {
  const token = randomToken();
  const expiresAt = new Date(
    input.now.getTime()
      + (input.kind === "invitation" ? INVITATION_TTL_MS : RECOVERY_TTL_MS),
  );
  return {
    values: {
      id: createId("lnk"),
      kind: input.kind,
      userId: input.userId,
      tokenHash: await hashToken(token),
      createdByUserId: input.createdByUserId,
      expiresAt,
      createdAt: input.now,
    },
    result: {
      kind: input.kind,
      url: new URL(
        `/${input.kind === "invitation" ? "invite" : "recover"}/${token}`,
        input.requestUrl,
      ).toString(),
      expiresAt,
      userId: input.userId,
    },
  };
}

export const adminRoutes = new Hono<AppEnv>()
  .use("*", requireAuth, requireAdmin)
  .get("/state", async (c) => {
    const db = createDb(c.env.DB);
    const [userRows, mailboxRows, memberships] = await Promise.all([
      db
        .select({
          id: users.id,
          name: users.name,
          avatarUrl: users.avatarUrl,
          role: users.role,
          status: users.status,
          createdAt: users.createdAt,
          personalEmail: mailboxes.address,
        })
        .from(users)
        .leftJoin(mailboxes, eq(mailboxes.personalOwnerId, users.id))
        .orderBy(desc(users.createdAt)),
      db.select().from(mailboxes).orderBy(mailboxes.kind, mailboxes.displayName),
      db
        .select({
          mailboxId: mailboxMembers.mailboxId,
          userId: mailboxMembers.userId,
          canSend: mailboxMembers.canSend,
        })
        .from(mailboxMembers)
        .innerJoin(mailboxes, eq(mailboxMembers.mailboxId, mailboxes.id))
        .where(eq(mailboxes.kind, "shared")),
    ]);
    return c.json({
      ok: true as const,
      users: userRows,
      mailboxes: mailboxRows.map((mailbox) => ({
        ...mailbox,
        members: memberships
          .filter((member) => member.mailboxId === mailbox.id)
          .map(({ userId, canSend }) => ({
            userId,
            canSend,
          })),
      })),
    });
  })
  .post(
    "/mailboxes",
    zValidator("json", createMailboxSchema),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const domain = await installationDomain(db);
      if (!domain || emailDomain(input.address) !== domain) {
        return apiError(c, 400, "BAD_REQUEST", `Mailbox must use @${domain ?? "the workspace domain"}`);
      }
      if (!(await hasKnownUsers(db, input.members))) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown mailbox member");
      }
      const id = createId("mbx");
      const now = new Date();
      try {
        await db.batch([
          db.insert(mailboxes).values({
            id,
            address: normalizeMailboxAddress(input.address),
            displayName: input.displayName,
            kind: "shared",
            createdByUserId: c.get("user").id,
            createdAt: now,
            updatedAt: now,
          }),
          ...input.members.map((member) =>
            db.insert(mailboxMembers).values({
              mailboxId: id,
              userId: member.userId,
              canSend: member.canSend,
              createdAt: now,
            }),
          ),
        ]);
      } catch {
        return apiError(c, 409, "CONFLICT", "Mailbox address is already in use");
      }
      return c.json({ ok: true as const, mailboxId: id }, 201);
    },
  )
  .patch(
    "/mailboxes/:id",
    zValidator("json", updateMailboxSchema),
    async (c) => {
      const db = createDb(c.env.DB);
      const mailboxId = c.req.param("id");
      const input = c.req.valid("json");
      const [mailbox] = await db
        .select({ id: mailboxes.id, kind: mailboxes.kind })
        .from(mailboxes)
        .where(eq(mailboxes.id, mailboxId))
        .limit(1);
      if (!mailbox) return apiError(c, 404, "NOT_FOUND", "Mailbox not found");
      if (mailbox.kind !== "shared") {
        return apiError(c, 400, "BAD_REQUEST", "Personal mailbox access follows its owner");
      }
      if (!(await hasKnownUsers(db, input.members))) {
        return apiError(c, 400, "BAD_REQUEST", "Unknown mailbox member");
      }
      const now = new Date();
      await db.batch([
        db
          .update(mailboxes)
          .set({ displayName: input.displayName, updatedAt: now })
          .where(eq(mailboxes.id, mailboxId)),
        db.delete(mailboxMembers).where(eq(mailboxMembers.mailboxId, mailboxId)),
        ...input.members.map((member) =>
          db.insert(mailboxMembers).values({
            mailboxId,
            userId: member.userId,
            canSend: member.canSend,
            createdAt: now,
          }),
        ),
      ]);
      return c.json({ ok: true as const });
    },
  )
  .post(
    "/invitations",
    zValidator("json", createInvitationSchema),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const domain = await installationDomain(db);
      if (!domain || emailDomain(input.email) !== domain) {
        return apiError(c, 400, "BAD_REQUEST", `Personal mailbox must use @${domain ?? "the workspace domain"}`);
      }
      const admin = c.get("user");
      const userId = createId("usr");
      const mailboxId = createId("mbx");
      const now = new Date();
      const account = personalAccountRecords({
        userId,
        mailboxId,
        name: input.name,
        email: input.email,
        avatarUrl: input.avatarUrl,
        role: "member",
        status: "invited",
        createdByUserId: admin.id,
        now,
      });
      const invitation = await prepareAccessLink({
        kind: "invitation",
        userId,
        createdByUserId: admin.id,
        requestUrl: c.req.url,
        now,
      });

      try {
        await db.batch([
          db.insert(users).values(account.user),
          db.insert(mailboxes).values(account.mailbox),
          db.insert(mailboxMembers).values(account.membership),
          db.insert(accessLinks).values(invitation.values),
        ]);
      } catch {
        return apiError(c, 409, "CONFLICT", "Email address is already in use");
      }

      return c.json(
        { ok: true as const, accessLink: invitation.result },
        201,
      );
    },
  )
  .post("/users/:id/access-link", async (c) => {
    const db = createDb(c.env.DB);
    const userId = c.req.param("id");
    const [target] = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!target) return apiError(c, 404, "NOT_FOUND", "User not found");

    const admin = c.get("user");
    const now = new Date();
    const kind: AccessLinkKind = target.status === "invited"
      ? "invitation"
      : "recovery";
    const accessLink = await prepareAccessLink({
      kind,
      userId,
      createdByUserId: admin.id,
      requestUrl: c.req.url,
      now,
    });
    await db.batch([
      db
        .delete(accessLinks)
        .where(
          and(
            eq(accessLinks.userId, userId),
            eq(accessLinks.kind, kind),
            isNull(accessLinks.consumedAt),
          ),
        ),
      db.insert(accessLinks).values(accessLink.values),
    ] as const);

    return c.json(
      {
        ok: true as const,
        accessLink: accessLink.result,
      },
      201,
    );
  })
  .patch(
    "/users/:id",
    zValidator("json", updateUserSchema),
    async (c) => {
      const db = createDb(c.env.DB);
      const userId = c.req.param("id");
      const input = c.req.valid("json");
      const [target] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!target) return apiError(c, 404, "NOT_FOUND", "User not found");

      const now = new Date();
      await db.batch([
        db
          .update(users)
          .set({
            name: input.name,
            avatarUrl: input.avatarUrl,
            updatedAt: now,
          })
          .where(eq(users.id, userId)),
        db
          .update(mailboxes)
          .set({
            displayName: input.name,
            updatedAt: now,
          })
          .where(eq(mailboxes.personalOwnerId, userId)),
      ]);
      return c.json({ ok: true as const });
    },
  );
