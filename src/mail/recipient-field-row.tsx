import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

export function RecipientFieldRow({
  label,
  value,
  onChange,
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  compact?: boolean;
}) {
  return (
    <InputGroup
      className={cn(
        "rounded-none bg-transparent dark:bg-transparent",
        compact ? "h-10 border-x-0 border-t-0" : "h-11 border-0",
      )}
    >
      <InputGroupAddon
        className={cn(
          "justify-start",
          compact ? "w-12 pl-3" : "w-14 pl-0",
        )}
      >
        <InputGroupText className="text-xs">{label}</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        className="px-3"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="name@example.com"
      />
    </InputGroup>
  );
}
