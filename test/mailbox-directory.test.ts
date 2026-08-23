import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  listActiveMailboxSessions,
  listMailboxUsersByIds,
} from "../worker/mail/mailbox-directory";

let directory: {
  mailboxId: string;
  sessionId: string;
  userId: string;
  userName: string;
};

beforeAll(async () => {
  const userName = "Directory Admin";
  const bootstrap = await exports.default.fetch(
    new Request("http://example.test/api/auth/mock/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: userName, email: "directory-admin@example.test" }),
    }),
  );
  expect(bootstrap.status).toBe(200);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  await bootstrap.json();

  const mailboxes = await exports.default.fetch(
    new Request("http://example.test/api/mail/mailboxes", {
      headers: { cookie: cookie! },
    }),
  );
  const mailboxBody = await mailboxes.json() as {
    mailboxes: Array<{ id: string }>;
  };
  const mailboxId = mailboxBody.mailboxes[0]!.id;
  const stored = await env.DB.prepare(`
    select session.id as session_id, session.user_id
    from sessions session
    inner join mailbox_members member on member.user_id = session.user_id
    where member.mailbox_id = ?
    limit 1
  `).bind(mailboxId).first<{ session_id: string; user_id: string }>();
  expect(stored).toBeTruthy();
  directory = {
    mailboxId,
    sessionId: stored!.session_id,
    userId: stored!.user_id,
    userName,
  };
});

describe("mailbox D1 directory queries", () => {
  it("accepts session and user ID sets larger than the D1 parameter limit", async () => {
    const missingIds = Array.from(
      { length: 150 },
      (_, index) => `missing_${index}`,
    );

    await expect(listActiveMailboxSessions(
      env.DB,
      directory.mailboxId,
      [...missingIds, directory.sessionId],
      Date.now(),
    )).resolves.toEqual([{
      id: directory.sessionId,
      tokenHash: expect.any(String),
      userId: directory.userId,
    }]);
    await expect(listMailboxUsersByIds(
      env.DB,
      directory.mailboxId,
      [...missingIds, directory.userId],
    )).resolves.toEqual([{
      id: directory.userId,
      name: directory.userName,
    }]);
  });
});
