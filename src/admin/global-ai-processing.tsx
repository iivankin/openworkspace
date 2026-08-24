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
        description="One global switch for incoming mail classification"
      />
      <AdminPanelBody className="flex items-center justify-between gap-6">
        <div>
          <p className="text-sm font-medium">Enable Workers AI</p>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
            Mailbox members configure shared rules and a confidence threshold for each mailbox in Mail. Turning this off preserves those settings.
          </p>
        </div>
        {loading ? (
          <Skeleton className="h-6 w-10 shrink-0 rounded-full" />
        ) : (
          <Switch
            aria-label="Enable AI mail processing globally"
            checked={enabled}
            disabled={update.isPending}
            onCheckedChange={(checked) => update.mutate(checked)}
          />
        )}
      </AdminPanelBody>
    </div>
  );
}
