import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyableValueRow({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-h-11 items-center gap-3 py-2">
      <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
        {value ?? "—"}
      </span>
      {value ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1_500);
            });
          }}
        >
          {copied ? <Check /> : <Copy />}
          <span className="sr-only">Copy {label}</span>
        </Button>
      ) : null}
    </div>
  );
}
