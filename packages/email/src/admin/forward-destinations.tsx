import {
  Badge,
  Skeleton,
  responseJson,
  useAddressSection,
} from "@open-workspace/core/ui";
import type { TeamAddress, UserAddress } from "@open-workspace/core/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { mailApi } from "../lib/mail-api";

/**
 * A forward's destinations in the address editor (People or Teams), each
 * Confirmed or Waiting for confirmation: Cloudflare forwards to one only
 * after it followed the link in Cloudflare's email. Saving the address adds
 * new destinations; one that Email Routing still lacks (adding it failed)
 * makes this section ask "Save address" to add it again, and shows why it
 * failed (worker/mail/forward-destinations.ts).
 */
export function ForwardDestinations({
  address,
}: {
  address: TeamAddress | UserAddress;
}) {
  if (address.delivery !== "forward" || !address.forwardTo.length) return null;

  return (
    <DestinationList
      mailboxId={address.mailboxId}
      forwardTo={address.forwardTo}
    />
  );
}

function DestinationList({
  mailboxId,
  forwardTo,
}: {
  mailboxId: string;
  /** As the form has them, saved or not. */
  forwardTo: string[];
}) {
  const queryClient = useQueryClient();
  const queryKey = ["forward-destinations", mailboxId];
  const param = { mailboxId };

  const saved = useQuery({
    queryKey,
    queryFn: async () =>
      responseJson(
        await mailApi.api.mail["forward-destinations"][":mailboxId"].$get({
          param,
        })
      ),
  });

  const statuses = new Map(
    (saved.data?.destinations ?? []).map((destination) => [
      destination.email.toLowerCase(),
      destination.status,
    ])
  );

  // A new destination, or a saved one Email Routing lacks: saving adds it.
  const missing =
    saved.data?.connected === true &&
    forwardTo.some((email) => {
      const status = statuses.get(email);

      return status === undefined || status === "missing";
    });

  useAddressSection({
    dirty: missing,
    // Runs after the address is saved, so the new destinations are stored.
    save: async () => {
      const response = await mailApi.api.mail["forward-destinations"][
        ":mailboxId"
      ].$post({ param });

      // Either way, show what Email Routing has now.
      await queryClient.invalidateQueries({ queryKey });
      await responseJson(response);
    },
  });

  return (
    <div className="space-y-2">
      <p className="text-foreground/85 text-[0.8125rem] font-semibold">
        Forward destinations
      </p>
      <ul className="divide-border/60 ring-border divide-y overflow-hidden rounded-xl ring-1">
        {forwardTo.map((email) => {
          const status = statuses.get(email);

          return (
            <li key={email} className="flex items-center gap-3 px-3.5 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
                {email}
              </span>
              {saved.isPending ? (
                <Skeleton className="h-5 w-24" />
              ) : status === undefined ? (
                <span className="text-muted-foreground text-xs">
                  Gets a confirmation email when you save
                </span>
              ) : status === "missing" ? (
                <Badge variant="destructive">Not added to Cloudflare</Badge>
              ) : status === "confirmed" ? (
                <Badge variant="success">Confirmed</Badge>
              ) : status === "waiting" ? (
                <Badge variant="warning">Waiting for confirmation</Badge>
              ) : null}
            </li>
          );
        })}
      </ul>
      {saved.isError ? (
        <p className="text-destructive text-xs">
          Couldn't check these with Cloudflare: {saved.error.message}
        </p>
      ) : saved.data && !saved.data.connected ? (
        <p className="text-muted-foreground text-xs">
          Email Routing isn't connected here (local development), so
          confirmations can't be checked and nothing is forwarded.
        </p>
      ) : forwardTo.some((email) => statuses.get(email) === "missing") ? (
        <p className="text-destructive text-xs">
          Cloudflare didn't add a destination, so it got no confirmation email.
          Save the address to try again.
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          Mail goes only to confirmed destinations. Each new one gets an email
          from Cloudflare with a link to confirm it.
        </p>
      )}
    </div>
  );
}
