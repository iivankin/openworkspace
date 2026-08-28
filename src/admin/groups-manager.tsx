import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, LoaderCircle, Plus, Save, Trash2, UsersRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, responseJson } from "@/lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
} from "./admin-panel";
import type { AdminGroup, AdminUser } from "./types";

export function GroupsManager({
  groups,
  users,
  loading = false,
  selectedId,
  onSelect,
}: {
  groups: AdminGroup[];
  users: AdminUser[];
  loading?: boolean;
  selectedId?: string;
  onSelect: (id?: string) => void;
}) {
  const queryClient = useQueryClient();
  const selected = selectedId === "new"
    ? undefined
    : groups.find((group) => group.id === selectedId);

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

  if (!selectedId) {
    return (
      <div className="max-w-3xl space-y-3">
        <div className="flex items-center justify-between gap-4 px-1">
          <p className="text-xs text-muted-foreground">{groups.length} groups</p>
          <Button size="sm" onClick={() => onSelect("new")}>
            <Plus /> Add group
          </Button>
        </div>
        <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface">
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-accent/45"
              onClick={() => onSelect(group.id)}
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
                <UsersRound className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{group.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {group.slug}
                </span>
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {group.memberIds.length}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
          {groups.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No identity groups
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  if (selectedId !== "new" && !selected) {
    return (
      <div className={`${adminPanelClass} max-w-3xl px-6 py-12 text-center`}>
        <p className="text-sm text-muted-foreground">Identity group not found.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <GroupEditor
        key={selected?.id ?? "new"}
        group={selected}
        users={users}
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
  );
}

function GroupEditor({
  group,
  users,
  onSaved,
  onDeleted,
}: {
  group?: AdminGroup;
  users: AdminUser[];
  onSaved: (groupId: string) => Promise<void>;
  onDeleted: () => Promise<void>;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [slug, setSlug] = useState(group?.slug ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [memberIds, setMemberIds] = useState(group?.memberIds ?? []);
  const [slugEdited, setSlugEdited] = useState(Boolean(group));

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name,
        slug,
        description: description.trim() || null,
        memberIds,
      };
      if (group) {
        await responseJson(
          await api.api.admin.groups[":id"].$patch({
            param: { id: group.id },
            json: payload,
          }),
        );
        return { groupId: group.id };
      }
      return responseJson(await api.api.admin.groups.$post({ json: payload }));
    },
    onSuccess: async ({ groupId }) => {
      toast.success(group ? "Group updated" : "Group created");
      await onSaved(groupId);
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (!group) return;
      await responseJson(
        await api.api.admin.groups[":id"].$delete({
          param: { id: group.id },
        }),
      );
    },
    onSuccess: async () => {
      toast.success("Group deleted");
      await onDeleted();
    },
    onError: (error) => toast.error(error.message),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form className={adminPanelClass} onSubmit={submit}>
      <div className="border-b border-border/70 bg-surface-sunken/60 px-5 py-4">
        <p className="font-mono text-[11px] tracking-[0.06em] text-muted-foreground">
          {group ? group.id : "New group"}
        </p>
        <h2 className="mt-1.5 text-lg font-semibold tracking-[-0.02em]">
          {group?.name ?? "Create identity group"}
        </h2>
      </div>
      <AdminPanelBody className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="group-name">Display name</Label>
          <Input
            id="group-name"
            value={name}
            onChange={(event) => {
              const next = event.target.value;
              setName(next);
              if (!slugEdited) setSlug(toSlug(next));
            }}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="group-slug">Claim slug</Label>
          <Input
            id="group-slug"
            className="font-mono"
            value={slug}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value.toLowerCase());
            }}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            required
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="group-description">Description</Label>
        <Textarea
          id="group-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What this group represents"
        />
      </div>

      <fieldset>
        <legend className="mb-2.5 text-[0.8125rem] font-semibold text-foreground/85">Members</legend>
        <div className="max-h-80 divide-y divide-border/60 overflow-y-auto rounded-xl bg-surface-sunken/50 ring-1 ring-border">
          {users.map((user) => (
            <label
              key={user.id}
              className="flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-accent/40"
            >
              <Checkbox
                checked={memberIds.includes(user.id)}
                onCheckedChange={(checked) =>
                  setMemberIds(
                    checked
                      ? [...memberIds, user.id]
                      : memberIds.filter((id) => id !== user.id),
                  )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.8125rem] font-semibold">{user.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {user.personalEmail}
                </span>
              </span>
              <span className="text-[11px] text-muted-foreground capitalize">{user.status}</span>
            </label>
          ))}
        </div>
      </fieldset>
      </AdminPanelBody>

      <AdminPanelFooter className={group ? "justify-between" : undefined}>
        {group && (
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(`Delete ${group.name}?`)) remove.mutate();
            }}
          >
            <Trash2 /> Delete
          </Button>
        )}
        <Button type="submit" disabled={save.isPending || !name || !slug}>
          {save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
          {group ? "Save group" : "Create group"}
        </Button>
      </AdminPanelFooter>
    </form>
  );
}

function toSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}
