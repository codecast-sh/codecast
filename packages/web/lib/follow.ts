// Follow mode, the pure parts: what a leader's view means for a follower's
// window, where in a transcript a leader is, and when a follow ends.
//
// A follow is a lease the follower holds on the leader (convex/follow.ts);
// the leader reports their place only while someone holds one. The follower
// applies each report as the person themselves would have moved: a route
// push, the app's one session path, a scroll to a message. Any move the
// follower makes on their own ends the follow, as in Figma.

export type FollowerRow = { user_id: string; name: string; image?: string };

/** Where this window is in a transcript: the top visible message and how much
 *  of it has scrolled past (0 at its top edge, 1 at its bottom). */
export type ViewAnchor = { conversationId: string; messageId: string; offset: number };

export type LeaderView = {
  path: string;
  conversation_id?: string;
  anchor?: { message_id: string; offset: number };
  updated_at: number;
  withheld: boolean;
};

export type FollowPlan =
  | { kind: "blocked" }
  | { kind: "stay" }
  | { kind: "route"; path: string }
  | { kind: "session"; conversationId: string; scrollTo: string | null };


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
  current: { pathname: string | null; conversationId: string | null; anchorMessageId: string | null },
): FollowPlan {
  if (view.withheld) return { kind: "blocked" };
  if (view.conversation_id) {
    const target = view.anchor?.message_id ?? null;
    if (current.conversationId !== view.conversation_id) return { kind: "session", conversationId: view.conversation_id, scrollTo: target };
    if (target && target !== current.anchorMessageId) return { kind: "session", conversationId: view.conversation_id, scrollTo: target };
    return { kind: "stay" };
  }
  const path = view.path.trim();
  if (!path) return { kind: "stay" };
  if (current.pathname && samePath(current.pathname, path)) return { kind: "stay" };
  return { kind: "route", path };
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
