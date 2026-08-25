import { accountApi } from "../account-api";
import type { Context } from "hono";
import type { AppEnv } from "../env";

type HonoExecutionContext = Context<AppEnv>["executionCtx"];

// Hono intentionally exposes the runtime-compatible subset of Cloudflare's
// ExecutionContext. Wrangler's generated type also requires tracing helpers,
// even though Hono neither consumes nor forwards them through sub-app fetches.
const fetchAccountApi = accountApi.fetch as (
  request: Request,
  env: Env,
  executionCtx: HonoExecutionContext,
) => Response | Promise<Response>;

export class AccountApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AccountApiError";
  }
}

type AccountApiResponse = Record<string, unknown> & {
  error?: { code?: string; message?: string };
};

export type AccountApiBinary = {
  bytes: Uint8Array;
  contentType: string;
  filename: string | null;
  offsetBytes: number;
  totalBytes: number;
};

function filenameFromDisposition(value: string | null) {
  const encoded = value?.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function binaryRange(response: Response, returnedBytes: number) {
  const contentRange = response.headers.get("content-range")?.match(
    /^bytes (\d+)-(\d+)\/(\d+)$/u,
  );
  return contentRange
    ? {
        offsetBytes: Number(contentRange[1]),
        totalBytes: Number(contentRange[3]),
      }
    : {
        offsetBytes: 0,
        totalBytes: Number(response.headers.get("content-length"))
          || returnedBytes,
      };
}

export class AccountApiClient {
  constructor(
    private readonly env: Env,
    private readonly executionCtx: HonoExecutionContext,
    private readonly token: string,
    private readonly publicOrigin: string,
  ) {}

  async json(
    path: string,
    init: {
      method?: string;
      json?: unknown;
      body?: BodyInit;
      headers?: HeadersInit;
    } = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.request(path, init);
    const payload = await response.text();
    let body: AccountApiResponse | null = null;
    try {
      body = JSON.parse(payload) as AccountApiResponse;
    } catch {
      if (response.ok) throw new Error("Account API returned an invalid response");
    }
    if (!response.ok) {
      throw new AccountApiError(
        body?.error?.message ?? (payload || `Request failed (${response.status})`),
        response.status,
        body?.error?.code,
      );
    }
    if (!body) throw new Error("Account API returned an empty response");
    return body;
  }

  async binary(
    path: string,
    input: { offsetBytes: number; maxBytes: number },
  ): Promise<AccountApiBinary> {
    const response = await this.request(path, {
      headers: {
        range: `bytes=${input.offsetBytes}-${input.offsetBytes + input.maxBytes - 1}`,
      },
    });
    if (!response.ok) {
      const payload = await response.text();
      let body: AccountApiResponse | null = null;
      try {
        body = JSON.parse(payload) as AccountApiResponse;
      } catch {
        // Binary endpoints may return a plain-text platform error.
      }
      throw new AccountApiError(
        body?.error?.message ?? (payload || `Request failed (${response.status})`),
        response.status,
        body?.error?.code,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      contentType: response.headers.get("content-type")
        ?? "application/octet-stream",
      filename: filenameFromDisposition(
        response.headers.get("content-disposition"),
      ),
      ...binaryRange(response, bytes.byteLength),
    };
  }

  private request(
    path: string,
    init: {
      method?: string;
      json?: unknown;
      body?: BodyInit;
      headers?: HeadersInit;
    } = {},
  ) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    return fetchAccountApi(
      new Request(new URL(path, this.publicOrigin), {
        method: init.method ?? "GET",
        headers,
        body,
      }),
      this.env,
      this.executionCtx,
    );
  }
}

export function apiPath(
  pathname: string,
  query: Record<string, string | number | boolean | null | undefined> = {},
) {
  const url = new URL(pathname, "https://account-api.internal");
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}
