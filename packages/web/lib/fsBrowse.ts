// The project picker's window onto the local disk.
//
// The daemon's loopback hook server exposes GET /fs/dirs and POST /fs/mkdir
// (packages/cli/src/fs/browseHttp.ts). We reach it through the same discovery
// the integrated terminal uses — getTerminalEndpoint — so it answers exactly
// when the viewer is on the machine whose daemon will run the session. Every
// failure (other machine, daemon down, old daemon without the route) collapses
// to "no listing", and the picker falls back to recents alone.

import { useEffect, useMemo, useState } from "react";
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

async function endpointFor(convex: ConvexReactClient, deviceId?: string | null): Promise<TerminalEndpoint | null> {
  if (Date.now() - endpointMissAt < ENDPOINT_MISS_TTL_MS) return null;
  const ep = await getTerminalEndpoint(convex).catch(() => null);
  if (!ep) {
    endpointMissAt = Date.now();
    return null;
  }
  // The picker may be routing the session at another machine; that machine's
  // disk is not this one's.
  if (deviceId && ep.deviceId !== deviceId && !isOverrideEndpoint(ep)) return null;
  return ep;
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
  const key = cacheKey(dir, hidden);
  const cached = peekDirListing(dir, hidden);
  if (cached) return cached;
  const ep = await endpointFor(convex, deviceId);
  if (!ep) return null;
  try {
    const res = await fetch(
      `${termHttpBase(ep)}/fs/dirs?path=${encodeURIComponent(dir)}${hidden ? "&hidden=1" : ""}`,
      { headers: { Authorization: `Bearer ${ep.token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const listing = (await res.json()) as DiskListing;
    listings.set(key, { at: Date.now(), listing });
    return listing;
  } catch {
    return null;
  }
}

/** Create a project folder (the daemon also `git init`s it). Resolves to the
 *  absolute path; throws when the daemon can't be reached or refuses. */
export async function createProjectFolder(
  convex: ConvexReactClient,
  path: string,
  deviceId?: string | null,
): Promise<string> {
  const ep = await endpointFor(convex, deviceId);
  if (!ep) throw new Error("This machine's daemon isn't reachable, so the folder can't be created here");
  const res = await fetch(`${termHttpBase(ep)}/fs/mkdir`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ep.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(10_000),
  });
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
  const [state, setState] = useState<{ listing: DiskListing | null; home: string | undefined }>({
    listing: null,
    home: undefined,
  });

  useEffect(() => {
    if (!dir) {
      setState((s) => (s.listing ? { ...s, listing: null } : s));
      return;
    }
    // Already known → paint now; the debounce only guards the network.
    const cached = peekDirListing(dir, hidden);
    if (cached) {
      setState({ listing: cached, home: cached.home });
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void fetchDirListing(convex, dir, hidden, opts.deviceId).then((listing) => {
        if (!live) return;
        setState((s) => ({ listing, home: listing?.home ?? s.home }));
      });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [convex, dir, hidden, opts.deviceId]);

  return state;
}
