import { describe, expect, it } from "vitest";
import {
  appendForwardedMessage,
  contextForNewRecipient,
  textWithQuotedContext,
} from "../worker/mail/outbound-content";
import type { MailAddress } from "../worker/mailbox/model";

const address = (value: string): MailAddress => ({ address: value, name: null });
const source = {
  fromJson: [address("author@example.net")],
  toJson: [address("me@example.test")],
  ccJson: [],
  subject: "Original subject",
  timelineAt: new Date("2026-07-23T10:00:00Z"),
  bodyText: "Original body",
  preview: "Original body",
};

describe("outbound message content", () => {
  it("serializes a forwarded message into the outgoing body", () => {
    const result = appendForwardedMessage("Please review.", undefined, source);
    expect(result.bodyText).toContain("Please review.\n\nForwarded message");
    expect(result.bodyText).toContain("From: author@example.net");
    expect(result.bodyText).toContain("Original body");
  });

  it("keeps participant context separate until SMTP serialization", () => {
    const context = contextForNewRecipient(source);
    expect(textWithQuotedContext("Welcome.", context)).toContain(
      "Welcome.\n\n> From: author@example.net",
    );
    expect(textWithQuotedContext("No quote.", null)).toBe("No quote.");
  });
});
