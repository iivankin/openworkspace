import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import PostalMime from "postal-mime";
import { z } from "zod";

import { fakeEmailRouting } from "./fake-email-routing.ts";
import { readJson } from "./json.ts";
import { bootstrapAdmin, drainInbound } from "./mail-flow-helpers.ts";
import { runAlarmUntil } from "./mailbox-helpers.ts";
import { pollUntil } from "./poll.ts";
import { env, hooks, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/**
 * The write-once mail archive through the real paths: Email Routing's
 * handler, sending through the API, permanent deletion, and the hourly cron.
 */

const origin = "http://example.test";
let cookie = "";
let mailboxId = "";

const entryRow = z.object({
  id: z.string(),
  direction: z.enum(["incoming", "outgoing"]),
  status: z.enum(["pending", "archived", "failed", "abandoned"]),
  source_key: z.string().nullable(),
  archive_key: z.string(),
  sha256: z.string().nullable(),
  attempts: z.number(),
  last_error: z.string().nullable(),
});

async function entries() {
  const { results } = await env.DB.prepare(
    "SELECT * FROM mail_archive_entries ORDER BY created_at"
  ).all();

  return z.array(entryRow).parse(results);
}

async function entryFor(direction: "incoming" | "outgoing", index = -1) {
  return required(
    (await entries())
      .filter((entry) => entry.direction === direction)
      .at(index),
    `a ${direction} archive entry`
  );
}

function raw(id: string, subject: string) {
  return [
    "From: Rosa Quill <rosa@fernhollow.example>",
    "To: ada@example.test",
    `Subject: ${subject}`,
    "Date: Tue, 03 Mar 2026 10:00:00 +0000",
    `Message-ID: <${id}@fernhollow.example>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Body of ${id}.`,
    "",
  ].join("\r\n");
}

/** `raw` for press@, failing DMARC on a domain that publishes `policy`. */
function failingDmarc(id: string, policy: "none" | "reject") {
  return [
    "Received: from mail.fernhollow.example (192.0.2.10)",
    "        by cloudflare-email.net (cloudflare) id 0123456789ab",
    "        for <press@example.test>; Tue, 03 Mar 2026 10:00:00 +0000",
    `Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=fernhollow.example policy.dmarc=${policy}; spf=fail smtp.mailfrom=rosa@fernhollow.example`,
    raw(id, `Unauthenticated ${policy}`).replace(
      "To: ada@example.test",
      "To: press@example.test"
    ),
  ].join("\r\n");
}

async function receive(id: string, subject: string) {
  const message = raw(id, subject);

  const { rejection } = await hooks.email({
    from: "rosa@fernhollow.example",
    to: "ada@example.test",
    raw: message,
  });

  expect(rejection).toBeUndefined();

  return message;
}

/** Runs the cron as if every open entry's backoff were over. */
async function retryNow() {
  await env.DB.prepare(
    "UPDATE mail_archive_entries SET updated_at = 0 WHERE status <> 'archived'"
  ).run();
  await hooks.scheduled({ scheduledTime: Date.UTC(2026, 2, 3, 10) });
}

beforeAll(async () => {
  cookie = await bootstrapAdmin("ada@example.test", "Ada Moss");
  mailboxId = z
    .object({ id: z.string() })
    .parse(
      await env.DB.prepare(
        "SELECT id FROM mailboxes WHERE local_part = 'ada'"
      ).first()
    ).id;
});

describe("mail archive", () => {
  it("copies received mail byte for byte, once", async () => {
    const message = await receive("in1", "Invoice 1042");

    // Email Routing retrying the same delivery records nothing new.
    await receive("in1", "Invoice 1042");

    const [entry, ...rest] = await entries();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ direction: "incoming", status: "archived" });

    const object = required(
      await env.MAIL_ARCHIVE.get(required(entry, "an entry").archive_key),
      "the archived copy"
    );

    expect(await object.text()).toBe(message);
    expect(object.customMetadata?.sha256).toBe(entry?.sha256 ?? "");
    expect(entry?.archive_key).toMatch(/^\d{4}\/\d{2}\/incoming\/.+\.eml$/u);
  });

  it("copies sent mail as it was handed to Email Sending", async () => {
    const sent = await hooks.fetchAndWait(`${origin}/api/mail/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        mailboxId,
        to: ["rosa@fernhollow.example"],
        subject: "Angebot für Größe ✓",
        bodyText: "Details below.",
      }),
    });

    expect(sent.status).toBe(201);

    const entry = await pollUntil(
      async () => {
        await hooks.runAlarm(mailboxId);

        const found = (await entries()).find(
          (row) => row.direction === "outgoing" && row.status === "archived"
        );

        return found ?? null;
      },
      {
        timeoutMs: 10_000,
        intervalMs: 50,
        failure: "sent mail was not archived",
      }
    );

    if (!entry) throw new Error("sent mail was not archived");

    const object = required(
      await env.MAIL_ARCHIVE.get(entry.archive_key),
      "the archived copy"
    );

    const [stored] = await hooks.mailboxRows(
      mailboxId,
      z.object({ message_id_header: z.string() }),
      "SELECT message_id_header FROM emails WHERE id = ?",
      entry.id
    );

    const parsed = await PostalMime.parse(await object.arrayBuffer());
    expect(parsed.subject).toBe("Angebot für Größe ✓");
    expect(parsed.text?.trim()).toBe("Details below.");
    expect(parsed.to).toEqual([
      { address: "rosa@fernhollow.example", name: "" },
    ]);
    // The Message-ID Email Sending returned.
    expect(parsed.messageId).toBe(
      required(stored, "the sent message").message_id_header
    );
  });

  it("keeps a permanently deleted raw message until it is archived", async () => {
    await receive("in2", "Contract draft");
    await drainInbound(mailboxId);
    const entry = await entryFor("incoming");

    const sourceKey = required(
      entry.source_key,
      "received mail has a raw copy"
    );

    // As if the copy had failed: the archive doesn't have it yet.
    await env.MAIL_ARCHIVE.delete(entry.archive_key);
    await env.DB.prepare(
      "UPDATE mail_archive_entries SET status = 'failed', attempts = 1 WHERE id = ?"
    )
      .bind(entry.id)
      .run();

    const [row] = await hooks.mailboxRows(
      mailboxId,
      z.object({ conversation_id: z.string() }),
      "SELECT conversation_id FROM emails WHERE raw_mime_r2_key = ?",
      sourceKey
    );

    const conversationId = required(
      row,
      "the message is stored"
    ).conversation_id;

    const target = mailbox(mailboxId);
    await target.bulkUpdateConversations([conversationId], "inbox", {
      mailboxState: "trash",
    });
    expect(
      await target.permanentlyDeleteConversations([conversationId])
    ).toMatchObject({
      outcome: "deleted",
    });

    const purgeDue = () =>
      hooks.mailboxSql(
        mailboxId,
        "UPDATE pending_object_deletions SET next_attempt_at = 0"
      );

    await purgeDue();
    await hooks.runAlarm(mailboxId);
    expect(await env.MAIL_STORAGE.head(sourceKey)).not.toBeNull();

    // The hourly retry archives it from the kept copy; then it can go.
    await retryNow();
    expect((await entryFor("incoming")).status).toBe("archived");
    expect(await env.MAIL_ARCHIVE.head(entry.archive_key)).not.toBeNull();

    await purgeDue();
    await runAlarmUntil(
      mailboxId,
      async () => (await env.MAIL_STORAGE.head(sourceKey)) === null
    );
  });

  it("never replaces a different object already at the key", async () => {
    await receive("in3", "Quarterly figures");
    const entry = await entryFor("incoming");

    await env.MAIL_ARCHIVE.delete(entry.archive_key);
    await env.MAIL_ARCHIVE.put(entry.archive_key, "something else", {
      customMetadata: { sha256: "0".repeat(64) },
    });
    await env.DB.prepare(
      "UPDATE mail_archive_entries SET status = 'pending' WHERE id = ?"
    )
      .bind(entry.id)
      .run();

    await retryNow();

    expect(await entryFor("incoming")).toMatchObject({
      status: "failed",
      attempts: 1,
      last_error: `${entry.archive_key} is already archived with different content`,
    });
    expect(await (await env.MAIL_ARCHIVE.get(entry.archive_key))?.text()).toBe(
      "something else"
    );

    const status = await readJson(
      await worker.fetch(
        new Request(`${origin}/api/mail/archive`, { headers: { cookie } })
      ),
      z.looseObject({
        enabled: z.boolean(),
        years: z.number().nullable(),
        failed: z.number(),
        open: z.array(
          z.looseObject({
            mailbox: z.string().nullable(),
            lastError: z.string().nullable(),
          })
        ),
      })
    );

    expect(status).toMatchObject({ enabled: true, years: 10, failed: 1 });
    expect(status.open.map((open) => open.mailbox)).toEqual([
      "ada@example.test",
    ]);
  });

  it("accepts mail when D1 can't record it, and the hourly pass picks it up", async () => {
    // A first delivery gives the message's id and archive key.
    const message = await receive("in4", "Delivery note");
    const entry = await entryFor("incoming");
    const stagingKey = `archive-staging/${entry.id}.eml`;

    await env.DB.prepare("DELETE FROM mail_archive_entries WHERE id = ?")
      .bind(entry.id)
      .run();
    // The archive refuses the copy, and D1 can't record it.
    await env.MAIL_ARCHIVE.delete(entry.archive_key);
    await env.MAIL_ARCHIVE.put(entry.archive_key, "something else");
    await env.DB.prepare(
      "ALTER TABLE mail_archive_entries RENAME TO mail_archive_entries_away"
    ).run();

    try {
      // Email Routing delivers it again; it is accepted all the same.
      await receive("in4", "Delivery note");
    } finally {
      await env.DB.prepare(
        "ALTER TABLE mail_archive_entries_away RENAME TO mail_archive_entries"
      ).run();
    }

    expect(await (await env.MAIL_STORAGE.get(stagingKey))?.text()).toBe(
      message
    );

    await env.MAIL_ARCHIVE.delete(entry.archive_key);
    await hooks.scheduled({ scheduledTime: Date.UTC(2026, 2, 3, 10) });
    expect(await entryFor("incoming")).toMatchObject({
      id: entry.id,
      source_key: stagingKey,
    });

    await retryNow();
    expect((await entryFor("incoming")).status).toBe("archived");
    expect(await (await env.MAIL_ARCHIVE.get(entry.archive_key))?.text()).toBe(
      message
    );
    expect(await env.MAIL_STORAGE.head(stagingKey)).toBeNull();
  });

  it("archives mail to a forward address once forwarded, not refused mail, and retries a failed copy", async () => {
    fakeEmailRouting();

    const ownerUserId = z
      .object({ id: z.string() })
      .parse(
        await env.DB.prepare(
          "SELECT id FROM users WHERE role = 'admin'"
        ).first()
      ).id;

    const created = await worker.fetch(
      new Request(`${origin}/api/admin/mailboxes`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({
          address: "press@example.test",
          displayName: "Press",
          ownerUserId,
          teamId: null,
          delivery: "forward",
          forwardTo: ["desk@agency.test"],
          listPosting: "workspace",
        }),
      })
    );

    expect(created.status).toBe(201);

    const forwardId = (
      await readJson(created, z.looseObject({ mailboxId: z.string() }))
    ).mailboxId;

    const message = raw("fw1", "Press inquiry").replace(
      "To: ada@example.test",
      "To: press@example.test"
    );

    // Refused mail isn't archived: over the hop limit, or every forward
    // refused (the sender gets a bounce).
    const looped = await hooks.email({
      from: "rosa@fernhollow.example",
      to: "press@example.test",
      raw: `X-OpenWorkspace-Forwarded: 3\r\n${raw("fw0", "Looped")}`,
    });

    expect(looped.forwarded).toEqual([]);

    const bounced = await hooks.email({
      from: "rosa@fernhollow.example",
      to: "press@example.test",
      raw: raw("fw00", "Bounced"),
      unverified: ["desk@agency.test"],
    });

    expect(bounced.forwarded).toEqual([]);

    // Failing DMARC where the sender's domain asks to reject it bounces.
    const unauthenticated = await hooks.email({
      from: "rosa@fernhollow.example",
      to: "press@example.test",
      raw: failingDmarc("fw000", "reject"),
    });

    expect(unauthenticated.forwarded).toEqual([]);
    expect(unauthenticated.rejection).toStartWith("Not forwarded");

    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM mail_archive_entries WHERE mailbox_id = ?"
      )
        .bind(forwardId)
        .first("n")
    ).toBe(0);

    const forward = () =>
      hooks.email({
        from: "rosa@fernhollow.example",
        to: "press@example.test",
        raw: message,
      });

    const first = await forward();
    expect(first.error).toBeUndefined();
    expect(first.forwarded.map((sent) => sent.to)).toEqual([
      "desk@agency.test",
    ]);

    const { results } = await env.DB.prepare(
      "SELECT * FROM mail_archive_entries WHERE mailbox_id = ?"
    )
      .bind(forwardId)
      .all();

    const [entry, ...rest] = z.array(entryRow).parse(results);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      direction: "incoming",
      status: "archived",
      source_key: null,
    });

    const archived = required(entry, "the forward's entry");
    expect(
      await (await env.MAIL_ARCHIVE.get(archived.archive_key))?.text()
    ).toBe(message);

    // The archive refuses a redelivery's copy: it still goes out, and the
    // copy is staged for the hourly retry.
    await env.DB.prepare("DELETE FROM mail_archive_entries WHERE id = ?")
      .bind(archived.id)
      .run();
    await env.MAIL_ARCHIVE.delete(archived.archive_key);
    await env.MAIL_ARCHIVE.put(archived.archive_key, "something else");

    const again = await forward();
    expect(again.error).toBeUndefined();
    expect(again.forwarded).toHaveLength(1);

    const stagingKey = `archive-staging/${archived.id}.eml`;
    expect(await (await env.MAIL_STORAGE.get(stagingKey))?.text()).toBe(
      message
    );

    await env.MAIL_ARCHIVE.delete(archived.archive_key);
    await retryNow();

    const retried = await env.DB.prepare(
      "SELECT status FROM mail_archive_entries WHERE id = ?"
    )
      .bind(archived.id)
      .first<{ status: string }>();

    expect(retried?.status).toBe("archived");
    expect(
      await (await env.MAIL_ARCHIVE.get(archived.archive_key))?.text()
    ).toBe(message);
    expect(await env.MAIL_STORAGE.head(stagingKey)).toBeNull();

    // Under p=none the domain asks for nothing: the mail is forwarded, so
    // it is archived like any other.
    const unenforcedMessage = failingDmarc("fw2", "none");

    const unenforced = await hooks.email({
      from: "rosa@fernhollow.example",
      to: "press@example.test",
      raw: unenforcedMessage,
    });

    expect(unenforced.rejection).toBeUndefined();
    expect(unenforced.forwarded).toHaveLength(1);

    const unenforcedEntry = await entryFor("incoming");
    expect(unenforcedEntry.status).toBe("archived");
    expect(
      await (await env.MAIL_ARCHIVE.get(unenforcedEntry.archive_key))?.text()
    ).toBe(unenforcedMessage);
  });

  it("archives an auto-reply as sent mail, RFC 3834 headers included", async () => {
    // Earlier tests' mail is stored first, so only the new message is answered.
    await drainInbound(mailboxId);

    const saved = await worker.fetch(
      new Request(`${origin}/api/mail/mailboxes/${mailboxId}/auto-reply`, {
        method: "PUT",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          inside: { enabled: false, html: "<p>Away</p>", text: "Away" },
          outside: { enabled: true, html: "<p>Away</p>", text: "Away" },
        }),
      })
    );

    expect(saved.status).toBe(200);
    await saved.json();

    const { rejection } = await hooks.email({
      from: "otto@quayside.example",
      to: "ada@example.test",
      raw: [
        "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=quayside.example; spf=pass smtp.mailfrom=otto@quayside.example",
        raw("ooo1", "Are you around?").replace(
          "From: Rosa Quill <rosa@fernhollow.example>",
          "From: Otto Vane <otto@quayside.example>"
        ),
      ].join("\r\n"),
    });

    expect(rejection).toBeUndefined();
    await drainInbound(mailboxId);

    const entry = required(
      await pollUntil(
        async () =>
          (await entries()).find(
            (row) => row.id.startsWith("ar_") && row.status === "archived"
          ) ?? null,
        { failure: "the auto-reply was not archived" }
      ),
      "the auto-reply's entry"
    );

    expect(entry.direction).toBe("outgoing");
    expect(entry.archive_key).toMatch(/^\d{4}\/\d{2}\/outgoing\/ar_.+\.eml$/u);

    const object = required(
      await env.MAIL_ARCHIVE.get(entry.archive_key),
      "the archived auto-reply"
    );

    const parsed = await PostalMime.parse(await object.arrayBuffer());
    expect(parsed.subject).toBe("Auto: Are you around?");
    expect(parsed.text?.trim()).toBe("Away");
    expect(parsed.to).toEqual([{ address: "otto@quayside.example", name: "" }]);
    expect(parsed.inReplyTo).toBe("<ooo1@fernhollow.example>");

    const header = (name: string) =>
      parsed.headers.find((row) => row.key === name)?.value;

    expect(header("auto-submitted")).toBe("auto-replied");
    expect(header("x-auto-response-suppress")).toBe("All");

    // The reply's Message-ID is the one Email Sending returned.
    const [logged] = await hooks.mailboxRows(
      mailboxId,
      z.object({ last_outbound_message_id: z.string().nullable() }),
      "SELECT last_outbound_message_id FROM auto_reply_log WHERE sender_address = ?",
      "otto@quayside.example"
    );

    expect(parsed.messageId).toBe(
      required(logged?.last_outbound_message_id, "the logged Message-ID")
    );
  });

  it("gives up on a copy whose message is gone, so it can't hold the rest back", async () => {
    const created = Date.UTC(2026, 2, 3, 9);

    await env.DB.prepare(
      `INSERT INTO mail_archive_entries (id, mailbox_id, direction, source_key, status, archive_key, created_at, updated_at)
       VALUES ('dlv_gone', ?, 'incoming', 'mailboxes/gone/raw.eml', 'pending', '2026/03/incoming/dlv_gone.eml', ?, 0)`
    )
      .bind(mailboxId, created)
      .run();

    await retryNow();

    expect(
      (await entries()).find((entry) => entry.id === "dlv_gone")
    ).toMatchObject({
      status: "abandoned",
      last_error: "The message is missing from mail storage",
    });

    const status = await worker.fetch(
      new Request(`${origin}/api/mail/archive`, { headers: { cookie } })
    );

    expect(await status.json()).toMatchObject({
      abandoned: 1,
      open: expect.arrayContaining([
        expect.objectContaining({ id: "dlv_gone", status: "abandoned" }),
      ]),
    });
  });
});
