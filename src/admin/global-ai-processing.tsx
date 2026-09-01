import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, responseJson } from "@/lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "./admin-panel";

export function GlobalAiProcessing({
  enabled,
  loading,
}: {
  enabled: boolean;
  loading: boolean;
}) {
  const client = useQueryClient();
  const update = useMutation({
    mutationFn: async (nextEnabled: boolean) => responseJson(
      await api.api.admin.ai.$put({ json: { enabled: nextEnabled } }),
    ),
    onSuccess: async (result) => {
      toast.success(result.enabled ? "AI processing enabled" : "AI processing disabled");
      await client.invalidateQueries({ queryKey: ["admin-state"] });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={Sparkles}
        title="AI mail processing"
        description="OpenAI classification through Cloudflare Workers AI"
      />
      <AdminPanelBody className="flex items-center justify-between gap-6">
        <div>
          <p className="text-sm font-medium">Enable OpenAI mail classification</p>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
            Raw .eml messages are sent to OpenAI. AI Gateway credits are required.
          </p>
        </div>
        {loading ? (
          <Skeleton className="h-6 w-10 shrink-0 rounded-full" />
        ) : (
          <Switch
            aria-label="Enable OpenAI mail classification globally"
            checked={enabled}
            disabled={update.isPending}
            onCheckedChange={(checked) => update.mutate(checked)}
          />
        )}
      </AdminPanelBody>
    </div>
  );
}
