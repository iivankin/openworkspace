import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function ToolbarTooltip({
  label,
  side = "top",
  sideOffset = 7,
  children,
}: {
  label: string;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={sideOffset}>{label}</TooltipContent>
    </Tooltip>
  );
}
