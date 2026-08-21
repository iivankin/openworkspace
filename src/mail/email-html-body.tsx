import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { sanitizeEmailHtml } from "./sanitize-email-html";
import type { MessageDetail } from "./types";

const MIN_FRAME_HEIGHT = 48;
const MAX_FRAME_HEIGHT = 720;

export function EmailHtmlBody({
  bodyHtml,
  mailboxId,
  message,
  onRenderModeChange,
}: {
  bodyHtml: string;
  mailboxId: string;
  message: MessageDetail;
  onRenderModeChange: (renderAsHtml: boolean) => void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const frameObserver = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState(MIN_FRAME_HEIGHT);
  const [frameReady, setFrameReady] = useState(false);
  const html = useQuery({
    queryKey: ["sanitized-message-html", mailboxId, message.id],
    queryFn: () => sanitizeEmailHtml({
      html: bodyHtml,
      mailboxId,
      messageId: message.id,
      attachments: message.attachments,
    }),
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    frameObserver.current?.disconnect();
    frameObserver.current = null;
    setFrameReady(false);
    setHeight(MIN_FRAME_HEIGHT);

    return () => {
      frameObserver.current?.disconnect();
      frameObserver.current = null;
    };
  }, [mailboxId, message.id]);

  useEffect(() => {
    onRenderModeChange(
      message.direction === "incoming"
        && (html.data?.renderAsHtml ?? false),
    );
  }, [html.data?.renderAsHtml, message.direction, onRenderModeChange]);

  function observeFrameSize() {
    const document = iframe.current?.contentDocument;
    if (!document) return;

    const updateHeight = () => {
      const contentHeight = document.body
        ? Math.max(document.body.scrollHeight, document.body.offsetHeight)
        : document.documentElement.scrollHeight;
      setHeight(Math.min(
        MAX_FRAME_HEIGHT,
        Math.max(MIN_FRAME_HEIGHT, contentHeight),
      ));
    };

    frameObserver.current?.disconnect();
    updateHeight();
    frameObserver.current = new ResizeObserver(updateHeight);
    frameObserver.current.observe(document.body ?? document.documentElement);
    setFrameReady(true);
  }

  const fallback = (
    <div className="whitespace-pre-wrap text-[15px] leading-6">
      {message.bodyText || message.preview || "No text body"}
    </div>
  );

  if (html.isPending) {
    return <Skeleton className="h-24 w-full rounded-md" />;
  }

  if (message.direction === "outgoing") {
    return html.data?.composerHtml
      ? (
          <div
            className="composer-message-body text-[0.9375rem] leading-[1.65]"
            dangerouslySetInnerHTML={{ __html: html.data.composerHtml }}
          />
        )
      : fallback;
  }

  if (!html.data?.renderAsHtml) return fallback;

  return (
    <div className="relative">
      {!frameReady ? <Skeleton className="h-24 w-full rounded-md" /> : null}
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
        onLoad={observeFrameSize}
      />
    </div>
  );
}
