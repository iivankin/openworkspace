import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Fingerprint, LoaderCircle, ShieldCheck } from "lucide-react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, responseJson } from "@/lib/api";

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
    <main className="grid min-h-dvh place-items-center bg-background px-6 py-12">
      <section className="w-full max-w-md">
        <div className="mb-10 flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl bg-foreground text-background">
            <Fingerprint className="size-4" />
          </span>
          <div>
            <p className="text-sm font-semibold">OpenWorkspace Identity</p>
            <p className="text-xs text-muted-foreground">Secure application access</p>
          </div>
        </div>

        {request.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : request.isError || !request.data ? (
          <div className="border-y py-8">
            <h1 className="text-xl font-semibold">Request unavailable</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This authorization request expired or no longer belongs to your session.
            </p>
          </div>
        ) : (
          <>
            <div className="border-b pb-6">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Authorization request
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-[-0.035em]">
                Continue to {request.data.request.clientName}
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                This application is asking OpenWorkspace to confirm your identity.
              </p>
            </div>

            <div className="divide-y">
              {request.data.request.scopes.map((scope) => (
                <div key={scope} className="flex gap-3 py-3.5">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{scope}</p>
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                      {scopeDescriptions[scope] ?? "Use this approved permission"}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                disabled={decision.isPending}
                onClick={() => decision.mutate(false)}
              >
                Deny
              </Button>
              <Button
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
      </section>
    </main>
  );
}
