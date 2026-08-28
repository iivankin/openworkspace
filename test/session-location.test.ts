import { describe, expect, it } from "vitest";
import { formatSessionLocation } from "../src/lib/session-location";

describe("session location formatting", () => {
  it("handles Cloudflare special country codes without throwing", () => {
    expect(formatSessionLocation("T1")).toBe("Tor");
    expect(formatSessionLocation("XX")).toBe("Unknown location");
    expect(formatSessionLocation("A1")).toBe("A1");
  });
});
