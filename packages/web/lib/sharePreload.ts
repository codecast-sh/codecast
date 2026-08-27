// Server-inlined share payload (packages/web/server/share.ts).
//
// The prod server runs the public share query itself and embeds the result in
// the HTML as window.__SHARE_PRELOAD__ so a share page paints before the Convex
// socket is even open. Pages read it as the initial value and let their own
// live query replace it once that answers. Absent in dev (vite serves the
// plain shell) and whenever the server chose not to inline — both fall back to
// the live query exactly as before.

export type SharePreloadKind = "message" | "doc" | "plan";

interface SharePreload {
  kind: SharePreloadKind;
  token: string;
  data: unknown;
}

/**
 * The inlined payload for this exact page, or `undefined` when there is none.
 * A `null` is a real answer ("no such share") and renders the not-found state
 * without waiting on the network.
 */
export function readSharePreload<T>(kind: SharePreloadKind, token: string): T | null | undefined {
  if (typeof window === "undefined") return undefined;
  const p = (window as { __SHARE_PRELOAD__?: SharePreload }).__SHARE_PRELOAD__;
  if (!p || p.kind !== kind || p.token !== token) return undefined;
  return p.data as T | null;
}
