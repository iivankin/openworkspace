/** Each person's drafts in a mailbox, and the files they keep. */
import { and, desc, eq, ne, sql } from "drizzle-orm";

import { mailboxOwnsObject } from "../mail/storage-keys";
import { bumpJmapState } from "./jmap-store";
import { drafts, pendingObjectDeletions } from "./schema";
import type { Draft } from "./schema";
import type { DraftInput, SaveDraftResult, MailboxContext } from "./support";
import { ALARM_WAKE_DELAY_MS, MAX_DRAFTS_PER_USER } from "./support";

/** The person's drafts in this mailbox, newest first. */
export function listDrafts(m: MailboxContext, userId: string) {
  return m.db
    .select()
    .from(drafts)
    .where(eq(drafts.userId, userId))
    .orderBy(desc(drafts.updatedAt))
    .all();
}

/**
 * The Drafts folder: the person's drafts, newest first, those whose
 * recipients, subject or text hold `search` when given. One page: there
 * are at most MAX_DRAFTS_PER_USER.
 */
export function searchDrafts(
  m: MailboxContext,
  userId: string,
  search: string | undefined
) {
  const needle = search?.trim().toLocaleLowerCase("en-US");

  return listDrafts(m, userId).filter(
    (draft) =>
      !needle ||
      [...draft.to, ...draft.cc, draft.subject, draft.bodyText].some((value) =>
        value.toLocaleLowerCase("en-US").includes(needle)
      )
  );
}

export function getDraft(m: MailboxContext, userId: string, id: string) {
  return (
    m.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.userId, userId), eq(drafts.id, id)))
      .get() ?? null
  );
}

/**
 * Saves a draft if it is still at `expectedVersion` (0 for a new one). The
 * check and the write run without an await between them, so they can't
 * interleave with another save. A conversation has one reply box, so a
 * reply draft replaces the person's other reply drafts in its
 * conversation. `copiedKeys` are files copied for this save; those the
 * stored draft doesn't hold afterwards (a conflict, the cap), and the files
 * the save dropped or the replaced drafts held, are queued for deletion.
 */
export async function saveDraft(
  m: MailboxContext,
  userId: string,
  input: DraftInput,
  expectedVersion: number,
  copiedKeys: string[] = []
): Promise<SaveDraftResult> {
  const current = getDraft(m, userId, input.id);
  const result = writeDraft(m, userId, input, expectedVersion, current);
  const kept = result.status === "saved" ? result.draft : current;
  const keptKeys = new Set(kept?.attachments.map((file) => file.r2Key));

  const replaced =
    result.status === "saved" && input.kind === "reply"
      ? m.db
          .delete(drafts)
          .where(
            and(
              eq(drafts.userId, userId),
              eq(drafts.kind, "reply"),
              eq(drafts.conversationId, input.conversationId ?? ""),
              ne(drafts.id, input.id)
            )
          )
          .returning({ attachments: drafts.attachments })
          .all()
      : [];

  await forgetDraftFiles(
    m,
    [
      ...copiedKeys,
      ...(current?.attachments.map((file) => file.r2Key) ?? []),
      ...replaced.flatMap((draft) =>
        draft.attachments.map((file) => file.r2Key)
      ),
    ].filter((key) => !keptKeys.has(key))
  );

  if (result.status === "saved") {
    announceDrafts(m, !current || replaced.length > 0);
  }

  return result;
}

/**
 * Tells clients the drafts changed. A new or deleted draft changes the
 * Drafts count and list, so web clients refresh; an autosave only tells
 * JMAP streams, without a push to phones every few seconds.
 */
export function announceDrafts(m: MailboxContext, listChanged: boolean) {
  if (listChanged) {
    m.publishUpdate();

    return;
  }

  bumpJmapState(m.state.storage);
  m.announceJmapState(false);
}

export function writeDraft(
  m: MailboxContext,
  userId: string,
  input: DraftInput,
  expectedVersion: number,
  current: Draft | null
): SaveDraftResult {
  if ((current?.version ?? 0) !== expectedVersion) {
    return { status: "conflict", draft: current };
  }

  if (!current) {
    const [count] = m.db
      .select({ value: sql<number>`count(*)` })
      .from(drafts)
      .where(eq(drafts.userId, userId))
      .all();

    if ((count?.value ?? 0) >= MAX_DRAFTS_PER_USER) {
      return { status: "limit" };
    }
  }

  const draft: Draft = {
    ...input,
    userId,
    version: expectedVersion + 1,
    updatedAt: new Date(),
  };

  m.db
    .insert(drafts)
    .values(draft)
    .onConflictDoUpdate({ target: [drafts.userId, drafts.id], set: draft })
    .run();

  return { status: "saved", draft };
}

/** Whether the person had a draft with this id; its files are queued for deletion. */
export async function deleteDraft(
  m: MailboxContext,
  userId: string,
  id: string
) {
  const [deleted] = m.db
    .delete(drafts)
    .where(and(eq(drafts.userId, userId), eq(drafts.id, id)))
    .returning({ attachments: drafts.attachments })
    .all();

  await forgetDraftFiles(
    m,
    deleted?.attachments.map((file) => file.r2Key) ?? []
  );

  if (deleted) announceDrafts(m, true);

  return Boolean(deleted);
}

/**
 * Queues draft files for deletion. The queue skips a key some draft still
 * holds, so a save racing this one can't lose its file.
 */
export async function forgetDraftFiles(
  m: MailboxContext,
  objectKeys: string[]
) {
  await forgetObjects(m, objectKeys);
}

/**
 * Queues this mailbox's objects for deletion. The queue skips a key a
 * message or draft still holds, and one the archive doesn't have yet.
 */
export async function forgetObjects(m: MailboxContext, objectKeys: string[]) {
  const mailboxId = m.state.id.name ?? "";

  const owned = objectKeys.filter((key) => mailboxOwnsObject(mailboxId, key));

  if (!owned.length) return;
  const cleanupAt = new Date();

  for (const objectKey of new Set(owned)) {
    m.db
      .insert(pendingObjectDeletions)
      .values({ objectKey, nextAttemptAt: cleanupAt })
      .onConflictDoNothing()
      .run();
  }

  await m.scheduleAlarm(cleanupAt.getTime() + ALARM_WAKE_DELAY_MS);
}
