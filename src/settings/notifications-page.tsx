import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, LoaderCircle, Smartphone } from "lucide-react";
import { toast } from "sonner";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "@/admin/admin-panel";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/auth/auth-context";
import { api, responseJson } from "@/lib/api";
import {
  currentPushRegistrationStatus,
  disableCurrentPushSubscription,
  enableCurrentPushSubscription,
} from "@/pwa/push-subscription";

type DeviceStatus =
  | "loading"
  | "error"
  | "unsupported"
  | "prompt"
  | "repair"
  | "denied"
  | "enabled";

function deviceStatusCopy(
  status: DeviceStatus,
  configured: boolean,
  configurationError: string | null,
) {
  if (status === "error") return "Could not check this device. Try again.";
  if (configurationError) return configurationError;
  if (!configured) return "Web Push is not configured on this server.";
  if (status === "unsupported") {
    return "Push is unavailable in this browser. On iPhone or iPad, add the app to the Home Screen first.";
  }
  if (status === "denied") return "Notifications are blocked in this browser's site settings.";
  if (status === "enabled") return "This device can notify you when OpenWorkspace is closed.";
  if (status === "repair") return "The server notification key changed. Reconnect this device.";
  if (status === "prompt") return "Enable notifications for this browser and device.";
  return "Checking this device…";
}

export function NotificationsSettings() {
  const client = useQueryClient();
  const userId = useAuth().user?.id;
  const config = useQuery({
    queryKey: ["push-config"],
    queryFn: async () => responseJson(await api.api.notifications.config.$get()),
    staleTime: 60_000,
  });
  const preferences = useQuery({
    queryKey: ["notification-preferences"],
    queryFn: async () => responseJson(await api.api.notifications.preferences.$get()),
  });
  const publicKey = config.data?.publicKey ?? null;
  const deviceStatusKey = ["push-device-status", userId, publicKey] as const;
  const device = useQuery({
    queryKey: deviceStatusKey,
    enabled: Boolean(config.data?.enabled && publicKey && userId),
    queryFn: () => currentPushRegistrationStatus(publicKey!),
  });

  const enable = useMutation({
    mutationFn: async () => {
      if (!publicKey) throw new Error("Web Push is not configured");
      if (!userId) throw new Error("Sign in is required");
      await enableCurrentPushSubscription(publicKey);
    },
    onSuccess: async () => {
      client.setQueryData(deviceStatusKey, "enabled" satisfies DeviceStatus);
      toast.success("Notifications enabled on this device");
    },
    onError: (error) => {
      void client.invalidateQueries({ queryKey: deviceStatusKey });
      toast.error(error.message);
    },
  });

  const disable = useMutation({
    mutationFn: disableCurrentPushSubscription,
    onSuccess: async (removal) => {
      client.setQueryData(deviceStatusKey, "prompt" satisfies DeviceStatus);
      if (!removal.browserUnsubscribed) {
        toast.warning("Notifications are disabled; this browser kept an unused subscription.");
      } else {
        toast.success("Notifications disabled on this device");
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const updatePreference = useMutation({
    mutationFn: async ({ mailboxId, enabled }: { mailboxId: string; enabled: boolean }) =>
      responseJson(
        await api.api.notifications.preferences[":mailboxId"].$put({
          param: { mailboxId },
          json: { enabled },
        }),
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["notification-preferences"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const configured = config.data?.enabled ?? false;
  const deviceStatus: DeviceStatus = config.isError || device.isError
    ? "error"
    : config.isLoading || (configured && device.isLoading)
      ? "loading"
      : configured
        ? device.data ?? "loading"
        : "unsupported";
  const devicePending = config.isLoading
    || device.isFetching
    || enable.isPending
    || disable.isPending;

  function handleDeviceAction() {
    if (deviceStatus === "error") {
      void (config.isError ? config.refetch() : device.refetch());
      return;
    }
    enable.mutate();
  }

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={Bell}
        title="Mail notifications"
        description="Push notifications are personal to you and this device."
      />
      <AdminPanelBody className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
            <Smartphone className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">This device</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {deviceStatusCopy(
                deviceStatus,
                configured,
                config.data?.error ?? null,
              )}
            </p>
          </div>
          {deviceStatus === "enabled" ? (
            <Button variant="outline" disabled={devicePending} onClick={() => disable.mutate()}>
              {disable.isPending ? <LoaderCircle className="animate-spin" /> : <BellOff />}
              Disable
            </Button>
          ) : (
            <Button
              disabled={
                (deviceStatus !== "error" && !configured)
                || deviceStatus === "unsupported"
                || deviceStatus === "denied"
                || deviceStatus === "loading"
                || devicePending
              }
              onClick={handleDeviceAction}
            >
              {devicePending ? <LoaderCircle className="animate-spin" /> : <Bell />}
              {deviceStatus === "error"
                ? "Retry"
                : deviceStatus === "repair"
                  ? "Reconnect"
                  : "Enable"}
            </Button>
          )}
        </div>

        <div className="border-t border-border/70 pt-5">
          <p className="text-sm font-semibold">Mailboxes</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose which mailboxes may send you new-message notifications.
          </p>
          <div className="mt-4 divide-y divide-border/70">
            {preferences.isLoading ? (
              <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" /> Loading mailboxes…
              </div>
            ) : preferences.isError ? (
              <div className="flex items-center justify-between gap-4 py-4">
                <p className="text-xs text-destructive">
                  Could not load mailbox preferences.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={preferences.isFetching}
                  onClick={() => void preferences.refetch()}
                >
                  {preferences.isFetching && <LoaderCircle className="animate-spin" />}
                  Retry
                </Button>
              </div>
            ) : preferences.data?.preferences.length ? (
              preferences.data.preferences.map((preference) => (
                <label key={preference.mailboxId} className="flex items-center gap-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{preference.displayName}</span>
                    <span className="block truncate text-xs text-muted-foreground">{preference.address}</span>
                  </span>
                  <Switch
                    checked={preference.enabled}
                    disabled={updatePreference.isPending}
                    onCheckedChange={(enabled) => updatePreference.mutate({
                      mailboxId: preference.mailboxId,
                      enabled,
                    })}
                  />
                </label>
              ))
            ) : (
              <p className="py-4 text-xs text-muted-foreground">
                No mailboxes are available for notifications.
              </p>
            )}
          </div>
        </div>
      </AdminPanelBody>
      <AdminPanelFooter className="justify-start text-xs text-muted-foreground">
        Notifications are suppressed while this mailbox is visible in an open tab.
      </AdminPanelFooter>
    </div>
  );
}
