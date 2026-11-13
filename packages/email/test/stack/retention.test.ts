import { describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import type { MailboxState } from "@open-workspace/email/worker/mailbox/folder-model.ts";
import type { NewEmail } from "@open-workspace/email/worker/mailbox/schema.ts";
import { z } from "zod";

import { pollUntil } from "./poll.ts";
import {
  hooks,
  mailbox as mailboxStub,
  useFreshWorkspace,
} from "./workspace.ts";

useFreshWorkspace();

const DAY_MS = 24 * 60 * 60 * 1000;

function incoming(conversationId: string): NewEmail {
  return {
    id: `msg_${conversationId}`,
    conversationId,
    direction: "incoming",
    fromJson: [{ address: "sender@example.net", name: null }],
    toJson: [{ address: "me@example.test", name: null }],
    subject: `Subject ${conversationId}`,
    timelineAt: new Date(),
    transportState: "received",
  };
}

/** A fresh mailbox holding one conversation per `[id, state]`. */
async function seeded(conversations: [string, MailboxState][]) {
  const mailboxId = `mbx_retention_${crypto.randomUUID()}`;
  const mailbox = mailboxStub(mailboxId);

  await mailbox.seedMailbox(
    [],
    conversations.map(([id]) => incoming(id)),
    conversations.map(([id, mailboxState]) => ({ id, mailboxState }))
  );

  return { mailboxId, mailbox };
}

async function stateChangedAt(mailboxId: string, conversationId: string) {
  const [row] = await hooks.mailboxRows(
    mailboxId,
    z.object({ state_changed_at: z.number().nullable() }),
    "select state_changed_at from conversations where id = ?",
    conversationId
  );

  return required(row, `${conversationId} exists`).state_changed_at;
}

function backdate(mailboxId: string, conversationId: string, at: number) {
  return hooks.mailboxSql(
    mailboxId,
    "update conversations set state_changed_at = ? where id = ?",
    at,
    conversationId
  );
}

async function remainingIds(mailboxId: string) {
  const rows = await hooks.mailboxRows(
    mailboxId,
    z.object({ id: z.string() }),
    "select id from conversations order by id"
  );

  return rows.map((row) => row.id);
}

describe("state_changed_at", () => {
  it("is set on insert and moves whenever the conversation changes place", async () => {
    const { mailboxId, mailbox } = await seeded([["conv_a", "active"]]);

    expect(await stateChangedAt(mailboxId, "conv_a")).toBeGreaterThan(0);

    await backdate(mailboxId, "conv_a", 1);
    await mailbox.bulkUpdateConversations(["conv_a"], "inbox", {
      mailboxState: "trash",
    });

    const trashedAt = required(
      await stateChangedAt(mailboxId, "conv_a"),
      "conv_a is stamped"
    );

    expect(trashedAt).toBeGreaterThan(Date.now() - 60_000);

    // New mail brings a thread back from Trash; that restarts the clock too.
    await backdate(mailboxId, "conv_a", 1);
    await mailbox.seedMailbox([], [{ ...incoming("conv_a"), id: "msg_new" }]);

    expect(
      (await mailbox.getConversationSnapshot("conv_a"))?.mailboxState
    ).toBe("active");
    expect(await stateChangedAt(mailboxId, "conv_a")).toBeGreaterThan(1);
  });
});

describe("emptyFolder", () => {
  it("deletes Trash in batches of 100 and leaves Spam alone", async () => {
    const trash = Array.from(
      { length: 101 },
      (_, index): [string, MailboxState] => [
        `conv_trash_${String(index).padStart(3, "0")}`,
        "trash",
      ]
    );

    const { mailboxId, mailbox } = await seeded([
      ...trash,
      ["conv_spam", "spam"],
      ["conv_inbox", "active"],
    ]);

    expect(await mailbox.emptyFolder("trash")).toEqual({
      deleted: 100,
      remaining: 1,
    });
    expect(await mailbox.emptyFolder("trash")).toEqual({
      deleted: 1,
      remaining: 0,
    });
    expect(await remainingIds(mailboxId)).toEqual(["conv_inbox", "conv_spam"]);

    expect(await mailbox.emptyFolder("spam")).toEqual({
      deleted: 1,
      remaining: 0,
    });
    expect(await remainingIds(mailboxId)).toEqual(["conv_inbox"]);
  });
});

describe("retention", () => {
  it("deletes only conversations past the limit and wakes for the next one", async () => {
    const { mailboxId, mailbox } = await seeded([
      ["conv_old", "trash"],
      ["conv_new", "trash"],
      ["conv_spam", "spam"],
      ["conv_inbox", "active"],
    ]);

    const now = Date.now();
    await backdate(mailboxId, "conv_old", now - 8 * DAY_MS);
    await backdate(mailboxId, "conv_new", now - 6 * DAY_MS);
    await backdate(mailboxId, "conv_spam", now - 100 * DAY_MS);
    await backdate(mailboxId, "conv_inbox", now - 100 * DAY_MS);

    await mailbox.setRetention({ trashDays: 7, spamDays: null }, "usr_test");

    // conv_old is already due, so the alarm is set for right away.
    expect(required(await mailbox.testAlarm(), "an alarm is set")).toBeLessThan(
      now + 5000
    );

    await hooks.runAlarm(mailboxId);

    expect(await remainingIds(mailboxId)).toEqual([
      "conv_inbox",
      "conv_new",
      "conv_spam",
    ]);
    expect(await mailbox.testAlarm()).toBe(now - 6 * DAY_MS + 7 * DAY_MS);
  });

  it("schedules a wake when mail is moved into Trash", async () => {
    const { mailboxId, mailbox } = await seeded([["conv_a", "active"]]);
    await mailbox.setRetention({ trashDays: 30, spamDays: 30 }, "usr_test");

    expect(await mailbox.testAlarm()).toBeNull();

    const before = Date.now();
    await mailbox.bulkUpdateConversations(["conv_a"], "inbox", {
      mailboxState: "trash",
    });

    const alarm = await pollUntil(() => mailbox.testAlarm(), {
      failure: "moving mail into Trash set no alarm",
    });

    // The trigger stamps whole seconds.
    expect(alarm).toBeGreaterThanOrEqual(before - 1000 + 30 * DAY_MS);
    expect(alarm).toBe(
      required(await stateChangedAt(mailboxId, "conv_a"), "conv_a is stamped") +
        30 * DAY_MS
    );
  });
});
