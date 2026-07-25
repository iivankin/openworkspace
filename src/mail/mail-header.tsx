import {
  Check,
  ChevronsUpDown,
  Inbox,
  Mail,
  Monitor,
  Moon,
  PenLine,
  Search,
  Settings2,
  Sun,
  UserRound,
} from "lucide-react";
import { useAuth } from "@/auth/auth-context";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTheme, type Theme } from "@/hooks/use-theme";
import type { Mailbox } from "./types";

const themeOptions: Array<{ value: Theme; label: string; Icon: typeof Sun }> = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

export function MailHeader({
  mailbox,
  mailboxes,
  search,
  searchPlaceholder,
  showSearch,
  onSearchChange,
  onMailboxChange,
  onCompose,
  onAdministration,
}: {
  mailbox?: Mailbox;
  mailboxes: Mailbox[];
  search: string;
  searchPlaceholder: string;
  showSearch: boolean;
  onSearchChange: (value: string) => void;
  onMailboxChange: (mailboxId: string) => void;
  onCompose: () => void;
  onAdministration: () => void;
}) {
  const auth = useAuth();
  const { theme, setTheme } = useTheme();

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border/70 bg-surface/80 px-3 backdrop-blur-xl sm:px-5">
      <div className="flex shrink-0 items-center gap-2.5 lg:mr-1">
        <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm ring-1 ring-primary/25">
          <Inbox className="size-4.5" strokeWidth={2.25} />
        </span>
        <span className="hidden font-display text-base leading-none font-semibold xl:inline">
          OpenWorkspace
        </span>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-2">
        {showSearch && (
          <label className="relative hidden w-48 xl:block 2xl:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-9 rounded-full bg-surface-sunken pr-3 pl-9 shadow-none"
              placeholder={searchPlaceholder}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </label>
        )}

        <Button className="hidden lg:inline-flex" disabled={!mailbox?.canSend} onClick={onCompose}>
          <PenLine /> Compose
        </Button>
        <Button className="lg:hidden" variant="outline" size="icon" disabled={!mailbox?.canSend} onClick={onCompose}>
          <PenLine /><span className="sr-only">Compose</span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={(
              <Button
                aria-label="Account and mailboxes"
                variant="ghost"
                className="h-11 max-w-60 gap-2.5 rounded-full py-0 pr-2.5 pl-1.5 hover:bg-accent"
              />
            )}
          >
            <Avatar className="size-8">
              <AvatarImage src={auth.user?.avatarUrl ?? undefined} />
              <AvatarFallback className="text-[11px]">{auth.user?.name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="hidden min-w-0 text-left md:block">
              <span className="block truncate text-[0.8125rem] leading-tight font-semibold text-foreground">
                {mailbox?.displayName ?? "Mailbox"}
              </span>
              <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                {mailbox?.address}
              </span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-80">
            <div className="flex items-center gap-3 px-2 py-2">
              <Avatar className="size-10">
                <AvatarImage src={auth.user?.avatarUrl ?? undefined} />
                <AvatarFallback className="text-xs">{auth.user?.name.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{auth.user?.name}</p>
                <p className="truncate text-xs text-muted-foreground capitalize">{auth.user?.role}</p>
              </div>
            </div>

            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Mailboxes</DropdownMenuLabel>
              {mailboxes.map((item) => {
                const active = item.id === mailbox?.id;
                return (
                  <DropdownMenuItem key={item.id} onClick={() => onMailboxChange(item.id)}>
                    <span
                      className={cn(
                        "grid size-7 shrink-0 place-items-center rounded-lg",
                        active
                          ? "bg-primary/20 text-foreground"
                          : "bg-surface-sunken text-muted-foreground",
                      )}
                    >
                      <Mail className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.8125rem] font-medium">{item.displayName}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">{item.address}</span>
                    </span>
                    {active && <Check className="shrink-0 text-primary" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>

            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Appearance</DropdownMenuLabel>
            </DropdownMenuGroup>
            <div className="flex gap-1 px-2 pb-1.5">
              {themeOptions.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={theme === value}
                  onClick={() => setTheme(value)}
                  className={cn(
                    "flex flex-1 flex-col items-center gap-1 rounded-lg border py-2 text-[11px] font-medium transition-colors",
                    theme === value
                      ? "border-primary/40 bg-primary/12 text-foreground"
                      : "border-transparent bg-surface-sunken text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {label}
                </button>
              ))}
            </div>

            <DropdownMenuSeparator />
            {auth.user?.role === "admin" && (
              <DropdownMenuItem onClick={onAdministration}><Settings2 />Administration</DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onClick={() => void auth.logout()}>
              <UserRound />Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
