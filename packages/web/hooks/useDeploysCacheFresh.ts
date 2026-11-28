// Whether what the store holds of a workspace's deploys is current enough to paint before its feeds answer. The cache
// is the workspace's own rows, but they are as old as the last time a Deploys page held that workspace's feeds live:
// a workspace opened hours ago paints its targets' old waiting counts, an old live deploy and runs merged since, for
// the seconds its first answer takes. So the page stamps, per workspace, when this browser last held the feeds live
// (each coarse tick while it does, and as it leaves), and paints a cache only within DEPLOYS_FRESH_MS of that stamp;
// otherwise it reads until the feeds answer. The stamp is cache bookkeeping kept beside no server data, so it lives in
// this browser's localStorage, read and written through try/catch: without storage every cache reads as old.
import { useMemo } from "react";
import { useWatchEffect } from "./useWatchEffect";

/** How long after the feeds were last held live their cache still paints at once. */
export const DEPLOYS_FRESH_MS = 2 * 60_000;

const keyOf = (workspace: string) => `codecast:deploys-live:${workspace}`;
const storage = () => (typeof window === "undefined" ? null : window.localStorage);

export function deploysLiveAt(workspace: string): number | null {
  try {
    const at = Number(storage()?.getItem(keyOf(workspace)));
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch {
    return null;
  }
}

export function stampDeploysLive(workspace: string, at: number): void {
  try {
    storage()?.setItem(keyOf(workspace), String(at));
  } catch {
    // Private mode or blocked storage: the next visit reads until the feeds answer.
  }
}

/** Whether a stamp taken at `liveAt` still vouches for the cache at `now`. */
export const cacheFresh = (liveAt: number | null, now: number) => liveAt != null && now - liveAt >= 0 && now - liveAt < DEPLOYS_FRESH_MS;

/**
 * `live`: this window's feeds for the workspace have answered. While they have, the stamp moves with `now` (a coarse
 * clock) and once more as the page leaves the workspace. Returns whether the cache the page opened on is fresh: judged
 * once per workspace, when the page opens on it, since what the feeds answer afterwards is live anyway.
 */
export function useDeploysCacheFresh(workspace: string | null | undefined, live: boolean, now: number): boolean {
  // Read when the page opens on the workspace, before this visit stamps anything.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- judged once per workspace, at the moment it opens
  const fresh = useMemo(() => !!workspace && cacheFresh(deploysLiveAt(workspace), Date.now()), [workspace]);
  useWatchEffect(() => {
    if (!workspace || !live) return;
    stampDeploysLive(workspace, Date.now());
    const leave = () => stampDeploysLive(workspace, Date.now());
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [workspace, live, now]);
  return fresh;
}
