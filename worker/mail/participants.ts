import { normalizeEmail, normalizeMailboxAddress } from "../lib/ids";
import type { MailAddress } from "../mailbox/model";

export function normalizedParticipantSet(
  values: Iterable<string>,
  ownAddress: string,
) {
  const own = normalizeMailboxAddress(ownAddress);
  const result = new Set<string>();
  for (const value of values) {
    const normalized = normalizeEmail(value);
    if (
      normalized
      && normalizeMailboxAddress(normalized) !== own
    ) {
      result.add(normalized);
    }
  }
  return result;
}

export function uniqueParticipantAddresses(
  values: Iterable<MailAddress>,
  ownAddress: string,
) {
  return [
    ...normalizedParticipantSet(
      Array.from(values, (value) => value.address),
      ownAddress,
    ),
  ];
}

export function sameParticipantSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
) {
  return left.size === right.size
    && [...left].every((value) => right.has(value));
}

export function participantLabels(
  values: Iterable<MailAddress>,
  ownAddress: string,
) {
  const own = normalizeMailboxAddress(ownAddress);
  const result = new Map<string, string>();
  for (const participant of values) {
    const normalized = normalizeEmail(participant.address);
    if (
      !normalized
      || normalizeMailboxAddress(normalized) === own
      || result.has(normalized)
    ) continue;
    result.set(
      normalized,
      participant.name?.trim() || participant.address,
    );
  }
  return [...result.values()];
}
