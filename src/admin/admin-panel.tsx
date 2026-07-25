import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const adminPanelClass =
  "overflow-hidden rounded-2xl bg-surface shadow-xs ring-1 ring-border";

export function AdminPanelHeader({
  Icon,
  title,
  description,
  children,
}: {
  Icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-border/70 bg-surface-sunken/60 px-5 py-4">
      {Icon && (
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/14 text-foreground/70">
          <Icon className="size-4.5" />
        </span>
      )}
      {children}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{title}</p>
        {description ? (
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

export function AdminPanelBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("p-5", className)}>{children}</div>;
}

export function AdminPanelFooter({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-3 border-t border-border/70 bg-surface-sunken/60 px-5 py-3.5",
        className,
      )}
    >
      {children}
    </div>
  );
}
