import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, FileKey2, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, responseJson } from "@/lib/api";
import { adminPanelClass } from "./admin-panel";
import { CopyableValueRow } from "./copyable-value-row";
import { SamlApplicationForm } from "./saml-application-form";
import type {
  AdminGroup,
  AdminSamlApplication,
  AdminSamlProvider,
  AdminUser,
} from "./types";

export function SamlApplications({
  applications,
  provider,
  users,
  groups,
  loading,
  selectedId,
  onSelect,
}: {
  applications: AdminSamlApplication[];
  provider: AdminSamlProvider;
  users: AdminUser[];
  groups: AdminGroup[];
  loading: boolean;
  selectedId?: string;
  onSelect: (id?: string) => void;
}) {
  const queryClient = useQueryClient();
  const selected = selectedId === "new"
    ? undefined
    : applications.find((application) => application.id === selectedId);
  const details = useQuery({
    queryKey: ["saml-application", selected?.id],
    enabled: Boolean(selected),
    gcTime: 0,
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      if (!selected) throw new Error("SAML application is not selected");
      return responseJson(
        await api.api.admin["saml-applications"][":id"].$get({
          param: { id: selected.id },
        }),
      );
    },
  });

  async function refresh(applicationId: string) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-state"] }),
      queryClient.invalidateQueries({
        queryKey: ["saml-application", applicationId],
      }),
    ]);
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (!selectedId) {
    return (
      <div className="max-w-3xl space-y-6">
        <ProviderEndpoints provider={provider} />
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 px-1">
            <p className="text-xs text-muted-foreground">
              {applications.length} registered
            </p>
            <Button size="sm" onClick={() => onSelect("new")}>
              <Plus /> Add application
            </Button>
          </div>
          <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface">
            {applications.map((application) => (
              <button
                key={application.id}
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/45"
                onClick={() => onSelect(application.id)}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
                  <FileKey2 className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {application.name}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {application.entityId}
                  </span>
                </span>
                {!application.enabled ? <Badge variant="outline">Off</Badge> : null}
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
            {applications.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                No SAML applications
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (selectedId !== "new" && !selected) {
    return (
      <div className={`${adminPanelClass} max-w-3xl px-6 py-12 text-center`}>
        <p className="text-sm text-muted-foreground">SAML application not found.</p>
      </div>
    );
  }

  if (selected && details.isPending) {
    return <Skeleton className="h-96 max-w-3xl" />;
  }

  if (selected && (details.isError || !details.data)) {
    return (
      <div className={`${adminPanelClass} max-w-3xl px-6 py-12 text-center`}>
        <p className="text-sm text-muted-foreground">SAML application unavailable.</p>
        <Button className="mt-4" variant="outline" onClick={() => void details.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <SamlApplicationForm
      key={selected?.id ?? "new"}
      application={selected && details.data
        ? { ...selected, ...details.data }
        : undefined}
      provider={provider}
      users={users}
      groups={groups}
      onSaved={async (applicationId) => {
        await refresh(applicationId);
        onSelect(applicationId);
      }}
      onDeleted={async () => {
        await queryClient.invalidateQueries({ queryKey: ["admin-state"] });
        if (selected) {
          queryClient.removeQueries({
            queryKey: ["saml-application", selected.id],
          });
        }
        onSelect(undefined);
      }}
    />
  );
}

function ProviderEndpoints({ provider }: { provider: AdminSamlProvider }) {
  const status = provider.configured
    ? "Configured"
    : provider.configurationError?.includes("not configured")
      ? "Not configured"
      : "Invalid configuration";
  return (
    <section className={adminPanelClass}>
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-3.5">
        <p className="text-sm font-semibold">Identity provider</p>
        <Badge variant={provider.configured ? "success" : "outline"}>
          {status}
        </Badge>
      </div>
      {provider.configurationError ? (
        <p className="border-b border-border/60 px-5 py-3 text-xs text-destructive">
          {provider.configurationError}
        </p>
      ) : null}
      <div className="divide-y divide-border/60 px-5">
        <CopyableValueRow label="Entity ID" value={provider.entityId} />
        <CopyableValueRow label="Metadata" value={provider.metadataUrl} />
        <CopyableValueRow label="SSO URL" value={provider.ssoUrl} />
      </div>
    </section>
  );
}
