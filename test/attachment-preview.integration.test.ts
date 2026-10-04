import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { mailboxStub } from "../worker/mailbox";

it("previews attachments inline with access checks, ranges, and inert text", async () => {
  const bootstrap = await exports.default.fetch(new Request(
    "http://example.test/api/auth/mock/bootstrap",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    },
  ));
  expect(bootstrap.status).toBe(200);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
  await bootstrap.json();
  const mailboxes = await exports.default.fetch(new Request(
    "http://example.test/api/mail/mailboxes", { headers: { cookie } },
  ));
  const { mailboxes: [mailbox] } = await mailboxes.json<{ mailboxes: { id: string }[] }>();
  const mailboxId = mailbox!.id;
  const fixtures = [
    { id: "pdf", filename: "report.pdf", contentType: "application/octet-stream", body: "%PDF-1.7\npreview" },
    { id: "image", filename: "pixel.png", contentType: "image/png", body: "image bytes" },
    { id: "text", filename: "data.xml", contentType: "application/xml", body: '<script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script>' },
    { id: "html", filename: "unsafe.pdf", contentType: "text/html", body: "<script>alert(1)</script>" },
    { id: "svg", filename: "unsafe.svg", contentType: "image/svg+xml", body: "<svg onload='alert(1)'/>" },
    { id: "office", filename: "report.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", body: "office bytes" },
  ];
  const attachments = fixtures.map((file) => ({
    ...file,
    r2Key: `preview/${file.id}`,
    size: new TextEncoder().encode(file.body).length,
    contentId: null,
    disposition: "attachment" as const,
    delivery: "attached" as const,
    downloadTokenHash: null,
    downloadExpiresAt: null,
  }));
  for (const file of attachments) await env.MAIL_STORAGE.put(file.r2Key, file.body);
  await mailboxStub(env, mailboxId).insertEmail({
    id: "msg_preview",
    conversationId: "conv_preview",
    direction: "incoming",
    fromJson: [{ address: "sender@example.net", name: null }],
    toJson: [{ address: "admin@example.test", name: null }],
    subject: "Previews",
    timelineAt: new Date(),
    transportState: "received",
    attachmentsJson: attachments,
  });
  const url = (id: string, selectedMailbox = mailboxId) =>
    `http://example.test/api/mail/messages/msg_preview/attachments/${id}/preview?mailboxId=${selectedMailbox}`;
  const anonymous = await exports.default.fetch(url("pdf"));
  expect(anonymous.status).toBe(401);
  await anonymous.json();
  const forbidden = await exports.default.fetch(new Request(
    url("pdf", "mbx_other"), { headers: { cookie } },
  ));
  expect(forbidden.status).toBe(403);
  await forbidden.json();

  for (const [id, contentType] of [
    ["pdf", "application/pdf"],
    ["image", "image/png"],
    ["text", "text/plain; charset=utf-8"],
  ]) {
    const response = await exports.default.fetch(new Request(url(id!), { headers: { cookie } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("inline;");
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new TextDecoder().decode(await response.arrayBuffer()))
      .toBe(fixtures.find((file) => file.id === id)!.body);
  }
  const partial = await exports.default.fetch(new Request(url("pdf"), {
    headers: { cookie, range: "bytes=0-7" },
  }));
  expect(partial.status).toBe(206);
  expect(partial.headers.get("content-range")).toBe("bytes 0-7/16");
  expect(new TextDecoder().decode(await partial.arrayBuffer())).toBe("%PDF-1.7");

  for (const id of ["html", "svg"]) {
    const response = await exports.default.fetch(new Request(url(id), { headers: { cookie } }));
    expect(response.status).toBe(422);
    await response.json();
  }
  const pending = await exports.default.fetch(new Request(url("office"), { headers: { cookie } }));
  expect(pending.status).toBe(409);
  await pending.json();
  await env.MAIL_STORAGE.put("preview/office.preview.pdf", "%PDF-1.7\nconverted");
  await mailboxStub(env, mailboxId).completeOfficePreview("msg_preview", "office", "preview/office", "ready");
  const converted = await exports.default.fetch(new Request(url("office"), { headers: { cookie } }));
  expect(converted.status).toBe(200);
  expect(converted.headers.get("content-type")).toBe("application/pdf");
  expect(converted.headers.get("content-disposition")).toContain("report.docx.pdf");
  expect(new TextDecoder().decode(await converted.arrayBuffer())).toBe("%PDF-1.7\nconverted");
  const original = await exports.default.fetch(new Request(url("office").replace("/preview?", "?"), { headers: { cookie } }));
  expect(original.headers.get("content-disposition")).toContain("attachment;");
  expect(new TextDecoder().decode(await original.arrayBuffer())).toBe("office bytes");
  await env.MAIL_STORAGE.delete("preview/pdf");
  const missing = await exports.default.fetch(new Request(url("pdf"), { headers: { cookie } }));
  expect(missing.status).toBe(404);
  await missing.json();
});
