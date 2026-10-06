// Follow mode, the pure parts: what a leader's view means for a follower's
// window, where in a transcript a leader is, and when a follow ends.
//
// A follow is a lease the follower holds on the leader (convex/follow.ts);
// the leader reports their place only while someone holds one. The follower
// applies each report as the person themselves would have moved: a route
// push, the app's one session path, a scroll to a message. Any move the
// follower makes on their own ends the follow, as in Figma.

import { clampFollowView, type FollowView } from "@codecast/shared/contracts/follow";
export type { FollowView };

export type FollowerRow = { user_id: string; name: string; image?: string };

/** Where this window is in a transcript: the top visible message and how much
 *  of it has scrolled past (0 at its top edge, 1 at its bottom). */
export type ViewAnchor = { conversationId: string; messageId: string; offset: number };

export type LeaderView = {
  path: string;
  conversation_id?: string;
  anchor?: { message_id: string; offset: number };
  view?: FollowView;
  updated_at: number;
  withheld: boolean;
  /** The leader stopped sharing with this follower. */
  ended?: boolean;
};

/** What a follower's window does with a report: where to go, then which
 *  in-page parts (panel, diff, scroll) to apply once it is there. */
export type FollowPlan =
  | { kind: "blocked" }
  | { kind: "stay"; view: FollowView | null }
  | { kind: "route"; path: string; view: FollowView | null }
  | { kind: "session"; conversationId: string; scrollTo: string | null; view: FollowView | null };

// ── in-page state: scroll regions and surfaces ──

/**
 * Every region a follow can scroll, by the key both sides send. A scroll
 * region names one scroller on one kind of page; a page with several
 * scrollers registers the one a person reads. Adding a region is one line
 * here plus `useFollowScroll(key, ref)` on its scroller.
 */
export const FOLLOW_SCROLL_REGIONS = {
  doc: "a doc's body (DocumentDetailLayout)",
  task: "a task page's body",
  review: "a review's file list and diff (ReviewView)",
  pr: "a pull request page (app/pr)",
  commit: "a commit page (app/commit)",
  "diff-pane": "a conversation's diff pane, one file or all of them (FileDiffLayout)",
} as const;
export type FollowScrollKey = keyof typeof FOLLOW_SCROLL_REGIONS;

export function isFollowScrollKey(key: string): key is FollowScrollKey {
  return Object.prototype.hasOwnProperty.call(FOLLOW_SCROLL_REGIONS, key);
}

export type FollowViewPart = keyof FollowView;
const PARTS: readonly FollowViewPart[] = ["panel", "diff", "scroll"];

/**
 * A surface that holds part of a person's place inside a page. `read` says
 * what it holds now (the leader side); `apply` takes the parts it owns from a
 * leader's view and moves this window there the way the person would, and
 * returns the parts it took (the follower side). Surfaces register while
 * mounted (hooks/useFollowSurface), so the follow hook never names them.
 */
export type FollowSurface = {
  read?: () => FollowView | null | undefined;
  apply?: (view: FollowView) => readonly FollowViewPart[];
};

const surfaces = new Set<FollowSurface>();
const surfaceListeners = new Set<() => void>();

function emitSurfaces(): void {
  for (const l of surfaceListeners) l();
}

export function registerFollowSurface(surface: FollowSurface): () => void {
  surfaces.add(surface);
  emitSurfaces();
  return () => {
    surfaces.delete(surface);
    emitSurfaces();
  };
}

/** A surface's state changed (a file picked, a panel opened, a scroll). */
export const notifyFollowView = emitSurfaces;

export function subscribeFollowSurfaces(fn: () => void): () => void {
  surfaceListeners.add(fn);
  return () => {
    surfaceListeners.delete(fn);
  };
}

/** The leader's in-page view, composed from every mounted surface. */
export function readLeaderView(): FollowView | undefined {
  return composeLeaderView([...surfaces].map((s) => s.read?.()));
}

/**
 * Hand a view's parts to the mounted surfaces, first taker wins per part.
 * Returns what no surface took yet (its page is still mounting), or null.
 */
export function applyFollowView(view: FollowView): FollowView | null {
  let left: FollowView = { ...view };
  for (const s of surfaces) {
    if (!s.apply || !hasParts(left)) break;
    for (const part of s.apply(left)) delete left[part];
  }
  return hasParts(left) ? left : null;
}

function hasParts(view: FollowView | null | undefined): view is FollowView {
  return !!view && PARTS.some((p) => view[p] !== undefined);
}

/**
 * One view from the surfaces' parts: the first surface to name a part holds
 * it, and a scroll in a region nobody registered is dropped, so a stray key
 * never reaches a follower. Clamped as the server stores it.
 */
export function composeLeaderView(parts: readonly (FollowView | null | undefined)[]): FollowView | undefined {
  const out: FollowView = {};
  for (const p of parts) {
    if (!p) continue;
    if (out.panel === undefined && p.panel) out.panel = p.panel;
    // A diff's file and line come from the surface showing it; its base may
    // come from another (the conversation's change position).
    if (p.diff?.file && !out.diff?.file) out.diff = { ...p.diff, base: p.diff.base ?? out.diff?.base };
    else if (p.diff?.base && !out.diff?.base) out.diff = { ...(out.diff ?? { file: "" }), base: p.diff.base };
    if (out.scroll === undefined && p.scroll && isFollowScrollKey(p.scroll.key)) out.scroll = p.scroll;
  }
  if (out.diff && !out.diff.file) delete out.diff;
  return clampFollowView(out);
}

/** A view as a string that changes exactly when a follower would move. */
export function followViewSig(view: FollowView | null | undefined): string {
  if (!view) return "";
  const d = view.diff;
  const sc = view.scroll;
  return `${view.panel ?? ""}|${d ? `${d.file}:${d.line ?? ""}@${d.base ?? ""}` : ""}|${sc ? `${sc.key}:${sc.offset.toFixed(3)}` : ""}`;
}

/**
 * The parts of `next` a follower still has to apply, given what it applied
 * last: a part that changed, or one it has not applied at all. A scroll that
 * moved less than half a percent is the same place.
 */
export function planViewApply(next: FollowView | null | undefined, applied: FollowView | null | undefined): FollowView | null {
  if (!next) return null;
  const out: FollowView = {};
  if (next.panel && next.panel !== applied?.panel) out.panel = next.panel;
  const d = next.diff;
  const a = applied?.diff;
  if (d && (!a || d.file !== a.file || d.line !== a.line || d.base !== a.base)) out.diff = d;
  const sc = next.scroll;
  const as = applied?.scroll;
  if (sc && (!as || sc.key !== as.key || Math.abs(sc.offset - as.offset) >= 0.005)) out.scroll = sc;
  return hasParts(out) ? out : null;
}


export function followersSig(rows: readonly FollowerRow[] | null | undefined): string {
  return (rows ?? []).map((r) => r.user_id).join(",");
}

export function sameViewAnchor(a: ViewAnchor | null, b: ViewAnchor | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.conversationId === b.conversationId && a.messageId === b.messageId && Math.abs(a.offset - b.offset) < 0.02;
}

/**
 * The anchor at the top of the viewport, from the rects the sticky prompt
 * already measures: the top visible item and the fraction of it above the
 * container's top edge. Null when nothing is visible or the item has no
 * message id (a divider, a day header).
 */
export function anchorFromRects(
  rects: readonly { index: number; top: number; bottom: number }[],
  topVisibleIndex: number,
  containerTop: number,
  ids: readonly (string | null)[],
): { messageId: string; offset: number } | null {
  if (topVisibleIndex < 0) return null;
  const id = ids[topVisibleIndex];
  if (!id) return null;
  const r = rects.find((x) => x.index === topVisibleIndex);
  if (!r) return { messageId: id, offset: 0 };
  const h = r.bottom - r.top;
  const offset = h > 0 ? Math.min(1, Math.max(0, (containerTop - r.top) / h)) : 0;
  return { messageId: id, offset: Math.round(offset * 100) / 100 };
}

/**
 * What to do with a leader's view. A withheld view (a session the follower
 * cannot open) blocks. A view in a conversation opens it, and scrolls to the
 * leader's anchor when it names a message this window is not already at. A
 * view elsewhere pushes the route when it differs. Otherwise stay.
 */
export function planFollowApply(
  view: LeaderView,
  current: {
    pathname: string | null;
    conversationId: string | null;
    anchorMessageId: string | null;
    /** The in-page view this window applied last, on this page. */
    appliedView?: FollowView | null;
  },
): FollowPlan {
  if (view.withheld) return { kind: "blocked" };
  // A move to another page lands with nothing applied there yet.
  const inPage = (moved: boolean) => planViewApply(view.view, moved ? null : current.appliedView);
  if (view.conversation_id) {
    const target = view.anchor?.message_id ?? null;
    if (current.conversationId !== view.conversation_id) return { kind: "session", conversationId: view.conversation_id, scrollTo: target, view: inPage(true) };
    if (target && target !== current.anchorMessageId) return { kind: "session", conversationId: view.conversation_id, scrollTo: target, view: inPage(false) };
    return { kind: "stay", view: inPage(false) };
  }
  const path = view.path.trim();
  if (!path) return { kind: "stay", view: null };
  if (current.pathname && samePath(current.pathname, path)) return { kind: "stay", view: inPage(false) };
  return { kind: "route", path, view: inPage(true) };
}

/** Two paths are the same view when they agree without a trailing slash. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return norm(a) === norm(b);
}

/**
 * A follow ends on the follower's own move. A navigation event is the
 * person's own when it is a gesture that lands somewhere other than the
 * session the last apply asked for: an apply's own echo names exactly that
 * session, and a machine move (sync, rekey, follow) is never the person.
 * Matching on the target rather than on time matters: a leader who keeps
 * scrolling would otherwise renew any grace window forever, swallowing the
 * follower's click at the moment they most want to break away.
 */
export function shouldEndFollow(source: string, to: string | null | undefined, expectedTarget: string | null): boolean {
  if (source !== "gesture") return false;
  if (!to) return false;
  return to !== expectedTarget;
}

/** "Bob is following you", "Bob and Cy are following you", "3 following you". */
export function followersLabel(rows: readonly FollowerRow[]): string {
  const first = (n: string) => n.split(/\s+/)[0] || n;
  if (rows.length === 0) return "";
  if (rows.length === 1) return `${first(rows[0].name)} is following you`;
  if (rows.length === 2) return `${first(rows[0].name)} and ${first(rows[1].name)} are following you`;
  return `${rows.length} following you`;
}

/**
 * On a call, a stage in SPEAKER view follows a face: the pinned one, else
 * whoever spoke last. A viewer who is following someone on that call has
 * opted into following in the app, so their follow moves with the stage, and
 * the speaker's own view (the same payload as any follow) drives their app.
 * Returns the person to follow now, or null to leave the follow alone: not
 * following, following someone outside the call, another view, nobody on the
 * stage, the viewer themselves, or a face that is not a person (an agent has
 * no app to follow).
 */
export function stageFollowTarget(s: {
  view: string;
  pinned: string | null;
  speaker: string | null;
  leader: string | null;
  self: string | null;
  inCall: (id: string) => boolean;
  isPerson: (id: string) => boolean;
}): string | null {
  if (s.view !== "speaker" || !s.leader || !s.inCall(s.leader)) return null;
  const target = s.pinned ?? s.speaker;
  if (!target || target === s.self || target === s.leader || !s.isPerson(target)) return null;
  return target;
}
