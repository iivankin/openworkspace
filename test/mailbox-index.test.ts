import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { mailboxStub } from "../worker/mailbox";
import type { NewEmail } from "../worker/mailbox/schema";

function incoming(input: {
  id: string;
  conversationId: string;
  timelineAt: Date;
  bodyText: string;
}): NewEmail {
  return {
    id: input.id,
    conversationId: input.conversationId,
    direction: "incoming",
    fromJson: [{ address: `${input.id}@example.net`, name: null }],
    toJson: [{ address: "me@example.test", name: null }],
    subject: `Subject ${input.id}`,
    preview: input.bodyText,
    bodyText: input.bodyText,
    timelineAt: input.timelineAt,
    transportState: "received",
  };
}

describe("mailbox conversation index", () => {
  it("searches every email in the selected folder and reactivates replied-to conversations", async () => {
    const mailbox = mailboxStub(env, `mbx_index_${crypto.randomUUID()}`);
    const now = Date.now();
    const targetConversationId = "conv_buried_target";
    const values: NewEmail[] = [
      incoming({
        id: "msg_buried_original",
        conversationId: targetConversationId,
        timelineAt: new Date(now - 100_000),
        bodyText: "The launch phrase is ultramarine falcon.",
      }),
      incoming({
        id: "msg_buried_latest",
        conversationId: targetConversationId,
        timelineAt: new Date(now - 99_000),
        bodyText: "Acknowledged with an outside-folder vermilion marker.",
      }),
      ...Array.from({ length: 30 }, (_, index) => incoming({
        id: `msg_filler_${index}`,
        conversationId: `conv_filler_${index}`,
        timelineAt: new Date(now - index * 1_000),
        bodyText: `Routine filler ${index}`,
      })),
    ];
    await mailbox.seedMailbox([{
      id: "project",
      name: "Project",
      sortOrder: 100,
    }], values, [{ id: targetConversationId, folderId: "project" }]);

    const firstPage = await mailbox.listConversations("inbox", 25, null, undefined);
    expect(firstPage?.items).toHaveLength(25);
    expect(firstPage?.next).not.toBeNull();
    expect(firstPage?.items.some(
      (item) => item.email.conversationId === targetConversationId,
    )).toBe(false);

    const search = await mailbox.listConversations("inbox", 25, null, "ultramarine");
    expect(search?.items.map((item) => item.email.conversationId)).toEqual([
      targetConversationId,
    ]);
    expect((await mailbox.listConversations("project", 25, null, "ultramarine"))?.items)
      .toHaveLength(1);
    expect((await mailbox.listConversations("inbox", 25, null, "vermilion"))?.items)
      .toHaveLength(1);
    expect((await mailbox.listConversations("project", 25, null, "vermilion"))?.items)
      .toHaveLength(1);

    await mailbox.updateConversation(targetConversationId, { mailboxState: "archive" });
    expect((await mailbox.listConversations("inbox", 25, null, "ultramarine"))?.items).toEqual([]);
    expect((await mailbox.listConversations("archive", 25, null, "ultramarine"))?.items).toHaveLength(1);
    expect((await mailbox.getConversationSnapshot(targetConversationId))?.mailboxState)
      .toBe("archive");

    await mailbox.insertEmail(incoming({
      id: "msg_buried_reply",
      conversationId: targetConversationId,
      timelineAt: new Date(now + 1_000),
      bodyText: "A new inbound reply.",
    }));
    expect((await mailbox.listConversations("inbox", 25, null, "ultramarine"))?.items).toHaveLength(1);
    expect((await mailbox.listConversations("archive", 25, null, "ultramarine"))?.items).toEqual([]);
    expect((await mailbox.getConversationSnapshot(targetConversationId))?.mailboxState)
      .toBe("active");
  });
});
