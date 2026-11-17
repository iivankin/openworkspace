import { useAuth } from "@open-workspace/core/ui";
import { useLayoutEffect, useRef, useState } from "react";
import type { DragEvent } from "react";

import type { ComposerContent, ComposerEditorHandle } from "./composer-editor";
import { isComposerSessionBusy, useComposerSession } from "./composer-session";
import type { ComposerAsset, ComposerAssetIntent } from "./composer-session";
import { isInlineComposerImage } from "./composer-upload-client";
import {
  draftAttachments,
  holdsOnlyInitialContent,
  openingText,
  restoredComposerAssets,
  restoredDraftContent,
  restoredDraftHtml,
} from "./draft-attachments";
import { messageSignatureHtml } from "./signature";
import type { Mailbox } from "./types";
import type { DraftContent, SavedDraft } from "./use-drafts";

const EMPTY_CONTENT: ComposerContent = {
  bodyHtml: "",
  editorHtml: "",
  bodyText: "",
  inlineAssetIds: [],
  storedImages: [],
  linkedAssetIds: [],
};

const NO_ASSETS: ComposerAsset[] = [];

/** What a composer opens with, worked out once. */
function opening(input: {
  mailbox: Mailbox | undefined;
  draft: SavedDraft | undefined;
  signature: "new" | "reply";
  userName: string;
}) {
  const { draft, mailbox } = input;

  if (draft) {
    const html = restoredDraftHtml(draft);
    const assets = restoredComposerAssets(mailbox?.id ?? "", draft, html);

    return {
      html,
      assets,
      content: restoredDraftContent(draft, html, assets),
    };
  }

  // The signature that applies, as editable content, added once: a reopened
  // draft already holds it, so it never gets a second one.
  return {
    html: mailbox
      ? messageSignatureHtml(mailbox, input.signature, input.userName)
      : "",
    assets: NO_ASSETS,
    content: EMPTY_CONTENT,
  };
}

/**
 * What the compose window and the reply box share: the upload session, the
 * editor and what it holds, adding and removing files, and dropping them
 * anywhere on the form.
 *
 * The files a message holds are the ones its document refers to
 * (ComposerSession.documentAssetIds); attachments are bookmarked in the
 * document like inline images, so undo brings both back.
 */
export function useComposerCore(input: {
  mailbox: Mailbox | undefined;
  /** A saved draft to reopen. */
  draft: SavedDraft | undefined;
  /** Which of the mailbox's signatures a new message opens with. */
  signature: "new" | "reply";
  /** Files that go with the message without being uploaded, e.g. a forward's. */
  reservedAssets?: readonly { size: number }[];
}) {
  const editor = useRef<ComposerEditorHandle>(null);
  const form = useRef<HTMLFormElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inlineFileInput = useRef<HTMLInputElement>(null);
  const { user } = useAuth();

  // oxlint-disable-next-line react/hook-use-state -- read once, when the editor is created; nothing sets it
  const [start] = useState(() =>
    opening({ ...input, userName: user?.name ?? "" })
  );

  // The text the editor opened with: a new composer still holding just that
  // (its signature) is untouched and creates no draft.
  // oxlint-disable-next-line react/hook-use-state -- read once; nothing sets it
  const [initialText] = useState(() => openingText(start.html));

  // Changes only as the person edits (the editor reports after a pause).
  const [content, setContent] = useState(start.content);

  const { session, snapshot } = useComposerSession(
    input.mailbox?.id ?? "",
    input.reservedAssets,
    start.assets
  );

  // The editor handle as last rendered: an unmounting composer's last save
  // still reads it after React has cleared `editor`.
  const lastEditor = useRef<ComposerEditorHandle | null>(null);
  useLayoutEffect(() => {
    if (editor.current) lastEditor.current = editor.current;
  });

  const activeAssets = snapshot.assets.filter((asset) =>
    snapshot.documentAssetIds.has(asset.id)
  );

  const [dragging, setDragging] = useState(false);

  /** What the editor holds right now. */
  function readContent() {
    try {
      return (editor.current ?? lastEditor.current)?.content() ?? content;
    } catch {
      // The editor was already destroyed.
      return content;
    }
  }

  function addFiles(
    files: File[],
    intent: ComposerAssetIntent,
    position?: number
  ) {
    const assets = session.addFiles(files, intent);

    if (assets) editor.current?.insertAssets(assets, position);
  }

  /** Images go into the text; other files attach. */
  function addDroppedFiles(files: File[], position?: number) {
    const images = files.filter(isInlineComposerImage);
    const others = files.filter((file) => !isInlineComposerImage(file));

    if (images.length) addFiles(images, "inline", position);

    if (others.length) addFiles(others, "attachment", position);
  }

  function removeAsset(asset: ComposerAsset) {
    if (editor.current?.removeAsset(asset.id)) return;
    session.remove(asset.id);
  }

  const busy = isComposerSessionBusy(snapshot.phase);

  const limitError = session.limitError();

  const uploadsPending = activeAssets.some(
    (asset) => asset.status === "uploading"
  );

  const uploadsFailed = activeAssets.some((asset) => asset.status === "error");

  return {
    editor,
    form,
    fileInput,
    inlineFileInput,
    session,
    snapshot,
    content,
    /** The person changed the body (a reopened draft counts as written). */
    edited: content !== EMPTY_CONTENT,
    readContent,
    activeAssets,
    limitError,
    uploadsPending,
    uploadsFailed,
    /** Why the message's files keep it from being sent, if they do. */
    uploadsError:
      limitError ??
      (uploadsPending
        ? "Wait for attachments to finish uploading"
        : uploadsFailed
          ? "Retry or remove failed attachments"
          : null),
    /** The status line under the editor's files: a limit, or a failed delivery check. */
    attachmentError:
      limitError ??
      (activeAssets.length > 0 && snapshot.planError
        ? "Could not check attachment delivery"
        : null),
    /** The finished uploads a draft keeps, as of now. */
    keptAttachments: () => draftAttachments(session.documentAssets()),
    /** The draft holds nothing but what the composer opened with. */
    holdsOnlyOpening: (draft: Pick<DraftContent, "bodyText" | "attachments">) =>
      holdsOnlyInitialContent(draft, initialText),
    addFiles,
    removeAsset,
    /** Props for the composer's editor. */
    editorProps: {
      session,
      initialHtml: start.html,
      onChange: setContent,
      onAssetsChange: session.setDocumentAssetIds,
      onAddInlineFiles: (files: File[], position?: number) =>
        addFiles(files, "inline", position),
      onAddAttachmentFiles: (files: File[], position?: number) =>
        addFiles(files, "attachment", position),
      onChooseInlineImage: () => inlineFileInput.current?.click(),
      onSubmitShortcut: () => form.current?.requestSubmit(),
      dragging: dragging && !busy,
      disabled: busy,
    },
    /** Props for the composer's list of files below the editor. */
    attachmentListProps: {
      // Uploaded files sent as links show as cards in the text instead.
      uploads: activeAssets.filter(
        (asset) =>
          !snapshot.linkedAssetIds.has(asset.id) || asset.status !== "uploaded"
      ),
      linkedIds: snapshot.linkedAssetIds,
      progress: session.progress,
      disabled: busy,
      onRemove: removeAsset,
      onRetry: (asset: ComposerAsset) => void session.retry(asset.id),
    },
    /** The form's drag and drop: files dropped anywhere on it are added. */
    dropProps: {
      onDragEnter: (event: DragEvent<HTMLFormElement>) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();

        if (!busy) setDragging(true);
      },
      onDragOver: (event: DragEvent<HTMLFormElement>) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = busy ? "none" : "copy";
      },
      onDragLeave: (event: DragEvent<HTMLFormElement>) => {
        if (
          !(
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          )
        ) {
          setDragging(false);
        }
      },
      onDragEnd: () => setDragging(false),
      onDrop: (event: DragEvent<HTMLFormElement>) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);

        if (busy) return;

        // The editor takes files dropped on the text itself, where they
        // fall; the form, files dropped anywhere else.
        if (
          event.target instanceof Element &&
          event.target.closest("[data-composer-editor-content]")
        ) {
          return;
        }

        addDroppedFiles(Array.from(event.dataTransfer.files));
      },
    },
  };
}
