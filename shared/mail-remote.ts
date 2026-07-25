/** Same-origin proxy path used inside sanitized HTML iframes. */
export function mailRemoteProxyPath(mailboxId: string, remoteUrl: string) {
  const params = new URLSearchParams({
    mailboxId,
    url: remoteUrl,
  });
  return `/api/mail/remote?${params.toString()}`;
}

export function isRemoteHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
