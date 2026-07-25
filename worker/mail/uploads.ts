import { AwsClient } from "aws4fetch";
import { MAX_COMPOSER_ATTACHMENT_BYTES } from "../../shared/mail";
import type { AppEnv } from "../env";
import { createId } from "../lib/ids";

type Bindings = AppEnv["Bindings"];

const PRESIGN_TTL_SECONDS = 15 * 60;

export type UploadedAttachment = {
  id: string;
  r2Key: string;
  filename: string;
  contentType: string;
  size: number;
};

export type ComposerUploadIntent = {
  id: string;
  uploadUrl: string;
  headers: Record<string, string>;
  filename: string;
  contentType: string;
  size: number;
};

type UploadMeta = {
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  mailboxId: string;
};

export function composerUploadKey(
  mailboxId: string,
  userId: string,
  uploadId: string,
) {
  return `mailboxes/${mailboxId}/uploads/${userId}/${uploadId}`;
}

function composerUploadMetaKey(r2Key: string) {
  return `${r2Key}.meta`;
}

function r2S3Credentials(env: Bindings) {
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucketName = env.R2_BUCKET_NAME?.trim() || "openworkspace";
  if (!accessKeyId || !secretAccessKey || !accountId) return null;
  return { accessKeyId, secretAccessKey, accountId, bucketName };
}

async function putUploadMeta(input: {
  env: Bindings;
  r2Key: string;
  meta: UploadMeta;
}) {
  await input.env.MAIL_STORAGE.put(
    composerUploadMetaKey(input.r2Key),
    JSON.stringify(input.meta),
    { httpMetadata: { contentType: "application/json" } },
  );
}

async function readUploadMeta(env: Bindings, r2Key: string) {
  const object = await env.MAIL_STORAGE.get(composerUploadMetaKey(r2Key));
  if (!object) return null;
  try {
    return JSON.parse(await object.text()) as UploadMeta;
  } catch {
    return null;
  }
}

async function signR2PutUrl(input: {
  env: Bindings;
  r2Key: string;
  contentType: string;
}) {
  const credentials = r2S3Credentials(input.env);
  if (!credentials) return null;

  const client = new AwsClient({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const url = new URL(
    `https://${credentials.accountId}.r2.cloudflarestorage.com/${credentials.bucketName}/${input.r2Key}`,
  );
  url.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));
  const signed = await client.sign(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": input.contentType },
    }),
    { aws: { signQuery: true } },
  );
  return signed.url;
}

export async function createComposerUploadIntent(input: {
  env: Bindings;
  requestOrigin: string;
  mailboxId: string;
  userId: string;
  filename: string;
  contentType: string;
  size: number;
}): Promise<ComposerUploadIntent> {
  if (input.size <= 0) {
    throw new UploadValidationError("Attachment file is empty");
  }
  if (input.size > MAX_COMPOSER_ATTACHMENT_BYTES) {
    throw new UploadValidationError(
      `Attachments are limited to ${Math.floor(MAX_COMPOSER_ATTACHMENT_BYTES / 1_000_000)} MB per message`,
    );
  }

  const id = createId("upl");
  const r2Key = composerUploadKey(input.mailboxId, input.userId, id);
  const filename = input.filename.trim().slice(0, 255) || "attachment";
  const contentType =
    input.contentType.trim().slice(0, 255) || "application/octet-stream";

  await putUploadMeta({
    env: input.env,
    r2Key,
    meta: {
      filename,
      contentType,
      size: input.size,
      uploadedBy: input.userId,
      mailboxId: input.mailboxId,
    },
  });

  const headers = { "content-type": contentType };
  const presignedUrl = await signR2PutUrl({
    env: input.env,
    r2Key,
    contentType,
  });
  if (presignedUrl) {
    return {
      id,
      uploadUrl: presignedUrl,
      headers,
      filename,
      contentType,
      size: input.size,
    };
  }

  // Local / Deploy without R2 S3 API tokens: same client flow, Worker receives PUT.
  const fallback = new URL("/api/mail/uploads/content", input.requestOrigin);
  fallback.searchParams.set("mailboxId", input.mailboxId);
  fallback.searchParams.set("uploadId", id);
  return {
    id,
    uploadUrl: fallback.toString(),
    headers,
    filename,
    contentType,
    size: input.size,
  };
}

export async function storeComposerUploadContent(input: {
  env: Bindings;
  mailboxId: string;
  userId: string;
  uploadId: string;
  body: ReadableStream | ArrayBuffer | Blob | null;
  contentType: string | undefined;
}) {
  if (!input.body) {
    throw new UploadValidationError("Attachment body is required");
  }
  const r2Key = composerUploadKey(input.mailboxId, input.userId, input.uploadId);
  const meta = await readUploadMeta(input.env, r2Key);
  if (!meta || meta.uploadedBy !== input.userId || meta.mailboxId !== input.mailboxId) {
    throw new UploadValidationError("Attachment upload was not found");
  }
  const contentType = (input.contentType || meta.contentType)
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (contentType !== meta.contentType.trim().toLowerCase()) {
    throw new UploadValidationError("Attachment content type does not match");
  }
  await input.env.MAIL_STORAGE.put(r2Key, input.body, {
    httpMetadata: { contentType: meta.contentType },
  });
  const stored = await input.env.MAIL_STORAGE.head(r2Key);
  if (!stored || stored.size !== meta.size) {
    try {
      await input.env.MAIL_STORAGE.delete(r2Key);
    } catch {
      // ignore cleanup failure
    }
    throw new UploadValidationError("Attachment size does not match");
  }
}

export async function loadComposerUpload(input: {
  env: Bindings;
  mailboxId: string;
  userId: string;
  uploadId: string;
}): Promise<UploadedAttachment> {
  const r2Key = composerUploadKey(input.mailboxId, input.userId, input.uploadId);
  const [object, meta] = await Promise.all([
    input.env.MAIL_STORAGE.head(r2Key),
    readUploadMeta(input.env, r2Key),
  ]);
  if (!object || !meta) {
    throw new UploadValidationError("Attachment upload was not found");
  }
  if (meta.uploadedBy !== input.userId || meta.mailboxId !== input.mailboxId) {
    throw new UploadValidationError("Attachment upload was not found");
  }
  if (object.size <= 0 || object.size !== meta.size) {
    throw new UploadValidationError("Attachment upload is incomplete");
  }
  if (object.size > MAX_COMPOSER_ATTACHMENT_BYTES) {
    throw new UploadValidationError("Attachment upload is invalid");
  }
  return {
    id: input.uploadId,
    r2Key,
    filename: meta.filename.slice(0, 255),
    contentType: meta.contentType.slice(0, 255),
    size: object.size,
  };
}

export async function copyComposerUploadToMessage(input: {
  env: Bindings;
  sourceKey: string;
  destinationKey: string;
  contentType: string;
}) {
  const source = await input.env.MAIL_STORAGE.get(input.sourceKey);
  if (!source?.body) {
    throw new UploadValidationError("Attachment upload was not found");
  }
  await input.env.MAIL_STORAGE.put(input.destinationKey, source.body, {
    httpMetadata: { contentType: input.contentType },
  });
}

export async function discardComposerUploadStaging(input: {
  env: Bindings;
  keys: string[];
}) {
  if (!input.keys.length) return;
  const metaKeys = input.keys.map(composerUploadMetaKey);
  try {
    await input.env.MAIL_STORAGE.delete([...input.keys, ...metaKeys]);
  } catch (error) {
    console.error("Could not remove composer upload staging objects", error);
  }
}

export class UploadValidationError extends Error {}
