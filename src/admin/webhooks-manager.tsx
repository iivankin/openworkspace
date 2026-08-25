import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Clipboard,
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
import { cn } from "@/lib/utils";
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
}: {
  deliveries: AdminWebhookDelivery[];
  webhooks: AdminWebhook[];
}) {
  const endpointNames = new Map(
    webhooks.map((webhook) => [webhook.id, webhook.name]),
  );
  return (
    <section className={adminPanelClass}>
      <div className="border-b border-border/70 bg-surface-sunken/60 px-5 py-4">
        <p className="text-sm font-semibold">Recent deliveries</p>
        <p className="text-xs text-muted-foreground">Latest 50 attempts across the account.</p>
      </div>
      {deliveries.length ? (
        <div className="divide-y divide-border/60">
          {deliveries.map((delivery) => (
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
          ))}
        </div>
      ) : (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          No deliveries yet. Save an endpoint and send a test.
        </p>
      )}
    </section>
  );
}

export function WebhooksManager() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [secret, setSecret] = useState<string>();
  const [copied, setCopied] = useState(false);
  const settings = useQuery({
    queryKey: ["admin-webhooks"],
    queryFn: async () => responseJson(await api.api.admin.webhooks.$get()),
  });

  if (settings.isLoading) {
    return (
      <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <Skeleton className="h-72" />
        <Skeleton className="h-[34rem]" />
      </div>
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
    : webhooks.find((webhook) => webhook.id === selectedId) ?? webhooks[0];
  const editingNew = selectedId === "new" || (!selected && webhooks.length === 0);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["admin-webhooks"] });
  }

  return (
    <>
      <div className="space-y-8">
        <div className="grid gap-8 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside>
            <div className="mb-3 flex items-center justify-between px-1">
              <div>
                <p className="text-sm font-semibold">Endpoints</p>
                <p className="text-xs text-muted-foreground">{webhooks.length} configured</p>
              </div>
              <Button size="sm" onClick={() => setSelectedId("new")}>
                <Plus /> Add endpoint
              </Button>
            </div>
            <div className="divide-y divide-border/60 overflow-hidden rounded-2xl bg-surface shadow-xs ring-1 ring-border">
              {webhooks.map((webhook) => {
                const active = !editingNew && webhook.id === selected?.id;
                return (
                  <button
                    key={webhook.id}
                    type="button"
                    aria-current={active}
                    className={cn(
                      "relative flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors",
                      "before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary before:transition-opacity",
                      active ? "bg-accent/60 before:opacity-100" : "before:opacity-0 hover:bg-accent/40",
                    )}
                    onClick={() => setSelectedId(webhook.id)}
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/12 text-foreground/70">
                      <Webhook className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.8125rem] font-semibold">{webhook.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{webhook.url}</span>
                    </span>
                    {!webhook.enabled ? <Badge variant="outline">Off</Badge> : null}
                  </button>
                );
              })}
              {!webhooks.length ? (
                <p className="px-4 py-10 text-center text-xs text-muted-foreground">
                  No webhook endpoints yet
                </p>
              ) : null}
            </div>
          </aside>

          <section className="min-w-0">
            <WebhookEditor
              key={editingNew ? "new" : selected?.id}
              webhook={editingNew ? undefined : selected}
              onSecret={(value) => {
                setCopied(false);
                setSecret(value);
              }}
              onSaved={async (id) => {
                await refresh();
                setSelectedId(id);
              }}
              onDeleted={async () => {
                await refresh();
                setSelectedId("new");
              }}
            />
          </section>
        </div>

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => void settings.refetch()} disabled={settings.isFetching}>
            {settings.isFetching ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            Refresh deliveries
          </Button>
        </div>
        <DeliveryHistory deliveries={deliveries} webhooks={webhooks} />
      </div>

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
