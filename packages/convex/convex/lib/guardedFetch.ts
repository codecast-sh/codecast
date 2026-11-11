// A fetch from our servers to a URL someone else chose (a mod's API call, a
// deploy target's live reader). Convex runs these from inside codecast's
// network, beside services and the cloud metadata endpoint, so before any
// request leaves:
//   - the URL's literal host must be public (shared/contracts/internalHost);
//   - a host name must resolve, and every address it resolves to must be
//     public, so a public name pointing at 10.x is refused. Convex actions
//     cannot resolve DNS themselves, so names are resolved over DNS-over-HTTPS;
//   - every redirect hop passes the same checks before it is requested.
// The resolve-then-fetch pair leaves a window for DNS rebinding (a name that
// answers our resolver and the backend's differently); egress rules on the
// host are the layer that closes it.
// A leaf module with no Convex imports.
import { internalAddressRefusal, internalHostRefusal as literalHostRefusal, isIpLiteral } from "@codecast/shared/contracts/internalHost";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
/** A host name's addresses, [] when it has none, or null when no resolver answered. */
export type Resolver = (host: string) => Promise<string[] | null>;

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

/** Why a URL's literal host is refused as one inside our own network, or null when it may be called. */
export function internalHostRefusal(raw: string): string | null {
  return literalHostRefusal(raw, ownHosts());
}

const DOH_RESOLVERS = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];
const DOH_TIMEOUT_MS = 5_000;
const CACHE_MAX = 500;
const cache = new Map<string, { addrs: string[]; until: number }>();

async function dohQuery(fetchImpl: FetchLike, base: string, host: string, type: "A" | "AAAA"): Promise<{ addrs: string[]; ttl: number } | null> {
  try {
    const res = await fetchImpl(`${base}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { Accept: "application/dns-json" },
      redirect: "manual",
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { Status?: number; Answer?: { type: number; data: string; TTL?: number }[] };
    // NOERROR and NXDOMAIN are answers; anything else (SERVFAIL, REFUSED) is a resolver that did not answer.
    if (body.Status !== 0 && body.Status !== 3) return null;
    const want = type === "A" ? 1 : 28;
    const records = (body.Answer ?? []).filter((r) => r.type === want);
    return { addrs: records.map((r) => String(r.data)), ttl: Math.min(...records.map((r) => r.TTL ?? 60), 300) };
  } catch {
    return null;
  }
}

/** Resolve A and AAAA over DNS-over-HTTPS, falling back to a second resolver. */
export function dohResolver(fetchImpl: FetchLike = fetch): Resolver {
  return async (host) => {
    const hit = cache.get(host);
    if (hit && hit.until > Date.now()) return hit.addrs;
    for (const base of DOH_RESOLVERS) {
      const [a, aaaa] = await Promise.all([dohQuery(fetchImpl, base, host, "A"), dohQuery(fetchImpl, base, host, "AAAA")]);
      if (!a || !aaaa) continue;
      const addrs = [...a.addrs, ...aaaa.addrs];
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(host, { addrs, until: Date.now() + Math.max(Math.min(a.ttl, aaaa.ttl), 0) * 1000 });
      return addrs;
    }
    return null;
  };
}

/** Why a URL may not be fetched from our servers, its literal host and its resolved addresses both checked, or null when it may. */
export async function fetchTargetRefusal(raw: string, resolve: Resolver): Promise<string | null> {
  const literal = internalHostRefusal(raw);
  if (literal) return literal;
  const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIpLiteral(host)) return null;
  const addrs = await resolve(host);
  if (addrs === null) return `${host} could not be resolved`;
  if (!addrs.length) return `${host} does not resolve`;
  for (const addr of addrs) {
    const refused = internalAddressRefusal(addr);
    if (refused) return `${host} resolves to ${refused}`;
  }
  return null;
}

/** A URL refused as one inside our own network. Its message names the host and why, never anything the server read. */
export class RefusedHostError extends Error {
  constructor(reason: string) {
    super(`not reachable from codecast's servers: ${reason}`);
    this.name = "RefusedHostError";
  }
}

export interface GuardedFetchOptions {
  /** Redirects to follow, each hop checked before it is requested. 0 (the default) hands a redirect back as it is. */
  maxRedirects?: number;
  /** The fetch to use; tests pass a fake. */
  fetch?: FetchLike;
  /** Tests pass a fake; the default resolves over DNS-over-HTTPS through `fetch`. */
  resolve?: Resolver;
}

/**
 * fetch() for a URL someone else chose. Throws RefusedHostError when the URL,
 * a name's resolved address, or any redirect hop is inside our network.
 */
export async function guardedFetch(raw: string, init: RequestInit = {}, opts: GuardedFetchOptions = {}): Promise<Response> {
  const doFetch = opts.fetch ?? fetch;
  const resolve = opts.resolve ?? dohResolver(doFetch);
  let url = raw;
  let current: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop++) {
    const refused = await fetchTargetRefusal(url, resolve);
    if (refused) throw new RefusedHostError(refused);
    const res = await doFetch(url, current);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location || hop >= (opts.maxRedirects ?? 0)) return res;
    await res.body?.cancel().catch(() => {});
    url = new URL(location, url).href;
    // 303, and 301/302 after a POST, continue as a GET without the body, the way browsers do.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && (current.method ?? "GET").toUpperCase() === "POST")) {
      const { body: _body, ...rest } = current;
      current = { ...rest, method: "GET" };
    }
  }
}
