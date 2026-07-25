import { useQuery } from "@tanstack/react-query";
import { Fingerprint, Inbox, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, responseJson } from "@/lib/api";
import { useAuth } from "./auth-context";

export function OidcLoginScreen() {
  const auth = useAuth();
  const { requestId = "" } = useParams();
  const [busy, setBusy] = useState(false);
  const transaction = useQuery({
    queryKey: ["oidc-login", requestId],
    queryFn: async () =>
      responseJson(
        await api.api.oidc.login[":id"].$get({
          param: { id: requestId },
        }),
      ),
    retry: false,
  });

  async function reauthenticate(mock = false) {
    setBusy(true);
    try {
      const redirectTo = await auth.reauthenticate(requestId, mock);
      window.location.assign(redirectTo);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Authentication failed",
      );
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6 py-12">
      <section className="w-full max-w-sm">
        <div className="mb-12 flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl bg-foreground text-background">
            <Inbox className="size-4" />
          </span>
          <span className="text-sm font-semibold">OpenWorkspace</span>
        </div>

        {transaction.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-10 w-4/5" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : transaction.isError || !transaction.data ? (
          <div className="border-y py-7">
            <h1 className="text-2xl font-semibold tracking-tight">
              Request unavailable
            </h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              This sign-in request expired or was opened in another browser.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-8 border-b pb-6">
              <p className="text-xs font-medium text-muted-foreground">
                Identity confirmation
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em]">
                Continue to {transaction.data.transaction.clientName}
              </h1>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Confirm your identity with a passkey. Your existing mail
                session is replaced only after verification succeeds.
              </p>
            </div>
            <Button
              className="h-10 w-full"
              disabled={busy}
              onClick={() => void reauthenticate()}
            >
              {busy
                ? <LoaderCircle className="animate-spin" />
                : <Fingerprint />}
              Confirm with passkey
            </Button>
            {auth.mockAuthEnabled && (
              <Button
                className="mt-3 w-full"
                variant="outline"
                disabled={busy}
                onClick={() => void reauthenticate(true)}
              >
                Open seeded local demo
              </Button>
            )}
          </>
        )}
      </section>
    </main>
  );
}
