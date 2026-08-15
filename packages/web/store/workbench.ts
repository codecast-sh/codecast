// Workbenches: the workspace arrangement as a NAMED, switchable thing.
//
// The insight behind these (see the "Workbenches" product direction): you never
// want "a doc beside a session", you want to BE reviewing, or BE triaging. So
// the arrangement is a property of the activity — designed once, given a name,
// and switched wholesale — instead of something you re-assemble by hand out of
// pins, closes and drags before every task.
//
// A workbench is a snapshot of the ENTIRE chrome: every slot's occupant kind,
// presentation and size, plus zen mode and (optionally) the surface it belongs
// on. Applying one restores all of it atomically. Contents stay re-derived —
// the same rule the ambient workspace persistence follows: a snapshot records
// that the context edge shows comments, never WHICH conversation's comments.
//
// Pure functions over WorkspaceState, like store/workspace.ts; inboxStore
// actions are thin wrappers. Saved workbenches persist as saved_views rows
// (page: "workspace"), so naming/sharing/deleting reuses that whole pipeline.
// There are no shipped presets: every workbench starts as "save what I have
// now", and is adjusted the same way — arrange, then update it in place.

import {
  SLOT_IDS,
  NAV_PANE,
  SESSION_LIST_PANE,
  TERMINAL_PANE,
  type Pane,
  type PaneKind,
  type Presentation,
  type SlotId,
  type WorkspaceState,
} from "./workspace";

/**
 * What a snapshot says occupies a slot:
 *  - a restorable PaneKind ("nav", "sessionList", "terminal", "page",
 *    "comments") — apply re-creates the pane, re-deriving any subject;
 *  - "empty"   — the slot is explicitly vacant (apply clears it);
 *  - "subject" — a subject pane (a conversation, a detail) was there. Apply
 *    keeps whatever subject currently occupies the slot rather than conjuring
 *    one: the ARRANGEMENT (presentation, size) is the preference, the subject
 *    is where you are now.
 */
export type WorkbenchOccupant = PaneKind | "empty" | "subject";

export type WorkbenchSlot = {
  pane: WorkbenchOccupant;
  presentation: Presentation;
  size?: number;
};

export type WorkbenchSnapshot = {
  /** The surface this arrangement belongs on ("/inbox", "/tasks"…). Applying a
   *  workbench navigates there — the activity includes where you are. */
  path?: string;
  /** Zen hides the whole chrome; it is part of the arrangement like any rail. */
  zen?: boolean;
  slots: Partial<Record<SlotId, WorkbenchSlot>>;
};

/** Kinds a snapshot can re-create. "comments" is here even though it names a
 *  subject: the subject (which conversation) is re-derived at apply time. */
const RESTORABLE_KINDS: ReadonlySet<PaneKind> = new Set<PaneKind>([
  "nav",
  "page",
  "sessionList",
  "terminal",
  "comments",
]);

/** Kinds whose apply can legitimately produce nothing (no subject on screen,
 *  no terminal on this device) — matching excuses their absence. */
const MAY_FAIL_TO_MATERIALIZE: ReadonlySet<PaneKind> = new Set<PaneKind>(["comments", "terminal"]);

function occupantOf(pane: Pane | null): WorkbenchOccupant {
  if (!pane) return "empty";
  return RESTORABLE_KINDS.has(pane.kind) ? pane.kind : "subject";
}

/** The current chrome, in full — every slot, zen, and the surface. */
export function captureWorkbench(
  ws: WorkspaceState,
  opts?: { zen?: boolean; path?: string },
): WorkbenchSnapshot {
  const slots: Partial<Record<SlotId, WorkbenchSlot>> = {};
  for (const id of SLOT_IDS) {
    const s = ws[id];
    slots[id] = { pane: occupantOf(s.pane), presentation: s.presentation, size: s.size };
  }
  return { path: opts?.path, zen: opts?.zen ?? false, slots };
}

export type ApplyContext = {
  /** The conversation whose comments the context edge would show. */
  conversationId?: string | null;
  /** Whether this device can host a terminal (a phone cannot). */
  allowTerminal?: boolean;
};

function paneFor(kind: PaneKind, ctx: ApplyContext): Pane | null {
  switch (kind) {
    case "nav": return NAV_PANE;
    case "page": return { kind: "page" };
    case "sessionList": return SESSION_LIST_PANE;
    case "terminal": return ctx.allowTerminal === false ? null : TERMINAL_PANE;
    // Comments without a conversation on screen is nothing to show — the slot
    // stays empty rather than opening a rail with no subject.
    case "comments": return ctx.conversationId ? { kind: "comments", ref: ctx.conversationId } : null;
    default: return null;
  }
}

/**
 * Restore a snapshot wholesale. Every slot the snapshot names is set — pane,
 * presentation and size — and every sticky dismissal is cleared: applying a
 * workbench is the most explicit arrangement gesture there is, so no earlier
 * hand-close outranks it. Slots the snapshot doesn't mention keep their state
 * (only snapshots from older saves omit slots). `primary` always keeps the
 * page: the route owns the stage's contents.
 */
export function applyWorkbench(
  ws: WorkspaceState,
  snap: WorkbenchSnapshot,
  ctx: ApplyContext = {},
): WorkspaceState {
  const next: WorkspaceState = { ...ws };
  for (const id of SLOT_IDS) {
    const want = snap.slots[id];
    if (!want) continue;
    const cur = next[id];
    const pane =
      id === "primary" ? { kind: "page" as const }
      : want.pane === "subject" ? cur.pane
      : want.pane === "empty" ? null
      : paneFor(want.pane, ctx);
    next[id] = {
      pane,
      presentation: want.presentation,
      // A snapshot without a size for this slot leaves the current one alone —
      // sizes are always worth keeping over resetting.
      size: want.size ?? cur.size,
      userClosed: null,
    };
  }
  return next;
}

/**
 * Is the live chrome still arranged the way this snapshot says? Compares what
 * occupies each slot and how it presents; sizes and subjects are ignored — a
 * pixel of drag or a different conversation doesn't deselect the activity.
 */
export function matchesWorkbench(
  ws: WorkspaceState,
  snap: WorkbenchSnapshot,
  opts?: { zen?: boolean },
): boolean {
  if ((snap.zen ?? false) !== (opts?.zen ?? false)) return false;
  for (const id of SLOT_IDS) {
    const want = snap.slots[id];
    if (!want) continue;
    const cur = ws[id];
    if (want.presentation !== cur.presentation) return false;
    if (want.pane === "subject") continue;
    const have = occupantOf(cur.pane);
    if (want.pane === have) continue;
    // A kind that could not materialize (comments with no conversation on
    // screen, terminal on a phone) leaves the slot empty; that still counts as
    // this workbench — the arrangement is right, the subject merely absent.
    // A slot the user CLOSED is different: userClosed marks the dismissal, and
    // a hand-close is exactly the drift the update affordance must surface.
    if (have === "empty" && !cur.userClosed && MAY_FAIL_TO_MATERIALIZE.has(want.pane as PaneKind)) continue;
    return false;
  }
  return true;
}

