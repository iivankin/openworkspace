import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Copy,
  Inbox,
  MailPlus,
  Settings2,
  SlidersHorizontal,
  type LucideIcon,
  UserPlus,
  Users,
} from "lucide-react";
import { Fragment, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import type { AccessLinkKind } from "../../shared/auth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, responseJson } from "@/lib/api";
import { InviteForm, MailboxForm } from "./admin-forms";
import { MailboxAccessEditor } from "./mailbox-access-editor";
import type {
  AdminMailbox,
  AdminUser,
  CreateMailboxInput,
  InvitationInput,
  UpdateMailboxInput,
  UpdateUserInput,
} from "./types";
import { UserAccessEditor } from "./user-access-editor";

type AdminView = "people" | "mailboxes" | "invite" | "new-mailbox" | "user" | "mailbox";
type AdminSection = "people" | "mailboxes" | "invite" | "new-mailbox";

const adminSections: Array<{
  id: AdminSection;
  label: string;
  Icon: LucideIcon;
  separatorBefore?: boolean;
}> = [
  { id: "people", label: "People", Icon: Users },
  { id: "mailboxes", label: "Mailboxes", Icon: Settings2 },
  { id: "invite", label: "Invite person", Icon: UserPlus, separatorBefore: true },
  { id: "new-mailbox", label: "New shared mailbox", Icon: MailPlus },
];

const viewCopy: Record<AdminView, { title: string; description: string }> = {
  people: { title: "People", description: "Workspace members and their mailbox access." },
  mailboxes: { title: "Mailboxes", description: "Personal and shared addresses provisioned for this workspace." },
  invite: { title: "Invite person", description: "Create a personal mailbox and a one-time registration link." },
  "new-mailbox": { title: "New shared mailbox", description: "Choose the address and exactly who can read or send from it." },
  user: { title: "Person", description: "Profile details and passkey recovery." },
  mailbox: { title: "Mailbox access", description: "Display name and member permissions for this shared address." },
};

export function AdminPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const rawView = params.get("view") as AdminView | null;
  const view: AdminView = rawView && rawView in viewCopy ? rawView : "people";
  const selectedId = params.get("id") ?? undefined;
  const [generatedLink, setGeneratedLink] = useState<{
    kind: AccessLinkKind;
    url: string;
    userId?: string;
  }>();
  const [copied, setCopied] = useState(false);

  const state = useQuery({
    queryKey: ["admin-state"],
    queryFn: async () => responseJson(await api.api.admin.state.$get()),
  });
  const sharedMailboxes = state.data?.mailboxes.filter((mailbox) => mailbox.kind === "shared") ?? [];
  const selectedUser = state.data?.users.find((user) => user.id === selectedId);
  const selectedMailbox = sharedMailboxes.find((mailbox) => mailbox.id === selectedId);
  const activeSection: AdminSection = view === "user" ? "people" : view === "mailbox" ? "mailboxes" : view;

  const invite = useMutation({
    mutationFn: async (input: InvitationInput) =>
      responseJson(await api.api.admin.invitations.$post({ json: input })),
    onSuccess: async (result) => {
      setCopied(false);
      setGeneratedLink(result.accessLink);
      await invalidateAdminData(client);
    },
    onError: (error) => toast.error(error.message),
  });
  const createMailbox = useMutation({
    mutationFn: async (input: CreateMailboxInput) => responseJson(await api.api.admin.mailboxes.$post({ json: input })),
    onSuccess: async () => {
      toast.success("Shared mailbox created");
      await invalidateAdminData(client);
      go("mailboxes");
    },
    onError: (error) => toast.error(error.message),
  });
  const updateMailbox = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateMailboxInput }) => responseJson(await api.api.admin.mailboxes[":id"].$patch({ param: { id }, json: input })),
    onSuccess: async () => {
      toast.success("Mailbox access updated");
      await invalidateAdminData(client);
    },
    onError: (error) => toast.error(error.message),
  });
  const updateUser = useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateUserInput }) => responseJson(await api.api.admin.users[":id"].$patch({ param: { id }, json: input })),
    onSuccess: async () => {
      toast.success("User access updated");
      await invalidateAdminData(client);
    },
    onError: (error) => toast.error(error.message),
  });
  const createAccessLink = useMutation({
    mutationFn: async (userId: string) =>
      responseJson(
        await api.api.admin.users[":id"]["access-link"].$post({
          param: { id: userId },
        }),
      ),
    onSuccess: (result, userId) => {
      setCopied(false);
      setGeneratedLink({ ...result.accessLink, userId });
    },
    onError: (error) => toast.error(error.message),
  });

  function go(next: AdminView, id?: string) {
    const nextParams = new URLSearchParams();
    nextParams.set("view", next);
    if (id) nextParams.set("id", id);
    setGeneratedLink(undefined);
    setCopied(false);
    setParams(nextParams);
  }

  return (
    <main className="flex h-dvh min-h-0 bg-background">
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-muted/15 md:flex">
        <div className="flex h-16 items-center gap-2.5 border-b px-5">
          <span className="grid size-8 place-items-center rounded-xl bg-foreground text-background"><Inbox className="size-4" /></span>
          <div>
            <p className="text-sm font-semibold">OpenWorkspace</p>
            <p className="text-[11px] text-muted-foreground">Administration</p>
          </div>
        </div>
        <AdminNavigation value={activeSection} onChange={(value) => go(value)} />
        <div className="mt-auto border-t p-3">
          <Button className="w-full justify-start" variant="ghost" onClick={() => navigate("/")}>
            <ArrowLeft /> Back to mail
          </Button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-16 shrink-0 items-center gap-3 border-b px-4 sm:px-6 lg:px-8">
          <Button className="md:hidden" variant="ghost" size="icon-sm" onClick={() => navigate("/")}>
            <ArrowLeft /><span className="sr-only">Back to mail</span>
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight">{viewCopy[view].title}</h1>
            <p className="hidden truncate text-xs text-muted-foreground sm:block">{viewCopy[view].description}</p>
          </div>
          {(view === "user" || view === "mailbox") && (
            <Button className="ml-auto" variant="outline" size="sm" onClick={() => go(view === "user" ? "people" : "mailboxes")}>
              <ArrowLeft /> Back to list
            </Button>
          )}
        </header>

        <div className="border-b p-2 md:hidden">
          <MobileAdminNavigation value={activeSection} onChange={(value) => go(value)} />
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
            {view === "people" && (
              <PeopleList
                users={state.data?.users}
                loading={state.isLoading}
                onManage={(id) => go("user", id)}
              />
            )}
            {view === "mailboxes" && (
              <MailboxList
                mailboxes={state.data?.mailboxes}
                loading={state.isLoading}
                onManage={(id) => go("mailbox", id)}
              />
            )}
            {view === "invite" && (
              <div className="max-w-3xl">
                <InviteForm pending={invite.isPending} onSubmit={(input) => invite.mutate(input)} />
                {generatedLink?.kind === "invitation" && <AccessLink kind="invitation" url={generatedLink.url} copied={copied} onCopied={() => markCopied(setCopied)} />}
              </div>
            )}
            {view === "new-mailbox" && (
              <div className="max-w-3xl">
                <MailboxForm pending={createMailbox.isPending} users={state.data?.users ?? []} onSubmit={(input) => createMailbox.mutate(input)} />
              </div>
            )}
            {view === "user" && selectedUser && (
              <div className="max-w-3xl">
                <UserAccessEditor
                  key={selectedUser.id}
                  user={selectedUser}
                  pending={updateUser.isPending}
                  accessLinkPending={createAccessLink.isPending}
                  onCreateAccessLink={() => createAccessLink.mutate(selectedUser.id)}
                  onSubmit={(input) => updateUser.mutate({ id: selectedUser.id, input })}
                />
                {generatedLink?.userId === selectedUser.id && (
                  <AccessLink kind={generatedLink.kind} url={generatedLink.url} copied={copied} onCopied={() => markCopied(setCopied)} />
                )}
              </div>
            )}
            {view === "mailbox" && selectedMailbox && (
              <div className="max-w-3xl">
                <MailboxAccessEditor
                  key={selectedMailbox.id}
                  mailbox={selectedMailbox}
                  users={state.data?.users ?? []}
                  pending={updateMailbox.isPending}
                  onSubmit={(input) => updateMailbox.mutate({ id: selectedMailbox.id, input })}
                />
              </div>
            )}
            {view === "user" && state.isSuccess && !selectedUser && (
              <MissingAdminRecord
                label="Person"
                onBack={() => go("people")}
              />
            )}
            {view === "mailbox" && state.isSuccess && !selectedMailbox && (
              <MissingAdminRecord
                label="Mailbox"
                onBack={() => go("mailboxes")}
              />
            )}
          </div>
        </ScrollArea>
      </section>
    </main>
  );
}

function AdminNavigation({
  value,
  onChange,
}: {
  value: AdminSection;
  onChange: (value: AdminSection) => void;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as AdminSection)} orientation="vertical" className="p-3">
      <TabsList variant="line" className="w-full items-stretch gap-1">
        {adminSections.map(({ id, label, Icon, separatorBefore }) => (
          <Fragment key={id}>
            {separatorBefore && <Separator className="my-2" />}
            <TabsTrigger value={id} className="h-9 px-3">
              <Icon /> {label}
            </TabsTrigger>
          </Fragment>
        ))}
      </TabsList>
    </Tabs>
  );
}

function MobileAdminNavigation({ value, onChange }: { value: AdminSection; onChange: (value: AdminSection) => void }) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as AdminSection)}>
      <SelectTrigger className="w-full">
        <SelectValue>
          {adminSections.find((section) => section.id === value)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectGroup>
          {adminSections.map(({ id, label, Icon }) => (
            <SelectItem key={id} value={id}><Icon /> {label}</SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function PeopleList({ users, loading, onManage }: { users?: AdminUser[]; loading: boolean; onManage: (id: string) => void }) {
  if (loading) return <ListSkeleton />;
  return (
    <div className="divide-y border-y">
      {users?.map((user) => (
        <div key={user.id} className="flex items-center gap-4 py-3">
          <Avatar className="size-10"><AvatarImage src={user.avatarUrl ?? undefined} /><AvatarFallback className="text-xs">{user.name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{user.personalEmail}</p>
          </div>
          {user.role === "admin" && <Badge variant="secondary">Admin</Badge>}
          <Badge variant={user.status === "active" ? "outline" : "secondary"}>{user.status}</Badge>
          <Button aria-label={`Manage ${user.name}`} variant="outline" size="sm" onClick={() => onManage(user.id)}><SlidersHorizontal /> Manage</Button>
        </div>
      ))}
    </div>
  );
}

function MailboxList({ mailboxes, loading, onManage }: { mailboxes?: AdminMailbox[]; loading: boolean; onManage: (id: string) => void }) {
  if (loading) return <ListSkeleton />;
  return (
    <div className="divide-y border-y">
      {mailboxes?.map((mailbox) => (
        <div key={mailbox.id} className="flex items-center gap-4 py-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted"><MailPlus className="size-4" /></span>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{mailbox.displayName}</p><p className="truncate text-xs text-muted-foreground">{mailbox.address}</p></div>
          <Badge variant="outline">{mailbox.kind}</Badge>
          {mailbox.kind === "shared" && <Button aria-label={`Manage ${mailbox.displayName}`} variant="outline" size="sm" onClick={() => onManage(mailbox.id)}><SlidersHorizontal /> Manage</Button>}
        </div>
      ))}
    </div>
  );
}

function ListSkeleton() {
  return <div className="space-y-3">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-16 w-full" />)}</div>;
}

function MissingAdminRecord({
  label,
  onBack,
}: {
  label: string;
  onBack: () => void;
}) {
  return (
    <div className="py-16 text-center">
      <p className="text-sm font-medium">{label} not found</p>
      <p className="mt-1 text-xs text-muted-foreground">
        It may have been removed or the link is stale.
      </p>
      <Button className="mt-4" variant="outline" size="sm" onClick={onBack}>
        <ArrowLeft /> Back to list
      </Button>
    </div>
  );
}

function AccessLink({ kind, url, copied, onCopied }: { kind: AccessLinkKind; url: string; copied: boolean; onCopied: () => void }) {
  return (
    <div className="mt-6 border-y py-4">
      <InputGroup className="h-10 bg-background">
        <InputGroupAddon><InputGroupText>{kind === "invitation" ? "Invitation" : "Recovery"}</InputGroupText></InputGroupAddon>
        <InputGroupInput readOnly value={url} />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-sm" variant="outline" onClick={() => void navigator.clipboard.writeText(url).then(onCopied)}>
            {copied ? <Check /> : <Copy />}<span className="sr-only">Copy {kind} link</span>
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function markCopied(setCopied: (value: boolean) => void) {
  setCopied(true);
  setTimeout(() => setCopied(false), 1500);
}

async function invalidateAdminData(client: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ["admin-state"] }),
    client.invalidateQueries({ queryKey: ["mailboxes"] }),
  ]);
}
