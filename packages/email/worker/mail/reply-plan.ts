import {
  normalizeEmail,
  normalizeMailboxAddress,
} from "@open-workspace/core/module";

import type { ReplyAction, ReplyPlan } from "../../shared/mail";
import type { MailAddress } from "../mailbox/model";
import type { Email } from "../mailbox/schema";

export type {
  ReplyAction,
  ReplyActionMode,
  ReplyPlan,
} from "../../shared/mail";

/**
 * Whether `address` is one of the mailbox's own addresses (`own`, normalized),
 * or a plus address of one (`sam+shop@` for `sam@`), which delivers there too.
 */
function isOwnAddress(address: string, own: ReadonlySet<string>) {
  const normalized = normalizeMailboxAddress(address);

  if (own.has(normalized)) return true;
  const at = normalized.lastIndexOf("@");
  const plus = normalized.indexOf("+");

  return (
    plus > 0 &&
    plus < at &&
    own.has(`${normalized.slice(0, plus)}${normalized.slice(at)}`)
  );
}

/** Each address once, leaving out the mailbox's own. */
function uniqueAddresses(values: MailAddress[], own: ReadonlySet<string>) {
  const result = new Set<string>();

  for (const value of values) {
    const normalized = normalizeEmail(value.address);

    if (normalized && !isOwnAddress(normalized, own)) result.add(normalized);
  }

  return [...result];
}

function without(values: string[], excluded: string[]) {
  const blocked = new Set(excluded.map(normalizeEmail));

  return values.filter((value) => !blocked.has(normalizeEmail(value)));
}

type ReplySource = Pick<
  Email,
  | "direction"
  | "messageIdHeader"
  | "transportState"
  | "fromJson"
  | "replyToJson"
  | "toJson"
  | "ccJson"
  | "listId"
  | "listPostAddress"
>;

export function canReplyFrom(
  email: Pick<ReplySource, "direction" | "messageIdHeader" | "transportState">
) {
  if (email.direction === "incoming") return true;

  return Boolean(email.messageIdHeader) && email.transportState === "submitted";
}

/**
 * How a message can be answered from a mailbox. `ownAddresses` are all of
 * the mailbox's addresses (the one replies come from, its own and its
 * aliases'); none of them, nor a plus address of one, is a recipient.
 */
export function buildReplyPlan(
  ownAddresses: readonly string[],
  email: ReplySource
): ReplyPlan {
  const own = new Set(
    ownAddresses.map((address) => normalizeMailboxAddress(address))
  );

  if (email.direction === "outgoing") {
    const to = uniqueAddresses(email.toJson, own);
    const cc = without(uniqueAddresses(email.ccJson, own), to);
    const participants = [...to, ...cc];

    return {
      defaultMode: "continue",
      isGroup: participants.length > 1,
      participants,
      actions: canReplyFrom(email)
        ? [
            {
              mode: "continue",
              label: "Continue",
              to,
              cc,
            },
          ]
        : [],
    };
  }

  // List managers commonly rewrite Reply-To to the list itself. A private
  // reply must still target the actual author; List-Post is handled separately.
  const replyTargets = uniqueAddresses(
    email.listId
      ? email.fromJson
      : email.replyToJson.length
        ? email.replyToJson
        : email.fromJson,
    own
  );

  const visibleParticipants = uniqueAddresses(
    [...email.fromJson, ...email.toJson, ...email.ccJson],
    own
  );

  const replyAllParticipants = uniqueAddresses(
    [
      ...(email.listId
        ? email.fromJson
        : email.replyToJson.length
          ? email.replyToJson
          : email.fromJson),
      ...email.toJson,
      ...email.ccJson,
    ],
    own
  );

  const visibleIsGroup =
    Boolean(email.listId) || replyAllParticipants.length > 1;

  const visibleRecipients = [...email.toJson, ...email.ccJson].some(
    (recipient) => isOwnAddress(recipient.address, own)
  );

  const undisclosedLocalRecipient = !email.listId && !visibleRecipients;
  const isGroup = visibleIsGroup && !undisclosedLocalRecipient;

  const actions: ReplyAction[] = [
    {
      mode: "reply",
      label: "Reply",
      to: replyTargets,
      cc: [],
    },
  ];

  const listTargets = uniqueAddresses(
    email.listPostAddress
      ? [{ address: email.listPostAddress, name: null }]
      : [],
    own
  ).slice(0, 1);

  if (!email.listId && visibleIsGroup) {
    actions.push({
      mode: "reply_all",
      label: "Reply all",
      to: replyTargets,
      cc: without(replyAllParticipants, replyTargets),
    });
  }

  if (email.listId && listTargets.length) {
    actions.push({
      mode: "reply_list",
      label: "Reply to list",
      to: listTargets,
      cc: [],
    });
  }

  return {
    defaultMode: listTargets.length
      ? "reply_list"
      : email.listId
        ? "reply"
        : undisclosedLocalRecipient
          ? "reply"
          : isGroup
            ? "reply_all"
            : "reply",
    isGroup,
    participants: undisclosedLocalRecipient
      ? replyTargets
      : visibleParticipants,
    actions,
  };
}

/**
 * The alias a reply comes from: the one the source was delivered to, or
 * sent from; null to use the mailbox's own address.
 */
export function replyAlias<Alias extends { address: string }>(
  source: Pick<Email, "direction" | "envelopeTo" | "fromJson">,
  aliases: readonly Alias[]
) {
  const address =
    source.direction === "incoming"
      ? source.envelopeTo
      : (source.fromJson[0]?.address ?? null);

  if (!address) return null;
  const normalized = normalizeMailboxAddress(address);
  const at = normalized.lastIndexOf("@");
  const plus = normalized.indexOf("+");

  // `sales+promo@` reached the alias `sales@`, and is answered from it.
  const base =
    plus > 0 && plus < at
      ? `${normalized.slice(0, plus)}${normalized.slice(at)}`
      : normalized;

  return (
    aliases.find(
      (alias) => alias.address === normalized || alias.address === base
    ) ?? null
  );
}
