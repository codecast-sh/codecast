// Workbenches: the workspace arrangement as a NAMED, switchable thing.
//
// The insight behind these (see the "Workbenches" product direction): you never
// want "a doc beside a session", you want to BE reviewing, or BE triaging. So
// the arrangement is a property of the activity — designed once, given a name,
// and switched wholesale — instead of something you re-assemble by hand out of
// pins, closes and drags before every task.
//
// A workbench is a snapshot of the ENTIRE chrome: every slot's occupant kind,
// presentation and size, plus zen mode, the session panel's chip filter and
// (optionally) the surface it belongs on. Applying one restores all of it
// atomically. Contents stay re-derived — the same rule the ambient workspace
// persistence follows: a snapshot records that the context edge shows comments,
// never WHICH conversation's comments.
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

/**
 * The session panel's ONE chip filter, as a snapshot records it. Triaging a
 * single label is a different activity from triaging everything, so the chip
 * belongs to the workbench alongside the panes.
 */
export type WorkbenchFilter = {
  /** id AND name: buckets are per-user today, so a shared layout resolves by
   *  id first, then by name against the applier's own labels. */
  bucket?: { id: string; name: string };
  project?: { name: string; path: string | null };
  exclude?: boolean;
};

/** Just enough of the store's bucket map to resolve a snapshot's label by name. */
export type BucketNames = Record<string, { name?: string } | undefined>;

export type WorkbenchSnapshot = {
  /** The surface this arrangement belongs on ("/inbox", "/tasks"…). Applying a
   *  workbench navigates there — the activity includes where you are. */
  path?: string;
  /** Zen hides the whole chrome; it is part of the arrangement like any rail. */
  zen?: boolean;
  /** Absent = no chip was live. A workbench is the WHOLE view, so applying one
   *  without a filter clears whatever chip is up — including for the older
   *  saves that predate this field. */
  filter?: WorkbenchFilter;
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

/** The current chrome, in full — every slot, zen, the surface and the chip. */
export function captureWorkbench(
  ws: WorkspaceState,
  opts?: { zen?: boolean; path?: string; filter?: WorkbenchFilter },
): WorkbenchSnapshot {
  const slots: Partial<Record<SlotId, WorkbenchSlot>> = {};
  for (const id of SLOT_IDS) {
    const s = ws[id];
    slots[id] = { pane: occupantOf(s.pane), presentation: s.presentation, size: s.size };
  }
  return { path: opts?.path, zen: opts?.zen ?? false, filter: opts?.filter, slots };
}

/** The chip row's single live filter in snapshot form, or undefined when no
 *  chip is up — a layout saved with a clear chip carries no filter at all. */
export function chipFilterOf(s: {
  activeBucketFilter?: string | null;
  activeProjectFilter?: string | null;
  activeProjectPath?: string | null;
  chipFilterExclude?: boolean;
  buckets?: BucketNames;
}): WorkbenchFilter | undefined {
  const exclude = !!s.chipFilterExclude;
  if (s.activeBucketFilter) {
    return { bucket: { id: s.activeBucketFilter, name: s.buckets?.[s.activeBucketFilter]?.name ?? "" }, exclude };
  }
  if (s.activeProjectFilter) {
    return { project: { name: s.activeProjectFilter, path: s.activeProjectPath ?? null }, exclude };
  }
  return undefined;
}

/**
 * A snapshot's filter as it applies HERE — the shape the store's three chip
 * fields take. The bucket resolves by id first, then by name (a shared layout
 * names a label this user has under a different id), and is DROPPED when
 * neither hits: filtering by a label you don't have would silently empty the
 * panel. Bucket wins over project; the chip row is one filter.
 */
export function resolveWorkbenchFilter(
  filter: WorkbenchFilter | undefined,
  buckets: BucketNames,
): { bucket: string | null; project: string | null; projectPath: string | null; exclude: boolean } {
  const want = filter?.bucket;
  const bucket = !want ? null
    : buckets[want.id] ? want.id
    : (Object.keys(buckets).find((id) => buckets[id]?.name === want.name) ?? null);
  if (bucket) return { bucket, project: null, projectPath: null, exclude: !!filter?.exclude };
  const project = filter?.project;
  if (!project) return { bucket: null, project: null, projectPath: null, exclude: false };
  return { bucket: null, project: project.name, projectPath: project.path ?? null, exclude: !!filter?.exclude };
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
    // The secondary slot is no longer an arrangement anyone declares: its one
    // remaining use is the fleet board's transient drill-in, owned by the
    // board. Old saves pinned companions here; applying that snapshot today
    // would strand a pane in a slot nothing renders.
    if (id === "secondary") continue;
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
 * occupies each slot, how it presents, and the chip filter; sizes and subjects
 * are ignored — a pixel of drag or a different conversation doesn't deselect
 * the activity.
 */
export function matchesWorkbench(
  ws: WorkspaceState,
  snap: WorkbenchSnapshot,
  opts?: { zen?: boolean; filter?: WorkbenchFilter; buckets?: BucketNames },
): boolean {
  if ((snap.zen ?? false) !== (opts?.zen ?? false)) return false;
  // Both sides go through the same resolution, so a shared layout whose label
  // resolves by name still counts as the one you are in — and a chip you change
  // by hand is drift, exactly what the update affordance exists to surface.
  const buckets = opts?.buckets ?? {};
  const wantFilter = resolveWorkbenchFilter(snap.filter, buckets);
  const haveFilter = resolveWorkbenchFilter(opts?.filter, buckets);
  if (
    wantFilter.bucket !== haveFilter.bucket ||
    wantFilter.project !== haveFilter.project ||
    wantFilter.exclude !== haveFilter.exclude
  ) return false;
  for (const id of SLOT_IDS) {
    // Ignored on apply (see applyWorkbench), so ignored here too — an old
    // save's pinned companion must not keep a workbench from ever matching.
    if (id === "secondary") continue;
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

