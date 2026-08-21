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
    const userId = "usr_index";
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

    const firstPage = await mailbox.listConversations(userId, "inbox", 25, null, undefined);
    expect(firstPage?.items).toHaveLength(25);
    expect(firstPage?.next).not.toBeNull();
    expect(firstPage?.items.some(
      (item) => item.email.conversationId === targetConversationId,
    )).toBe(false);

    const search = await mailbox.listConversations(userId, "inbox", 25, null, "ultramarine");
    expect(search?.items.map((item) => item.email.conversationId)).toEqual([
      targetConversationId,
    ]);
    expect((await mailbox.listConversations(userId, "project", 25, null, "ultramarine"))?.items)
      .toHaveLength(1);
    expect((await mailbox.listConversations(userId, "inbox", 25, null, "vermilion"))?.items)
      .toHaveLength(1);
    expect((await mailbox.listConversations(userId, "project", 25, null, "vermilion"))?.items)
      .toHaveLength(1);

    await mailbox.updateConversation(targetConversationId, { mailboxState: "archive" });
    expect((await mailbox.listConversations(userId, "inbox", 25, null, "ultramarine"))?.items).toEqual([]);
    expect((await mailbox.listConversations(userId, "archive", 25, null, "ultramarine"))?.items).toHaveLength(1);
    expect((await mailbox.getConversationSnapshot(targetConversationId))?.mailboxState)
      .toBe("archive");

    await mailbox.insertEmail(incoming({
      id: "msg_buried_reply",
      conversationId: targetConversationId,
      timelineAt: new Date(now + 1_000),
      bodyText: "A new inbound reply.",
    }));
    expect((await mailbox.listConversations(userId, "inbox", 25, null, "ultramarine"))?.items).toHaveLength(1);
    expect((await mailbox.listConversations(userId, "archive", 25, null, "ultramarine"))?.items).toEqual([]);
    expect((await mailbox.getConversationSnapshot(targetConversationId))?.mailboxState)
      .toBe("active");
  });

  it("keeps message reads personal inside a shared mailbox", async () => {
    const mailbox = mailboxStub(env, `mbx_reads_${crypto.randomUUID()}`);
    const now = Date.now();
    const conversationId = "conv_shared_reads";
    await mailbox.seedMailbox([], [
      incoming({
        id: "msg_shared_first",
        conversationId,
        timelineAt: new Date(now - 2_000),
        bodyText: "First incoming message",
      }),
      incoming({
        id: "msg_shared_second",
        conversationId,
        timelineAt: new Date(now - 1_000),
        bodyText: "Second incoming message",
      }),
      {
        id: "msg_shared_reply",
        conversationId,
        direction: "outgoing",
        fromJson: [{ address: "me@example.test", name: null }],
        toJson: [{ address: "customer@example.net", name: null }],
        subject: "Re: Shared reads",
        timelineAt: new Date(now),
        transportState: "submitted",
      },
    ]);

    const initial = await mailbox.listConversations(
      "usr_reader_one",
      "inbox",
      25,
      null,
      undefined,
    );
    expect(initial?.items[0]).toMatchObject({
      messageCount: 3,
      unreadCount: 2,
    });
    expect((await mailbox.listFolders("usr_reader_one")).find(
      (folder) => folder.id === "inbox",
    )).toMatchObject({ totalCount: 1, unreadCount: 1 });

    expect(await mailbox.setMessageRead(
      "usr_reader_one",
      "msg_shared_first",
      true,
    )).toBe(true);
    expect((await mailbox.listConversations(
      "usr_reader_one",
      "inbox",
      25,
      null,
      undefined,
    ))?.items[0]?.unreadCount).toBe(1);
    expect((await mailbox.listConversations(
      "usr_reader_two",
      "inbox",
      25,
      null,
      undefined,
    ))?.items[0]?.unreadCount).toBe(2);

    await mailbox.setMessageRead("usr_reader_one", "msg_shared_second", true);
    expect((await mailbox.listFolders("usr_reader_one")).find(
      (folder) => folder.id === "inbox",
    )?.unreadCount).toBe(0);
    expect((await mailbox.listFolders("usr_reader_two")).find(
      (folder) => folder.id === "inbox",
    )?.unreadCount).toBe(1);
    expect((await mailbox.getConversationSnapshot(conversationId))?.readStates)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          emailId: "msg_shared_first",
          userId: "usr_reader_one",
        }),
        expect.objectContaining({
          emailId: "msg_shared_second",
          userId: "usr_reader_one",
        }),
      ]));

    await mailbox.setMessageRead("usr_reader_one", "msg_shared_second", false);
    expect((await mailbox.listConversations(
      "usr_reader_one",
      "inbox",
      25,
      null,
      undefined,
    ))?.items[0]?.unreadCount).toBe(1);

    expect(await mailbox.setConversationRead(
      "usr_reader_one",
      conversationId,
      true,
    )).toBe(true);
    expect((await mailbox.getFolderCounts("usr_reader_one", "inbox"))?.unreadCount)
      .toBe(0);
    expect((await mailbox.listConversations(
      "usr_reader_two",
      "inbox",
      25,
      null,
      undefined,
    ))?.items[0]?.unreadCount).toBe(2);

    await mailbox.setConversationRead("usr_reader_one", conversationId, false);
    expect((await mailbox.listConversations(
      "usr_reader_one",
      "inbox",
      25,
      null,
      undefined,
    ))?.items[0]?.unreadCount).toBe(1);
    expect(await mailbox.setConversationRead(
      "usr_reader_one",
      "conv_missing",
      true,
    )).toBe(false);
  });
});
