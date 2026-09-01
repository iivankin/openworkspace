import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  classifyInboundEmail,
  EmailAiClassificationError,
  MAILBOX_AI_MAX_EML_BYTES,
  MAILBOX_AI_MODEL,
  type MailboxAiRequest,
} from "../worker/mail/ai-classification";

const rawEmail = [
  "From: Founder <founder@example.com>",
  "To: team@example.test",
  "Subject: Product launch feedback",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="openworkspace-test"',
  "",
  "--openworkspace-test",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Launch plan: <a href="https://product.example.test/launch">notes</a></p>',
  "--openworkspace-test",
  'Content-Type: image/png; name="diagram.png"',
  "Content-Disposition: attachment; filename=diagram.png",
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
  "--openworkspace-test--",
].join("\r\n");
const rawMime = new TextEncoder().encode(rawEmail).buffer;

const configuration = {
  instructions: "Route product discussions to Product.",
  confidenceThreshold: 75,
};

function modelTextResponse(text: string) {
  return {
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        content: [{ type: "output_text", text }],
      },
    ],
  };
}

function modelResponse(value: unknown) {
  return modelTextResponse(JSON.stringify(value));
}

function requestFile(request: MailboxAiRequest) {
  const file = request.input[0]?.content.find(
    (content) => content.type === "input_file",
  );
  if (!file || file.type !== "input_file") {
    throw new Error("AI request did not contain an email file");
  }
  return file;
}

function requestMetadata(request: MailboxAiRequest) {
  const content = request.input[0]?.content.find(
    (item) => item.type === "input_text",
  );
  if (!content || content.type !== "input_text") {
    throw new Error("AI request did not contain email metadata");
  }
  return JSON.parse(content.text) as {
    customFolders: Array<{ id: string; name: string }>;
    rawMessageTruncated: boolean;
  };
}

describe("Workers AI mail classification", () => {
  it("accepts a confident result for an existing mailbox folder", async () => {
    let request: MailboxAiRequest | undefined;
    const result = await classifyInboundEmail({
      rawMime,
      folders: [{ id: "folder_product", name: "Product" }],
      configuration,
      run: async (input) => {
        request = input;
        return modelResponse({
          spam: false,
          spamConfidence: 0.98,
          folderId: "folder_product",
          folderConfidence: 0.91,
          reason: "A product discussion",
        });
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
    expect(request).toMatchObject({
      reasoning: { effort: "medium" },
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "email_classification",
          strict: true,
          schema: {
            additionalProperties: false,
            required: [
              "spam",
              "spamConfidence",
              "folderId",
              "folderConfidence",
              "reason",
            ],
          },
        },
      },
    });
    expect(request).not.toHaveProperty("max_output_tokens");
    expect(request?.instructions).toContain(
      "Trusted mailbox classification rules",
    );
    expect(request?.instructions).toContain(
      "as solicited transactional mail",
    );
    expect(request?.instructions).toContain(
      "Treat phishing, social engineering, business-email compromise",
    );
    expect(request?.instructions).toContain(
      "Compare From, Reply-To, Message-ID, and every link hostname available",
    );
    const file = requestFile(request!);
    expect(file).toMatchObject({
      type: "input_file",
      filename: "message.eml",
    });
    expect(file.file_data).toMatch(/^data:message\/rfc822;base64,/u);
    expect(Buffer.from(file.file_data.split(",", 2)[1]!, "base64").toString())
      .toBe(rawEmail);
    expect(requestMetadata(request!)).toEqual({
      customFolders: [{ id: "folder_product", name: "Product" }],
      rawMessageTruncated: false,
    });
  });

  it("keeps MIME content inside the .eml without separate image input", async () => {
    let request: MailboxAiRequest | undefined;
    await classifyInboundEmail({
      rawMime,
      folders: [],
      configuration,
      run: async (input) => {
        request = input;
        return modelResponse({
          spam: true,
          spamConfidence: 0.99,
          folderId: null,
          folderConfidence: 0,
          reason: "Credential phishing through login-confirm.example",
        });
      },
    });

    const encoded = requestFile(request!).file_data.split(",", 2)[1]!;
    expect(Buffer.from(encoded, "base64").toString()).toBe(rawEmail);
    expect(JSON.stringify(request)).not.toContain("input_image");
  });

  it("omits the end of oversized raw .eml input", async () => {
    let request: MailboxAiRequest | undefined;
    const oversizedMime = new TextEncoder().encode(
      `From: sender@example.test\r\nSubject: Large\r\n\r\nBEGIN\n${"x".repeat(
        MAILBOX_AI_MAX_EML_BYTES + 10_000,
      )}\nEND`,
    ).buffer;
    await classifyInboundEmail({
      rawMime: oversizedMime,
      folders: [],
      configuration,
      run: async (input) => {
        request = input;
        return modelResponse({
          spam: false,
          spamConfidence: 0,
          folderId: null,
          folderConfidence: 0,
          reason: "No suspicious content",
        });
      },
    });

    const encoded = requestFile(request!).file_data.split(",", 2)[1]!;
    const limitedMime = Buffer.from(encoded, "base64");
    expect(limitedMime.byteLength).toBe(MAILBOX_AI_MAX_EML_BYTES);
    expect(limitedMime.toString()).toContain("BEGIN");
    expect(limitedMime.toString()).not.toContain("END");
    expect(requestMetadata(request!).rawMessageTruncated).toBe(true);
  });

  it("falls back to Inbox for unknown folders and low-confidence spam", async () => {
    const result = await classifyInboundEmail({
      rawMime,
      folders: [{ id: "folder_product", name: "Product" }],
      configuration,
      run: async () => modelResponse({
        spam: true,
        spamConfidence: 0.6,
        folderId: "invented_folder",
        folderConfidence: 0.99,
        reason: "Uncertain result",
      }),
    });

    expect(result).toMatchObject({
      spam: false,
      folderId: null,
      folderConfidence: 0,
    });
  });

  it("does not assign a custom folder to accepted spam", async () => {
    const result = await classifyInboundEmail({
      rawMime,
      folders: [{ id: "folder_product", name: "Product" }],
      configuration,
      run: async () => modelResponse({
        spam: true,
        spamConfidence: 0.99,
        folderId: "folder_product",
        folderConfidence: 0.99,
        reason: "Credential phishing",
      }),
    });

    expect(result).toMatchObject({
      spam: true,
      folderId: null,
      folderConfidence: 0,
    });
  });

  it("turns malformed model output into a retryable classification error", async () => {
    await expect(classifyInboundEmail({
      rawMime,
      folders: [],
      configuration,
      run: async () => ({ response: "not json" }),
    })).rejects.toBeInstanceOf(EmailAiClassificationError);
  });

  it("rejects incomplete model output even when it contains valid JSON", async () => {
    await expect(classifyInboundEmail({
      rawMime,
      folders: [],
      configuration,
      run: async () => ({
        ...modelResponse({
          spam: true,
          spamConfidence: 1,
          folderId: null,
          folderConfidence: 0,
          reason: "Partial result",
        }),
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    })).rejects.toBeInstanceOf(EmailAiClassificationError);
  });
});
