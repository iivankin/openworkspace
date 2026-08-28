import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  Clipboard,
  History,
  LoaderCircle,
  Plus,
  RefreshCw,
  Webhook,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { WebhookEventType } from "../../shared/webhooks";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, responseJson } from "@/lib/api";
import { adminPanelClass } from "./admin-panel";
import type { AdminWebhook, AdminWebhookDelivery } from "./types";
import { WebhookEditor, webhookEventLabels } from "./webhook-editor";

function formatDate(value: string | Date | null) {
  if (!value) return "Not attempted";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function DeliveryHistory({
  deliveries,
  webhooks,
  refreshing,
  onRefresh,
}: {
  deliveries: AdminWebhookDelivery[];
  webhooks: AdminWebhook[];
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const endpointNames = new Map(
    webhooks.map((webhook) => [webhook.id, webhook.name]),
  );
  return (
    <section>
      <div className="flex items-end justify-between gap-4 px-1">
        <div>
          <p className="text-sm font-semibold">Recent deliveries</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Latest 50 attempts across the account.</p>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          Refresh
        </Button>
      </div>
      <div className="mt-3 divide-y divide-border/70 border-y border-border/70">
        {deliveries.length ? (
          deliveries.map((delivery) => (
            <div key={delivery.id} className="grid gap-2 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium">
                    {delivery.eventType === "webhook.test"
                      ? "Webhook test"
                      : webhookEventLabels[delivery.eventType as WebhookEventType] ?? delivery.eventType}
                  </p>
                  <Badge variant={delivery.status === "delivered" ? "success" : delivery.status === "failed" ? "destructive" : "outline"}>
                    {delivery.status}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {endpointNames.get(delivery.webhookId) ?? "Deleted endpoint"}
                  {delivery.responseStatus ? ` · HTTP ${delivery.responseStatus}` : ""}
                  {` · ${delivery.attempts} ${delivery.attempts === 1 ? "attempt" : "attempts"}`}
                </p>
                {delivery.error ? (
                  <p className="mt-1 truncate font-mono text-[11px] text-destructive">{delivery.error}</p>
                ) : null}
                {delivery.responseBody ? (
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {delivery.responseBody}
                  </p>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground sm:text-right">
                {formatDate(delivery.lastAttemptAt ?? delivery.createdAt)}
              </p>
            </div>
          ))
        ) : (
          <div className="flex items-center gap-3 px-1 py-5 text-muted-foreground">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-sunken">
              <History className="size-4" />
            </span>
            <p className="text-sm">No deliveries yet</p>
          </div>
        )}
      </div>
    </section>
  );
}

export function WebhooksManager({
  selectedId,
  onSelect,
}: {
  selectedId?: string;
  onSelect: (id?: string) => void;
}) {
  const queryClient = useQueryClient();
  const [secret, setSecret] = useState<string>();
  const [copied, setCopied] = useState(false);
  const settings = useQuery({
    queryKey: ["admin-webhooks"],
    queryFn: async () => responseJson(await api.api.admin.webhooks.$get()),
  });

  if (settings.isLoading) {
    return (
      <Skeleton className={selectedId ? "h-[34rem] max-w-3xl" : "h-72 max-w-3xl"} />
    );
  }
  if (settings.isError) {
    return (
      <div className={`${adminPanelClass} p-8 text-center`}>
        <p className="text-sm text-destructive">Could not load webhook settings.</p>
        <Button className="mt-4" variant="outline" onClick={() => void settings.refetch()}>
          <RefreshCw /> Retry
        </Button>
      </div>
    );
  }

  const webhooks = settings.data?.webhooks ?? [];
  const deliveries = settings.data?.deliveries ?? [];
  const selected = selectedId === "new"
    ? undefined
    : webhooks.find((webhook) => webhook.id === selectedId);
  const editingNew = selectedId === "new";

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["admin-webhooks"] });
  }

  return (
    <>
      {!selectedId ? (
        <div className="max-w-3xl space-y-10">
          <section>
            <div className="flex items-end justify-between gap-4 px-1">
              <div>
                <p className="text-sm font-semibold">Endpoints</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{webhooks.length} configured</p>
              </div>
              <Button size="sm" onClick={() => onSelect("new")}>
                <Plus /> Add endpoint
              </Button>
            </div>
            <div className="mt-3 divide-y divide-border/70 border-y border-border/70">
              {webhooks.map((webhook) => (
                <button
                  key={webhook.id}
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/45"
                  onClick={() => onSelect(webhook.id)}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
                    <Webhook className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{webhook.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{webhook.url}</span>
                  </span>
                  {!webhook.enabled ? <Badge variant="outline">Off</Badge> : null}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
              {!webhooks.length ? (
                <div className="flex items-center gap-3 px-1 py-5 text-muted-foreground">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-sunken">
                    <Webhook className="size-4" />
                  </span>
                  <p className="text-sm">No webhook endpoints yet</p>
                </div>
              ) : null}
            </div>
          </section>

          <DeliveryHistory
            deliveries={deliveries}
            webhooks={webhooks}
            refreshing={settings.isFetching}
            onRefresh={() => void settings.refetch()}
          />
        </div>
      ) : selectedId !== "new" && !selected ? (
        <div className={`${adminPanelClass} max-w-3xl px-6 py-12 text-center`}>
          <p className="text-sm text-muted-foreground">Webhook endpoint not found.</p>
        </div>
      ) : (
        <div className="max-w-3xl">
          <WebhookEditor
            key={editingNew ? "new" : selected?.id}
            webhook={editingNew ? undefined : selected}
            onSecret={(value) => {
              setCopied(false);
              setSecret(value);
            }}
            onSaved={async (id) => {
              await refresh();
              onSelect(id);
            }}
            onDeleted={async () => {
              await refresh();
              onSelect();
            }}
          />
        </div>
      )}

      <Dialog open={Boolean(secret)} onOpenChange={(open) => {
        if (!open) setSecret(undefined);
      }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Copy the signing secret</DialogTitle>
            <DialogDescription>
              This secret will not be shown again. Store it in the receiving service before closing this window.
            </DialogDescription>
          </DialogHeader>
          <div className="bg-surface-sunken p-4 font-mono text-xs leading-relaxed break-all ring-1 ring-border">
            {secret}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Verify <code className="font-mono text-foreground/75">x-openworkspace-signature</code> as HMAC-SHA256 of
            <code className="ml-1 font-mono text-foreground/75">timestamp.raw_body</code>, using
            <code className="ml-1 font-mono text-foreground/75">x-openworkspace-timestamp</code>.
          </p>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                if (!secret) return;
                void navigator.clipboard.writeText(secret).then(() => {
                  setCopied(true);
                  toast.success("Signing secret copied");
                }).catch(() => toast.error("Signing secret could not be copied"));
              }}
            >
              {copied ? <Check /> : <Clipboard />}
              {copied ? "Copied" : "Copy secret"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
