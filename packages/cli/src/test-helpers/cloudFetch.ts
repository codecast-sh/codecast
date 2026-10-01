/**
 * The fetch the cloud agent adapter tests run their API against: canned
 * responses by "METHOD path", every call recorded in order.
 */

export interface FakeCloudCall {
  method: string;
  /** The path, after `stripPrefix`. */
  path: string;
  search: string;
  body?: any;
  headers: Record<string, string>;
}

export interface FakeCloudFetchOptions {
  /** Where every call is recorded. */
  calls?: FakeCloudCall[];
  /** Taken off the front of each path before it is routed (an API's base path). */
  stripPrefix?: string;
  /** The answer to a call no route serves (default a 404 in the `{error: {code, message}}` shape). */
  missing?: (call: FakeCloudCall) => Response;
}

export function fakeCloudFetch(routes: Record<string, (call: FakeCloudCall) => Response>, opts: FakeCloudFetchOptions = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const p = opts.stripPrefix && url.pathname.startsWith(opts.stripPrefix) ? url.pathname.slice(opts.stripPrefix.length) : url.pathname;
    const call: FakeCloudCall = { method: init?.method ?? "GET", path: p, search: url.search, headers: (init?.headers ?? {}) as Record<string, string>, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
    opts.calls?.push(call);
    const hit = routes[`${call.method} ${p}`];
    if (hit) return hit(call);
    return opts.missing?.(call) ?? new Response(JSON.stringify({ error: { type: "not_found_error", code: "not_found", message: `No route ${call.method} ${p}` } }), { status: 404 });
  }) as typeof fetch;
}

/** A route answering with JSON. */
export const json = (v: unknown, status = 200) => () => new Response(JSON.stringify(v), { status });

/** A route answering with Server-Sent Events. */
export const sseBody = (body: string) => () => new Response(body, { headers: { "content-type": "text/event-stream" } });
