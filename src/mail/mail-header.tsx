import {
  Check,
  ChevronDown,
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
import { useTheme, type Theme } from "@/hooks/use-theme";
import type { Mailbox } from "./types";

const themeIcon: Record<Theme, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

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
  const ThemeIcon = themeIcon[theme];

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
      <div className="flex shrink-0 items-center gap-2.5 lg:mr-2">
        <span className="grid size-8 place-items-center rounded-xl bg-foreground text-background">
          <Inbox className="size-4" />
        </span>
        <span className="hidden text-sm font-semibold tracking-tight xl:inline">OpenWorkspace</span>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        {showSearch && (
          <label className="relative hidden w-40 xl:block 2xl:w-56">
            <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input className="h-9 border-0 bg-muted/65 pl-8 shadow-none" placeholder={searchPlaceholder} value={search} onChange={(event) => onSearchChange(event.target.value)} />
          </label>
        )}
        <Button className="hidden lg:inline-flex" size="sm" disabled={!mailbox?.canSend} onClick={onCompose}>
          <PenLine /> Compose
        </Button>
        <Button className="lg:hidden" variant="ghost" size="icon-sm" disabled={!mailbox?.canSend} onClick={onCompose}>
          <PenLine /><span className="sr-only">Compose</span>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button aria-label="Account and mailboxes" variant="ghost" size="sm" className="max-w-52 px-2" />}>
            <Avatar className="size-7">
              <AvatarImage src={auth.user?.avatarUrl ?? undefined} />
              <AvatarFallback className="text-[10px]">{auth.user?.name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="hidden min-w-0 text-left md:block">
              <span className="block truncate text-xs font-medium">{mailbox?.displayName ?? "Mailbox"}</span>
              <span className="block truncate text-[10px] text-muted-foreground">{mailbox?.address}</span>
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                <span className="block text-foreground">{auth.user?.name}</span>
                <span className="font-normal">{auth.user?.role}</span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Mailboxes</DropdownMenuLabel>
              {mailboxes.map((item) => (
                <DropdownMenuItem key={item.id} onClick={() => onMailboxChange(item.id)}>
                  <Mail />
                  <span className="min-w-0">
                    <span className="block truncate">{item.displayName}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{item.address}</span>
                  </span>
                  {item.id === mailbox?.id && <Check className="ml-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {auth.user?.role === "admin" && <DropdownMenuItem onClick={onAdministration}><Settings2 />Administration</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")}><ThemeIcon />Theme: {theme}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void auth.logout()}><UserRound />Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
