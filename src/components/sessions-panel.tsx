import { useState } from "react";
import {
  CalendarClock,
  LoaderCircle,
  MapPin,
  Monitor,
  Network,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import {
  adminPanelClass,
  AdminPanelHeader,
} from "@/admin/admin-panel";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatSessionLocation } from "@/lib/session-location";

export type SessionRecord = {
  id: string;
  userAgent: string | null;
  location: string | null;
  ipAddress: string | null;
  createdAt: string | Date;
  expiresAt: string | Date;
  isCurrent: boolean;
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: string | Date) {
  return dateFormatter.format(new Date(value));
}

function sessionDevice(userAgent: string | null) {
  if (!userAgent) return { label: "Unknown device", mobile: false };
  const mobile = /Android|iPhone|iPad|Mobile/u.test(userAgent);
  const browser = /Edg(?:e|A|iOS)?\//u.test(userAgent)
    ? "Edge"
    : /(?:Chrome|CriOS)\//u.test(userAgent)
      ? "Chrome"
      : /(?:Firefox|FxiOS)\//u.test(userAgent)
        ? "Firefox"
        : /Safari\//u.test(userAgent)
          ? "Safari"
          : "Browser";
  const platform = /iPhone/u.test(userAgent)
    ? "iPhone"
    : /iPad/u.test(userAgent)
      ? "iPad"
      : /Android/u.test(userAgent)
        ? "Android"
        : /Windows/u.test(userAgent)
          ? "Windows"
          : /Macintosh|Mac OS X/u.test(userAgent)
            ? "macOS"
            : /Linux/u.test(userAgent)
              ? "Linux"
              : "unknown OS";
  return { label: `${browser} on ${platform}`, mobile };
}

function LoadingRows() {
  return Array.from({ length: 2 }, (_, index) => (
    <div key={index} className="flex items-center gap-4 border-t border-border/70 px-5 py-4 first:border-t-0">
      <Skeleton className="size-10 rounded-lg" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-64 max-w-full" />
      </div>
    </div>
  ));
}

export function SessionsPanel({
  title = "Sessions",
  description = "Active sign-ins",
  sessions,
  loading,
  error,
  pendingSessionId,
  onRetry,
  onRevoke,
}: {
  title?: string;
  description?: string;
  sessions?: SessionRecord[];
  loading: boolean;
  error: boolean;
  pendingSessionId?: string;
  onRetry: () => void;
  onRevoke: (session: SessionRecord) => void;
}) {
  const [confirmation, setConfirmation] = useState<SessionRecord | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);

  return (
    <>
      <div className={adminPanelClass}>
        <AdminPanelHeader Icon={ShieldCheck} title={title} description={description} />
        {loading ? <LoadingRows /> : error ? (
          <div className="flex items-center justify-between gap-4 px-5 py-6">
            <p className="text-sm text-destructive">Sessions unavailable</p>
            <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
          </div>
        ) : sessions?.length ? sessions.map((record) => {
          const device = sessionDevice(record.userAgent);
          const DeviceIcon = device.mobile ? Smartphone : Monitor;
          return (
            <div
              key={record.id}
              className="flex items-start gap-4 border-t border-border/70 px-5 py-4 first:border-t-0"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-sunken text-muted-foreground ring-1 ring-border/80">
                <DeviceIcon className="size-4.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium" title={record.userAgent ?? undefined}>{device.label}</p>
                  {record.isCurrent ? <Badge variant="success">Current</Badge> : null}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="size-3.5" /> {formatSessionLocation(record.location)}
                  </span>
                  {record.ipAddress ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Network className="size-3.5" /> {record.ipAddress}
                    </span>
                  ) : null}
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarClock className="size-3.5" />
                    Signed in <time dateTime={new Date(record.createdAt).toISOString()}>{formatDate(record.createdAt)}</time>
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground/75">
                  Expires{" "}
                  <time dateTime={new Date(record.expiresAt).toISOString()}>{formatDate(record.expiresAt)}</time>
                </p>
              </div>
              <Button
                type="button"
                className="mt-0.5"
                size="sm"
                variant="destructive"
                disabled={Boolean(pendingSessionId)}
                onClick={() => {
                  setConfirmation(record);
                  setConfirmationOpen(true);
                }}
              >
                {pendingSessionId === record.id ? <LoaderCircle className="animate-spin" /> : <X />}
                Revoke
              </Button>
            </div>
          );
        }) : (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">No active sessions</p>
        )}
      </div>

      <AlertDialog
        open={confirmationOpen}
        onOpenChange={setConfirmationOpen}
        onOpenChangeComplete={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke session?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.isCurrent
                ? "You will be signed out."
                : "This sign-in will be revoked."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              onClick={() => {
                const session = confirmation;
                setConfirmationOpen(false);
                if (session) onRevoke(session);
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
