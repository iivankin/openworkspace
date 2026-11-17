import { ApiError } from "@open-workspace/core/ui";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { toast } from "sonner";

import type { ComposerContent, ComposerEditorHandle } from "./composer-editor";
import { isComposerSessionBusy, isUploadedAsset } from "./composer-session";
import type { ComposerSession, ComposerSessionPhase } from "./composer-session";
import { resolveComposerAttachmentPlan } from "./use-composer-attachment-preflight";
import type { PreflightContext } from "./use-composer-attachment-preflight";
import { useMailSend, withMailSendRequestId } from "./use-mail-send";
import type { MailSendDraft, SubmittedMessage } from "./use-mail-send";

type UploadedAttachment = NonNullable<
  MailSendDraft["uploadedAttachments"]
>[number];

/** Whether the body holds something the person wrote or added. */
export function hasAuthoredContent(content: ComposerContent) {
  return Boolean(
    content.bodyText.trim() ||
    content.inlineAssetIds.length ||
    content.storedImages.length
  );
}

/**
 * The body and files a message sends. With files, the delivery plan is
 * settled first (which go as links), and the body is read again with the
 * link cards that plan chose, so what is sent is what the person sees.
 */
async function settledMessage(
  session: ComposerSession,
  editor: ComposerEditorHandle,
  context: (content: ComposerContent) => PreflightContext,
  signal: AbortSignal
) {
  let content = editor.content();
  const assets = session.documentAssets();

  if (assets.length) {
    await resolveComposerAttachmentPlan(
      session,
      context(content),
      assets,
      signal
    );
    editor.reconcileAssets();
    content = editor.content();
  }

  const linked = new Set(content.linkedAssetIds);
  const submitted = session.documentAssets().filter(isUploadedAsset);

  const uploadedAttachments: UploadedAttachment[] = submitted.map((asset) => {
    // A linked inline image goes as a plain attachment, without its content ID.
    const linkedInline = asset.intent === "inline" && linked.has(asset.id);

    return {
      uploadId: asset.uploadId,
      disposition: linkedInline ? "attachment" : asset.intent,
      // JSON leaves an undefined one out.
      contentId: (!linkedInline && asset.contentId) || undefined,
    };
  });

  return {
    content,
    assetIds: submitted.map((asset) => asset.id),
    uploadedAttachments,
  };
}

/**
 * Sends a composer's message: checks it, settles its files' delivery, sends
 * it once (retries of the same message reuse its request id), and hands the
 * uploads to the Worker or back to the composer.
 */
export function useComposerSubmission(input: {
  session: ComposerSession;
  phase: ComposerSessionPhase;
  editor: RefObject<ComposerEditorHandle | null>;
  /** Why the message can't be sent as it is, if it can't. */
  validate: () => string | null;
  /** Why the body can't be sent as it is (nothing written), if it can't. */
  missingText: (content: ComposerContent) => string | null;
  context: (content: ComposerContent) => PreflightContext;
  command: (
    content: ComposerContent,
    uploadedAttachments: UploadedAttachment[]
  ) => MailSendDraft;
  failureLabel: string;
  onSuccess: (result: SubmittedMessage) => void;
}) {
  const { send } = useMailSend();
  const mounted = useRef(true);
  const preflightRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
      preflightRequest.current?.abort();
    };
  }, []);

  async function prepare(signal: AbortSignal) {
    const editor = input.editor.current;

    if (!editor) throw new Error(input.failureLabel);

    const message = await settledMessage(
      input.session,
      editor,
      input.context,
      signal
    );

    const error = input.missingText(message.content);

    if (error) throw new Error(error);
    const command = input.command(message.content, message.uploadedAttachments);

    return {
      assetIds: message.assetIds,
      command,
      submissionKey: JSON.stringify(command),
    };
  }

  async function submit() {
    const content = input.editor.current?.content();

    const validationError =
      input.validate() ??
      (content ? input.missingText(content) : input.failureLabel);

    if (validationError) {
      toast.error(validationError);

      return;
    }

    if (!input.session.beginPreflight()) return;

    const controller = new AbortController();
    preflightRequest.current = controller;

    const preparation = await prepare(controller.signal).then(
      (prepared) => ({ prepared }),
      (cause: unknown) => ({ cause })
    );

    if (preflightRequest.current === controller) {
      preflightRequest.current = null;
    }

    if ("cause" in preparation) {
      if (!controller.signal.aborted) input.session.cancelPreflight();

      if (controller.signal.aborted || !mounted.current) return;
      const { cause } = preparation;
      toast.error(cause instanceof Error ? cause.message : input.failureLabel);

      return;
    }

    const { prepared } = preparation;

    if (controller.signal.aborted || !mounted.current) {
      input.session.cancelPreflight();

      return;
    }

    const requestId = input.session.beginSubmission(
      prepared.assetIds,
      prepared.submissionKey
    );

    if (!requestId) return;

    let result: SubmittedMessage;

    try {
      result = await send.mutateAsync(
        withMailSendRequestId(prepared.command, requestId)
      );
    } catch (error) {
      // The continuation can outlive React after a mailbox switch. Session
      // ownership still has to be released even when no UI remains.
      input.session.releaseSubmission(
        !(error instanceof ApiError) || error.status >= 500
      );

      if (!mounted.current) return;
      toast.error(error instanceof Error ? error.message : input.failureLabel);

      return;
    }

    input.session.completeSubmission();

    if (mounted.current) input.onSuccess(result);
  }

  return {
    busy: isComposerSessionBusy(input.phase),
    submit,
  };
}
