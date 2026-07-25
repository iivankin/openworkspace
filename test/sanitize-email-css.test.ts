import { describe, expect, it } from "vitest";
import { sanitizeEmailCss } from "../src/mail/sanitize-email-html";
import { mailRemoteProxyPath } from "../shared/mail-remote";
import { assertProxyableRemoteUrl } from "../worker/mail/remote-proxy";

describe("sanitizeEmailCss", () => {
  it("keeps ordinary email layout declarations", () => {
    expect(
      sanitizeEmailCss(
        "display:inline-block;background:#111;color:#fff;padding:12px 24px;border-radius:8px",
      ),
    ).toContain("background:#111");
  });

  it("rewrites remote urls through the worker proxy", () => {
    const cleaned = sanitizeEmailCss(
      "background-image:url(https://cdn.example/logo.png)",
      (url) => mailRemoteProxyPath("mbx_1", url),
    );
    expect(cleaned).toContain("/api/mail/remote?");
    expect(cleaned).toContain(encodeURIComponent("https://cdn.example/logo.png"));
    expect(cleaned).not.toMatch(/url\(["']?https:\/\/cdn\.example/i);
  });

  it("strips scriptable CSS and unrewritable remote urls", () => {
    const cleaned = sanitizeEmailCss(
      "width:100%; background:url(https://tracker.example/pixel.gif); color:expression(alert(1)); @import 'x.css'",
    );
    expect(cleaned).not.toMatch(/https:\/\/tracker/i);
    expect(cleaned).not.toMatch(/expression/i);
    expect(cleaned).not.toMatch(/@import/i);
  });

  it("allows data and cid image urls", () => {
    expect(
      sanitizeEmailCss("background-image:url(data:image/png;base64,aaa)"),
    ).toContain("data:image/png");
    expect(
      sanitizeEmailCss("background-image:url(cid:logo@mail)"),
    ).toContain("cid:logo@mail");
  });
});

describe("assertProxyableRemoteUrl", () => {
  it("accepts public https urls", () => {
    expect(assertProxyableRemoteUrl("https://cdn.example/a.png").hostname)
      .toBe("cdn.example");
  });

  it("rejects private and local targets", () => {
    expect(() => assertProxyableRemoteUrl("http://127.0.0.1/x")).toThrow();
    expect(() => assertProxyableRemoteUrl("http://192.168.0.1/x")).toThrow();
    expect(() => assertProxyableRemoteUrl("http://localhost/x")).toThrow();
    expect(() => assertProxyableRemoteUrl("file:///etc/passwd")).toThrow();
  });
});
