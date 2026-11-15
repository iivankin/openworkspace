import { expect, it } from "bun:test";

import { z } from "zod";

import { readJson } from "./json.ts";
import { bootstrapAdmin } from "./mail-flow-helpers.ts";
import { env, hooks, useFreshWorkspace, worker } from "./workspace.ts";

useFreshWorkspace();

/**
 * A mailbox with more new mail than one backup batch stores (100) is
 * finished by the next batch, from where the first one stopped.
 */

const origin = "http://example.test";

const latest = z.object({
  latest: z
    .object({
      status: z.enum(["running", "completed"]),
      itemCount: z.number(),
      newObjectCount: z.number(),
      errors: z.array(z.string()),
    })
    .nullable(),
});

it("continues a mailbox a batch stopped in the middle of", async () => {
  const cookie = await bootstrapAdmin("ada@example.test", "Ada Moss");

  const { id: mailboxId } = z
    .object({ id: z.string() })
    .parse(await env.DB.prepare("SELECT id FROM mailboxes").first());

  for (let index = 0; index < 101; index += 1) {
    const url = new URL(
      `${origin}/api/mail/import/mailboxes/${mailboxId}/messages`
    );

    url.searchParams.set("sourceId", `m${index}`);

    // oxlint-disable-next-line eslint/no-await-in-loop -- one import after another
    const response = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { cookie, "content-type": "message/rfc822" },
        body: [
          "From: Rosa Quill <rosa@fernhollow.example>",
          "To: ada@example.test",
          `Subject: Note ${index}`,
          "Date: Tue, 03 Mar 2026 10:00:00 +0000",
          `Message-ID: <m${index}@fernhollow.example>`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          `Body ${index}.`,
          "",
        ].join("\r\n"),
      })
    );

    expect(response.status).toBe(201);
    // oxlint-disable-next-line eslint/no-await-in-loop -- see above
    await response.json();
  }

  const run = await hooks.fetchAndWait(
    new Request(`${origin}/api/admin/backups/run`, {
      method: "POST",
      headers: { cookie, origin },
    })
  );

  expect(run.status).toBe(202);
  await run.json();
  // The first batch stops after 100 new messages; the cron takes the rest.
  await hooks.scheduled({ scheduledTime: Date.now() });

  const status = await readJson(
    await worker.fetch(
      new Request(`${origin}/api/admin/backups`, { headers: { cookie } })
    ),
    latest
  );

  expect(status.latest).toMatchObject({
    status: "completed",
    newObjectCount: 101,
    errors: [],
  });
});
