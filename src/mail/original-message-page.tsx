import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  LoaderCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { Button, buttonVariants } from "@/components/ui/button";
import { api, responseJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { dkimSigningDomains } from "./original-message";

const AUTHENTICATION_DOCS =
  "https://developers.cloudflare.com/email-service/concepts/email-authentication/";

function originalUrl(mailboxId: string, messageId: string) {
  return `/api/mail/messages/${encodeURIComponent(messageId)}/original?mailboxId=${encodeURIComponent(mailboxId)}`;
}

async function responseMessage(response: Response) {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message;
  } catch {
    return undefined;
  }
}

function verdictTone(value: string | null) {
  if (value === "pass") return "text-success";
  if (["fail", "permerror", "temperror"].includes(value ?? "")) {
    return "text-destructive";
  }
  return "text-muted-foreground";
}

function AuthenticationRow({
  label,
  value,
  displayValue,
  detail,
  href,
}: {
  label: string;
  value: string | null;
  displayValue?: string;
  detail?: string;
  href: string;
}) {
  return (
    <div className="grid gap-1 border-b px-1 py-4 last:border-b-0 sm:grid-cols-[9rem_1fr_auto] sm:items-baseline sm:gap-5">
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0">
        <span className={cn("font-semibold tracking-wide", verdictTone(value))}>
          {displayValue ?? value?.toLocaleUpperCase() ?? "UNAVAILABLE"}
        </span>
        {detail ? <span className="ml-2 text-muted-foreground">{detail}</span> : null}
      </dd>
      <dd>
        <a
          className="text-sm font-medium text-info hover:underline"
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          Learn more
        </a>
      </dd>
    </div>
  );
}

const unavailableMessages = {
  expired: "Cloudflare no longer retains analytics for this message.",
  missing_message_id: "This message has no Message-ID to match with Cloudflare.",
  not_configured: "Cloudflare authentication details are not configured for this account.",
  not_found: "Cloudflare has not published analytics for this message yet.",
  rate_limited: "Authentication details were requested too often. Try again shortly.",
  request_failed: "Cloudflare authentication details are temporarily unavailable.",
} as const;

const retryableUnavailableReasons = new Set([
  "not_found",
  "rate_limited",
  "request_failed",
]);

export function OriginalMessagePage() {
  const { mailboxId, messageId } = useParams();
  const [copied, setCopied] = useState(false);
  const validParams = Boolean(mailboxId && messageId);
  const sourceUrl = validParams ? originalUrl(mailboxId!, messageId!) : "";
  const source = useQuery({
    queryKey: ["message-original", mailboxId, messageId],
    enabled: validParams,
    queryFn: async () => {
      const response = await fetch(sourceUrl);
      if (!response.ok) {
        throw new Error(
          await responseMessage(response) ?? `Original message failed (${response.status})`,
        );
      }
      return response.text();
    },
    staleTime: Infinity,
  });
  const details = useQuery({
    queryKey: ["message-authentication", mailboxId, messageId],
    enabled: validParams,
    queryFn: async () => responseJson(
      await api.api.mail.messages[":messageId"].authentication.$get({
        param: { messageId: messageId! },
        query: { mailboxId: mailboxId! },
      }),
    ),
    // Cloudflare can publish the routing event after the message itself. A
    // short stale window lets a revisit recover without polling in the
    // background; successful results are persisted by the mailbox backend.
    staleTime: 15_000,
  });
  const signingDomains = useMemo(
    () => source.data ? dkimSigningDomains(source.data) : [],
    [source.data],
  );
  const sourceByteLength = useMemo(
    () => source.data ? new TextEncoder().encode(source.data).byteLength : null,
    [source.data],
  );

  useEffect(() => {
    if (!details.data?.original.subject) return;
    const previousTitle = document.title;
    document.title = `Original · ${details.data.original.subject}`;
    return () => {
      document.title = previousTitle;
    };
  }, [details.data?.original.subject]);

  if (!validParams) {
    return <main className="grid min-h-dvh place-items-center">Original message not found.</main>;
  }

  const authentication = details.data?.state === "available"
    ? details.data.authentication
    : null;
  const original = details.data?.original;
  const canRetryAuthentication = details.isError
    || (
      details.data?.state === "unavailable"
      && retryableUnavailableReasons.has(details.data.reason)
    );
  const spamDetail = authentication
    ? [
        authentication.isSpam ? "Flagged by Cloudflare" : "Not flagged by Cloudflare",
        authentication.spamScore !== null
        && authentication.spamThreshold !== null
          ? `score ${authentication.spamScore} / ${authentication.spamThreshold}`
          : null,
      ].filter(Boolean).join(" · ")
    : undefined;

  async function copySource() {
    if (!source.data) return;
    await navigator.clipboard.writeText(source.data);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
              Original message
            </h1>
            {original ? (
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {original.subject}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copySource()}
              disabled={!source.data}
            >
              {copied ? <Check /> : <Copy />}
              <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
            </Button>
            <a
              className={buttonVariants({ variant: "ghost", size: "sm" })}
              href={sourceUrl}
              download={`${messageId}.eml`}
            >
              <Download />
              <span className="hidden sm:inline">Download</span>
            </a>
            <Link
              className={buttonVariants({ variant: "ghost", size: "sm" })}
              to={`/mail/${encodeURIComponent(mailboxId!)}`}
            >
              <ArrowLeft />
              <span className="hidden sm:inline">Mail</span>
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
        {original ? (
          <dl className="mb-10 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-[7rem_1fr]">
            <dt className="text-muted-foreground">From</dt>
            <dd className="break-all">{original.from}</dd>
            <dt className="text-muted-foreground">To</dt>
            <dd className="break-all">{original.to.join(", ")}</dd>
            <dt className="text-muted-foreground">Received</dt>
            <dd>{new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "long",
            }).format(new Date(original.receivedAt))}</dd>
            <dt className="text-muted-foreground">Message-ID</dt>
            <dd className="break-all font-mono text-xs">{original.messageId ?? "Unavailable"}</dd>
          </dl>
        ) : null}

        <section aria-labelledby="authentication-heading" className="mb-12">
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2 id="authentication-heading" className="font-heading text-xl font-semibold">
              Authentication
            </h2>
            <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
              Cloudflare Email Routing
            </span>
          </div>
          {details.isLoading ? (
            <div className="flex items-center gap-2 border-y py-6 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> Checking authentication…
            </div>
          ) : authentication ? (
            <dl className="border-y">
              <AuthenticationRow
                label="SPF"
                value={authentication.spf}
                href={`${AUTHENTICATION_DOCS}#spf-sender-policy-framework`}
              />
              <AuthenticationRow
                label="DKIM"
                value={authentication.dkim}
                detail={signingDomains.length ? `with domain ${signingDomains.join(", ")}` : undefined}
                href={`${AUTHENTICATION_DOCS}#dkim-domainkeys-identified-mail`}
              />
              <AuthenticationRow
                label="DMARC"
                value={authentication.dmarc}
                displayValue={authentication.dmarc === "none" ? "POLICY NONE" : undefined}
                detail={authentication.dmarc === "none" ? "Monitoring only" : undefined}
                href={`${AUTHENTICATION_DOCS}#dmarc-domain-based-message-authentication-reporting--conformance`}
              />
              <AuthenticationRow
                label="Spam"
                value={authentication.isSpam ? "fail" : "pass"}
                detail={spamDetail}
                href="https://developers.cloudflare.com/email-service/observability/metrics-analytics/"
              />
            </dl>
          ) : (
            <div className="flex items-center justify-between gap-4 border-y py-5">
              <p className="text-sm text-muted-foreground">
                {details.isError
                  ? details.error.message
                  : details.data?.state === "unavailable"
                    ? unavailableMessages[details.data.reason]
                    : "Authentication details are unavailable."}
              </p>
              {canRetryAuthentication ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={details.isFetching}
                  onClick={() => void details.refetch()}
                >
                  {details.isFetching ? <LoaderCircle className="animate-spin" /> : null}
                  Try again
                </Button>
              ) : null}
            </div>
          )}
        </section>

        <section aria-labelledby="source-heading">
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2 id="source-heading" className="font-heading text-xl font-semibold">
              Raw source
            </h2>
            {sourceByteLength !== null ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {sourceByteLength.toLocaleString()} bytes
              </span>
            ) : null}
          </div>
          {source.isLoading ? (
            <div className="flex min-h-56 items-center justify-center border-y bg-surface-sunken text-muted-foreground">
              <LoaderCircle className="size-5 animate-spin" />
            </div>
          ) : source.isError ? (
            <p className="border-y py-8 text-destructive">{source.error.message}</p>
          ) : (
            <pre className="max-h-[65dvh] overflow-auto border-y bg-surface-sunken px-4 py-5 font-mono text-[0.72rem] leading-5 whitespace-pre sm:px-6">
              {source.data}
            </pre>
          )}
        </section>
      </div>
    </main>
  );
}
