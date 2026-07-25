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
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
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
import { mailboxAddress, mailboxLocalPart } from "./mailbox-address";
import { SharedUserAccess } from "./shared-user-access";

function DomainAddressField({
  id,
  domain,
  placeholder,
  value,
  onChange,
  required,
}: {
  id: string;
  domain: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <InputGroup className="h-9">
      <InputGroupInput
        id={id}
        type="text"
        inputMode="email"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(mailboxLocalPart(event.target.value))}
        required={required}
        aria-label="Mailbox local part"
      />
      <InputGroupAddon align="inline-end">
        <InputGroupText className="font-mono text-xs">@{domain}</InputGroupText>
      </InputGroupAddon>
    </InputGroup>
  );
}

export function InviteForm({
  pending,
  domain,
  onSubmit,
}: {
  pending: boolean;
  domain: string;
  onSubmit: (input: InvitationInput) => void;
}) {
  const [name, setName] = useState("");
  const [localPart, setLocalPart] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    const local = mailboxLocalPart(localPart);
    if (!local) return;
    onSubmit({
      name,
      email: mailboxAddress(local, domain),
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
          <DomainAddressField
            id="invite-email"
            domain={domain}
            placeholder="name"
            value={localPart}
            onChange={setLocalPart}
            required
          />
        </Field>
      </FieldGroup>
      </AdminPanelBody>
      <AdminPanelFooter>
        <Button type="submit" disabled={pending || !mailboxLocalPart(localPart)}>
          {pending ? <LoaderCircle className="animate-spin" /> : <UserPlus />}
          Invite
        </Button>
      </AdminPanelFooter>
    </form>
  );
}

export function MailboxForm({
  pending,
  domain,
  users,
  onSubmit,
}: {
  pending: boolean;
  domain: string;
  users: AdminUser[];
  onSubmit: (input: CreateMailboxInput) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [members, setMembers] = useState<MailboxMemberPermission[]>([]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const local = mailboxLocalPart(localPart);
    if (!local) return;
    onSubmit({
      displayName,
      address: mailboxAddress(local, domain),
      members,
    });
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
          <Field>
            <FieldLabel className="sr-only" htmlFor="mailbox-display-name">Display name</FieldLabel>
            <Input
              id="mailbox-display-name"
              placeholder="Support"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </Field>
          <Field>
            <FieldLabel className="sr-only" htmlFor="mailbox-address">Address</FieldLabel>
            <DomainAddressField
              id="mailbox-address"
              domain={domain}
              placeholder="support"
              value={localPart}
              onChange={setLocalPart}
              required
            />
          </Field>
        </FieldGroup>
        <FieldSet>
          <FieldLegend variant="label">Mailbox access</FieldLegend>
          <SharedUserAccess users={users} value={members} onChange={setMembers} />
        </FieldSet>
      </AdminPanelBody>
      <AdminPanelFooter>
        <Button
          type="submit"
          disabled={pending || members.length === 0 || !mailboxLocalPart(localPart)}
        >
          {pending ? <LoaderCircle className="animate-spin" /> : <MailPlus />}
          Create
        </Button>
      </AdminPanelFooter>
    </form>
  );
}
