import {
  ChevronUp,
  LoaderCircle,
  Minus,
  Paperclip,
  Send,
  X,
} from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { forwardSubject, MAX_MAIL_RECIPIENTS } from "../../shared/mail";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Textarea } from "@/components/ui/textarea";
import {
  dedupeRecipientInputs,
  parseRecipientInput,
  recipientInputCount,
} from "./recipient-input";
import { RecipientFieldRow } from "./recipient-field-row";
import { notifyOutboundResult } from "./outbound-notification";
import type { Mailbox, MessageDetail } from "./types";
import { formatBytes, useMailSend, type MailSendInput } from "./use-mail-send";

export function ComposeWindow({
  mailbox,
  forwardedMessage,
  onClose,
}: {
  mailbox: Mailbox;
  forwardedMessage?: Pick<
    MessageDetail,
    "id" | "subject" | "fromAddress" | "fromName" | "preview"
  >;
  onClose: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [subject, setSubject] = useState(
    () => forwardedMessage ? forwardSubject(forwardedMessage.subject) : "",
  );
  const [body, setBody] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [showReplyTo, setShowReplyTo] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const {
    send,
    files,
    totalAttachmentBytes,
    addFiles,
    removeFile,
  } = useMailSend();

  const recipients = dedupeRecipientInputs({
    to: parseRecipientInput(to),
    cc: parseRecipientInput(cc),
    bcc: parseRecipientInput(bcc),
  });
  const recipientCount = recipientInputCount(recipients);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (send.isPending) return;
    if (recipientCount === 0) {
      toast.error("Add at least one recipient in To, Cc, or Bcc");
      return;
    }
    if (recipientCount > MAX_MAIL_RECIPIENTS) {
      toast.error(`Use at most ${MAX_MAIL_RECIPIENTS} recipients across To, Cc, and Bcc`);
      return;
    }
    if (!mailbox.canSend) {
      toast.error("This mailbox is read-only");
      return;
    }
    const common = {
      mailboxId: mailbox.id,
      bodyText: body,
    };
    const command: MailSendInput = forwardedMessage
      ? {
          ...common,
          kind: "forward",
          sourceEmailId: forwardedMessage.id,
          to: recipients.to,
          cc: recipients.cc,
          bcc: recipients.bcc,
          replyTo: replyTo.trim() || undefined,
        }
      : {
          ...common,
          kind: "compose",
          to: recipients.to,
          cc: recipients.cc,
          bcc: recipients.bcc,
          replyTo: replyTo.trim() || undefined,
          subject,
        };
    send.mutate(command, {
      onSuccess: (result) => {
        notifyOutboundResult(result, "message");
        onClose();
      },
      onError: (error) => toast.error(error.message),
    });
  }

  if (minimized) {
    return (
      <section
        aria-label="Minimized message composer"
        className="fixed right-4 bottom-4 z-50 flex h-13 w-[min(360px,calc(100vw-2rem))] animate-rise items-center gap-1 rounded-xl bg-surface pr-1.5 pl-4 shadow-2xl ring-1 ring-border"
      >
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm font-semibold"
          onClick={() => setMinimized(false)}
        >
          {subject || "New message"}
        </button>
        <Button variant="ghost" size="icon-sm" onClick={() => setMinimized(false)}>
          <ChevronUp /><span className="sr-only">Restore composer</span>
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <X /><span className="sr-only">Close composer</span>
        </Button>
      </section>
    );
  }

  return (
    <section
      role="dialog"
      aria-label="New message"
      className="fixed inset-0 z-50 flex animate-rise flex-col bg-surface shadow-2xl ring-1 ring-border sm:inset-auto sm:right-5 sm:bottom-5 sm:h-[min(480px,calc(100dvh-2.5rem))] sm:w-[min(440px,calc(100vw-2.5rem))] sm:rounded-2xl"
    >
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
        <header className="flex h-13 shrink-0 items-center gap-1 border-b border-border/70 bg-surface-sunken/70 pr-1.5 pl-4 sm:rounded-t-2xl">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">New message</p>
            <p className="truncate text-[11px] text-muted-foreground">From {mailbox.address}</p>
          </div>
          <Button className="hidden sm:inline-flex" type="button" variant="ghost" size="icon-sm" onClick={() => setMinimized(true)}>
            <Minus /><span className="sr-only">Minimize composer</span>
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose}>
            <X /><span className="sr-only">Close composer</span>
          </Button>
        </header>

        <div className="shrink-0 divide-y divide-border/70 border-b border-border/70 px-4">
          <InputGroup className="h-11 rounded-none border-0 bg-transparent shadow-none dark:bg-transparent">
            <InputGroupAddon className="w-14 justify-start pl-0">
              <InputGroupText className="text-xs font-medium">To</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput className="px-3" value={to} onChange={(event) => setTo(event.target.value)} placeholder="name@example.com" />
            <InputGroupAddon align="inline-end" className="gap-0 pr-0">
              <InputGroupButton onClick={() => setShowCc(true)}>Cc</InputGroupButton>
              <InputGroupButton onClick={() => setShowBcc(true)}>Bcc</InputGroupButton>
              <InputGroupButton onClick={() => setShowReplyTo(true)}>Reply-to</InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          {showCc && <RecipientFieldRow label="Cc" value={cc} onChange={setCc} />}
          {showBcc && <RecipientFieldRow label="Bcc" value={bcc} onChange={setBcc} />}
          {showReplyTo && <RecipientFieldRow label="Reply-to" value={replyTo} onChange={setReplyTo} />}
          <InputGroup className="h-11 rounded-none border-0 bg-transparent shadow-none dark:bg-transparent">
            <InputGroupAddon className="w-14 justify-start pl-0">
              <InputGroupText className="text-xs font-medium">Subject</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              className="px-3"
              value={subject}
              readOnly={Boolean(forwardedMessage)}
              onChange={(event) => setSubject(event.target.value)}
              placeholder="Subject"
            />
          </InputGroup>
        </div>

        {forwardedMessage && (
          <div className="shrink-0 border-b border-border/70 bg-primary/8 px-4 py-2.5 text-xs">
            <p className="font-semibold">Forwarding {forwardedMessage.fromName || forwardedMessage.fromAddress}</p>
            <p className="mt-0.5 truncate text-muted-foreground">
              {forwardedMessage.subject} · {forwardedMessage.preview}
            </p>
          </div>
        )}

        <Textarea className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-4 py-4 text-[0.9375rem] leading-[1.65] shadow-none hover:border-transparent focus-visible:ring-0 dark:bg-transparent" value={body} onChange={(event) => setBody(event.target.value)} placeholder="Write a message" />

        {files.length > 0 && (
          <div className="max-h-28 shrink-0 overflow-y-auto border-t border-border/70 px-4 py-2">
            {files.map((file, index) => (
              <div key={`${file.name}-${index}`} className="flex items-center gap-2 py-1 text-xs">
                <Paperclip className="size-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{file.name}</span>
                <span className="text-muted-foreground tabular-nums">{formatBytes(file.size)}</span>
                <Button type="button" variant="ghost" size="icon-xs" onClick={() => removeFile(index)}>
                  <X /><span className="sr-only">Remove {file.name}</span>
                </Button>
              </div>
            ))}
          </div>
        )}

        <footer className="flex h-15 shrink-0 items-center gap-2 border-t border-border/70 bg-surface-sunken/70 px-3 sm:rounded-b-2xl">
          <input
            ref={fileInput}
            className="sr-only"
            type="file"
            multiple
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => fileInput.current?.click()}>
            <Paperclip /><span className="sr-only">Add attachments</span>
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {files.length > 0
              ? `${files.length} files · ${formatBytes(totalAttachmentBytes)} · large files become 30-day links`
              : "Up to 20 MB"}
          </span>
          <Button
            className="ml-auto"
            type="submit"
            disabled={send.isPending || recipientCount === 0 || !mailbox.canSend}
          >
            {send.isPending ? <LoaderCircle className="animate-spin" /> : <Send />}
            Send
          </Button>
        </footer>
      </form>
    </section>
  );
}
