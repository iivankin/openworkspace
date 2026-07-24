import { describe, expect, it } from "vitest";
import {
  attachmentsRequiringDownloadLinks,
  messageIdForRequest,
} from "../worker/mail/outbound";
import { composeSchema } from "../worker/mail/schemas";
import { normalizeEmail, normalizeMailboxAddress } from "../worker/lib/ids";
import { boundedMessageIds, replyThreadHeaders } from "../worker/mail/rfc";
import { emailDestinations } from "../worker/mail/outbound-delivery";

describe("outbound email limits", () => {
  it("externalizes only as many large attachments as needed for the 5 MiB MIME limit", () => {
    const linked = attachmentsRequiringDownloadLinks({
      subject: "Quarterly files",
      bodyText: "See attachments.",
      attachments: [
        { id: "largest", size: 3_200_000 },
        { id: "smaller", size: 2_000_000 },
      ],
    });

    expect([...linked]).toEqual(["largest"]);
  });

  it("enforces the provider's combined 50-recipient limit", () => {
    const result = composeSchema.safeParse({
      requestId: crypto.randomUUID(),
      mailboxId: "mailbox",
      to: Array.from({ length: 25 }, (_, index) => `to${index}@example.test`),
      cc: Array.from({ length: 25 }, (_, index) => `cc${index}@example.test`),
      bcc: ["hidden@example.test"],
    });

    expect(result.success).toBe(false);
  });

  it("accepts a Bcc-only message", () => {
    const result = composeSchema.safeParse({
      requestId: crypto.randomUUID(),
      mailboxId: "mailbox",
      bcc: ["hidden@example.test"],
    });

    expect(result.success).toBe(true);
    expect(emailDestinations({
      toJson: [],
      ccJson: [],
      bccJson: [{ address: "hidden@example.test", name: null }],
    })).toEqual({ bcc: ["hidden@example.test"] });
  });

  it("preserves external local-part case and deduplicates recipient roles", () => {
    const result = composeSchema.safeParse({
      requestId: crypto.randomUUID(),
      mailboxId: "mailbox",
      to: ["Person@Example.NET", "Person@example.net"],
      cc: ["Person@example.net", "copy@Example.NET"],
      bcc: ["copy@example.net", "hidden@Example.NET"],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({
      to: ["Person@example.net"],
      cc: ["copy@example.net"],
      bcc: ["hidden@example.net"],
    });
    expect(normalizeEmail("Person@Example.NET")).toBe("Person@example.net");
    expect(normalizeMailboxAddress("Person@Example.NET")).toBe("person@example.net");
  });

  it("accepts one attachment above the former 14 MB base64 cap", () => {
    const result = composeSchema.safeParse({
      requestId: crypto.randomUUID(),
      mailboxId: "mailbox",
      to: ["recipient@example.test"],
      attachments: [{
        filename: "large.bin",
        contentType: "application/octet-stream",
        contentBase64: "AAAA".repeat(3_500_001),
      }],
    });

    expect(result.success).toBe(true);
  });

  it("keeps only the newest References within provider limits", () => {
    const references = boundedMessageIds(
      Array.from({ length: 140 }, (_, index) => `<message-${index}@example.test>`),
    );

    expect(references).toHaveLength(100);
    expect(references[0]).toBe("<message-40@example.test>");
    expect(references.at(-1)).toBe("<message-139@example.test>");
    expect(new TextEncoder().encode(references.join(" ")).byteLength).toBeLessThanOrEqual(12 * 1024);
  });

  it("derives one local message ID from a client request ID", async () => {
    const requestId = crypto.randomUUID();
    const first = await messageIdForRequest("mailbox", requestId);
    const second = await messageIdForRequest("mailbox", requestId);

    expect(second).toBe(first);
  });

  it("uses a parent's single In-Reply-To when References is absent", () => {
    expect(replyThreadHeaders({
      messageIdHeader: "<parent@example.test>",
      inReplyToJson: ["<grandparent@example.test>"],
      referencesJson: [],
    })).toEqual({
      inReplyTo: ["<parent@example.test>"],
      references: ["<grandparent@example.test>", "<parent@example.test>"],
    });
  });
});
