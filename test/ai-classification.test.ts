import { describe, expect, it } from "vitest";
import {
  classifyInboundEmail,
  EmailAiClassificationError,
  MAILBOX_AI_MODEL,
  type MailboxAiRequest,
} from "../worker/mail/ai-classification";
import type { NewEmail } from "../worker/mailbox/schema";

const email: NewEmail = {
  id: "msg_ai_test",
  conversationId: "conv_ai_test",
  direction: "incoming",
  fromJson: [{ address: "founder@example.com", name: "Founder" }],
  toJson: [{ address: "team@example.test", name: null }],
  subject: "Product launch feedback",
  bodyText: "Here are my notes about the launch plan.",
  timelineAt: new Date("2026-08-24T10:00:00.000Z"),
  transportState: "received",
};

const configuration = {
  instructions: "Route product discussions to Product.",
  confidenceThreshold: 75,
};

describe("Workers AI mail classification", () => {
  it("accepts a confident result for an existing mailbox folder", async () => {
    let request: MailboxAiRequest | undefined;
    const result = await classifyInboundEmail({
      email,
      folders: [{ id: "folder_product", name: "Product" }],
      configuration,
      run: async (input) => {
        request = input;
        return {
          response: JSON.stringify({
            spam: false,
            spamConfidence: 0.98,
            folderId: "folder_product",
            folderConfidence: 0.91,
            reason: "A product discussion",
          }),
        };
      },
      now: () => 123,
    });

    expect(result).toEqual({
      source: "workers-ai",
      model: MAILBOX_AI_MODEL,
      processedAt: 123,
      spam: false,
      spamConfidence: 0.98,
      folderId: "folder_product",
      folderConfidence: 0.91,
      reason: "A product discussion",
    });
    expect(request?.response_format.type).toBe("json_schema");
    expect(request?.messages[0]?.content).toContain(
      "Trusted mailbox classification rules",
    );
  });

  it("falls back to Inbox for unknown folders and low-confidence spam", async () => {
    const result = await classifyInboundEmail({
      email,
      folders: [{ id: "folder_product", name: "Product" }],
      configuration,
      run: async () => ({
        response: {
          spam: true,
          spamConfidence: 0.6,
          folderId: "invented_folder",
          folderConfidence: 0.99,
          reason: "Uncertain result",
        },
      }),
    });

    expect(result).toMatchObject({
      spam: false,
      folderId: null,
    });
  });

  it("turns malformed model output into a retryable classification error", async () => {
    await expect(classifyInboundEmail({
      email,
      folders: [],
      configuration,
      run: async () => ({ response: "not json" }),
    })).rejects.toBeInstanceOf(EmailAiClassificationError);
  });
});
