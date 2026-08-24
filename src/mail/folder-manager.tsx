import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Folder,
  FolderCog,
  LoaderCircle,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, responseJson } from "@/lib/api";
import { MailboxAiSettings } from "./mailbox-ai-settings";
import { ToolbarTooltip } from "./toolbar-tooltip";
import type { MailFolder } from "./types";

type FolderOperation =
  | { type: "create"; name: string }
  | { type: "rename"; folderId: string; name: string }
  | { type: "delete"; folderId: string }
  | { type: "reorder"; folderIds: string[] };

export function FolderManager({
  mailboxId,
  activeFolderId,
  folders,
  onSelectFolder,
}: {
  mailboxId: string;
  activeFolderId: string;
  folders: MailFolder[];
  onSelectFolder: (folderId: string) => void;
}) {
  const client = useQueryClient();
  const customFolders = folders.filter((folder) => folder.kind === "custom");
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<MailFolder | null>(null);
  const [section, setSection] = useState("folders");
  const mutation = useMutation({
    mutationFn: async (operation: FolderOperation) => {
      if (operation.type === "create") {
        return responseJson(await api.api.mail.mailboxes[":id"].folders.$post({
          param: { id: mailboxId },
          json: { name: operation.name },
        }));
      }
      if (operation.type === "rename") {
        return responseJson(
          await api.api.mail.mailboxes[":id"].folders[":folderId"].$patch({
            param: { id: mailboxId, folderId: operation.folderId },
            json: { name: operation.name },
          }),
        );
      }
      if (operation.type === "delete") {
        return responseJson(
          await api.api.mail.mailboxes[":id"].folders[":folderId"].$delete({
            param: { id: mailboxId, folderId: operation.folderId },
          }),
        );
      }
      return responseJson(
        await api.api.mail.mailboxes[":id"].folders.order.$put({
          param: { id: mailboxId },
          json: { folderIds: operation.folderIds },
        }),
      );
    },
    onSuccess: async (_result, operation) => {
      if (operation.type === "create") {
        setNewName("");
        toast.success("Folder created");
      } else if (operation.type === "rename") {
        setEditingId(null);
        toast.success("Folder renamed");
      } else if (operation.type === "delete") {
        setDeleteCandidate(null);
        if (operation.folderId === activeFolderId) onSelectFolder("inbox");
        toast.success("Folder deleted; its conversations moved to Inbox");
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: ["folders", mailboxId] }),
        client.invalidateQueries({ queryKey: ["conversations", mailboxId] }),
      ]);
    },
    onError: async (error) => {
      toast.error(error.message);
      // A reorder conflict means this client no longer has the authoritative
      // folder list. Refresh on every failed mutation so retrying cannot loop
      // on the same stale order after a missed realtime invalidation.
      await client.invalidateQueries({ queryKey: ["folders", mailboxId] });
    },
  });

  function createFolder(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (name) mutation.mutate({ type: "create", name });
  }

  function renameFolder(event: FormEvent, folderId: string) {
    event.preventDefault();
    const name = editingName.trim();
    if (name) mutation.mutate({ type: "rename", folderId, name });
  }

  function moveFolder(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= customFolders.length) return;
    const folderIds = customFolders.map((folder) => folder.id);
    [folderIds[index], folderIds[target]] = [folderIds[target]!, folderIds[index]!];
    mutation.mutate({ type: "reorder", folderIds });
  }

  return (
    <TooltipProvider delay={300}>
      <Dialog open={open} onOpenChange={setOpen}>
        <ToolbarTooltip label="Manage folders and AI rules" side="bottom">
          <DialogTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 rounded-full"
              />
            }
          >
            <FolderCog />
            <span className="sr-only">Manage folders and AI rules</span>
          </DialogTrigger>
        </ToolbarTooltip>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Folders &amp; AI sorting</DialogTitle>
            <DialogDescription>
              Organization settings are shared with everyone who can access this mailbox.
            </DialogDescription>
          </DialogHeader>

          <Tabs value={section} onValueChange={(value) => setSection(String(value))}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="folders">
                <Folder />
                Folders
              </TabsTrigger>
              <TabsTrigger value="ai">
                <Sparkles />
                AI sorting
              </TabsTrigger>
            </TabsList>

            <TabsContent value="folders" className="space-y-4 pt-2">
              <form className="flex gap-2" onSubmit={createFolder}>
                <Input
                  aria-label="New folder name"
                  maxLength={80}
                  placeholder="New folder name"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                />
                <Button type="submit" disabled={!newName.trim() || mutation.isPending}>
                  {mutation.isPending && mutation.variables?.type === "create"
                    ? <LoaderCircle className="animate-spin" />
                    : <Plus />}
                  Add
                </Button>
              </form>

              <div className="max-h-[min(23rem,50vh)] overflow-y-auto border-y border-border/70">
                {customFolders.length ? customFolders.map((folder, index) => (
                  <div
                    key={folder.id}
                    className="flex min-h-12 items-center gap-2 border-b border-border/60 px-1 py-2 last:border-b-0"
                  >
                    {editingId === folder.id ? (
                      <form
                        className="flex min-w-0 flex-1 items-center gap-2"
                        onSubmit={(event) => renameFolder(event, folder.id)}
                      >
                        <Input
                          autoFocus
                          aria-label={`Rename ${folder.name}`}
                          maxLength={80}
                          value={editingName}
                          onChange={(event) => setEditingName(event.target.value)}
                        />
                        <ToolbarTooltip label="Save name">
                          <Button
                            type="submit"
                            variant="ghost"
                            size="icon-sm"
                            disabled={!editingName.trim() || mutation.isPending}
                          >
                            <Check />
                            <span className="sr-only">Save name</span>
                          </Button>
                        </ToolbarTooltip>
                        <ToolbarTooltip label="Cancel rename">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            disabled={mutation.isPending}
                            onClick={() => setEditingId(null)}
                          >
                            <X />
                            <span className="sr-only">Cancel rename</span>
                          </Button>
                        </ToolbarTooltip>
                      </form>
                    ) : (
                      <>
                        <Folder className="ml-2 size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {folder.name}
                        </span>
                        <div className="flex shrink-0 items-center">
                          <ToolbarTooltip label="Move up">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              disabled={index === 0 || mutation.isPending}
                              onClick={() => moveFolder(index, -1)}
                            >
                              <ArrowUp />
                              <span className="sr-only">Move {folder.name} up</span>
                            </Button>
                          </ToolbarTooltip>
                          <ToolbarTooltip label="Move down">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              disabled={index === customFolders.length - 1 || mutation.isPending}
                              onClick={() => moveFolder(index, 1)}
                            >
                              <ArrowDown />
                              <span className="sr-only">Move {folder.name} down</span>
                            </Button>
                          </ToolbarTooltip>
                          <ToolbarTooltip label="Rename">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              disabled={mutation.isPending}
                              onClick={() => {
                                setEditingId(folder.id);
                                setEditingName(folder.name);
                              }}
                            >
                              <Pencil />
                              <span className="sr-only">Rename {folder.name}</span>
                            </Button>
                          </ToolbarTooltip>
                          <ToolbarTooltip label="Delete">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="text-destructive"
                              disabled={mutation.isPending}
                              onClick={() => {
                                setOpen(false);
                                setDeleteCandidate(folder);
                              }}
                            >
                              <Trash2 />
                              <span className="sr-only">Delete {folder.name}</span>
                            </Button>
                          </ToolbarTooltip>
                        </div>
                      </>
                    )}
                  </div>
                )) : (
                  <div className="grid min-h-28 place-items-center px-6 text-center text-sm text-muted-foreground">
                    Create a folder to organize Inbox conversations and give AI another destination.
                  </div>
                )}
              </div>

              <DialogFooter showCloseButton />
            </TabsContent>

            <TabsContent value="ai" keepMounted className="space-y-4 pt-2">
              <MailboxAiSettings mailboxId={mailboxId} active={open && section === "ai"} />
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteCandidate)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteCandidate(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteCandidate?.name}?</DialogTitle>
            <DialogDescription>
              The folder will disappear for everyone. Its conversations will return to Inbox.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={<Button type="button" variant="outline" />}
              onClick={() => setOpen(true)}
            >
              Cancel
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => {
                if (deleteCandidate) {
                  mutation.mutate({ type: "delete", folderId: deleteCandidate.id });
                }
              }}
            >
              {mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              Delete folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
