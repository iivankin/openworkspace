/** The mailbox as JMAP sees it: state, changes, queries and moves. */
import { and, eq, sql } from "drizzle-orm";

import { DRAFTS_FOLDER_ID } from "../../shared/folder-order";
import {
  changedSince,
  jmapChanges as jmapChangeLog,
  emailPlacement as jmapEmailPlacement,
  jmapState as jmapStateOf,
  mailboxes as jmapMailboxRows,
  moveEmails as moveEmailsInStore,
  queryAllEmails as queryAllJmapEmails,
  queryEmails as queryJmapEmails,
  threadEmails as jmapThreadEmails,
} from "./jmap-store";
import * as mailboxDrafts from "./mailbox-drafts";
import * as senderSafety from "./mailbox-senders";
import { isRetentionFolder } from "./retention";
import { drafts, emails } from "./schema";
import type { MailboxContext } from "./support";
import { stringListJson } from "./support";

export function jmapState(m: MailboxContext) {
  return jmapStateOf(m.state.storage);
}

/** Foo/changes for this person (jmap-store.ts); null: resync instead. */
export function jmapChanges(
  m: MailboxContext,
  input: Parameters<typeof jmapChangeLog>[1]
) {
  const changes = jmapChangeLog(m.state.storage.sql, input);

  if (!changes || input.type !== "Mailbox" || !changes.emailsChanged) {
    return changes;
  }

  // Mail changed, so any mailbox's counts may have: all of them updated.
  const updated = jmapMailboxRows(m.state.storage.sql, input.userId)
    .map((row) => row.id)
    .filter(
      (id) => !changes.created.includes(id) && !changes.destroyed.includes(id)
    );

  // More than the client takes at once: it reads the mailboxes again.
  if (
    input.maxChanges !== null &&
    changes.created.length + changes.destroyed.length + updated.length >
      input.maxChanges
  ) {
    return null;
  }

  return { ...changes, updated };
}

export function jmapMailboxes(m: MailboxContext, userId: string) {
  return {
    state: jmapStateOf(m.state.storage),
    mailboxes: jmapMailboxRows(m.state.storage.sql, userId),
  };
}

export function jmapQueryEmails(
  m: MailboxContext,
  input: Parameters<typeof queryJmapEmails>[1]
) {
  // The drafts mailbox lists the person's drafts, newest first; its
  // other conditions are not applied.
  if (input.filter.inMailbox === DRAFTS_FOLDER_ID) {
    const ids = mailboxDrafts
      .listDrafts(m, input.userId)
      .map((draft) => draft.id);

    if (input.ascending) ids.reverse();

    return {
      state: jmapStateOf(m.state.storage),
      ids: ids.slice(input.position, input.position + input.limit),
      total: ids.length,
    };
  }

  return {
    state: jmapStateOf(m.state.storage),
    ...queryJmapEmails(m.state.storage.sql, input),
  };
}

/**
 * Email/queryChanges (RFC 8620 §5.6): every email that changed since the
 * state is removed and, where the query lists it now, added back at its
 * index. Emails that didn't change can't have joined, left or moved in
 * the list, so this turns the old list into the current one. With
 * collapseThreads a changed email can change its thread's representative,
 * so every email of a changed thread counts as changed. Null: resync.
 */
export function jmapQueryChanges(
  m: MailboxContext,
  input: Parameters<typeof queryAllJmapEmails>[1] & {
    sinceQueryState: string;
  }
) {
  const store = m.state.storage.sql;

  const changed = changedSince(
    store,
    "Email",
    input.sinceQueryState,
    input.userId
  );

  if (!changed) return null;
  const removed = new Set(changed);
  const threads = new Set<string>();

  if (input.collapseThreads && input.filter.inMailbox !== DRAFTS_FOLDER_ID) {
    for (const id of changedSince(
      store,
      "Thread",
      input.sinceQueryState,
      input.userId
    ) ?? []) {
      threads.add(id);
    }

    for (const row of m.db
      .select({ conversationId: emails.conversationId })
      .from(emails)
      .where(
        sql`${emails.id} in (select cast(value as text) from json_each(${stringListJson([...changed])}))`
      )
      .all()) {
      threads.add(row.conversationId);
    }

    for (const row of m.db
      .select({ id: emails.id })
      .from(emails)
      .where(
        sql`${emails.conversationId} in (select cast(value as text) from json_each(${stringListJson([...threads])}))`
      )
      .all()) {
      removed.add(row.id);
    }
  }

  const listed =
    input.filter.inMailbox === DRAFTS_FOLDER_ID
      ? mailboxDrafts.listDrafts(m, input.userId).map((draft) => ({
          id: draft.id,
          conversation_id: "",
        }))
      : queryAllJmapEmails(store, input);

  if (input.filter.inMailbox === DRAFTS_FOLDER_ID && input.ascending) {
    listed.reverse();
  }

  const added = listed.flatMap((row, index) =>
    removed.has(row.id) || threads.has(row.conversation_id)
      ? [{ id: row.id, index }]
      : []
  );

  for (const { id } of added) removed.add(id);

  return {
    state: jmapStateOf(m.state.storage),
    removed: [...removed],
    added,
    total: listed.length,
  };
}

/**
 * Emails with their JMAP Mailbox and this user's $seen keyword, and the
 * person's drafts among `ids`; unknown ids are left out.
 */
export function jmapEmails(m: MailboxContext, userId: string, ids: string[]) {
  const placement = jmapEmailPlacement(m.state.storage.sql, userId, ids);
  const draftIds = ids.filter((id) => id.startsWith("drf_"));

  return {
    state: jmapStateOf(m.state.storage),
    emails: ids.flatMap((id) => {
      const email = m.getEmail(id);
      const place = placement.get(id);

      return email && place ? [{ email, ...place }] : [];
    }),
    drafts: draftIds.length
      ? m.db
          .select()
          .from(drafts)
          .where(
            and(
              eq(drafts.userId, userId),
              sql`${drafts.id} in (select cast(value as text) from json_each(${stringListJson(draftIds)}))`
            )
          )
          .all()
      : [],
  };
}

export function jmapThreads(m: MailboxContext, ids: string[], userId: string) {
  return {
    state: jmapStateOf(m.state.storage),
    threads: [...jmapThreadEmails(m.state.storage.sql, ids, userId)].map(
      ([id, emailIds]) => ({ id, emailIds })
    ),
  };
}

export function jmapMoveEmails(
  m: MailboxContext,
  emailIds: string[],
  target: string
) {
  const moved = m.db.transaction(() => {
    const known = moveEmailsInStore(m.state.storage.sql, emailIds, target);

    if (known) {
      // Mail kept out of a conversation as spam rejoins it once moved out of Junk.
      senderSafety.rejoinSplitConversations(
        m,
        m.db
          .selectDistinct({ id: emails.conversationId })
          .from(emails)
          .where(
            sql`${emails.id} in (select cast(value as text) from json_each(${stringListJson(emailIds)}))`
          )
          .all()
          .map((row) => row.id)
      );
    }

    return known;
  });

  if (moved) {
    m.publishUpdate();

    if (isRetentionFolder(target)) m.scheduleRetention();
  }

  return moved;
}
