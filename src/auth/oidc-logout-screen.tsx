import { useMutation } from "@tanstack/react-query";
import { Fingerprint, LoaderCircle } from "lucide-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { api, responseJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAuth } from "./auth-context";
import { AuthHeading, AuthShell } from "./auth-shell";

export function OidcLogoutScreen() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const payload = useMemo(
    () => ({
      client_id: params.get("client_id") ?? undefined,
      id_token_hint: params.get("id_token_hint") ?? undefined,
      post_logout_redirect_uri:
        params.get("post_logout_redirect_uri") ?? undefined,
      state: params.get("state") ?? undefined,
    }),
    [params],
  );

  const confirm = useMutation({
    mutationFn: async () =>
      responseJson(
        await api.api.oidc.logout.$post({
          json: payload,
        }),
      ),
    onSuccess: ({ redirectTo }) => window.location.assign(redirectTo),
    onError: (error) => toast.error(error.message),
  });

  return (
    <AuthShell
      Icon={Fingerprint}
      title="OpenWorkspace Identity"
      subtitle="Sign-out confirmation"
    >
      <AuthHeading
        title="Sign out of OpenWorkspace?"
        description="An application asked to end your OpenWorkspace session. Confirm only if you meant to sign out."
      />

      <div className="mt-6 flex flex-col gap-2">
        <Button
          className="w-full"
          size="lg"
          disabled={confirm.isPending || !auth.authenticated}
          onClick={() => confirm.mutate()}
        >
          {confirm.isPending ? <LoaderCircle className="animate-spin" /> : null}
          Sign out
        </Button>
        <Link
          to="/"
          className={cn(buttonVariants({ variant: "ghost", size: "lg" }), "w-full")}
        >
          Stay signed in
        </Link>
      </div>
    </AuthShell>
  );
}
