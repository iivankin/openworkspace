import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { MAILBOX_REALTIME_UPDATE } from "../shared/mail";
import { mailboxStub } from "../worker/mailbox";

let session: { cookie: string; mailboxId: string; userId: string };

beforeAll(async () => {
  const response = await exports.default.fetch(
    new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const mailboxes = await exports.default.fetch(
    new Request("http://example.test/api/mail/mailboxes", {
      headers: { cookie: cookie! },
    }),
  );
  const body = await mailboxes.json() as { mailboxes: Array<{ id: string }> };
  const membership = await env.DB.prepare(
    "SELECT user_id FROM mailbox_members WHERE mailbox_id = ? LIMIT 1",
  ).bind(body.mailboxes[0]!.id).first<{ user_id: string }>();
  expect(membership).toBeTruthy();
  session = {
    cookie: cookie!,
    mailboxId: body.mailboxes[0]!.id,
    userId: membership!.user_id,
  };
});

describe("mailbox realtime", () => {
  it("authenticates the upgrade and broadcasts read changes", async () => {
    const { cookie, mailboxId } = session;
    const stub = mailboxStub(env, mailboxId);
    await stub.seedMailbox([], [{
      id: "msg_realtime_read",
      conversationId: "conv_realtime_read",
      direction: "incoming",
      fromJson: [{ address: "sender@example.net", name: "Sender" }],
      toJson: [{ address: "admin@example.test", name: null }],
      subject: "Realtime read",
      timelineAt: new Date(),
      transportState: "received",
    }]);

    const upgrade = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/realtime`,
        {
          headers: {
            cookie,
            origin: "http://example.test",
            upgrade: "websocket",
          },
        },
      ),
    );
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket!;
    socket.accept();
    const nextEvent = new Promise<string>((resolve) => {
      socket.addEventListener("message", (message) => {
        resolve(String(message.data));
      }, { once: true });
    });

    const read = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/messages/msg_realtime_read/read?mailboxId=${mailboxId}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ isRead: true }),
        },
      ),
    );
    expect(read.status).toBe(200);
    await expect(nextEvent).resolves.toBe(MAILBOX_REALTIME_UPDATE);
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
    });
    socket.close(1000, "Test complete");
    await closed;
    await expect(
      stub.suppressedPushUserIds(
        "msg_realtime_read",
        [session.userId, "usr_unread"],
      ),
    ).resolves.toEqual([session.userId]);
  });

  it("rejects a cross-origin WebSocket request", async () => {
    const { cookie, mailboxId } = session;
    const response = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/realtime`,
        {
          headers: {
            cookie,
            origin: "https://attacker.example",
            upgrade: "websocket",
          },
        },
      ),
    );
    expect(response.status).toBe(403);
  });

  it("closes a socket before broadcasting after mailbox access is revoked", async () => {
    const { cookie, mailboxId } = session;
    const membership = await env.DB.prepare(
      "SELECT user_id, can_send FROM mailbox_members WHERE mailbox_id = ? LIMIT 1",
    ).bind(mailboxId).first<{ user_id: string; can_send: number }>();
    expect(membership).toBeTruthy();
    const stub = mailboxStub(env, mailboxId);
    await stub.seedMailbox([], [{
      id: "msg_realtime_revoked",
      conversationId: "conv_realtime_revoked",
      direction: "incoming",
      fromJson: [{ address: "sender@example.net", name: "Sender" }],
      toJson: [{ address: "admin@example.test", name: null }],
      subject: "Revoked realtime",
      timelineAt: new Date(),
      transportState: "received",
    }]);
    const upgrade = await exports.default.fetch(
      new Request(
        `http://example.test/api/mail/mailboxes/${mailboxId}/realtime`,
        {
          headers: {
            cookie,
            origin: "http://example.test",
            upgrade: "websocket",
          },
        },
      ),
    );
    const socket = upgrade.webSocket!;
    socket.accept();
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener("close", (event) => resolve(event.code), { once: true });
    });

    await env.DB.prepare(
      "DELETE FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?",
    ).bind(mailboxId, membership!.user_id).run();
    await stub.setMessageRead(membership!.user_id, "msg_realtime_revoked", true);
    await expect(closed).resolves.toBe(1008);
    await env.DB.prepare(`
      INSERT INTO mailbox_members (mailbox_id, user_id, can_send)
      VALUES (?, ?, ?)
    `).bind(mailboxId, membership!.user_id, membership!.can_send).run();
  });
});

describe("notification preferences", () => {
  it("binds a push registration to the current session", async () => {
    const endpoint = `https://push.example.test/${crypto.randomUUID()}`;
    const create = await exports.default.fetch(
      new Request("http://example.test/api/notifications/subscriptions", {
        method: "POST",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          endpoint,
          keys: {
            p256dh: env.VAPID_PUBLIC_KEY,
            auth: "AAAAAAAAAAAAAAAAAAAAAA",
          },
        }),
      }),
    );
    expect(create.status).toBe(201);
    const status = await exports.default.fetch(
      new Request("http://example.test/api/notifications/subscriptions/status", {
        method: "POST",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({ endpoint }),
      }),
    );
    await expect(status.json()).resolves.toMatchObject({ registered: true });

    const remove = await exports.default.fetch(
      new Request("http://example.test/api/notifications/subscriptions", {
        method: "DELETE",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({ endpoint }),
      }),
    );
    expect(remove.status).toBe(200);
  });

  it("rejects malformed browser push keys", async () => {
    const create = await exports.default.fetch(
      new Request("http://example.test/api/notifications/subscriptions", {
        method: "POST",
        headers: { cookie: session.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: `https://push.example.test/${crypto.randomUUID()}`,
          keys: { p256dh: "not-a-p256-key", auth: "too-short" },
        }),
      }),
    );
    expect(create.status).toBe(400);
  });

  it("removes expired sessions and their push registrations on login", async () => {
    const expiredTokenHash = `expired_${crypto.randomUUID()}`;
    const expiredSessionId = `ses_${crypto.randomUUID()}`;
    const pushSubscriptionId = `push_${crypto.randomUUID()}`;
    const endpoint = `https://push.example.test/${crypto.randomUUID()}`;
    const now = Date.now();
    await env.DB.prepare(`
      INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      expiredSessionId,
      expiredTokenHash,
      session.userId,
      now - 1,
      now - 60_000,
    ).run();
    await env.DB.prepare(`
      INSERT INTO push_subscriptions (id, session_id, endpoint, p256dh, auth)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      pushSubscriptionId,
      expiredSessionId,
      endpoint,
      env.VAPID_PUBLIC_KEY,
      "AAAAAAAAAAAAAAAAAAAAAA",
    ).run();

    const login = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: session.userId }),
      }),
    );
    expect(login.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE token_hash = ?",
      ).bind(expiredTokenHash).first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM push_subscriptions WHERE id = ?",
      ).bind(pushSubscriptionId).first<{ count: number }>(),
    ).toMatchObject({ count: 0 });
  });

  it("defaults each accessible mailbox to enabled and stores a personal override", async () => {
    const { cookie, mailboxId } = session;
    const initial = await exports.default.fetch(
      new Request("http://example.test/api/notifications/preferences", {
        headers: { cookie },
      }),
    );
    expect(await initial.json()).toMatchObject({
      preferences: [{ mailboxId, enabled: true }],
    });

    const update = await exports.default.fetch(
      new Request(
        `http://example.test/api/notifications/preferences/${mailboxId}`,
        {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      ),
    );
    expect(update.status).toBe(200);

    const changed = await exports.default.fetch(
      new Request("http://example.test/api/notifications/preferences", {
        headers: { cookie },
      }),
    );
    expect(await changed.json()).toMatchObject({
      preferences: [{ mailboxId, enabled: false }],
    });
  });
});
