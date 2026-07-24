import { useState, type FormEvent } from "react";
import { Fingerprint, Inbox, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "./auth-context";

export function AuthScreen() {
  const auth = useAuth();
  const [name, setName] = useState("Ilya");
  const [email, setEmail] = useState("ilya@example.com");
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
    <main className="grid min-h-dvh place-items-center bg-background px-6 py-12">
      <section className="w-full max-w-sm">
        <div className="mb-12 flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-xl bg-foreground text-background">
            <Inbox className="size-4" />
          </span>
          <span className="text-sm font-semibold">OpenWorkspace</span>
        </div>
        <div className="mb-8 border-b pb-6">
          <p className="text-xs font-medium text-muted-foreground">
            {auth.needsBootstrap ? "Initial setup" : "Authentication"}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em]">
            {auth.needsBootstrap ? "Create administrator" : "Sign in"}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {auth.needsBootstrap
              ? "The first account owns the workspace and its first personal mailbox."
              : "Use a passkey registered for this workspace."}
          </p>
        </div>

        {auth.needsBootstrap ? (
            <form className="space-y-5" onSubmit={submit}>
              <div className="space-y-2">
                <Label htmlFor="name">Your name</Label>
                <Input id="name" value={name} onChange={(event) => setName(event.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Personal mailbox</Label>
                <Input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
              </div>
              <Button className="h-10 w-full" disabled={busy}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Fingerprint />}
                Create with passkey
              </Button>
              {auth.mockAuthEnabled && (
                <Button
                  className="w-full"
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => auth.bootstrap({ name, email }, true))}
                >
                  Create local demo without passkey
                </Button>
              )}
            </form>
          ) : (
            <div className="space-y-3">
              <Button className="h-10 w-full" disabled={busy} onClick={() => void run(() => auth.login())}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Fingerprint />}
                Continue with passkey
              </Button>
              {auth.mockAuthEnabled && (
                <Button className="w-full" variant="outline" disabled={busy} onClick={() => void run(() => auth.login(true))}>
                  Open seeded local demo
                </Button>
              )}
            </div>
          )}
        <p className="mt-8 border-t pt-5 text-xs leading-5 text-muted-foreground">
          Authentication is passwordless. Biometric data remains on your device.
        </p>
      </section>
    </main>
  );
}
