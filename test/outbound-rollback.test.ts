import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  discardPreparedObjects,
  prepareOutgoingEmail,
  type OutgoingMessageInput,
} from "../worker/mail/outbound";
import { submitOutgoing } from "../worker/mail/outbound-service";
import { linkedAttachmentTextToken } from "../shared/mail";
import { composeSchema } from "../worker/mail/schemas";
import {
  composerUploadKey,
  createComposerUploadIntent,
  discardComposerUploads,
  finalizeComposerUpload,
} from "../worker/mail/uploads";

async function createFinalizedUpload(input: {
  mailboxId: string;
  userId: string;
  filename: string;
  contentType: string;
  body: string;
}) {
  const intent = await createComposerUploadIntent({
    env,
    requestOrigin: "https://mail.example.test",
    mailboxId: input.mailboxId,
    userId: input.userId,
    filename: input.filename,
    contentType: input.contentType,
    size: new TextEncoder().encode(input.body).byteLength,
  });
  await env.MAIL_STORAGE.put(
    composerUploadKey(input.mailboxId, input.userId, intent.id),
    input.body,
  );
  return finalizeComposerUpload({
    env,
    mailboxId: input.mailboxId,
    userId: input.userId,
    uploadId: intent.id,
  });
}

describe("outbound object rollback", () => {
  it("returns after persistence while composer cleanup runs in the background", async () => {
    const mailboxId = `mbx_cleanup_${crypto.randomUUID()}`;
    const userId = `usr_cleanup_${crypto.randomUUID()}`;
    const upload = await createFinalizedUpload({
      mailboxId,
      userId,
      filename: "cleanup.txt",
      contentType: "text/plain",
      body: "cleanup",
    });
    let releaseDelete = () => {};
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const blockingDelete: R2Bucket["delete"] = async (keys) => {
      await deleteGate;
      await env.MAIL_STORAGE.delete(keys);
    };
    const blockingStorage = new Proxy(env.MAIL_STORAGE, {
      get(target, property) {
        if (property === "delete") return blockingDelete;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const blockingEnv: Env = { ...env, MAIL_STORAGE: blockingStorage };
    const deferredTasks: Promise<unknown>[] = [];
    const submissionInput = {
      env: blockingEnv,
      requestUrl: "https://mail.example.test",
      fromAddress: "sender@example.test",
      fromName: "Sender",
      compose: {
        requestId: crypto.randomUUID(),
        mailboxId,
        userId,
        to: ["recipient@example.test"],
        cc: [],
        bcc: [],
        subject: "Background cleanup",
        bodyText: "Authored content",
        attachments: [{ uploadId: upload.id, disposition: "attachment" }],
      },
      conversationId: `conv_${crypto.randomUUID()}`,
      related: null,
      forwarded: null,
      includeRelatedContext: false,
      defer: (task) => deferredTasks.push(task),
    } satisfies Parameters<typeof submitOutgoing>[0];
    const submission = submitOutgoing(submissionInput);
    const timeout = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = await Promise.race([
        submission,
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => resolve(timeout), 500);
        }),
      ]);
      expect(result).not.toBe(timeout);
      expect(deferredTasks.length).toBeGreaterThanOrEqual(1);
      const firstDeferredCount = deferredTasks.length;
      const replay = await submitOutgoing(submissionInput);
      expect(replay.inserted).toBe(false);
      expect(deferredTasks.length).toBeGreaterThan(firstDeferredCount);
    } finally {
      if (timer) clearTimeout(timer);
      releaseDelete();
      await Promise.all(deferredTasks);
      const result = await submission;
      await env.MAIL_STORAGE.delete([
        ...result.email.attachmentsJson.map((file) => file.r2Key),
        ...(result.email.bodyHtmlR2Key ? [result.email.bodyHtmlR2Key] : []),
      ]);
    }
  });

  it("rejects non-image uploads submitted as inline content", async () => {
    const mailboxId = `mbx_inline_${crypto.randomUUID()}`;
    const userId = `usr_inline_${crypto.randomUUID()}`;
    const upload = await createFinalizedUpload({
      mailboxId,
      userId,
      filename: "document.txt",
      contentType: "text/plain",
      body: "not an image",
    });
    const uploadId = upload.id;
    const parsed = composeSchema.parse({
      requestId: crypto.randomUUID(),
      mailboxId,
      to: ["recipient@example.test"],
      attachments: [{
        uploadId,
        disposition: "inline",
        contentId: "document@example.test",
      }],
    });

    try {
      await expect(prepareOutgoingEmail({
        env,
        requestUrl: "https://mail.example.test",
        compose: { ...parsed, userId },
        requestFingerprint: "inline-validation-fingerprint",
        id: `msg_inline_${crypto.randomUUID()}`,
        conversationId: `conv_${crypto.randomUUID()}`,
        related: null,
        forwarded: null,
        includeRelatedContext: false,
        fromAddress: "sender@example.test",
        fromName: "Sender",
        now: new Date("2026-07-27T00:00:00Z"),
      })).rejects.toThrow("Inline images must be PNG, JPEG, GIF, or WebP");
    } finally {
      await discardComposerUploads({
        env,
        mailboxId,
        userId,
        uploadIds: [uploadId],
      });
    }
  });

  it("waits for every attempted write before removing a failed attempt", async () => {
    const mailboxId = `mbx_rollback_${crypto.randomUUID()}`;
    const userId = `usr_rollback_${crypto.randomUUID()}`;
    const upload = await createFinalizedUpload({
      mailboxId,
      userId,
      filename: "attachment.txt",
      contentType: "text/plain",
      body: "attachment",
    });
    const uploadId = upload.id;
    const sourceKey = upload.r2Key;
    const messageId = `msg_rollback_${crypto.randomUUID()}`;
    const attemptPrefix = `mailboxes/${mailboxId}/messages/${messageId}/attempts/`;

    const failingPut: R2Bucket["put"] = async (key, value, options) => {
      if (key.endsWith("/body.html")) {
        throw new Error("Simulated HTML write failure");
      }
      return env.MAIL_STORAGE.put(key, value, options);
    };
    const failingStorage = new Proxy(env.MAIL_STORAGE, {
      get(target, property) {
        if (property === "put") return failingPut;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failingEnv: Env = { ...env, MAIL_STORAGE: failingStorage };
    const parsed = composeSchema.parse({
      requestId: crypto.randomUUID(),
      mailboxId,
      to: ["recipient@example.test"],
      bodyText: "Authored content",
      bodyHtml: "<p>Authored content</p>",
      attachments: [{ uploadId }],
    });
    const compose: OutgoingMessageInput = { ...parsed, userId };

    try {
      await expect(prepareOutgoingEmail({
        env: failingEnv,
        requestUrl: "https://mail.example.test",
        compose,
        requestFingerprint: "rollback-fingerprint",
        id: messageId,
        conversationId: `conv_${crypto.randomUUID()}`,
        related: null,
        forwarded: null,
        includeRelatedContext: false,
        fromAddress: "sender@example.test",
        fromName: "Sender",
        now: new Date("2026-07-27T00:00:00Z"),
      })).rejects.toThrow("Simulated HTML write failure");

      expect((await env.MAIL_STORAGE.list({ prefix: attemptPrefix })).objects)
        .toHaveLength(0);
      expect(await env.MAIL_STORAGE.head(sourceKey)).not.toBeNull();
    } finally {
      await discardComposerUploads({
        env,
        mailboxId,
        userId,
        uploadIds: [uploadId],
      });
    }
  });

  it("builds preview after resolving composer attachment markers", async () => {
    const mailboxId = `mbx_preview_${crypto.randomUUID()}`;
    const userId = `usr_preview_${crypto.randomUUID()}`;
    const upload = await createFinalizedUpload({
      mailboxId,
      userId,
      filename: "preview.txt",
      contentType: "text/plain",
      body: "preview attachment",
    });
    const token = linkedAttachmentTextToken(upload.id);
    const parsed = composeSchema.parse({
      requestId: crypto.randomUUID(),
      mailboxId,
      to: ["recipient@example.test"],
      bodyText: token,
      bodyHtml: `<p><span data-linked-attachment="${upload.id}">preview.txt</span></p>`,
      attachments: [{ uploadId: upload.id }],
    });
    let prepared: Awaited<ReturnType<typeof prepareOutgoingEmail>> | null = null;

    try {
      prepared = await prepareOutgoingEmail({
        env,
        requestUrl: "https://mail.example.test",
        compose: { ...parsed, userId },
        requestFingerprint: "preview-fingerprint",
        id: `msg_preview_${crypto.randomUUID()}`,
        conversationId: `conv_${crypto.randomUUID()}`,
        related: null,
        forwarded: null,
        includeRelatedContext: false,
        fromAddress: "sender@example.test",
        fromName: "Sender",
        now: new Date("2026-07-27T00:00:00Z"),
      });

      expect(prepared.email.preview).toBe("");
      expect(prepared.email.preview).not.toContain("openworkspace-attachment");
    } finally {
      if (prepared) {
        await discardPreparedObjects(env, prepared.storageKeys);
      }
      await discardComposerUploads({
        env,
        mailboxId,
        userId,
        uploadIds: [upload.id],
      });
    }
  });
});
