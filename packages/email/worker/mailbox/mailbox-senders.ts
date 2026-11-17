/**
 * Sender safety: blocks, trust, reports, unsubscribes, and taking mail out
 * of Spam back into its conversation.
 */
import { createId } from "@open-workspace/core/module";
import { required } from "@open-workspace/core/shared";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { FeedbackLabel, Unsubscription } from "../../shared/mail-feedback";
import { mergeConversation } from "./email-index";
import type { SenderIntel } from "./model";
import { conversations, emails, unsubscriptions } from "./schema";
import {
  blockFromPattern,
  listBlockedSenders as listBlockedSenderRows,
  recordSenderFeedback,
  senderHistory,
  senderStatuses,
  setSenderBlocked,
  setSenderTrusted as storeSenderTrusted,
} from "./senders";
import type { MailboxContext } from "./support";
import {
  blockPatternPredicate,
  conversationFolder,
  stringListJson,
} from "./support";

/**
 * Fills sender intelligence in on view: for a message without any, or
 * replacing the failed result checked at `replacesCheckedAt`.
 */
export function setEmailSenderIntel(
  m: MailboxContext,
  emailId: string,
  intel: SenderIntel,
  replacesCheckedAt: number | null = null
) {
  const current =
    replacesCheckedAt === null
      ? isNull(emails.senderIntelJson)
      : sql`json_extract(${emails.senderIntelJson}, '$.checkedAt') = ${replacesCheckedAt}`;

  return (
    m.db
      .update(emails)
      .set({ senderIntelJson: intel })
      .where(
        and(eq(emails.id, emailId), eq(emails.direction, "incoming"), current)
      )
      .returning({ id: emails.id })
      .all().length > 0
  );
}

/** Inbound/outbound counters for the given addresses (lowercased keys). */
export function getSenderHistory(m: MailboxContext, addresses: string[]) {
  return Object.fromEntries(senderHistory(m.state.storage.sql, addresses));
}

/** Block, trust and report state for senders, and unsubscribe records for lists. */
export function getMessageSafetyContext(
  m: MailboxContext,
  addresses: string[],
  listKeys: string[]
) {
  const keys = [...new Set(listKeys)].slice(0, 100);

  const rows = keys.length
    ? m.db
        .select()
        .from(unsubscriptions)
        .where(inArray(unsubscriptions.listKey, keys))
        .all()
    : [];

  return {
    senders: Object.fromEntries(senderStatuses(m.state.storage.sql, addresses)),
    unsubscriptions: Object.fromEntries(
      rows.map((row): [string, Unsubscription] => [
        row.listKey,
        {
          listKey: row.listKey,
          method: row.method,
          status: row.status,
          target: row.target,
          at: row.createdAt.getTime(),
        },
      ])
    ),
  };
}

export function recordUnsubscription(
  m: MailboxContext,
  input: {
    listKey: string;
    emailId: string;
    method: Unsubscription["method"];
    status: Unsubscription["status"];
    target: string | null;
    detail: string | null;
    userId: string;
  }
): Unsubscription {
  const createdAt = new Date();
  const values = { ...input, createdAt };
  m.db
    .insert(unsubscriptions)
    .values(values)
    .onConflictDoUpdate({ target: unsubscriptions.listKey, set: values })
    .run();
  m.publishUpdate();

  return {
    listKey: input.listKey,
    method: input.method,
    status: input.status,
    target: input.target,
    at: createdAt.getTime(),
  };
}

/** Moves every Inbox or Archive conversation with mail from the pattern to Spam. */
export function moveSenderConversationsToSpam(
  m: MailboxContext,
  pattern: string
) {
  const predicate = blockPatternPredicate(
    "lower(json_extract(message.from_json, '$[0].address'))",
    pattern
  );

  const moved = m.state.storage.sql
    .exec<{ id: string }>(
      `
    update conversations
    set mailbox_state = 'spam', folder_id = null, state_changed_at = ?
    where mailbox_state in ('active', 'archive')
      and id in (
        select message.conversation_id from emails message
        where message.direction = 'incoming' and ${predicate.sql}
      )
    returning id
  `,
      Date.now(),
      ...predicate.bindings
    )
    .toArray().length;

  if (moved) m.scheduleRetention();

  return moved;
}

export function blockSender(
  m: MailboxContext,
  pattern: string,
  moveExisting: boolean
) {
  const moved = m.db.transaction(() => {
    setSenderBlocked(m.state.storage.sql, pattern, true, Date.now());

    return moveExisting ? moveSenderConversationsToSpam(m, pattern) : 0;
  });

  m.forgetParticipants();
  m.publishUpdate();

  return { block: blockFromPattern(pattern, Date.now(), false), moved };
}

/** For a workspace-wide block: existing mail goes to Spam; the block itself lives in D1. */
export function moveSenderToSpam(m: MailboxContext, pattern: string) {
  const moved = moveSenderConversationsToSpam(m, pattern);

  if (moved) {
    m.forgetParticipants();
    m.publishUpdate();
  }

  return moved;
}

export function unblockSender(m: MailboxContext, pattern: string) {
  const existed =
    m.state.storage.sql
      .exec(
        "select 1 from senders where address = ? and blocked_at is not null",
        pattern
      )
      .toArray().length > 0;

  setSenderBlocked(m.state.storage.sql, pattern, false, Date.now());
  m.forgetParticipants();
  m.publishUpdate();

  return existed;
}

export function listBlockedSenders(m: MailboxContext) {
  return listBlockedSenderRows(m.state.storage.sql);
}

export function setSenderTrusted(
  m: MailboxContext,
  address: string,
  trusted: boolean
) {
  storeSenderTrusted(m.state.storage.sql, address, trusted, Date.now());
  m.publishUpdate();

  return true;
}

/** The newest incoming message of each conversation, for actions that need a sender. */
export function latestIncomingEmails(
  m: MailboxContext,
  conversationIds: string[]
) {
  const ids = [...new Set(conversationIds)].slice(0, 100);

  if (!ids.length) return [];

  const rows = m.state.storage.sql
    .exec<{ id: string }>(
      `
    select (
      select message.id from emails message
      where message.conversation_id = requested.value and message.direction = 'incoming'
      order by message.timeline_at desc, message.id desc limit 1
    ) as id
    from json_each(?) requested
  `,
      stringListJson(ids)
    )
    .toArray()
    .flatMap((row) => (row.id ? [row.id] : []));

  return rows.length
    ? m.db.select().from(emails).where(inArray(emails.id, rows)).all()
    : [];
}

/**
 * Report spam: labels the message, records feedback for the classifier,
 * and moves its conversation to Spam. Never contacts the sender.
 */
export function reportMessage(
  m: MailboxContext,
  input: { emailId: string; userId: string }
) {
  const email = m.getEmail(input.emailId);

  if (!email || email.direction !== "incoming") return null;
  const address = email.fromJson[0]?.address ?? "";

  const moved = m.db.transaction((tx) => {
    tx.update(emails)
      .set({ reportLabel: "spam" })
      .where(eq(emails.id, email.id))
      .run();

    if (address.includes("@")) {
      recordSenderFeedback(m.state.storage.sql, {
        id: createId("fbk"),
        address,
        emailId: email.id,
        label: "spam",
        userId: input.userId,
        now: Date.now(),
      });
    }

    return (
      tx
        .update(conversations)
        .set({
          mailboxState: "spam",
          folderId: null,
          stateChangedAt: new Date(),
        })
        .where(
          and(
            eq(conversations.id, email.conversationId),
            inArray(conversations.mailboxState, ["active", "archive"])
          )
        )
        .returning({ id: conversations.id })
        .all().length > 0
    );
  });

  m.forgetParticipants();
  m.publishUpdate();

  if (moved) m.scheduleRetention();

  return {
    email: required(m.getEmail(email.id), "The reported email exists"),
    moved,
  };
}

/** "Not spam": back to Inbox, the sender becomes trusted, and the feedback is recorded. */
export function markNotSpam(
  m: MailboxContext,
  input: { emailId: string; userId: string }
) {
  const email = m.getEmail(input.emailId);

  if (!email || email.direction !== "incoming") return null;
  const address = email.fromJson[0]?.address ?? "";
  const label: FeedbackLabel = "not_spam";

  const outcome = m.db.transaction((tx) => {
    tx.update(emails)
      .set({ reportLabel: null })
      .where(eq(emails.conversationId, email.conversationId))
      .run();

    if (address.includes("@")) {
      recordSenderFeedback(m.state.storage.sql, {
        id: createId("fbk"),
        address,
        emailId: email.id,
        label,
        userId: input.userId,
        now: Date.now(),
      });
      storeSenderTrusted(m.state.storage.sql, address, true, Date.now());
    }

    const back =
      tx
        .update(conversations)
        .set({ mailboxState: "active" })
        .where(
          and(
            eq(conversations.id, email.conversationId),
            eq(conversations.mailboxState, "spam")
          )
        )
        .returning({ id: conversations.id })
        .all().length > 0;

    // Spam that named a conversation here was kept out of it; once it is
    // not spam, it rejoins that conversation.
    const conversationId = back
      ? (rejoinSplitConversations(m, [email.conversationId]).get(
          email.conversationId
        ) ?? email.conversationId)
      : email.conversationId;

    const place = tx
      .select({
        mailboxState: conversations.mailboxState,
        folderId: conversations.folderId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .all()[0];

    return {
      restored: back,
      conversationId,
      folder: place ? conversationFolder(place) : "inbox",
    };
  });

  m.forgetParticipants();
  m.publishUpdate();

  return {
    restored: outcome.restored,
    conversationId: outcome.conversationId,
    rejoined: outcome.conversationId !== email.conversationId,
    folder: outcome.folder,
    address: address.includes("@") ? address : null,
  };
}

/**
 * Puts mail kept out of a conversation as spam (#25) back into it, once
 * its own conversation has left Spam: by Not spam, a move in the app or
 * over JMAP, or a reply sent from here. Call it inside the transaction
 * that moved `conversationIds`; only those now in Inbox or Archive that
 * hold a message marked with `split_from_conversation_id` are touched, so
 * conversations threaded elsewhere (an import's, say) are never merged.
 *
 * The marked message names the conversation it was kept out of. When that
 * conversation is gone, the message's own threading headers are resolved
 * again. The conversation rejoins its target when the target is in Inbox
 * or Archive; a target in Trash or Spam is not brought back by it, and the
 * conversation stays where it was moved. Either way the decision is final
 * and the mark is cleared.
 *
 * The rescued message is placed as a legitimate reply would be: moved to
 * Inbox (or a custom folder), the target becomes active and takes that
 * folder (else keeps its own). Moved to Archive, the target stays where it
 * is. Returns, for each merged conversation, the one its messages are in.
 */
export function rejoinSplitConversations(
  m: MailboxContext,
  conversationIds: string[]
) {
  const merged = new Map<string, string>();

  if (!conversationIds.length) return merged;

  const marked = m.db
    .select({
      emailId: emails.id,
      conversationId: conversations.id,
      mailboxState: conversations.mailboxState,
      folderId: conversations.folderId,
      splitFrom: emails.splitFromConversationId,
      inReplyTo: emails.inReplyToJson,
      references: emails.referencesJson,
    })
    .from(emails)
    .innerJoin(conversations, eq(conversations.id, emails.conversationId))
    .where(
      and(
        sql`${conversations.id} in (select cast(value as text) from json_each(${stringListJson(conversationIds)}))`,
        inArray(conversations.mailboxState, ["active", "archive"]),
        isNotNull(emails.splitFromConversationId)
      )
    )
    .all();

  const groups = new Map<string, typeof marked>();

  for (const row of marked) {
    groups.set(row.conversationId, [
      ...(groups.get(row.conversationId) ?? []),
      row,
    ]);
  }

  for (const [conversationId, rows] of groups) {
    const targets = new Set(
      rows.map((row) => splitTarget(m, conversationId, row))
    );

    const [target, ...others] = targets;

    m.db
      .update(emails)
      .set({ splitFromConversationId: null })
      .where(
        and(
          eq(emails.conversationId, conversationId),
          isNotNull(emails.splitFromConversationId)
        )
      )
      .run();

    if (!target || others.length) continue;
    const [moved] = rows;

    if (!moved) continue;
    mergeConversation(m.state.storage.sql, conversationId, target);

    if (moved.mailboxState === "active") {
      m.db
        .update(conversations)
        .set({
          mailboxState: "active",
          folderId: moved.folderId ?? sql`${conversations.folderId}`,
        })
        .where(eq(conversations.id, target))
        .run();
    }

    merged.set(conversationId, target);
  }

  return merged;
}

/**
 * The conversation a marked message rejoins, or null: the one it was kept
 * out of, else (when that one is gone) its parent's, while that
 * conversation is in Inbox or Archive.
 */
export function splitTarget(
  m: MailboxContext,
  conversationId: string,
  row: { splitFrom: string | null; inReplyTo: string[]; references: string[] }
) {
  const placeOf = (id: string) =>
    m.db
      .select({ mailboxState: conversations.mailboxState })
      .from(conversations)
      .where(eq(conversations.id, id))
      .all()[0];

  let targetId = row.splitFrom;
  let target = targetId ? placeOf(targetId) : undefined;

  if (!target) {
    const parent = m.resolveParent(row.inReplyTo, row.references);
    targetId = parent?.conversationId ?? null;
    target = targetId ? placeOf(targetId) : undefined;
  }

  return targetId &&
    targetId !== conversationId &&
    (target?.mailboxState === "active" || target?.mailboxState === "archive")
    ? targetId
    : null;
}
