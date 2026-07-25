import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  LoaderCircle,
  Plus,
  RotateCw,
  Save,
  Shield,
  Trash2,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { oidcScopes, type OidcScope } from "../../shared/oidc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, responseJson } from "@/lib/api";
import type {
  AdminGroup,
  AdminOidcClient,
  AdminUser,
} from "./types";

type ClientInput = {
  name: string;
  clientType: "public" | "confidential";
  accessPolicy: "all_active_users" | "selected_users";
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  allowedOrigins: string[];
  allowedScopes: OidcScope[];
  trusted: boolean;
  enabled: boolean;
  assignedUserIds: string[];
  exposedGroupIds: string[];
};

const emptyClient: ClientInput = {
  name: "",
  clientType: "confidential",
  accessPolicy: "selected_users",
  redirectUris: [],
  postLogoutRedirectUris: [],
  allowedOrigins: [],
  allowedScopes: ["openid", "profile", "email"],
  trusted: false,
  enabled: true,
  assignedUserIds: [],
  exposedGroupIds: [],
};

export function SsoApplications({
  clients,
  users,
  groups,
  loading = false,
}: {
  clients: AdminOidcClient[];
  users: AdminUser[];
  groups: AdminGroup[];
  loading?: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [secret, setSecret] = useState<string>();
  const selected = selectedId === "new"
    ? undefined
    : clients.find((client) => client.id === selectedId) ?? clients[0];

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["admin-state"] });
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">SSO applications</p>
            <p className="text-xs text-muted-foreground">{clients.length} registered</p>
          </div>
          <Button
            size="icon-sm"
            aria-label="Create SSO application"
            onClick={() => {
              setSelectedId("new");
              setSecret(undefined);
            }}
          >
            <Plus />
          </Button>
        </div>
        <div className="divide-y border-y">
          {clients.map((client) => (
            <button
              key={client.id}
              type="button"
              className="flex w-full items-center gap-3 py-3 text-left"
              onClick={() => {
                setSelectedId(client.id);
                setSecret(undefined);
              }}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
                <Shield className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{client.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {client.id}
                </span>
              </span>
              {!client.enabled && <Badge variant="secondary">Off</Badge>}
            </button>
          ))}
          {clients.length === 0 && (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No applications yet
            </p>
          )}
        </div>
      </aside>

      <section className="min-w-0">
        <ClientEditor
          key={selected?.id ?? "new"}
          client={selected}
          users={users}
          groups={groups}
          secret={secret}
          onSecret={setSecret}
          onSaved={async (clientId) => {
            await refresh();
            setSelectedId(clientId);
          }}
          onDeleted={async () => {
            await refresh();
            setSelectedId("new");
            setSecret(undefined);
          }}
        />
      </section>
    </div>
  );
}

function ClientEditor({
  client,
  users,
  groups,
  secret,
  onSecret,
  onSaved,
  onDeleted,
}: {
  client?: AdminOidcClient;
  users: AdminUser[];
  groups: AdminGroup[];
  secret?: string;
  onSecret: (value: string | undefined) => void;
  onSaved: (clientId: string) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const initial: ClientInput = client
    ? {
      name: client.name,
      clientType: client.clientType,
      accessPolicy: client.accessPolicy,
      redirectUris: client.redirectUris,
      postLogoutRedirectUris: client.postLogoutRedirectUris,
      allowedOrigins: client.allowedOrigins,
      allowedScopes: client.allowedScopes as OidcScope[],
      trusted: client.trusted,
      enabled: client.enabled,
      assignedUserIds: client.assignedUserIds,
      exposedGroupIds: client.exposedGroupIds,
    }
    : emptyClient;
  const [input, setInput] = useState(initial);
  const [redirectUris, setRedirectUris] = useState(initial.redirectUris.join("\n"));
  const [logoutUris, setLogoutUris] = useState(
    initial.postLogoutRedirectUris.join("\n"),
  );
  const [origins, setOrigins] = useState(initial.allowedOrigins.join("\n"));
  const [copied, setCopied] = useState(false);

  const save = useMutation({
    mutationFn: async (payload: ClientInput) => {
      if (client) {
        await responseJson(
          await api.api.admin["oidc-clients"][":id"].$patch({
            param: { id: client.id },
            json: payload,
          }),
        );
        return { clientId: client.id, clientSecret: undefined };
      }
      return responseJson(
        await api.api.admin["oidc-clients"].$post({ json: payload }),
      );
    },
    onSuccess: async (result) => {
      if (result.clientSecret) onSecret(result.clientSecret);
      toast.success(client ? "SSO application updated" : "SSO application created");
      await onSaved(result.clientId);
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (!client) return;
      await responseJson(
        await api.api.admin["oidc-clients"][":id"].$delete({
          param: { id: client.id },
        }),
      );
    },
    onSuccess: async () => {
      toast.success("SSO application deleted");
      await onDeleted();
    },
    onError: (error) => toast.error(error.message),
  });
  const rotate = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error("Save the application first");
      return responseJson(
        await api.api.admin["oidc-clients"][":id"]["rotate-secret"].$post({
          param: { id: client.id },
        }),
      );
    },
    onSuccess: (result) => {
      onSecret(result.clientSecret);
      toast.success("Client secret rotated");
    },
    onError: (error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate({
      ...input,
      redirectUris: lines(redirectUris),
      postLogoutRedirectUris: lines(logoutUris),
      allowedOrigins: lines(origins),
      assignedUserIds:
        input.accessPolicy === "selected_users"
          ? input.assignedUserIds
          : [],
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="mb-6 flex items-start justify-between gap-4 border-b pb-5">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {client ? client.id : "New client"}
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight">
            {client?.name ?? "Register application"}
          </h2>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Enabled
          <Switch
            checked={input.enabled}
            onCheckedChange={(enabled) => setInput({ ...input, enabled })}
          />
        </label>
      </div>

      {secret && (
        <div className="mb-6 border-y bg-muted/25 py-4">
          <p className="text-sm font-semibold">Copy this secret now</p>
          <p className="mt-1 text-xs text-muted-foreground">
            It is stored only as a hash and cannot be shown again.
          </p>
          <div className="mt-3 flex gap-2">
            <Input className="font-mono text-xs" readOnly value={secret} />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => {
                void navigator.clipboard.writeText(secret);
                setCopied(true);
              }}
            >
              {copied ? <Check /> : <Copy />}
              <span className="sr-only">Copy client secret</span>
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="oidc-name">Application name</Label>
          <Input
            id="oidc-name"
            className="mt-1.5"
            value={input.name}
            onChange={(event) => setInput({ ...input, name: event.target.value })}
            required
          />
        </div>
        <div>
          <Label>Client type</Label>
          <Select
            value={input.clientType}
            disabled={Boolean(client)}
            onValueChange={(clientType) =>
              setInput({
                ...input,
                clientType: clientType as ClientInput["clientType"],
              })}
          >
            <SelectTrigger className="mt-1.5 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="confidential">Confidential web app</SelectItem>
              <SelectItem value="public">Public browser app</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <UriField
        id="redirect-uris"
        label="Redirect URIs"
        value={redirectUris}
        onChange={setRedirectUris}
        required
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <UriField
          id="logout-uris"
          label="Post-logout URIs"
          value={logoutUris}
          onChange={setLogoutUris}
        />
        <UriField
          id="allowed-origins"
          label="Browser origins"
          value={origins}
          onChange={setOrigins}
        />
      </div>

      <fieldset className="mt-6 border-y py-4">
        <legend className="px-2 text-sm font-semibold">Allowed scopes</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {oidcScopes.map((scope) => (
            <label key={scope} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={input.allowedScopes.includes(scope)}
                disabled={scope === "openid"}
                onCheckedChange={(checked) =>
                  setInput({
                    ...input,
                    allowedScopes: checked
                      ? [...input.allowedScopes, scope]
                      : input.allowedScopes.filter((item) => item !== scope),
                  })}
              />
              <span className="font-mono text-xs">{scope}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <Label>Application access</Label>
          <Select
            value={input.accessPolicy}
            onValueChange={(accessPolicy) =>
              setInput({
                ...input,
                accessPolicy: accessPolicy as ClientInput["accessPolicy"],
              })}
          >
            <SelectTrigger className="mt-1.5 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="selected_users">Selected users</SelectItem>
              <SelectItem value="all_active_users">All active users</SelectItem>
            </SelectContent>
          </Select>
          {input.accessPolicy === "selected_users" && (
            <SelectionList
              label="Assigned users"
              items={users
                .filter((user) => user.status === "active")
                .map((user) => ({
                  id: user.id,
                  label: user.name,
                  detail: user.personalEmail ?? undefined,
                }))}
              value={input.assignedUserIds}
              onChange={(assignedUserIds) =>
                setInput({ ...input, assignedUserIds })}
            />
          )}
        </div>
        <div>
          <Label>Groups claim allowlist</Label>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Membership never grants application access. Only selected groups are disclosed.
          </p>
          <SelectionList
            label="Exposed groups"
            items={groups.map((group) => ({
              id: group.id,
              label: group.name,
              detail: group.slug,
            }))}
            value={input.exposedGroupIds}
            onChange={(exposedGroupIds) =>
              setInput({ ...input, exposedGroupIds })}
          />
        </div>
      </div>

      <label className="mt-6 flex items-center justify-between gap-4 border-y py-3">
        <span>
          <span className="block text-sm font-medium">Trusted application</span>
          <span className="block text-xs text-muted-foreground">
            Skip consent after the user has authenticated.
          </span>
        </span>
        <Switch
          checked={input.trusted}
          onCheckedChange={(trusted) => setInput({ ...input, trusted })}
        />
      </label>

      <div className="mt-6 flex flex-wrap justify-between gap-3">
        <div className="flex gap-2">
          {client?.clientType === "confidential" && (
            <Button
              type="button"
              variant="outline"
              disabled={rotate.isPending}
              onClick={() => rotate.mutate()}
            >
              {rotate.isPending
                ? <LoaderCircle className="animate-spin" />
                : <RotateCw />}
              Rotate secret
            </Button>
          )}
          {client && (
            <Button
              type="button"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete ${client.name}?`)) remove.mutate();
              }}
            >
              <Trash2 /> Delete
            </Button>
          )}
        </div>
        <Button disabled={save.isPending || !input.name || !redirectUris.trim()}>
          {save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
          {client ? "Save application" : "Create application"}
        </Button>
      </div>
    </form>
  );
}

function UriField({
  id,
  label,
  value,
  onChange,
  required = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <div className="mt-4">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        className="mt-1.5 min-h-20 font-mono text-xs"
        placeholder="https://app.example.com/callback"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
      />
      <p className="mt-1 text-[11px] text-muted-foreground">One exact URI per line.</p>
    </div>
  );
}

function SelectionList({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: Array<{ id: string; label: string; detail?: string }>;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="mt-3 max-h-56 overflow-y-auto border-y">
      <legend className="sr-only">{label}</legend>
      {items.map((item) => (
        <label key={item.id} className="flex items-center gap-3 border-b py-2 last:border-0">
          <Checkbox
            checked={value.includes(item.id)}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...value, item.id]
                  : value.filter((id) => id !== item.id),
              )}
          />
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium">{item.label}</span>
            {item.detail && (
              <span className="block truncate text-[11px] text-muted-foreground">
                {item.detail}
              </span>
            )}
          </span>
        </label>
      ))}
      {items.length === 0 && (
        <p className="py-4 text-center text-xs text-muted-foreground">None available</p>
      )}
    </fieldset>
  );
}

function lines(value: string) {
  return [...new Set(
    value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  )];
}
