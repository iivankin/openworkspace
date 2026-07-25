import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { createDb } from "../db/client";
import { users } from "../db/schema";
import type { AppEnv } from "../env";
import { apiError } from "../lib/http";
import { checkRateLimit } from "../lib/rate-limit";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export function avatarImageId(userId: string) {
  return `avatars/${userId}`;
}

function pickVariantUrl(variants: string[]) {
  return (
    variants.find((url) => /\/public$/i.test(url)) ??
    variants.find((url) => /\/avatar$/i.test(url)) ??
    variants[0] ??
    null
  );
}

async function rateLimitAvatar(c: Context<AppEnv>, userId: string) {
  const rate = await checkRateLimit(c.env.DB, {
    action: "avatar-upload",
    identifier: userId,
    limit: 10,
    windowMs: 60_000,
  });
  if (rate.allowed) return null;
  c.header("retry-after", String(rate.retryAfterSeconds));
  return apiError(c, 429, "RATE_LIMITED", "Too many avatar updates");
}

export async function uploadAvatar(c: Context<AppEnv>) {
  const user = c.get("user");
  const limited = await rateLimitAvatar(c, user.id);
  if (limited) return limited;

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return apiError(c, 400, "BAD_REQUEST", "Expected multipart form data");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return apiError(c, 400, "BAD_REQUEST", "Choose an image file to upload");
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return apiError(
      c,
      400,
      "BAD_REQUEST",
      "Avatar must be a JPEG, PNG, WebP, or GIF image",
    );
  }
  if (file.size <= 0 || file.size > MAX_AVATAR_BYTES) {
    return apiError(c, 400, "BAD_REQUEST", "Avatar must be at most 2 MB");
  }

  const imageId = avatarImageId(user.id);
  const bytes = await file.arrayBuffer();

  try {
    await c.env.IMAGES.hosted.image(imageId).delete();
  } catch {
    // Best-effort replace when a previous object cannot be deleted.
  }

  let metadata: ImageMetadata;
  try {
    metadata = await c.env.IMAGES.hosted.upload(bytes, {
      id: imageId,
      filename: file.name || "avatar",
      creator: user.id,
      requireSignedURLs: false,
      metadata: { purpose: "avatar" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Avatar upload failed";
    return apiError(c, 502, "BAD_GATEWAY", message);
  }

  const avatarUrl = pickVariantUrl(metadata.variants);
  if (!avatarUrl) {
    return apiError(
      c,
      502,
      "BAD_GATEWAY",
      "Images returned no public delivery URL. Create a public variant in the Images dashboard.",
    );
  }

  const now = new Date();
  const db = createDb(c.env.DB);
  await db
    .update(users)
    .set({ avatarUrl, updatedAt: now })
    .where(eq(users.id, user.id));

  return c.json({ ok: true as const, avatarUrl });
}

export async function deleteAvatar(c: Context<AppEnv>) {
  const user = c.get("user");
  const limited = await rateLimitAvatar(c, user.id);
  if (limited) return limited;

  const imageId = avatarImageId(user.id);
  await c.env.IMAGES.hosted.image(imageId).delete();

  const now = new Date();
  const db = createDb(c.env.DB);
  await db
    .update(users)
    .set({ avatarUrl: null, updatedAt: now })
    .where(eq(users.id, user.id));

  return c.json({ ok: true as const, avatarUrl: null });
}
