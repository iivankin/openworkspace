import { hc } from "hono/client";
import type { AppType } from "@worker/index";

export const api = hc<AppType>(window.location.origin);
export const AUTH_UNAUTHORIZED_EVENT = "openworkspace:auth-unauthorized";

type ResponseLike = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type SuccessfulResponse<R extends ResponseLike> = Extract<
  Awaited<ReturnType<R["json"]>>,
  { ok: true }
>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function responseJson<R extends ResponseLike>(
  response: R,
): Promise<SuccessfulResponse<R>> {
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
    }
    const failure = body as { error?: { message?: string } };
    throw new ApiError(
      failure.error?.message ?? `Request failed (${response.status})`,
      response.status,
    );
  }
  return body as SuccessfulResponse<R>;
}
