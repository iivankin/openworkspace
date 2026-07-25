import { useQuery } from "@tanstack/react-query";
import { Fingerprint, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import type { AccessLinkKind } from "../../shared/auth";
import { Button } from "@/components/ui/button";
import { api, responseJson } from "@/lib/api";
import { useAuth } from "./auth-context";
import { AuthHeading, AuthShell } from "./auth-shell";

const copy = {
  invitation: {
    unavailable: "Invitation unavailable",
    eyebrow: "Workspace invitation",
    button: "Register passkey",
    error: "Could not accept invitation",
  },
  recovery: {
    unavailable: "Recovery link unavailable",
    eyebrow: "Passkey recovery",
    button: "Register replacement passkey",
    error: "Could not recover account",
  },
} satisfies Record<AccessLinkKind, Record<string, string>>;

export function AccessLinkScreen({ kind }: { kind: AccessLinkKind }) {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: ["access-link", kind, token],
    queryFn: async () => {
      const result = await responseJson(
        kind === "invitation"
          ? await api.api.auth.invitation[":token"].$get({ param: { token } })
          : await api.api.auth.recovery[":token"].$get({ param: { token } }),
      );
      return result.accessLink;
    },
    enabled: Boolean(token),
  });
  const labels = copy[kind];

  async function complete() {
    setBusy(true);
    try {
      await auth.completeAccessLink(kind, token);
      navigate("/", { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : labels.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell subtitle={labels.eyebrow} width="max-w-md">
      {preview.isLoading ? (
        <div className="grid place-items-center py-10">
          <LoaderCircle className="animate-spin text-muted-foreground" />
        </div>
      ) : preview.isError || !preview.data ? (
        <AuthHeading
          title={labels.unavailable}
          description="This link is invalid, expired, or already used."
        />
      ) : (
        <>
          <AuthHeading eyebrow={labels.eyebrow} title={preview.data.name} />
          <p className="mt-6 rounded-xl bg-surface-sunken px-4 py-3 text-sm leading-6 text-muted-foreground ring-1 ring-border">
            Personal mailbox:{" "}
            <strong className="font-semibold text-foreground">{preview.data.email}</strong>
          </p>
          {kind === "recovery" && (
            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              Registering a new passkey removes existing passkeys and signs out other sessions.
            </p>
          )}
          <Button
            className="mt-6 w-full"
            size="lg"
            disabled={busy}
            onClick={() => void complete()}
          >
            {busy ? <LoaderCircle className="animate-spin" /> : <Fingerprint />}
            {labels.button}
          </Button>
        </>
      )}
    </AuthShell>
  );
}
