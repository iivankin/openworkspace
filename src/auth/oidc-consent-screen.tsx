import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Fingerprint, LoaderCircle, ShieldCheck } from "lucide-react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, responseJson } from "@/lib/api";
import { AuthHeading, AuthShell } from "./auth-shell";

const scopeDescriptions: Record<string, string> = {
  openid: "Confirm your identity",
  profile: "Read your name and profile picture",
  email: "Read your personal mailbox address",
  groups: "Read group memberships approved for this application",
  offline_access: "Keep access while you are away",
};

export function OidcConsentScreen() {
  const { requestId = "" } = useParams();
  const request = useQuery({
    queryKey: ["oidc-consent", requestId],
    queryFn: async () =>
      responseJson(
        await api.api.oidc.consent[":id"].$get({
          param: { id: requestId },
        }),
      ),
  });
  const decision = useMutation({
    mutationFn: async (approved: boolean) =>
      responseJson(
        await api.api.oidc.consent[":id"].$post({
          param: { id: requestId },
          json: { approved },
        }),
      ),
    onSuccess: ({ redirectTo }) => window.location.assign(redirectTo),
    onError: (error) => toast.error(error.message),
  });

  return (
    <AuthShell
      Icon={Fingerprint}
      title="OpenWorkspace Identity"
      subtitle="Secure application access"
    >
      {request.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-3/4" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : request.isError || !request.data ? (
        <AuthHeading
          title="Request unavailable"
          description="This authorization request expired or no longer belongs to your session."
        />
      ) : (
        <>
          <AuthHeading
            eyebrow="Authorization request"
            title={`Continue to ${request.data.request.clientName}`}
            description="This application is asking OpenWorkspace to confirm your identity."
          />

          <ul className="mt-6 space-y-2">
            {request.data.request.scopes.map((scope) => (
              <li
                key={scope}
                className="flex gap-3 rounded-xl bg-surface-sunken px-3.5 py-3 ring-1 ring-border"
              >
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
                <div>
                  <p className="font-mono text-[0.8125rem] font-medium">{scope}</p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {scopeDescriptions[scope] ?? "Use this approved permission"}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-7 grid grid-cols-2 gap-3">
            <Button
              variant="outline"
              size="lg"
              disabled={decision.isPending}
              onClick={() => decision.mutate(false)}
            >
              Deny
            </Button>
            <Button
              size="lg"
              disabled={decision.isPending}
              onClick={() => decision.mutate(true)}
            >
              {decision.isPending
                ? <LoaderCircle className="animate-spin" />
                : <ArrowRight />}
              Continue
            </Button>
          </div>
        </>
      )}
    </AuthShell>
  );
}
