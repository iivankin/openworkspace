import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plus, Save, Trash2, UsersRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { api, responseJson } from "@/lib/api";
import type { AdminGroup, AdminUser } from "./types";

export function GroupsManager({
  groups,
  users,
  loading = false,
}: {
  groups: AdminGroup[];
  users: AdminUser[];
  loading?: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const selected = selectedId === "new"
    ? undefined
    : groups.find((group) => group.id === selectedId) ?? groups[0];

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
            <p className="text-sm font-semibold">Identity groups</p>
            <p className="text-xs text-muted-foreground">{groups.length} groups</p>
          </div>
          <Button
            size="icon-sm"
            aria-label="Create group"
            onClick={() => setSelectedId("new")}
          >
            <Plus />
          </Button>
        </div>
        <div className="divide-y border-y">
          {groups.map((group) => (
            <button
              key={group.id}
              type="button"
              className="flex w-full items-center gap-3 py-3 text-left"
              onClick={() => setSelectedId(group.id)}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
                <UsersRound className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{group.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {group.slug}
                </span>
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {group.memberIds.length}
              </span>
            </button>
          ))}
          {groups.length === 0 && (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No identity groups
            </p>
          )}
        </div>
      </aside>
      <GroupEditor
        key={selected?.id ?? "new"}
        group={selected}
        users={users}
        onSaved={async (id) => {
          await refresh();
          setSelectedId(id);
        }}
        onDeleted={async () => {
          await refresh();
          setSelectedId("new");
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
    <form onSubmit={submit}>
      <div className="mb-6 border-b pb-5">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          {group ? group.id : "New group"}
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">
          {group?.name ?? "Create identity group"}
        </h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="group-name">Display name</Label>
          <Input
            id="group-name"
            className="mt-1.5"
            value={name}
            onChange={(event) => {
              const next = event.target.value;
              setName(next);
              if (!slugEdited) setSlug(toSlug(next));
            }}
            required
          />
        </div>
        <div>
          <Label htmlFor="group-slug">Claim slug</Label>
          <Input
            id="group-slug"
            className="mt-1.5 font-mono"
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
      <div className="mt-4">
        <Label htmlFor="group-description">Description</Label>
        <Textarea
          id="group-description"
          className="mt-1.5"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What this group represents"
        />
      </div>

      <fieldset className="mt-6 max-h-80 overflow-y-auto border-y">
        <legend className="px-2 text-sm font-semibold">Members</legend>
        {users.map((user) => (
          <label key={user.id} className="flex items-center gap-3 border-b py-2.5 last:border-0">
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
              <span className="block truncate text-sm font-medium">{user.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {user.personalEmail}
              </span>
            </span>
            <span className="text-[11px] text-muted-foreground">{user.status}</span>
          </label>
        ))}
      </fieldset>

      <div className="mt-6 flex justify-between gap-3">
        <div>
          {group && (
            <Button
              type="button"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete ${group.name}?`)) remove.mutate();
              }}
            >
              <Trash2 /> Delete
            </Button>
          )}
        </div>
        <Button disabled={save.isPending || !name || !slug}>
          {save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
          {group ? "Save group" : "Create group"}
        </Button>
      </div>
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
