import { useEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { translatedEmailHtml } from "./translation-html";
import { useSanitizedEmailHtml } from "./use-sanitized-email-html";
import type { MessageDetail } from "./types";

const MIN_FRAME_HEIGHT = 48;
const MAX_FRAME_HEIGHT = 720;

export function EmailHtmlBody({
  bodyHtml,
  mailboxId,
  message,
  onRenderModeChange,
  translations,
}: {
  bodyHtml: string;
  mailboxId: string;
  message: MessageDetail;
  onRenderModeChange: (renderAsHtml: boolean) => void;
  translations?: string[];
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const frameObserver = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState(MIN_FRAME_HEIGHT);
  const [frameReady, setFrameReady] = useState(false);
  const html = useSanitizedEmailHtml(bodyHtml, mailboxId, message);
  const composerHtml = useMemo(() =>
    translations && message.direction === "outgoing" && html.data?.composerHtml
      ? translatedEmailHtml(html.data.composerHtml, translations, false)
      : html.data?.composerHtml,
  [html.data?.composerHtml, message.direction, translations]);
  const srcDoc = useMemo(() =>
    translations && message.direction === "incoming" && html.data?.srcDoc
      ? translatedEmailHtml(html.data.srcDoc, translations, true)
      : html.data?.srcDoc,
  [html.data?.srcDoc, message.direction, translations]);

  useEffect(() => {
    frameObserver.current?.disconnect();
    frameObserver.current = null;
    setFrameReady(false);
    setHeight(MIN_FRAME_HEIGHT);

    return () => {
      frameObserver.current?.disconnect();
      frameObserver.current = null;
    };
  }, [mailboxId, message.id, translations]);

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
    return composerHtml
      ? (
          <div
            className="composer-message-body text-[0.9375rem] leading-[1.65]"
            dangerouslySetInnerHTML={{ __html: composerHtml }}
          />
        )
      : fallback;
  }

  if (!html.data?.renderAsHtml || !srcDoc) return fallback;

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
        srcDoc={srcDoc}
        onLoad={observeFrameSize}
      />
    </div>
  );
}
