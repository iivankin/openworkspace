import type { ConversationCursorPosition } from "../mailbox";

const CURSOR_VERSION = 1;

function toBase64Url(value: string) {
  const bytes = new TextEncoder().encode(value);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeConversationCursor(position: ConversationCursorPosition) {
  return toBase64Url(JSON.stringify([
    CURSOR_VERSION,
    position.timelineAt,
    position.emailId,
  ]));
}

export function decodeConversationCursor(value: string) {
  try {
    const decoded: unknown = JSON.parse(fromBase64Url(value));
    if (
      !Array.isArray(decoded)
      || decoded.length !== 3
      || decoded[0] !== CURSOR_VERSION
      || !Number.isSafeInteger(decoded[1])
      || typeof decoded[2] !== "string"
      || decoded[2].length === 0
    ) {
      return null;
    }
    return { timelineAt: decoded[1], emailId: decoded[2] };
  } catch {
    return null;
  }
}
