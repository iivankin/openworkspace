import { Inbox, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function BrandMark({
  Icon = Inbox,
  className,
}: {
  Icon?: LucideIcon;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "grid size-10 place-items-center rounded-md bg-primary text-primary-foreground",
        className,
      )}
    >
      <Icon className="size-5" strokeWidth={2.25} />
    </span>
  );
}

export function AuthShell({
  Icon,
  title = "OpenWorkspace",
  subtitle,
  width = "max-w-md",
  children,
}: {
  Icon?: LucideIcon;
  title?: string;
  subtitle?: string;
  width?: string;
  children: ReactNode;
}) {
  return (
    <main className="paper-grain grid min-h-dvh place-items-center bg-background px-6 py-12">
      <section className={cn("w-full animate-rise", width)}>
        <div className="mb-6 flex items-center gap-3">
          <BrandMark Icon={Icon} />
          <div>
            <p className="text-[0.9375rem] leading-tight font-semibold tracking-[-0.01em]">{title}</p>
            {subtitle ? (
              <p className="text-xs leading-tight text-muted-foreground">{subtitle}</p>
            ) : null}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-surface p-6 sm:p-7">
          {children}
        </div>
      </section>
    </main>
  );
}

export function AuthHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="border-b border-border/70 pb-6">
      {eyebrow ? (
        <p className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          {eyebrow}
        </p>
      ) : null}
      <h1 className="mt-2.5 text-[1.75rem] leading-tight font-semibold tracking-[-0.025em] text-balance">
        {title}
      </h1>
      {description ? (
        <p className="mt-2.5 text-sm leading-6 text-muted-foreground text-pretty">{description}</p>
      ) : null}
    </div>
  );
}
