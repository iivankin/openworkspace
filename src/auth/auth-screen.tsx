import { useState, type FormEvent } from "react";
import { Fingerprint, Inbox, LoaderCircle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "./auth-context";

export function AuthScreen() {
  const auth = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(() => auth.bootstrap({ name, email }));
  }

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1fr_minmax(0,34rem)]">
      <BrandPanel />

      <section className="paper-grain flex items-center justify-center bg-background px-6 py-14 sm:px-10">
        <div className="w-full max-w-sm animate-rise">
          <div className="mb-10 flex items-center gap-2.5 lg:hidden">
            <span className="grid size-9 place-items-center rounded-md bg-primary text-primary-foreground">
              <Inbox className="size-4.5" strokeWidth={2.25} />
            </span>
            <span className="text-base font-semibold tracking-[-0.01em]">OpenWorkspace</span>
          </div>

          <p className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            {auth.needsBootstrap ? "Initial setup" : "Authentication"}
          </p>
          <h1 className="mt-3 text-[2.125rem] leading-none font-semibold tracking-[-0.03em]">
            {auth.needsBootstrap ? "Create administrator" : "Sign in"}
          </h1>
          <p className="mt-4 text-sm leading-6 text-muted-foreground text-pretty">
            {auth.needsBootstrap
              ? "The first account owns the workspace and its first personal mailbox."
              : "Use a passkey registered for this workspace."}
          </p>

          <div className="my-8 h-px rule-fade" />

          {auth.needsBootstrap ? (
            <form className="space-y-5" onSubmit={submit}>
              <div className="space-y-2">
                <Label htmlFor="name">Your name</Label>
                <Input id="name" className="h-11" value={name} onChange={(event) => setName(event.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Personal mailbox</Label>
                <Input id="email" className="h-11" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
              </div>
              <Button className="w-full" type="submit" size="lg" disabled={busy}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Fingerprint />}
                Create with passkey
              </Button>
              {auth.mockAuthEnabled && (
                <Button
                  className="w-full"
                  type="button"
                  variant="outline"
                  size="lg"
                  disabled={busy}
                  onClick={() => void run(() => auth.bootstrap({ name, email }, true))}
                >
                  Create local demo without passkey
                </Button>
              )}
            </form>
          ) : (
            <div className="space-y-3">
              <Button className="w-full" size="lg" disabled={busy} onClick={() => void run(() => auth.login())}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Fingerprint />}
                Continue with passkey
              </Button>
              {auth.mockAuthEnabled && (
                <Button className="w-full" variant="outline" size="lg" disabled={busy} onClick={() => void run(() => auth.login(true))}>
                  Open seeded local demo
                </Button>
              )}
            </div>
          )}

          <p className="mt-9 flex items-start gap-2.5 rounded-xl bg-surface-sunken px-3.5 py-3 text-xs leading-5 text-muted-foreground ring-1 ring-border">
            <ShieldCheck className="mt-px size-4 shrink-0 text-success" />
            Authentication is passwordless. Biometric data remains on your device.
          </p>
        </div>
      </section>
    </main>
  );
}

function BrandPanel() {
  return (
    <aside className="hidden border-r border-white/8 bg-[oklch(0.19_0.035_250)] p-14 text-[oklch(0.96_0.012_240)] lg:flex lg:flex-col lg:justify-between">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-md bg-primary text-primary-foreground">
          <Inbox className="size-5" strokeWidth={2.25} />
        </span>
        <span className="text-lg font-semibold tracking-[-0.015em]">OpenWorkspace</span>
      </div>

      <div className="max-w-md">
        <p className="text-[2.25rem] leading-[1.08] font-semibold tracking-[-0.035em] text-balance">
          Mail that belongs to your workspace, not to a vendor.
        </p>
        <p className="mt-6 text-sm leading-7 text-[oklch(0.96_0.008_84_/_0.62)] text-pretty">
          Shared mailboxes, passkey-only access, and single sign-on — running entirely
          on infrastructure you control.
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-6 border-t border-white/10 pt-8 text-xs">
        {[
          ["Passkeys", "No passwords, ever"],
          ["Shared", "Team mailboxes"],
          ["SSO", "OIDC + SAML"],
        ].map(([term, detail]) => (
          <div key={term}>
            <dt className="text-base font-semibold text-primary">{term}</dt>
            <dd className="mt-1 text-[oklch(0.96_0.008_84_/_0.55)]">{detail}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
