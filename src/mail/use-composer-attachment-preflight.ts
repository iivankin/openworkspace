import { useEffect, useRef } from "react";
import type { ReplyActionMode } from "../../shared/mail";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api, responseJson } from "@/lib/api";
import type { ComposerAsset, ComposerSession } from "./composer-session";

const textEncoder = new TextEncoder();

export type PreflightContext =
  | {
    kind: "compose";
    mailboxId: string;
    subject: string;
    bodyText: string;
    bodyHtml?: string;
  }
  | {
    kind: "forward";
    mailboxId: string;
    sourceEmailId: string;
    bodyText: string;
    bodyHtml?: string;
  }
  | {
    kind: "reply";
    mailboxId: string;
    sourceEmailId: string;
    mode: ReplyActionMode;
    cc: string[];
    bcc: string[];
    bodyText: string;
    bodyHtml?: string;
  };

function byteLength(value: string | undefined) {
  return value ? textEncoder.encode(value).byteLength : 0;
}

function preflightContextSignature(context: PreflightContext) {
  const content = [
    byteLength(context.bodyText),
    byteLength(context.bodyText.trimEnd()),
    byteLength(context.bodyHtml),
  ];
  if (context.kind === "compose") {
    return [
      "compose",
      context.mailboxId,
      byteLength(context.subject.trim()),
      ...content,
    ];
  }
  if (context.kind === "forward") {
    return [
      "forward",
      context.mailboxId,
      context.sourceEmailId,
      ...content,
    ];
  }
  return [
    "reply",
    context.mailboxId,
    context.sourceEmailId,
    context.mode,
    context.cc,
    context.bcc,
    ...content,
  ];
}

export function composerPlanKey(
  context: PreflightContext,
  assets: readonly ComposerAsset[],
) {
  return JSON.stringify([
    preflightContextSignature(context),
    assets.map((asset) => [
      asset.id,
      asset.uploadId,
      asset.intent,
      asset.contentId,
    ]),
  ]);
}

async function preflightComposerAttachments(
  context: PreflightContext,
  assets: readonly ComposerAsset[],
  signal?: AbortSignal,
) {
  return responseJson(
    await api.api.mail["attachment-preflight"].$post({
      json: {
        ...context,
        attachments: assets.map((asset) => ({
          uploadId: asset.uploadId!,
          disposition: asset.intent,
          ...(asset.contentId ? { contentId: asset.contentId } : {}),
        })),
      },
    }, { init: { signal } }),
  );
}

/**
 * Fetches and publishes one revision-tagged plan. Both the debounced preview
 * and the final send check use this path, so they cannot drift apart.
 */
export async function resolveComposerAttachmentPlan(
  session: ComposerSession,
  context: PreflightContext,
  assets: readonly ComposerAsset[],
  signal?: AbortSignal,
) {
  const planKey = composerPlanKey(context, assets);
  session.beginPlan(planKey);
  if (!assets.length) {
    session.resolvePlan(planKey, []);
    return;
  }

  try {
    const result = await preflightComposerAttachments(context, assets, signal);
    const linkedUploadIds = new Set(result.linkedUploadIds);
    session.resolvePlan(
      planKey,
      assets.flatMap((asset) =>
        asset.uploadId && linkedUploadIds.has(asset.uploadId)
          ? [asset.id]
          : []
      ),
    );
  } catch (error) {
    if (!signal?.aborted) session.failPlan(planKey);
    throw error;
  }
}

/**
 * Preflight only publishes a revision-tagged delivery plan to the session.
 * ProseMirror subscribes to that plan directly, so React never rewrites nodes.
 */
export function useComposerAttachmentPreflight(
  session: ComposerSession,
  context: PreflightContext,
  assets: readonly ComposerAsset[],
  active = true,
) {
  const requestKey = composerPlanKey(context, assets);
  const debouncedRequestKey = useDebouncedValue(requestKey, 750);
  const request = useRef({ requestKey, context, assets });
  request.current = { requestKey, context, assets };

  useEffect(() => {
    if (!active) return;
    session.beginPlan(requestKey);
    if (!assets.length) session.resolvePlan(requestKey, []);
  }, [active, assets.length, requestKey, session]);

  useEffect(() => {
    const current = request.current;
    if (
      !active
      || current.requestKey !== requestKey
      || requestKey !== debouncedRequestKey
      || !current.assets.length
      || current.assets.some((asset) => !asset.uploadId)
    ) return;

    const controller = new AbortController();
    void resolveComposerAttachmentPlan(
      session,
      current.context,
      current.assets,
      controller.signal,
    ).catch(() => {
      // Background preflight is advisory. Final submission reports failures.
    });
    return () => controller.abort();
  }, [active, debouncedRequestKey, requestKey, session]);
}
