import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";

function Checkbox({
  className,
  ...props
}: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer grid size-4.5 shrink-0 place-items-center rounded-[6px] border border-input bg-surface text-primary-foreground shadow-2xs outline-none transition-[color,background-color,border-color,box-shadow] duration-150 ease-out hover:border-[color-mix(in_oklch,var(--input),var(--foreground)_20%)] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 data-checked:border-primary data-checked:bg-primary data-disabled:pointer-events-none data-disabled:opacity-50 dark:not-data-checked:bg-input/20",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator">
        <CheckIcon className="size-3.5" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
