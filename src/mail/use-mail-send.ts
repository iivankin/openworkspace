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

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read attachment"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Could not read attachment"));
        return;
      }
      resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
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
        files.map(async (file) => ({
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          contentBase64: await fileToBase64(file),
        })),
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
      toast.error("Attachments are limited to 20 MB per message");
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
