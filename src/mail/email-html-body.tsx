import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { sanitizeEmailHtml } from "./sanitize-email-html";
import type { MessageDetail } from "./types";

const MIN_FRAME_HEIGHT = 48;
const MAX_FRAME_HEIGHT = 720;

export function EmailHtmlBody({
  mailboxId,
  message,
  onRenderModeChange,
}: {
  mailboxId: string;
  message: MessageDetail;
  onRenderModeChange: (renderAsHtml: boolean) => void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_FRAME_HEIGHT);
  const [frameReady, setFrameReady] = useState(false);
  const html = useQuery({
    queryKey: ["message-html", mailboxId, message.id],
    queryFn: async () => {
      const response = await fetch(
        `/api/mail/messages/${encodeURIComponent(message.id)}/html?mailboxId=${encodeURIComponent(mailboxId)}`,
      );
      if (!response.ok) throw new Error("Could not load the HTML body");
      return sanitizeEmailHtml({
        html: await response.text(),
        mailboxId,
        messageId: message.id,
        attachments: message.attachments,
      });
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    setFrameReady(false);
    setHeight(MIN_FRAME_HEIGHT);
  }, [mailboxId, message.id]);

  useEffect(() => {
    onRenderModeChange(html.data?.renderAsHtml ?? false);
  }, [html.data?.renderAsHtml, onRenderModeChange]);

  function resizeFrame() {
    const frame = iframe.current;
    const contentHeight = frame?.contentDocument?.documentElement.scrollHeight
      ?? MIN_FRAME_HEIGHT;
    setHeight(Math.min(
      MAX_FRAME_HEIGHT,
      Math.max(MIN_FRAME_HEIGHT, contentHeight),
    ));
    setFrameReady(true);
  }

  const fallback = (
    <div className="whitespace-pre-wrap text-[15px] leading-6">
      {message.bodyText || message.preview || "No text body"}
    </div>
  );

  if (!html.data?.renderAsHtml) return fallback;

  return (
    <div className="relative">
      {!frameReady ? fallback : null}
      <iframe
        ref={iframe}
        className={cn(
          "block w-full overflow-hidden rounded-md border border-black/8 bg-white",
          frameReady
            ? "relative opacity-100"
            : "pointer-events-none absolute inset-x-0 top-0 h-0 opacity-0",
        )}
        style={frameReady ? { height } : undefined}
        title={`HTML body of ${message.subject}`}
        sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
        referrerPolicy="no-referrer"
        srcDoc={html.data.srcDoc}
        onLoad={resizeFrame}
      />
    </div>
  );
}
