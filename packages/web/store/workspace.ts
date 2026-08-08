// The workspace: one layout system for every region of the screen.
//
// A workspace is a fixed set of SLOTS. Each slot holds AT MOST ONE pane, so the
// cap ("no more than N things beside each other") is structural — there is
// nowhere to put an extra pane — rather than a policy each region has to
// remember. Every region that used to carry its own open flag, its own sticky
// dismissal, its own size key and its own ✕ becomes a pane in a slot.
//
// The rules live here as pure reducers so they can be tested without React and
// stated once: inboxStore actions are thin wrappers that apply them.
// See WORKSPACE_SLOTS.md for the design and the migration order.

/** Screen regions, in left-to-right order (dock sits beneath them all). */
export type SlotId = "nav" | "list" | "primary" | "secondary" | "context" | "dock";

export const SLOT_IDS: readonly SlotId[] = ["nav", "list", "primary", "secondary", "context", "dock"] as const;

/** What a slot is showing. `ref` identifies the subject (a session, doc, task). */
export type Pane =
  | { kind: "nav" }
  | { kind: "page" }
  | { kind: "conversation"; ref: string }
  | { kind: "sessionList" }
  | { kind: "comments"; ref: string }
  | { kind: "detail"; ref: string }
  | { kind: "diff"; ref?: string }
  | { kind: "terminal" };

export type PaneKind = Pane["kind"];

/**
 * How a slot occupies space:
 *  - "split"     a real resizable column beside its neighbours
 *  - "overlay"   a peek sliding over its neighbour; transient by nature
 *  - "collapsed" a thin edge that hover-peeks (the old EdgePeek)
 */
export type Presentation = "split" | "overlay" | "collapsed";

export type SlotState = {
  pane: Pane | null;
  presentation: Presentation;
  /** Persisted through the existing layouts bag, keyed by slot. */
  size?: number;
  /**
   * The generalized sticky dismissal. When the user closes a pane BY HAND, the
   * pane is remembered here so automatic rules (a route default, a "carry the
   * conversation along" rule) don't immediately put it back — otherwise the ✕
   * is a lie. Cleared as soon as a DIFFERENT pane wants the slot.
   */
  userClosed?: Pane | null;
};

export type WorkspaceState = Record<SlotId, SlotState>;

const emptySlot = (presentation: Presentation = "split"): SlotState => ({ pane: null, presentation });

export function createWorkspace(): WorkspaceState {
  return {
    nav: emptySlot("split"),
    list: emptySlot("split"),
    primary: { pane: { kind: "page" }, presentation: "split" },
    secondary: emptySlot("overlay"),
    context: emptySlot("split"),
    dock: emptySlot("split"),
  };
}

/** Same subject in the same role — the identity used by dismissal and swap. */
export function samePane(a: Pane | null | undefined, b: Pane | null | undefined): boolean {
  if (!a || !b) return a == null && b == null;
  if (a.kind !== b.kind) return false;
  const ra = "ref" in a ? a.ref : undefined;
  const rb = "ref" in b ? b.ref : undefined;
  return ra === rb;
}

export function paneIn(ws: WorkspaceState, slot: SlotId): Pane | null {
  return ws[slot].pane;
}

export function isVisible(ws: WorkspaceState, slot: SlotId): boolean {
  const s = ws[slot];
  return s.pane != null && s.presentation !== "collapsed";
}

/** Which slot, if any, currently holds this pane. */
export function findPane(ws: WorkspaceState, pane: Pane): SlotId | null {
  for (const id of SLOT_IDS) if (samePane(ws[id].pane, pane)) return id;
  return null;
}

function patch(ws: WorkspaceState, slot: SlotId, next: Partial<SlotState>): WorkspaceState {
  return { ...ws, [slot]: { ...ws[slot], ...next } };
}

/**
 * Put a pane in a slot. Whatever was there is replaced — panes swap, they never
 * accumulate. An explicit show outranks an earlier hand-close of a DIFFERENT
 * pane, so the dismissal never leaks onto an unrelated subject.
 */
export function showPane(
  ws: WorkspaceState,
  slot: SlotId,
  pane: Pane,
  opts?: { presentation?: Presentation },
): WorkspaceState {
  const cur = ws[slot];
  const presentation = opts?.presentation ?? (cur.presentation === "collapsed" ? "split" : cur.presentation);
  return patch(ws, slot, {
    pane,
    presentation,
    // Showing this pane clears a dismissal, whether it was for this pane
    // (explicit re-open beats the sticky close) or another one (stale).
    userClosed: null,
  });
}

/**
 * Empty a slot. `remember` (the ✕) records the pane so automatic rules leave it
 * closed until a different pane wants the slot; without it this is bookkeeping
 * (the surface went away) and the pane may come back on its own.
 */
export function hidePane(ws: WorkspaceState, slot: SlotId, opts?: { remember?: boolean }): WorkspaceState {
  const cur = ws[slot];
  const remember = opts?.remember !== false;
  return patch(ws, slot, {
    pane: null,
    userClosed: remember && cur.pane ? cur.pane : cur.userClosed ?? null,
  });
}

/**
 * May an automatic rule (route default, carry-along) put this pane here? False
 * only while the user's own close of that same pane stands.
 */
export function autoAllowed(ws: WorkspaceState, slot: SlotId, pane: Pane): boolean {
  return !samePane(ws[slot].userClosed, pane);
}

/** Show if absent or different; hide (remembering) if this exact pane is up. */
export function togglePane(ws: WorkspaceState, slot: SlotId, pane: Pane): WorkspaceState {
  if (isVisible(ws, slot) && samePane(ws[slot].pane, pane)) return hidePane(ws, slot, { remember: true });
  return showPane(ws, slot, pane);
}

export function setPresentation(ws: WorkspaceState, slot: SlotId, presentation: Presentation): WorkspaceState {
  return patch(ws, slot, { presentation });
}

export function setSize(ws: WorkspaceState, slot: SlotId, size: number): WorkspaceState {
  return patch(ws, slot, { size });
}

/**
 * Move a slot's pane onto the stage. The pane it displaces moves back into the
 * slot, so promote is a swap and the total pane count never changes.
 */
export function promote(ws: WorkspaceState, slot: SlotId): WorkspaceState {
  if (slot === "primary") return ws;
  const incoming = ws[slot].pane;
  if (!incoming) return ws;
  const displaced = ws.primary.pane;
  let next = patch(ws, "primary", { pane: incoming, presentation: "split" });
  next = patch(next, slot, {
    pane: displaced && displaced.kind !== "page" ? displaced : null,
    userClosed: null,
  });
  return next;
}

/**
 * The topmost overlay — what Esc should retreat from. One rule for every
 * region, instead of a keydown handler per component.
 */
export function topOverlay(ws: WorkspaceState): SlotId | null {
  for (const id of ["secondary", "context", "list", "dock", "nav"] as SlotId[]) {
    const s = ws[id];
    if (s.pane && s.presentation === "overlay") return id;
  }
  return null;
}
