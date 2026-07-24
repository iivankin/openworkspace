import { format, isToday, isYesterday } from "date-fns";
import { CircleAlert, LoaderCircle, MailOpen, RotateCw } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import type { ConversationSummary } from "./types";

function shortDate(value: string) {
  const date = new Date(value);
  if (isToday(date)) return format(date, "HH:mm");
  if (isYesterday(date)) return "Yesterday";
  return format(date, "MMM d");
}

function LoadMoreButton({ loading, onLoadMore }: {
  loading: boolean;
  onLoadMore: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={loading}
      onClick={onLoadMore}
    >
      {loading ? <LoaderCircle className="animate-spin" /> : null}
      Load older conversations
    </Button>
  );
}

export function MessageList({
  folderName,
  messages,
  loading,
  loadingMore,
  hasMore,
  search,
  error,
  onLoadMore,
  onRetry,
  onSelect,
}: {
  folderName: string;
  messages: ConversationSummary[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  search: string;
  error?: string;
  onLoadMore: () => void;
  onRetry: () => void;
  onSelect: (message: ConversationSummary) => void;
}) {
  if (loading) {
    return <div className="grid min-h-72 place-items-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>;
  }
  if (error) {
    return (
      <div className="grid min-h-72 place-items-center border-y px-8 text-center">
        <div>
          <CircleAlert className="mx-auto size-7 text-destructive/70" />
          <p className="mt-3 text-sm font-medium">Could not load conversations</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">{error}</p>
          <Button className="mt-4" type="button" variant="outline" size="sm" onClick={onRetry}>
            <RotateCw /> Retry
          </Button>
        </div>
      </div>
    );
  }
  if (!messages.length) {
    return (
      <div className="grid flex-1 place-items-center px-8 text-center">
        <div>
          <MailOpen className="mx-auto size-7 text-muted-foreground/60" />
          <p className="mt-3 text-sm font-medium">
            {search ? `No matches in ${folderName}` : `No conversations in ${folderName}`}
          </p>
          {search ? <p className="mt-1 text-xs text-muted-foreground">Try a different name, address, subject, or phrase.</p> : null}
          {hasMore ? (
            <div className="mt-4">
              <LoadMoreButton loading={loadingMore} onLoadMore={onLoadMore} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="border-y">
      <div className="divide-y">
        {messages.map((message) => {
          const sender = message.conversationLabel;
          return (
            <button
              type="button"
              key={message.id}
              onClick={() => onSelect(message)}
              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 px-3 py-4 text-left transition-colors hover:bg-muted/45 sm:gap-4 sm:px-5"
            >
              <div>
                <Avatar className="size-10 sm:size-11">
                  <AvatarFallback className="text-xs font-semibold">
                    {sender.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm">{sender}</span>
                </div>
                <p className="mt-0.5 truncate text-sm text-foreground/85">{message.subject}</p>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground sm:line-clamp-1">{message.preview || "No text preview"}</p>
              </div>
              <time className="pt-0.5 text-[11px] text-muted-foreground">{shortDate(message.timelineAt)}</time>
            </button>
          );
        })}
      </div>
      {hasMore ? (
        <div className="flex justify-center border-t px-4 py-5">
          <LoadMoreButton loading={loadingMore} onLoadMore={onLoadMore} />
        </div>
      ) : null}
    </div>
  );
}
