import { mailboxStub } from "../mailbox";
import type { Email } from "../mailbox/schema";
import {
  messageIdForRequest,
  outgoingRequestFingerprint,
  prepareOutgoingEmail,
  type OutgoingMessageInput,
} from "./outbound";
import { discardComposerUploadStaging } from "./uploads";

export class OutgoingRequestConflictError extends Error {}

async function discardPreparedObjects(env: Env, storageKeys: string[]) {
  if (!storageKeys.length) return;
  try {
    await env.MAIL_STORAGE.delete(storageKeys);
  } catch (error) {
    // Attempt-scoped keys cannot corrupt the winning idempotent request.
    console.error("Could not remove unused outgoing mail objects", error);
  }
}

export async function submitOutgoing(input: {
  env: Env;
  requestUrl: string;
  fromAddress: string;
  fromName: string;
  compose: OutgoingMessageInput;
  conversationId: string;
  related: Email | null;
  forwarded: Email | null;
  includeRelatedContext: boolean;
}) {
  const { compose } = input;
  const stub = mailboxStub(input.env, compose.mailboxId);
  const id = await messageIdForRequest(compose.mailboxId, compose.requestId);
  const requestFingerprint = await outgoingRequestFingerprint(compose);
  const existing = await stub.getEmail(id);
  if (existing) {
    if (
      existing.direction !== "outgoing"
      || existing.requestFingerprint !== requestFingerprint
    ) {
      throw new OutgoingRequestConflictError(
        "Request identifier is already in use with different content",
      );
    }
    return { email: existing, inserted: false };
  }

  const prepared = await prepareOutgoingEmail({
    env: input.env,
    requestUrl: input.requestUrl,
    compose,
    requestFingerprint,
    id,
    conversationId: input.conversationId,
    related: input.related,
    forwarded: input.forwarded,
    includeRelatedContext: input.includeRelatedContext,
    fromAddress: input.fromAddress,
    fromName: input.fromName,
    now: new Date(),
  });

  let submission: Awaited<ReturnType<typeof stub.submitOutgoing>>;
  try {
    submission = await stub.submitOutgoing(prepared.email);
  } catch (error) {
    await discardPreparedObjects(input.env, prepared.storageKeys);
    throw error;
  }
  if (submission.outcome !== "inserted") {
    await discardPreparedObjects(input.env, prepared.storageKeys);
    if (submission.outcome === "conflict") {
      throw new OutgoingRequestConflictError(
        "Request identifier is already in use with different content",
      );
    }
  } else if (prepared.stagingUploadKeys.length) {
    await discardComposerUploadStaging({
      env: input.env,
      keys: prepared.stagingUploadKeys,
    });
  }
  return {
    email: submission.email,
    inserted: submission.outcome === "inserted",
  };
}
