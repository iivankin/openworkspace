import { Download, FileText } from "lucide-react";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { attachmentPreview } from "../../shared/attachment-preview";
import { AttachmentPreviewDialog } from "./attachment-preview-dialog";
import { formatBytes } from "./format-bytes";
import type { MessageAttachment } from "./types";

const attachmentClassName = "flex max-w-full items-center gap-2 rounded-lg border border-current/12 bg-current/4 px-2.5 py-1.5 text-xs transition-colors hover:border-current/25 hover:bg-current/8 focus-visible:outline-2 focus-visible:outline-ring";

export function MessageAttachments({
  messageId,
  mailboxId,
  attachments,
}: {
  messageId: string;
  mailboxId?: string;
  attachments: MessageAttachment[];
}) {
  if (!attachments.length) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2 border-t border-current/10 pt-3">
      {attachments.map((attachment) => {
        const baseUrl = `/api/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}`;
        const query = `?mailboxId=${encodeURIComponent(mailboxId ?? "")}`;
        const downloadUrl = `${baseUrl}${query}`;
        const preview = attachmentPreview(attachment);
        const Icon = preview ? FileText : Download;
        const label = (
          <>
            <Icon className="size-3.5 shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate font-medium">{attachment.filename}</span>
            <span className="shrink-0 opacity-60 tabular-nums">{formatBytes(attachment.size)}</span>
          </>
        );

        if (!preview) {
          return (
            <a key={attachment.id} className={attachmentClassName} href={downloadUrl}>
              {label}
            </a>
          );
        }
        return (
          <Dialog key={attachment.id}>
            <DialogTrigger className={attachmentClassName} aria-label={`Preview ${attachment.filename}`}>
              {label}
            </DialogTrigger>
            <AttachmentPreviewDialog
              messageId={messageId}
              mailboxId={mailboxId ?? ""}
              attachment={attachment}
              preview={preview}
              previewUrl={`${baseUrl}/preview${query}`}
              downloadUrl={downloadUrl}
            />
          </Dialog>
        );
      })}
    </div>
  );
}
