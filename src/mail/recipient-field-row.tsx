import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";

export function RecipientFieldRow({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <InputGroup className="h-11 rounded-none border-0 bg-transparent dark:bg-transparent">
      <InputGroupAddon className="w-14 justify-start pl-0">
        <InputGroupText className="text-xs">{label}</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput
        className="px-3"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="name@example.com"
      />
    </InputGroup>
  );
}
