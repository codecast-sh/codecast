// The window's undo stack and its history.
//
// Entries come from two places. The middleware records a "generic" entry for
// every action with an undo spec (see undo.ts): its closures replay the old
// cell values through the action pipeline and re-invoke the action on redo.
// App code may still push a hand-written "manual" entry with pushUndo. Both
// keep the closure contract: undo() and redo() do the work, and may return
// an UndoOutcome saying whether they could.
//
// Everything here is in memory and per window. The history is a ring of the
// last entries in any state (done, undone, conflict, refused, dropped,
// external); the stacks hold only what a keypress can still reach.
import { sameShape } from "./syncProtocol";
import type { CellChange, UndoEntry, UndoOutcome } from "./types";

export type { UndoEntry, UndoOutcome };

// How the stack tells the user what happened. The engine ships no toast of its
// own: an app installs its notifier once at boot.
export type UndoNotifier = {
  notify: (message: string) => void;
  /** Show `label` with an inline "Undo" affordance wired to undoEntry(entryId). */
  notifyWithUndo?: (label: string, entryId: string) => void;
  /**
   * A successful undo or redo walk: `steps` entries in one press or one
   * timeline click, `entry` the last one reached. When present it replaces
   * the default "Undid: <label>" notice; conflicts still go through notify.
   */
  onHistoryStep?: (kind: "undo" | "redo", steps: number, entry: UndoEntry) => void;
  /**
   * A keyboard undo stopped at a `confirm` entry and took nothing back. When
   * present it replaces notify(message), so an app can point at the entry
   * (an open history can mark its row) instead of only printing the notice.
   */
  onConfirmStop?: (entry: UndoEntry, message: string) => void;
};

export type UndoHistoryItem = Omit<UndoEntry, "undo" | "redo" | "children"> & {
  children?: UndoHistoryItem[];
};
export type UndoHistorySnapshot = {
  version: number;
  /** Newest first. */
  items: readonly UndoHistoryItem[];
  /** The entry the next undo would take back, or null. */
  head: string | null;
  /**
   * Ids on the undo stack, top first: the order successive undos take them
   * back. Differs from history order once an entry is undone out of turn
   * and redone, and omits done entries trimmed past the stack limit.
   */
  undoOrder: readonly string[];
  /** Ids on the redo stack, top first: the order successive redos replay. */
  redoOrder: readonly string[];
};

export const DEFAULT_UNDO_KEYBOARD_WINDOW_MS = 5 * 60_000;
export const DEFAULT_UNDO_STACK_LIMIT = 100;
export const DEFAULT_UNDO_HISTORY_LIMIT = 200;
export const UNDO_COALESCE_WINDOW_MS = 2_000;

let keyboardWindowMs = DEFAULT_UNDO_KEYBOARD_WINDOW_MS;
let stackLimit = DEFAULT_UNDO_STACK_LIMIT;
let historyLimit = DEFAULT_UNDO_HISTORY_LIMIT;
let stampFields: ReadonlySet<string> | undefined;

let undoStack: UndoEntry[] = [];
let redoStack: UndoEntry[] = [];
// Oldest first; the snapshot reverses it.
let history: UndoEntry[] = [];
let notifier: UndoNotifier = { notify: () => {} };

let version = 0;
let snapshot: UndoHistorySnapshot | null = null;
const listeners = new Set<() => void>();

let suppressDepth = 0;
let refreshTarget: UndoEntry | null = null;
let groupDepth = 0;
let groupChildren: UndoEntry[] | null = null;
let groupToast = false;
// External entries recorded inside the open group: one gesture over several
// rows the record owns becomes one history row, named by the group's label.
let groupExternals: UndoEntry[] | null = null;
let idCounter = 0;

/** Tune the limits; the middleware calls it with PlatformConfig.undo. */
export function configureUndoStack(opts: {
  keyboardWindowMs?: number;
  stackLimit?: number;
  historyLimit?: number;
  stampFields?: ReadonlySet<string>;
}): void {
  if (opts.keyboardWindowMs !== undefined) keyboardWindowMs = opts.keyboardWindowMs;
  if (opts.stackLimit !== undefined) stackLimit = opts.stackLimit;
  if (opts.historyLimit !== undefined) historyLimit = opts.historyLimit;
  if (opts.stampFields !== undefined) stampFields = opts.stampFields;
}

/** The protected rows some cells name, once each, in order. */
export function objectsOf(changes: readonly CellChange[]): Array<{ store: string; id: string }> {
  const seen = new Set<string>();
  const out: Array<{ store: string; id: string }> = [];
  for (const c of changes) {
    if (c.kind !== "protected") continue;
    const k = `${c.store}\u0000${c.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ store: c.store, id: c.id });
  }
  return out;
}

/**
 * How many server rows a list of objects names. Two stores on one table hold
 * copies of one row under the row's id (`objects` lists each copy, `skipped`
 * each row once), so every count of rows reads ids, never list lengths.
 */
export function undoRowCount(objects: ReadonlyArray<{ store: string; id: string }> | undefined): number {
  return new Set((objects ?? []).map((o) => o.id)).size;
}

export function getUndoKeyboardWindowMs(): number {
  return keyboardWindowMs;
}

export function setUndoNotifier(next: UndoNotifier): void {
  notifier = next;
}

export function newUndoEntryId(): string {
  idCounter += 1;
  return `u${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function changed(): void {
  version += 1;
  snapshot = null;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error("[undo] history listener failed", error);
    }
  }
}

// The ring drops its oldest entries first, but never one a stack still holds:
// the timeline must be able to render every entry an undo or redo can reach.
function addToHistory(entry: UndoEntry): void {
  history.push(entry);
  let excess = history.length - historyLimit;
  if (excess <= 0) return;
  const onStack = new Set([...undoStack, ...redoStack]);
  history = history.filter((e) => {
    if (excess <= 0 || onStack.has(e)) return true;
    excess -= 1;
    return false;
  });
}

function remove(stack: UndoEntry[], entry: UndoEntry): boolean {
  const at = stack.indexOf(entry);
  if (at === -1) return false;
  stack.splice(at, 1);
  return true;
}

/**
 * Put an entry back on a stack at the place its history order gives it: the
 * undo stack holds the newest on top, the redo stack the oldest. Refusals of
 * a walk's replays arrive in walk order, so pushing each on top would invert
 * the stack.
 */
function restoreToStack(which: "undo" | "redo", entry: UndoEntry): void {
  const stack = which === "undo" ? undoStack : redoStack;
  const rank = history.indexOf(entry);
  const newerOnTop = which === "undo";
  let at = stack.length;
  while (at > 0) {
    const below = history.indexOf(stack[at - 1]!);
    if (newerOnTop ? below < rank : below > rank) break;
    at -= 1;
  }
  stack.splice(at, 0, entry);
}

function pushEntry(entry: UndoEntry): void {
  for (const dropped of redoStack) {
    dropped.status = "dropped";
    dropped.droppedBy = entry.id;
  }
  redoStack = [];
  entry.status = "done";
  undoStack.push(entry);
  if (undoStack.length > stackLimit) undoStack.splice(0, undoStack.length - stackLimit);
  addToHistory(entry);
  changed();
}

// ---------------------------------------------------------------------------
// Capture context: replays, withoutUndo, redo refresh, groups
// ---------------------------------------------------------------------------

/** Run `fn` with capture off: nothing it does is recorded. */
export function withoutUndo<T>(fn: () => T): T {
  suppressDepth += 1;
  try {
    return fn();
  } finally {
    suppressDepth -= 1;
  }
}

// Holds on recording for the whole window (suspendUndoRecording).
let recordingHolds = 0;

/**
 * Stop recording in this window until the returned release runs. For a
 * window with no way to undo (no undo key, no toast it can click, no
 * timeline): an entry recorded there would strand in its in-memory history,
 * and the gesture would look undoable when nothing can reach it. Counted, and
 * each release counts once.
 */
export function suspendUndoRecording(): () => void {
  recordingHolds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    recordingHolds = Math.max(0, recordingHolds - 1);
  };
}

export function isUndoSuppressed(): boolean {
  return suppressDepth > 0 || recordingHolds > 0;
}

/** The entry a redo is refreshing, so its capture rewrites that entry instead of pushing. */
export function undoRefreshTarget(): UndoEntry | null {
  return refreshTarget;
}

/**
 * The undone entries a redo of `entry` comes before, nearest first: its later
 * siblings in its group, then the redo stack above its owner. Each of them
 * recorded the state `entry` left as its own before state.
 */
export function undoneAfter(entry: UndoEntry): UndoEntry[] {
  const owner = redoStack.find((e) => e === entry || e.children?.includes(entry));
  if (!owner) return [];
  const out = owner === entry ? [] : owner.children!.slice(owner.children!.indexOf(entry) + 1);
  for (let i = redoStack.indexOf(owner) - 1; i >= 0; i -= 1) {
    const later = redoStack[i]!;
    out.push(...(later.children ?? [later]));
  }
  return out;
}

/** The entries recorded after `entry`, oldest first: its later siblings in
 *  its group, then every entry the history holds above its owner. */
function recordedAfter(entry: UndoEntry): UndoEntry[] {
  const order = withVanished(history.some((e) => e === entry || e.children?.includes(entry)) ? history : undoStack);
  const owner = order.find((e) => e === entry || e.children?.includes(entry));
  if (!owner) return [];
  const out = owner === entry ? [] : owner.children!.slice(owner.children!.indexOf(entry) + 1);
  for (const later of order.slice(order.indexOf(owner) + 1)) out.push(...(later.children ?? [later]));
  return out;
}

/**
 * `order` with every vanished run (a coalesced run that ended where it
 * began, out of the history while its calls are on the wire) at the place it
 * comes back to. A run can come back, so every rebase that walks the entries
 * recorded after one reaches it there too, and the value it began from stays
 * what stands under it.
 */
function withVanished(order: UndoEntry[]): UndoEntry[] {
  const runs = new Set([...vanishedRuns.values()]);
  if (runs.size === 0) return order;
  const out = [...order];
  for (const v of runs) {
    if (out.includes(v.entry)) continue;
    out.splice(vanishedPlace(out, v), 0, v.entry);
  }
  return out;
}

/** Where a vanished run goes back into `order`: over the entry it sat on, or by time when that is gone. */
function vanishedPlace(order: UndoEntry[], v: { entry: UndoEntry; below: UndoEntry | undefined }): number {
  const under = v.below ? order.indexOf(v.below) : -1;
  if (under !== -1) return under + 1;
  if (!v.below) return 0;
  const later = order.findIndex((e) => e.ts > v.entry.ts);
  return later === -1 ? order.length : later;
}

/** A cell whose value under the later entries changed: the value they saw (`from`) and the one that stands (`to`). */
export type UndoCellMove = { from: { after: unknown; hadAfter: boolean }; to: { after: unknown; hadAfter: boolean } };

// Cells kept beside an entry outside the stack (a controller's applied cells),
// rebased with the entry's own.
const rebaseHooks = new Set<(entry: UndoEntry, rebase: (cells: CellChange[]) => CellChange[]) => void>();

/** Called when an entry's cells are rebased, with the same rebase for any cells kept beside it. Returns the unsubscribe. */
export function onUndoRebase(hook: (entry: UndoEntry, rebase: (cells: CellChange[]) => CellChange[]) => void): () => void {
  rebaseHooks.add(hook);
  return () => {
    rebaseHooks.delete(hook);
  };
}

/**
 * A value under `later` moved: each cell in `moved` (by cell key) now stands at
 * its `to` value where the later entries recorded `from`. The nearest later
 * entry that touches the cell takes `to` as its before, if its before was
 * `from`; the cell is then settled for every entry above it, which recorded
 * that entry's after instead.
 */
export function rebaseUndoCells(
  later: Iterable<UndoEntry>,
  moved: Map<string, UndoCellMove>,
  defer?: (entry: UndoEntry) => boolean,
): boolean {
  let touched = false;
  for (const entry of later) {
    if (moved.size === 0) break;
    const reached = new Set<string>();
    // An entry `defer` names consumes the move without taking it: it is
    // kept beside the entry (replayDeferred) for its replay's refusal.
    if (defer?.(entry)) {
      for (const c of entry.changes ?? []) {
        const m = moved.get(cellKey(c));
        if (!m) continue;
        reached.add(cellKey(c));
        if (c.hadBefore !== m.from.hadAfter || !sameShape(c.before, m.from.after)) continue;
        entry.replayDeferred = [
          ...(entry.replayDeferred ?? []).filter((d) => cellKey(d) !== cellKey(c)),
          { ...c, before: m.from.after, hadBefore: m.from.hadAfter, after: m.to.after, hadAfter: m.to.hadAfter },
        ];
      }
      for (const k of reached) moved.delete(k);
      continue;
    }
    const rebase = (cells: CellChange[]) =>
      cells.map((c) => {
        const m = moved.get(cellKey(c));
        if (!m) return c;
        reached.add(cellKey(c));
        if (c.hadBefore !== m.from.hadAfter || !sameShape(c.before, m.from.after)) return c;
        touched = true;
        return { ...c, before: m.to.after, hadBefore: m.to.hadAfter };
      });
    if (entry.changes) entry.changes = rebase(entry.changes);
    for (const hook of rebaseHooks) hook(entry, rebase);
    for (const k of reached) moved.delete(k);
    if (reached.size > 0) rebaseVanished(entry);
  }
  return touched;
}

export function withUndoRefresh<T>(entry: UndoEntry, fn: () => T): T {
  const prior = refreshTarget;
  refreshTarget = entry;
  try {
    return fn();
  } finally {
    refreshTarget = prior;
  }
}

/**
 * Fold every capture inside `fn` into one entry. Synchronous only: the group
 * closes when `fn` returns. A nested group flattens into the outer one, whose
 * label wins. The label may be a function of the captured entries, resolved
 * when the group closes, so it can count them.
 */
export function undoGroup<T>(label: string | ((entries: UndoEntry[]) => string), fn: () => T): T {
  if (groupDepth > 0) {
    groupDepth += 1;
    try {
      return fn();
    } finally {
      groupDepth -= 1;
    }
  }
  groupDepth = 1;
  groupChildren = [];
  groupExternals = [];
  groupToast = false;
  try {
    return fn();
  } finally {
    const children = groupChildren;
    const externals = groupExternals;
    const toast = groupToast;
    groupDepth = 0;
    groupChildren = null;
    groupExternals = null;
    groupToast = false;
    if (children.length > 0) {
      const group = makeGroupEntry(typeof label === "function" ? label(children) : label, children);
      pushEntry(group);
      if (toast) announceRecorded(group);
    }
    if (externals.length === 1) {
      addToHistory(externals[0]!);
      changed();
    } else if (externals.length > 1) {
      addToHistory({ ...externals[0]!, id: newUndoEntryId(), label: typeof label === "function" ? label(externals) : label });
      changed();
    }
  }
}

function makeGroupEntry(label: string, children: UndoEntry[]): UndoEntry {
  const objects: Array<{ store: string; id: string }> = [];
  const seen = new Set<string>();
  for (const child of children) {
    for (const o of child.objects ?? []) {
      const k = `${o.store}\u0000${o.id}`;
      if (!seen.has(k)) {
        seen.add(k);
        objects.push(o);
      }
    }
  }
  const group: UndoEntry = {
    id: newUndoEntryId(),
    label,
    ts: Date.now(),
    status: "done",
    mode: children.every((c) => c.mode === "generic") ? "generic" : "manual",
    children,
    objects,
    // A blind press must not take back a child it would not take back alone.
    ...(children.some((c) => c.confirm) ? { confirm: true } : {}),
    undo: () => {
      // Children undo newest first, each under its own guard: a child sees
      // the state its later siblings' undos leave, which is the state it
      // produced. Rows that conflict are skipped, as in a single entry.
      let applied = 0;
      let skipped = 0;
      let any = false;
      const skippedRows: Array<{ store: string; id: string }> = [];
      const already: UndoEntry[] = [];
      for (const child of [...children].reverse()) {
        if (child.status !== "done") continue;
        const outcome = runClosure(child.undo);
        if (outcome.ok) {
          any = true;
          applied += outcome.applied;
          skipped += outcome.skipped;
          child.status = "undone";
          child.undoneAt = Date.now();
          skippedRows.push(...(child.skipped ?? []));
        } else if (outcome.reason === "already") {
          // Its rows already hold their before values: nothing to take back,
          // and nothing changed since. The group's other children decide
          // whether the press did anything, so its status waits for theirs.
          already.push(child);
        } else {
          child.status = "conflict";
          skipped += 1;
          // The guard's skipped rows name each server row once; objects
          // name every store copy of it.
          skippedRows.push(...(child.skipped?.length ? child.skipped : (child.objects ?? [])));
        }
      }
      group.skipped = skippedRows;
      if (!any) return { ok: false, reason: "conflict" };
      const now = Date.now();
      for (const child of already) {
        child.status = "undone";
        child.undoneAt = now;
      }
      return { ok: true, applied, skipped };
    },
    redo: () => {
      let applied = 0;
      let skipped = 0;
      let any = false;
      for (const child of children) {
        if (child.status !== "undone") continue;
        const outcome = runClosure(child.redo);
        if (outcome.ok) {
          any = true;
          applied += outcome.applied;
          child.status = "done";
          child.undoneAt = undefined;
        } else {
          child.status = "conflict";
          skipped += 1;
        }
      }
      return any ? { ok: true, applied, skipped } : { ok: false, reason: "conflict" };
    },
  };
  return group;
}

function runClosure(fn: () => UndoOutcome | void): UndoOutcome {
  try {
    const outcome = fn();
    return outcome ?? { ok: true, applied: 0, skipped: 0 };
  } catch (error) {
    console.error("[undo] entry failed", error);
    return { ok: false, reason: "gone" };
  }
}

const isStampCell = (c: CellChange) => c.field !== undefined && !!stampFields?.has(c.field);

function cellKey(c: CellChange): string {
  return `${c.store}\u0000${c.id}\u0000${c.field ?? "\u0001"}`;
}

// The calls a coalesced entry merged, in order, each with its own outbox id
// and cells, and the first call's cells (the run's origin). A refusal of one
// call rebuilds the entry from the calls that stood (splitRefusedCall).
type CoalescedCall = { outboxId: string; changes: CellChange[]; label: string; args?: unknown[] };
type CoalescedRun = { origin: CellChange[]; calls: CoalescedCall[] };
const coalescedRuns = new WeakMap<UndoEntry, CoalescedRun>();
// A run that ended where it began leaves the history, but its calls are still
// on the wire. Keyed by each call's outbox id until one is refused (or the
// cap pushes it out), so the refusal can bring the entry back.
// `below` is the history entry it sat on, so it comes back at its own place.
const vanishedRuns = new Map<string, { entry: UndoEntry; run: CoalescedRun; below: UndoEntry | undefined }>();
const VANISHED_RUNS_LIMIT = 200;

// First before, last after; a cell the run took back to where it began is no change.
function mergeRun(origin: CellChange[], laterCalls: CellChange[][], keepUnchanged = false): CellChange[] {
  let merged = origin;
  for (const next of laterCalls) {
    const byKey = new Map(next.map((c) => [cellKey(c), c]));
    const seen = new Set(merged.map(cellKey));
    merged = [
      ...merged.map((c) => {
        const later = byKey.get(cellKey(c));
        return later ? { ...c, after: later.after, hadAfter: later.hadAfter } : c;
      }),
      ...next.filter((c) => !seen.has(cellKey(c))),
    ];
  }
  return keepUnchanged ? merged : merged.filter((c) => c.hadBefore !== c.hadAfter || !sameShape(c.before, c.after));
}

// One call of a coalesced run was refused: the entry keeps the run's origin
// and ends at the last call that stood. Returns false when no call stood.
function splitRefusedCall(entry: UndoEntry, outboxId: string): boolean {
  const run = coalescedRuns.get(entry);
  if (!run || run.calls.length < 2 || !run.calls.some((c) => c.outboxId === outboxId)) return false;
  run.calls = run.calls.filter((c) => c.outboxId !== outboxId);
  entry.outboxIds = entry.outboxIds?.filter((id) => id !== outboxId);
  const merged = mergeRun(run.origin, run.calls.map((c) => c.changes));
  if (!merged.some((c) => !isStampCell(c))) return false;
  const last = run.calls[run.calls.length - 1]!;
  entry.changes = merged;
  entry.objects = objectsOf(merged);
  entry.label = last.label;
  entry.args = last.args;
  return true;
}

// A call of a run that ended where it began was refused: what stands is the
// run without it. When that is a change, the entry comes back at its place in
// the history and on the undo stack, and the entries recorded since are
// rebased onto it.
function restoreVanishedRun(outboxId: string): boolean {
  const vanished = vanishedRuns.get(outboxId);
  if (!vanished) return false;
  const { entry, run } = vanished;
  for (const call of run.calls) vanishedRuns.delete(call.outboxId);
  const standing = run.calls.filter((c) => c.outboxId !== outboxId);
  if (standing.length === 0) return false;
  const origin = withFirstSight(run, entry.changes ?? []);
  const merged = mergeRun(origin.origin, standing.map((c) => origin.calls.find((o) => o.outboxId === c.outboxId)!.changes));
  if (!merged.some((c) => !isStampCell(c))) return false;
  const ended = mergeRun(origin.origin, origin.calls.slice(1).map((c) => c.changes), true);
  reinstateVanished(vanished, { origin: origin.origin, calls: origin.calls.filter((c) => c.outboxId !== outboxId) }, merged);
  // The later entries saw the run end where all its calls left it.
  rebaseRefused(entry, ended, merged);
  return true;
}

// The run's first sight of each cell: the cells its first call wrote, then
// each cell a later call wrote first. Its befores are where the run began.
function firstSight(run: CoalescedRun): CellChange[] {
  const out = [...run.origin];
  const seen = new Set(out.map(cellKey));
  for (const call of run.calls.slice(1)) {
    for (const c of call.changes) {
      if (seen.has(cellKey(c))) continue;
      seen.add(cellKey(c));
      out.push(c);
    }
  }
  return out;
}

// The run with the befores of `sight` (its first sight of each cell, as
// rebased while it was out) put back where each cell first appears.
function withFirstSight(run: CoalescedRun, sight: readonly CellChange[]): CoalescedRun {
  const byKey = new Map(sight.map((c) => [cellKey(c), c] as const));
  const seen = new Set<string>();
  const take = (cells: CellChange[]) =>
    cells.map((c) => {
      const k = cellKey(c);
      if (seen.has(k)) return c;
      seen.add(k);
      const s = byKey.get(k);
      return s ? { ...c, before: s.before, hadBefore: s.hadBefore } : c;
    });
  const origin = take(run.origin);
  return { origin, calls: run.calls.map((call, i) => ({ ...call, changes: i === 0 ? origin : take(call.changes) })) };
}

// Back into the history at its place and onto the undo stack, as `merged`.
function reinstateVanished(
  vanished: { entry: UndoEntry; run: CoalescedRun; below: UndoEntry | undefined },
  run: CoalescedRun,
  merged: CellChange[],
): void {
  const { entry } = vanished;
  for (const call of vanished.run.calls) vanishedRuns.delete(call.outboxId);
  const last = run.calls[run.calls.length - 1]!;
  entry.changes = merged;
  entry.objects = objectsOf(merged);
  entry.label = last.label;
  entry.args = last.args;
  entry.outboxIds = run.calls.map((c) => c.outboxId);
  entry.status = "done";
  coalescedRuns.set(entry, run);
  history.splice(vanishedPlace(history, vanished), 0, entry);
  restoreToStack("undo", entry);
  changed();
}

// A rebase reached a vanished run: where it began moved, so it may no longer
// end there. Then it is a change that stands (its calls write absolute
// values, so the entries above it saw what they left) and it comes back.
function rebaseVanished(entry: UndoEntry): void {
  const vanished = [...vanishedRuns.values()].find((v) => v.entry === entry);
  if (!vanished) return;
  const run = withFirstSight(vanished.run, entry.changes ?? []);
  const merged = mergeRun(run.origin, run.calls.slice(1).map((c) => c.changes));
  if (!merged.some((c) => !isStampCell(c))) {
    vanished.run.origin = run.origin;
    vanished.run.calls = run.calls;
    return;
  }
  reinstateVanished(vanished, run, merged);
}

// Merge a rapid repeat of the top entry's action over the same cells into it:
// first before, last after, last args.
function tryCoalesce(entry: UndoEntry): boolean {
  const top = undoStack[undoStack.length - 1];
  if (!top || top.mode !== "generic" || top.children || top.action !== entry.action) return false;
  if (history[history.length - 1] !== top || redoStack.length > 0) return false;
  if (entry.ts - top.ts > UNDO_COALESCE_WINDOW_MS) return false;
  // The same cells, stamps aside: a stamp restamps on every call, and two
  // calls in one millisecond leave it unchanged, so it never decides a match.
  const prior = top.changes ?? [];
  const next = entry.changes ?? [];
  const keysOf = (cells: CellChange[]) => cells.filter((c) => !isStampCell(c)).map(cellKey);
  const priorKeys = keysOf(prior);
  const nextKeys = new Set(keysOf(next));
  if (priorKeys.length !== nextKeys.size || !priorKeys.every((k) => nextKeys.has(k))) return false;
  // A redo refreshes the entry's cells and outbox id; a run recorded before it is stale.
  const known = coalescedRuns.get(top);
  const fresh = known && top.outboxIds?.includes(known.calls[known.calls.length - 1]!.outboxId);
  const run: CoalescedRun = fresh && known ? known : {
    origin: prior,
    calls: [{ outboxId: top.outboxIds?.[0] ?? "", changes: prior, label: top.label, args: top.args }],
  };
  run.calls.push({ outboxId: entry.outboxIds?.[0] ?? "", changes: next, label: entry.label, args: entry.args });
  const merged = mergeRun(run.origin, run.calls.slice(1).map((c) => c.changes));
  if (!merged.some((c) => !isStampCell(c))) {
    coalescedRuns.delete(top);
    // The run ended where it began: the entry records nothing, as a call
    // that changed no cell never records one.
    remove(undoStack, top);
    history.pop();
    // While it is out, the entry's cells are where the run began, so the
    // rebases that reach it (withVanished) move them.
    top.changes = firstSight(run);
    const vanished = { entry: top, run, below: history[history.length - 1] };
    for (const call of run.calls) if (call.outboxId) vanishedRuns.set(call.outboxId, vanished);
    while (vanishedRuns.size > VANISHED_RUNS_LIMIT) vanishedRuns.delete(vanishedRuns.keys().next().value!);
    changed();
    return true;
  }
  coalescedRuns.set(top, run);
  top.changes = merged;
  top.objects = objectsOf(merged);
  top.args = entry.args;
  top.label = entry.label;
  top.ts = entry.ts;
  top.planted = { ...(top.planted ?? {}), ...(entry.planted ?? {}) };
  top.outboxIds = [...(top.outboxIds ?? []), ...(entry.outboxIds ?? [])];
  changed();
  return true;
}

function announceRecorded(entry: UndoEntry): void {
  if (notifier.notifyWithUndo) notifier.notifyWithUndo(entry.label, entry.id);
  else notifier.notify(entry.label);
}

/**
 * Record a captured entry: into the open group, merged into the top entry
 * (coalesce), or onto the stack. External entries are history only.
 */
export function recordUndoEntry(entry: UndoEntry, opts?: { toast?: boolean; coalesce?: boolean }): void {
  if (recordingHolds > 0) return;
  if (entry.status === "external") {
    if (groupExternals) {
      groupExternals.push(entry);
      return;
    }
    addToHistory(entry);
    changed();
    return;
  }
  if (groupChildren) {
    groupChildren.push(entry);
    if (opts?.toast) groupToast = true;
    return;
  }
  if (opts?.coalesce && tryCoalesce(entry)) return;
  pushEntry(entry);
  if (opts?.toast) announceRecorded(entry);
}

/** A hand-written entry (mode "manual"). Returns its id. */
export function pushUndo(entry: Omit<UndoEntry, "id" | "ts" | "status" | "mode">): string {
  const full: UndoEntry = { ...entry, id: newUndoEntryId(), ts: Date.now(), status: "done", mode: "manual" };
  if (recordingHolds > 0) return full.id;
  if (groupChildren) {
    groupChildren.push(full);
    return full.id;
  }
  pushEntry(full);
  return full.id;
}

// ---------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------

/**
 * When a done entry's keyboard window opened: its record, or the redo that
 * last put it back, since a redo is a fresh gesture and the entry it put
 * back is as reachable as one just recorded.
 */
export function undoKeyboardSince(entry: { ts: number; redoneAt?: number }): number {
  return Math.max(entry.ts, entry.redoneAt ?? 0);
}

function expired(entry: UndoEntry, now: number): boolean {
  return now - undoKeyboardSince(entry) > keyboardWindowMs;
}

function redoExpired(entry: UndoEntry, now: number): boolean {
  return now - (entry.undoneAt ?? entry.ts) > keyboardWindowMs;
}

// A manual entry is blind (a closure over a snapshot), so it never outlives
// the keyboard window anywhere. Generic entries stay reachable from the
// timeline, guarded.
function pruneExpiredManual(now: number): void {
  const before = undoStack.length + redoStack.length;
  undoStack = undoStack.filter((e) => e.mode !== "manual" || !expired(e, now));
  redoStack = redoStack.filter((e) => e.mode !== "manual" || !redoExpired(e, now));
  if (undoStack.length + redoStack.length !== before) changed();
}

// Gestures whose store write waits on something before it runs (a row's exit
// animation). Until it runs nothing records it, yet it is the newest thing the
// user did: a walk that arrived in the wait would take back an older entry,
// and the gesture landing afterwards would drop that entry's redo.
const pendingGestures = new Set<() => void>();

/**
 * Register a gesture whose write runs later. Returns `commit`, which runs it
 * once: call it when the wait ends. Every walk (a press, a toast's undo, a
 * history click) commits pending gestures first, so it takes them back.
 */
export function deferUndoGesture(commit: () => void): () => void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    pendingGestures.delete(run);
    commit();
  };
  pendingGestures.add(run);
  return run;
}

/** Run every gesture still waiting, oldest first. Each walk calls it before it reads the stacks. */
export function commitPendingUndoGestures(): void {
  for (const run of [...pendingGestures]) {
    try {
      run();
    } catch (error) {
      console.error("[undo] deferred gesture failed", error);
    }
  }
}

type StepResult = { ok: true; entry: UndoEntry } | { ok: false; entry: UndoEntry };

// The order undo steps ran in, so a refused replay can find the steps that
// came after it (and judged against its value) wherever they sit now: still
// undone, or dropped by a gesture.
const undoSeq = new WeakMap<UndoEntry, number>();
let undoSeqCounter = 0;

function stepUndo(entry: UndoEntry): StepResult {
  const outcome = runClosure(entry.undo);
  remove(undoStack, entry);
  if (!outcome.ok) {
    entry.status = "conflict";
    changed();
    return { ok: false, entry };
  }
  undoSeqCounter += 1;
  undoSeq.set(entry, undoSeqCounter);
  entry.status = "undone";
  entry.undoneAt = Date.now();
  redoStack.push(entry);
  changed();
  return { ok: true, entry };
}

function stepRedo(entry: UndoEntry): StepResult {
  const outcome = runClosure(entry.redo);
  remove(redoStack, entry);
  if (!outcome.ok) {
    entry.status = "conflict";
    changed();
    return { ok: false, entry };
  }
  entry.status = "done";
  entry.undoneAt = undefined;
  entry.redoneAt = Date.now();
  undoStack.push(entry);
  changed();
  return { ok: true, entry };
}

function announceStep(kind: "undo" | "redo", steps: number, entry: UndoEntry): void {
  if (steps === 0) return;
  if (notifier.onHistoryStep) {
    notifier.onHistoryStep(kind, steps, entry);
    return;
  }
  const verb = kind === "undo" ? "Undid" : "Redid";
  // A redo after a partial undo leaves the same rows, so it says so too.
  const partial = entry.skipped?.length
    ? ` (${entry.skipped.length} changed since, left as they are)`
    : "";
  notifier.notify(steps > 1 ? `${verb} ${steps} changes` : `${verb}: ${entry.label}${partial}`);
}

function announceConflict(kind: "undo" | "redo", entry: UndoEntry): void {
  notifier.notify(`Can't ${kind} ${entry.label}: changed since`);
}

/**
 * Keyboard undo: the top entry, if it is inside the keyboard window. A
 * `confirm` entry is never taken back blind: the press names it and stops
 * there, so its toast or the history is the only way to undo it. Reaching
 * under it would take back an older change the user did not aim at.
 */
export function performUndo(): boolean {
  commitPendingUndoGestures();
  const now = Date.now();
  pruneExpiredManual(now);
  const top = undoStack[undoStack.length - 1];
  if (!top || expired(top, now)) return false;
  if (top.confirm) {
    const message = `Undo ${top.label} from its toast or the history`;
    if (notifier.onConfirmStop) notifier.onConfirmStop(top, message);
    else notifier.notify(message);
    return true;
  }
  const step = stepUndo(top);
  if (step.ok) announceStep("undo", 1, top);
  else announceConflict("undo", top);
  return true;
}

/** Keyboard redo: the top undone entry, if it was undone inside the keyboard window. */
export function performRedo(): boolean {
  commitPendingUndoGestures();
  const now = Date.now();
  pruneExpiredManual(now);
  const entry = redoStack[redoStack.length - 1];
  if (!entry || redoExpired(entry, now)) return false;
  const step = stepRedo(entry);
  if (step.ok) announceStep("redo", 1, entry);
  else announceConflict("redo", entry);
  return true;
}

/**
 * Undo one named entry (a toast's own). On top, it is a normal undo; below
 * the top it is a selective undo of that entry alone, under the same guard.
 * A manual entry can only be undone from the top.
 */
export function undoEntry(id: string): boolean {
  commitPendingUndoGestures();
  const now = Date.now();
  pruneExpiredManual(now);
  const at = undoStack.findIndex((e) => e.id === id);
  if (at === -1) return false;
  const entry = undoStack[at]!;
  if (expired(entry, now)) return false;
  if (entry.mode === "manual" && at !== undoStack.length - 1) {
    notifier.notify(`Can't undo ${entry.label}: newer changes came after it`);
    return false;
  }
  const step = stepUndo(entry);
  if (step.ok) announceStep("undo", 1, entry);
  else announceConflict("undo", entry);
  return step.ok;
}

/**
 * Undo from the top down to and including `id`, one step at a time,
 * stopping at the first conflict. One notification for the whole walk.
 * Explicit, so a generic entry past the keyboard window is still reachable.
 */
export function undoTo(id: string): number {
  commitPendingUndoGestures();
  const now = Date.now();
  pruneExpiredManual(now);
  if (!undoStack.some((e) => e.id === id)) return 0;
  let steps = 0;
  let last: UndoEntry | null = null;
  while (undoStack.length > 0) {
    const entry = undoStack[undoStack.length - 1]!;
    const step = stepUndo(entry);
    if (!step.ok) {
      if (last) announceStep("undo", steps, last);
      announceConflict("undo", entry);
      return steps;
    }
    steps += 1;
    last = entry;
    if (entry.id === id) break;
  }
  if (last) announceStep("undo", steps, last);
  return steps;
}

/** Redo from the top of the redo stack up to and including `id`. */
export function redoTo(id: string): number {
  commitPendingUndoGestures();
  const now = Date.now();
  pruneExpiredManual(now);
  if (!redoStack.some((e) => e.id === id)) return 0;
  let steps = 0;
  let last: UndoEntry | null = null;
  while (redoStack.length > 0) {
    const entry = redoStack[redoStack.length - 1]!;
    const step = stepRedo(entry);
    if (!step.ok) {
      if (last) announceStep("redo", steps, last);
      announceConflict("redo", entry);
      return steps;
    }
    steps += 1;
    last = entry;
    if (entry.id === id) break;
  }
  if (last) announceStep("redo", steps, last);
  return steps;
}

/** Show `label` with an Undo affordance for the newest entry (a hand-written gesture's toast). */
export function showUndoToast(label: string): void {
  const top = undoStack[undoStack.length - 1];
  if (top && notifier.notifyWithUndo) notifier.notifyWithUndo(label, top.id);
  else notifier.notify(label);
}

export function canUndo(): boolean {
  // A waiting gesture records when the walk commits it.
  if (pendingGestures.size > 0) return true;
  const now = Date.now();
  pruneExpiredManual(now);
  const top = undoStack[undoStack.length - 1];
  return !!top && !expired(top, now);
}

export function canRedo(): boolean {
  // A waiting gesture drops the redo branch when the walk commits it.
  if (pendingGestures.size > 0) return false;
  const now = Date.now();
  pruneExpiredManual(now);
  const top = redoStack[redoStack.length - 1];
  return !!top && !redoExpired(top, now);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function toItem(entry: UndoEntry): UndoHistoryItem {
  const { undo: _u, redo: _r, children, replaySent: _s, supersededReplay: _p, replayDeferred: _d, priorOutboxIds: _o, forwardRefused: _f, lapsedDeferred: _l, ...rest } = entry;
  return children ? { ...rest, children: children.map(toItem) } : { ...rest };
}

/** The history, newest first. The same reference until something changes. */
export function getUndoHistory(): UndoHistorySnapshot {
  if (!snapshot) {
    snapshot = {
      version,
      items: history.slice().reverse().map(toItem),
      head: undoStack[undoStack.length - 1]?.id ?? null,
      undoOrder: undoStack.map((e) => e.id).reverse(),
      redoOrder: redoStack.map((e) => e.id).reverse(),
    };
  }
  return snapshot;
}

export function subscribeUndoHistory(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---------------------------------------------------------------------------
// Refusal and rekey (called by the middleware and the sync engine)
// ---------------------------------------------------------------------------

// Children a refusal took out of their group while a replay they overtook was
// still findable (supersededReplay): a refusal of that replay can still bring
// them back, so the refusal walk keeps reaching them. `at` is where they sat.
const detachedChildren = new Map<UndoEntry, { parent: UndoEntry; at: number }>();
const DETACHED_CHILDREN_LIMIT = 200;

function* allEntries(): Generator<{ entry: UndoEntry; parent: UndoEntry | null }> {
  const seen = new Set<UndoEntry>();
  for (const list of [history, undoStack, redoStack]) {
    for (const entry of list) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      yield { entry, parent: null };
      for (const child of entry.children ?? []) yield { entry: child, parent: entry };
    }
  }
  for (const [child, { parent }] of [...detachedChildren]) if (!seen.has(child)) yield { entry: child, parent };
}

// An undone entry whose undo replay went out: that replay carried the entry's
// before as it stood then, and is what the server holds unless it is refused.
const replayOut = (e: UndoEntry) =>
  (e.status === "undone" || e.status === "dropped") && e.replayDir === "undo" && !!e.replaySent;

/** Moves from cells: each from its `before` to its `after`. */
const movesOf = (cells: readonly CellChange[]) =>
  new Map(cells.map((c) => [cellKey(c), { from: { after: c.before, hadAfter: c.hadBefore }, to: { after: c.after, hadAfter: c.hadAfter } }] as const));

// A refused write never landed: each cell `was` wrote now stands where `now`
// leaves it (a split run's last standing call), or back at its before when
// `now` no longer writes it. The entries recorded after `entry` recorded the
// refused after as their before, and are rebased onto what stands. An entry
// already undone with its replay out is not: that replay sent the refused
// value as its before, so the move waits on the replay (replayDeferred).
function rebaseRefused(entry: UndoEntry, was: readonly CellChange[], now: readonly CellChange[]): void {
  const nowByKey = new Map(now.map((c) => [cellKey(c), c] as const));
  const moved = new Map<string, UndoCellMove>();
  for (const c of was) {
    const stands = nowByKey.get(cellKey(c));
    const to = stands ? { after: stands.after, hadAfter: stands.hadAfter } : { after: c.before, hadAfter: c.hadBefore };
    if (to.hadAfter === c.hadAfter && sameShape(to.after, c.after)) continue;
    moved.set(cellKey(c), { from: { after: c.after, hadAfter: c.hadAfter }, to });
  }
  if (moved.size > 0) rebaseUndoCells(recordedAfter(entry), moved, replayOut);
}

// A refused replay never reached the server, so the entries that used its
// value are rebased onto what it held. `replayed` is the entry whose replay was
// refused (a group's child, or the entry itself) and `owner` what goes back on
// a stack with it.
//
// Undo: the replay wrote each cell's before value; the cell stands at the
// entry's after value instead, unless a later step of the walk wrote it. A
// later step that judged the replay's value as its after wrote its own before
// value, and so on down the walk: the entry's before becomes the value the
// last of them left, which is what stands. A gesture recorded after the entry
// saw the replay's value as its before, where the server held the after value.
//
// Redo (a partial redo's replay of the after values): the cells stand at the
// before values, and every entry recorded after it, the walk's later redos
// included, saw the after value as its before.
//
// An undo replay whose every cell a later step of the walk wrote over returns
// those steps: the value it wrote over does not come back on screen while
// their replays stand, so its entry stays undone (coveredBy). Otherwise null.
function rebaseRefusedReplay(replayed: UndoEntry, owner: UndoEntry, dir: "undo" | "redo"): Set<UndoEntry> | null {
  // What the replay carried: `before` written over `after`. An entry from
  // before replays kept that falls back on its cells.
  const flip = (c: CellChange): CellChange => ({ ...c, before: c.after, hadBefore: c.hadAfter, after: c.before, hadAfter: c.hadBefore });
  const sent = (replayed.replaySent ?? (dir === "undo" ? replayed.changes : replayed.changes?.map(flip)) ?? [])
    .filter((c) => !isStampCell(c));
  const deferred = replayed.replayDeferred;
  replayed.replaySent = undefined;
  replayed.replayDeferred = undefined;
  if (sent.length === 0) return null;
  const toLater = new Map<string, UndoCellMove>();
  if (dir === "redo") {
    for (const c of sent) {
      toLater.set(cellKey(c), { from: { after: c.before, hadAfter: c.hadBefore }, to: { after: c.after, hadAfter: c.hadAfter } });
    }
    rebaseUndoCells(recordedAfter(replayed), toLater);
    return null;
  }
  // The walk's later steps: every entry undone after the owner whose own
  // undo replay went out, even one whose forward was refused since (its
  // replay still wrote), judged by what that replay carried.
  const since = undoSeq.get(owner) ?? Infinity;
  const sentOut = (e: UndoEntry) =>
    e.status === "undone" || e.status === "dropped" || (e.status === "refused" && e.replayDir === "undo" && !!e.replaySent);
  const steps: UndoEntry[] = [];
  for (const { entry, parent } of allEntries()) {
    if (parent || entry === owner) continue;
    const seq = undoSeq.get(entry);
    if (seq === undefined || seq <= since || !sentOut(entry)) continue;
    steps.push(entry);
  }
  steps.sort((a, b) => undoSeq.get(a)! - undoSeq.get(b)!);
  // A group's children undo newest first, so the replayed child's older
  // siblings came after it in the same step.
  const siblings = owner.children ? owner.children.slice(0, owner.children.indexOf(replayed)).reverse() : [];
  const walk = [
    ...siblings.map((step) => ({ step, by: owner })),
    ...steps.flatMap((e) => (e.children ? [...e.children].reverse() : [e]).map((step) => ({ step, by: e }))),
  ];
  const own = new Map<string, UndoCellMove>();
  const covering = new Set<UndoEntry>();
  for (const c of sent) {
    let value = { after: c.before, hadAfter: c.hadBefore };
    for (const { step, by } of walk) {
      if (!sentOut(step)) continue;
      // `after` is what a step's replay wrote over, `before` what it wrote.
      const hit = (step.replaySent ?? step.changes)?.find((s) => cellKey(s) === cellKey(c));
      if (!hit || hit.hadAfter !== value.hadAfter || !sameShape(hit.after, value.after)) continue;
      value = { after: hit.before, hadAfter: hit.hadBefore };
      if (by !== owner) covering.add(by);
    }
    const from = { after: c.before, hadAfter: c.hadBefore };
    if (value.hadAfter !== from.hadAfter || !sameShape(value.after, from.after)) own.set(cellKey(c), { from, to: value });
    else toLater.set(cellKey(c), { from, to: { after: c.after, hadAfter: c.hadAfter } });
  }
  if (own.size > 0) rebaseUndoCells([replayed], own);
  // A refused forward under the entry waited on this replay: it applies now,
  // where the walk left the cell at what the replay sent.
  if (deferred?.length) rebaseUndoCells([replayed], movesOf(deferred));
  if (toLater.size > 0) rebaseUndoCells(recordedAfter(replayed), toLater);
  return toLater.size === 0 && covering.size > 0 ? covering : null;
}

// Entries left undone by a refused undo replay because later steps of the
// walk wrote every cell over (rebaseRefusedReplay), by covering step. When a
// covering step's own replay is refused too, the cells roll back past both
// and the entry's value is on screen again: it goes back to be undone.
const coveredBy = new WeakMap<UndoEntry, UndoEntry[]>();

function releaseCovered(step: UndoEntry): boolean {
  const owners = coveredBy.get(step);
  if (!owners) return false;
  coveredBy.delete(step);
  let touched = false;
  for (const owner of owners) {
    if ((owner.status !== "undone" && owner.status !== "dropped") || undoStack.includes(owner)) continue;
    remove(redoStack, owner);
    owner.droppedBy = undefined;
    owner.status = "done";
    owner.undoneAt = undefined;
    restoreToStack("undo", owner);
    touched = true;
  }
  return touched;
}

/**
 * The server refused the dispatch with this outbox id for good. A forward
 * capture (or a redo) that named it is marked refused and leaves both stacks.
 * An undo's own refused dispatch puts its entry back on the undo stack: its
 * locks roll back through the middleware's refusal path.
 */
export function markUndoOutboxRefused(outboxId: string): void {
  let touched = false;
  for (const { entry, parent } of allEntries()) {
    // A refused forward under the entry waited on this replay, which a later
    // step superseded: that step recorded the replay's value as its before.
    const lapsed = entry.lapsedDeferred?.find((l) => l.ids.includes(outboxId));
    if (lapsed) {
      entry.lapsedDeferred = entry.lapsedDeferred!.filter((l) => l !== lapsed);
      if (rebaseUndoCells([entry], movesOf(lapsed.moves))) touched = true;
    }
    if (entry.outboxIds?.includes(outboxId)) {
      touched = true;
      // The entries recorded after this one saw its after values as their
      // befores; what stands now is what the server held (rebaseRefused).
      const was = entry.changes ?? [];
      // A coalesced run stays undoable down to the calls that landed.
      if (splitRefusedCall(entry, outboxId)) {
        rebaseRefused(entry, was, entry.changes ?? []);
        continue;
      }
      // A redo replay of the entry is out, re-sending the after values of the
      // cells it covers: those stand on it, so their refusal waits beside it
      // (forwardRefused) and applies only if it is refused too. The cells it
      // does not cover never landed.
      if (entry.status === "done" && entry.replayDir === "redo" && entry.replaySent?.length) {
        const covered = new Set(entry.replaySent.map(cellKey));
        rebaseRefused(entry, was.filter((c) => !covered.has(cellKey(c))), []);
        entry.outboxIds = entry.outboxIds.filter((id) => id !== outboxId);
        entry.forwardRefused = true;
        continue;
      }
      rebaseRefused(entry, was, []);
      refuseEntry(entry, parent);
    } else if (entry.priorOutboxIds?.includes(outboxId)) {
      // A forward a redo's re-invoke has replaced: what stands is the
      // re-invoke's, unless it rolls back past the undo replay it overtook.
      entry.priorOutboxIds = entry.priorOutboxIds.filter((id) => id !== outboxId);
      entry.forwardRefused = true;
    } else if (entry.supersededReplay?.ids.includes(outboxId)) {
      const { dir } = entry.supersededReplay;
      entry.supersededReplay = undefined;
      if (restoreSuperseded(entry, dir, parent)) touched = true;
    } else if (entry.replayOutboxIds?.includes(outboxId)) {
      // A refused replay sends its owner back off the stack the replay put
      // it on. A replay of several passes can be refused once per pass;
      // only the first moves it, so a later one cannot flip it back.
      // A group's children are refused one by one: each refused child goes
      // back with its owner even when an earlier child already moved it.
      const owner = parent ?? entry;
      if (entry.replayDir === "undo") {
        // The walk's later steps and any gesture since judged the replay's value.
        // Once per entry: a replay of several passes is refused once per pass.
        if (entry.status !== "done" && entry.replaySent) {
          const covering = rebaseRefusedReplay(entry, owner, "undo");
          // Cells the walk's later steps wrote over stay where they left them,
          // so the entry stays undone until one of those replays is refused.
          if (covering && !parent) {
            for (const step of covering) coveredBy.set(step, [...(coveredBy.get(step) ?? []), owner]);
            if (releaseCovered(owner)) touched = true;
            continue;
          }
        }
        if (releaseCovered(owner)) touched = true;
        // A gesture recorded while the replay was on the wire dropped the
        // redo branch. The forward value comes back on screen all the same,
        // so its entry must come back with it.
        if (remove(redoStack, owner) || (owner.status === "dropped" && !undoStack.includes(owner))) {
          owner.droppedBy = undefined;
          touched = true;
          owner.status = "done";
          owner.undoneAt = undefined;
          restoreToStack("undo", owner);
        }
        if (parent && entry.status !== "done" && undoStack.includes(owner)) {
          touched = true;
          entry.status = "done";
          entry.undoneAt = undefined;
        }
      } else if (entry.replayDir === "redo") {
        if (entry.status !== "undone" && entry.replaySent) rebaseRefusedReplay(entry, owner, "redo");
        // The forward under this redo was refused too: nothing landed.
        if (entry.forwardRefused && entry.status !== "refused") {
          touched = true;
          refuseEntry(entry, parent);
          continue;
        }
        if (remove(undoStack, owner)) {
          touched = true;
          owner.status = "undone";
          owner.undoneAt = Date.now();
          restoreToStack("redo", owner);
        }
        if (parent && entry.status !== "undone" && redoStack.includes(owner)) {
          touched = true;
          entry.status = "undone";
          entry.undoneAt = Date.now();
        }
      }
    }
  }
  if (!touched && restoreVanishedRun(outboxId)) touched = true;
  if (touched) changed();
}

// Nothing of the entry landed: it is refused and leaves both stacks. A group
// child leaves its group (findable while a replay it overtook can still bring
// it back), and a group with no child left is refused with it.
function refuseEntry(entry: UndoEntry, parent: UndoEntry | null): void {
  entry.status = "refused";
  if (!parent) {
    remove(undoStack, entry);
    remove(redoStack, entry);
    return;
  }
  if (entry.supersededReplay) {
    detachedChildren.set(entry, { parent, at: parent.children!.indexOf(entry) });
    while (detachedChildren.size > DETACHED_CHILDREN_LIMIT) detachedChildren.delete(detachedChildren.keys().next().value!);
  }
  parent.children = parent.children!.filter((c) => c !== entry);
  if (parent.children.length === 0) {
    parent.status = "refused";
    remove(undoStack, parent);
    remove(redoStack, parent);
  }
}

// A later step of `entry` overtook the replay `sup` names, was refused, and
// rolled back past that replay's dropped send: neither landed, so the cells
// stand where they stood before that replay. An undo replay's entry is done
// again, a redo replay's undone again. The step's refusal rebased the entries
// recorded after it onto the value this replay would have written; they go
// back to the value that stands.
//
// A group's child goes back with its owner, as a child's refused replay does:
// it rejoins the group where it sat if a refusal took it out, and the owner
// goes to the stack the child's status needs.
function restoreSuperseded(entry: UndoEntry, dir: "undo" | "redo", parent: UndoEntry | null = null): boolean {
  const target = dir === "undo" ? "done" : "undone";
  const onStack = dir === "undo" ? undoStack : redoStack;
  const owner = parent ?? entry;
  const detached = detachedChildren.get(entry);
  detachedChildren.delete(entry);
  // The undo replay wrote over a forward that was refused: what stood before
  // it is the entry's before value, so the entry stays refused.
  if (dir === "undo" && entry.forwardRefused) return false;
  if (entry.status === target && onStack.includes(owner)) return false;
  if (parent && detached && !parent.children!.includes(entry)) {
    parent.children!.splice(Math.min(detached.at, parent.children!.length), 0, entry);
  }
  const cells = (entry.changes ?? []).filter((c) => !isStampCell(c));
  const toLater = new Map<string, UndoCellMove>();
  for (const c of cells) {
    const [from, to] = dir === "undo"
      ? [{ after: c.before, hadAfter: c.hadBefore }, { after: c.after, hadAfter: c.hadAfter }]
      : [{ after: c.after, hadAfter: c.hadAfter }, { after: c.before, hadAfter: c.hadBefore }];
    toLater.set(cellKey(c), { from, to });
  }
  if (toLater.size > 0) rebaseUndoCells(recordedAfter(entry), toLater);
  for (const e of parent ? [entry, owner] : [entry]) {
    e.droppedBy = undefined;
    e.status = target;
    e.undoneAt = dir === "undo" ? undefined : Date.now();
  }
  if (!onStack.includes(owner)) {
    remove(undoStack, owner);
    remove(redoStack, owner);
    restoreToStack(dir, owner);
  }
  return true;
}

const rekeyPendingKey = (key: string, oldId: string, newId: string): string => {
  const parts = key.split(":");
  return parts.map((p) => (p === oldId ? newId : p)).join(":");
};

/**
 * `value` with every mention of `oldId` moved to `newId`, at any depth: a
 * string equal to it, and an object key equal to it (a table keyed by row id,
 * a map from row id to a sort key). A row whose own `_id` is the stub moves
 * the way syncEngine moves it: its `_id` follows, and any other top-level
 * field that holds the stub (its alt key, `client_id`) stays. The same
 * reference comes back when nothing names the id.
 */
export function rekeyIds<T>(value: T, oldId: string, newId: string): T {
  if (value === oldId) return newId as T;
  if (Array.isArray(value)) {
    const next = value.map((v) => rekeyIds(v, oldId, newId));
    return (next.some((v, i) => v !== value[i]) ? next : value) as T;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const own = (value as { _id?: unknown })._id === oldId;
    let moved = false;
    const entries = Object.entries(value).map(([k, v]): [string, unknown] => {
      const key = k === oldId ? newId : k;
      const next = own && k !== "_id" && v === oldId ? v : rekeyIds(v, oldId, newId);
      if (key !== k || next !== v) moved = true;
      return [key, next];
    });
    return (moved ? Object.fromEntries(entries) : value) as T;
  }
  return value;
}

/**
 * Cells naming `oldId`, moved to `newId`; the same array when none does. The
 * values follow too, a whole row's as well as a field's (a parent pointer or a
 * bucket id the app's rekeyExtra rewrites), so the guard compares them with
 * the rewritten row and a restored row comes back pointing at the server id.
 */
export function rekeyCells(cells: CellChange[], oldId: string, newId: string): CellChange[] {
  let moved = false;
  const out = cells.map((c) => {
    const id = c.id === oldId ? newId : c.id;
    const before = rekeyIds(c.before, oldId, newId);
    const after = rekeyIds(c.after, oldId, newId);
    if (id === c.id && before === c.before && after === c.after) return c;
    moved = true;
    return { ...c, id, before, after };
  });
  return moved ? out : cells;
}

// State an owner keeps outside the entry (the controller's inverse and
// applied cells) follows a rekey through these. A hook returns whether it
// changed anything.
const rekeyHooks = new Set<(entry: UndoEntry, oldId: string, newId: string) => boolean>();
export function onUndoRekey(hook: (entry: UndoEntry, oldId: string, newId: string) => boolean): () => void {
  rekeyHooks.add(hook);
  return () => {
    rekeyHooks.delete(hook);
  };
}

/** A stub row was superseded by its server row: follow it in live entries. */
export function rekeyUndoIds(oldId: string, newId: string): void {
  if (oldId === newId) return;
  let touched = false;
  // A vanished run can still come back (restoreVanishedRun), so it follows too.
  const vanished = new Set([...vanishedRuns.values()].map((v) => v.entry));
  for (const { entry } of [...allEntries(), ...[...vanished].map((entry) => ({ entry }))]) {
    for (const list of ["changes", "replaySent", "replayDeferred"] as const) {
      const cells = entry[list];
      if (!cells) continue;
      const next = rekeyCells(cells, oldId, newId);
      if (next !== cells) {
        entry[list] = next;
        touched = true;
      }
    }
    for (const hook of rekeyHooks) if (hook(entry, oldId, newId)) touched = true;
    for (const list of ["objects", "skipped"] as const) {
      const objs = entry[list];
      if (objs?.some((o) => o.id === oldId)) {
        entry[list] = objs.map((o) => (o.id === oldId ? { ...o, id: newId } : o));
        touched = true;
      }
    }
    if (entry.planted && Object.keys(entry.planted).some((k) => k.split(":").includes(oldId))) {
      entry.planted = Object.fromEntries(
        Object.entries(entry.planted).map(([k, v]) => [rekeyPendingKey(k, oldId, newId), v]),
      );
      touched = true;
    }
    if (entry.args) {
      const args = rekeyIds(entry.args, oldId, newId);
      if (args !== entry.args) {
        entry.args = args;
        touched = true;
      }
    }
    // The run a coalesced entry keeps beside it rebuilds the entry on a
    // refusal and merges the next call; it must name the row the entry names.
    const run = coalescedRuns.get(entry);
    if (run) {
      run.origin = rekeyCells(run.origin, oldId, newId);
      run.calls = run.calls.map((c) => {
        const changes = rekeyCells(c.changes, oldId, newId);
        const args = c.args ? rekeyIds(c.args, oldId, newId) : c.args;
        return changes === c.changes && args === c.args ? c : { ...c, changes, args };
      });
    }
  }
  if (touched) changed();
}

const resetListeners = new Set<() => void>();

/**
 * Called when the history is reset: anything outside the stacks that holds a
 * reset history's state (a controller's send order, a toast, an open card)
 * drops it here. Returns the unsubscribe.
 */
export function onUndoReset(fn: () => void): () => void {
  resetListeners.add(fn);
  return () => {
    resetListeners.delete(fn);
  };
}

/**
 * Forget every entry, as at an account boundary: the history belongs to the
 * principal that made it, and replaying it under another would write the old
 * account's rows into the new one's store and send them as the new one. A
 * group or suppression already running keeps its own bookkeeping; only what
 * it recorded so far goes.
 */
export function resetUndoHistory(): void {
  vanishedRuns.clear();
  undoStack = [];
  redoStack = [];
  history = [];
  if (groupChildren) groupChildren = [];
  if (groupExternals) groupExternals = [];
  for (const fn of [...resetListeners]) {
    try {
      fn();
    } catch (error) {
      console.error("[undo] reset listener failed", error);
    }
  }
  changed();
}

/** One window's undo state: everything a browser window keeps of its own. */
type UndoWindowSlots = {
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  history: UndoEntry[];
  version: number;
  snapshot: UndoHistorySnapshot | null;
  suppressDepth: number;
  refreshTarget: UndoEntry | null;
  groupDepth: number;
  groupChildren: UndoEntry[] | null;
  groupToast: boolean;
  groupExternals: UndoEntry[] | null;
  recordingHolds: number;
};

/**
 * Test seam for a harness that runs several windows in one process (the
 * codecast multiplayer sim): each browser window keeps its own history, so the
 * harness saves this state after a window's turn and loads it before the
 * next. Arrays are copied, so a saved slot never aliases the live stacks.
 * Configuration, the notifier, listeners and the id counter stay one per
 * process (set once at load; ids only need to be unique).
 */
export function __undoStackWindowSlots(): { get(): object; set(s: object): void; fresh(): object } {
  // Lists are copied; anything else a harness hands in passes as it is.
  const list = <T>(x: T): T => (Array.isArray(x) ? ([...x] as T) : x);
  const copy = (s: UndoWindowSlots): UndoWindowSlots => ({
    ...s,
    undoStack: list(s.undoStack),
    redoStack: list(s.redoStack),
    history: list(s.history),
    groupChildren: list(s.groupChildren),
    groupExternals: list(s.groupExternals),
  });
  return {
    fresh: (): UndoWindowSlots => ({
      undoStack: [],
      redoStack: [],
      history: [],
      version: 0,
      snapshot: null,
      suppressDepth: 0,
      refreshTarget: null,
      groupDepth: 0,
      groupChildren: null,
      groupToast: false,
      groupExternals: null,
      recordingHolds: 0,
    }),
    get: (): UndoWindowSlots =>
      copy({ undoStack, redoStack, history, version, snapshot, suppressDepth, refreshTarget, groupDepth, groupChildren, groupToast, groupExternals, recordingHolds }),
    set: (raw: object) => {
      const s = copy(raw as UndoWindowSlots);
      ({ undoStack, redoStack, history, version, snapshot, suppressDepth, refreshTarget, groupDepth, groupChildren, groupToast, groupExternals, recordingHolds } = s);
    },
  };
}

/** Test hook: the stacks live at module scope and would leak across tests. */
export function _resetUndoStacks(): void {
  pendingGestures.clear();
  vanishedRuns.clear();
  undoStack = [];
  redoStack = [];
  history = [];
  suppressDepth = 0;
  recordingHolds = 0;
  refreshTarget = null;
  groupDepth = 0;
  groupChildren = null;
  groupExternals = null;
  groupToast = false;
  changed();
}
