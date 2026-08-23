import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { inboundMessageId } from "../worker/mail/inbound";
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

    expect(await mailbox.bulkUpdateConversations(
      [targetConversationId],
      "project",
      { mailboxState: "archive" },
    )).toBe(1);
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
    )).toMatchObject({ totalCount: 1, unreadCount: 2 });

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
    )?.unreadCount).toBe(2);
    expect((await mailbox.listConversations(
      "usr_reader_one",
      "inbox",
      25,
      null,
      undefined,
      true,
    ))?.items).toEqual([]);
    expect((await mailbox.listConversations(
      "usr_reader_two",
      "inbox",
      25,
      null,
      undefined,
      true,
    ))?.items).toHaveLength(1);
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

    expect(await mailbox.bulkSetConversationRead(
      "usr_reader_one",
      [conversationId],
      true,
    )).toBe(1);
    expect((await mailbox.getFolderCounts("usr_reader_one", "inbox"))?.unreadCount)
      .toBe(0);
    expect((await mailbox.listConversations(
      "usr_reader_two",
      "inbox",
      25,
      null,
      undefined,
    ))?.items[0]?.unreadCount).toBe(2);

    await mailbox.bulkSetConversationRead(
      "usr_reader_one",
      [conversationId],
      false,
    );
    expect((await mailbox.listConversations(
      "usr_reader_one",
      "inbox",
      25,
      null,
      undefined,
    ))?.items[0]?.unreadCount).toBe(1);
    expect(await mailbox.bulkSetConversationRead(
      "usr_reader_one",
      ["conv_missing"],
      true,
    )).toBe(0);
  });

  it("shows custom folders only while their conversations are in Inbox", async () => {
    const mailbox = mailboxStub(env, `mbx_global_unread_${crypto.randomUUID()}`);
    const conversationId = "conv_product_unread";
    await mailbox.seedMailbox([{
      id: "product",
      name: "Product",
      sortOrder: 100,
    }], [incoming({
      id: "msg_product_unread",
      conversationId,
      timelineAt: new Date(),
      bodyText: "Unread product message",
    })], [{ id: conversationId, folderId: "product" }]);

    expect((await mailbox.getFolderCounts("usr_product", "inbox"))?.unreadCount)
      .toBe(1);
    expect((await mailbox.getFolderCounts("usr_product", "product"))?.unreadCount)
      .toBe(1);
    expect(Object.fromEntries(
      (await mailbox.listFolders("usr_product")).map((folder) => [folder.id, folder]),
    )).toMatchObject({
      inbox: { totalCount: 1, unreadCount: 1 },
      product: { totalCount: 1, unreadCount: 1 },
      archive: { totalCount: 0, unreadCount: 0 },
    });

    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "product",
      { mailboxState: "archive" },
    )).toBe(1);
    expect((await mailbox.getFolderCounts("usr_product", "inbox"))?.unreadCount)
      .toBe(0);
    expect(await mailbox.getFolderCounts("usr_product", "product"))
      .toEqual({ totalCount: 0, unreadCount: 0 });
    expect((await mailbox.getFolderCounts("usr_product", "archive"))?.unreadCount)
      .toBe(1);
    expect(Object.fromEntries(
      (await mailbox.listFolders("usr_product")).map((folder) => [folder.id, folder]),
    )).toMatchObject({
      inbox: { totalCount: 0, unreadCount: 0 },
      product: { totalCount: 0, unreadCount: 0 },
      archive: { totalCount: 1, unreadCount: 1 },
    });

    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "archive",
      { folderId: "product" },
    )).toBe(1);
    expect((await mailbox.getFolderCounts("usr_product", "inbox"))?.unreadCount)
      .toBe(1);
    expect((await mailbox.getFolderCounts("usr_product", "product"))?.unreadCount)
      .toBe(1);
  });

  it("keeps outgoing-only conversations out of Inbox distribution folders", async () => {
    const mailbox = mailboxStub(env, `mbx_outgoing_distribution_${crypto.randomUUID()}`);
    const conversationId = "conv_outgoing_distribution";
    await mailbox.seedMailbox([{
      id: "product",
      name: "Product",
      sortOrder: 100,
    }], [{
      id: "msg_outgoing_distribution",
      conversationId,
      direction: "outgoing",
      fromJson: [{ address: "me@example.test", name: null }],
      toJson: [{ address: "customer@example.net", name: null }],
      subject: "Outgoing only",
      timelineAt: new Date(),
      transportState: "submitted",
    }]);

    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "sent",
      { mailboxState: "archive" },
    )).toBe(1);
    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "archive",
      { mailboxState: "active", folderId: null },
    )).toBe(0);
    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "archive",
      { mailboxState: "active" },
    )).toBe(1);
    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "sent",
      { folderId: "product" },
    )).toBe(0);
    expect(await mailbox.bulkUpdateConversations(
      [conversationId],
      "sent",
      { folderId: "missing" },
    )).toBeNull();
    expect(await mailbox.bulkSetConversationRead(
      "usr_outgoing_distribution",
      [conversationId],
      false,
    )).toBe(0);
    expect((await mailbox.listConversations(
      "usr_outgoing_distribution",
      "sent",
      25,
      null,
      undefined,
    ))?.items).toMatchObject([{ hasIncoming: false }]);
    expect(await mailbox.getConversationSnapshot(conversationId)).toMatchObject({
      mailboxState: "active",
      folderId: null,
      readStates: [],
    });
  });

  it("applies bulk actions once and cleans permanently deleted message objects", async () => {
    const mailbox = mailboxStub(env, `mbx_bulk_${crypto.randomUUID()}`);
    const now = Date.now();
    const objectKeys = [
      `test/bulk/${crypto.randomUUID()}/body.html`,
      `test/bulk/${crypto.randomUUID()}/raw.eml`,
      `test/bulk/${crypto.randomUUID()}/attachment.txt`,
    ];
    await Promise.all(objectKeys.map((key) => env.MAIL_STORAGE.put(key, "stored")));
    await mailbox.seedMailbox([], [
      {
        ...incoming({
          id: "msg_bulk_first",
          conversationId: "conv_bulk_first",
          timelineAt: new Date(now - 1_000),
          bodyText: "First bulk message",
        }),
        bodyHtmlR2Key: objectKeys[0],
        rawMimeR2Key: objectKeys[1],
        attachmentsJson: [{
          id: "att_bulk_first",
          r2Key: objectKeys[2]!,
          filename: "attachment.txt",
          contentType: "text/plain",
          size: 6,
          contentId: null,
          disposition: "attachment",
          delivery: "attached",
          downloadTokenHash: null,
          downloadExpiresAt: null,
        }],
      },
      incoming({
        id: "msg_bulk_second",
        conversationId: "conv_bulk_second",
        timelineAt: new Date(now),
        bodyText: "Second bulk message",
      }),
    ]);
    const conversationIds = ["conv_bulk_first", "conv_bulk_second"];

    expect(await mailbox.bulkSetConversationRead(
      "usr_bulk_one",
      conversationIds,
      true,
    )).toBe(2);
    expect((await mailbox.listFolders("usr_bulk_one")).find(
      (folder) => folder.id === "inbox",
    )?.unreadCount).toBe(0);
    expect((await mailbox.listFolders("usr_bulk_two")).find(
      (folder) => folder.id === "inbox",
    )?.unreadCount).toBe(2);

    expect(await mailbox.bulkUpdateConversations(
      conversationIds,
      "inbox",
      { mailboxState: "archive" },
    )).toBe(2);
    await expect(mailbox.permanentlyDeleteConversations(conversationIds))
      .resolves.toMatchObject({ outcome: "not_in_trash" });
    expect(await mailbox.bulkUpdateConversations(
      conversationIds,
      "inbox",
      { mailboxState: "trash" },
    )).toBe(0);
    expect(await mailbox.bulkUpdateConversations(
      conversationIds,
      "archive",
      { mailboxState: "trash" },
    )).toBe(2);
    await expect(mailbox.permanentlyDeleteConversations(conversationIds))
      .resolves.toEqual({ outcome: "deleted", deletedCount: 2 });
    expect(await mailbox.getConversationSnapshot("conv_bulk_first")).toBeNull();
    expect(await mailbox.getConversationSnapshot("conv_bulk_second")).toBeNull();
    expect(await mailbox.shouldSuppressPush(
      "msg_bulk_first",
      "usr_bulk_one",
      "ses_bulk_one",
    )).toBe(true);

    await runDurableObjectAlarm(mailbox);
    for (const objectKey of objectKeys) {
      expect(await env.MAIL_STORAGE.get(objectKey)).toBeNull();
    }
  });

  it("does not recreate permanently deleted email from pending inbound work", async () => {
    const mailboxId = `mbx_pending_delete_${crypto.randomUUID()}`;
    const mailbox = mailboxStub(env, mailboxId);
    const deliveryId = `pending_delete_${crypto.randomUUID()}`;
    const messageId = inboundMessageId(deliveryId);
    const conversationId = "conv_pending_delete";
    const rawObjectKey = `test/pending-delete/${crypto.randomUUID()}/raw.eml`;
    const now = Date.now();
    await env.MAIL_STORAGE.put(rawObjectKey, [
      "From: Pending Sender <sender@example.net>",
      "To: me@example.test",
      "Subject: Pending delete",
      "Message-ID: <pending-delete@example.net>",
      "",
      "This message must not return.",
    ].join("\r\n"));
    await mailbox.enqueueInbound({
      id: deliveryId,
      mailboxId,
      rawObjectKey,
      envelopeFrom: "sender@example.net",
      envelopeTo: "me@example.test",
      receivedAt: now,
    });
    await mailbox.seedMailbox([], [{
      ...incoming({
        id: messageId,
        conversationId,
        timelineAt: new Date(now),
        bodyText: "Already visible",
      }),
      rawMimeR2Key: rawObjectKey,
    }], [{ id: conversationId, mailboxState: "trash" }]);

    await expect(mailbox.permanentlyDeleteConversations([conversationId]))
      .resolves.toEqual({ outcome: "deleted", deletedCount: 1 });
    expect(await mailbox.getEmail(messageId)).toBeNull();

    await runDurableObjectAlarm(mailbox);
    expect(await mailbox.getEmail(messageId)).toBeNull();
    expect(await env.MAIL_STORAGE.get(rawObjectKey)).toBeNull();
  });

  it("applies every bulk action beyond the SQLite parameter limit", async () => {
    const mailbox = mailboxStub(env, `mbx_large_bulk_${crypto.randomUUID()}`);
    const now = Date.now();
    const conversationIds = Array.from(
      { length: 101 },
      (_, index) => `conv_large_bulk_${index}`,
    );
    await mailbox.seedMailbox([], conversationIds.map((conversationId, index) =>
      incoming({
        id: `msg_large_bulk_${index}`,
        conversationId,
        timelineAt: new Date(now + index),
        bodyText: `Large bulk message ${index}`,
      })
    ));

    expect(await mailbox.bulkSetConversationRead(
      "usr_large_bulk",
      conversationIds,
      true,
    )).toBe(conversationIds.length);
    expect(await mailbox.bulkUpdateConversations(
      conversationIds,
      "inbox",
      { mailboxState: "archive" },
    )).toBe(conversationIds.length);
    expect(await mailbox.bulkUpdateConversations(
      conversationIds,
      "archive",
      { mailboxState: "trash" },
    )).toBe(conversationIds.length);
    await expect(mailbox.permanentlyDeleteConversations(conversationIds))
      .resolves.toEqual({
        outcome: "deleted",
        deletedCount: conversationIds.length,
      });
  });

  it("keeps legacy shared objects until their last referencing email is deleted", async () => {
    const mailbox = mailboxStub(env, `mbx_shared_object_${crypto.randomUUID()}`);
    const objectKey = `test/shared-object/${crypto.randomUUID()}/attachment.txt`;
    const attachment = {
      id: "att_shared",
      r2Key: objectKey,
      filename: "shared.txt",
      contentType: "text/plain",
      size: 6,
      contentId: null,
      disposition: "attachment" as const,
      delivery: "attached" as const,
      downloadTokenHash: null,
      downloadExpiresAt: null,
    };
    await env.MAIL_STORAGE.put(objectKey, "shared");
    await mailbox.seedMailbox([], [
      {
        ...incoming({
          id: "msg_shared_object_source",
          conversationId: "conv_shared_object_source",
          timelineAt: new Date(Date.now() - 1_000),
          bodyText: "Source",
        }),
        attachmentsJson: [attachment],
      },
      {
        ...incoming({
          id: "msg_shared_object_survivor",
          conversationId: "conv_shared_object_survivor",
          timelineAt: new Date(),
          bodyText: "Survivor",
        }),
        attachmentsJson: [{ ...attachment, id: "att_shared_copy" }],
      },
    ]);

    expect(await mailbox.bulkUpdateConversations(
      ["conv_shared_object_source"],
      "inbox",
      { mailboxState: "trash" },
    )).toBe(1);
    await expect(mailbox.permanentlyDeleteConversations([
      "conv_shared_object_source",
    ])).resolves.toMatchObject({ outcome: "deleted" });
    expect(await env.MAIL_STORAGE.get(objectKey)).not.toBeNull();

    expect(await mailbox.bulkUpdateConversations(
      ["conv_shared_object_survivor"],
      "inbox",
      { mailboxState: "trash" },
    )).toBe(1);
    await expect(mailbox.permanentlyDeleteConversations([
      "conv_shared_object_survivor",
    ])).resolves.toMatchObject({ outcome: "deleted" });
    expect(await runDurableObjectAlarm(mailbox)).toBe(true);
    expect(await env.MAIL_STORAGE.get(objectKey)).toBeNull();
  });
});
