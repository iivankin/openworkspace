// Kept apart from use-drafts.ts, which loads the API client, so unit tests
// can import these.
import { EMAIL_SERVICE_MAX_BYTES } from "../../shared/mail";
import type { ComposerContent } from "./composer-editor-document";
import type { ComposerAsset } from "./composer-session";
import type { DraftContent, SavedDraft } from "./use-drafts";

/** The finished uploads a composer's draft keeps. */
export function draftAttachments(
  assets: readonly ComposerAsset[]
): NonNullable<DraftContent["attachments"]> {
  return assets.flatMap((asset) =>
    asset.status === "uploaded" && asset.uploadId
      ? [
          {
            assetId: asset.id,
            uploadId: asset.uploadId,
            disposition: asset.intent,
            // JSON leaves an undefined one out.
            contentId: asset.contentId ?? undefined,
          },
        ]
      : []
  );
}

/**
 * A reopened draft's files as composer assets, already uploaded: its
 * attachments, and the inline files its editor HTML (`html`, from
 * restoredDraftHtml) still shows. An inline file the HTML no longer refers
 * to, such as a copy of a signature image left out, isn't brought back.
 */
export function restoredComposerAssets(
  mailboxId: string,
  draft: Pick<SavedDraft, "attachments"> | undefined,
  html: string
): ComposerAsset[] {
  // The HTML is the browser's serialization, so the attribute reads this way.
  const shown = new Set(
    Array.from(
      html.matchAll(/data-composer-asset="([^"]+)"/gu),
      (match) => match[1]
    )
  );

  return (draft?.attachments ?? []).flatMap((file) =>
    file.disposition === "inline" && !shown.has(file.assetId)
      ? []
      : [
          {
            id: file.assetId,
            uploadId: file.uploadId,
            filename: file.filename,
            contentType: file.contentType,
            size: file.size,
            intent: file.disposition,
            contentId: file.contentId,
            // As for a new upload: an image too large to send inline becomes a link.
            previewUrl:
              file.disposition === "inline" &&
              file.size <= EMAIL_SERVICE_MAX_BYTES
                ? `/api/mail/drafts/files/${encodeURIComponent(file.uploadId)}?mailboxId=${encodeURIComponent(mailboxId)}`
                : null,
            status: "uploaded" as const,
            error: null,
          },
        ]
  );
}

/** Plain text as editor HTML: a paragraph per blank-line-separated block. */
function textHtml(text: string) {
  const document = new DOMParser().parseFromString("", "text/html");

  for (const block of text.split(/\r?\n\s*\r?\n/u)) {
    const paragraph = document.createElement("p");

    block.split(/\r?\n/u).forEach((line, index) => {
      if (index > 0) paragraph.appendChild(document.createElement("br"));
      paragraph.appendChild(document.createTextNode(line));
    });
    document.body.appendChild(paragraph);
  }

  return document.body.innerHTML;
}

/**
 * A reopened draft's editor HTML. The signature images it kept as its own
 * files become ordinary inline images of those files, so the draft no longer
 * depends on the signature as it is now. A mail app's draft has no editor
 * HTML: its HTML is taken as is, and a text-only one becomes paragraphs.
 */
export function restoredDraftHtml(
  draft: Pick<
    SavedDraft,
    "bodyHtml" | "editorHtml" | "bodyText" | "attachments"
  >
) {
  const document = new DOMParser().parseFromString(
    draft.editorHtml ?? draft.bodyHtml ?? textHtml(draft.bodyText),
    "text/html"
  );

  for (const image of document.querySelectorAll<HTMLImageElement>(
    "img[data-stored-owner]"
  )) {
    const contentId =
      image.dataset.cid ??
      (image.getAttribute("src") ?? "").replace(/^cid:/u, "");

    const copy = draft.attachments.find(
      (file) =>
        file.storedImage?.ownerId === image.dataset.storedOwner &&
        file.storedImage?.contentId === contentId
    );

    if (!copy) {
      image.remove();
      continue;
    }

    const asset = document.createElement("span");
    asset.dataset.composerAsset = copy.assetId;
    asset.dataset.composerAssetIntent = "inline";
    image.replaceWith(asset);
  }

  return document.body.innerHTML;
}

/**
 * A reopened draft as the composer's content, the way its editor opens it
 * (`html`, from restoredDraftHtml). Starting from this, opening a draft
 * changes nothing, so it doesn't save; and it counts as written, so it can
 * be sent as is.
 */
export function restoredDraftContent(
  draft: Pick<SavedDraft, "bodyHtml" | "bodyText">,
  html: string,
  assets: readonly ComposerAsset[]
): ComposerContent {
  return {
    bodyHtml: draft.bodyHtml ?? "",
    editorHtml: html,
    bodyText: draft.bodyText,
    inlineAssetIds: assets.flatMap((asset) =>
      asset.intent === "inline" ? [asset.id] : []
    ),
    storedImages: [],
    linkedAssetIds: [],
  };
}

/** The text of HTML the editor opens with, images as their alt text, as the editor reads it. */
export function openingText(html: string) {
  const document = new DOMParser().parseFromString(html, "text/html");

  for (const image of document.querySelectorAll("img")) {
    image.replaceWith(image.alt);
  }

  return document.body.textContent;
}

/**
 * Whether a draft holds nothing but what its composer opened with
 * (`initialText`, e.g. the signature): no new text and no files. Spacing is
 * ignored, since the editor and the opening HTML space blocks apart
 * differently.
 */
export function holdsOnlyInitialContent(
  content: Pick<DraftContent, "bodyText" | "attachments">,
  initialText: string
) {
  const squeeze = (text: string) => text.replaceAll(/\s+/gu, "");

  return (
    squeeze(content.bodyText ?? "") === squeeze(initialText) &&
    !content.attachments?.length
  );
}
