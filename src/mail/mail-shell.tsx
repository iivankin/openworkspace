import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { ConversationView } from "./conversation-view";
import { MailHeader } from "./mail-header";
import { FolderTabBar, folderDisplayName } from "./mail-navigation";
import { MessageList } from "./message-list";
import type {
  ConversationSummary,
  Folder,
  MessageDetail,
} from "./types";
import { mailboxForRoute, resolveMailLocation } from "./mail-location";
import {
  useConversations,
  useMailboxes,
  useConversation,
  useFolders,
  useUpdateConversation,
} from "./use-mail-data";

const ComposeWindow = lazy(async () => {
  const module = await import("./compose-window");
  return { default: module.ComposeWindow };
});

export function MailShell({ mailboxId }: { mailboxId?: string }) {
  const navigateRoute = useNavigate();
  const [params] = useSearchParams();
  const [composerMailboxId, setComposerMailboxId] = useState<string | null>(null);
  const [forwardedMessage, setForwardedMessage] = useState<MessageDetail | undefined>();
  const [search, setSearch] = useState("");
  const mailboxQuery = useMailboxes();
  const mailboxes = mailboxQuery.data?.mailboxes ?? [];
  const requestedMailbox = mailboxForRoute(mailboxId, mailboxes);
  const foldersQuery = useFolders(requestedMailbox?.id);
  const folders = foldersQuery.data?.folders;
  const location = resolveMailLocation(
    mailboxId,
    params,
    mailboxes,
    folders,
  );
  const {
    mailbox,
    folder,
    conversationId,
    ready: locationReady,
    canonicalParams,
  } = location;
  const activeMailboxId = mailbox?.id;
  const composeOpen = composerMailboxId === activeMailboxId;
  const currentSearch = params.toString();
  const canonicalSearch = canonicalParams.toString();
  useEffect(() => {
    if (
      composerMailboxId
      && activeMailboxId
      && composerMailboxId !== activeMailboxId
    ) {
      setComposerMailboxId(null);
      setForwardedMessage(undefined);
    }
  }, [activeMailboxId, composerMailboxId]);
  useEffect(() => {
    if (
      locationReady
      && mailbox
      && (mailboxId !== mailbox.id || currentSearch !== canonicalSearch)
    ) {
      navigateRoute({
        pathname: `/mail/${encodeURIComponent(mailbox.id)}`,
        search: canonicalSearch ? `?${canonicalSearch}` : "",
      }, { replace: true });
    }
  }, [
    canonicalSearch,
    currentSearch,
    locationReady,
    mailbox,
    mailboxId,
    navigateRoute,
  ]);
  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  const conversationsQuery = useConversations(
    mailbox?.id,
    folder,
    debouncedSearch,
    locationReady && !conversationId,
  );
  const conversationQuery = useConversation(
    mailbox?.id,
    locationReady ? conversationId : undefined,
  );
  const updateConversation = useUpdateConversation();
  const conversations = useMemo(
    () => conversationsQuery.data?.pages.flatMap((page) => page.conversations) ?? [],
    [conversationsQuery.data?.pages],
  );
  const folderName = folderDisplayName(folder, folders);

  function navigate(next: {
    folder?: Folder;
    mailbox?: string;
    conversation?: string | null;
  }) {
    const value = new URLSearchParams();
    const targetMailboxId = next.mailbox ?? mailbox?.id;
    if (!targetMailboxId) return;
    value.set("folder", next.folder ?? folder);
    if (next.conversation === null) value.delete("conversation");
    else if (next.conversation) value.set("conversation", next.conversation);
    else if (conversationId) value.set("conversation", conversationId);
    navigateRoute({
      pathname: `/mail/${encodeURIComponent(targetMailboxId)}`,
      search: `?${value.toString()}`,
    });
  }

  function openCompose() {
    if (!mailbox?.canSend) return;
    setForwardedMessage(undefined);
    setComposerMailboxId(mailbox.id);
  }

  function openForward(message: MessageDetail) {
    if (!mailbox?.canSend) return;
    setForwardedMessage(message);
    setComposerMailboxId(mailbox.id);
  }

  function closeComposer() {
    setComposerMailboxId(null);
    setForwardedMessage(undefined);
  }

  // Reads the live URL: a mutation can settle after the user already moved to
  // another folder, and the captured `folder` would drag them back.
  function closeConversation() {
    const search = new URLSearchParams(window.location.search);
    if (!search.has("conversation")) return;
    search.delete("conversation");
    navigateRoute({
      pathname: window.location.pathname,
      search: search.size ? `?${search.toString()}` : "",
    });
  }

  function mutateConversation(
    input: {
      mailboxState?: "active" | "archive" | "spam" | "trash";
      folderId?: string | null;
    },
    returnToList = false,
  ) {
    if (!conversationId || !mailbox) return;
    updateConversation.mutate(
      { id: conversationId, mailboxId: mailbox.id, input },
      {
        onSuccess: () => {
          if (returnToList) closeConversation();
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  function selectFolder(next: Folder) {
    navigate({ folder: next, conversation: null });
  }

  return (
    <main className="paper-grain flex h-dvh min-h-0 flex-col overflow-hidden bg-background">
      <MailHeader
        mailbox={mailbox}
        mailboxes={mailboxQuery.data?.mailboxes ?? []}
        search={search}
        searchPlaceholder={`Search in ${folderName}`}
        showSearch={!conversationId}
        onSearchChange={setSearch}
        onMailboxChange={(id) => {
          closeComposer();
          navigate({ mailbox: id, folder: "inbox", conversation: null });
        }}
        onCompose={openCompose}
        onAdministration={() => navigateRoute("/admin")}
      />
      <FolderTabBar folder={folder} folders={folders} onSelect={selectFolder} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversationId ? (
          <ConversationView
            messages={conversationQuery.data?.messages ?? []}
            loading={conversationQuery.isLoading}
            error={conversationQuery.error?.message}
            mailbox={mailbox}
            mailboxState={conversationQuery.data?.mailboxState ?? "active"}
            onRetry={() => void conversationQuery.refetch()}
            onBack={() => navigate({ conversation: null })}
            onArchive={() => mutateConversation({ mailboxState: "archive" }, true)}
            onRestore={() => mutateConversation({ mailboxState: "active" }, true)}
            onTrash={() => mutateConversation({ mailboxState: "trash" }, true)}
            onForward={openForward}
            onOpenConversation={(id) => navigate({ folder: "sent", conversation: id })}
          />
        ) : (
          <section className="w-full px-3 pb-24 sm:px-6 lg:px-8 lg:pb-10">
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pt-7 pb-5 sm:pt-9 sm:pb-6">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                  {mailbox?.address}
                </p>
                <h1 className="mt-1.5 font-display text-[2rem] leading-none font-semibold sm:text-[2.5rem]">
                  {folderName}
                </h1>
              </div>
              <p className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {conversations.length}{conversationsQuery.hasNextPage ? "+" : ""} conversations
              </p>
            </div>

            <label className="relative mb-4 block xl:hidden">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="h-11 rounded-full pl-10" placeholder={`Search in ${folderName}`} value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>

            <MessageList
              folderName={folderName}
              messages={conversations}
              loading={mailboxQuery.isLoading || foldersQuery.isLoading || conversationsQuery.isLoading}
              loadingMore={conversationsQuery.isFetchingNextPage}
              hasMore={Boolean(conversationsQuery.hasNextPage)}
              search={debouncedSearch}
              error={mailboxQuery.error?.message
                ?? foldersQuery.error?.message
                ?? conversationsQuery.error?.message}
              onLoadMore={() => void conversationsQuery.fetchNextPage()}
              onRetry={() => void (mailboxQuery.isError
                ? mailboxQuery.refetch()
                : foldersQuery.isError
                  ? foldersQuery.refetch()
                  : conversationsQuery.refetch())}
              onSelect={(message: ConversationSummary) => navigate({ conversation: message.conversationId })}
            />
          </section>
        )}
      </div>

      {composeOpen && mailbox && (
        <Suspense fallback={null}>
          <ComposeWindow
            key={`${mailbox.id}:${forwardedMessage?.id ?? "compose"}`}
            mailbox={mailbox}
            forwardedMessage={forwardedMessage}
            onClose={closeComposer}
          />
        </Suspense>
      )}
    </main>
  );
}
