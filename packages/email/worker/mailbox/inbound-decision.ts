/**
 * Where an incoming message goes: one decision from the sender's screening,
 * the mailbox's rules, AI sorting and the conversation it names, which the
 * mailbox then applies as it stores the message.
 */

export type MailboxState = "active" | "archive" | "spam" | "trash";

export type DeliveryInput = {
  /** A block (the mailbox's or the workspace's) on the sender. */
  blocked: boolean;
  /** The sender is marked trusted here. */
  trusted: boolean;
  /** DMARC verified the From address, so it can't be forged. */
  authenticated: boolean;
  /** The first matching rule's placement, and the rules' other actions. */
  rules: {
    placement:
      | { type: "spam" | "trash" | "archive" }
      | { type: "folder"; folderId: string }
      | null;
    notSpam: boolean;
    markRead: boolean;
  } | null;
  /** AI sorting's verdict; its folder only when that folder still exists. */
  classification: { spam: boolean; folderId: string | null } | null;
  /** The conversation the message's threading headers name, if it exists. */
  parent: { state: MailboxState; folderId: string | null } | null;
  /**
   * The message would be the conversation's first incoming one, e.g. a
   * reply to a thread this mailbox started: it is filed like new mail.
   */
  startsConversation: boolean;
  /** Whether a rule's folder still exists. */
  folderExists: (folderId: string) => boolean;
};

export type DeliveryDecision = {
  /**
   * The message starts its own conversation instead of joining the one it
   * names: that one is somewhere this message must not take it (or pull it
   * from), e.g. spam naming a thread in Inbox.
   */
  split: boolean;
  state: MailboxState;
  folderId: string | null;
  /** Read for everyone with access (a rule's "Mark read"). */
  markRead: boolean;
};

/**
 * Blocks win over rules and AI. A rule's Spam wins over AI; an AI spam
 * verdict holds unless the sender is trusted (and authenticated, since the
 * From address is the sender's to choose) or a rule says "never Spam".
 *
 * A message joins the conversation it names unless that would move it
 * between Spam or Trash and the rest; then it starts its own (recording
 * the one it named, to rejoin when it leaves Spam). Joining a received
 * thread leaves it where it is, except that new mail brings a thread back
 * from Archive or Trash, unless an Archive rule matches (a notification
 * thread stays archived). A thread's first incoming message is filed like
 * new mail.
 */
export function decideDelivery(input: DeliveryInput): DeliveryDecision {
  const rule = input.rules?.placement ?? null;
  const trusted = input.trusted && input.authenticated && !input.blocked;

  const spam =
    input.blocked ||
    rule?.type === "spam" ||
    (Boolean(input.classification?.spam) && !trusted && !input.rules?.notSpam);

  const { parent } = input;
  const markRead = Boolean(input.rules?.markRead) && !spam;

  const decided = (
    state: MailboxState,
    folderId: string | null,
    split: boolean
  ): DeliveryDecision => ({ split, state, folderId, markRead });

  if (spam || rule?.type === "trash") {
    const state = spam ? "spam" : "trash";

    // Spam may join spam, and Trash Trash; anything else stays apart.
    return decided(state, null, Boolean(parent && parent.state !== state));
  }

  // Not spam: a thread in Spam isn't brought into Inbox by it, nor is this
  // message hidden in Spam with it.
  if (parent?.state === "spam") return decided("active", null, true);

  // A rule's folder, else AI sorting's (asked only when no rule placed it).
  const folder =
    rule?.type === "folder"
      ? input.folderExists(rule.folderId)
        ? rule.folderId
        : null
      : (input.classification?.folderId ?? null);

  if (!parent || input.startsConversation) {
    if (rule?.type === "archive") return decided("archive", null, false);

    // Filed only if the thread isn't in a folder already.
    return decided("active", parent?.folderId ?? folder, false);
  }

  if (parent.state === "archive" && rule?.type === "archive") {
    return decided("archive", null, false);
  }

  // Where the thread is, brought back from Archive or Trash.
  return decided("active", parent.folderId, false);
}
