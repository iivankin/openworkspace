import { format } from "date-fns";
import {
  Check,
  CheckCheck,
  CircleAlert,
  Clock3,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type {
  MessageDetail,
  RecipientDeliveryStatus,
} from "./types";

type Indicator = {
  Icon: LucideIcon;
  label: string;
  tone: "muted" | "warning" | "danger";
};

function recipients(message: MessageDetail) {
  return [...new Set([
    ...message.toAddresses,
    ...message.ccAddresses,
    ...message.bccAddresses,
  ].map((address) => address.trim().toLocaleLowerCase()))];
}

function deliveryIndicator(
  message: MessageDetail,
  totalRecipients: number,
): Indicator {
  if (message.transportState === "unconfirmed") {
    return { Icon: CircleAlert, label: "Unconfirmed", tone: "warning" };
  }
  if (message.transportState === "failed") {
    return { Icon: CircleAlert, label: "Not sent", tone: "danger" };
  }
  if (!message.deliveryStatuses.length) {
    return { Icon: Check, label: "Sent", tone: "muted" };
  }

  const delivered = message.deliveryStatuses.filter(
    (item) => item.status === "delivered" || item.status === "complained",
  ).length;
  const failed = message.deliveryStatuses.filter(
    (item) => ["bounced", "failed", "rejected"].includes(item.status),
  ).length;
  const complained = message.deliveryStatuses.some(
    (item) => item.status === "complained",
  );
  if (failed > 0 || complained) {
    return {
      Icon: CircleAlert,
      label: delivered > 0 && totalRecipients > 1
        ? `${delivered}/${totalRecipients} delivered`
        : failed > 0 ? "Not delivered" : "Marked as spam",
      tone: delivered > 0 ? "warning" : "danger",
    };
  }
  if (totalRecipients > 0 && delivered >= totalRecipients) {
    return { Icon: CheckCheck, label: "Delivered", tone: "muted" };
  }
  return {
    Icon: Clock3,
    label: delivered > 0 && totalRecipients > 1
      ? `${delivered}/${totalRecipients} delivered`
      : "Delivering",
    tone: "muted",
  };
}

function recipientStatusLabel(status: RecipientDeliveryStatus | undefined) {
  if (!status) return "Awaiting status";
  if (status.status === "delivered") return "Delivered";
  if (status.status === "deferred") return "Delivery delayed";
  if (status.status === "bounced") return "Bounced";
  if (status.status === "failed") return "Delivery failed";
  if (status.status === "rejected") return "Rejected";
  return "Marked as spam";
}

export function DeliveryIndicator({ message }: { message: MessageDetail }) {
  if (message.direction !== "outgoing") return null;
  const addresses = recipients(message);
  const statuses = new Map(
    message.deliveryStatuses.map((status) => [
      status.recipient.toLocaleLowerCase(),
      status,
    ]),
  );
  const indicator = deliveryIndicator(message, addresses.length);
  const { Icon } = indicator;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <button
            type="button"
            className={cn(
              "mt-2 ml-auto flex items-center gap-1 text-[11px] outline-none hover:opacity-75 focus-visible:underline",
              indicator.tone === "muted" && "text-muted-foreground",
              indicator.tone === "warning" && "text-amber-700 dark:text-amber-400",
              indicator.tone === "danger" && "text-destructive",
            )}
            aria-label={`Delivery status: ${indicator.label}`}
          />
        )}
      >
        <Icon className="size-3.5" />
        <span>{indicator.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Delivery</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {message.transportState === "unconfirmed" ? (
          <p className="px-2 py-2 text-xs text-amber-700 dark:text-amber-400">
            {message.transportError
              ? `${message.transportError} Submission could not be confirmed.`
              : "Submission could not be confirmed."} Automatic resend is disabled because it
            could deliver a duplicate.
          </p>
        ) : message.transportState === "failed" ? (
          <p className="px-2 py-2 text-xs text-destructive">
            {message.transportError || "The message could not be prepared for sending."}
          </p>
        ) : (
          <div className="divide-y">
            {addresses.map((address) => {
              const status = statuses.get(address);
              return (
                <div key={address} className="px-2 py-2 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{address}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {recipientStatusLabel(status)}
                    </span>
                  </div>
                  {status?.detail || status?.smtpCode ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {[status.smtpCode, status.detail].filter(Boolean).join(" · ")}
                    </p>
                  ) : null}
                  {status ? (
                    <time className="mt-1 block text-[10px] text-muted-foreground">
                      {format(new Date(status.eventAt), "MMM d · HH:mm")}
                    </time>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
