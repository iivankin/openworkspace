import { can, createDb, mayManageAddress } from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import type { Context } from "hono";

/**
 * Who may do what with a mailbox, in one place, so every route (and JMAP)
 * answers the same and the app can hide what the Worker would refuse.
 *
 * - Read: anyone `accessibleMailbox` lets in.
 * - Send, and delete for good: send access.
 * - Organize the mailbox itself (folders, rules, AI sorting): its owner for
 *   a person's own mailbox; for a shared inbox, which these act on for
 *   everyone, people who manage teams.
 * - Configure the address (auto-reply, forwards): its owner for their own
 *   mailbox, and whoever may manage the address in core (mayManageAddress).
 */

/** Whether `mailbox` (as accessibleMailbox returns it) may be organized by this request. */
export function mayOrganizeMailbox(
  c: Context<AppEnv>,
  mailbox: { ownerUserId: string | null }
) {
  return mailbox.ownerUserId !== null || can(c, "manage_teams");
}

/** Whether this request may change what is set on an address (auto-reply, forwards). */
export function mayConfigureAddress(
  c: Context<AppEnv>,
  address: { ownerUserId: string | null }
) {
  if (
    address.ownerUserId !== null &&
    address.ownerUserId === c.get("user").id
  ) {
    return Promise.resolve(true);
  }

  return mayManageAddress(c, createDb(c.env.DB), address);
}
