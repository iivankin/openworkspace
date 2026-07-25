import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "@/admin/admin-panel";

const themeOptions: Array<{ value: Theme; label: string; Icon: typeof Sun; description: string }> = [
  {
    value: "system",
    label: "System",
    Icon: Monitor,
    description: "Match your device preference.",
  },
  {
    value: "light",
    label: "Light",
    Icon: Sun,
    description: "Bright surfaces and high contrast.",
  },
  {
    value: "dark",
    label: "Dark",
    Icon: Moon,
    description: "Dim surfaces for low light.",
  },
];

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={Monitor}
        title="Theme"
        description="Choose how OpenWorkspace looks on this device."
      />
      <AdminPanelBody>
        <div className="grid gap-3 sm:grid-cols-3">
          {themeOptions.map(({ value, label, Icon, description }) => {
            const active = theme === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setTheme(value)}
                className={cn(
                  "flex flex-col items-start gap-3 rounded-2xl border px-4 py-4 text-left transition-colors",
                  active
                    ? "border-primary/40 bg-primary/12 text-foreground"
                    : "border-border/70 bg-surface-sunken text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-5" />
                <span>
                  <span className="block text-sm font-semibold text-foreground">{label}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </AdminPanelBody>
    </div>
  );
}
