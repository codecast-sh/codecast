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

export function isUndoSuppressed(): boolean {
  return suppressDepth > 0;
}

/** The entry a redo is refreshing, so its capture rewrites that entry instead of pushing. */
export function undoRefreshTarget(): UndoEntry | null {
  return refreshTarget;
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
  groupToast = false;
  try {
    return fn();
  } finally {
    const children = groupChildren;
    const toast = groupToast;
    groupDepth = 0;
    groupChildren = null;
    groupToast = false;
    if (children.length > 0) {
      const group = makeGroupEntry(typeof label === "function" ? label(children) : label, children);
      pushEntry(group);
      if (toast) announceRecorded(group);
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

// First before, last after; a cell the run took back to where it began is no change.
function mergeRun(origin: CellChange[], laterCalls: CellChange[][]): CellChange[] {
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
  return merged.filter((c) => c.hadBefore !== c.hadAfter || !sameShape(c.before, c.after));
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
  if (entry.status === "external") {
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

function expired(entry: UndoEntry, now: number): boolean {
  return now - entry.ts > keyboardWindowMs;
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

type StepResult = { ok: true; entry: UndoEntry } | { ok: false; entry: UndoEntry };

function stepUndo(entry: UndoEntry): StepResult {
  const outcome = runClosure(entry.undo);
  remove(undoStack, entry);
  if (!outcome.ok) {
    entry.status = "conflict";
    changed();
    return { ok: false, entry };
  }
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
  const now = Date.now();
  pruneExpiredManual(now);
  const top = undoStack[undoStack.length - 1];
  return !!top && !expired(top, now);
}

export function canRedo(): boolean {
  const now = Date.now();
  pruneExpiredManual(now);
  const top = redoStack[redoStack.length - 1];
  return !!top && !redoExpired(top, now);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function toItem(entry: UndoEntry): UndoHistoryItem {
  const { undo: _u, redo: _r, children, ...rest } = entry;
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
    if (entry.outboxIds?.includes(outboxId)) {
      touched = true;
      // A coalesced run stays undoable down to the calls that landed.
      if (splitRefusedCall(entry, outboxId)) continue;
      entry.status = "refused";
      if (parent) {
        parent.children = parent.children!.filter((c) => c !== entry);
        if (parent.children.length === 0) {
          parent.status = "refused";
          remove(undoStack, parent);
          remove(redoStack, parent);
        }
      } else {
        remove(undoStack, entry);
        remove(redoStack, entry);
      }
    } else if (entry.replayOutboxIds?.includes(outboxId)) {
      // A refused replay sends its owner back off the stack the replay put
      // it on. A replay of several passes can be refused once per pass;
      // only the first moves it, so a later one cannot flip it back.
      // A group's children are refused one by one: each refused child goes
      // back with its owner even when an earlier child already moved it.
      const owner = parent ?? entry;
      if (entry.replayDir === "undo") {
        // A gesture recorded while the replay was on the wire dropped the
        // redo branch. The forward value comes back on screen all the same,
        // so its entry must come back with it.
        if (remove(redoStack, owner) || (owner.status === "dropped" && !undoStack.includes(owner))) {
          owner.droppedBy = undefined;
          touched = true;
          owner.status = "done";
          owner.undoneAt = undefined;
          undoStack.push(owner);
        }
        if (parent && entry.status !== "done" && undoStack.includes(owner)) {
          touched = true;
          entry.status = "done";
          entry.undoneAt = undefined;
        }
      } else if (entry.replayDir === "redo") {
        if (remove(undoStack, owner)) {
          touched = true;
          owner.status = "undone";
          owner.undoneAt = Date.now();
          redoStack.push(owner);
        }
        if (parent && entry.status !== "undone" && redoStack.includes(owner)) {
          touched = true;
          entry.status = "undone";
          entry.undoneAt = Date.now();
        }
      }
    }
  }
  if (touched) changed();
}

const rekeyPendingKey = (key: string, oldId: string, newId: string): string => {
  const parts = key.split(":");
  return parts.map((p) => (p === oldId ? newId : p)).join(":");
};

/** `value` with every string equal to `oldId` replaced, at any depth; the same reference when none is. */
export function rekeyIds<T>(value: T, oldId: string, newId: string): T {
  if (value === oldId) return newId as T;
  if (Array.isArray(value)) {
    const next = value.map((v) => rekeyIds(v, oldId, newId));
    return (next.some((v, i) => v !== value[i]) ? next : value) as T;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(value)) {
      const next = rekeyIds(v, oldId, newId);
      if (next !== v) (out ??= { ...(value as Record<string, unknown>) })[k] = next;
    }
    return (out ?? value) as T;
  }
  return value;
}

// A whole row moves to its server id the way syncEngine moves it: only its
// `_id` changes, the rest (its client_id among them) stays.
const rekeyRow = (row: unknown, oldId: string, newId: string): unknown =>
  row && typeof row === "object" && (row as { _id?: unknown })._id === oldId ? { ...row, _id: newId } : row;

/**
 * Cells naming `oldId`, moved to `newId`; the same array when none does. A
 * field cell's values follow too (a parent pointer or a bucket id the app's
 * rekeyExtra rewrites), so the guard compares them with the rewritten row.
 */
export function rekeyCells(cells: CellChange[], oldId: string, newId: string): CellChange[] {
  let moved = false;
  const out = cells.map((c) => {
    if (c.field === undefined) {
      if (c.id !== oldId) return c;
      moved = true;
      return { ...c, id: newId, before: rekeyRow(c.before, oldId, newId), after: rekeyRow(c.after, oldId, newId) };
    }
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
  for (const { entry } of allEntries()) {
    if (entry.changes) {
      const changes = rekeyCells(entry.changes, oldId, newId);
      if (changes !== entry.changes) {
        entry.changes = changes;
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

/** Test hook: the stacks live at module scope and would leak across tests. */
export function _resetUndoStacks(): void {
  undoStack = [];
  redoStack = [];
  history = [];
  suppressDepth = 0;
  refreshTarget = null;
  groupDepth = 0;
  groupChildren = null;
  groupToast = false;
  changed();
}
