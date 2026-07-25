import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  MAX_COMPOSER_ATTACHMENT_BYTES,
  MAX_COMPOSER_ATTACHMENT_COUNT,
  type ReplyActionMode,
} from "../../shared/mail";
import {
  api,
  responseJson,
  type SuccessfulResponse,
} from "@/lib/api";
import { invalidateMailQueries } from "./use-mail-data";

export type SubmittedMessage = SuccessfulResponse<
  Awaited<ReturnType<typeof api.api.mail.messages.$post>>
>;

type MessageContent = {
  mailboxId: string;
  bodyText: string;
};

export type MailSendInput =
  | MessageContent & {
    kind: "compose";
    to: string[];
    cc: string[];
    bcc: string[];
    replyTo?: string;
    subject: string;
  }
  | MessageContent & {
    kind: "reply";
    parentEmailId: string;
    mode: ReplyActionMode;
    cc: string[];
    bcc: string[];
  }
  | MessageContent & {
    kind: "forward";
    sourceEmailId: string;
    to: string[];
    cc: string[];
    bcc: string[];
    replyTo?: string;
  };

async function uploadAttachment(mailboxId: string, file: File) {
  const intent = await responseJson(
    await api.api.mail.uploads.$post({
      query: { mailboxId },
      json: {
        filename: file.name || "attachment",
        contentType: file.type || "application/octet-stream",
        size: file.size,
      },
    }),
  );
  const put = await fetch(intent.upload.uploadUrl, {
    method: "PUT",
    headers: intent.upload.headers,
    body: file,
  });
  if (!put.ok) {
    throw new Error(`Attachment upload failed (${put.status})`);
  }
  return intent.upload;
}

export function useMailSend() {
  const client = useQueryClient();
  const requestId = useRef(crypto.randomUUID());
  const [files, setFiles] = useState<File[]>([]);
  const totalAttachmentBytes = useMemo(
    () => files.reduce((total, file) => total + file.size, 0),
    [files],
  );

  const reset = useCallback(() => {
    requestId.current = crypto.randomUUID();
    setFiles([]);
  }, []);

  const send = useMutation({
    mutationFn: async (input: MailSendInput) => {
      const attachments = await Promise.all(
        files.map(async (file) => {
          const upload = await uploadAttachment(input.mailboxId, file);
          return { uploadId: upload.id };
        }),
      );
      const request = {
        requestId: requestId.current,
        mailboxId: input.mailboxId,
        bodyText: input.bodyText,
        attachments,
      };
      if (input.kind === "reply") {
        return responseJson(
          await api.api.mail.messages[":id"].replies.$post({
            param: { id: input.parentEmailId },
            json: {
              ...request,
              mode: input.mode,
              cc: input.cc,
              bcc: input.bcc,
            },
          }),
        );
      }
      if (input.kind === "forward") {
        return responseJson(
          await api.api.mail.messages[":id"].forward.$post({
            param: { id: input.sourceEmailId },
            json: {
              ...request,
              to: input.to,
              cc: input.cc,
              bcc: input.bcc,
              replyTo: input.replyTo,
            },
          }),
        );
      }
      return responseJson(
        await api.api.mail.messages.$post({
          json: {
            ...request,
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            replyTo: input.replyTo,
            subject: input.subject,
          },
        }),
      );
    },
    onSuccess: async () => {
      reset();
      await invalidateMailQueries(client);
    },
  });

  function addFiles(selected: FileList | null) {
    if (!selected) return;
    const next = [...files, ...Array.from(selected)];
    if (next.length > MAX_COMPOSER_ATTACHMENT_COUNT) {
      toast.error(`Use at most ${MAX_COMPOSER_ATTACHMENT_COUNT} attachments`);
      return;
    }
    if (
      next.reduce((total, file) => total + file.size, 0)
        > MAX_COMPOSER_ATTACHMENT_BYTES
    ) {
      toast.error(
        `Attachments are limited to ${Math.floor(MAX_COMPOSER_ATTACHMENT_BYTES / 1_000_000)} MB per message`,
      );
      return;
    }
    setFiles(next);
  }

  function removeFile(index: number) {
    setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  return {
    send,
    files,
    totalAttachmentBytes,
    addFiles,
    removeFile,
    reset,
  };
}

export function formatBytes(value: number) {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}
