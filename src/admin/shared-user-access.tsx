import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import type {
  AdminUser,
  MailboxMemberPermission,
} from "./types";

export function SharedUserAccess({
  users,
  value,
  onChange,
}: {
  users: AdminUser[];
  value: MailboxMemberPermission[];
  onChange: (value: MailboxMemberPermission[]) => void;
}) {
  function setMember(userId: string, enabled: boolean) {
    const without = value.filter((member) => member.userId !== userId);
    onChange(enabled ? [...without, { userId, canSend: false }] : without);
  }

  function setCanSend(userId: string, canSend: boolean) {
    onChange(value.map((member) =>
      member.userId === userId ? { ...member, canSend } : member
    ));
  }

  return (
    <div className="divide-y border-y">
      {users.map((user) => {
        const member = value.find((item) => item.userId === user.id);
        return (
          <div
            key={user.id}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2.5 text-xs"
          >
            <Checkbox
              aria-label={`Give ${user.name} access`}
              checked={Boolean(member)}
              onCheckedChange={(checked) => setMember(user.id, checked)}
            />
            <span className="min-w-0">
              <span className="block truncate font-medium">{user.name}</span>
              <span className="block truncate text-muted-foreground">
                {user.personalEmail}
              </span>
            </span>
            <label className="flex items-center gap-2 text-muted-foreground">
              <span>{member?.canSend ? "Read & send" : "Read only"}</span>
              <Switch
                size="sm"
                checked={member?.canSend ?? false}
                disabled={!member}
                onCheckedChange={(checked) => setCanSend(user.id, checked)}
              />
            </label>
          </div>
        );
      })}
    </div>
  );
}
