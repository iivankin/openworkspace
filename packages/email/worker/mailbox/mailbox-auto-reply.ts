/** The mailbox's auto-reply: its settings, and answering incoming mail. */
import {
  createDb,
  mailboxAddressSql,
  mailboxes,
  mailDomainAllowed,
  normalizeMailboxAddress,
} from "@open-workspace/core/module";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";

import { sendArchived } from "../mail/archive";
import {
  AUTO_REPLY_HOURLY_CAP,
  autoReplyImagePrefix,
  autoReplyRecipient,
  autoReplyStatus,
  buildAutoReply,
  messageSkipReason,
  parseHeaderBlock,
} from "../mail/auto-reply";
import { replyAlias } from "../mail/reply-plan";
import { inlineImages } from "../mail/rich-content";
import {
  autoReplyLog,
  autoReplySettings,
  conversations,
  senders,
} from "./schema";
import type { AutoReplySettings, Email, PendingInbound } from "./schema";
import type { AutoReplyInput, MailboxContext } from "./support";
import { DAY_MS } from "./support";

export function getAutoReply(m: MailboxContext): AutoReplySettings | null {
  return m.db.select().from(autoReplySettings).all()[0] ?? null;
}

export function setAutoReply(
  m: MailboxContext,
  input: AutoReplyInput,
  userId: string
) {
  const previous = getAutoReply(m);

  const settings: AutoReplySettings = {
    ...input,
    id: 1,
    updatedBy: userId,
    updatedAt: new Date(),
  };

  // Each absence starts fresh: switching on or moving the window forgets
  // who has been answered.
  const newAbsence =
    input.enabled &&
    (!previous?.enabled ||
      previous.startsAt?.getTime() !== input.startsAt?.getTime() ||
      previous.endsAt?.getTime() !== input.endsAt?.getTime());

  m.db.transaction((tx) => {
    tx.insert(autoReplySettings)
      .values(settings)
      .onConflictDoUpdate({ target: autoReplySettings.id, set: settings })
      .run();

    if (newAbsence) tx.delete(autoReplyLog).run();
  });

  return settings;
}

export function turnOffAutoReply(m: MailboxContext, userId: string) {
  m.db
    .update(autoReplySettings)
    .set({ enabled: false, updatedBy: userId, updatedAt: new Date() })
    .run();

  return getAutoReply(m);
}

/**
 * Whether this mailbox has written to any of `addresses` (To, Cc or Bcc),
 * as its correspondents record keeps it, even after that mail is deleted.
 */
export function hasWrittenTo(m: MailboxContext, addresses: readonly string[]) {
  const unique = [
    ...new Set(addresses.map((address) => address.trim().toLowerCase())),
  ].filter(Boolean);

  return (
    unique.length > 0 &&
    m.db
      .select({ address: senders.address })
      .from(senders)
      .where(
        and(inArray(senders.address, unique), gt(senders.outboundCount, 0))
      )
      .limit(1)
      .all().length > 0
  );
}

/**
 * The automatic reply to a live delivery (never an import): the message
 * for people inside the workspace or the one for everyone else. It is
 * sent, not stored, and never retried: the sender is logged before
 * sending, so a failure can't turn into a loop.
 */
export async function maybeAutoReply(
  m: MailboxContext,
  job: PendingInbound,
  email: Email,
  rawMime: ArrayBuffer
) {
  const settings = getAutoReply(m);
  const now = new Date();

  if (!settings || autoReplyStatus(settings, now) !== "active") return;

  const conversation = m.db
    .select({ mailboxState: conversations.mailboxState })
    .from(conversations)
    .where(eq(conversations.id, email.conversationId))
    .all()[0];

  const mailboxId = m.state.id.name ?? "";
  const db = createDb(m.env.DB);

  const [mailbox, aliases] = await Promise.all([
    db
      .select({
        address: mailboxAddressSql,
        displayName: mailboxes.displayName,
      })
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxId))
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({
        address: mailboxAddressSql,
        displayName: mailboxes.displayName,
      })
      .from(mailboxes)
      .where(eq(mailboxes.aliasOf, mailboxId)),
  ]);

  if (!mailbox) return;

  const mailboxAddress = normalizeMailboxAddress(mailbox.address);

  if (
    messageSkipReason({
      headers: parseHeaderBlock(rawMime),
      envelopeFrom: job.envelopeFrom,
      ownAddresses: [
        mailboxAddress,
        ...aliases.map((alias) => alias.address),
      ].map((address) => address.toLowerCase()),
      listAddress: job.listAddress,
      mailboxState: conversation?.mailboxState,
      email,
    })
  ) {
    return;
  }

  // The reply goes to the envelope sender (RFC 3834), but who wrote is the
  // From address: the envelope sender of forwarded mail, newsletters and
  // many companies is a rewritten bounce address. From counts as inside
  // the workspace only when DMARC verified it, so it can't be forged.
  const recipient = autoReplyRecipient(job.envelopeFrom);
  // One reply per sender, however they spell their address's case.
  const sender = recipient.toLowerCase();
  const author = email.fromJson[0]?.address ?? null;

  const inside = Boolean(
    author &&
    email.authenticationResultsJson?.verdict === "verified" &&
    mailDomainAllowed(author)
  );

  const message = inside ? settings.inside : settings.outside;

  if (!message.enabled) return;

  if (
    !inside &&
    settings.outside.audience === "knownSenders" &&
    !hasWrittenTo(m, author ? [author, recipient] : [recipient])
  ) {
    return;
  }

  const intervalMs = settings.replyIntervalDays * DAY_MS;

  const reserved = m.db.transaction((tx) => {
    tx.delete(autoReplyLog)
      .where(
        lt(autoReplyLog.lastRepliedAt, new Date(now.getTime() - intervalMs))
      )
      .run();

    if (
      tx
        .select({ sender: autoReplyLog.senderAddress })
        .from(autoReplyLog)
        .where(eq(autoReplyLog.senderAddress, sender))
        .all().length > 0
    ) {
      return false;
    }

    const lastHour =
      tx
        .select({ count: sql<number>`count(*)` })
        .from(autoReplyLog)
        .where(
          gt(autoReplyLog.lastRepliedAt, new Date(now.getTime() - 3_600_000))
        )
        .all()[0]?.count ?? 0;

    if (lastHour >= AUTO_REPLY_HOURLY_CAP) return false;

    tx.insert(autoReplyLog)
      .values({
        senderAddress: sender,
        lastRepliedAt: now,
        lastOriginalEmailId: email.id,
      })
      .run();

    return true;
  });

  if (!reserved) return;

  // Mail that came through an alias is answered from the alias.
  const from = replyAlias(email, aliases) ?? mailbox;

  try {
    const images = await Promise.all(
      inlineImages(
        autoReplyImagePrefix(mailboxId),
        message.html,
        message.images
      ).map(async (image) => {
        const object = await m.env.MAIL_STORAGE.get(image.r2Key);

        if (!object) throw new Error(`Image ${image.contentId} is missing`);

        return {
          contentId: image.contentId,
          filename: image.filename,
          type: image.contentType,
          content: await object.arrayBuffer(),
        };
      })
    );

    // Sent mail, so the archive keeps it; it's never stored, so its own id.
    const result = await sendArchived(
      m.env,
      { id: `ar_${crypto.randomUUID()}`, mailboxId },
      buildAutoReply({
        from: {
          address: normalizeMailboxAddress(from.address),
          name: from.displayName,
        },
        recipient,
        original: email,
        message,
        images,
      })
    );

    m.db
      .update(autoReplyLog)
      .set({ lastOutboundMessageId: result.messageId })
      .where(eq(autoReplyLog.senderAddress, sender))
      .run();
  } catch (error) {
    console.error(`Auto-reply to ${recipient} failed`, error);
  }
}
