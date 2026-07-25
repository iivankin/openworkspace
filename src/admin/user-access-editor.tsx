import { KeyRound, LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { AdminUser, UpdateUserInput } from "./types";

export function UserAccessEditor({
  user,
  pending,
  accessLinkPending,
  onSubmit,
  onCreateAccessLink,
}: {
  user: AdminUser;
  pending: boolean;
  accessLinkPending: boolean;
  onSubmit: (input: UpdateUserInput) => void;
  onCreateAccessLink: () => void;
}) {
  const [name, setName] = useState(user.name);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [active, setActive] = useState(user.status === "active");

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({
      name,
      avatarUrl: avatarUrl.trim() || null,
      ...(user.status === "invited"
        ? {}
        : { status: active ? "active" as const : "disabled" as const }),
    });
  }

  return (
    <form className="my-6 border-y bg-muted/25 py-5" onSubmit={submit}>
      <div className="mb-4 flex items-start gap-3">
        <Avatar className="size-10">
          <AvatarImage src={avatarUrl || undefined} />
          <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Manage {user.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            Personal mailbox: {user.personalEmail}
          </p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`user-name-${user.id}`}>Name</Label>
          <Input
            id={`user-name-${user.id}`}
            className="mt-1.5 bg-background"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor={`user-avatar-${user.id}`}>Avatar URL</Label>
          <Input
            id={`user-avatar-${user.id}`}
            className="mt-1.5 bg-background"
            type="url"
            placeholder="Optional"
            value={avatarUrl}
            onChange={(event) => setAvatarUrl(event.target.value)}
          />
        </div>
      </div>
      {user.status !== "invited" && (
        <label className="mt-4 flex items-center justify-between gap-4 border-y py-3">
          <span>
            <span className="block text-sm font-medium">Account access</span>
            <span className="block text-xs text-muted-foreground">
              Disabling ends sessions and revokes every OIDC token.
            </span>
          </span>
          <Switch checked={active} onCheckedChange={setActive} />
        </label>
      )}
      <div className="mt-4 flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={accessLinkPending || user.status === "disabled"}
          onClick={onCreateAccessLink}
        >
          {accessLinkPending ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
          {user.status === "invited"
            ? "New invitation link"
            : user.status === "disabled"
              ? "Enable account for recovery"
              : "Recovery link"}
        </Button>
        <Button disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Save />}
          Save changes
        </Button>
      </div>
    </form>
  );
}
