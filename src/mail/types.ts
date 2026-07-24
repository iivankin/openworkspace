import type { api, SuccessfulResponse } from "@/lib/api";

export type {
  MailboxState,
  RecipientDeliveryStatus,
  ReplyAction,
  ReplyActionMode,
  ReplyPlan,
  TransportState,
} from "../../shared/mail";

type MailboxesResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.mail.mailboxes.$get>>
>;
type FoldersResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.mail.mailboxes[":id"]["folders"]["$get"]>>
>;
type ConversationsResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.mail.conversations.$get>>
>;
type ConversationResponse = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.mail.conversations[":id"]["$get"]>>
>;

export type Mailbox = MailboxesResponse["mailboxes"][number];
export type MailFolder = FoldersResponse["folders"][number];
export type ConversationSummary =
  ConversationsResponse["conversations"][number];
export type MessageDetail = ConversationResponse["messages"][number];
export type MessageAttachment = MessageDetail["attachments"][number];

export type Folder = string;
