// One HTTP request from codecast to a connected product (sources/app.ts):
// signed for its source, bearer secret attached when the connection holds one,
// redirects refused, time and size capped, failures named in the product's words.
import type { Doc } from "../_generated/dataModel";
import type { FetchLike } from "../tokenConnectors";
import { tokenHttp } from "./tokenHttp";
import { signatureHeaders } from "./codecastSigning";
import { APP_LIMITS } from "@codecast/shared/contracts/appConnector";

export interface AppHttpResult {
  ok: boolean;
  status?: number;
  text?: string;
  content_type?: string;
  bytes: number;
  ms: number;
  error?: string;
}

/** Which source a request is for: its signature names both, and the app checks them against its codecast.json. */
export interface AppSigner {
  source: string;
  workspace: string;
}

/** The signer of a source row. */
export const signerOf = (source: Pick<Doc<"event_sources">, "short_id" | "workspace">): AppSigner => ({ source: source.short_id, workspace: source.workspace });

/**
 * One request to the product, signed by codecast for `sign`'s source, with
 * the bearer secret too when the connection holds one. Redirects are not
 * followed (nothing goes to a host the connection does not name), the call is
 * aborted after 15 s, and a body over 256 KB is refused while it streams.
 * Error text never contains the secret. With no secret, a request codecast
 * cannot sign is not sent.
 */
export async function appHttp(
  fetchImpl: FetchLike,
  req: { url: string; method: string; body?: string },
  headers: { token?: string; actor: string; idempotency_key?: string; sign?: AppSigner },
): Promise<AppHttpResult> {
  const signed = headers.sign ? await signatureHeaders({ method: req.method, url: req.url, body: req.body, ...headers.sign }) : null;
  if (!headers.token && !signed?.ok) {
    return { ok: false, bytes: 0, ms: 0, error: signed && !signed.ok ? signed.error : "the connection has no secret and the request is unsigned" };
  }
  const res = await tokenHttp(fetchImpl, {
    url: req.url,
    method: req.method,
    ...(req.body !== undefined ? { body: req.body } : {}),
    ...(headers.token ? { token: headers.token } : {}),
    headers: {
      ...(signed?.ok ? signed.headers : {}),
      "X-Codecast-Actor": headers.actor,
      ...(headers.idempotency_key ? { "Idempotency-Key": headers.idempotency_key } : {}),
    },
    maxBytes: APP_LIMITS.response_bytes,
    timeoutMs: APP_LIMITS.timeout_ms,
    vendor: "the app",
  });
  // The product's own wording for each failure: these land in app_calls and on watch state.
  const error = (() => {
    switch (res.failure) {
      case "timeout":
        return `no answer in ${APP_LIMITS.timeout_ms / 1000}s`;
      case "redirect":
        return `redirected (${res.status}); the connector does not follow redirects`;
      case "over":
        return `the response is over ${APP_LIMITS.response_bytes / 1024} KB`;
      case undefined:
        return res.ok ? undefined : `answered ${res.status}`;
      default:
        return res.error;
    }
  })();
  return {
    ok: res.ok,
    ...(res.status ? { status: res.status } : {}),
    ...(res.text !== undefined ? { text: res.text } : {}),
    ...(res.content_type ? { content_type: res.content_type } : {}),
    bytes: res.bytes,
    ms: res.ms,
    ...(error ? { error } : {}),
  };
}
