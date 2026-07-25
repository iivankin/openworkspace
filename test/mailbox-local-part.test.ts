import { describe, expect, it } from "vitest";
import { mailboxAddress, mailboxLocalPart } from "../src/admin/mailbox-address";

describe("mailbox local-part helpers", () => {
  it("strips pasted hosts down to the local part", () => {
    expect(mailboxLocalPart("  support@looma.llc ")).toBe("support");
    expect(mailboxLocalPart("ilya")).toBe("ilya");
  });

  it("builds addresses on the installation domain", () => {
    expect(mailboxAddress("support", "looma.llc")).toBe("support@looma.llc");
    expect(mailboxAddress("a@other.test", "looma.llc")).toBe("a@looma.llc");
  });
});
