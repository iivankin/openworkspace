import { useState } from "react";
import {
  Ellipsis,
  MailPlus,
  Settings2,
  SlidersHorizontal,
  Star,
  Trash2,
  type LucideIcon,
  Users,
} from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import type { AdminMailbox, AdminUser } from "./types";

export function PeopleList({
  users,
  loading,
  onManage,
}: {
  users?: AdminUser[];
  loading: boolean;
  onManage: (id: string) => void;
}) {
  if (loading) return <ListSkeleton />;
  if (!users?.length) {
    return (
      <AdminEmptyState
        Icon={Users}
        title="No people yet"
        description="Invite someone to create their personal mailbox."
      />
    );
  }
  return (
    <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface">
      {users.map((user) => (
        <div
          key={user.id}
          className="flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-accent/45"
        >
          <Avatar className="size-10">
            <AvatarImage src={user.avatarUrl ?? undefined} />
            <AvatarFallback className="text-xs">
              {user.name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{user.personalEmail}</p>
          </div>
          {user.role === "admin" ? <Badge>Admin</Badge> : null}
          <Badge
            variant={user.status === "active" ? "success" : "outline"}
            className="capitalize"
          >
            {user.status}
          </Badge>
          <Button
            aria-label={`Manage ${user.name}`}
            variant="outline"
            size="sm"
            onClick={() => onManage(user.id)}
          >
            <SlidersHorizontal /> Manage
          </Button>
        </div>
      ))}
    </div>
  );
}

export function MailboxList({
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
    return (
      <AdminEmptyState
        Icon={Settings2}
        title="No mailboxes yet"
        description="Personal mailboxes appear here once people are invited."
      />
    );
  }
  return (
    <>
      <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface">
        {mailboxes.map((mailbox) => {
          const canMakePrimary = mailbox.kind === "personal" && !mailbox.isPrimary;
          const canDelete = mailbox.kind === "shared" || canMakePrimary;
          return (
            <div
              key={mailbox.id}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-accent/45 sm:gap-4"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
                <MailPlus className="size-4.5" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{mailbox.displayName}</p>
                <p className="truncate text-xs text-muted-foreground">{mailbox.address}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="outline" className="hidden capitalize sm:inline-flex">
                  {mailbox.kind}
                </Badge>
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
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setDeleteCandidate(mailbox)}
                      >
                        <Trash2 /> Delete
                      </DropdownMenuItem>
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

function AdminEmptyState({
  Icon,
  title,
  description,
}: {
  Icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface px-6 py-16 text-center">
      <span className="mx-auto grid size-12 place-items-center rounded-lg bg-primary/12 text-primary">
        <Icon className="size-5" />
      </span>
      <p className="mt-4 text-base font-semibold tracking-[-0.01em]">{title}</p>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground text-pretty">
        {description}
      </p>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border bg-surface">
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
