import { readFile } from "node:fs/promises";
import { expect, test } from "playwright/test";

test("converts Word, Excel, and PowerPoint attachments and keeps originals", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Real container conversion is covered once");
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Open seeded local demo" }).click();
  await expect(page).toHaveURL(/\/mail\//u);
  const mailboxId = new URL(page.url()).pathname.split("/")[2]!;
  const attachments = [];
  const files = [
    ["document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["workbook.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ];
  for (const [filename, contentType] of files) {
    const bytes = await readFile(new URL(`../test/fixtures/office/${filename}`, import.meta.url));
    const created = await page.request.post(`/api/mail/uploads?mailboxId=${mailboxId}`, {
      data: { filename, contentType, size: bytes.length },
    });
    expect(created.status()).toBe(201);
    const { upload } = await created.json() as {
      upload: { id: string; uploadUrl: string; headers: Record<string, string> };
    };
    expect((await page.request.put(upload.uploadUrl, { headers: upload.headers, data: bytes })).ok()).toBe(true);
    expect((await page.request.post(`/api/mail/uploads/${upload.id}/complete?mailboxId=${mailboxId}`)).ok()).toBe(true);
    attachments.push({ uploadId: upload.id, disposition: "attachment" });
  }
  const sent = await page.request.post("/api/mail/messages", {
    data: {
      mailboxId,
      requestId: crypto.randomUUID(),
      to: ["preview@example.test"],
      subject: "Office preview verification",
      bodyText: "Word, Excel, PowerPoint",
      attachments,
    },
  });
  expect(sent.status()).toBe(201);
  const { conversationId, messageId } = await sent.json() as { conversationId: string; messageId: string };
  await page.goto(`/mail/${mailboxId}?folder=sent&conversation=${conversationId}`);
  let downloaded = false;
  page.on("download", () => { downloaded = true; });
  for (const [index, [filename]] of files.entries()) {
    await page.getByRole("button", { name: `Preview ${filename}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator('.page[data-page-number="1"] canvas')).toBeVisible({ timeout: 120_000 });
    const base = `/api/mail/messages/${messageId}/attachments/att_${index + 1}`;
    const pdf = await page.request.get(`${base}/preview?mailboxId=${mailboxId}`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
    const original = await page.request.get(`${base}?mailboxId=${mailboxId}`);
    expect(await original.body()).toEqual(await readFile(new URL(`../test/fixtures/office/${filename}`, import.meta.url)));
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  }
  expect(downloaded).toBe(false);
});
