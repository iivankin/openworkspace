import { useMutation } from "@tanstack/react-query";
import { Fingerprint, LoaderCircle } from "lucide-react";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { api, responseJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAuth } from "./auth-context";

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
    <main className="grid min-h-dvh place-items-center bg-background px-6 py-12">
      <section className="w-full max-w-md">
        <div className="mb-10 flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl bg-foreground text-background">
            <Fingerprint className="size-4" />
          </span>
          <div>
            <p className="text-sm font-semibold">OpenWorkspace Identity</p>
            <p className="text-xs text-muted-foreground">Sign-out confirmation</p>
          </div>
        </div>

        <div className="border-b pb-6">
          <h1 className="text-3xl font-semibold tracking-[-0.035em]">
            Sign out of OpenWorkspace?
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            An application asked to end your OpenWorkspace session. Confirm only
            if you meant to sign out.
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-3">
          <Button
            className="h-10 w-full"
            disabled={confirm.isPending || !auth.authenticated}
            onClick={() => confirm.mutate()}
          >
            {confirm.isPending ? <LoaderCircle className="animate-spin" /> : null}
            Sign out
          </Button>
          <Link
            to="/"
            className={cn(buttonVariants({ variant: "ghost" }), "h-10 w-full")}
          >
            Stay signed in
          </Link>
        </div>
      </section>
    </main>
  );
}
