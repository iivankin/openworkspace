import { describe, expect, it } from "bun:test";

import { decideDelivery } from "@open-workspace/email/worker/mailbox/inbound-decision.ts";
import type { DeliveryInput } from "@open-workspace/email/worker/mailbox/inbound-decision.ts";

function input(overrides: Partial<DeliveryInput> = {}): DeliveryInput {
  return {
    blocked: false,
    trusted: false,
    authenticated: false,
    rules: null,
    classification: null,
    parent: null,
    startsConversation: true,
    folderExists: () => true,
    ...overrides,
  };
}

const rules = (
  placement: NonNullable<DeliveryInput["rules"]>["placement"],
  extra: Partial<NonNullable<DeliveryInput["rules"]>> = {}
) => ({ placement, notSpam: false, markRead: false, ...extra });

const aiSpam = { spam: true, folderId: null };

describe("where an incoming message goes", () => {
  it("files new mail by a rule, else by AI sorting", () => {
    expect(
      decideDelivery(
        input({ rules: rules({ type: "folder", folderId: "fld_a" }) })
      )
    ).toEqual({
      split: false,
      state: "active",
      folderId: "fld_a",
      markRead: false,
    });
    expect(
      decideDelivery(
        input({ classification: { spam: false, folderId: "fld_ai" } })
      )
    ).toMatchObject({ state: "active", folderId: "fld_ai" });
    // A rule's folder that was deleted files nothing.
    expect(
      decideDelivery(
        input({
          rules: rules({ type: "folder", folderId: "fld_gone" }),
          folderExists: () => false,
        })
      )
    ).toMatchObject({ state: "active", folderId: null });
  });

  it("trusts a sender over an AI spam verdict only when authenticated", () => {
    expect(
      decideDelivery(input({ trusted: true, classification: aiSpam }))
    ).toMatchObject({ state: "spam" });
    expect(
      decideDelivery(
        input({ trusted: true, authenticated: true, classification: aiSpam })
      )
    ).toMatchObject({ state: "active" });
    expect(
      decideDelivery(
        input({ rules: rules(null, { notSpam: true }), classification: aiSpam })
      )
    ).toMatchObject({ state: "active" });
  });

  it("sends a blocked sender to Spam whatever a rule or trust says", () => {
    expect(
      decideDelivery(
        input({
          blocked: true,
          trusted: true,
          authenticated: true,
          rules: rules(
            { type: "folder", folderId: "fld_a" },
            { notSpam: true }
          ),
        })
      )
    ).toMatchObject({ state: "spam", folderId: null, markRead: false });
  });

  it("keeps spam out of a thread elsewhere, and lets it join spam", () => {
    const parent = { state: "active" as const, folderId: "fld_a" };

    expect(
      decideDelivery(
        input({ classification: aiSpam, parent, startsConversation: false })
      )
    ).toMatchObject({ split: true, state: "spam" });
    expect(
      decideDelivery(
        input({
          classification: aiSpam,
          parent: { state: "spam", folderId: null },
          startsConversation: false,
        })
      )
    ).toMatchObject({ split: false, state: "spam" });
  });

  it("keeps mail that isn't spam out of a thread in Spam", () => {
    expect(
      decideDelivery(
        input({
          trusted: true,
          authenticated: true,
          parent: { state: "spam", folderId: null },
          startsConversation: false,
        })
      )
    ).toMatchObject({ split: true, state: "active" });
  });

  it("keeps an archived notification thread archived under an Archive rule", () => {
    const archived = { state: "archive" as const, folderId: null };

    expect(
      decideDelivery(
        input({
          rules: rules({ type: "archive" }),
          parent: archived,
          startsConversation: false,
        })
      )
    ).toMatchObject({ split: false, state: "archive" });
    // Without the rule, new mail brings the thread back.
    expect(
      decideDelivery(input({ parent: archived, startsConversation: false }))
    ).toMatchObject({ state: "active" });
  });

  it("leaves a received thread where it is, bringing it back from Trash", () => {
    expect(
      decideDelivery(
        input({
          rules: rules({ type: "folder", folderId: "fld_b" }),
          parent: { state: "active", folderId: "fld_a" },
          startsConversation: false,
        })
      )
    ).toMatchObject({ state: "active", folderId: "fld_a" });
    expect(
      decideDelivery(
        input({
          parent: { state: "trash", folderId: null },
          startsConversation: false,
        })
      )
    ).toMatchObject({ split: false, state: "active" });
  });

  it("files a thread's first incoming message like new mail", () => {
    expect(
      decideDelivery(
        input({
          rules: rules({ type: "archive" }),
          parent: { state: "active", folderId: null },
          startsConversation: true,
        })
      )
    ).toMatchObject({ state: "archive" });
  });

  it("marks read only mail that isn't spam", () => {
    expect(
      decideDelivery(input({ rules: rules(null, { markRead: true }) }))
    ).toMatchObject({ markRead: true });
    expect(
      decideDelivery(
        input({ rules: rules({ type: "spam" }, { markRead: true }) })
      )
    ).toMatchObject({ state: "spam", markRead: false });
  });
});
