import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../worker/db/client";
import { mailboxMembers, mailboxes, users } from "../worker/db/schema";
import { mailboxStub } from "../worker/mailbox";

describe("read-only mailbox access", () => {
  it("can read stored mail but cannot send or send again", async () => {
    const bootstrap = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
      }),
    );
    expect(bootstrap.status).toBe(200);
    await bootstrap.json();

    const db = createDb(env.DB);
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1);
    const userId = `usr_read_only_${crypto.randomUUID()}`;
    const mailboxId = `mbx_read_only_${crypto.randomUUID()}`;
    const now = new Date();
    await db.batch([
      db.insert(users).values({
        id: userId,
        name: "Reader",
        role: "member",
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(mailboxes).values({
        id: mailboxId,
        address: "readonly@example.test",
        displayName: "Read only",
        kind: "shared",
        createdByUserId: admin!.id,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(mailboxMembers).values({
        mailboxId,
        userId,
        canSend: false,
        createdAt: now,
      }),
    ] as const);

    const mailbox = mailboxStub(env, mailboxId);
    await mailbox.seedMailbox([], [
      {
        id: "msg_visible_incoming",
        conversationId: "conv_visible",
        direction: "incoming",
        messageIdHeader: "<visible@example.net>",
        fromJson: [{ address: "visible@example.net", name: null }],
        toJson: [{ address: "readonly@example.test", name: null }],
        subject: "Visible incoming",
        timelineAt: now,
        transportState: "received",
      },
      {
        id: "msg_visible_unconfirmed",
        conversationId: "conv_visible_failed",
        direction: "outgoing",
        fromJson: [{ address: "readonly@example.test", name: null }],
        toJson: [{ address: "recipient@example.net", name: null }],
        subject: "Visible failed send",
        timelineAt: now,
        transportState: "unconfirmed",
      },
    ]);

    const login = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      }),
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    await login.json();

    const list = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/conversations?mailboxId=${mailboxId}&folder=inbox`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      conversations: [{ conversationId: "conv_visible" }],
    });

    const conversation = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/conversations/conv_visible?mailboxId=${mailboxId}`,
        { headers: { cookie: cookie! } },
      ),
    );
    expect(conversation.status).toBe(200);
    await conversation.json();

    const compose = await exports.default.fetch(
      new Request("http://example.test/api/mail/messages", {
        method: "POST",
        headers: { cookie: cookie!, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          mailboxId,
          to: ["recipient@example.net"],
          subject: "Forbidden compose",
          bodyText: "A read-only member cannot send.",
        }),
      }),
    );
    expect(compose.status).toBe(403);
    await compose.json();

    const resend = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/messages/msg_visible_unconfirmed/send-again?mailboxId=${mailboxId}`,
        { method: "POST", headers: { cookie: cookie! } },
      ),
    );
    expect(resend.status).toBe(403);
    await resend.json();
  });
});
