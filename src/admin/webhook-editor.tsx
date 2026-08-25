import { useMutation } from "@tanstack/react-query";
import {
  FlaskConical,
  LoaderCircle,
  RotateCw,
  Save,
  Trash2,
  Webhook,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  webhookEventTypes,
  type WebhookEventType,
} from "../../shared/webhooks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, responseJson } from "@/lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin-panel";
import type { AdminWebhook, WebhookInput } from "./types";

const eventCopy: Record<
  WebhookEventType,
  { label: string; description: string }
> = {
  "email.received": {
    label: "Email received",
    description: "After spam and AI routing, including text and HTML body.",
  },
  "email.sent": {
    label: "Email sent",
    description: "After an outgoing message is persisted and submitted.",
  },
  "user.joined": {
    label: "User joined",
    description: "When an invited user completes registration.",
  },
  "user.updated": {
    label: "User updated",
    description: "Name, role, or account status changed by an administrator.",
  },
  "mailbox.created": {
    label: "Mailbox created",
    description: "A personal or shared mailbox was provisioned.",
  },
  "mailbox.updated": {
    label: "Mailbox updated",
    description: "Display name or shared membership changed.",
  },
  "mailbox.deleted": {
    label: "Mailbox deleted",
    description: "A shared mailbox was permanently removed.",
  },
};

export const webhookEventLabels = Object.fromEntries(
  Object.entries(eventCopy).map(([event, copy]) => [event, copy.label]),
) as Record<WebhookEventType, string>;

const emptyWebhook: WebhookInput = {
  name: "",
  url: "",
  events: ["email.received"],
  enabled: true,
};

export function WebhookEditor({
  webhook,
  onSaved,
  onDeleted,
  onSecret,
}: {
  webhook?: AdminWebhook;
  onSaved: (id: string) => Promise<void>;
  onDeleted: () => Promise<void>;
  onSecret: (secret: string) => void;
}) {
  const [input, setInput] = useState<WebhookInput>(webhook
    ? {
        name: webhook.name,
        url: webhook.url,
        events: webhook.events,
        enabled: webhook.enabled,
      }
    : emptyWebhook);
  const [confirmation, setConfirmation] = useState<"delete" | "rotate" | null>(null);

  const save = useMutation({
    mutationFn: async (payload: WebhookInput) => {
      if (webhook) {
        const result = await responseJson(
          await api.api.admin.webhooks[":id"].$put({
            param: { id: webhook.id },
            json: payload,
          }),
        );
        return { webhook: result.webhook, signingSecret: undefined };
      }
      return responseJson(
        await api.api.admin.webhooks.$post({ json: payload }),
      );
    },
    onSuccess: async (result) => {
      if (result.signingSecret) onSecret(result.signingSecret);
      toast.success(webhook ? "Webhook updated" : "Webhook created");
      await onSaved(result.webhook.id);
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (!webhook) return;
      await responseJson(
        await api.api.admin.webhooks[":id"].$delete({
          param: { id: webhook.id },
        }),
      );
    },
    onSuccess: async () => {
      toast.success("Webhook deleted");
      setConfirmation(null);
      await onDeleted();
    },
    onError: (error) => toast.error(error.message),
  });
  const rotate = useMutation({
    mutationFn: async () => {
      if (!webhook) throw new Error("Save the webhook first");
      return responseJson(
        await api.api.admin.webhooks[":id"]["rotate-secret"].$post({
          param: { id: webhook.id },
        }),
      );
    },
    onSuccess: (result) => {
      setConfirmation(null);
      onSecret(result.signingSecret);
      toast.success("Signing secret rotated");
    },
    onError: (error) => toast.error(error.message),
  });
  const test = useMutation({
    mutationFn: async () => {
      if (!webhook) throw new Error("Save the webhook first");
      return responseJson(
        await api.api.admin.webhooks[":id"].test.$post({
          param: { id: webhook.id },
        }),
      );
    },
    onSuccess: () => toast.success("Test delivery queued"),
    onError: (error) => toast.error(error.message),
  });

  function toggleEvent(event: WebhookEventType, checked: boolean) {
    setInput((current) => ({
      ...current,
      events: checked
        ? [...current.events, event]
        : current.events.filter((candidate) => candidate !== event),
    }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate(input);
  }

  const busy = save.isPending || remove.isPending || rotate.isPending;
  const valid = input.name.trim().length >= 2
    && input.url.startsWith("https://")
    && input.events.length > 0;

  return (
    <>
      <form className={adminPanelClass} onSubmit={submit}>
        <AdminPanelHeader
          Icon={Webhook}
          title={webhook ? webhook.name : "New webhook"}
          description="Every selected event is delivered across the whole account."
        />
        <AdminPanelBody className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="webhook-name">Name</Label>
              <Input
                id="webhook-name"
                value={input.name}
                maxLength={80}
                placeholder="Automation service"
                onChange={(event) => setInput((current) => ({
                  ...current,
                  name: event.target.value,
                }))}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="webhook-url">Endpoint URL</Label>
              <Input
                id="webhook-url"
                type="url"
                value={input.url}
                maxLength={2048}
                placeholder="https://example.com/webhooks/openworkspace"
                className="font-mono text-xs"
                onChange={(event) => setInput((current) => ({
                  ...current,
                  url: event.target.value,
                }))}
              />
              <p className="text-xs text-muted-foreground">HTTPS is required.</p>
            </div>
          </div>

          <fieldset className="space-y-3 border-t border-border/70 pt-5">
            <legend className="text-sm font-semibold">Events</legend>
            <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              {webhookEventTypes.map((event) => (
                <label key={event} className="flex cursor-pointer items-start gap-3">
                  <Checkbox
                    className="mt-0.5"
                    checked={input.events.includes(event)}
                    onCheckedChange={(checked) => toggleEvent(event, checked)}
                  />
                  <span>
                    <span className="block text-sm font-medium">{eventCopy[event].label}</span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                      {eventCopy[event].description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex items-center justify-between gap-6 border-t border-border/70 pt-5">
            <div>
              <p className="text-sm font-medium">Endpoint enabled</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Pausing preserves its URL, events, and delivery history.
              </p>
            </div>
            <Switch
              checked={input.enabled}
              onCheckedChange={(enabled) => setInput((current) => ({
                ...current,
                enabled,
              }))}
            />
          </div>
        </AdminPanelBody>
        <AdminPanelFooter className="justify-between">
          <div className="flex flex-wrap gap-2">
            {webhook ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || test.isPending}
                  onClick={() => test.mutate()}
                >
                  {test.isPending ? <LoaderCircle className="animate-spin" /> : <FlaskConical />}
                  Send test
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirmation("rotate")}
                >
                  <RotateCw /> Rotate secret
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setConfirmation("delete")}
                >
                  <Trash2 /> Delete
                </Button>
              </>
            ) : null}
          </div>
          <Button type="submit" disabled={!valid || busy}>
            {save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
            {webhook ? "Save changes" : "Create webhook"}
          </Button>
        </AdminPanelFooter>
      </form>

      <Dialog open={confirmation !== null} onOpenChange={(open) => {
        if (!open && !busy) setConfirmation(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmation === "delete" ? "Delete webhook?" : "Rotate signing secret?"}
            </DialogTitle>
            <DialogDescription>
              {confirmation === "delete"
                ? "Delivery stops immediately and its recent delivery history is removed."
                : "The current secret stops working immediately. Update the receiving service before sending more events."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={confirmation === "delete" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => confirmation === "delete" ? remove.mutate() : rotate.mutate()}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : null}
              {confirmation === "delete" ? "Delete" : "Rotate secret"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
