import type { Email } from "../mailbox/schema";

const MAX_CONTEXT_CHARACTERS = 24_000;

type ContentSource = Pick<
  Email,
  "fromJson" | "toJson" | "ccJson" | "subject" | "timelineAt" | "bodyText" | "preview"
>;

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function displayAddress(email: ContentSource) {
  const from = email.fromJson[0];
  if (!from) return "Unknown sender";
  return from.name ? `${from.name} <${from.address}>` : from.address;
}

function clippedBody(email: ContentSource) {
  const value = email.bodyText?.trim() || email.preview.trim() || "No text body";
  if (value.length <= MAX_CONTEXT_CHARACTERS) return value;
  return `${value.slice(0, MAX_CONTEXT_CHARACTERS).trimEnd()}\n[Context truncated]`;
}

function metadataLines(email: ContentSource) {
  return [
    `From: ${displayAddress(email)}`,
    `Date: ${email.timelineAt.toISOString()}`,
    `Subject: ${email.subject}`,
    ...(email.toJson.length
      ? [`To: ${email.toJson.map((item) => item.address).join(", ")}`]
      : []),
    ...(email.ccJson.length
      ? [`Cc: ${email.ccJson.map((item) => item.address).join(", ")}`]
      : []),
  ];
}

export function contextForNewRecipient(email: ContentSource) {
  return [...metadataLines(email), "", clippedBody(email)].join("\n");
}

export function forwardedMessageText(email: ContentSource) {
  return ["Forwarded message", ...metadataLines(email), "", clippedBody(email)].join("\n");
}

export function forwardedMessageHtml(email: ContentSource) {
  const metadata = metadataLines(email)
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join("");
  return `<section data-forwarded-message><strong>Forwarded message</strong>${metadata}<pre style="white-space:pre-wrap">${escapeHtml(clippedBody(email))}</pre></section>`;
}

export function appendForwardedMessage(
  bodyText: string,
  bodyHtml: string | undefined,
  forwarded: ContentSource | null,
) {
  if (!forwarded) return { bodyText, bodyHtml };
  const text = forwardedMessageText(forwarded);
  const nextText = `${bodyText.trimEnd()}${bodyText.trimEnd() ? "\n\n" : ""}${text}`;
  return {
    bodyText: nextText,
    bodyHtml: bodyHtml
      ? `${bodyHtml}${forwardedMessageHtml(forwarded)}`
      : undefined,
  };
}

export function textWithQuotedContext(bodyText: string, quotedText: string | null) {
  if (!quotedText) return bodyText;
  const quote = quotedText.split("\n").map((line) => `> ${line}`).join("\n");
  return `${bodyText.trimEnd()}${bodyText.trimEnd() ? "\n\n" : ""}${quote}`;
}

export function htmlWithQuotedContext(bodyHtml: string, quotedText: string | null) {
  if (!quotedText) return bodyHtml;
  return `${bodyHtml}<blockquote><pre style="white-space:pre-wrap">${escapeHtml(quotedText)}</pre></blockquote>`;
}
