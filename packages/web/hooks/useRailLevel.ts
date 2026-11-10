import { useState } from "react";

// Which level of the Modern rail is open (components/sidebar/ModernSidebar):
// Chat, Tasks or More, slid over the root rail, or none.
//
// A level is open for one of two reasons. The route belongs to it (a chat
// room opens Chat, a task opens Tasks), and then it closes as soon as the
// route leaves it: a full load of /ops in a tab that showed a chat room
// earlier lands on the root rail, never on a Chat level left over from the
// tab's last page. Or the person opened it by hand (the Chat row, More), and
// then it stays while they move around, so opening a session from the side
// panel keeps them in Chat, until Back or until they arrive in another
// level's section. Back always returns to the root, whichever opened it.

export function useRailLevel<L extends string>(routeLevel: L | null, available: Record<L, boolean>) {
  const [s, set] = useState<{
    /** The level the route belongs to, as last rendered. */
    route: L | null;
    /** The level the person opened by hand, until Back or another section. */
    byHand: L | null;
    /** The route's level after Back on that route: closed until the route moves. */
    dismissed: L | null;
    /** The last level drawn, so the pane keeps its content while it slides out. */
    shown: L | null;
  }>({ route: routeLevel, byHand: null, dismissed: null, shown: routeLevel });

  // The route moved: arriving in a section opens its level (and replaces a
  // level opened by hand for another section); leaving one closes the level
  // it opened. Render-phase, so the first paint of the new page is right.
  let cur = s;
  if (cur.route !== routeLevel) {
    cur = { ...cur, route: routeLevel, dismissed: null, byHand: routeLevel && cur.byHand !== routeLevel ? null : cur.byHand };
  }
  const want = cur.byHand ?? (cur.route && cur.route !== cur.dismissed ? cur.route : null);
  const level = want && available[want] ? want : null;
  if (level && level !== cur.shown) cur = { ...cur, shown: level };
  if (cur !== s) set(cur);

  return {
    level,
    // The pane keeps its content while it slides out.
    shown: level ?? cur.shown,
    back: () => set((p) => ({ ...p, byHand: null, dismissed: p.route })),
    open: (l: L) => set((p) => ({ ...p, byHand: l, dismissed: null, shown: l })),
  };
}
