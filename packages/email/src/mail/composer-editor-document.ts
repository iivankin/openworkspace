import type { Editor } from "@tiptap/react";

import type { StoredImageRef } from "../../shared/rich-content";
import type { ComposerSession } from "./composer-session";
import { takeStoredImages } from "./rich-content";

export type ComposerContent = {
  bodyHtml: string;
  /** The editor's own HTML, asset references included, which a draft keeps. */
  editorHtml: string;
  bodyText: string;
  inlineAssetIds: string[];
  linkedAssetIds: string[];
  /** Saved images (rich-content.ts) the body shows, sent by reference. */
  storedImages: StoredImageRef[];
};

/**
 * Serializes the editor from stable asset references. Upload metadata stays in
 * ComposerSession and never has to be copied back into ProseMirror attributes.
 */
export function composerContent(
  editor: Editor,
  session: ComposerSession
): ComposerContent {
  const editorHtml = editor.getHTML();
  // A document without a window: an <img src="cid:…"> here is never fetched,
  // which in the page's own document fails with ERR_UNKNOWN_URL_SCHEME.
  const inert = document.implementation.createHTMLDocument("");
  const wrapper = inert.createElement("div");
  wrapper.innerHTML = editorHtml;

  // Saved images keep their content id out of `src` in the editor (see
  // StoredImage); the sent HTML refers to them by it.
  for (const image of wrapper.querySelectorAll<HTMLImageElement>(
    "img[data-cid]"
  )) {
    image.setAttribute("src", `cid:${image.dataset.cid ?? ""}`);
    delete image.dataset.cid;
  }

  const inlineAssetIds: string[] = [];
  const linkedAssetIds: string[] = [];

  for (const reference of wrapper.querySelectorAll<HTMLElement>(
    "[data-composer-asset]"
  )) {
    const assetId = reference.dataset.composerAsset ?? "";
    const asset = session.getAsset(assetId);

    if (!asset?.uploadId) {
      reference.remove();
      continue;
    }

    if (session.isLinked(asset.id)) {
      linkedAssetIds.push(asset.id);
      const placeholder = inert.createElement("span");
      placeholder.dataset.linkedAttachment = asset.uploadId;
      placeholder.dataset.linkedAttachmentFilename = asset.filename;
      placeholder.textContent = asset.filename;
      reference.replaceWith(placeholder);
      continue;
    }

    if (asset.intent === "inline" && asset.contentId) {
      inlineAssetIds.push(asset.id);
      const image = inert.createElement("img");
      image.setAttribute("src", `cid:${asset.contentId}`);
      image.alt = asset.filename;
      image.title = asset.filename;
      reference.replaceWith(image);
      continue;
    }

    reference.remove();
  }

  const storedImages = takeStoredImages(wrapper);

  return {
    bodyHtml: wrapper.innerHTML,
    editorHtml,
    bodyText: editor.getText({ blockSeparator: "\n\n" }),
    inlineAssetIds,
    linkedAssetIds,
    storedImages,
  };
}
