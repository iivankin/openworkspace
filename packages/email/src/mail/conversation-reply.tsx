import {
  Badge,
  Button,
  useConfirm,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@open-workspace/core/ui";
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
import { useImperativeHandle, useMemo, useState } from "react";
import type { Ref } from "react";
import { toast } from "sonner";

import { normalizeExternalEmailAddress } from "../../shared/mail";
import { ComposerAttachmentList } from "./composer-attachment-list";
import { ComposerEditor } from "./composer-editor";
import type { ComposerContent } from "./composer-editor";
import {
  recipientAddresses,
  recipientField,
  validateComposerRecipients,
} from "./composer-recipients";
import type { RecipientFieldValue } from "./composer-recipients";
import { notifyOutboundResult } from "./outbound-notification";
import { RecipientCombobox } from "./recipient-combobox";
import { ReplyToWarning } from "./reply-to-warning";
import type {
  Mailbox,
  MessageDetail,
  ReplyAction,
  ReplyActionMode,
} from "./types";
import { useComposerAttachmentPreflight } from "./use-composer-attachment-preflight";
import { useComposerCore } from "./use-composer-core";
import {
  hasAuthoredContent,
  useComposerSubmission,
} from "./use-composer-submission";
import { newDraftId, useDraftAutosave } from "./use-drafts";
import type { DraftContent, SavedDraft } from "./use-drafts";
import type { SubmittedMessage } from "./use-mail-send";

export type SentReply = Pick<SubmittedMessage, "conversationId" | "detached">;

/** What the conversation asks the open reply box before replacing it. */
export type ReplyHandle = {
  /** Something was written: replacing the reply would lose it. */
  hasContent: () => boolean;
  /** Stops saving and deletes its draft. */
  discard: () => Promise<void>;
};

const EMPTY_RECIPIENT_FIELD: RecipientFieldValue = {
  recipients: [],
  input: "",
};

function recipientAddressSet(value: RecipientFieldValue) {
  return new Set(recipientAddresses(value).map(normalizeExternalEmailAddress));
}

export function ConversationReply({
  mailbox,
  parent,
  mode,
  onModeChange,
  onCancel,
  onSent,
  draft,
  ref,
}: {
  mailbox?: Mailbox;
  parent: MessageDetail;
  mode: ReplyActionMode;
  onModeChange: (mode: ReplyActionMode) => void;
  onCancel: () => void;
  onSent: (result: SentReply) => void;
  /** A saved reply to this message to reopen. */
  draft?: SavedDraft;
  ref?: Ref<ReplyHandle>;
}) {
  const initialAction = findAction(parent, mode);
  const fieldsSource = `${mode}\0${parent.id}`;

  const core = useComposerCore({ mailbox, draft, signature: "reply" });

  const {
    session,
    snapshot,
    editor,
    activeAssets,
    dropProps,
    addFiles,
    attachmentError,
    attachmentListProps,
    content: reportedContent,
    editorProps,
    fileInput,
    form,
    holdsOnlyOpening,
    inlineFileInput,
    keptAttachments,
    limitError,
    readContent,
    uploadsError,
    uploadsFailed,
    uploadsPending,
  } = core;

  const initialCc = draft?.cc ?? initialAction?.cc ?? [];
  const [cc, setCc] = useState(() => recipientField(initialCc));

  const [bcc, setBcc] = useState<RecipientFieldValue>(() =>
    recipientField(draft?.bcc ?? [])
  );

  const [showCc, setShowCc] = useState(initialCc.length > 0);
  const [showBcc, setShowBcc] = useState(Boolean(draft?.bcc.length));
  const [ccSource, setCcSource] = useState(fieldsSource);

  // Another reply mode or parent message resets Cc to its own; adjusted
  // while rendering, so the old Cc never shows with the new reply.
  if (ccSource !== fieldsSource) {
    setCcSource(fieldsSource);
    setCc(recipientField(initialAction?.cc ?? []));
    setShowCc(Boolean(initialAction?.cc.length));
  }

  const action = useMemo(() => findAction(parent, mode), [mode, parent]);

  const recipients = validateComposerRecipients({
    to: recipientField(action?.to ?? []),
    cc,
    bcc,
  });

  const preflightContext = (content: ComposerContent) => ({
    kind: "reply" as const,
    mailboxId: mailbox?.id ?? "",
    sourceEmailId: parent.id,
    mode: action?.mode ?? mode,
    cc: recipients.cc,
    bcc: recipients.bcc,
    bodyText: content.bodyText,
    bodyHtml: content.bodyHtml || undefined,
  });

  useComposerAttachmentPreflight(
    session,
    preflightContext(reportedContent),
    activeAssets,
    snapshot.phase === "editing" && Boolean(mailbox && action)
  );

  // One id for the reply box's lifetime: created once, never replaced.
  // oxlint-disable-next-line react/hook-use-state -- the lazy initializer keeps one id; there is nothing to set
  const [draftId] = useState(() => draft?.id ?? newDraftId());

  const draftContent = (
    body: ComposerContent,
    attachments: DraftContent["attachments"]
  ): DraftContent => ({
    kind: "reply",
    sourceEmailId: parent.id,
    conversationId: parent.conversationId,
    replyMode: action?.mode ?? mode,
    // Shown in the drafts list; sending works out the recipients again.
    to: action?.to ?? [],
    cc: recipientAddresses(cc),
    bcc: recipientAddresses(bcc),
    replyTo: null,
    subject: parent.subject,
    bodyText: body.bodyText,
    bodyHtml: body.bodyHtml || null,
    // The editor's HTML, so the reopened editor puts the files back in place.
    editorHtml: body.editorHtml || null,
    attachments,
    storedImages: body.storedImages,
  });

  // A reopened draft already exists, so it is never blank.
  const blank = (saved: Pick<DraftContent, "bodyText" | "attachments">) =>
    !draft && holdsOnlyOpening(saved);

  const autosave = useDraftAutosave({
    mailboxId: mailbox?.id ?? "",
    session,
    draftId,
    restored: draft,
    content: draftContent(reportedContent, keptAttachments()),
    current: () => draftContent(readContent(), keptAttachments()),
    blank,
    editing:
      snapshot.phase === "editing" && Boolean(mailbox?.canSend && action),
  });

  const submission = useComposerSubmission({
    session,
    phase: snapshot.phase,
    editor,
    validate: () =>
      !mailbox?.canSend || !action
        ? "Reply is no longer available"
        : (recipients.error ?? uploadsError),
    missingText: (content) =>
      hasAuthoredContent(content) &&
      !blank({
        bodyText: content.bodyText,
        attachments: keptAttachments(),
      })
        ? null
        : "Add text to the reply before sending",
    context: preflightContext,
    command: (content, uploadedAttachments) => ({
      kind: "reply",
      mailboxId: mailbox?.id ?? "",
      cc: recipients.cc,
      bcc: recipients.bcc,
      bodyText: content.bodyText,
      bodyHtml: content.bodyHtml,
      uploadedAttachments,
      storedImages: content.storedImages,
      parentEmailId: parent.id,
      mode: action?.mode ?? mode,
      draftId: autosave.draftId,
    }),
    failureLabel: "Could not send reply",
    onSuccess: (result) => {
      notifyOutboundResult(result, "reply");
      autosave.sent();
      setBcc(EMPTY_RECIPIENT_FIELD);
      onSent({
        conversationId: result.conversationId,
        detached: result.detached,
      });
    },
  });

  // What the reply holds right now, not as of the editor's last report.
  const holdsNothing = () =>
    blank({
      bodyText: readContent().bodyText,
      attachments: keptAttachments(),
    });

  useImperativeHandle(ref, () => ({
    hasContent: () => !holdsNothing(),
    discard: autosave.discard,
  }));

  const { busy } = submission;
  const { confirm, dialog: confirmDialog } = useConfirm();

  const toAddresses = new Set(
    (action?.to ?? []).map(normalizeExternalEmailAddress)
  );

  const ccExcludedAddresses = new Set([
    ...toAddresses,
    ...recipientAddressSet(bcc),
  ]);

  const bccExcludedAddresses = new Set([
    ...toAddresses,
    ...recipientAddressSet(cc),
  ]);

  if (!mailbox?.canSend || !action || action.to.length === 0) return null;

  function selectAction(next: ReplyAction) {
    onModeChange(next.mode);
    setCc(recipientField(next.cc));
    setShowCc(next.cc.length > 0);
  }

  async function cancel() {
    if (
      !holdsNothing() &&
      !(await confirm({
        title: "Discard this reply?",
        description:
          activeAssets.length > 0
            ? "The text you wrote and its attachments are deleted."
            : "The text you wrote is deleted.",
        action: "Discard reply",
        destructive: true,
      }))
    ) {
      return;
    }

    try {
      await autosave.discard();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not discard the draft"
      );

      return;
    }

    onCancel();
  }

  return (
    <div>
      {confirmDialog}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- files can be dropped anywhere on the form */}
      <form
        ref={form}
        className="animate-rise border-input bg-surface focus-within:border-ring/60 focus-within:ring-ring/12 overflow-hidden rounded-lg border shadow-sm transition-shadow focus-within:ring-3"
        aria-busy={busy}
        onDragEnter={dropProps.onDragEnter}
        onDragOver={dropProps.onDragOver}
        onDragLeave={dropProps.onDragLeave}
        onDragEnd={dropProps.onDragEnd}
        onDrop={dropProps.onDrop}
        onSubmit={(event) => {
          event.preventDefault();
          void submission.submit();
        }}
      >
        <div className="border-border flex min-h-10 items-center gap-2 border-b px-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2"
                  disabled={busy}
                />
              }
            >
              <ReplyActionIcon mode={action.mode} />
              {action.label}
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-80 max-w-[calc(100vw-2rem)]"
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  Recipients from this message
                </DropdownMenuLabel>
                {parent.replyPlan.actions.map((candidate) => (
                  <DropdownMenuItem
                    key={candidate.mode}
                    disabled={busy}
                    onClick={() => selectAction(candidate)}
                  >
                    <ReplyActionIcon mode={candidate.mode} />
                    <span className="min-w-0 flex-1">
                      <span className="block">{candidate.label}</span>
                      <span className="text-muted-foreground block truncate text-xs">
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
            {!showCc && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={busy}
                onClick={() => setShowCc(true)}
              >
                Cc
              </Button>
            )}
            {!showBcc && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground"
                disabled={busy}
                onClick={() => setShowBcc(true)}
              >
                Bcc
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground ml-1"
              aria-label="Discard reply"
              disabled={busy}
              onClick={cancel}
            >
              <X />
            </Button>
          </div>
        </div>

        <div className="border-border text-muted-foreground truncate border-b px-3.5 py-2 text-xs">
          Replying to{" "}
          <span className="text-foreground font-semibold">
            {parent.fromName || parent.fromAddress}
          </span>
          <span aria-hidden="true"> · </span>
          {parent.preview}
        </div>
        <ReplyToWarning
          message={parent}
          recipients={[...recipients.to, ...recipients.cc, ...recipients.bcc]}
          className="border-border border-b"
        />

        {showCc && (
          <div className="border-border border-b px-3">
            <RecipientCombobox
              mailboxId={mailbox.id}
              label="Cc"
              value={cc}
              excludedAddresses={ccExcludedAddresses}
              disabled={busy}
              onChange={setCc}
            />
          </div>
        )}
        {showBcc && (
          <div className="border-border border-b px-3">
            <RecipientCombobox
              mailboxId={mailbox.id}
              label="Bcc"
              value={bcc}
              excludedAddresses={bccExcludedAddresses}
              disabled={busy}
              onChange={setBcc}
            />
          </div>
        )}

        <div className="flex h-64 flex-col">
          <ComposerEditor
            ref={editor}
            {...editorProps}
            label="Reply"
            placeholder={
              action.mode === "reply_all"
                ? "Reply to everyone"
                : `Reply to ${action.to.join(", ")}`
            }
          />
        </div>
        <div className="border-border text-muted-foreground flex items-center gap-2 border-t px-2 py-1.5 text-sm">
          <input
            ref={fileInput}
            className="sr-only"
            type="file"
            multiple
            disabled={busy}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []), "attachment");
              event.target.value = "";
            }}
          />
          <input
            ref={inlineFileInput}
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            tabIndex={-1}
            aria-hidden
            disabled={busy}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []), "inline");
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip />
            <span className="sr-only">Add attachments</span>
          </Button>
          <span
            className={cn(
              "min-w-0 flex-1 text-xs",
              attachmentError && "text-destructive"
            )}
          >
            {attachmentError ??
              (activeAssets.length ? (
                `${activeAssets.length} attachment${activeAssets.length === 1 ? "" : "s"}`
              ) : (
                <span className="hidden sm:inline">Ctrl + Enter to send</span>
              ))}
          </span>
          <Button
            type="submit"
            size="sm"
            disabled={
              busy || Boolean(limitError) || uploadsPending || uploadsFailed
            }
          >
            {busy ? <LoaderCircle className="animate-spin" /> : <Send />}
            Send
          </Button>
        </div>

        <ComposerAttachmentList {...attachmentListProps} />
      </form>
    </div>
  );
}

/** The plan's action for the mode, else its default; none for an empty plan. */
function findAction(parent: MessageDetail, requestedMode: ReplyActionMode) {
  return (
    parent.replyPlan.actions.find((action) => action.mode === requestedMode) ??
    parent.replyPlan.actions.find(
      (action) => action.mode === parent.replyPlan.defaultMode
    ) ??
    parent.replyPlan.actions[0]
  );
}

export function ReplyActionIcon({ mode }: { mode: ReplyActionMode }) {
  if (mode === "reply_all") return <ReplyAll />;

  if (mode === "reply_list") return <Users />;

  if (mode === "continue") return <Send />;

  return <Reply />;
}
