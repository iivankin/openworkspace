/** A mailbox's folders: the system ones at their places, and custom ones. */
import { eq } from "drizzle-orm";

import {
  DRAFTS_FOLDER_ID,
  FOLDER_ORDER_STEP,
  folderOrderPositions,
  isCompleteFolderOrder,
} from "../../shared/folder-order";
import { MAX_CUSTOM_FOLDER_COUNT } from "../../shared/mail";
import { systemFolderDefinitions } from "./folder-model";
import { folders, systemFolderOrder } from "./schema";
import type { MailFolder, MailboxContext } from "./support";

/** The system folders at their places in the mailbox's folder order. */
export function systemFolders(m: MailboxContext) {
  const stored = new Map(
    m.db
      .select()
      .from(systemFolderOrder)
      .all()
      .map((row) => [row.folderId, row.sortOrder])
  );

  return systemFolderDefinitions.map((folder) => ({
    ...folder,
    sortOrder:
      folder.id === "inbox" ? 0 : (stored.get(folder.id) ?? folder.sortOrder),
  }));
}

export function getFolder(m: MailboxContext, id: string): MailFolder | null {
  const system = systemFolders(m).find((folder) => folder.id === id);

  if (system) {
    return {
      ...system,
      kind: "system",
    };
  }

  const custom = m.db.select().from(folders).where(eq(folders.id, id)).all()[0];

  return custom ? { ...custom, kind: "custom", systemType: null } : null;
}

export function folderNameTaken(
  m: MailboxContext,
  name: string,
  excludingId?: string
) {
  const normalized = name.toLocaleLowerCase("en-US");

  return (
    normalized === DRAFTS_FOLDER_ID ||
    systemFolderDefinitions.some(
      (folder) => folder.name.toLocaleLowerCase("en-US") === normalized
    ) ||
    m.db
      .select({ id: folders.id, name: folders.name })
      .from(folders)
      .all()
      .some(
        (folder) =>
          folder.id !== excludingId &&
          folder.name.toLocaleLowerCase("en-US") === normalized
      )
  );
}

export function createFolder(m: MailboxContext, id: string, name: string) {
  const result = insertFolder(m, id, name);

  if (result.status === "ok") m.publishUpdate();

  return result;
}

export function insertFolder(m: MailboxContext, id: string, name: string) {
  const normalizedName = name.trim();

  if (!normalizedName || normalizedName.length > 80) {
    return { status: "invalid" as const };
  }

  const existing = m.db
    .select({ id: folders.id, sortOrder: folders.sortOrder })
    .from(folders)
    .all();

  if (existing.length >= MAX_CUSTOM_FOLDER_COUNT) {
    return { status: "limit" as const };
  }

  if (folderNameTaken(m, normalizedName)) {
    return { status: "conflict" as const };
  }

  // A new folder goes to the end of the whole order, system folders included.
  const last = Math.max(
    ...existing.map((item) => item.sortOrder),
    ...systemFolders(m).map((item) => item.sortOrder)
  );

  const folder = m.db
    .insert(folders)
    .values({ id, name: normalizedName, sortOrder: last + FOLDER_ORDER_STEP })
    .returning()
    .get();

  return { status: "ok" as const, folder };
}

export function renameFolder(m: MailboxContext, id: string, name: string) {
  const normalizedName = name.trim();

  if (!normalizedName || normalizedName.length > 80) {
    return { status: "invalid" as const };
  }

  if (
    !getFolder(m, id) ||
    systemFolderDefinitions.some((item) => item.id === id)
  ) {
    return { status: "not_found" as const };
  }

  if (folderNameTaken(m, normalizedName, id)) {
    return { status: "conflict" as const };
  }

  const [folder] = m.db
    .update(folders)
    .set({ name: normalizedName })
    .where(eq(folders.id, id))
    .returning()
    .all();

  if (!folder) return { status: "not_found" as const };
  m.publishUpdate();

  return { status: "ok" as const, folder };
}

export function deleteFolder(m: MailboxContext, id: string) {
  const deleted = m.db
    .delete(folders)
    .where(eq(folders.id, id))
    .returning({ id: folders.id })
    .all()[0];

  if (!deleted) return { status: "not_found" as const };
  m.publishUpdate();

  return { status: "ok" as const };
}

/**
 * Sets the one order of every folder but Inbox: each system folder and
 * custom folder exactly once, so system folders can sit among custom ones.
 */
export function reorderFolders(m: MailboxContext, folderIds: string[]) {
  const customIds = m.db
    .select({ id: folders.id })
    .from(folders)
    .all()
    .map((folder) => folder.id);

  if (!isCompleteFolderOrder(folderIds, customIds)) {
    return { status: "conflict" as const };
  }

  const custom = new Set(customIds);
  m.db.transaction((tx) => {
    for (const { id, sortOrder } of folderOrderPositions(folderIds)) {
      if (custom.has(id)) {
        tx.update(folders).set({ sortOrder }).where(eq(folders.id, id)).run();
      } else {
        tx.insert(systemFolderOrder)
          .values({ folderId: id, sortOrder })
          .onConflictDoUpdate({
            target: systemFolderOrder.folderId,
            set: { sortOrder },
          })
          .run();
      }
    }
  });
  m.publishUpdate();

  return { status: "ok" as const };
}
