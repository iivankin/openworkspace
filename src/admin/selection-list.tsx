import { Checkbox } from "@/components/ui/checkbox";

export function SelectionList({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: Array<{ id: string; label: string; detail?: string }>;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="mt-3 max-h-56 divide-y divide-border/60 overflow-y-auto rounded-xl bg-surface-sunken/50 ring-1 ring-border">
      <legend className="sr-only">{label}</legend>
      {items.map((item) => (
        <label key={item.id} className="flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-accent/40">
          <Checkbox
            checked={value.includes(item.id)}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? [...value, item.id]
                  : value.filter((id) => id !== item.id),
              )}
          />
          <span className="min-w-0">
            <span className="block truncate text-xs font-semibold">{item.label}</span>
            {item.detail && (
              <span className="block truncate text-[11px] text-muted-foreground">
                {item.detail}
              </span>
            )}
          </span>
        </label>
      ))}
      {items.length === 0 && (
        <p className="py-4 text-center text-xs text-muted-foreground">None available</p>
      )}
    </fieldset>
  );
}
