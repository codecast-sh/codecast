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

// ---------------------------------------------------------------------------
// Well-known panes + selectors
//
// Regions used to each expose their own boolean (`sidePanelOpen`,
// `commentRailOpen`, `diff_panel_open`…). With slots there is one question —
// "what is in this slot?" — so the booleans become selectors over slot state.
// ---------------------------------------------------------------------------

export const SESSION_LIST_PANE: Pane = { kind: "sessionList" };
export const NAV_PANE: Pane = { kind: "nav" };
export const TERMINAL_PANE: Pane = { kind: "terminal" };

export function slotShows(ws: WorkspaceState, slot: SlotId, kind: PaneKind): boolean {
  const s = ws[slot];
  return s.pane?.kind === kind && s.presentation !== "collapsed";
}

/** The right edge is showing the session list. */
export function isSessionRailOpen(ws: WorkspaceState): boolean {
  return slotShows(ws, "context", "sessionList");
}

/** The right edge is showing conversation comments. */
export function isCommentRailOpen(ws: WorkspaceState): boolean {
  return slotShows(ws, "context", "comments");
}

/** Nav is present but folded to its hover-peek edge. */
export function isNavCollapsed(ws: WorkspaceState): boolean {
  return ws.nav.presentation === "collapsed";
}

// ---------------------------------------------------------------------------
// Persistence
//
// Slot CONFIGURATION persists (which regions you keep open, how wide, peek vs
// split); panes that name a SUBJECT do not. Restoring `{kind:"conversation",
// ref}` from a previous run is how the old conversation column became a stale
// column that reappeared where you didn't want it — the arrangement is worth
// remembering, the contents are re-derived from where you are now.
// ---------------------------------------------------------------------------

/**
 * Where a slot's arrangement is stored. Most regions follow you between devices
 * as an ordinary layout preference; some are device-local BY NATURE and saying
 * so belongs in the model rather than in a component that opts out of it. The
 * dock is the case in point: the terminal only exists where a loopback daemon
 * is reachable, so a phone has no terminal to open and must not inherit one.
 */
export const SLOT_PERSISTENCE: Record<SlotId, "shared" | "device"> = {
  nav: "shared",
  list: "shared",
  primary: "shared",
  secondary: "shared",
  context: "shared",
  dock: "device",
};

export function slotsWithPersistence(scope: "shared" | "device"): SlotId[] {
  return SLOT_IDS.filter((id) => SLOT_PERSISTENCE[id] === scope);
}

/** Pane kinds whose presence is a durable preference rather than a subject. */
const PERSISTABLE_KINDS: ReadonlySet<PaneKind> = new Set<PaneKind>(["nav", "sessionList", "terminal", "page"]);

export type PersistedWorkspace = Partial<Record<SlotId, { kind?: PaneKind; presentation: Presentation; size?: number }>>;

export function serializeWorkspace(ws: WorkspaceState, scope?: "shared" | "device"): PersistedWorkspace {
  const out: PersistedWorkspace = {};
  for (const id of scope ? slotsWithPersistence(scope) : SLOT_IDS) {
    const s = ws[id];
    const kind = s.pane && PERSISTABLE_KINDS.has(s.pane.kind) ? s.pane.kind : undefined;
    out[id] = { kind, presentation: s.presentation, size: s.size };
  }
  return out;
}

export function hydrateWorkspace(
  saved: PersistedWorkspace | undefined | null,
  deviceSaved?: PersistedWorkspace | undefined | null,
): WorkspaceState {
  const ws = createWorkspace();
  const merged: PersistedWorkspace = { ...(saved ?? {}) };
  for (const id of slotsWithPersistence("device")) {
    const d = deviceSaved?.[id];
    if (d) merged[id] = d; else delete merged[id];
  }
  if (!saved && !deviceSaved) return ws;
  for (const id of SLOT_IDS) {
    const _s = merged[id];
    void _s;
    const s = merged[id];
    if (!s) continue;
    const pane: Pane | null =
      s.kind === "nav" ? NAV_PANE
      : s.kind === "sessionList" ? SESSION_LIST_PANE
      : s.kind === "terminal" ? TERMINAL_PANE
      : s.kind === "page" ? { kind: "page" }
      : null;
    ws[id] = {
      pane: id === "primary" ? { kind: "page" } : pane,
      presentation: s.presentation ?? ws[id].presentation,
      size: s.size,
    };
  }
  return ws;
}

/**
 * Adopt a per-tab layout snapshot wholesale. Snapshots come from persistence
 * and from older clients that stamped partial shapes, so each slot is taken
 * only when it looks like real slot state (has its pane and presentation);
 * anything malformed keeps the current slot. Returns `current` untouched when
 * nothing well-formed is in the snapshot, so callers can cheaply detect a no-op.
 */
export function adoptWorkspaceSnapshot(current: WorkspaceState, snap: unknown): WorkspaceState {
  if (!snap || typeof snap !== "object") return current;
  const next: WorkspaceState = { ...current };
  let changed = false;
  for (const id of SLOT_IDS) {
    const s = (snap as Partial<Record<SlotId, SlotState>>)[id];
    if (!s || typeof s !== "object" || !("pane" in s) || !("presentation" in s)) continue;
    next[id] = s;
    changed = true;
  }
  return changed ? next : current;
}

/** The conversation sharing the stage, if any (the old `companionSessionId`). */
export function companionId(ws: WorkspaceState): string | null {
  const p = ws.secondary.pane;
  return p && p.kind === "conversation" ? p.ref : null;
}

/** The conversation drilled in as an overlay (the fleet board's dialog), if
    any. Distinct from a split companion: an overlay is what the user is
    LOOKING AT, so per-session chords and menus target it. */
export function overlayConversationId(ws: WorkspaceState): string | null {
  return ws.secondary.presentation === "overlay" ? companionId(ws) : null;
}

// ---------------------------------------------------------------------------
// Surfaces
//
// Which kind of place a route is. Routes default NO panes any more — side by
// side on the stage is the tab's split layout (store/stageSplit), entered by
// a deliberate gesture, and the one remaining secondary-slot use (the fleet
// board's overlay drill-in) is owned end to end by the board itself
// (components/FleetBoard: it shows the overlay, and its unmount clears it).
// ---------------------------------------------------------------------------

export type SurfaceKind = "inbox" | "conversation" | "working" | "settings" | "plain";

export function surfaceForPath(pathname: string): SurfaceKind {
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/inbox")) return "inbox";
  if (pathname.startsWith("/conversation/")) return "conversation";
  if (/^\/(tasks|docs|plans|threads)(\/|$)/.test(pathname)) return "working";
  return "plain";
}

