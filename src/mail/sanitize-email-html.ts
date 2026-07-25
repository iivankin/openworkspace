import {
  isRemoteHttpUrl,
  mailRemoteProxyPath,
} from "../../shared/mail-remote";
import type { MessageAttachment } from "./types";

const FORBIDDEN_TAGS = [
  "script",
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
  "poster",
  "action",
  "formaction",
];

const SAFE_INLINE_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const DANGEROUS_CSS =
  /expression\s*\(|-moz-binding|behavior\s*:|@import|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html/giu;

/**
 * Keep email layout CSS while blocking scriptable CSS.
 * Remote `url(...)` values are rewritten through the Worker proxy when provided.
 */
export function sanitizeEmailCss(
  css: string,
  rewriteRemoteUrl?: (url: string) => string | null,
) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const withoutDanger = withoutComments.replace(DANGEROUS_CSS, "/* blocked */");
  return withoutDanger.replace(
    /url\s*\(\s*(['"]?)([^)'"]*?)\1\s*\)/giu,
    (match, _quote: string, rawUrl: string) => {
      const url = rawUrl.trim();
      if (/^data:image\/(?:gif|jpeg|jpg|png|webp)/iu.test(url)) return match;
      if (/^cid:/iu.test(url)) return match;
      if (isRemoteHttpUrl(url) && rewriteRemoteUrl) {
        const proxied = rewriteRemoteUrl(url);
        if (proxied) return `url("${proxied}")`;
      }
      return "/* remote url blocked */";
    },
  );
}

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

function rewriteSrcset(
  value: string,
  rewriteRemoteUrl: (url: string) => string | null,
) {
  return value
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return "";
      const match = /^(\S+)(\s+.+)?$/u.exec(trimmed);
      if (!match) return "";
      const [, source = "", descriptor = ""] = match;
      if (!isRemoteHttpUrl(source)) return trimmed;
      const proxied = rewriteRemoteUrl(source);
      return proxied ? `${proxied}${descriptor}` : "";
    })
    .filter(Boolean)
    .join(", ");
}

function scrubStyles(
  root: ParentNode,
  rewriteRemoteUrl: (url: string) => string | null,
) {
  for (const element of root.querySelectorAll("[style]")) {
    const style = element.getAttribute("style");
    if (!style) continue;
    const next = sanitizeEmailCss(style, rewriteRemoteUrl);
    if (next.trim()) element.setAttribute("style", next);
    else element.removeAttribute("style");
  }
  for (const styleTag of root.querySelectorAll("style")) {
    styleTag.textContent = sanitizeEmailCss(
      styleTag.textContent ?? "",
      rewriteRemoteUrl,
    );
  }
}

export type SafeEmailDocument = {
  srcDoc: string;
  proxiedRemoteImages: number;
};

export async function sanitizeEmailHtml(input: {
  html: string;
  mailboxId: string;
  messageId: string;
  attachments: MessageAttachment[];
}): Promise<SafeEmailDocument> {
  const rewriteRemoteUrl = (url: string) =>
    mailRemoteProxyPath(input.mailboxId, url);

  const { default: DOMPurify } = await import("dompurify");
  const sanitized = DOMPurify.sanitize(input.html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ["style"],
    ADD_ATTR: [
      "style",
      "bgcolor",
      "color",
      "width",
      "height",
      "align",
      "valign",
      "background",
      "srcset",
    ],
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
  });
  const document = new DOMParser().parseFromString(sanitized, "text/html");
  scrubStyles(document, rewriteRemoteUrl);
  const inlineUrls = inlineAttachmentUrls(
    input.mailboxId,
    input.messageId,
    input.attachments,
  );
  let proxiedRemoteImages = 0;

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
    } else if (safeDataImage) {
      // keep as-is
    } else if (isRemoteHttpUrl(source)) {
      image.setAttribute("src", rewriteRemoteUrl(source));
      image.setAttribute("loading", "lazy");
      image.setAttribute("referrerpolicy", "no-referrer");
      proxiedRemoteImages += 1;
    } else if (source) {
      image.removeAttribute("src");
    }

    const srcset = image.getAttribute("srcset")?.trim() ?? "";
    if (srcset) {
      const rewritten = rewriteSrcset(srcset, rewriteRemoteUrl);
      if (rewritten) image.setAttribute("srcset", rewritten);
      else image.removeAttribute("srcset");
    }
  }

  for (const element of document.querySelectorAll("[background]")) {
    const background = element.getAttribute("background")?.trim() ?? "";
    if (isRemoteHttpUrl(background)) {
      element.setAttribute("background", rewriteRemoteUrl(background));
      proxiedRemoteImages += 1;
    } else {
      element.removeAttribute("background");
    }
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

  const headStyles = [...document.querySelectorAll("head style")]
    .map((node) => node.outerHTML)
    .join("\n");
  const body = document.body.innerHTML;
  const srcDoc = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light only; }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      color: #111111;
    }
    body {
      overflow-wrap: anywhere;
      font: 400 15px/1.55 system-ui, -apple-system, sans-serif;
    }
    img { max-width: 100%; height: auto; }
    pre { overflow: auto; white-space: pre-wrap; }
  </style>
  ${headStyles}
</head>
<body>${body}</body>
</html>`;
  return { srcDoc, proxiedRemoteImages };
}
