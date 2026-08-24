import { describe, expect, it } from "vitest";
import {
  dkimSigningDomains,
  originalHeaderValues,
} from "../src/mail/original-message";

describe("original message headers", () => {
  it("unfolds headers and extracts unique DKIM signing domains", () => {
    const raw = [
      "From: sender@example.com",
      "DKIM-Signature: v=1; a=rsa-sha256;",
      " d=mail.example.com; s=one; b=abc",
      "DKIM-Signature: v=1; d=EXAMPLE.NET; s=two; b=def",
      "DKIM-Signature: v=1; d=mail.example.com; s=three; b=ghi",
      "",
      "DKIM-Signature: d=body.invalid",
    ].join("\r\n");

    expect(originalHeaderValues(raw, "dkim-signature")).toHaveLength(3);
    expect(dkimSigningDomains(raw)).toEqual([
      "mail.example.com",
      "example.net",
    ]);
  });
});
