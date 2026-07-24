import { LoaderCircle, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SharedUserAccess } from "./shared-user-access";
import type {
  AdminMailbox,
  AdminUser,
  UpdateMailboxInput,
} from "./types";

export function MailboxAccessEditor({
  mailbox,
  users,
  pending,
  onSubmit,
}: {
  mailbox: AdminMailbox;
  users: AdminUser[];
  pending: boolean;
  onSubmit: (input: UpdateMailboxInput) => void;
}) {
  const [displayName, setDisplayName] = useState(mailbox.displayName);
  const [members, setMembers] = useState(mailbox.members);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ displayName, members });
  }

  return (
    <form className="my-6 border-y bg-muted/25 py-5" onSubmit={submit}>
      <div className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Manage {mailbox.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">{mailbox.address}</p>
        </div>
      </div>
      <div>
        <Label htmlFor={`mailbox-name-${mailbox.id}`}>Display name</Label>
        <Input
          id={`mailbox-name-${mailbox.id}`}
          className="mt-1.5 bg-background"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          required
        />
      </div>
      <fieldset className="mt-4">
        <legend className="mb-2 text-xs font-medium">User access</legend>
        <SharedUserAccess users={users} value={members} onChange={setMembers} />
      </fieldset>
      <div className="mt-4 flex justify-end">
        <Button disabled={pending || members.length === 0}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Save />}
          Save access
        </Button>
      </div>
    </form>
  );
}
