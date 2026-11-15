import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { required } from "@open-workspace/core/shared";
import { mcpAccessToken } from "@open-workspace/core/testing";
import { main } from "@open-workspace/create/import/cli.ts";
import { inboundMessageId } from "@open-workspace/email/worker/mail/inbound.ts";
import { draftFileKey } from "@open-workspace/email/worker/mail/uploads.ts";
import { z } from "zod";

import type { JsonValue } from "./json.ts";
import {
  bootstrapAdmin,
  drainInbound,
  firstMailboxId,
} from "./mail-flow-helpers.ts";
import { env, hooks, mailbox, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/**
 * A snapshot keeps what a mailbox holds beside its mail, and `import backup`
 * puts it back on a new copy of the address: folders and rules, a draft and
 * its image, the auto-reply and its image, the address's signature and its
 * image, a sender block, AI instructions and notification choices; and the
 * workspace's blocked senders and people's signatures.
 */

const origin = "http://example.test";
const signatureLogo = "kiln-logo@openworkspace.local";
const personalLogo = "ana-logo@openworkspace.local";
const awayLogo = "away@openworkspace.local";
const draftId = "drf_backup-glaze";
let cookie = "";
let adminId = "";
let teamId = "";
let kilnId = "";
let draftUpload = "";

const idRow = z.object({ id: z.string() });

async function call(path: string, method = "GET", json?: JsonValue) {
  const response = await worker.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    })
  );

  expect(response.status, path).toBeLessThan(300);

  return z.looseObject({}).parse(await response.json());
}

/** Uploads `bytes` as a PNG through the composer's upload flow; its upload id. */
async function uploadImage(mailboxId: string, bytes: string) {
  const intent = z
    .looseObject({
      upload: z.looseObject({
        id: z.string(),
        uploadUrl: z.string(),
        headers: z.record(z.string(), z.string()),
      }),
    })
    .parse(
      await call(`/api/mail/uploads?mailboxId=${mailboxId}`, "POST", {
        filename: "logo.png",
        contentType: "image/png",
        size: bytes.length,
      })
    );

  const put = await fetch(intent.upload.uploadUrl, {
    method: "PUT",
    headers: intent.upload.headers,
    body: bytes,
  });

  expect(put.status).toBe(200);
  await put.arrayBuffer();
  await call(
    `/api/mail/uploads/${intent.upload.id}/complete?mailboxId=${mailboxId}`,
    "POST"
  );

  return intent.upload.id;
}

async function stored(key: string) {
  return (await env.MAIL_STORAGE.get(key))?.text() ?? null;
}

/** Copies every object of the backup bucket under `dir`, as rclone would. */
async function downloadBucket(dir: string) {
  const { objects } = await env.BACKUP_STORAGE.list({ prefix: "backups/" });

  for (const { key } of objects) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of small objects
    const body = required(await env.BACKUP_STORAGE.get(key), key);
    const path = join(dir, key);
    mkdirSync(dirname(path), { recursive: true });
    // oxlint-disable-next-line eslint/no-await-in-loop -- see above
    writeFileSync(path, await body.bytes());
  }
}

beforeAll(async () => {
  cookie = await bootstrapAdmin("ana@example.test", "Ana Moss");
  const personalId = await firstMailboxId(cookie);
  adminId = idRow.parse(
    await env.DB.prepare("SELECT id FROM users").first()
  ).id;

  await call("/api/admin/teams", "POST", {
    name: "Kiln",
    slug: "kiln",
    description: null,
    members: [{ userId: adminId, canSend: true }],
  });
  teamId = idRow.parse(
    await env.DB.prepare("SELECT id FROM teams WHERE slug = 'kiln'").first()
  ).id;
  kilnId = z.object({ mailboxId: z.string() }).parse(
    await call("/api/admin/mailboxes", "POST", {
      address: "kiln@example.test",
      displayName: "Kiln",
      ownerUserId: null,
      teamId,
    })
  ).mailboxId;

  // Zinc comes first; Receipts, after it, holds mail, so on restore it is
  // created by its message before the settings line puts it back in place.
  await call(`/api/mail/mailboxes/${kilnId}/folders`, "POST", { name: "Zinc" });

  const folder = z.object({ folder: z.object({ id: z.string() }) }).parse(
    await call(`/api/mail/mailboxes/${kilnId}/folders`, "POST", {
      name: "Receipts",
    })
  );

  const filed = await worker.fetch(
    new Request(
      `${origin}/api/mail/import/mailboxes/${kilnId}/messages?${new URLSearchParams({ sourceId: "receipt-1", placement: "inbox", folder: "Receipts" })}`,
      {
        method: "POST",
        headers: { cookie, "content-type": "message/rfc822" },
        body: [
          "From: Rosa Quill <rosa@fernhollow.example>",
          "To: kiln@example.test",
          "Subject: Your receipt",
          "Date: Tue, 03 Mar 2026 10:00:00 +0000",
          "Message-ID: <receipt-1@fernhollow.example>",
          "",
          "Thanks.",
          "",
        ].join("\r\n"),
      }
    )
  );

  expect(filed.status).toBe(201);
  await filed.json();

  await call(`/api/mail/mailboxes/${kilnId}/rules`, "POST", {
    name: "Receipts",
    conditions: [{ type: "subject", op: "contains", value: "receipt" }],
    actions: [{ type: "moveToFolder", folderId: folder.folder.id }],
  });

  draftUpload = await uploadImage(kilnId, "draft-png");
  const assetId = crypto.randomUUID();

  await call(`/api/mail/drafts/${draftId}?mailboxId=${kilnId}`, "PUT", {
    expectedVersion: 0,
    kind: "compose",
    to: ["rosa@fernhollow.example"],
    subject: "Glaze samples",
    bodyText: "Photo attached",
    bodyHtml: `<p>Photo<span data-composer-asset="${assetId}" data-composer-asset-intent="inline"></span></p>`,
    attachments: [
      {
        assetId,
        uploadId: draftUpload,
        disposition: "inline",
        contentId: "draft-photo@openworkspace.local",
      },
    ],
  });

  const away = await uploadImage(kilnId, "away-png");

  await call(`/api/mail/mailboxes/${kilnId}/auto-reply`, "PUT", {
    enabled: true,
    inside: { enabled: false, html: "", text: "" },
    outside: {
      enabled: true,
      html: `<p>Away</p><img src="cid:${awayLogo}">`,
      text: "Away",
      images: [{ uploadId: away, contentId: awayLogo }],
      uploadMailboxId: kilnId,
    },
  });

  const teamUpload = await uploadImage(kilnId, "kiln-png");

  await call(`/api/mail/team-signatures/${kilnId}`, "PUT", {
    html: `<p>Kiln <img src="cid:${signatureLogo}"></p>`,
    text: "Kiln",
    images: [{ uploadId: teamUpload, contentId: signatureLogo }],
    uploadMailboxId: kilnId,
  });

  const personalUpload = await uploadImage(personalId, "ana-png");

  await call("/api/mail/signature", "PUT", {
    html: `<p>Ana <img src="cid:${personalLogo}"></p>`,
    text: "Ana",
    images: [{ uploadId: personalUpload, contentId: personalLogo }],
    uploadMailboxId: personalId,
  });

  await call(`/api/mail/mailboxes/${kilnId}/blocked-senders`, "POST", {
    pattern: "spam.example",
  });
  await call("/api/admin/blocked-senders", "POST", {
    pattern: "@evil.example",
  });
  // One the admin screen refuses, from before that check: restore skips it too.
  await env.DB.prepare(
    "INSERT INTO blocked_senders (pattern, created_at) VALUES ('@example.test', 0)"
  ).run();
  await call(`/api/mail/mailboxes/${kilnId}/ai`, "PUT", {
    instructions: "Firing schedules go to Receipts",
    confidenceThreshold: 80,
  });
  await call(`/api/notifications/preferences/${kilnId}`, "PUT", {
    enabled: false,
  });
});

describe("backups of mail settings", () => {
  it("restores an address's settings, drafts and images, and the workspace's", async () => {
    await hooks.scheduled({ scheduledTime: Date.now() });

    const { latest } = z
      .object({
        latest: z.object({
          id: z.string(),
          status: z.string(),
          errors: z.array(z.string()),
        }),
      })
      .parse(await call("/api/admin/backups"));

    expect(latest).toMatchObject({ status: "completed", errors: [] });

    const dir = mkdtempSync(join(tmpdir(), "ow-backup-settings-"));
    await downloadBucket(dir);

    // The address goes, and with it everything it kept; so do the workspace's.
    await call(`/api/admin/mailboxes/${kilnId}`, "DELETE");
    await env.DB.prepare("DELETE FROM signatures WHERE user_id = ?")
      .bind(adminId)
      .run();
    await env.MAIL_STORAGE.delete(`signatures/${adminId}/${personalLogo}`);
    await env.DB.prepare("DELETE FROM blocked_senders").run();

    const { accessToken } = await mcpAccessToken(cookie, {
      scope: "admin.workspace",
    });

    const restore = async (stateDir: string) => {
      const log: string[] = [];

      const code = await main(
        [
          "backup",
          join(dir, "backups", latest.id),
          "--workspace",
          origin,
          "--token",
          accessToken,
          "--state-dir",
          join(dir, stateDir),
        ],
        {
          fetch: (input: string, init?: RequestInit) =>
            worker.fetch(new Request(input, init)),
          credentialsPath: null,
          log: (line) => log.push(line),
          progress: () => {},
        }
      );

      expect(code, log.join("\n")).toBe(0);

      return log.join("\n");
    };

    // The receipt, settings, the draft, its image, the auto-reply's, the signature's;
    // the workspace's settings and Ana's signature image.
    expect(await restore("state")).toContain(
      "8 restored, 0 already there, 0 skipped, 0 failed"
    );

    const restoredId = idRow.parse(
      await env.DB.prepare(
        "SELECT id FROM mailboxes WHERE local_part = 'kiln' AND team_id = ?"
      )
        .bind(teamId)
        .first()
    ).id;

    expect(restoredId).not.toBe(kilnId);

    // Folders keep their order, the one its mail created included.
    expect(
      await hooks.mailboxSql(
        restoredId,
        "SELECT name FROM folders ORDER BY sort_order, name"
      )
    ).toEqual([{ name: "Zinc" }, { name: "Receipts" }]);

    // The rule follows its folder to the new copy, and still files mail.
    const { rules } = z
      .object({
        rules: z.array(
          z.looseObject({ name: z.string(), folderDeleted: z.boolean() })
        ),
      })
      .parse(await call(`/api/mail/mailboxes/${restoredId}/rules`));

    expect(rules).toMatchObject([{ name: "Receipts", folderDeleted: false }]);

    const delivery = `delivery_${crypto.randomUUID()}`;
    await env.MAIL_STORAGE.put(
      `test/${delivery}.eml`,
      [
        "From: Rosa Quill <rosa@fernhollow.example>",
        "To: kiln@example.test",
        "Subject: Your receipt",
        "Message-ID: <receipt@fernhollow.example>",
        "",
        "Paid.",
        "",
      ].join("\r\n")
    );
    await mailbox(restoredId).enqueueInbound({
      id: delivery,
      mailboxId: restoredId,
      rawObjectKey: `test/${delivery}.eml`,
      envelopeFrom: "rosa@fernhollow.example",
      envelopeTo: "kiln@example.test",
      receivedAt: Date.now(),
    });
    await drainInbound(restoredId);
    expect(
      await hooks.mailboxSql(
        restoredId,
        `SELECT f.name FROM emails e JOIN conversations c ON c.id = e.conversation_id
         JOIN folders f ON f.id = c.folder_id WHERE e.id = ?`,
        inboundMessageId(delivery)
      )
    ).toEqual([{ name: "Receipts" }]);

    // The draft, with its image under the new address.
    expect(await mailbox(restoredId).listDrafts(adminId)).toMatchObject([
      { id: draftId, subject: "Glaze samples", kind: "compose" },
    ]);

    const photo = await worker.fetch(
      new Request(
        `${origin}/api/mail/drafts/files/${draftUpload}?mailboxId=${restoredId}`,
        { headers: { cookie } }
      )
    );

    expect(photo.status).toBe(200);
    expect(await photo.text()).toBe("draft-png");
    expect(await stored(draftFileKey(restoredId, adminId, draftUpload))).toBe(
      "draft-png"
    );

    // The auto-reply, its image, the block, the AI instructions, the choice.
    expect(
      await call(`/api/mail/mailboxes/${restoredId}/auto-reply`)
    ).toMatchObject({ status: "active", settings: { enabled: true } });
    expect(await stored(`mailboxes/${restoredId}/auto-reply/${awayLogo}`)).toBe(
      "away-png"
    );
    expect(
      await call(`/api/mail/mailboxes/${restoredId}/blocked-senders`)
    ).toMatchObject({ blocked: [{ pattern: "@spam.example" }] });
    expect(
      (await mailbox(restoredId).getMailboxAiSettings()).configuration
    ).toEqual({
      instructions: "Firing schedules go to Receipts",
      confidenceThreshold: 80,
    });
    expect(
      await env.DB.prepare(
        "SELECT user_id, enabled FROM mailbox_notification_preferences WHERE mailbox_id = ?"
      )
        .bind(restoredId)
        .all()
    ).toMatchObject({ results: [{ user_id: adminId, enabled: 0 }] });

    // The signature comes back with its image, and goes out with mail again.
    expect(await stored(`signatures/${restoredId}/${signatureLogo}`)).toBe(
      "kiln-png"
    );

    const { messageId } = z.object({ messageId: z.string() }).parse(
      await call("/api/mail/messages", "POST", {
        requestId: crypto.randomUUID(),
        mailboxId: restoredId,
        to: ["rosa@fernhollow.example"],
        subject: "Signed",
        bodyText: "Hello",
        includeSignature: true,
      })
    );

    expect(
      (await mailbox(restoredId).getEmail(messageId))?.attachmentsJson
    ).toMatchObject([{ contentId: signatureLogo, disposition: "inline" }]);

    // The workspace's: the blocked sender, Ana's own signature and image.
    expect(
      await env.DB.prepare("SELECT pattern FROM blocked_senders").all()
    ).toMatchObject({ results: [{ pattern: "@evil.example" }] });
    expect(
      await env.DB.prepare("SELECT html FROM signatures WHERE user_id = ?")
        .bind(adminId)
        .first()
    ).toEqual({ html: `<p>Ana <img src="cid:${personalLogo}"></p>` });
    expect(await stored(`signatures/${adminId}/${personalLogo}`)).toBe(
      "ana-png"
    );

    // Again: everything is there already.
    expect(await restore("state-again")).toContain(
      "0 restored, 8 already there, 0 skipped"
    );
  });
});
