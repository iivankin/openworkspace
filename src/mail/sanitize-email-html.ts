import type { MessageAttachment } from "./types";

const FORBIDDEN_TAGS = [
  "script",
  "style",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "meta",
  "link",
  "base",
  "object",
  "embed",
  "iframe",
  "audio",
  "video",
  "source",
  "svg",
  "math",
];

const FORBIDDEN_ATTRIBUTES = [
  "style",
  "srcset",
  "poster",
  "background",
  "action",
  "formaction",
];

const SAFE_INLINE_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function mediaType(contentType: string) {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function normalizedContentId(value: string) {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed percent escapes are treated as an opaque content ID.
  }
  return decoded
    .replace(/^cid:/iu, "")
    .replace(/^<|>$/gu, "")
    .trim()
    .toLocaleLowerCase();
}

function safeLink(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function inlineAttachmentUrls(
  mailboxId: string,
  messageId: string,
  attachments: MessageAttachment[],
) {
  const values = new Map<string, string>();
  for (const attachment of attachments) {
    if (
      !attachment.contentId
      || !SAFE_INLINE_IMAGE_TYPES.has(mediaType(attachment.contentType))
    ) {
      continue;
    }
    values.set(
      normalizedContentId(attachment.contentId),
      `/api/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}/inline?mailboxId=${encodeURIComponent(mailboxId)}`,
    );
  }
  return values;
}

export type SafeEmailDocument = {
  srcDoc: string;
  blockedRemoteImages: number;
};

export async function sanitizeEmailHtml(input: {
  html: string;
  mailboxId: string;
  messageId: string;
  attachments: MessageAttachment[];
}): Promise<SafeEmailDocument> {
  const { default: DOMPurify } = await import("dompurify");
  const sanitized = DOMPurify.sanitize(input.html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
  });
  const document = new DOMParser().parseFromString(sanitized, "text/html");
  const inlineUrls = inlineAttachmentUrls(
    input.mailboxId,
    input.messageId,
    input.attachments,
  );
  let blockedRemoteImages = 0;

  for (const image of document.querySelectorAll("img")) {
    const source = image.getAttribute("src")?.trim() ?? "";
    const inlineUrl = source.toLocaleLowerCase().startsWith("cid:")
      ? inlineUrls.get(normalizedContentId(source))
      : undefined;
    const safeDataImage =
      /^data:image\/(?:gif|jpeg|png|webp);base64,[a-z0-9+/=\s]+$/iu.test(source);
    if (inlineUrl) {
      image.setAttribute("src", inlineUrl);
      image.setAttribute("loading", "lazy");
      continue;
    }
    if (safeDataImage) continue;

    if (source) blockedRemoteImages += 1;
    const placeholder = document.createElement("span");
    placeholder.className = "blocked-image";
    placeholder.textContent = image.getAttribute("alt")?.trim()
      || "External image blocked";
    image.replaceWith(placeholder);
  }

  for (const link of document.querySelectorAll("a")) {
    const href = link.getAttribute("href")?.trim() ?? "";
    if (!safeLink(href)) {
      link.removeAttribute("href");
      continue;
    }
    if (!href.toLocaleLowerCase().startsWith("mailto:")) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  }

  const body = document.body.innerHTML;
  const srcDoc = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; max-width: 100%; }
    html, body { margin: 0; padding: 0; background: transparent; }
    body {
      overflow-wrap: anywhere;
      color: CanvasText;
      font: 400 15px/1.55 Figtree, ui-sans-serif, sans-serif;
    }
    p, h1, h2, h3, h4, h5, h6 { margin: 0 0 .75em; }
    table { width: auto; border-collapse: collapse; }
    td, th { padding: .2rem .35rem; vertical-align: top; }
    pre { overflow: auto; white-space: pre-wrap; }
    blockquote { margin: .75rem 0; padding-left: .75rem; border-left: 2px solid color-mix(in srgb, CanvasText 18%, transparent); }
    a { color: LinkText; text-decoration: underline; text-underline-offset: 2px; }
    img { height: auto; }
    .blocked-image {
      display: inline-block;
      margin: .25rem 0;
      padding: .2rem .45rem;
      border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      border-radius: .35rem;
      color: GrayText;
      font-size: .75rem;
    }
  </style>
</head>
<body>${body}</body>
</html>`;
  return { srcDoc, blockedRemoteImages };
}
