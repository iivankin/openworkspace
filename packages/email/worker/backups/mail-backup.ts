import {
  createDb,
  mailboxAddressSql,
  mailboxes,
} from "@open-workspace/core/module";
import type {
  BackupSnapshot,
  Database,
  ModuleBackup,
} from "@open-workspace/core/module";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";

import type { MailboxState } from "../../shared/mail";
import { importPlacements } from "../../shared/mail-import";
import type { ImportPlacement } from "../../shared/mail-import";
import { importRawMessage } from "../mail/import-routes";
import { prepareOutboundDelivery } from "../mail/outbound-delivery";
import { mailboxStub } from "../mailbox";
import type { Email } from "../mailbox/schema";
import { serializeEml } from "./eml";
import {
  mailboxAt,
  mailboxPieces,
  restorePiece,
  WORKSPACE_FOLDER,
  workspacePieces,
  writePieces,
} from "./settings-backup";

/**
 * Mail's part of a backup snapshot: a folder per address that keeps mail,
 * with one line per message, and each message's `.eml` object stored once,
 * then the address's settings and drafts (settings-backup.ts).
 * The mailbox keeps each stored message's hash, so later snapshots write
 * its line from the mailbox's rows alone, and read and store only new mail.
 */

/** Rows a batch lists; those with a stored hash cost nothing more. */
const BATCH_ROWS = 5000;

/** New messages a batch reads and stores, about 3 subrequests each. */
const BATCH_NEW = 100;

/**
 * Addresses a batch goes through at most, about 2 subrequests each, so a
 * workspace with many small or empty mailboxes still takes few batches.
 */
const BATCH_MAILBOXES = 20;

const EML = { extension: "eml", contentType: "message/rfc822" };

/** One message in a snapshot: what `import backup` sends back with it. */
type MailBackupLine = {
  /** The message's id in the mailbox, its source id on restore. */
  id: string;
  /** Its object, `<sha256>.eml`. */
  object: string;
  placement: ImportPlacement;
  /** The custom folder of a conversation in the Inbox. */
  folder: string | null;
  /** Read by anyone who can open the mailbox; sent mail is read. */
  seen: boolean;
  /** The conversation: messages with the same thread are restored as one. */
  thread: string;
  direction: "incoming" | "outgoing";
  received_at: string;
  subject: string;
};

/** Where a message goes on restore: the place, and the custom folder in the Inbox. */
type BackupPlace = { placement: ImportPlacement; folder: string | null };

/**
 * Where a message goes on restore, from its conversation's state: Archive,
 * Spam and Trash hold the whole conversation; in an active conversation,
 * received mail is in the Inbox (and its custom folder) and sent mail is
 * Sent, which leaves the conversation's place to the rest.
 */
function backupPlacement(input: {
  direction: "incoming" | "outgoing";
  mailboxState: MailboxState;
  folderName: string | null;
}): BackupPlace {
  if (input.mailboxState !== "active") {
    return { placement: input.mailboxState, folder: null };
  }

  if (input.direction === "outgoing") {
    return { placement: "sent", folder: null };
  }

  return { placement: "inbox", folder: input.folderName };
}

/**
 * A message's `.eml`, and whether it is final: its hash may then stand for
 * it in every later snapshot. One rebuilt without its attachments, or sent
 * mail before Email Sending gave it its Message-ID, isn't: the next
 * snapshot builds it again.
 */
type MessageBytes = { bytes: Uint8Array<ArrayBuffer>; final: boolean };

/** Outgoing mail as Email Sending got it (same body and attachments), as MIME. */
async function sentMessageBytes(
  env: Env,
  email: Email,
  error: (message: string) => void
): Promise<MessageBytes> {
  let delivery: Awaited<ReturnType<typeof prepareOutboundDelivery>>;
  let complete = true;

  try {
    delivery = await prepareOutboundDelivery(env, email);
  } catch (cause) {
    // A missing attachment must not cost the backup the message itself.
    error(
      `${email.id}: ${cause instanceof Error ? cause.message : String(cause)}; kept without attachments`
    );
    complete = false;
    delivery = await prepareOutboundDelivery(env, {
      ...email,
      attachmentsJson: [],
    });
  }

  const bytes = serializeEml({
    id: email.id,
    from: email.fromJson,
    to: email.toJson,
    cc: email.ccJson,
    bcc: email.bccJson,
    replyTo: email.replyToJson,
    subject: email.subject,
    date: email.timelineAt,
    messageId: email.messageIdHeader,
    inReplyTo: email.inReplyToJson,
    references: email.referencesJson,
    text: delivery.text,
    html: delivery.html,
    attachments: (delivery.attachments ?? []).map((attachment) => ({
      ...attachment,
      // SAFETY: prepareOutboundDelivery reads each attachment with R2's
      // arrayBuffer(); EmailAttachment's type only allows more.
      content: attachment.content as ArrayBuffer,
    })),
  });

  return {
    bytes,
    final:
      complete && (email.direction !== "outgoing" || !!email.messageIdHeader),
  };
}

async function messageBytes(
  env: Env,
  email: Email,
  error: (message: string) => void
): Promise<MessageBytes> {
  if (email.rawMimeR2Key) {
    const object = await env.MAIL_STORAGE.get(email.rawMimeR2Key);

    if (object) {
      return { bytes: new Uint8Array(await object.arrayBuffer()), final: true };
    }

    error(`${email.id}: raw message is missing, rebuilt from its fields`);

    // Rebuilt only for now: the next snapshot looks for the original again.
    return { ...(await sentMessageBytes(env, email, error)), final: false };
  }

  return sentMessageBytes(env, email, error);
}

/** The next address after `afterId` that keeps mail (a mailing list keeps none). */
async function nextMailbox(db: Database, afterId: string | null) {
  const [row] = await db
    .select({ id: mailboxes.id, address: mailboxAddressSql })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.delivery, "inbox"),
        afterId ? gt(mailboxes.id, afterId) : undefined
      )
    )
    .orderBy(asc(mailboxes.id))
    .limit(1);

  return row ?? null;
}

const cursorSchema = z.union([
  z.object({ workspace: z.literal(true), skip: z.number() }),
  z.object({
    mailbox: z.string(),
    address: z.string(),
    after: z.string().nullable(),
    /** Set once its mail is written: the next of its settings pieces. */
    settings: z.number().optional(),
  }),
]);

/**
 * One batch: pages of mailboxes' messages, each followed by its settings
 * and drafts (settings-backup.ts), from the cursor's mailbox on, until it
 * has listed BATCH_ROWS rows, stored BATCH_NEW new objects or gone through
 * BATCH_MAILBOXES addresses; after the last address, the workspace's
 * settings.
 */
async function exportMail(env: Env, snapshot: BackupSnapshot) {
  const db = createDb(env.DB);

  const position = snapshot.cursor
    ? cursorSchema.parse(JSON.parse(snapshot.cursor))
    : null;

  if (position && "workspace" in position) {
    const { next } = await writePieces(
      snapshot,
      WORKSPACE_FOLDER,
      await workspacePieces(env),
      position.skip,
      BATCH_NEW
    );

    return next === null
      ? null
      : JSON.stringify({ workspace: true, skip: next });
  }

  let mailbox = position
    ? { id: position.mailbox, address: position.address }
    : await nextMailbox(db, null);

  let after = position?.after ?? null;
  let settings = position?.settings;
  let rowsLeft = BATCH_ROWS;
  let newLeft = BATCH_NEW;

  for (
    let visited = 0;
    mailbox && visited < BATCH_MAILBOXES && rowsLeft > 0 && newLeft > 0;
    visited += 1
  ) {
    if (settings === undefined) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one mailbox after another, within the batch's budget
      const page = await messagePage(env, snapshot, mailbox, after, {
        rows: rowsLeft,
        new: newLeft,
      });

      rowsLeft -= page.rows;
      newLeft -= page.new;

      if (page.last) {
        return JSON.stringify({
          mailbox: mailbox.id,
          address: mailbox.address,
          after: page.last,
        });
      }

      settings = 0;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- see above
    const pieces = await mailboxPieces(env, mailbox.id);

    // oxlint-disable-next-line eslint/no-await-in-loop -- see above
    const written = await writePieces(
      snapshot,
      mailbox.address,
      pieces,
      settings,
      newLeft
    );

    newLeft -= written.stored;

    if (written.next !== null) {
      return JSON.stringify({
        mailbox: mailbox.id,
        address: mailbox.address,
        after: null,
        settings: written.next,
      });
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- see above
    mailbox = await nextMailbox(db, mailbox.id);
    after = null;
    settings = undefined;
  }

  if (!mailbox) return JSON.stringify({ workspace: true, skip: 0 });

  return JSON.stringify({
    mailbox: mailbox.id,
    address: mailbox.address,
    after,
    settings,
  });
}

/**
 * One page of a mailbox's messages from `after`, within the batch's budget:
 * what it listed and stored, and the last message when more follow.
 */
async function messagePage(
  env: Env,
  snapshot: BackupSnapshot,
  mailbox: { id: string; address: string },
  after: string | null,
  budget: { rows: number; new: number }
) {
  const stub = mailboxStub(env, mailbox.id);

  const { rows, full, more } = await stub.listBackupEmails(
    after,
    budget.rows,
    budget.new
  );

  const stored: { id: string; sha256: string }[] = [];
  const lines: MailBackupLine[] = [];

  for (const row of rows) {
    let sha256 = row.backupSha256;

    if (!sha256) {
      const email = full.find((candidate) => candidate.id === row.id);

      if (!email) continue;

      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one message in memory at a time; a message may be 25 MiB
        const message = await messageBytes(env, email, snapshot.error);
        // oxlint-disable-next-line eslint/no-await-in-loop -- see above
        sha256 = await snapshot.putObject(message.bytes, EML);

        if (message.final) stored.push({ id: row.id, sha256 });
      } catch (cause) {
        // Left out of this snapshot; the next one tries again.
        snapshot.error(
          `${mailbox.address} ${row.id}: ${cause instanceof Error ? cause.message : String(cause)}`
        );
        continue;
      }
    }

    lines.push({
      id: row.id,
      object: `${sha256}.${EML.extension}`,
      ...backupPlacement(row),
      seen: row.direction === "outgoing" || row.seen,
      thread: row.conversationId,
      direction: row.direction,
      received_at: row.timelineAt.toISOString(),
      subject: row.subject,
    });
  }

  // After the objects, so a hash the mailbox holds always names one.
  if (stored.length) await stub.setBackupHashes(stored);
  snapshot.writeLines(mailbox.address, lines);

  return {
    rows: rows.length,
    new: full.length,
    last: more ? (rows.at(-1)?.id ?? null) : null,
  };
}

/**
 * Core's `mailboxSaved` hook: an address that no longer keeps mail (now an
 * alias, a forward or a list) is left out of snapshots, so the hashes its
 * mailbox holds are forgotten; if it keeps mail again, its messages are
 * stored again instead of naming objects the sweep may have deleted.
 */
export async function forgetBackupHashes(env: Env, mailboxId: string) {
  const [row] = await createDb(env.DB)
    .select({ delivery: mailboxes.delivery })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId))
    .limit(1);

  if (row && row.delivery !== "inbox") {
    await mailboxStub(env, mailboxId).clearBackupHashes();
  }
}

const restoreLineSchema = z.object({
  id: z.string().min(1).max(200),
  placement: z.enum(importPlacements),
  folder: z.string().trim().min(1).max(80).nullable(),
  seen: z.boolean(),
  thread: z.string().min(1).max(200),
  direction: z.enum(["incoming", "outgoing"]),
  received_at: z.iso.datetime(),
});

export const mailBackup: ModuleBackup = {
  export: exportMail,
  /** Adds a message to the mailbox at its folder's address, unless it is there. */
  async restore(c, item) {
    const piece = await restorePiece(c, item);

    if (piece) return piece;
    const { folder, line, object } = item;
    const parsed = restoreLineSchema.safeParse(line);

    if (!parsed.success || !object) {
      return { status: "skipped", reason: "not a message line" };
    }

    const message = parsed.data;
    const mailbox = await mailboxAt(c.env, folder);

    if (!mailbox) return { status: "skipped", reason: `no mailbox ${folder}` };

    const result = await importRawMessage({
      env: c.env,
      mailbox,
      raw: object,
      importKey: `backup:${message.id}`,
      receivedAt: Date.parse(message.received_at),
      placement: message.placement,
      folderName: message.folder,
      seen: message.seen,
      thread: `backup:${message.thread}`,
      direction: message.direction,
    });

    if (result.status === "unprocessable") {
      return { status: "skipped", reason: result.reason };
    }

    return { status: result.status === "duplicate" ? "exists" : "restored" };
  },
};
