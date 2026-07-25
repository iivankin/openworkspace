import { KeyRound, LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin-panel";
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
    <form className={adminPanelClass} onSubmit={submit}>
      <AdminPanelHeader
        title={`Manage ${user.name}`}
        description={`Personal mailbox: ${user.personalEmail}`}
      >
        <Avatar className="size-10 shrink-0">
          <AvatarImage src={avatarUrl || undefined} />
          <AvatarFallback className="text-xs">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
      </AdminPanelHeader>

      <AdminPanelBody className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`user-name-${user.id}`}>Name</Label>
            <Input
              id={`user-name-${user.id}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`user-avatar-${user.id}`}>Avatar URL</Label>
            <Input
              id={`user-avatar-${user.id}`}
              type="url"
              placeholder="Optional"
              value={avatarUrl}
              onChange={(event) => setAvatarUrl(event.target.value)}
            />
          </div>
        </div>
        {user.status !== "invited" && (
          <label className="flex items-center justify-between gap-4 rounded-xl bg-surface-sunken px-4 py-3 ring-1 ring-border">
            <span>
              <span className="block text-[0.8125rem] font-semibold">Account access</span>
              <span className="block text-xs text-muted-foreground">
                Disabling ends sessions and revokes every OIDC token.
              </span>
            </span>
            <Switch checked={active} onCheckedChange={setActive} />
          </label>
        )}
      </AdminPanelBody>

      <AdminPanelFooter className="justify-between">
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
        <Button type="submit" disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Save />}
          Save changes
        </Button>
      </AdminPanelFooter>
    </form>
  );
}
