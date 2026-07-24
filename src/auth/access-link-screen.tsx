import { useQuery } from "@tanstack/react-query";
import { Fingerprint, Inbox, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import type { AccessLinkKind } from "../../shared/auth";
import { Button } from "@/components/ui/button";
import { api, responseJson } from "@/lib/api";
import { useAuth } from "./auth-context";

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
    <main className="grid min-h-dvh place-items-center bg-background px-6 py-12">
      <section className="w-full max-w-sm">
        <span className="mb-10 grid size-10 place-items-center rounded-xl bg-foreground text-background">
          <Inbox className="size-5" />
        </span>
        {preview.isLoading ? (
          <LoaderCircle className="animate-spin text-muted-foreground" />
        ) : preview.isError || !preview.data ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">{labels.unavailable}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This link is invalid, expired, or already used.
            </p>
          </>
        ) : (
          <>
            <p className="text-xs font-medium text-muted-foreground">{labels.eyebrow}</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em]">
              {preview.data.name}
            </h1>
            <p className="mt-3 border-y py-4 text-sm leading-6 text-muted-foreground">
              Personal mailbox:{" "}
              <strong className="font-medium text-foreground">{preview.data.email}</strong>
            </p>
            {kind === "recovery" && (
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                Registering a new passkey removes existing passkeys and signs out other sessions.
              </p>
            )}
            <Button
              className={kind === "recovery" ? "mt-6 h-10 w-full" : "mt-8 h-10 w-full"}
              disabled={busy}
              onClick={() => void complete()}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <Fingerprint />}
              {labels.button}
            </Button>
          </>
        )}
      </section>
    </main>
  );
}
