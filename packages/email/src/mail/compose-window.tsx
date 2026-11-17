import { useConfirm } from "@open-workspace/core/ui";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { RefObject } from "react";
import { toast } from "sonner";

import { forwardSubject } from "../../shared/mail";
import {
  ComposeWindowFooter,
  ComposeWindowHeader,
  ForwardedMessageNotice,
  MinimizedComposer,
} from "./compose-window-chrome";
import { ComposerAttachmentList } from "./composer-attachment-list";
import { ComposerEditor } from "./composer-editor";
import type { ComposerContent } from "./composer-editor";
import { ComposerRecipientFields } from "./composer-recipient-fields";
import {
  recipientAddresses,
  recipientField,
  validateComposerRecipients,
} from "./composer-recipients";
import type { RecipientFieldValue } from "./composer-recipients";
import { notifyOutboundResult } from "./outbound-notification";
import { ReplyToWarning } from "./reply-to-warning";
import type { Mailbox, MessageDetail } from "./types";
import { useComposerAttachmentPreflight } from "./use-composer-attachment-preflight";
import { useComposerCore } from "./use-composer-core";
import {
  hasAuthoredContent,
  useComposerSubmission,
} from "./use-composer-submission";
import { useDraftAutosave } from "./use-drafts";
import type { DraftContent, SavedDraft } from "./use-drafts";

const EMPTY_RECIPIENT_FIELD: RecipientFieldValue = {
  recipients: [],
  input: "",
};

/** Below Tailwind's `sm`, the composer covers the screen. */
const PHONE_QUERY = "(max-width: 639.98px)";

function usePhoneLayout() {
  return useSyncExternalStore(
    (onChange) => {
      const media = matchMedia(PHONE_QUERY);
      media.addEventListener("change", onChange);

      return () => media.removeEventListener("change", onChange);
    },
    () => matchMedia(PHONE_QUERY).matches,
    () => false
  );
}

/**
 * Makes everything outside `element` inert: each sibling of the element and
 * of its ancestors up to <body>. Returns the undo. Elements that were inert
 * already are left alone.
 */
function inertOutside(element: HTMLElement) {
  const changed: HTMLElement[] = [];

  for (
    let node: HTMLElement | null = element;
    node && node !== document.body;
    node = node.parentElement
  ) {
    for (const sibling of node.parentElement?.children ?? []) {
      if (
        sibling === node ||
        !(sibling instanceof HTMLElement) ||
        sibling.inert
      ) {
        continue;
      }

      if (
        sibling instanceof HTMLScriptElement ||
        sibling instanceof HTMLStyleElement
      ) {
        continue;
      }

      sibling.inert = true;
      changed.push(sibling);
    }
  }

  return () => {
    for (const sibling of changed) sibling.inert = false;
  };
}

/**
 * On a phone the composer is a full-screen modal: the page behind is inert,
 * focus starts inside, Escape closes it (unless a list or popup inside is
 * open and takes the key), and focus goes back to what opened it. The
 * floating desktop window stays non-modal.
 */
function useFullScreenComposer(
  section: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape: () => void
) {
  const escape = useEffectEvent(onEscape);
  // What had focus before the composer opened, to go back to when it closes.
  const opener = useRef(document.activeElement);
  useEffect(() => {
    const element = section.current;

    if (!active || !element) return;
    const undo = inertOutside(element);

    if (!element.contains(document.activeElement)) element.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;

      if (
        event.target instanceof Element &&
        event.target.closest('[aria-expanded="true"]')
      ) {
        return;
      }

      event.preventDefault();
      escape();
    };

    element.addEventListener("keydown", onKeyDown);

    return () => {
      element.removeEventListener("keydown", onKeyDown);
      undo();
      // Once the composer is gone, focus would fall to <body>.
      const { current: returnTo } = opener;

      requestAnimationFrame(() => {
        const current = document.activeElement;

        if (
          (!current || current === document.body) &&
          returnTo instanceof HTMLElement &&
          returnTo.isConnected
        ) {
          returnTo.focus();
        }
      });
    };
  }, [section, active]);
}

export function ComposeWindow({
  mailbox,
  forwardedMessage,
  draft,
  draftId,
  onSaved,
  onClose,
}: {
  mailbox: Mailbox;
  forwardedMessage?: Pick<
    MessageDetail,
    | "id"
    | "subject"
    | "fromAddress"
    | "fromName"
    | "preview"
    | "attachments"
    | "security"
    | "conversationId"
  >;
  /** A saved draft to reopen. */
  draft?: SavedDraft;
  /** The id this composer's draft is saved under. */
  draftId: string;
  /** The draft was first saved. */
  onSaved: (draftId: string) => void;
  onClose: () => void;
}) {
  const [to, setTo] = useState<RecipientFieldValue>(() =>
    draft ? recipientField(draft.to) : EMPTY_RECIPIENT_FIELD
  );

  const [cc, setCc] = useState<RecipientFieldValue>(() =>
    draft ? recipientField(draft.cc) : EMPTY_RECIPIENT_FIELD
  );

  const [bcc, setBcc] = useState<RecipientFieldValue>(() =>
    draft ? recipientField(draft.bcc) : EMPTY_RECIPIENT_FIELD
  );

  const [replyTo, setReplyTo] = useState(draft?.replyTo ?? "");

  const [subject, setSubject] = useState(
    () =>
      draft?.subject ??
      (forwardedMessage ? forwardSubject(forwardedMessage.subject) : "")
  );

  const [minimized, setMinimized] = useState(false);
  const section = useRef<HTMLElement>(null);
  const minimizeButton = useRef<HTMLButtonElement>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  // Minimizing moves focus to Restore, and restoring back to Minimize.
  const focusAfterToggle = useRef(false);
  const phone = usePhoneLayout();

  const core = useComposerCore({
    mailbox,
    draft,
    signature: forwardedMessage ? "reply" : "new",
    reservedAssets: forwardedMessage?.attachments,
  });

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

  const recipients = validateComposerRecipients({
    to,
    cc,
    bcc,
    replyTo,
  });

  const preflightContext = (content: ComposerContent) =>
    forwardedMessage
      ? {
          kind: "forward" as const,
          mailboxId: mailbox.id,
          sourceEmailId: forwardedMessage.id,
          bodyText: content.bodyText,
          bodyHtml: content.bodyHtml || undefined,
        }
      : {
          kind: "compose" as const,
          mailboxId: mailbox.id,
          subject,
          bodyText: content.bodyText,
          bodyHtml: content.bodyHtml || undefined,
        };

  useComposerAttachmentPreflight(
    session,
    preflightContext(reportedContent),
    activeAssets,
    snapshot.phase === "editing"
  );

  const draftContent = (
    body: ComposerContent,
    attachments: DraftContent["attachments"]
  ): DraftContent => ({
    kind: forwardedMessage ? "forward" : "compose",
    sourceEmailId: forwardedMessage?.id ?? null,
    conversationId: forwardedMessage?.conversationId ?? null,
    to: recipientAddresses(to),
    cc: recipientAddresses(cc),
    bcc: recipientAddresses(bcc),
    replyTo: replyTo.trim() || null,
    subject,
    bodyText: body.bodyText,
    bodyHtml: body.bodyHtml,
    // The editor's HTML, so the reopened editor puts the files back in place.
    editorHtml: body.editorHtml,
    attachments,
    storedImages: body.storedImages,
  });

  // The body holds only what it opened with (e.g. the signature), no files.
  const untouched = (saved: Pick<DraftContent, "bodyText" | "attachments">) =>
    !draft && holdsOnlyOpening(saved);

  const autosave = useDraftAutosave({
    mailboxId: mailbox.id,
    session,
    draftId,
    restored: draft,
    content: draftContent(reportedContent, keptAttachments()),
    current: () => draftContent(readContent(), keptAttachments()),
    blank: (saved) =>
      !recipientAddresses(to).length &&
      !recipientAddresses(cc).length &&
      !recipientAddresses(bcc).length &&
      (Boolean(forwardedMessage) || !subject.trim()) &&
      untouched(saved),
    editing: snapshot.phase === "editing" && mailbox.canSend,
    onSaved,
  });

  const submission = useComposerSubmission({
    session,
    phase: snapshot.phase,
    editor,
    validate: () => {
      if (recipients.error) return recipients.error;

      if (recipients.count === 0) {
        return "Add at least one recipient in To, Cc, or Bcc";
      }

      return (
        uploadsError ?? (mailbox.canSend ? null : "This mailbox is read-only")
      );
    },
    // A forward can go without a note.
    missingText: (content) =>
      forwardedMessage ||
      (hasAuthoredContent(content) &&
        !untouched({
          bodyText: content.bodyText,
          attachments: keptAttachments(),
        }))
        ? null
        : "Add text to the message before sending",
    context: preflightContext,
    command: (content, uploadedAttachments) => {
      const common = {
        mailboxId: mailbox.id,
        bodyText: content.bodyText,
        bodyHtml:
          content.bodyText.trim() ||
          content.inlineAssetIds.length ||
          content.linkedAssetIds.length ||
          content.storedImages.length
            ? content.bodyHtml
            : undefined,
        uploadedAttachments,
        storedImages: content.storedImages,
        draftId: autosave.draftId,
        to: recipients.to,
        cc: recipients.cc,
        bcc: recipients.bcc,
        replyTo: recipients.replyTo,
      };

      return forwardedMessage
        ? { ...common, kind: "forward", sourceEmailId: forwardedMessage.id }
        : { ...common, kind: "compose", subject };
    },
    failureLabel: "Could not send message",
    onSuccess: (result) => {
      notifyOutboundResult(result, "message");
      // Sent: the server deleted the draft.
      autosave.sent();
      onClose();
    },
  });

  const { confirm, dialog: confirmDialog } = useConfirm();
  const { busy } = submission;

  function closeComposer() {
    if (busy) {
      toast.error("Wait for the message to finish sending");

      return;
    }

    // Saves what the editor holds now, not just what it last reported.
    autosave.flush();
    session.close();
    onClose();
  }

  async function discardDraft() {
    if (busy) return;

    if (
      !(await confirm({
        title: "Discard this draft?",
        description: "The message you wrote and its attachments are deleted.",
        action: "Discard draft",
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

    session.close();
    onClose();
  }

  function toggleMinimized(next: boolean) {
    focusAfterToggle.current = true;
    setMinimized(next);
  }

  useEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    (minimized ? restoreButton : minimizeButton).current?.focus();
  }, [minimized]);

  useFullScreenComposer(section, phone && !minimized, closeComposer);

  if (minimized) {
    return (
      <MinimizedComposer
        subject={subject}
        restoreRef={restoreButton}
        onRestore={() => toggleMinimized(false)}
        onClose={closeComposer}
      />
    );
  }

  return (
    <section
      ref={section}
      role="dialog"
      aria-label="New message"
      aria-modal={phone || undefined}
      tabIndex={-1}
      className="animate-rise bg-surface ring-border fixed inset-0 z-50 flex flex-col shadow-2xl ring-1 outline-none sm:inset-auto sm:right-6 sm:bottom-6 sm:h-[min(600px,calc(100dvh-3rem))] sm:w-[min(560px,calc(100vw-2.5rem))] sm:rounded-xl"
    >
      {confirmDialog}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- files can be dropped anywhere on the form */}
      <form
        ref={form}
        className="flex min-h-0 flex-1 flex-col"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submission.submit();
        }}
        onDragEnter={dropProps.onDragEnter}
        onDragOver={dropProps.onDragOver}
        onDragLeave={dropProps.onDragLeave}
        onDragEnd={dropProps.onDragEnd}
        onDrop={dropProps.onDrop}
      >
        <ComposeWindowHeader
          from={mailbox.address}
          minimizeRef={minimizeButton}
          onMinimize={() => toggleMinimized(true)}
          onDiscard={() => void discardDraft()}
          onClose={closeComposer}
        />

        <ComposerRecipientFields
          mailboxId={mailbox.id}
          to={to}
          cc={cc}
          bcc={bcc}
          replyTo={replyTo}
          subject={subject}
          subjectReadOnly={Boolean(forwardedMessage)}
          disabled={busy}
          onToChange={setTo}
          onCcChange={setCc}
          onBccChange={setBcc}
          onReplyToChange={setReplyTo}
          onSubjectChange={setSubject}
        />

        {forwardedMessage ? (
          <>
            <ForwardedMessageNotice message={forwardedMessage} />
            <ReplyToWarning
              message={forwardedMessage}
              recipients={[
                ...recipients.to,
                ...recipients.cc,
                ...recipients.bcc,
              ]}
            />
          </>
        ) : null}

        <ComposerEditor ref={editor} {...editorProps} />

        <ComposerAttachmentList {...attachmentListProps} />

        <ComposeWindowFooter
          fileInput={fileInput}
          inlineFileInput={inlineFileInput}
          uploads={activeAssets}
          error={attachmentError}
          sending={busy}
          sendDisabled={
            busy ||
            recipients.count === 0 ||
            !mailbox.canSend ||
            Boolean(limitError) ||
            uploadsPending ||
            uploadsFailed
          }
          onAddAttachments={(files) => addFiles(files, "attachment")}
          onAddInlineImages={(files) => addFiles(files, "inline")}
        />
      </form>
    </section>
  );
}
