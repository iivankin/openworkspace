import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, responseJson } from "@/lib/api";
import { scheduleMailboxRefresh } from "./mail-query-cache";
import type { Folder } from "./types";

export function useMailboxes() {
  return useQuery({
    queryKey: ["mailboxes"],
    queryFn: async ({ signal }) =>
      responseJson(await api.api.mail.mailboxes.$get(undefined, {
        init: { signal },
      })),
  });
}

export function useFolders(mailboxId: string | undefined) {
  return useQuery({
    queryKey: ["folders", mailboxId],
    queryFn: async ({ signal }) =>
      responseJson(
        await api.api.mail.mailboxes[":id"].folders.$get({
          param: { id: mailboxId! },
        }, { init: { signal } }),
      ),
    enabled: Boolean(mailboxId),
  });
}

export function useRecipientSuggestions(
  mailboxId: string | undefined,
  query: string,
  active: boolean,
) {
  return useQuery({
    queryKey: ["recipient-suggestions", mailboxId, query],
    queryFn: async ({ signal }) =>
      responseJson(
        await api.api.mail.mailboxes[":id"]["recipient-suggestions"].$get({
          param: { id: mailboxId! },
          query: { q: query, limit: "8" },
        }, { init: { signal } }),
      ),
    enabled: Boolean(mailboxId) && active,
    staleTime: 30_000,
  });
}

export function useConversations(
  mailboxId: string | undefined,
  folder: Folder,
  search: string,
  active = true,
) {
  return useInfiniteQuery({
    queryKey: ["conversations", mailboxId, folder, search],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      responseJson(
        await api.api.mail.conversations.$get({
          query: {
            mailboxId: mailboxId!,
            folder,
            limit: "25",
            cursor: pageParam,
            search: search || undefined,
          },
        }, { init: { signal } }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(mailboxId) && active,
  });
}

export function useConversation(
  mailboxId: string | undefined,
  conversationId: string | undefined,
) {
  return useQuery({
    queryKey: ["conversation", mailboxId, conversationId],
    queryFn: async ({ signal }) =>
      responseJson(
        await api.api.mail.conversations[":id"].$get({
          param: { id: conversationId! },
          query: { mailboxId: mailboxId! },
        }, { init: { signal } }),
      ),
    enabled: Boolean(mailboxId && conversationId),
  });
}

export function useResendMessage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, mailboxId }: { id: string; mailboxId: string }) =>
      responseJson(
        await api.api.mail.messages[":id"]["send-again"].$post({
          param: { id },
          query: { mailboxId },
        }),
      ),
    onSuccess: (_result, { mailboxId }) => scheduleMailboxRefresh(client, mailboxId),
  });
}

export function useSetMessageRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      mailboxId,
      isRead,
    }: {
      id: string;
      mailboxId: string;
      isRead: boolean;
    }) =>
      responseJson(
        await api.api.mail.messages[":id"].read.$patch({
          param: { id },
          query: { mailboxId },
          json: { isRead },
        }),
      ),
    onSuccess: (_result, { mailboxId }) => scheduleMailboxRefresh(client, mailboxId),
  });
}

export function useSetConversationRead() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      mailboxId,
      isRead,
    }: {
      id: string;
      mailboxId: string;
      isRead: boolean;
    }) =>
      responseJson(
        await api.api.mail.conversations[":id"].read.$patch({
          param: { id },
          query: { mailboxId },
          json: { isRead },
        }),
      ),
    onSuccess: (_result, { mailboxId }) => scheduleMailboxRefresh(client, mailboxId),
  });
}

export function useUpdateConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      mailboxId,
      input,
    }: {
      id: string;
      mailboxId: string;
      input: {
        mailboxState?: "active" | "archive" | "spam" | "trash";
        folderId?: string | null;
      };
    }) =>
      responseJson(
        await api.api.mail.conversations[":id"].$patch({
          param: { id },
          query: { mailboxId },
          json: input,
        }),
      ),
    onSuccess: (_result, { mailboxId }) => scheduleMailboxRefresh(client, mailboxId),
  });
}
