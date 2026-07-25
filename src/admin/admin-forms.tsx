import { LoaderCircle, MailPlus, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin-panel";
import type {
  AdminUser,
  CreateMailboxInput,
  InvitationInput,
  MailboxMemberPermission,
} from "./types";
import { SharedUserAccess } from "./shared-user-access";

export function InviteForm({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (input: InvitationInput) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({
      name,
      email,
      avatarUrl: avatarUrl.trim() || null,
    });
  }

  return (
    <form className={adminPanelClass} onSubmit={submit}>
      <AdminPanelHeader
        Icon={UserPlus}
        title="Invite a person"
        description="They receive a one-time link to register a passkey."
      />
      <AdminPanelBody>
      <FieldGroup className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel className="sr-only" htmlFor="invite-name">Name</FieldLabel>
          <Input
            id="invite-name"
            placeholder="Full name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field>
          <FieldLabel className="sr-only" htmlFor="invite-email">
            Personal mailbox
          </FieldLabel>
          <Input
            id="invite-email"
            type="email"
            placeholder="name@your-domain.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </Field>
        <Field className="sm:col-span-2">
          <FieldLabel className="sr-only" htmlFor="invite-avatar">Avatar URL</FieldLabel>
          <Input
            id="invite-avatar"
            type="url"
            placeholder="Avatar URL (optional)"
            value={avatarUrl}
            onChange={(event) => setAvatarUrl(event.target.value)}
          />
        </Field>
      </FieldGroup>
      </AdminPanelBody>
      <AdminPanelFooter>
        <Button disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" /> : <UserPlus />}
          Invite
        </Button>
      </AdminPanelFooter>
    </form>
  );
}

export function MailboxForm({
  pending,
  users,
  onSubmit,
}: {
  pending: boolean;
  users: AdminUser[];
  onSubmit: (input: CreateMailboxInput) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [address, setAddress] = useState("");
  const [members, setMembers] = useState<MailboxMemberPermission[]>([]);
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({ displayName, address, members });
  }
  return (
    <form className={adminPanelClass} onSubmit={submit}>
      <AdminPanelHeader
        Icon={MailPlus}
        title="Create a shared mailbox"
        description="Choose the address and exactly who can read or send from it."
      />
      <AdminPanelBody className="space-y-6">
        <FieldGroup className="grid gap-4 sm:grid-cols-[1fr_1.3fr]">
          <Field><FieldLabel className="sr-only" htmlFor="mailbox-display-name">Display name</FieldLabel><Input id="mailbox-display-name" placeholder="Support" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></Field>
          <Field><FieldLabel className="sr-only" htmlFor="mailbox-address">Address</FieldLabel><Input id="mailbox-address" type="email" placeholder="support@your-domain.com" value={address} onChange={(event) => setAddress(event.target.value)} required /></Field>
        </FieldGroup>
        <FieldSet>
          <FieldLegend variant="label">Mailbox access</FieldLegend>
          <SharedUserAccess users={users} value={members} onChange={setMembers} />
        </FieldSet>
      </AdminPanelBody>
      <AdminPanelFooter>
        <Button disabled={pending || members.length === 0}>
          {pending ? <LoaderCircle className="animate-spin" /> : <MailPlus />}
          Create
        </Button>
      </AdminPanelFooter>
    </form>
  );
}
