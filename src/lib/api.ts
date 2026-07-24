import { hc } from "hono/client";
import type { AppType } from "@worker/index";

export const api = hc<AppType>(window.location.origin);

type ResponseLike = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type SuccessfulResponse<R extends ResponseLike> = Extract<
  Awaited<ReturnType<R["json"]>>,
  { ok: true }
>;

export async function responseJson<R extends ResponseLike>(
  response: R,
): Promise<SuccessfulResponse<R>> {
  const body = await response.json();
  if (!response.ok) {
    const failure = body as { error?: { message?: string } };
    throw new Error(
      failure.error?.message ?? `Request failed (${response.status})`,
    );
  }
  return body as SuccessfulResponse<R>;
}
