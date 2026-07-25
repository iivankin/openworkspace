import {
  Check,
  ChevronDown,
  LoaderCircle,
  Paperclip,
  Reply,
  ReplyAll,
  Send,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { MAX_MAIL_RECIPIENTS } from "../../shared/mail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  dedupeRecipientInputs,
  parseRecipientInput,
  recipientInputCount,
} from "./recipient-input";
import { RecipientFieldRow } from "./recipient-field-row";
import { notifyOutboundResult } from "./outbound-notification";
import type {
  Mailbox,
  MessageDetail,
  ReplyAction,
  ReplyActionMode,
} from "./types";
import { useMailSend, type SubmittedMessage } from "./use-mail-send";

export type SentReply = Pick<SubmittedMessage, "conversationId" | "detached">;

export function ConversationReply({
  mailbox,
  parent,
  mode,
  onModeChange,
  onSent,
}: {
  mailbox?: Mailbox;
  parent: MessageDetail;
  mode: ReplyActionMode;
  onModeChange: (mode: ReplyActionMode) => void;
  onSent: (result: SentReply) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const initialAction = findAction(parent, mode);
  const [body, setBody] = useState("");
  const [cc, setCc] = useState(initialAction?.cc.join(", ") ?? "");
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(Boolean(initialAction?.cc.length));
  const [showBcc, setShowBcc] = useState(false);
  const { send, files, addFiles, removeFile } = useMailSend();
  const action = useMemo(
    () => findAction(parent, mode),
    [mode, parent],
  );
  useEffect(() => {
    const next = findAction(parent, mode);
    setCc(next.cc.join(", "));
    setShowCc(next.cc.length > 0);
  }, [mode, parent.id]);
  const recipients = dedupeRecipientInputs({
    to: action?.to ?? [],
    cc: parseRecipientInput(cc),
    bcc: parseRecipientInput(bcc),
  });

  if (!mailbox?.canSend || !action || action.to.length === 0) return null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (send.isPending) return;
    const recipientCount = recipientInputCount(recipients);
    if (recipientCount > MAX_MAIL_RECIPIENTS) {
      toast.error(`Use at most ${MAX_MAIL_RECIPIENTS} recipients across To, Cc, and Bcc`);
      return;
    }
    queueReply();
  }

  function selectAction(next: ReplyAction) {
    onModeChange(next.mode);
    setCc(next.cc.join(", "));
    setShowCc(next.cc.length > 0);
  }

  function queueReply() {
    if (!mailbox || !action) return;
    send.mutate({
      kind: "reply",
      mailboxId: mailbox.id,
      cc: recipients.cc,
      bcc: recipients.bcc,
      bodyText: body,
      parentEmailId: parent.id,
      mode: action.mode,
    }, {
      onSuccess: (result) => {
        notifyOutboundResult(result, "reply");
        setBody("");
        setBcc("");
        onSent({
          conversationId: result.conversationId,
          detached: result.detached,
        });
      },
      onError: (error) => toast.error(error.message),
    });
  }

  return (
    <div className="sticky bottom-16 z-20 -mx-3 bg-gradient-to-t from-background via-background to-transparent px-3 pt-10 pb-4 sm:-mx-6 sm:px-6 sm:pb-6 lg:bottom-0">
      <form className="mx-auto max-w-2xl animate-rise overflow-hidden rounded-2xl bg-surface shadow-xl ring-1 ring-border" onSubmit={submit}>
        <div className="flex min-h-11 items-center gap-2 border-b border-border/70 bg-surface-sunken/70 px-2.5">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" className="h-7 px-2" />}>
              <ReplyActionIcon mode={action.mode} />
              {action.label}
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Recipients from this message</DropdownMenuLabel>
                {parent.replyPlan.actions.map((candidate) => (
                  <DropdownMenuItem key={candidate.mode} onClick={() => selectAction(candidate)}>
                    <ReplyActionIcon mode={candidate.mode} />
                    <span className="min-w-0 flex-1">
                      <span className="block">{candidate.label}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[...candidate.to, ...candidate.cc].join(", ")}
                      </span>
                    </span>
                    {candidate.mode === mode && <Check />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {action.mode === "reply_all" && (
            <Badge variant="secondary">
              {recipients.to.length + recipients.cc.length} people
            </Badge>
          )}
          <div className="ml-auto flex items-center">
            <Button type="button" variant="ghost" size="xs" onClick={() => setShowCc(true)}>Cc</Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setShowBcc(true)}>Bcc</Button>
          </div>
        </div>

        <div className="truncate border-b border-border/70 px-3.5 py-2 text-xs text-muted-foreground">
          Replying to <span className="font-semibold text-foreground">{parent.fromName || parent.fromAddress}</span>
          <span aria-hidden="true"> · </span>{parent.preview}
        </div>

        {showCc && (
          <RecipientFieldRow compact label="Cc" value={cc} onChange={setCc} />
        )}
        {showBcc && (
          <RecipientFieldRow compact label="Bcc" value={bcc} onChange={setBcc} />
        )}

        <InputGroup className="min-h-24 rounded-none border-0 bg-transparent shadow-none dark:bg-transparent">
          <InputGroupTextarea
            className="min-h-16 px-4 pt-3.5 text-[0.9375rem] leading-[1.65]"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              if (
                !send.isPending
                && (event.metaKey || event.ctrlKey)
                && event.key === "Enter"
                && (body.trim() || files.length > 0)
              ) {
                event.preventDefault();
                queueReply();
              }
            }}
            placeholder={action.mode === "reply_all" ? "Reply to everyone" : `Reply to ${action.to.join(", ")}`}
          />
          <InputGroupAddon align="block-end" className="border-t border-border/70 bg-surface-sunken/40 px-2.5 py-2">
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
            <InputGroupButton size="icon-sm" onClick={() => fileInput.current?.click()}>
              <Paperclip /><span className="sr-only">Add attachments</span>
            </InputGroupButton>
            <InputGroupText className="min-w-0 flex-1 text-xs">
              {files.length ? `${files.length} attachment${files.length === 1 ? "" : "s"}` : "Ctrl + Enter to send"}
            </InputGroupText>
            <Button
              type="submit"
              size="sm"
              disabled={send.isPending || (!body.trim() && files.length === 0)}
            >
              {send.isPending ? <LoaderCircle className="animate-spin" /> : <Send />}
              Send
            </Button>
          </InputGroupAddon>
        </InputGroup>

        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t border-border/70 px-3 py-2.5">
            {files.map((file, index) => (
              <Badge key={`${file.name}-${index}`} variant="outline" className="max-w-56 gap-1.5">
                <Paperclip className="size-3" />
                <span className="truncate">{file.name}</span>
                <button type="button" onClick={() => removeFile(index)}>
                  <X className="size-3" /><span className="sr-only">Remove {file.name}</span>
                </button>
              </Badge>
            ))}
          </div>
        )}
      </form>
    </div>
  );
}

function findAction(parent: MessageDetail, requestedMode: ReplyActionMode) {
  return parent.replyPlan.actions.find((action) => action.mode === requestedMode)
    ?? parent.replyPlan.actions.find((action) => action.mode === parent.replyPlan.defaultMode)
    ?? parent.replyPlan.actions[0]!;
}

export function ReplyActionIcon({ mode }: { mode: ReplyActionMode }) {
  if (mode === "reply_all") return <ReplyAll />;
  if (mode === "reply_list") return <Users />;
  if (mode === "continue") return <Send />;
  return <Reply />;
}

