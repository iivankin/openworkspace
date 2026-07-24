import type { api, SuccessfulResponse } from "@/lib/api";

type AdminStateResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.admin.state.$get>>
>;

export type AdminMailbox = AdminStateResponse["mailboxes"][number];
export type AdminUser = AdminStateResponse["users"][number];
export type MailboxMemberPermission = AdminMailbox["members"][number];

export type InvitationInput = {
  name: string;
  email: string;
  avatarUrl: string | null;
};

export type UpdateUserInput = Pick<
  AdminUser,
  "name" | "avatarUrl"
>;

export type CreateMailboxInput = {
  displayName: string;
  address: string;
  members: MailboxMemberPermission[];
};

export type UpdateMailboxInput = Pick<
  CreateMailboxInput,
  "displayName" | "members"
>;
