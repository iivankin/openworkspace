import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { MAX_OFFICE_PREVIEW_BYTES, officePreviewKey, type OfficePreviewJob } from "../shared/office-preview";
import { convertOfficeDocument } from "../worker/mail/office-conversion";
import { consumeOfficePreviews } from "../worker/mail/office-preview-queue";
import { mailboxStub } from "../worker/mailbox";
import { inboundMessageId } from "../worker/mail/inbound";

function batch(job: OfficePreviewJob, attempts = 1) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    ack,
    retry,
    batch: {
      queue: "openworkspace-office-previews",
      messages: [{ id: crypto.randomUUID(), timestamp: new Date(), body: job, attempts, ack, retry }],
      metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } satisfies MessageBatch<unknown>,
  };
}

async function insertOffice(filename = "report.xlsx", size = 5) {
  const mailboxId = `mbx_preview_${crypto.randomUUID()}`;
  const sourceKey = `test/${mailboxId}/attachment`;
  const mailbox = mailboxStub(env, mailboxId);
  await env.MAIL_STORAGE.put(sourceKey, "bytes");
  await mailbox.insertEmail({
    id: "msg_preview", conversationId: "conv_preview", direction: "incoming",
    fromJson: [{ address: "sender@example.test", name: null }],
    toJson: [{ address: "me@example.test", name: null }],
    subject: "Office", timelineAt: new Date(), transportState: "received",
    attachmentsJson: [{
      id: "att_preview", r2Key: sourceKey, filename, size,
      contentType: "application/octet-stream", contentId: null, disposition: "attachment",
      delivery: "attached", downloadTokenHash: null, downloadExpiresAt: null,
    }],
  });
  const job: OfficePreviewJob = { mailboxId, messageId: "msg_preview", attachmentId: "att_preview", sourceKey };
  return { mailbox, job };
}

it("persists preview work with the email, reuses PDFs on redelivery, and deletes both objects", async () => {
  const { mailbox, job } = await insertOffice();
  expect((await mailbox.getAttachment(job.messageId, job.attachmentId))?.pdfPreviewStatus).toBe("pending");
  await runInDurableObject(mailbox, async (_, state) => {
    expect(state.storage.sql.exec("select * from pending_office_previews").toArray()).toHaveLength(1);
    expect(await state.storage.getAlarm()).not.toBeNull();
  });
  await runDurableObjectAlarm(mailbox);
  await runInDurableObject(mailbox, (_, state) => {
    expect(state.storage.sql.exec("select * from pending_office_previews").toArray()).toHaveLength(0);
  });
  await env.MAIL_STORAGE.put(officePreviewKey(job.sourceKey), "%PDF-1.7\nready");
  const first = batch(job);
  await consumeOfficePreviews(first.batch, env);
  expect(first.ack).toHaveBeenCalledOnce();
  expect((await mailbox.getAttachment(job.messageId, job.attachmentId))?.pdfPreviewStatus).toBe("ready");
  const duplicate = batch(job);
  await consumeOfficePreviews(duplicate.batch, env);
  expect(duplicate.ack).toHaveBeenCalledOnce();
  expect(duplicate.retry).not.toHaveBeenCalled();
  await mailbox.bulkUpdateConversations(["conv_preview"], "inbox", { mailboxState: "trash" });
  await mailbox.permanentlyDeleteConversations(["conv_preview"]);
  await runDurableObjectAlarm(mailbox);
  expect(await env.MAIL_STORAGE.head(job.sourceKey)).toBeNull();
  expect(await env.MAIL_STORAGE.head(officePreviewKey(job.sourceKey))).toBeNull();
  expect(await mailbox.completeOfficePreview(job.messageId, job.attachmentId, job.sourceKey, "ready")).toBe(false);
  const deleted = batch(job);
  await consumeOfficePreviews(deleted.batch, env);
  expect(deleted.ack).toHaveBeenCalledOnce();
});

it("retries temporary converter failures and eventually leaves the original downloadable", async () => {
  const { mailbox, job } = await insertOffice("slides.pptx");
  // The unit-test binding has no container: exercise the real infrastructure error path.
  const first = batch(job);
  await consumeOfficePreviews(first.batch, env);
  expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  expect(first.ack).not.toHaveBeenCalled();
  const last = batch(job, 3);
  await consumeOfficePreviews(last.batch, env);
  expect(last.ack).toHaveBeenCalledOnce();
  expect((await mailbox.getAttachment(job.messageId, job.attachmentId))?.pdfPreviewStatus).toBe("failed");
  expect(await (await env.MAIL_STORAGE.get(job.sourceKey))?.text()).toBe("bytes");
});

it("cleans up a late PDF on redelivery after the email and its original cleanup are gone", async () => {
  const { mailbox, job } = await insertOffice();
  await mailbox.bulkUpdateConversations(["conv_preview"], "inbox", { mailboxState: "trash" });
  await mailbox.permanentlyDeleteConversations(["conv_preview"]);
  await runDurableObjectAlarm(mailbox);
  // Conversion finished after deletion, then the consumer lost its cleanup attempt.
  await env.MAIL_STORAGE.put(officePreviewKey(job.sourceKey), "%PDF-1.7\nlate");
  const redelivery = batch(job, 2);
  await consumeOfficePreviews(redelivery.batch, env);
  expect(redelivery.ack).toHaveBeenCalledOnce();
  await runInDurableObject(mailbox, async (instance, state) => {
    // Fail R2 only inside this mailbox, after the queue has acknowledged the task.
    const bindings = Reflect.get(instance, "bindings") as Env;
    const remove = vi.spyOn(bindings.MAIL_STORAGE, "delete")
      .mockRejectedValue(new Error("R2 unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await state.storage.deleteAlarm();
      await instance.alarm();
      expect(remove).toHaveBeenCalledOnce();
      expect(state.storage.sql.exec("select object_key, attempts from pending_object_deletions").toArray())
        .toEqual([{ object_key: officePreviewKey(job.sourceKey), attempts: 1 }]);
      expect(await state.storage.getAlarm()).not.toBeNull();
    } finally {
      remove.mockRestore();
      errorLog.mockRestore();
    }
    state.storage.sql.exec("update pending_object_deletions set next_attempt_at = 0");
  });
  await runDurableObjectAlarm(mailbox);
  expect(await env.MAIL_STORAGE.head(officePreviewKey(job.sourceKey))).toBeNull();
});

it("does not reset preview, delivery, conversation or read state on duplicate insertion and completion", async () => {
  const { mailbox, job } = await insertOffice();
  const original = await mailbox.getEmail(job.messageId);
  if (!original) throw new Error("Missing fixture email");
  await mailbox.setMessageRead("usr_preview", job.messageId, true);
  await runDurableObjectAlarm(mailbox);
  const before = await mailbox.getConversationPageSnapshot("conv_preview", "usr_preview", 10, null);
  await mailbox.completeOfficePreview(job.messageId, job.attachmentId, job.sourceKey, "ready");
  await mailbox.insertEmail(original);
  await mailbox.completeOfficePreview(job.messageId, job.attachmentId, job.sourceKey, "failed");
  const after = await mailbox.getConversationPageSnapshot("conv_preview", "usr_preview", 10, null);
  expect(after).toEqual({
    ...before,
    messages: before!.messages.map((email) => ({
      ...email,
      attachmentsJson: email.attachmentsJson.map((file) => ({ ...file, pdfPreviewStatus: "ready" })),
    })),
  });
  await runInDurableObject(mailbox, (_, state) => {
    expect(state.storage.sql.exec("select * from pending_office_previews").toArray()).toHaveLength(0);
  });
});

it("does not queue oversized Office attachments", async () => {
  const { mailbox, job } = await insertOffice("large.docx", MAX_OFFICE_PREVIEW_BYTES + 1);
  expect((await mailbox.getAttachment(job.messageId, job.attachmentId))?.pdfPreviewStatus).toBe("failed");
  await runInDurableObject(mailbox, (_, state) => {
    expect(state.storage.sql.exec("select * from pending_office_previews").toArray()).toHaveLength(0);
  });
});

it("queues previews when an incoming MIME attachment is processed", async () => {
  const mailboxId = `mbx_incoming_preview_${crypto.randomUUID()}`;
  const mailbox = mailboxStub(env, mailboxId);
  const id = `delivery_${crypto.randomUUID()}`;
  const rawObjectKey = `test/${id}/raw.eml`;
  await env.MAIL_STORAGE.put(rawObjectKey, [
    "From: sender@example.test", "To: me@example.test", "Subject: Incoming Office",
    'Content-Type: multipart/mixed; boundary="preview-test"', "",
    "--preview-test", "Content-Type: text/plain", "", "An Office attachment",
    "--preview-test", 'Content-Type: application/octet-stream; name="report.xlsx"',
    'Content-Disposition: attachment; filename="report.xlsx"',
    "Content-Transfer-Encoding: base64", "", "Ynl0ZXM=", "--preview-test--", "",
  ].join("\r\n"));
  await mailbox.enqueueInbound({
    id, mailboxId, rawObjectKey, envelopeFrom: "sender@example.test",
    envelopeTo: "me@example.test", receivedAt: Date.now(),
  });
  await runDurableObjectAlarm(mailbox);
  const email = await mailbox.getEmail(inboundMessageId(id));
  expect(email?.attachmentsJson[0]).toMatchObject({ filename: "report.xlsx", pdfPreviewStatus: "pending" });
});

it("uploads Office bytes, persists PDF output, and rejects invalid conversion responses", async () => {
  const key = `test/convert/${crypto.randomUUID()}`;
  await env.MAIL_STORAGE.put(key, "Office bytes");
  const result = await convertOfficeDocument(env.MAIL_STORAGE, async (request) => {
    expect(new URL(request.url).pathname).toBe("/forms/libreoffice/convert");
    const file = (await request.formData()).get("files");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new Error("Expected an Office file");
    expect(file.name).toBe("document.xlsx");
    expect(await file.text()).toBe("Office bytes");
    return new Response("%PDF-1.7\nconverted", { headers: { "content-type": "application/pdf" } });
  }, key, "xlsx");
  expect(result).toBe("ready");
  const pdf = await env.MAIL_STORAGE.get(officePreviewKey(key));
  expect(new TextDecoder().decode(await pdf!.arrayBuffer())).toBe("%PDF-1.7\nconverted");
  await expect(convertOfficeDocument(env.MAIL_STORAGE, async () => new Response("broken", { status: 503 }), key, "xlsx"))
    .rejects.toThrow("503");
  await expect(convertOfficeDocument(env.MAIL_STORAGE, async () => new Response("not a PDF"), key, "xlsx"))
    .rejects.toThrow("did not return a PDF");
  expect(await convertOfficeDocument(env.MAIL_STORAGE, async () => new Response("password required", { status: 400 }), key, "xlsx"))
    .toBe("failed");
});
