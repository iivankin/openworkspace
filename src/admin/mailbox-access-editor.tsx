import { LoaderCircle, Mailbox, Save } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin-panel";
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
    <form className={adminPanelClass} onSubmit={submit}>
      <AdminPanelHeader
        Icon={Mailbox}
        title={`Manage ${mailbox.displayName}`}
        description={mailbox.address}
      />
      <AdminPanelBody className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor={`mailbox-name-${mailbox.id}`}>Display name</Label>
          <Input
            id={`mailbox-name-${mailbox.id}`}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
          />
        </div>
        <fieldset>
          <legend className="mb-2.5 text-[0.8125rem] font-semibold text-foreground/85">User access</legend>
          <SharedUserAccess users={users} value={members} onChange={setMembers} />
        </fieldset>
      </AdminPanelBody>
      <AdminPanelFooter>
        <Button disabled={pending || members.length === 0}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Save />}
          Save access
        </Button>
      </AdminPanelFooter>
    </form>
  );
}
