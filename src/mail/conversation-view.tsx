import { format } from "date-fns";
import {
  Archive,
  ArrowLeft,
  CircleAlert,
  ChevronDown,
  Download,
  FileText,
  Forward,
  Inbox,
  LoaderCircle,
  RotateCw,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Bubble,
  BubbleContent,
  BubbleGroup,
  BubbleReactions,
} from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { baseSubject } from "../../shared/mail";
import {
  ConversationReply,
  ReplyActionIcon,
  type SentReply,
} from "./conversation-reply";
import { DeliveryIndicator } from "./delivery-indicator";
import { EmailHtmlBody } from "./email-html-body";
import { notifyOutboundResult } from "./outbound-notification";
import { useResendMessage } from "./use-mail-data";
import { formatBytes } from "./use-mail-send";
import type {
  Mailbox,
  MessageDetail,
  ReplyAction,
  ReplyActionMode,
} from "./types";

type ReplySelection = {
  parentId: string;
  mode: ReplyActionMode;
};

export function ConversationView({
  messages,
  loading,
  error,
  mailbox,
  mailboxState,
  onRetry,
  onBack,
  onArchive,
  onRestore,
  onTrash,
  onForward,
  onOpenConversation,
}: {
  messages: MessageDetail[];
  loading: boolean;
  error?: string;
  mailbox?: Mailbox;
  mailboxState: "active" | "archive" | "spam" | "trash";
  onRetry: () => void;
  onBack: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onTrash: () => void;
  onForward: (message: MessageDetail) => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [replySelection, setReplySelection] = useState<ReplySelection | null>(null);
  const resendMessage = useResendMessage();

  if (loading) {
    return <div className="grid min-h-72 place-items-center"><LoaderCircle className="animate-spin text-muted-foreground" /></div>;
  }
  if (error) {
    return (
      <section className="w-full px-3 sm:px-6">
        <div className="flex h-14 items-center border-b">
          <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft /> Back</Button>
        </div>
        <div className="grid min-h-72 place-items-center text-center">
          <div>
            <CircleAlert className="mx-auto size-7 text-destructive/70" />
            <p className="mt-3 text-sm font-medium">Could not load this conversation</p>
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">{error}</p>
            <Button className="mt-4" variant="outline" size="sm" onClick={onRetry}>
              <RotateCw /> Retry
            </Button>
          </div>
        </div>
      </section>
    );
  }
  const latest = messages.at(-1);
  if (!latest) return null;
  const conversationSubject = baseSubject(latest.subject);
  const explicitlySelected = messages.find(
    (message) => message.id === replySelection?.parentId && message.replyPlan.actions.length > 0,
  );
  const selectedParent = explicitlySelected ?? null;
  const selectedMode = selectedParent && replySelection
    ? replySelection.mode
    : null;

  function handleSent(result: SentReply) {
    setReplySelection(null);
    if (result.detached) onOpenConversation(result.conversationId);
  }

  function resend(message: MessageDetail) {
    if (!mailbox) return;
    if (
      message.transportState === "unconfirmed"
      && !window.confirm(
        "The original submission was not confirmed. Sending again can deliver a duplicate. Send again?",
      )
    ) {
      return;
    }
    resendMessage.mutate(
      { id: message.id, mailboxId: mailbox.id },
      {
        onSuccess: (result) => notifyOutboundResult(result, "message"),
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <article className="w-full px-3 pb-24 sm:px-6 lg:pb-8">
      <header className="sticky top-0 z-30 -mx-3 flex h-14 items-center gap-1 border-b bg-background/95 px-3 backdrop-blur sm:-mx-6 sm:px-6">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
        <Separator orientation="vertical" className="mx-2 h-5" />
        {mailboxState === "active" ? (
          <Button variant="ghost" size="icon-sm" onClick={onArchive}>
            <Archive /><span className="sr-only">Archive conversation</span>
          </Button>
        ) : (
          <Button variant="ghost" size="icon-sm" onClick={onRestore}>
            <Inbox />
            <span className="sr-only">
              {mailboxState === "spam" ? "Mark as not spam" : "Move conversation to inbox"}
            </span>
          </Button>
        )}
        {mailboxState !== "trash" && (
          <Button variant="ghost" size="icon-sm" onClick={onTrash}>
            <Trash2 /><span className="sr-only">Move conversation to trash</span>
          </Button>
        )}
      </header>

      <div className="mx-auto max-w-4xl py-7 sm:py-10">
        <div className="mb-8">
          <p className="text-xs font-medium text-muted-foreground">
            {messages.length} {messages.length === 1 ? "message" : "messages"}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">{conversationSubject}</h1>
        </div>

        <BubbleGroup className="gap-1 pb-3">
          {messages.map((message, index) => {
            const previous = messages[index - 1];
            const audience = previous ? audienceChange(previous, message) : null;
            return (
              <div key={message.id} className="contents">
                {audience && <AudienceChange text={audience} />}
                <MessageBubble
                  message={message}
                  mailboxId={mailbox?.id}
                  showAvatar={shouldShowAvatar(previous, message)}
                  canForward={Boolean(mailbox?.canSend)}
                  onReply={(action) => setReplySelection({
                    parentId: message.id,
                    mode: action.mode,
                  })}
                  onRetry={() => resend(message)}
                  onForward={() => onForward(message)}
                  retryPending={resendMessage.isPending && resendMessage.variables?.id === message.id}
                />
              </div>
            );
          })}
        </BubbleGroup>

        {selectedParent && selectedMode && (
          <ConversationReply
            key={selectedParent.id}
            mailbox={mailbox}
            parent={selectedParent}
            mode={selectedMode}
            onModeChange={(mode) => setReplySelection({
              parentId: selectedParent.id,
              mode,
            })}
            onSent={handleSent}
          />
        )}
      </div>
    </article>
  );
}

function MessageBubble({
  message,
  mailboxId,
  showAvatar,
  canForward,
  onReply,
  onRetry,
  onForward,
  retryPending,
}: {
  message: MessageDetail;
  mailboxId?: string;
  showAvatar: boolean;
  canForward: boolean;
  onReply: (action: ReplyAction) => void;
  onRetry: () => void;
  onForward: () => void;
  retryPending: boolean;
}) {
  const outgoing = message.direction === "outgoing";
  const sender = message.fromName || message.fromAddress;

  return (
    <section
      className={cn(
        "group/message flex items-end gap-2 pb-5 pt-1",
        outgoing && "justify-end",
      )}
      data-message-id={message.id}
    >
      {!outgoing && (
        showAvatar
          ? (
              <Avatar className="size-8 shrink-0">
                <AvatarFallback className="text-[11px] font-semibold">{initials(sender)}</AvatarFallback>
              </Avatar>
            )
          : <span className="w-8 shrink-0" aria-hidden="true" />
      )}

      <Bubble
        align={outgoing ? "end" : "start"}
        variant={outgoing ? "tinted" : "secondary"}
        className="max-w-[calc(100%-2.5rem)] sm:max-w-[78%]"
      >
        <MessageMetadata
          message={message}
          mailboxId={mailboxId}
          sender={sender}
          outgoing={outgoing}
        />
        <BubbleContent className="w-full min-w-36 px-3.5 py-2.5">
          {message.hasHtmlBody && !message.quotedText && mailboxId ? (
            <EmailHtmlBody mailboxId={mailboxId} message={message} />
          ) : (
            <div className="whitespace-pre-wrap text-[15px] leading-6">
              {message.bodyText || (message.quotedText ? "No new text" : message.preview || "No text body")}
            </div>
          )}

          {message.quotedText && (
            <Collapsible className="mt-2 border-t border-current/10 pt-1.5">
              <CollapsibleTrigger className="group/quote flex items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:underline">
                <ChevronDown className="size-3.5 transition-transform group-data-[panel-open]/quote:rotate-180" />
                Show quoted text
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap border-l-2 border-current/15 pl-3 text-xs leading-5 text-muted-foreground">
                {message.quotedText}
              </CollapsibleContent>
            </Collapsible>
          )}

          {message.attachments.length > 0 && (
            <div className="mt-2 divide-y divide-current/10 border-t border-current/10">
              {message.attachments.map((attachment) => (
                <a
                  key={attachment.id}
                  className="flex items-center gap-2 py-2 text-xs hover:opacity-70"
                  href={`/api/mail/messages/${message.id}/attachments/${attachment.id}?mailboxId=${encodeURIComponent(mailboxId ?? "")}`}
                >
                  <Download className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
                  <span className="opacity-60">{formatBytes(attachment.size)}</span>
                </a>
              ))}
            </div>
          )}

          <DeliveryIndicator message={message} />
        </BubbleContent>

        {(message.replyPlan.actions.length > 0 || canRetry(message) || canForward) && (
          <BubbleReactions
            align={outgoing ? "end" : "start"}
            className="opacity-100 transition-opacity md:opacity-0 md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100"
          >
            {message.replyPlan.actions.map((action) => (
              <Button
                key={action.mode}
                type="button"
                size="xs"
                variant="ghost"
                className="h-7 rounded-full px-2 text-xs"
                aria-label={actionAriaLabel(action)}
                onClick={() => onReply(action)}
              >
                <ReplyActionIcon mode={action.mode} />
                <span className="hidden sm:inline">{actionButtonLabel(action)}</span>
              </Button>
            ))}
            {canForward && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="h-7 rounded-full px-2 text-xs"
                aria-label="Forward this message"
                onClick={onForward}
              >
                <Forward />
                <span className="hidden sm:inline">Forward</span>
              </Button>
            )}
            {canRetry(message) && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="h-7 rounded-full px-2 text-xs"
                disabled={retryPending}
                onClick={onRetry}
              >
                <RotateCw className={cn(retryPending && "animate-spin")} />
                <span className="hidden sm:inline">
                  {message.transportState === "failed" ? "Retry" : "Send again"}
                </span>
              </Button>
            )}
          </BubbleReactions>
        )}
      </Bubble>
    </section>
  );
}

function canRetry(message: MessageDetail) {
  return message.direction === "outgoing"
    && (
      message.transportState === "failed"
      || message.transportState === "unconfirmed"
    );
}

function MessageMetadata({
  message,
  mailboxId,
  sender,
  outgoing,
}: {
  message: MessageDetail;
  mailboxId?: string;
  sender: string;
  outgoing: boolean;
}) {
  return (
    <details className={cn("group/meta max-w-full text-xs", outgoing && "text-right")}>
      <summary className="flex cursor-pointer list-none items-baseline gap-2 text-muted-foreground outline-none focus-visible:underline">
        <span className="min-w-0 truncate font-medium text-foreground">{outgoing ? "You" : sender}</span>
        <time className="shrink-0 text-[11px]">{format(new Date(message.timelineAt), "MMM d · HH:mm")}</time>
        <ChevronDown className="size-3 shrink-0 transition-transform group-open/meta:rotate-180" />
      </summary>
      <dl className={cn(
        "mt-1 grid max-w-xl grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-left text-[11px]",
        outgoing && "ml-auto",
      )}>
        <dt className="text-muted-foreground">From</dt><dd className="truncate">{message.fromAddress}</dd>
        <dt className="text-muted-foreground">To</dt><dd className="truncate">{message.toAddresses.join(", ")}</dd>
        {message.ccAddresses.length > 0 && <><dt className="text-muted-foreground">Cc</dt><dd className="truncate">{message.ccAddresses.join(", ")}</dd></>}
        {message.bccAddresses.length > 0 && <><dt className="text-muted-foreground">Bcc</dt><dd className="truncate">{message.bccAddresses.join(", ")}</dd></>}
        {message.replyToAddresses.length > 0 && <><dt className="text-muted-foreground">Reply-to</dt><dd className="truncate">{message.replyToAddresses.join(", ")}</dd></>}
        {message.hasOriginal && mailboxId && (
          <>
            <dt className="text-muted-foreground">Source</dt>
            <dd>
              <a
                className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
                href={`/api/mail/messages/${message.id}/original?mailboxId=${encodeURIComponent(mailboxId)}`}
                target="_blank"
                rel="noreferrer"
              >
                <FileText className="size-3" />
                Show original
              </a>
            </dd>
          </>
        )}
      </dl>
    </details>
  );
}

function AudienceChange({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 py-4 text-[11px] text-muted-foreground">
      <Separator className="flex-1" />
      <span>{text}</span>
      <Separator className="flex-1" />
    </div>
  );
}

function shouldShowAvatar(previous: MessageDetail | undefined, message: MessageDetail) {
  if (message.direction === "outgoing") return false;
  return !previous
    || previous.direction !== "incoming"
    || previous.fromAddress !== message.fromAddress;
}

function audienceChange(previous: MessageDetail, current: MessageDetail) {
  const before = new Set(previous.replyPlan.participants);
  const after = new Set(current.replyPlan.participants);
  if (
    before.size === after.size
    && [...before].every((participant) => after.has(participant))
  ) return null;
  const added = current.replyPlan.participants.filter((value) => !before.has(value));
  const removed = previous.replyPlan.participants.filter((value) => !after.has(value));
  if (added.length && !removed.length) return `${added.join(", ")} joined`;
  if (removed.length && !added.length) return `${removed.join(", ")} left`;
  return "Recipients changed";
}

function actionButtonLabel(action: ReplyAction) {
  if (action.mode === "reply_all") return "Reply all";
  if (action.mode === "reply_list") return "Reply to list";
  if (action.mode === "continue") return "Continue";
  return "Reply";
}

function actionAriaLabel(action: ReplyAction) {
  return `${actionButtonLabel(action)} to this message`;
}

function initials(value: string) {
  return value
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

