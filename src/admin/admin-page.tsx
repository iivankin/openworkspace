import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Copy,
  Ellipsis,
  Globe2,
  Inbox,
  KeyRound,
  MailPlus,
  Settings2,
  SlidersHorizontal,
  Star,
  Trash2,
  type LucideIcon,
  UserPlus,
  Users,
  UsersRound,
  Webhook,
} from "lucide-react";
import { Fragment, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import type { AccessLinkKind } from "../../shared/auth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { GlobalAiProcessing } from "./global-ai-processing";
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
import { GroupsManager } from "./groups-manager";
import { SsoApplications } from "./sso-applications";
import { WebhooksManager } from "./webhooks-manager";
import { DomainsManager } from "./domains-manager";

type AdminView =
  | "people"
  | "mailboxes"
  | "domains"
  | "sso-applications"
  | "groups"
  | "webhooks"
  | "invite"
  | "new-mailbox"
  | "user"
  | "mailbox";
type AdminSection =
  | "people"
  | "mailboxes"
  | "domains"
  | "sso-applications"
  | "groups"
  | "webhooks"
  | "invite"
  | "new-mailbox";

const adminSections: Array<{
  id: AdminSection;
  label: string;
  Icon: LucideIcon;
  separatorBefore?: boolean;
}> = [
  { id: "people", label: "People", Icon: Users },
  { id: "mailboxes", label: "Mailboxes", Icon: Settings2 },
  { id: "domains", label: "Domains", Icon: Globe2 },
  { id: "sso-applications", label: "SSO applications", Icon: KeyRound, separatorBefore: true },
  { id: "groups", label: "Identity groups", Icon: UsersRound },
  { id: "webhooks", label: "Webhooks", Icon: Webhook },
  { id: "invite", label: "Invite person", Icon: UserPlus, separatorBefore: true },
  { id: "new-mailbox", label: "New mailbox", Icon: MailPlus },
];

const viewCopy: Record<AdminView, { title: string; description: string }> = {
  people: { title: "People", description: "Workspace members and their mailbox access." },
  mailboxes: { title: "Mailboxes", description: "Personal and shared addresses provisioned for this workspace." },
  domains: { title: "Domains", description: "Mail domains and Cloudflare zone IDs." },
  "sso-applications": { title: "SSO applications", description: "OIDC clients, callbacks, user assignments, and released claims." },
  groups: { title: "Identity groups", description: "Reusable memberships exposed to approved OIDC applications." },
  webhooks: { title: "Webhooks", description: "Signed account events delivered to external systems." },
  invite: { title: "Invite person", description: "Create a personal mailbox and a one-time registration link." },
  "new-mailbox": { title: "New mailbox", description: "Personal or shared address." },
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
      toast.success("Mailbox created");
      await invalidateAdminData(client);
      go("mailboxes");
    },
    onError: (error) => toast.error(error.message),
  });
  const setPrimaryMailbox = useMutation({
    mutationFn: async (id: string) => responseJson(
      await api.api.admin.mailboxes[":id"].primary.$post({ param: { id } }),
    ),
    onSuccess: async () => {
      toast.success("Primary mailbox updated");
      await invalidateAdminData(client);
    },
    onError: (error) => toast.error(error.message),
  });
  const deleteMailbox = useMutation({
    mutationFn: async (id: string) => responseJson(
      await api.api.admin.mailboxes[":id"].$delete({ param: { id } }),
    ),
    onSuccess: async () => {
      toast.success("Mailbox deleted");
      await invalidateAdminData(client);
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
      <aside className="hidden w-68 shrink-0 flex-col border-r border-border/70 bg-sidebar md:flex">
        <div className="flex h-18 shrink-0 items-center gap-2.5 border-b border-border/70 px-5">
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm ring-1 ring-primary/25">
            <Inbox className="size-4.5" strokeWidth={2.25} />
          </span>
          <div>
            <p className="font-display text-[0.9375rem] leading-tight font-semibold">OpenWorkspace</p>
            <p className="text-[11px] leading-tight text-muted-foreground">Administration</p>
          </div>
        </div>
        <AdminNavigation value={activeSection} onChange={(value) => go(value)} />
        <div className="mt-auto border-t border-border/70 p-3">
          <Button className="w-full justify-start" variant="ghost" onClick={() => navigate("/")}>
            <ArrowLeft /> Back to mail
          </Button>
        </div>
      </aside>

      <section className="paper-grain flex min-w-0 flex-1 flex-col">
        <header className="flex h-18 shrink-0 items-center gap-3 border-b border-border/70 bg-surface/70 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
          <Button className="md:hidden" variant="ghost" size="icon-sm" onClick={() => navigate("/")}>
            <ArrowLeft /><span className="sr-only">Back to mail</span>
          </Button>
          <div className="min-w-0">
            <h1 className="truncate font-display text-xl font-semibold">{viewCopy[view].title}</h1>
            <p className="hidden truncate text-xs text-muted-foreground sm:block">{viewCopy[view].description}</p>
          </div>
          {(view === "user" || view === "mailbox") && (
            <Button className="ml-auto" variant="outline" size="sm" onClick={() => go(view === "user" ? "people" : "mailboxes")}>
              <ArrowLeft /> Back to list
            </Button>
          )}
        </header>

        <div className="border-b border-border/70 p-2 md:hidden">
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
              <div className="max-w-3xl space-y-6">
                <GlobalAiProcessing
                  enabled={state.data?.aiProcessingEnabled ?? false}
                  loading={state.isLoading}
                />
                <MailboxList
                  mailboxes={state.data?.mailboxes}
                  loading={state.isLoading}
                  onManage={(id) => go("mailbox", id)}
                  onMakePrimary={(id) => setPrimaryMailbox.mutate(id)}
                  onDelete={(id) => deleteMailbox.mutate(id)}
                  pending={setPrimaryMailbox.isPending || deleteMailbox.isPending}
                />
              </div>
            )}
            {view === "domains" && (
              <div className="max-w-3xl">
                <DomainsManager
                  domains={state.data?.domains ?? []}
                  loading={state.isLoading}
                />
              </div>
            )}
            {view === "sso-applications" && (
              <SsoApplications
                clients={state.data?.oidcClients ?? []}
                users={state.data?.users ?? []}
                groups={state.data?.groups ?? []}
                loading={state.isLoading}
              />
            )}
            {view === "groups" && (
              <GroupsManager
                groups={state.data?.groups ?? []}
                users={state.data?.users ?? []}
                loading={state.isLoading}
              />
            )}
            {view === "webhooks" && <WebhooksManager />}
            {view === "invite" && (
              <div className="max-w-3xl">
                {state.data?.domains.length ? (
                  <InviteForm
                    pending={invite.isPending}
                    domains={state.data.domains}
                    onSubmit={(input) => invite.mutate(input)}
                  />
                ) : null}
                {generatedLink?.kind === "invitation" && <AccessLink kind="invitation" url={generatedLink.url} copied={copied} onCopied={() => markCopied(setCopied)} />}
              </div>
            )}
            {view === "new-mailbox" && (
              <div className="max-w-3xl">
                {state.data?.domains.length ? (
                  <MailboxForm
                    pending={createMailbox.isPending}
                    domains={state.data.domains}
                    users={state.data?.users ?? []}
                    onSubmit={(input) => createMailbox.mutate(input)}
                  />
                ) : null}
              </div>
            )}            {view === "user" && selectedUser && (
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
      <TabsList variant="line" className="w-full items-stretch gap-0.5">
        {adminSections.map(({ id, label, Icon, separatorBefore }) => (
          <Fragment key={id}>
            {separatorBefore && <Separator className="my-2.5 bg-border/70" />}
            <TabsTrigger
              value={id}
              className="h-9 justify-start gap-2.5 rounded-lg px-3 text-[0.8125rem] after:hidden group-data-[variant=line]/tabs-list:hover:bg-sidebar-accent group-data-[variant=line]/tabs-list:data-active:bg-sidebar-accent group-data-[variant=line]/tabs-list:data-active:font-semibold data-active:[&_svg]:text-primary"
            >
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
  if (!users?.length) {
    return <AdminEmptyState Icon={Users} title="No people yet" description="Invite someone to create their personal mailbox." />;
  }
  return (
    <div className="divide-y divide-border/60 overflow-hidden rounded-2xl bg-surface shadow-xs ring-1 ring-border">
      {users.map((user) => (
        <div key={user.id} className="flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-accent/45">
          <Avatar className="size-10"><AvatarImage src={user.avatarUrl ?? undefined} /><AvatarFallback className="text-xs">{user.name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{user.personalEmail}</p>
          </div>
          {user.role === "admin" && <Badge>Admin</Badge>}
          <Badge variant={user.status === "active" ? "success" : "outline"} className="capitalize">{user.status}</Badge>
          <Button aria-label={`Manage ${user.name}`} variant="outline" size="sm" onClick={() => onManage(user.id)}><SlidersHorizontal /> Manage</Button>
        </div>
      ))}
    </div>
  );
}

function MailboxList({
  mailboxes,
  loading,
  pending,
  onManage,
  onMakePrimary,
  onDelete,
}: {
  mailboxes?: AdminMailbox[];
  loading: boolean;
  pending: boolean;
  onManage: (id: string) => void;
  onMakePrimary: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [deleteCandidate, setDeleteCandidate] = useState<AdminMailbox | null>(null);
  if (loading) return <ListSkeleton />;
  if (!mailboxes?.length) {
    return <AdminEmptyState Icon={Settings2} title="No mailboxes yet" description="Personal mailboxes appear here once people are invited." />;
  }
  return (
    <>
      <div className="divide-y divide-border/60 overflow-hidden rounded-2xl bg-surface shadow-xs ring-1 ring-border">
        {mailboxes.map((mailbox) => {
          const canMakePrimary = mailbox.kind === "personal" && !mailbox.isPrimary;
          const canDelete = mailbox.kind === "shared" || canMakePrimary;
          return (
            <div
              key={mailbox.id}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-accent/45 sm:gap-4"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/12 text-foreground/70"><MailPlus className="size-4.5" /></span>
              <div className="min-w-0"><p className="truncate text-sm font-semibold">{mailbox.displayName}</p><p className="truncate text-xs text-muted-foreground">{mailbox.address}</p></div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="outline" className="hidden capitalize sm:inline-flex">{mailbox.kind}</Badge>
                {mailbox.isPrimary ? <Badge>Primary</Badge> : null}
                {canDelete ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={(
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          disabled={pending}
                          aria-label={`Actions for ${mailbox.displayName}`}
                        />
                      )}
                    >
                      <Ellipsis />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {mailbox.kind === "shared" ? (
                        <DropdownMenuItem onClick={() => onManage(mailbox.id)}>
                          <SlidersHorizontal /> Manage access
                        </DropdownMenuItem>
                      ) : null}
                      {canMakePrimary ? (
                        <DropdownMenuItem onClick={() => onMakePrimary(mailbox.id)}>
                          <Star /> Make primary
                        </DropdownMenuItem>
                      ) : null}
                      {canDelete ? <DropdownMenuSeparator /> : null}
                      {canDelete ? (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeleteCandidate(mailbox)}
                        >
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <Dialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setDeleteCandidate(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteCandidate?.displayName}?</DialogTitle>
            <DialogDescription>
              Messages, attachments, settings, and mailbox access are permanently deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => setDeleteCandidate(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending || !deleteCandidate}
              onClick={() => {
                if (!deleteCandidate) return;
                const id = deleteCandidate.id;
                setDeleteCandidate(null);
                onDelete(id);
              }}
            >
              <Trash2 /> Delete mailbox
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AdminEmptyState({ Icon, title, description }: { Icon: LucideIcon; title: string; description: string }) {
  return (
    <div className="rounded-2xl bg-surface px-6 py-16 text-center shadow-xs ring-1 ring-border">
      <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-primary/12 text-foreground/60">
        <Icon className="size-5" />
      </span>
      <p className="mt-4 font-display text-lg font-semibold">{title}</p>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground text-pretty">{description}</p>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="divide-y divide-border/60 overflow-hidden rounded-2xl bg-surface ring-1 ring-border">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-4">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-8 w-24 shrink-0" />
        </div>
      ))}
    </div>
  );
}

function MissingAdminRecord({
  label,
  onBack,
}: {
  label: string;
  onBack: () => void;
}) {
  return (
    <div className="rounded-2xl bg-surface py-16 text-center ring-1 ring-border">
      <p className="font-display text-lg font-semibold">{label} not found</p>
      <p className="mt-1.5 text-sm text-muted-foreground">
        It may have been removed or the link is stale.
      </p>
      <Button className="mt-5" variant="outline" size="sm" onClick={onBack}>
        <ArrowLeft /> Back to list
      </Button>
    </div>
  );
}

function AccessLink({ kind, url, copied, onCopied }: { kind: AccessLinkKind; url: string; copied: boolean; onCopied: () => void }) {
  return (
    <div className="mt-6 rounded-2xl bg-primary/8 p-4 ring-1 ring-primary/25">
      <p className="mb-2.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
        One-time link — share it over a trusted channel
      </p>
      <InputGroup className="h-10 bg-surface">
        <InputGroupAddon><InputGroupText className="font-medium">{kind === "invitation" ? "Invitation" : "Recovery"}</InputGroupText></InputGroupAddon>
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
