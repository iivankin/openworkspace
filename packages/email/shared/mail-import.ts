/**
 * Importing existing mail (`POST /api/mail/import/mailboxes/:id/messages`).
 * The `open-workspace import` CLI (@open-workspace/create) speaks this
 * protocol; it keeps its own copy of these values so it does not depend on
 * this package.
 */

/**
 * The largest raw message the import accepts: the size Email Routing
 * delivers, so an imported message is never bigger than one the mailbox
 * could have received.
 */
export const MAX_IMPORT_MESSAGE_BYTES = 25 * 1024 * 1024;

/**
 * Where an imported message puts its conversation. `inbox` (with an
 * optional custom folder), Archive, Spam, Trash; `sent` says nothing about
 * the conversation's place (a sent message that was never in the Inbox).
 */
export const importPlacements = [
  "inbox",
  "archive",
  "spam",
  "trash",
  "sent",
] as const;

export type ImportPlacement = (typeof importPlacements)[number];

/** The longest caller-supplied source id and thread key. */
export const MAX_IMPORT_KEY_LENGTH = 512;
