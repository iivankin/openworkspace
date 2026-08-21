import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { api, responseJson } from "@/lib/api";
import type { Folder } from "./types";

export function useMailboxes() {
  return useQuery({
    queryKey: ["mailboxes"],
    queryFn: async () =>
      responseJson(await api.api.mail.mailboxes.$get()),
  });
}

export function useFolders(mailboxId: string | undefined) {
  return useQuery({
    queryKey: ["folders", mailboxId],
    queryFn: async () =>
      responseJson(
        await api.api.mail.mailboxes[":id"].folders.$get({
          param: { id: mailboxId! },
        }),
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
    queryFn: async () =>
      responseJson(
        await api.api.mail.mailboxes[":id"]["recipient-suggestions"].$get({
          param: { id: mailboxId! },
          query: { q: query, limit: "8" },
        }),
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
    queryFn: async ({ pageParam }) =>
      responseJson(
        await api.api.mail.conversations.$get({
          query: {
            mailboxId: mailboxId!,
            folder,
            limit: "25",
            cursor: pageParam,
            search: search || undefined,
          },
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(mailboxId) && active,
    refetchInterval: active ? 5_000 : false,
  });
}

export function useConversation(
  mailboxId: string | undefined,
  conversationId: string | undefined,
) {
  return useQuery({
    queryKey: ["conversation", mailboxId, conversationId],
    queryFn: async () =>
      responseJson(
        await api.api.mail.conversations[":id"].$get({
          param: { id: conversationId! },
          query: { mailboxId: mailboxId! },
        }),
      ),
    enabled: Boolean(mailboxId && conversationId),
    refetchInterval: 5_000,
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
    onSuccess: () => invalidateMailQueries(client),
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
    onSuccess: () => invalidateMailQueries(client),
  });
}

export async function invalidateMailQueries(client: QueryClient) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ["conversations"] }),
    client.invalidateQueries({ queryKey: ["conversation"] }),
  ]);
}
