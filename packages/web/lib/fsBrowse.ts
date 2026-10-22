// The web's window onto the local disk: the project picker's folders and the
// composer's @ file completion.
//
// The daemon's loopback hook server exposes the /fs routes
// (packages/cli/src/fs/browseHttp.ts). We reach it through the same discovery
// the integrated terminal uses — getTerminalEndpoint — so it answers exactly
// when the viewer is on the machine whose daemon will run the session. Every
// failure (other machine, daemon down, old daemon without the route) collapses
// to "no answer", and the surfaces fall back to what they know without it.

import { useWatchEffect } from "../hooks/useWatchEffect";
import { useMemo, useState } from "react";
import type { ConvexReactClient } from "convex/react";
import { getTerminalEndpoint, isOverrideEndpoint, termHttpBase, type TerminalEndpoint } from "./terminal/endpoint";
import { splitDirQuery, type DiskListing } from "./utils";

const REQUEST_TIMEOUT_MS = 2_500;
// Keystrokes inside one directory share a listing; a directory that changed
// underneath the picker is picked up on the next open.
const LISTING_TTL_MS = 20_000;
// A miss on discovery must not turn every keystroke into a fresh 10s hunt.
const ENDPOINT_MISS_TTL_MS = 30_000;
const DEBOUNCE_MS = 90;

const listings = new Map<string, { at: number; listing: DiskListing }>();
let endpointMissAt = 0;

// The request itself is the probe: a cached endpoint is used as is, and only a
// failed request pays for discovery. Revalidating first cost a /term/sessions
// round trip per listing (a second or more on a busy daemon), long enough that
// the picker settled on its fallback row before the folders arrived.
async function endpointFor(convex: ConvexReactClient, deviceId: string | null | undefined, force: boolean): Promise<TerminalEndpoint | null> {
  if (Date.now() - endpointMissAt < ENDPOINT_MISS_TTL_MS) return null;
  const ep = await getTerminalEndpoint(convex, force ? { force: true } : { trustCache: true }).catch(() => null);
  if (!ep) {
    endpointMissAt = Date.now();
    return null;
  }
  // The picker may be routing the session at another machine; that machine's
  // disk is not this one's.
  if (deviceId && ep.deviceId !== deviceId && !isOverrideEndpoint(ep)) return null;
  return ep;
}

/** One request to this machine's daemon, re-discovering the endpoint once when
 *  the cached one no longer answers. Null when the daemon can't be asked. */
async function daemonFetch(
  convex: ConvexReactClient,
  pathAndQuery: string,
  opts: { deviceId?: string | null; timeoutMs?: number; init?: RequestInit } = {},
): Promise<Response | null> {
  for (const force of [false, true]) {
    const ep = await endpointFor(convex, opts.deviceId, force);
    if (!ep) return null;
    try {
      const res = await fetch(`${termHttpBase(ep)}${pathAndQuery}`, {
        ...opts.init,
        headers: { Authorization: `Bearer ${ep.token}`, ...(opts.init?.headers ?? {}) },
        signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      // A refused token or a port another process now holds means the cached
      // endpoint is stale; anything else is the route's own answer.
      if (res.status !== 401 && res.status !== 403) return res;
    } catch (err) {
      if ((err as Error)?.name === "TimeoutError") return null;
    }
  }
  return null;
}

async function daemonJson<T>(convex: ConvexReactClient, pathAndQuery: string, opts?: Parameters<typeof daemonFetch>[2]): Promise<T | null> {
  const res = await daemonFetch(convex, pathAndQuery, opts);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

function cacheKey(dir: string, hidden: boolean): string {
  return `${hidden ? "." : ""}${dir}`;
}

/** A still-fresh cached listing, synchronously — what lets a directory the
 *  picker has already seen render on the same keystroke. */
function peekDirListing(dir: string, hidden: boolean): DiskListing | null {
  const hit = listings.get(cacheKey(dir, hidden));
  return hit && Date.now() - hit.at < LISTING_TTL_MS ? hit.listing : null;
}

/** Directories inside `dir` on this machine, or null when it can't be asked. */
export async function fetchDirListing(
  convex: ConvexReactClient,
  dir: string,
  hidden: boolean,
  deviceId?: string | null,
): Promise<DiskListing | null> {
  const cached = peekDirListing(dir, hidden);
  if (cached) return cached;
  const listing = await daemonJson<DiskListing>(convex, `/fs/dirs?path=${encodeURIComponent(dir)}${hidden ? "&hidden=1" : ""}`, { deviceId });
  if (listing) listings.set(cacheKey(dir, hidden), { at: Date.now(), listing });
  return listing;
}

/** One folder's sessions on this machine (packages/cli/src/fs/localSessions.ts). */
export type LocalFolder = {
  path: string;
  repository?: string;
  sessions: number;
  claude: number;
  codex: number;
  synced: number;
  first: number;
  last: number;
  /** Each session's last activity, newest first. */
  times: number[];
  git: boolean;
  exists: boolean;
};

/**
 * Sessions per folder on the machine the browser runs on, synced or not.
 * Null when that machine's daemon can't be asked (another machine, daemon
 * down, an older daemon without the route). Stays on the loopback: the list of
 * folders that did not sync never reaches the server.
 */
export async function fetchLocalSessions(convex: ConvexReactClient): Promise<LocalFolder[] | null> {
  const body = await daemonJson<{ folders: LocalFolder[] }>(convex, "/fs/sessions", { timeoutMs: 30_000 });
  return body?.folders ?? null;
}

/**
 * Which of `paths` are directories on the machine the browser runs on, with
 * that machine's home. Null when its daemon can't be asked.
 */
export async function fetchPathsExist(convex: ConvexReactClient, paths: string[]): Promise<{ home: string; exists: Record<string, boolean> } | null> {
  if (paths.length === 0) return null;
  const q = paths.slice(0, 300).map((p) => `p=${encodeURIComponent(p)}`).join("&");
  return daemonJson(convex, `/fs/exists?${q}`, { timeoutMs: REQUEST_TIMEOUT_MS * 2 });
}

/** Create a project folder (the daemon also `git init`s it). Resolves to the
 *  absolute path; throws when the daemon can't be reached or refuses. */
export async function createProjectFolder(
  convex: ConvexReactClient,
  path: string,
  deviceId?: string | null,
): Promise<string> {
  const res = await daemonFetch(convex, "/fs/mkdir", {
    deviceId,
    timeoutMs: 10_000,
    init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) },
  });
  if (!res) throw new Error("This machine's daemon isn't reachable, so the folder can't be created here");
  if (!res.ok) throw new Error(`Couldn't create ${path}`);
  const made = (await res.json()) as { path: string };
  // The parent's cached listing no longer knows about the new folder.
  for (const key of [...listings.keys()]) {
    if (made.path.startsWith(key.replace(/^\./, "") + "/")) listings.delete(key);
  }
  return made.path;
}

/**
 * The disk listing behind a picker query: the folders inside the directory the
 * query browses (see splitDirQuery), debounced per keystroke. Also hands back
 * the daemon's real home once known, which callers should prefer over the
 * inferred one so "~" resolves where the session will actually cd.
 */
export function useDirListing(
  convex: ConvexReactClient,
  query: string,
  home: string | undefined,
  base: string | undefined,
  opts: { enabled: boolean; deviceId?: string | null },
): { listing: DiskListing | null; home: string | undefined } {
  const split = useMemo(() => (opts.enabled ? splitDirQuery(query, home, base) : undefined), [opts.enabled, query, home, base]);
  const dir = split?.dir;
  const hidden = split?.hidden ?? false;
  const [state, setState] = useState<{ listing: DiskListing | null; home: string | undefined; failed?: string }>({
    listing: null,
    home: undefined,
  });
  // A directory whose listing failed (daemon busy, endpoint stale) is asked
  // again on the next keystroke; one that answered is not asked again while
  // the text stays inside it.
  const retry = state.failed === dir ? query : "";

  useWatchEffect(() => {
    if (!dir) {
      setState((s) => (s.listing ? { ...s, listing: null } : s));
      return;
    }
    // Already known → paint now; the debounce only guards the network.
    const cached = peekDirListing(dir, hidden);
    if (cached) {
      setState((s) => (s.listing === cached ? s : { listing: cached, home: cached.home }));
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void fetchDirListing(convex, dir, hidden, opts.deviceId).then((listing) => {
        if (!live) return;
        setState((s) => ({ listing, home: listing?.home ?? s.home, failed: listing ? undefined : dir }));
      });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [convex, dir, hidden, opts.deviceId, retry]);

  return state;
}

export type FileMatches = { root: string; query: string; files: string[] };

const FILES_TTL_MS = 15_000;
const fileMatches = new Map<string, { at: number; matches: FileMatches }>();

/**
 * Files in the project at `root` (on this machine) that match `query`, best
 * first, as paths relative to `root`: the composer's @ file completion. Null
 * until the daemon answers, and whenever it can't be asked. A previous
 * answer stays up while the next one is in flight, so the list narrows
 * instead of flickering.
 */
export function useFileSearch(
  convex: ConvexReactClient,
  root: string | null | undefined,
  query: string | null,
): FileMatches | null {
  const [matches, setMatches] = useState<FileMatches | null>(null);
  const enabled = !!root && query !== null;

  useWatchEffect(() => {
    if (!enabled) {
      setMatches(null);
      return;
    }
    const key = `${root}\0${query}`;
    const hit = fileMatches.get(key);
    if (hit && Date.now() - hit.at < FILES_TTL_MS) {
      setMatches(hit.matches);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void daemonJson<{ exists: boolean; files: string[] }>(
        convex,
        `/fs/files?root=${encodeURIComponent(root!)}&q=${encodeURIComponent(query!)}`,
      ).then((body) => {
        if (!body || !live) return;
        const next = { root: root!, query: query!, files: body.files };
        if (fileMatches.size > 200) fileMatches.clear();
        fileMatches.set(key, { at: Date.now(), matches: next });
        setMatches(next);
      });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [convex, enabled, root, query]);

  return enabled && matches?.root === root ? matches : null;
}
