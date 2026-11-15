import {
  createDb,
  mailboxAddressPredicate,
  mailboxAddressSql,
  mailboxes,
  normalizeMailboxAddress,
  users,
} from "@open-workspace/core/module";
import type {
  AppEnv,
  BackupRestoreItem,
  BackupRestoreResult,
  BackupSnapshot,
  Database,
} from "@open-workspace/core/module";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";

import { autoReplyAudiences, replyActionModes } from "../../shared/mail";
import { normalizeBlockPattern } from "../../shared/mail-feedback";
import {
  blockedSenders,
  mailboxNotificationPreferences,
  signatures,
} from "../db/schema";
import { autoReplyImagePrefix } from "../mail/auto-reply";
import { importedEmailId } from "../mail/import-routes";
import { ruleActionSchema, ruleConditionSchema } from "../mail/rules";
import { signatureImagePrefix } from "../mail/signatures";
import { draftFileKey } from "../mail/uploads";
import {
  blocksOwnMailDomain,
  forgetWorkspaceBlockPatterns,
} from "../mail/workspace-safety";
import { mailboxStub } from "../mailbox";

/**
 * What a snapshot keeps beside the mail (mail-backup.ts). In each address's
 * folder: a `settings` line (folders, rules, auto-reply, AI instructions,
 * sender blocks, the address's signature, notification choices), a `draft`
 * line a draft, and a `file` line for each image or file they keep in R2.
 * In `workspace`: the workspace's blocked senders and people's signatures,
 * and their images. Each line names a stored object, so what didn't change
 * costs no storage. People are named by id and primary address.
 */

export const WORKSPACE_FOLDER = "workspace";

const JSON_OBJECT = { extension: "json", contentType: "application/json" };

const FILE_OBJECT = {
  extension: "bin",
  contentType: "application/octet-stream",
};

type UserRef = { id: string; address: string | null };

/** A line as written; `restorePiece` reads it back with `pieceLine`. */
type PieceLine = z.infer<typeof pieceLine> & { object?: string };

/** A line to write and its object's bytes; null when the object is gone. */
type Piece = {
  line: PieceLine;
  type: { extension: string; contentType: string };
  bytes: () => Promise<Uint8Array<ArrayBuffer> | null>;
};

function jsonPiece(line: PieceLine, json: string): Piece {
  return {
    line,
    type: JSON_OBJECT,
    bytes: () => Promise.resolve(new TextEncoder().encode(json)),
  };
}

function filePiece(env: Env, line: PieceLine, key: string): Piece {
  return {
    line,
    type: FILE_OBJECT,
    async bytes() {
      const object = await env.MAIL_STORAGE.get(key);

      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
  };
}

/** Each person's id with their primary address, which finds them again after a restore. */
export async function userRefs(db: Database) {
  const rows = await db
    .select({ id: mailboxes.ownerUserId, address: mailboxAddressSql })
    .from(mailboxes)
    .where(eq(mailboxes.isPrimary, true));

  const addresses = new Map(rows.map((row) => [row.id, row.address]));

  return (id: string): UserRef => ({ id, address: addresses.get(id) ?? null });
}

/** What a mailbox keeps beside its mail, as pieces of the snapshot. */
export async function mailboxPieces(
  env: Env,
  mailboxId: string,
  /** People by id, read once a batch rather than once an address. */
  refs: ReturnType<typeof userRefs>
) {
  const db = createDb(env.DB);

  const [{ drafts, ...settings }, [signature], notifications, ref] =
    await Promise.all([
      mailboxStub(env, mailboxId).backupSettings(),
      db
        .select({
          html: signatures.html,
          text: signatures.text,
          images: signatures.images,
          useOnNew: signatures.useOnNew,
          useOnReply: signatures.useOnReply,
        })
        .from(signatures)
        .where(eq(signatures.mailboxId, mailboxId))
        .limit(1),
      db
        .select({
          userId: mailboxNotificationPreferences.userId,
          enabled: mailboxNotificationPreferences.enabled,
        })
        .from(mailboxNotificationPreferences)
        .where(eq(mailboxNotificationPreferences.mailboxId, mailboxId)),
      refs,
    ]);

  const kept = {
    ...settings,
    signature: signature ?? null,
    notifications: notifications.map((row) => ({
      user: ref(row.userId),
      enabled: row.enabled,
    })),
  };

  const pieces: Piece[] = [];

  // A mailbox with nothing set adds no line.
  if (
    Object.values(kept).some((value) =>
      Array.isArray(value) ? value.length > 0 : value !== null
    )
  ) {
    pieces.push(jsonPiece({ kind: "settings" }, JSON.stringify(kept)));
  }

  for (const draft of drafts) {
    const user = ref(draft.userId);
    pieces.push(jsonPiece({ kind: "draft", user }, JSON.stringify(draft)));

    for (const file of draft.attachments) {
      pieces.push(
        filePiece(
          env,
          {
            kind: "file",
            target: "draft",
            user,
            name: file.uploadId,
            filename: file.filename,
            contentType: file.contentType,
          },
          file.r2Key
        )
      );
    }
  }

  const autoReplyImages = new Map(
    [
      ...(settings.autoReply?.inside.images ?? []),
      ...(settings.autoReply?.outside.images ?? []),
    ].map((image) => [image.contentId, image])
  );

  for (const image of autoReplyImages.values()) {
    pieces.push(
      filePiece(
        env,
        {
          kind: "file",
          target: "auto-reply",
          name: image.contentId,
          contentType: image.contentType,
        },
        `${autoReplyImagePrefix(mailboxId)}${image.contentId}`
      )
    );
  }

  for (const image of signature?.images ?? []) {
    pieces.push(
      filePiece(
        env,
        {
          kind: "file",
          target: "signature",
          name: image.contentId,
          contentType: image.contentType,
        },
        `${signatureImagePrefix(mailboxId)}${image.contentId}`
      )
    );
  }

  return pieces;
}

/** The workspace's blocked senders and people's signatures, as pieces. */
export async function workspacePieces(env: Env) {
  const db = createDb(env.DB);

  const [blocked, personal, ref] = await Promise.all([
    db
      .select({
        pattern: blockedSenders.pattern,
        createdAt: blockedSenders.createdAt,
      })
      .from(blockedSenders),
    db
      .select({
        userId: signatures.userId,
        html: signatures.html,
        text: signatures.text,
        images: signatures.images,
        useOnNew: signatures.useOnNew,
        useOnReply: signatures.useOnReply,
      })
      .from(signatures)
      .where(isNotNull(signatures.userId)),
    userRefs(db),
  ]);

  const owned = personal.flatMap(({ userId, ...signature }) =>
    userId ? [{ ...signature, user: ref(userId) }] : []
  );

  if (!blocked.length && !owned.length) return [];

  return [
    jsonPiece(
      { kind: "workspace" },
      JSON.stringify({ blockedSenders: blocked, signatures: owned })
    ),
    ...owned.flatMap((signature) =>
      signature.images.map((image) =>
        filePiece(
          env,
          {
            kind: "file",
            target: "signature",
            user: signature.user,
            name: image.contentId,
            contentType: image.contentType,
          },
          `${signatureImagePrefix(signature.user.id)}${image.contentId}`
        )
      )
    ),
  ];
}

/**
 * Stores and writes up to `limit` pieces from `skip` on (each about 3
 * subrequests, as a new message), and resolves to how many it took and
 * where the next batch starts, or null after the last.
 * ponytail: pieces are counted by position, so a draft saved or deleted
 * between two batches of one mailbox can shift one piece into the next
 * snapshot; drafts change rarely enough mid-run.
 */
export async function writePieces(
  snapshot: BackupSnapshot,
  folder: string,
  pieces: Piece[],
  skip: number,
  limit: number
) {
  const lines: PieceLine[] = [];

  for (const piece of pieces.slice(skip, skip + limit)) {
    const label = `${folder} ${piece.line.kind} ${"name" in piece.line ? piece.line.name : ""}`;

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one file in memory at a time
      const bytes = await piece.bytes();

      if (!bytes) {
        snapshot.error(`${label}: missing, left out`);
        continue;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- see above
      const sha256 = await snapshot.putObject(bytes, piece.type);
      lines.push({
        ...piece.line,
        object: `${sha256}.${piece.type.extension}`,
      });
    } catch (cause) {
      snapshot.error(
        `${label}: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  }

  if (lines.length) snapshot.writeLines(folder, lines);
  const next = skip + limit;

  return {
    stored: Math.min(limit, Math.max(0, pieces.length - skip)),
    next: next < pieces.length ? next : null,
  };
}

/** The address a folder of the snapshot is for, if it is here and keeps mail. */
export async function mailboxAt(env: Env, folder: string) {
  const address = normalizeMailboxAddress(folder);

  const [mailbox] = await createDb(env.DB)
    .select({ id: mailboxes.id, address: mailboxAddressSql })
    .from(mailboxes)
    .where(
      and(mailboxAddressPredicate(address), eq(mailboxes.delivery, "inbox"))
    )
    .limit(1);

  return mailbox ?? null;
}

/** The person here: the owner of their primary address, else by id. */
async function personHere(db: Database, ref: UserRef) {
  if (ref.address) {
    const [owner] = await db
      .select({ id: mailboxes.ownerUserId })
      .from(mailboxes)
      .where(
        and(
          mailboxAddressPredicate(normalizeMailboxAddress(ref.address)),
          eq(mailboxes.isPrimary, true)
        )
      )
      .limit(1);

    if (owner?.id) return owner.id;
  }

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, ref.id))
    .limit(1);

  return user?.id ?? null;
}

const id = z.string().min(1).max(200);

/** A content or upload id, the last part of an R2 key. */
const keyName = id.regex(/^[^/\\]+$/u).refine((name) => !/^\.\.?$/u.test(name));

const userRef = z.object({ id, address: z.string().max(320).nullable() });
const date = z.coerce.date();

const richImage = z.object({
  contentId: keyName,
  filename: z.string().max(255),
  contentType: z.string().max(255),
  size: z.number().int().nonnegative(),
});

const richMessage = z.object({
  enabled: z.boolean(),
  subject: z.string().max(998).nullable(),
  html: z.string(),
  text: z.string(),
  images: z.array(richImage),
});

const signature = z.object({
  html: z.string(),
  text: z.string(),
  images: z.array(richImage),
  useOnNew: z.boolean(),
  useOnReply: z.boolean(),
});

const settingsObject = z.object({
  folders: z.array(
    z.object({ id, name: z.string().max(80), sortOrder: z.number().int() })
  ),
  systemFolderOrder: z.array(
    z.object({ folderId: id, sortOrder: z.number().int() })
  ),
  rules: z.array(
    z.object({
      id,
      position: z.number().int(),
      name: z.string().max(200),
      enabled: z.boolean(),
      match: z.enum(["all", "any"]),
      conditionsJson: z.array(ruleConditionSchema),
      actionsJson: z.array(ruleActionSchema),
      stopProcessing: z.boolean(),
      updatedAt: date,
    })
  ),
  autoReply: z
    .object({
      id: z.number().int(),
      enabled: z.boolean(),
      startsAt: date.nullable(),
      endsAt: date.nullable(),
      replyIntervalDays: z.number().int().positive(),
      inside: richMessage,
      outside: richMessage.extend({ audience: z.enum(autoReplyAudiences) }),
      updatedBy: id,
      updatedAt: date,
    })
    .nullable(),
  autoReplyLog: z.array(
    z.object({
      senderAddress: z.string().max(320),
      lastRepliedAt: date,
      lastOriginalEmailId: id,
      lastOutboundMessageId: z.string().max(998).nullable(),
    })
  ),
  ai: z
    .object({
      id,
      instructions: z.string().max(4000),
      confidenceThreshold: z.number().int().min(50).max(100),
      updatedAt: date,
    })
    .nullable(),
  senders: z.array(
    z.object({
      address: z.string().max(320),
      domain: z.string().max(320),
      blockedAt: date.nullable(),
      trustedAt: date.nullable(),
    })
  ),
  signature: signature.nullable(),
  notifications: z.array(z.object({ user: userRef, enabled: z.boolean() })),
});

const draftObject = z.object({
  id,
  kind: z.enum(["compose", "reply", "forward"]),
  sourceEmailId: id.nullable(),
  conversationId: id.nullable(),
  replyMode: z.enum(replyActionModes).nullable(),
  to: z.array(z.string().max(998)),
  cc: z.array(z.string().max(998)),
  bcc: z.array(z.string().max(998)),
  replyTo: z.string().max(998).nullable(),
  subject: z.string(),
  bodyText: z.string(),
  bodyHtml: z.string().nullable(),
  editorHtml: z.string().nullable(),
  // A signature image's draft copy comes back as an ordinary inline image.
  attachments: z.array(
    z.object({
      assetId: id,
      uploadId: keyName,
      disposition: z.enum(["attachment", "inline"]),
      contentId: z.string().max(998).nullable(),
      filename: z.string().max(255),
      contentType: z.string().max(255),
      size: z.number().int().nonnegative(),
    })
  ),
});

const workspaceObject = z.object({
  blockedSenders: z.array(
    z.object({ pattern: z.string().max(320), createdAt: date })
  ),
  signatures: z.array(signature.extend({ user: userRef })),
});

const pieceLine = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("settings") }),
  z.object({ kind: z.literal("draft"), user: userRef }),
  z.object({ kind: z.literal("workspace") }),
  z.object({
    kind: z.literal("file"),
    target: z.enum(["draft", "auto-reply", "signature"]),
    user: userRef.optional(),
    name: keyName,
    filename: z.string().max(255).optional(),
    contentType: z.string().max(255),
  }),
]);

function parseObject<T>(schema: z.ZodType<T>, object: Uint8Array) {
  try {
    return schema.safeParse(JSON.parse(new TextDecoder().decode(object))).data;
  } catch {
    return undefined;
  }
}

const restored = (changed: boolean): BackupRestoreResult => ({
  status: changed ? "restored" : "exists",
});

const skipped = (reason: string): BackupRestoreResult => ({
  status: "skipped",
  reason,
});

/**
 * Puts a piece back; what exists is left as it is. Null for a line that
 * is no piece (a message).
 */
export async function restorePiece(
  c: Context<AppEnv>,
  { folder, line, object }: BackupRestoreItem
): Promise<BackupRestoreResult | null> {
  const piece = pieceLine.safeParse(line).data;

  if (!piece) return null;

  if (!object) return skipped("missing");
  const { env } = c;
  const db = createDb(env.DB);

  const mailbox =
    folder === WORKSPACE_FOLDER ? null : await mailboxAt(env, folder);

  if (folder !== WORKSPACE_FOLDER && !mailbox) {
    return skipped(`no mailbox ${folder}`);
  }

  const owner =
    "user" in piece && piece.user ? await personHere(db, piece.user) : null;

  if ("user" in piece && piece.user && !owner) {
    return skipped("no such person");
  }

  if (piece.kind === "workspace") {
    const data = parseObject(workspaceObject, object);

    if (!data) return skipped("damaged");
    const actor = c.get("user").id;

    const blocks = await Promise.all(
      data.blockedSenders.map((row) => {
        const pattern = normalizeBlockPattern(row.pattern);

        // As the admin screen: never the workspace's own mail domains.
        return pattern && !blocksOwnMailDomain(pattern)
          ? db
              .insert(blockedSenders)
              .values({
                pattern,
                createdByUserId: actor,
                createdAt: row.createdAt,
              })
              .onConflictDoNothing()
              .returning({ pattern: blockedSenders.pattern })
          : [];
      })
    );

    if (blocks.flat().length) forgetWorkspaceBlockPatterns();

    const added = await Promise.all(
      data.signatures.map(async ({ user, ...row }) => {
        const userId = await personHere(db, user);

        return userId
          ? db
              .insert(signatures)
              .values({ ...row, userId })
              .onConflictDoNothing()
              .returning({ userId: signatures.userId })
          : [];
      })
    );

    return restored([...blocks, ...added].flat().length > 0);
  }

  if (piece.kind === "file") {
    // Where the file lives under its new owner: the address, or the person.
    const prefixes = {
      signature: owner ?? mailbox?.id,
      "auto-reply": mailbox && autoReplyImagePrefix(mailbox.id),
      draft: mailbox && owner && draftFileKey(mailbox.id, owner, ""),
    };

    const prefix =
      piece.target === "signature"
        ? prefixes.signature && signatureImagePrefix(prefixes.signature)
        : prefixes[piece.target];

    if (!prefix) return skipped("no owner");
    const target = `${prefix}${piece.name}`;

    if (await env.MAIL_STORAGE.head(target)) return restored(false);

    await env.MAIL_STORAGE.put(target, object, {
      httpMetadata: { contentType: piece.contentType },
      customMetadata: piece.filename
        ? { filename: piece.filename, contentType: piece.contentType }
        : undefined,
    });

    // A draft's file goes again unless a draft holds it: its draft line
    // comes first, so a draft that was skipped (the drafts limit, one already
    // there) leaves no stray file. The queue keeps keys a draft holds.
    if (piece.target === "draft" && mailbox) {
      await mailboxStub(env, mailbox.id).forgetDraftFiles([target]);
    }

    return restored(true);
  }

  if (!mailbox) return skipped("not a workspace line");
  const stub = mailboxStub(env, mailbox.id);

  if (piece.kind === "draft") {
    const draft = parseObject(draftObject, object);

    if (!draft || !owner) return skipped("damaged");

    const status = await stub.restoreDraft(
      owner,
      {
        ...draft,
        attachments: draft.attachments.map((file) => ({
          ...file,
          r2Key: draftFileKey(mailbox.id, owner, file.uploadId),
        })),
      },
      draft.sourceEmailId
        ? await importedEmailId(`backup:${draft.sourceEmailId}`)
        : null
    );

    return status === "limit"
      ? skipped("drafts limit")
      : restored(status === "saved");
  }

  const data = parseObject(settingsObject, object);

  if (!data) return skipped("damaged");
  const { signature: own, notifications, ...settings } = data;

  const [changed, kept, choices] = await Promise.all([
    stub.restoreSettings(settings),
    own
      ? db
          .insert(signatures)
          .values({ ...own, mailboxId: mailbox.id })
          .onConflictDoNothing()
          .returning({ mailboxId: signatures.mailboxId })
      : [],
    Promise.all(
      notifications.map(async ({ user, enabled }) => {
        const userId = await personHere(db, user);

        return userId
          ? db
              .insert(mailboxNotificationPreferences)
              .values({ mailboxId: mailbox.id, userId, enabled })
              .onConflictDoNothing()
              .returning({ userId: mailboxNotificationPreferences.userId })
          : [];
      })
    ),
  ]);

  return restored(changed || kept.length > 0 || choices.flat().length > 0);
}
