import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ api: {}, responseJson: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { ComposerSession } from "../src/mail/composer-session";

describe("ComposerSession", () => {
  it("publishes only current delivery plans that change the visible projection", () => {
    const session = new ComposerSession("mailbox");
    let publications = 0;
    session.subscribe(() => publications += 1);

    session.beginPlan("stale");
    session.beginPlan("current");
    expect(session.resolvePlan("stale", ["asset-a"])).toBe(false);
    expect(publications).toBe(0);

    expect(session.resolvePlan("current", ["asset-a"])).toBe(true);
    const linkedAssetIds = session.getSnapshot().linkedAssetIds;
    expect(publications).toBe(1);

    session.beginPlan("unchanged");
    expect(session.resolvePlan("unchanged", ["asset-a"])).toBe(true);
    expect(session.getSnapshot().linkedAssetIds).toBe(linkedAssetIds);
    expect(publications).toBe(1);

    session.beginPlan("failed");
    session.failPlan("failed");
    expect(session.getSnapshot()).toMatchObject({ planError: true });
    expect(session.getSnapshot().linkedAssetIds).toBe(linkedAssetIds);
    expect(publications).toBe(2);

    session.beginPlan("recovered");
    session.resolvePlan("recovered", ["asset-a"]);
    expect(session.getSnapshot()).toMatchObject({ planError: false });
    expect(session.getSnapshot().linkedAssetIds).toBe(linkedAssetIds);
    expect(publications).toBe(3);
  });

  it("reuses only a preserved submission attempt for the same payload", () => {
    const session = new ComposerSession("mailbox");

    expect(session.beginPreflight()).toBe(true);
    const first = session.beginSubmission([], "same-payload");
    expect(first).toEqual(expect.any(String));
    session.releaseSubmission(true);

    expect(session.beginPreflight()).toBe(true);
    expect(session.beginSubmission([], "same-payload")).toBe(first);
    session.releaseSubmission(false);

    expect(session.beginPreflight()).toBe(true);
    expect(session.beginSubmission([], "same-payload")).not.toBe(first);
  });
});
