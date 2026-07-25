import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function body<T>(response: Response) {
  const value = await response.json<T>();
  expect(response.status, JSON.stringify(value)).toBeLessThan(400);
  return value;
}

function pngBytes() {
  // Minimal 1x1 PNG
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
    0x00, 0x05, 0xfe, 0x02, 0xfe, 0xa3, 0x5f, 0x45, 0x40, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return bytes;
}

describe("avatar upload", () => {
  it("uploads and deletes a profile avatar via Images", async () => {
    const bootstrap = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Avatar Admin",
          email: "avatar-admin@example.test",
        }),
      }),
    );
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0]!;
    await body(bootstrap);

    const form = new FormData();
    form.set(
      "file",
      new File([pngBytes()], "avatar.png", { type: "image/png" }),
    );
    const upload = await body<{ avatarUrl: string }>(
      await exports.default.fetch(
        new Request("http://example.test/api/auth/avatar", {
          method: "POST",
          headers: { cookie },
          body: form,
        }),
      ),
    );
    expect(upload.avatarUrl.length).toBeGreaterThan(0);
    expect(upload.avatarUrl).toContain("avatars/");

    const user = await env.DB.prepare(
      "SELECT avatar_url AS avatarUrl FROM users WHERE name = ?",
    )
      .bind("Avatar Admin")
      .first<{ avatarUrl: string | null }>();
    expect(user?.avatarUrl).toBe(upload.avatarUrl);

    await body(
      await exports.default.fetch(
        new Request("http://example.test/api/auth/avatar", {
          method: "DELETE",
          headers: { cookie },
        }),
      ),
    );
    const cleared = await env.DB.prepare(
      "SELECT avatar_url AS avatarUrl FROM users WHERE name = ?",
    )
      .bind("Avatar Admin")
      .first<{ avatarUrl: string | null }>();
    expect(cleared?.avatarUrl).toBeNull();
  });
});
