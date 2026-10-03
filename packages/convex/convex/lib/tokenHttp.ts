// One bearer-token HTTP client for every outside service a token connection
// reaches (Sentry, PostHog, a product's app connector, and the validate call
// that proves a pasted token). Every call:
//   - refuses a host inside our own network (loopback, private, link-local,
//     CGNAT, unique-local, the deployment's own hosts), since Convex runs
//     these fetches from inside codecast's network;
//   - refuses redirects, so a token is never carried to a host nobody named,
//     and cancels the redirect's body;
//   - is aborted after a timeout;
//   - reads the answer capped as it streams;
//   - never puts the token or a redirect target in an error message.
// Vendors map statuses to their own wording in thin wrappers. A leaf module
// with no Convex imports, so the adapters, replays and tokenConnectors can all
// load it without a cycle.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const TOKEN_HTTP_TIMEOUT_MS = 15_000;
/** The cap when a caller names none: no vendor answer this feature reads is near it. */
export const TOKEN_HTTP_MAX_BYTES = 4 * 1024 * 1024;

/**
 * A response body of at most `max` bytes, or null. Refuses on the declared
 * length first, then counts while streaming so a lying or absent header still
 * stops at the cap.
 */
export async function readBodyCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) {
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.length > max ? null : whole;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── Hosts inside our own network ──

function ipv4Parts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function privateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function privateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true;
  // fc00::/7 unique local, fe80::/10 link local.
  if (/^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h)) return true;
  // An IPv4 address mapped into IPv6, dotted or as two hex groups.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) {
    const p = ipv4Parts(dotted[1]);
    return !p || privateIpv4(p);
  }
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    return privateIpv4([hi >> 8, hi & 0xff]);
  }
  return false;
}

/** The deployment's own hosts, from the env Convex sets. */
function ownHosts(): string[] {
  const out = ["convex.codecast.sh"];
  for (const name of ["CONVEX_SITE_URL", "CONVEX_CLOUD_URL", "CONVEX_CLOUD_ORIGIN"]) {
    try {
      const raw = process.env[name];
      if (raw) out.push(new URL(raw).hostname.toLowerCase());
    } catch {
      // Not a URL; nothing to add.
    }
  }
  return out;
}

/**
 * Why a URL's host is refused as one inside our own network, or null when it
 * may be called. The literal host is checked here; Convex actions cannot
 * resolve DNS, so a public name that resolves to a private address is out of
 * reach of this check (the TLS requirement on every call still applies).
 */
export function internalHostRefusal(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a URL";
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return "no host";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return `${host} is a local host`;
  }
  const v4 = ipv4Parts(host);
  if (v4 && privateIpv4(v4)) return `${host} is a private address`;
  if (host.includes(":") && privateIpv6(host)) return `${host} is a private address`;
  // Bare numeric forms (2130706433, 0x7f.1) that URL parsing did not fold into a dotted quad.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) return `${host} is a numeric address`;
  if (ownHosts().some((own) => host === own || host.endsWith(`.${own}`))) return `${host} is codecast's own host`;
  return null;
}

// ── The call ──

export interface TokenHttpRequest {
  url: string;
  method?: string;
  /** Sent as is; a JSON body is the caller's to stringify. */
  body?: string;
  token: string;
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  /** The service's name in messages ("Sentry", "PostHog"). */
  vendor: string;
}

export interface TokenHttpResult {
  /** A 2xx answer read whole within the cap. */
  ok: boolean;
  /** 0 when no answer arrived. */
  status: number;
  text?: string;
  content_type?: string;
  /** Sentry's pagination header. */
  link: string | null;
  bytes: number;
  ms: number;
  /** Set on every failure; a non-2xx answer gets `<vendor> answered <status>` for a wrapper to refine. */
  error?: string;
  /** Why the call failed before a status could mean anything. */
  failure?: "refused_host" | "unreachable" | "timeout" | "redirect" | "over" | "broken";
}

/** One authenticated call under the rules at the top of this file. */
export async function tokenHttp(fetchImpl: FetchLike, req: TokenHttpRequest): Promise<TokenHttpResult> {
  const started = Date.now();
  const ms = () => Date.now() - started;
  const timeoutMs = req.timeoutMs ?? TOKEN_HTTP_TIMEOUT_MS;
  const maxBytes = req.maxBytes ?? TOKEN_HTTP_MAX_BYTES;
  const fail = (failure: TokenHttpResult["failure"], error: string, status = 0, bytes = 0): TokenHttpResult => ({ ok: false, status, link: null, bytes, ms: ms(), error, failure });

  const refused = internalHostRefusal(req.url);
  if (refused) return fail("refused_host", `${req.vendor} is not called inside codecast's network (${refused})`);
  const origin = new URL(req.url).origin;
  let res: Response;
  try {
    res = await fetchImpl(req.url, {
      method: req.method ?? "GET",
      headers: {
        Authorization: `Bearer ${req.token}`,
        Accept: "application/json",
        ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...req.headers,
      },
      ...(req.body !== undefined ? { body: req.body } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return timedOut
      ? fail("timeout", `${req.vendor} gave no answer in ${timeoutMs / 1000}s`)
      : fail("unreachable", `Could not reach ${req.vendor} at ${origin}: ${e?.message ?? "network error"}`);
  }
  if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
    await res.body?.cancel().catch(() => {});
    return fail("redirect", `${req.vendor} redirected (${res.status}); redirects are not followed, so connect with the final URL`, res.status);
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await readBodyCapped(res, maxBytes);
  } catch (e: any) {
    return fail("broken", `${req.vendor}'s answer broke off: ${e?.message ?? "read error"}`, res.status);
  }
  if (!bytes) return fail("over", `${req.vendor}'s answer is over ${maxBytes} bytes`, res.status, maxBytes);
  return {
    ok: res.ok,
    status: res.status,
    text: new TextDecoder().decode(bytes),
    content_type: res.headers.get("content-type") ?? undefined,
    link: res.headers.get("link"),
    bytes: bytes.length,
    ms: ms(),
    ...(res.ok ? {} : { error: `${req.vendor} answered ${res.status}` }),
  };
}

/** A result's text as JSON, or undefined when it is not. */
export function jsonOf(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
