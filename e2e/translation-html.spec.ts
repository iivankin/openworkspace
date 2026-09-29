import { expect, test } from "playwright/test";

test("translation preserves email elements and treats model output as text", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/mail/translation-html.ts";
    const { emailHtmlTextSegments, translatedEmailHtml } = await import(modulePath);
    const original = `<!doctype html><html><head><style>table { width: 100%; }</style></head>
      <body><table><tr><td><p>Hello <strong>friend</strong></p>
      <a href="https://example.com/order">Open order</a><img src="/logo.png" alt="Logo"></td></tr></table></body></html>`;
    const segments = emailHtmlTextSegments(original);
    const translated = translatedEmailHtml(
      original,
      ["Привет", "друг", "<script>alert(1)</script>"],
      true,
    );
    const document = new DOMParser().parseFromString(translated ?? "", "text/html");
    return {
      segments,
      paragraph: document.querySelector("p")?.innerHTML,
      linkText: document.querySelector("a")?.textContent,
      linkHref: document.querySelector("a")?.getAttribute("href"),
      imageSrc: document.querySelector("img")?.getAttribute("src"),
      tableCount: document.querySelectorAll("table").length,
      styles: document.querySelector("style")?.textContent,
      scriptCount: document.querySelectorAll("script").length,
    };
  });

  expect(result.segments).toEqual(["Hello", "friend", "Open order"]);
  expect(result.paragraph).toBe("Привет <strong>друг</strong>");
  expect(result.linkText).toBe("<script>alert(1)</script>");
  expect(result.linkHref).toBe("https://example.com/order");
  expect(result.imageSrc).toBe("/logo.png");
  expect(result.tableCount).toBe(1);
  expect(result.styles).toContain("width: 100%");
  expect(result.scriptCount).toBe(0);
});
