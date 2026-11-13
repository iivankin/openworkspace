import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  responseJson,
} from "@open-workspace/core/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, LoaderCircle, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { mailApi } from "../lib/mail-api";
import { ToolbarTooltip } from "./toolbar-tooltip";

const PRESET_DAYS = [7, 30, 90];

function plural(count: number) {
  return `${count} ${count === 1 ? "conversation" : "conversations"}`;
}

/** The server deletes in batches; keeps asking until nothing is left. */
async function emptyAll(mailboxId: string, folder: "trash" | "spam") {
  let deleted = 0;

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each batch deletes what the last one left
    const result = await responseJson(
      // oxlint-disable-next-line eslint/no-await-in-loop -- same request as above
      await mailApi.api.mail.mailboxes[":id"].folders[":folder"].empty.$post({
        param: { id: mailboxId, folder },
      })
    );

    deleted += result.deleted;

    if (!result.remaining || !result.deleted) return deleted;
  }
}

/** Auto-delete and "Empty" for Trash and Spam; shown only with send access. */
export function FolderCleanupMenu({
  mailboxId,
  folder,
  folderName,
  conversationCount,
}: {
  mailboxId: string;
  folder: "trash" | "spam";
  folderName: string;
  conversationCount: number;
}) {
  const client = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [emptying, setEmptying] = useState(false);

  const retention = useQuery({
    queryKey: ["mailbox-retention", mailboxId],
    queryFn: async () =>
      (
        await responseJson(
          await mailApi.api.mail.mailboxes[":id"].retention.$get({
            param: { id: mailboxId },
          })
        )
      ).retention,
  });

  const key = folder === "trash" ? "trashDays" : "spamDays";
  const days = retention.data?.[key] ?? null;

  const options =
    days && !PRESET_DAYS.includes(days)
      ? [...PRESET_DAYS, days].toSorted((a, b) => a - b)
      : PRESET_DAYS;

  async function setDays(value: string) {
    if (!retention.data) return;

    try {
      await responseJson(
        await mailApi.api.mail.mailboxes[":id"].retention.$put({
          param: { id: mailboxId },
          json: {
            ...retention.data,
            [key]: value === "never" ? null : Number(value),
          },
        })
      );
      await client.invalidateQueries({
        queryKey: ["mailbox-retention", mailboxId],
      });
      toast.success(
        value === "never"
          ? `${folderName} is kept until you empty it`
          : `${folderName} now deletes conversations after ${value} days`
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Auto-delete wasn't saved"
      );
    }
  }

  async function empty() {
    setConfirmOpen(false);
    setEmptying(true);

    try {
      toast.success(
        `${plural(await emptyAll(mailboxId, folder))} deleted permanently`
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `${folderName} couldn't be emptied`
      );
    }

    setEmptying(false);
    await Promise.all([
      client.invalidateQueries({ queryKey: ["conversations", mailboxId] }),
      client.invalidateQueries({ queryKey: ["folders", mailboxId] }),
    ]);
  }

  return (
    <>
      <DropdownMenu>
        <ToolbarTooltip label={`${folderName} options`} side="bottom">
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" className="size-7" />
            }
            aria-label={`${folderName} options`}
            disabled={emptying}
          >
            {emptying ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Ellipsis />
            )}
          </DropdownMenuTrigger>
        </ToolbarTooltip>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Delete automatically</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={days ? String(days) : "never"}
              onValueChange={(value: string) => void setDays(value)}
            >
              <DropdownMenuRadioItem
                value="never"
                disabled={!retention.data}
                closeOnClick
              >
                Never
              </DropdownMenuRadioItem>
              {options.map((option) => (
                <DropdownMenuRadioItem
                  key={option}
                  value={String(option)}
                  disabled={!retention.data}
                  closeOnClick
                >
                  After {option} days
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={conversationCount === 0}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 /> Empty {folderName}…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Empty {folderName}?</AlertDialogTitle>
            <AlertDialogDescription>
              All {plural(conversationCount)} in {folderName} and their
              attachments will be deleted for everyone. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              onClick={() => void empty()}
            >
              Empty {folderName}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
