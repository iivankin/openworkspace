import { useQuery } from "@tanstack/react-query";
import { ImageOff } from "lucide-react";
import { useRef, useState } from "react";
import { sanitizeEmailHtml } from "./sanitize-email-html";
import type { MessageDetail } from "./types";

const MIN_FRAME_HEIGHT = 48;
const MAX_FRAME_HEIGHT = 720;

export function EmailHtmlBody({
  mailboxId,
  message,
}: {
  mailboxId: string;
  message: MessageDetail;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_FRAME_HEIGHT);
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

  function resizeFrame() {
    const frame = iframe.current;
    const contentHeight = frame?.contentDocument?.documentElement.scrollHeight
      ?? MIN_FRAME_HEIGHT;
    setHeight(Math.min(
      MAX_FRAME_HEIGHT,
      Math.max(MIN_FRAME_HEIGHT, contentHeight),
    ));
  }

  if (!html.data) {
    return (
      <div className="whitespace-pre-wrap text-[15px] leading-6">
        {message.bodyText || message.preview || "No text body"}
      </div>
    );
  }

  return (
    <div>
      {html.data.blockedRemoteImages > 0 ? (
        <p className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ImageOff className="size-3.5" />
          External images blocked
        </p>
      ) : null}
      <iframe
        ref={iframe}
        className="block w-full border-0 bg-transparent"
        style={{ height }}
        title={`HTML body of ${message.subject}`}
        sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
        referrerPolicy="no-referrer"
        srcDoc={html.data.srcDoc}
        onLoad={resizeFrame}
      />
    </div>
  );
}
