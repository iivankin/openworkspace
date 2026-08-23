import { format, isThisYear, isToday, isYesterday } from "date-fns";
import { CircleAlert, LoaderCircle, MailOpen, RotateCw, SearchX } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "./types";

function shortDate(value: string) {
  const date = new Date(value);
  if (isToday(date)) return format(date, "HH:mm");
  if (isYesterday(date)) return "Yesterday";
  if (isThisYear(date)) return format(date, "MMM d");
  return format(date, "MMM d, yyyy");
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

function EmptyState({
  Icon,
  title,
  description,
  children,
}: {
  Icon: typeof MailOpen;
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="grid min-h-80 place-items-center px-8 py-16 text-center">
      <div className="animate-fade-in">
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-surface-sunken text-muted-foreground ring-1 ring-border">
          <Icon className="size-6" strokeWidth={1.75} />
        </span>
        <p className="mt-5 font-display text-lg font-semibold">{title}</p>
        {description ? (
          <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
        {children ? <div className="mt-5">{children}</div> : null}
      </div>
    </div>
  );
}

export function MessageList({
  folderName,
  messages,
  loading,
  loadingMore,
  hasMore,
  search,
  unreadOnly,
  error,
  onLoadMore,
  onRetry,
  onSelect,
  selection,
}: {
  folderName: string;
  messages: ConversationSummary[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  search: string;
  unreadOnly: boolean;
  error?: string;
  onLoadMore: () => void;
  onRetry: () => void;
  onSelect: (message: ConversationSummary) => void;
  selection?: {
    disabled: boolean;
    selectedIds: ReadonlySet<string>;
    onToggle: (conversationId: string) => void;
  };
}) {
  if (loading) {
    return (
      <div className="divide-y divide-border/60 overflow-hidden rounded-2xl bg-surface ring-1 ring-border">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex items-center gap-4 px-4 py-4">
            <Skeleton className="size-10 shrink-0 rounded-full" />
            <Skeleton className="h-3.5 w-40 shrink-0" />
            <Skeleton className="h-3.5 min-w-0 flex-1" />
            <Skeleton className="h-3 w-12 shrink-0" />
          </div>
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-2xl bg-surface ring-1 ring-border">
        <EmptyState
          Icon={CircleAlert}
          title="Could not load conversations"
          description={error}
        >
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            <RotateCw /> Retry
          </Button>
        </EmptyState>
      </div>
    );
  }
  if (!messages.length) {
    return (
      <div className="rounded-2xl bg-surface ring-1 ring-border">
        <EmptyState
          Icon={search ? SearchX : MailOpen}
          title={search
            ? `No${unreadOnly ? " unread" : ""} matches in ${folderName}`
            : unreadOnly
              ? `No unread conversations in ${folderName}`
              : `${folderName} is empty`}
          description={search
            ? "Try a different name, address, subject, or phrase."
            : unreadOnly
              ? "There are no unread conversations in this folder."
            : "New conversations will appear here as soon as they arrive."}
        >
          {hasMore ? <LoadMoreButton loading={loadingMore} onLoadMore={onLoadMore} /> : null}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl bg-surface shadow-xs ring-1 ring-border">
      <div className="divide-y divide-border/60">
        {messages.map((message) => {
          const sender = message.conversationLabel;
          const selected = selection?.selectedIds.has(message.conversationId) ?? false;
          return (
            <div
              key={message.id}
              className={cn(
                "group relative grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-3 py-3.5 text-left",
                "transition-colors duration-150 ease-out hover:bg-accent/55",
                "before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary before:opacity-0 before:transition-opacity hover:before:opacity-100 focus-visible:before:opacity-100",
                "sm:gap-4 sm:px-5",
                message.isUnread && "bg-primary/4",
                selected && "bg-primary/9 before:opacity-100",
              )}
            >
              <button
                type="button"
                disabled={selection?.disabled}
                className="absolute inset-0 z-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                aria-label={selection
                  ? `${selected ? "Deselect" : "Select"} ${message.subject}`
                  : `Open ${message.subject}`}
                onClick={() => selection
                  ? selection.onToggle(message.conversationId)
                  : onSelect(message)}
              />

              <span className="pointer-events-none relative z-10 grid size-10 place-items-center">
                {selection ? (
                  <Checkbox
                    className="size-5"
                    checked={selected}
                    disabled={selection.disabled}
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                ) : (
                  <Avatar className={cn(
                    "size-10",
                    message.isUnread && "ring-2 ring-primary/25",
                  )}>
                    <AvatarFallback className="text-xs">
                      {sender.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                )}
              </span>

              <div className="pointer-events-none relative z-1 min-w-0 lg:flex lg:items-baseline lg:gap-4">
                <span className="flex min-w-0 items-center gap-2 lg:w-56 lg:shrink-0">
                  {message.isUnread ? (
                    <span
                      className="size-2 shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_14%,transparent)]"
                      aria-label={`${message.unreadCount} unread messages`}
                    />
                  ) : null}
                  <span className={cn(
                    "block truncate text-[0.9375rem] leading-6 tracking-[-0.01em]",
                    message.isUnread ? "font-bold" : "font-semibold",
                  )}>
                    {sender}
                  </span>
                </span>
                <span className="mt-0.5 block min-w-0 lg:mt-0 lg:flex lg:flex-1 lg:items-baseline lg:gap-2">
                  <span className="flex min-w-0 items-baseline gap-1.5 lg:max-w-[46%] lg:shrink-0">
                    <span className={cn(
                      "block truncate text-sm leading-6 text-foreground/90",
                      message.isUnread ? "font-semibold" : "font-medium",
                    )}>
                      {message.subject}
                    </span>
                    {message.messageCount > 1 ? (
                      <span className="shrink-0 text-[10px] font-semibold text-muted-foreground tabular-nums">
                        {message.messageCount}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block line-clamp-2 text-[0.8125rem] leading-5 text-muted-foreground lg:mt-0 lg:min-w-0 lg:flex-1 lg:truncate lg:before:mr-2 lg:before:text-border lg:before:content-['—']">
                    {message.preview || "No text preview"}
                  </span>
                </span>
              </div>

              <time className={cn(
                "pointer-events-none relative z-1",
                "shrink-0 pt-1 text-[11px] font-medium tabular-nums",
                message.isUnread ? "text-foreground" : "text-muted-foreground",
              )}>
                {shortDate(message.timelineAt)}
              </time>
            </div>
          );
        })}
      </div>
      {hasMore ? (
        <div className="flex justify-center border-t border-border/60 bg-surface-sunken/60 px-4 py-4">
          <LoadMoreButton loading={loadingMore} onLoadMore={onLoadMore} />
        </div>
      ) : null}
    </div>
  );
}
