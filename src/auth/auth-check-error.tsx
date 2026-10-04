import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AuthCheckError({ onRetry }: { onRetry: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  return (
    <main className="grid min-h-dvh place-content-center justify-items-center gap-4 p-6">
      <h1 className="text-lg font-semibold">Could not check session</h1>
      <Button variant="outline" disabled={pending} onClick={() => {
        setPending(true);
        void onRetry().finally(() => setPending(false));
      }}>
        {pending && <LoaderCircle className="animate-spin" />}
        Retry
      </Button>
    </main>
  );
}
