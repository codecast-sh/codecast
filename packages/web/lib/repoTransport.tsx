// Which way a repository page reads its data.
//
// The same pages serve two audiences. Signed in, a reader goes through Convex:
// the ensure action fills the cache, the get query paints from it, and the
// answer is enriched with what codecast knows — the session that wrote a
// commit, the tasks it names, the pull request being shepherded. Signed out on
// a public repository, there is no viewer to check and no enrichment to show,
// so the same data comes over one plain HTTP GET.
//
// The decision belongs to the shell that mounts the pages, never to a page. A
// page asks for a branch list; this decides where the branch list comes from,
// and both transports hand back the same RepoRead shape so nothing downstream
// can tell them apart. With no provider the mode is "convex", which is what the
// signed-in app already was.

import { createContext, useContext, useState, type ReactNode } from "react";
import { getConvexUrl } from "./convexUrl";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useCoarseNow } from "../hooks/useCoarseNow";

export type RepoTransportMode = "convex" | "public";

const TransportContext = createContext<RepoTransportMode>("convex");

export function RepoTransportProvider({
  mode,
  children,
}: {
  mode: RepoTransportMode;
  children: ReactNode;
}) {
  return <TransportContext.Provider value={mode}>{children}</TransportContext.Provider>;
}

export function useRepoTransport(): RepoTransportMode {
  return useContext(TransportContext);
}

// The route is registered on /api/public/repo/ as well, but the proxy in front
// of the deployment only forwards a fixed set of prefixes to HTTP actions and
// /cli/ is the one already open (infra/convex-proxy/Caddyfile).
const PUBLIC_REPO_BASE = "/cli/public/repo/";

/** The URL for one public read, or null when the read is not ready to run. */
export function publicRepoUrl(
  repository: string | undefined,
  kind: string,
  params: Record<string, unknown> | null,
): string | null {
  if (!repository || !params) return null;

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "repository" || value === undefined || value === null || value === "") continue;
    query.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  const suffix = query.toString();
  return `${getConvexUrl()}${PUBLIC_REPO_BASE}${repository}/${kind}${suffix ? `?${suffix}` : ""}`;
}

type PublicResult = { data?: unknown; missing: boolean; error?: Error };

/**
 * One in-flight request per URL, and one answer kept for a minute.
 *
 * Several components ask for the same thing on one page — a directory listing
 * and its last-commit column both want the tree — and without this each mount
 * is its own round trip. The entry holds the promise rather than the value, so
 * simultaneous askers share the request instead of racing it.
 */
const cache = new Map<string, { at: number; request: Promise<PublicResult> }>();

async function fetchPublic(url: string): Promise<PublicResult> {
  const response = await fetch(url, { cache: "no-store", credentials: "omit", headers: { Accept: "application/json" } });
  // The route answers 404 for a private repository, one it has never heard of,
  // and a ref or path that does not exist. None of those is a failure to show
  // as an error: the surface has nothing to render and says so.
  if (response.status === 404) return { missing: true };
  if (!response.ok) {
    return { missing: false, error: new Error(`Repository read failed (${response.status})`) };
  }
  return { data: await response.json(), missing: false };
}

export function readPublic(url: string): Promise<PublicResult> {
  const hit = cache.get(url);
  if (hit) return hit.request;

  const request = fetchPublic(url).catch((error: unknown) => {
    // A failed request must not be remembered as this minute's answer.
    cache.delete(url);
    return { missing: false, error: error instanceof Error ? error : new Error(String(error)) };
  }).finally(() => cache.delete(url));
  cache.set(url, { at: Date.now(), request });
  return request;
}

/** For tests, and for a page that wants its next read to go to the network. */
export function clearPublicRepoCache() {
  cache.clear();
}

export type PublicRead<T> = {
  data: T | undefined;
  missing: boolean;
  ready: boolean;
  error: Error | undefined;
};

/** The public half of a read. `url === null` reads nothing at all. */
export function usePublicRepoRead<T>(url: string | null): PublicRead<T> {
  const cycle = useCoarseNow(60_000);
  const [state, setState] = useState<{ url: string | null; cycle?: number; result?: PublicResult }>({ url: null });

  useWatchEffect(() => {
    if (!url) return;
    let cancelled = false;
    setState({ url, cycle });
    void readPublic(url).then((result) => {
      if (!cancelled) setState({ url, cycle, result });
    });
    return () => {
      cancelled = true;
    };
  }, [url, cycle]);

  // Derived, not stored: a new URL shows nothing on the render that asks for
  // it, rather than the previous URL's answer for one frame.
  const result = state.url === url && state.cycle === cycle ? state.result : undefined;
  return {
    data: result?.data as T | undefined,
    missing: !!result?.missing,
    ready: result !== undefined,
    error: result?.error,
  };
}
