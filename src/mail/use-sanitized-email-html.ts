import { useQuery } from "@tanstack/react-query";
import { sanitizeEmailHtml } from "./sanitize-email-html";
import type { MessageDetail } from "./types";

export function useSanitizedEmailHtml(
  bodyHtml: string | null | undefined,
  mailboxId: string,
  message: MessageDetail,
) {
  return useQuery({
    queryKey: ["sanitized-message-html", mailboxId, message.id],
    queryFn: () => sanitizeEmailHtml({
      html: bodyHtml ?? "",
      mailboxId,
      messageId: message.id,
      attachments: message.attachments,
    }),
    enabled: Boolean(bodyHtml),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
