import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, responseJson } from "@/lib/api";
import type {
  MailboxAiConfiguration,
  MailboxAiSettings as MailboxAiSettingsValue,
} from "./types";

export function MailboxAiSettings({
  mailboxId,
  active,
}: {
  mailboxId: string;
  active: boolean;
}) {
  const settings = useQuery({
    queryKey: ["mailbox-ai", mailboxId],
    queryFn: async () => responseJson(
      await api.api.mail.mailboxes[":id"].ai.$get({
        param: { id: mailboxId },
      }),
    ),
    enabled: active,
  });

  if (settings.isLoading) {
    return (
      <div className="space-y-4 py-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  if (settings.isError) {
    return (
      <div className="flex items-center justify-between gap-4 border-y border-border/70 py-4">
        <p className="text-sm text-muted-foreground">Mailbox AI settings are unavailable.</p>
        <Button type="button" variant="outline" onClick={() => void settings.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  return settings.data ? (
    <MailboxAiSettingsForm
      key={`${mailboxId}:${settings.data.settings.configuration.instructions}:${settings.data.settings.configuration.confidenceThreshold}`}
      mailboxId={mailboxId}
      initial={settings.data.settings}
    />
  ) : null;
}

function MailboxAiSettingsForm({
  mailboxId,
  initial,
}: {
  mailboxId: string;
  initial: MailboxAiSettingsValue;
}) {
  const client = useQueryClient();
  const [configuration, setConfiguration] = useState(initial.configuration);
  const save = useMutation({
    mutationFn: async (input: MailboxAiConfiguration) => responseJson(
      await api.api.mail.mailboxes[":id"].ai.$put({
        param: { id: mailboxId },
        json: input,
      }),
    ),
    onSuccess: async (result) => {
      setConfiguration(result.settings.configuration);
      toast.success("Mailbox AI rules updated");
      await client.invalidateQueries({ queryKey: ["mailbox-ai", mailboxId] });
    },
    onError: (error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate(configuration);
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <div className="flex items-start justify-between gap-4 border-y border-border/70 py-4">
        <div>
          <p className="text-sm font-medium">Processing status</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Controlled globally by an administrator. Your settings are preserved while paused.
          </p>
        </div>
        <Badge variant={initial.globalEnabled ? "default" : "outline"}>
          {initial.globalEnabled ? "Enabled" : "Paused"}
        </Badge>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`mailbox-ai-confidence-${mailboxId}`}>
          Minimum confidence
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id={`mailbox-ai-confidence-${mailboxId}`}
            className="w-24 tabular-nums"
            type="number"
            min={50}
            max={100}
            step={5}
            required
            value={configuration.confidenceThreshold}
            onChange={(event) => setConfiguration({
              ...configuration,
              confidenceThreshold: Number(event.target.value),
            })}
          />
          <span className="text-sm text-muted-foreground">%</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Lower-confidence decisions stay in Inbox.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`mailbox-ai-instructions-${mailboxId}`}>
          Classification rules
        </Label>
        <Textarea
          id={`mailbox-ai-instructions-${mailboxId}`}
          className="min-h-32 resize-y"
          maxLength={4_000}
          placeholder="For example: partnership requests go to Product. Treat newsletters as spam only when clearly unsolicited."
          value={configuration.instructions}
          onChange={(event) => setConfiguration({
            ...configuration,
            instructions: event.target.value,
          })}
        />
        <p className="text-xs text-muted-foreground">
          Refer to custom folders by the names shown in navigation. If nothing matches, mail stays in Inbox.
        </p>
      </div>

      <DialogFooter>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
          Save rules
        </Button>
      </DialogFooter>
    </form>
  );
}
