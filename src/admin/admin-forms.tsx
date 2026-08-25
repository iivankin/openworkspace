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
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin-panel";
import type {
  AdminDomain,
  AdminUser,
  CreateMailboxInput,
  InvitationInput,
  MailboxMemberPermission,
} from "./types";
import { mailboxAddress, mailboxLocalPart } from "./mailbox-address";
import { SharedUserAccess } from "./shared-user-access";

function DomainAddressField({
  id,
  domains,
  domainId,
  onDomainChange,
  placeholder,
  value,
  onChange,
  required,
}: {
  id: string;
  domains: AdminDomain[];
  domainId: string;
  onDomainChange: (domainId: string) => void;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const selectedDomain = domains.find((domain) => domain.id === domainId)?.name ?? "";

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(9rem,auto)]">
      <InputGroup className="h-9 rounded-r-none border-r-0">
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
      </InputGroup>
      <Select
        value={domainId}
        onValueChange={(value) => value && onDomainChange(value)}
      >
        <SelectTrigger
          className="w-full rounded-l-none font-mono text-xs"
          aria-label="Mailbox domain"
        >
          <SelectValue>{`@${selectedDomain}`}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start" alignItemWithTrigger={false}>
          {domains.map((domain) => (
            <SelectItem key={domain.id} value={domain.id}>{domain.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function InviteForm({
  pending,
  domains,
  onSubmit,
}: {
  pending: boolean;
  domains: AdminDomain[];
  onSubmit: (input: InvitationInput) => void;
}) {
  const [name, setName] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [domainId, setDomainId] = useState(
    () => domains.find((domain) => domain.isPrimary)?.id ?? domains[0]?.id ?? "",
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    const local = mailboxLocalPart(localPart);
    if (!local) return;
    const domain = domains.find((candidate) => candidate.id === domainId);
    if (!domain) return;
    onSubmit({
      name,
      email: mailboxAddress(local, domain.name),
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
              domains={domains}
              domainId={domainId}
              onDomainChange={setDomainId}
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
  domains,
  users,
  onSubmit,
}: {
  pending: boolean;
  domains: AdminDomain[];
  users: AdminUser[];
  onSubmit: (input: CreateMailboxInput) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [domainId, setDomainId] = useState(
    () => domains.find((domain) => domain.isPrimary)?.id ?? domains[0]?.id ?? "",
  );
  const [mailboxType, setMailboxType] = useState<"shared" | "personal">("shared");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [members, setMembers] = useState<MailboxMemberPermission[]>([]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const local = mailboxLocalPart(localPart);
    if (!local) return;
    const domain = domains.find((candidate) => candidate.id === domainId);
    if (!domain || (mailboxType === "personal" && !ownerUserId)) return;
    onSubmit({
      displayName,
      address: mailboxAddress(local, domain.name),
      ownerUserId: mailboxType === "personal" ? ownerUserId : null,
      members: mailboxType === "shared" ? members : [],
    });
  }
  return (
    <form className={adminPanelClass} onSubmit={submit}>
      <AdminPanelHeader
        Icon={MailPlus}
        title="Create a mailbox"
      />
      <AdminPanelBody className="space-y-6">
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="mailbox-type">Type</FieldLabel>
            <Select
              value={mailboxType}
              onValueChange={(value) =>
                setMailboxType((value ?? "shared") as "shared" | "personal")}
            >
              <SelectTrigger id="mailbox-type" className="w-full">
                <SelectValue>{mailboxType === "shared" ? "Shared" : "Personal"}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                <SelectItem value="shared">Shared</SelectItem>
                <SelectItem value="personal">Personal</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {mailboxType === "personal" ? (
            <Field>
              <FieldLabel htmlFor="mailbox-owner">Owner</FieldLabel>
              <Select
                value={ownerUserId}
                onValueChange={(value) => setOwnerUserId(value ?? "")}
              >
                <SelectTrigger id="mailbox-owner" className="w-full">
                  <SelectValue placeholder="Select owner">
                    {users.find((user) => user.id === ownerUserId)?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  {users.map((user) => (
                    <SelectItem key={user.id} value={user.id}>{user.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field className={mailboxType === "personal" ? "sm:col-span-2" : undefined}>
            <FieldLabel htmlFor="mailbox-display-name">Display name</FieldLabel>
            <Input
              id="mailbox-display-name"
              placeholder="Support"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel htmlFor="mailbox-address">Address</FieldLabel>
            <DomainAddressField
              id="mailbox-address"
              domains={domains}
              domainId={domainId}
              onDomainChange={setDomainId}
              placeholder="support"
              value={localPart}
              onChange={setLocalPart}
              required
            />
          </Field>
        </FieldGroup>
        {mailboxType === "shared" ? (
          <FieldSet>
            <FieldLegend variant="label">Mailbox access</FieldLegend>
            <SharedUserAccess users={users} value={members} onChange={setMembers} />
          </FieldSet>
        ) : null}
      </AdminPanelBody>
      <AdminPanelFooter>
        <Button
          type="submit"
          disabled={
            pending
            || !mailboxLocalPart(localPart)
            || (mailboxType === "shared" ? members.length === 0 : !ownerUserId)
          }
        >
          {pending ? <LoaderCircle className="animate-spin" /> : <MailPlus />}
          Create
        </Button>
      </AdminPanelFooter>
    </form>
  );
}
