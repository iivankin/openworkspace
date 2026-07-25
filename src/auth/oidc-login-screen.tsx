import { useQuery } from "@tanstack/react-query";
import { Fingerprint, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, responseJson } from "@/lib/api";
import { useAuth } from "./auth-context";
import { AuthHeading, AuthShell } from "./auth-shell";

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
    <AuthShell subtitle="Identity confirmation">
      {transaction.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-10 w-4/5" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : transaction.isError || !transaction.data ? (
        <AuthHeading
          title="Request unavailable"
          description="This sign-in request expired or was opened in another browser."
        />
      ) : (
        <>
          <AuthHeading
            eyebrow="Identity confirmation"
            title={`Continue to ${transaction.data.transaction.clientName}`}
            description="Confirm your identity with a passkey. Your existing mail session is replaced only after verification succeeds."
          />
          <Button
            className="mt-6 w-full"
            size="lg"
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
              size="lg"
              disabled={busy}
              onClick={() => void reauthenticate(true)}
            >
              Open seeded local demo
            </Button>
          )}
        </>
      )}
    </AuthShell>
  );
}
