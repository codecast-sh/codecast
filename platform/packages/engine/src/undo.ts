// Generic undo: capture what an action changed, write it back on undo.
//
// The middleware calls the controller for every action that has an undo spec.
// Capture reads the two immutable states the action already produced and
// records each touched store cell with its value on either side. Undo writes
// the before values back through the middleware's own runAction, under the
// name of a real action (the app's replay action, a per-collection writer's
// action, or a spec's inverse), so the replay gets pending locks, the view
// guard, IndexedDB write-through, the follower tee, the outbox and refusal
// rollback exactly as any action does. Redo re-invokes the original action
// with its original args, unless the undo was partial: then it writes the
// applied cells' after values back the same way.
import type { Patch } from "mutative";
import { sameLock, sameShape } from "./syncProtocol";
import type {
  CellChange,
  Invocation,
  PendingEntry,
  UndoConfig,
  UndoCtx,
  UndoEntry,
  UndoOutcome,
  UndoSpec,
} from "./types";
import {
  configureUndoStack,
  isUndoSuppressed,
  newUndoEntryId,
  objectsOf,
  onUndoRebase,
  onUndoRekey,
  onUndoReset,
  rebaseUndoCells,
  undoneAfter,
  type UndoCellMove,
  recordUndoEntry,
  rekeyCells,
  rekeyIds,
  undoRefreshTarget,
  withoutUndo,
  withUndoRefresh,
} from "./undoStack";

export type CellShapeKind = "collection" | "list" | "singleton" | "scalar";

/**
 * One store cell an action touched. `id` is "" for a singleton or a scalar;
 * `field` is absent for a whole row (a collection or list row added or
 * removed, or replaced as a non-object) and for a scalar's whole value.
 */
export type TouchedCell = {
  store: string;
  id: string;
  field?: string;
  shape: CellShapeKind;
  op: "add" | "remove" | "set";
  // Whether a pending lock may be planted for the cell: a direct row add or
  // remove, an exact depth-3 field write, or a list/singleton diff. A deeper
  // write or a whole-row replace is a touch, never a lock (see
  // generateAutoPending for why a leaf value must not lock its field).
  lockable: boolean;
  // The value a lock asserts: the last direct patch's value for a collection
  // field, the after value for a list or singleton field.
  lockValue?: unknown;
  // Where a removed list row sat.
  index?: number;
};

export type TouchedCellShape = {
  kindOf: (key: string) => CellShapeKind;
  rowKeyOf?: (key: string) => string;
  // Store keys to enumerate; everything else is skipped. `pending` never is.
  include?: (key: string) => boolean;
};

const isPlainObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The cells an action touched, from its patches and, where given, the states
 * before and after it. Collections are read from patch paths (a field write
 * is truncated to depth 3, a depth-2 add or remove is a row); lists diff by
 * row identity and singletons by field, because a splice or an unshift
 * patches positions, not rows. A whole-row replace or a whole-key write is
 * expanded by diffing the two values. Pending locks (generateAutoPending)
 * and the undo capture both read this, so they cannot disagree about what an
 * action touched.
 */
export function enumerateTouchedCells(
  patches: Patch[],
  shape: TouchedCellShape,
  prev?: Record<string, any>,
  next?: Record<string, any>,
): TouchedCell[] {
  const cells = new Map<string, TouchedCell>();
  const put = (cell: TouchedCell) => {
    const key = `${cell.store}\u0000${cell.id}\u0000${cell.field ?? "\u0001"}`;
    const prior = cells.get(key);
    if (!prior) {
      cells.set(key, cell);
      return;
    }
    // A later lockable write owns the lock value; a later non-lockable touch
    // never demotes an earlier direct write.
    if (cell.lockable) cells.set(key, cell);
    else if (!prior.lockable) cells.set(key, { ...prior, op: cell.op });
  };
  const include = (key: string) => key !== "pending" && (shape.include ? shape.include(key) : true);
  const whole: string[] = [];
  const wholeSeen = new Set<string>();
  const rowReplaces: Array<[string, string]> = [];
  const keyWhole = (key: string) => {
    if (!wholeSeen.has(key)) {
      wholeSeen.add(key);
      whole.push(key);
    }
  };

  const diffRow = (store: string, id: string, before: any, after: any, lockable: boolean, rowShape: CellShapeKind) => {
    if (isPlainObject(before) && isPlainObject(after)) {
      for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[field] === after[field]) continue;
        put({ store, id, field, shape: rowShape, op: "set", lockable, ...(lockable ? { lockValue: after[field] } : {}) });
      }
    } else if (before !== after) {
      put({ store, id, shape: rowShape, op: "set", lockable: false });
    }
  };

  for (const patch of patches) {
    const path = patch.path as (string | number)[];
    if (path.length < 1) continue;
    const store = String(path[0]);
    if (!include(store)) continue;
    if (shape.kindOf(store) !== "collection" || path.length === 1) {
      keyWhole(store);
      continue;
    }
    const id = String(path[1]);
    if (path.length === 2) {
      if (patch.op === "add") put({ store, id, shape: "collection", op: "add", lockable: true });
      else if (patch.op === "remove") put({ store, id, shape: "collection", op: "remove", lockable: true });
      else rowReplaces.push([store, id]);
      continue;
    }
    const field = String(path[2]);
    if (path.length === 3 && (patch.op === "replace" || patch.op === "add" || patch.op === "remove")) {
      put({ store, id, field, shape: "collection", op: "set", lockable: true, lockValue: patch.value });
    } else {
      put({ store, id, field, shape: "collection", op: "set", lockable: false });
    }
  }

  if (prev && next) {
    for (const [store, id] of rowReplaces) {
      const before = prev[store]?.[id];
      const after = next[store]?.[id];
      if (before === undefined && after !== undefined) put({ store, id, shape: "collection", op: "add", lockable: false });
      else if (before !== undefined && after === undefined) put({ store, id, shape: "collection", op: "remove", lockable: false });
      else diffRow(store, id, before, after, false, "collection");
    }
    for (const store of whole) {
      const kind = shape.kindOf(store);
      const before = prev[store];
      const after = next[store];
      if (before === after) continue;
      if (kind === "singleton") {
        if (isPlainObject(before) && isPlainObject(after)) diffRow(store, "", before, after, true, "singleton");
        else put({ store, id: "", shape: "scalar", op: "set", lockable: false });
        continue;
      }
      if (kind === "list") {
        if (!Array.isArray(before) || !Array.isArray(after)) {
          put({ store, id: "", shape: "scalar", op: "set", lockable: false });
          continue;
        }
        const rowKey = shape.rowKeyOf?.(store) ?? "_id";
        const index = new Map<string, number>();
        before.forEach((r: any, i: number) => {
          if (typeof r?.[rowKey] === "string") index.set(r[rowKey], i);
        });
        const after_ = new Map<string, any>();
        for (const r of after) if (typeof r?.[rowKey] === "string") after_.set(r[rowKey], r);
        for (const [id, row] of after_) {
          const at = index.get(id);
          if (at === undefined) put({ store, id, shape: "list", op: "add", lockable: true });
          else if (before[at] !== row) diffRow(store, id, before[at], row, true, "list");
        }
        for (const [id, at] of index) {
          if (!after_.has(id)) put({ store, id, shape: "list", op: "remove", lockable: true, index: at });
        }
        continue;
      }
      if (kind === "collection" && isPlainObject(before) && isPlainObject(after)) {
        for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
          const b = before[id];
          const a = after[id];
          if (b === a) continue;
          if (b === undefined) put({ store, id, shape: "collection", op: "add", lockable: false });
          else if (a === undefined) put({ store, id, shape: "collection", op: "remove", lockable: false });
          else diffRow(store, id, b, a, false, "collection");
        }
        continue;
      }
      put({ store, id: "", shape: "scalar", op: "set", lockable: false });
    }
  }
  return [...cells.values()];
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export type CaptureShape = {
  /** The key's declared sync kind, if the registry names one. */
  declaredKind: (key: string) => CellShapeKind | undefined;
  rowKeyOf: (key: string) => string;
  isProtected: (key: string) => boolean;
  isUnprotectedField: (key: string, field: string) => boolean;
  viewFields: ReadonlySet<string>;
  ignoreKeys?: ReadonlySet<string>;
  /**
   * The server row a store's rows reach (its dispatch table). Two stores on
   * one table hold copies of one row, so the guard judges them together.
   */
  rowGroupOf?: (key: string) => string;
  /**
   * Fields whose clear the server spells by leaving them out
   * (PlatformConfig.optionalClearFields). The guard reads null and absent as
   * one value there, as the sync layer's echo check does.
   */
  optionalClearFields?: ReadonlySet<string>;
};

type CellAddress = { store: string; id: string; field?: string; shape?: CellShapeKind };

/** Read one cell from a state: whether it exists, and its value. */
export function readCell(
  state: Record<string, any>,
  cell: CellAddress,
  rowKeyOf: (key: string) => string,
): { has: boolean; value: unknown; rowGone: boolean } {
  const slice = state?.[cell.store];
  switch (cell.shape ?? "collection") {
    case "scalar":
      return { has: slice !== undefined, value: slice, rowGone: false };
    case "singleton": {
      const has = isPlainObject(slice) && cell.field !== undefined && cell.field in slice;
      return { has, value: has ? slice[cell.field!] : undefined, rowGone: !isPlainObject(slice) };
    }
    case "list": {
      const rowKey = rowKeyOf(cell.store);
      const row = Array.isArray(slice) ? slice.find((r: any) => r?.[rowKey] === cell.id) : undefined;
      if (cell.field === undefined) return { has: row !== undefined, value: row, rowGone: row === undefined };
      const has = isPlainObject(row) && cell.field in row;
      return { has, value: has ? row[cell.field] : undefined, rowGone: row === undefined };
    }
    default: {
      const row = isPlainObject(slice) && Object.prototype.hasOwnProperty.call(slice, cell.id) ? slice[cell.id] : undefined;
      if (cell.field === undefined) return { has: row !== undefined, value: row, rowGone: row === undefined };
      const has = isPlainObject(row) && cell.field in row;
      return { has, value: has ? row[cell.field] : undefined, rowGone: row === undefined };
    }
  }
}

/**
 * The cells an action changed, classified for undo: `protected` (a
 * local-first key and a protected field: conflict-checked), `view` (a view
 * guard field), `mirror` (anything else: restored only while it still holds
 * the after value). `pending`, ignored keys and the spec's ignored fields
 * are never captured.
 */
export function captureCells(
  patches: Patch[],
  prev: Record<string, any>,
  next: Record<string, any>,
  shape: CaptureShape,
  spec?: Pick<UndoSpec, "ignoreFields" | "captureKeys">,
): CellChange[] {
  const ignoreFields = new Set(spec?.ignoreFields ?? []);
  const captureKeys = new Set(spec?.captureKeys ?? []);
  const kindOf = (key: string): CellShapeKind => {
    const declared = shape.declaredKind(key);
    if (declared) return declared;
    if (shape.isProtected(key)) return "collection";
    const value = prev[key] !== undefined ? prev[key] : next[key];
    if (Array.isArray(value)) {
      // An undeclared array is a list only when every row names itself;
      // otherwise it is restored as one value.
      const rowKey = shape.rowKeyOf(key);
      const keyed = (rows: unknown) => !Array.isArray(rows) || rows.every((r: any) => typeof r?.[rowKey] === "string");
      return keyed(prev[key]) && keyed(next[key]) ? "list" : "scalar";
    }
    if (isPlainObject(value)) return "collection";
    return "scalar";
  };
  const touched = enumerateTouchedCells(
    patches,
    {
      kindOf,
      rowKeyOf: shape.rowKeyOf,
      include: (key) => captureKeys.has(key) || !shape.ignoreKeys?.has(key),
    },
    prev,
    next,
  );
  const out: CellChange[] = [];
  for (const cell of touched) {
    if (cell.field !== undefined && ignoreFields.has(cell.field)) continue;
    const before = readCell(prev, cell, shape.rowKeyOf);
    const after = readCell(next, cell, shape.rowKeyOf);
    if (before.has === after.has && sameShape(before.value, after.value)) continue;
    const kind: CellChange["kind"] = shape.viewFields.has(cell.store)
      ? "view"
      : shape.isProtected(cell.store) && (cell.field === undefined || !shape.isUnprotectedField(cell.store, cell.field))
        ? "protected"
        : "mirror";
    out.push({
      store: cell.store,
      id: cell.id,
      ...(cell.field !== undefined ? { field: cell.field } : {}),
      before: before.value,
      after: after.value,
      hadBefore: before.has,
      hadAfter: after.has,
      kind,
      shape: cell.shape,
      ...(cell.index !== undefined ? { index: cell.index } : {}),
    });
  }
  return out;
}

/** The pending entries an action added or replaced, including ones its draft wrote by hand. */
export function plantedEntries(
  prevPending: Record<string, PendingEntry> | undefined,
  nextPending: Record<string, PendingEntry> | undefined,
): Record<string, PendingEntry> {
  const out: Record<string, PendingEntry> = {};
  if (!nextPending || nextPending === prevPending) return out;
  for (const [key, entry] of Object.entries(nextPending)) {
    if (entry && prevPending?.[key] !== entry) out[key] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

const rowKeyOfCell = (c: { store: string; id: string }) => `${c.store}\u0000${c.id}`;

type Verdict = "apply" | "already" | "conflict";

type GuardOpts = {
  rowKeyOf: (key: string) => string;
  stampFields?: ReadonlySet<string>;
  optionalClearFields?: ReadonlySet<string>;
  serverAssignedFields?: ReadonlySet<string>;
  tombstone?: UndoConfig["tombstone"];
};

// A cell as the guard sees it: a row the server keeps as a tombstone (an
// archived doc the sync log still delivers) is a row that is gone.
function readLive(state: Record<string, any>, cell: CellChange, opts: GuardOpts) {
  const cur = readCell(state, cell, opts.rowKeyOf);
  if (!opts.tombstone || cur.rowGone || cell.shape === "scalar" || cell.shape === "singleton") return cur;
  const row = cell.field === undefined ? cur.value : readCell(state, { ...cell, field: undefined }, opts.rowKeyOf).value;
  return opts.tombstone(cell.store, row) ? { has: false, value: undefined, rowGone: true } : cur;
}

// Whether a cell's current value is `target`. On an optional-clear field a
// null and a missing field are the same clear: the server's echo of a null
// leaves the field out, and the lock layer already retires on that.
function holds(
  cell: CellChange,
  cur: { has: boolean; value: unknown },
  target: unknown,
  hadTarget: boolean,
  opts: GuardOpts,
): boolean {
  if (cur.has === hadTarget && sameShape(cur.value, target)) return true;
  if (cell.field !== undefined && opts.optionalClearFields?.has(cell.field) && cur.value == null && target == null) {
    return true;
  }
  return false;
}

// A row the forward added is still the row it added when every field the
// forward wrote holds its value. Stamps, server system fields ("_id",
// "_creationTime") and fields the server assigns on create (a created_at the
// echo replaces with its own clock) are the server's, and fields only the
// echo carries are not the forward's either.
function rowStillAsAdded(cur: unknown, added: unknown, opts: GuardOpts): boolean {
  if (!isPlainObject(cur) || !isPlainObject(added)) return sameShape(cur, added);
  for (const [field, value] of Object.entries(added)) {
    if (field.startsWith("_") || opts.stampFields?.has(field) || opts.serverAssignedFields?.has(field)) continue;
    if (!sameShape(cur[field], value)) {
      if (!(opts.optionalClearFields?.has(field) && cur[field] == null && value == null)) return false;
    }
  }
  return true;
}

function verdictForUndo(cell: CellChange, state: Record<string, any>, opts: GuardOpts): Verdict {
  const cur = readLive(state, cell, opts);
  if (cell.field === undefined && cell.shape !== "scalar") {
    // Forward added the row: take it back only while it is the row it added.
    // A mirror holds copies the server's push rebuilds in its own shape (a
    // favorites row with a few fields where the forward copied the whole
    // row), so there the row's presence is the fact the forward wrote.
    if (!cell.hadBefore && cell.hadAfter) {
      if (!cur.has) return "already";
      if (cell.kind === "mirror") return "apply";
      return rowStillAsAdded(cur.value, cell.after, opts) ? "apply" : "conflict";
    }
    if (cell.hadBefore && !cell.hadAfter) return cur.has ? "already" : "apply"; // forward removed it
  } else if (cur.rowGone && cell.shape !== "scalar") {
    return "conflict";
  }
  if (holds(cell, cur, cell.after, cell.hadAfter, opts)) return "apply";
  if (holds(cell, cur, cell.before, cell.hadBefore, opts)) return "already";
  // Absent and undefined read the same to the user.
  if (sameShape(cur.value, cell.after)) return "apply";
  if (sameShape(cur.value, cell.before)) return "already";
  return "conflict";
}

function holdsBefore(cell: CellChange, state: Record<string, any>, opts: GuardOpts): boolean {
  const cur = readLive(state, cell, opts);
  if (cell.field === undefined && cell.shape !== "scalar") {
    if (!cell.hadBefore && cell.hadAfter) return !cur.has;
    if (cell.hadBefore && !cell.hadAfter) return cur.has;
  } else if (cur.rowGone && cell.shape !== "scalar") {
    // The row was deleted since the undo: an absent field on a gone row is
    // not the before value, and re-running the action would recreate it.
    return false;
  }
  return holds(cell, cur, cell.before, cell.hadBefore, opts) || sameShape(cur.value, cell.before);
}

export type UndoGuardResult = {
  apply: CellChange[];
  /** One per server row left alone (what the notice counts). */
  skippedRows: Array<{ store: string; id: string }>;
  /** Every store copy of those rows, for the pending and inverse filters. */
  held: Array<{ store: string; id: string }>;
  /**
   * Mirror cells someone changed since. They are left alone locally, and a
   * spec's inverse must not send their prior values either (narrowInverse).
   */
  mirrorConflicts: CellChange[];
};

/**
 * Which cells an undo may write now. Per server row, all or nothing: every
 * protected cell must still hold its after value (or already hold its before
 * value); one that holds anything else skips the whole row, in every store
 * that holds a copy of it (`rowGroupOf`). Stamp fields are
 * never compared and ride along with their row. Mirror cells are restored
 * only while they still hold the after value; view cells only when the spec
 * asks and the view has not moved.
 */
export function guardUndo(
  changes: readonly CellChange[],
  state: Record<string, any>,
  opts: GuardOpts & {
    rowGroupOf?: (key: string) => string;
    restoreView?: boolean;
  },
): UndoGuardResult {
  const isStamp = (c: CellChange) => c.field !== undefined && !!opts.stampFields?.has(c.field);
  const rows = new Map<string, CellChange[]>();
  for (const cell of changes) {
    if (cell.kind !== "protected") continue;
    const k = rowKeyOfCell({ store: opts.rowGroupOf?.(cell.store) ?? cell.store, id: cell.id });
    const list = rows.get(k) ?? [];
    list.push(cell);
    rows.set(k, list);
  }
  const apply: CellChange[] = [];
  const skippedRows: Array<{ store: string; id: string }> = [];
  const held: Array<{ store: string; id: string }> = [];
  const appliedRows = new Set<string>();
  for (const cells of rows.values()) {
    const compared = cells.filter((c) => !isStamp(c));
    const verdicts = compared.map((c) => verdictForUndo(c, state, opts));
    if (verdicts.includes("conflict")) {
      skippedRows.push({ store: cells[0]!.store, id: cells[0]!.id });
      for (const k of new Set(cells.map(rowKeyOfCell))) {
        const c = cells.find((x) => rowKeyOfCell(x) === k)!;
        held.push({ store: c.store, id: c.id });
      }
      continue;
    }
    const writes = compared.filter((_, i) => verdicts[i] === "apply");
    if (writes.length === 0) continue;
    apply.push(...writes);
    for (const c of cells) appliedRows.add(rowKeyOfCell(c));
  }
  // A mirror or view cell naming a skipped row's id belongs to that row (the
  // favorites entry of a row whose is_favorite moved): it stays too.
  const skippedIds = new Set(skippedRows.map((r) => r.id).filter((id) => id !== ""));
  const mirrorConflicts: CellChange[] = [];
  for (const cell of changes) {
    if (cell.kind === "protected") {
      if (isStamp(cell) && appliedRows.has(rowKeyOfCell(cell))) apply.push(cell);
      continue;
    }
    if (cell.kind === "view" && !opts.restoreView) continue;
    if (isStamp(cell) || skippedIds.has(cell.id)) continue;
    const verdict = verdictForUndo(cell, state, opts);
    if (verdict === "apply") apply.push(cell);
    else if (verdict === "conflict" && cell.kind === "mirror") mirrorConflicts.push(cell);
  }
  // A restored mirror row is restamped too, as a protected row is: a stamp
  // that orders writes (last writer wins) must call the restore the newest.
  const mirrorRows = new Set(apply.filter((c) => c.kind !== "protected").map(rowKeyOfCell));
  for (const cell of changes) {
    if (cell.kind !== "protected" && isStamp(cell) && !skippedIds.has(cell.id) && mirrorRows.has(rowKeyOfCell(cell))) apply.push(cell);
  }
  return { apply, skippedRows, held, mirrorConflicts };
}

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

function restamp(row: unknown, stampFields: ReadonlySet<string> | undefined, now: number): unknown {
  if (!stampFields || !isPlainObject(row)) return row;
  let out: Record<string, any> | null = null;
  for (const f of stampFields) {
    if (f in row) {
      out ??= { ...row };
      out[f] = now;
    }
  }
  return out ?? row;
}

/** Write each cell's before value into a draft. */
export function writeBeforeValues(
  draft: any,
  cells: readonly CellChange[],
  opts: {
    rowKeyOf: (key: string) => string;
    stampFields?: ReadonlySet<string>;
    restoreView?: (draft: any, field: string, value: unknown) => void;
    now?: number;
  },
): void {
  const now = opts.now ?? Date.now();
  for (const cell of cells) {
    const stamp = cell.field !== undefined && !!opts.stampFields?.has(cell.field);
    const value = stamp ? now : cell.before;
    switch (cell.shape ?? "collection") {
      case "scalar":
        if (cell.hadBefore) draft[cell.store] = cell.before;
        else delete draft[cell.store];
        break;
      case "singleton": {
        if (!isPlainObject(draft[cell.store])) {
          if (!cell.hadBefore) break;
          draft[cell.store] = {};
        }
        if (cell.field === undefined) break;
        if (cell.hadBefore || stamp) draft[cell.store][cell.field] = value;
        else delete draft[cell.store][cell.field];
        break;
      }
      case "list": {
        const list = draft[cell.store];
        if (!Array.isArray(list)) break;
        const rowKey = opts.rowKeyOf(cell.store);
        const at = list.findIndex((r: any) => r?.[rowKey] === cell.id);
        if (cell.field === undefined) {
          if (!cell.hadBefore) {
            if (at !== -1) list.splice(at, 1);
          } else if (at === -1) {
            list.splice(Math.min(cell.index ?? list.length, list.length), 0, restamp(cell.before, opts.stampFields, now));
          }
          break;
        }
        if (at === -1) break;
        if (cell.hadBefore || stamp) list[at][cell.field] = value;
        else delete list[at][cell.field];
        break;
      }
      default: {
        if (cell.field === undefined) {
          if (!isPlainObject(draft[cell.store])) {
            if (!cell.hadBefore) break;
            draft[cell.store] = {};
          }
          if (cell.hadBefore) draft[cell.store][cell.id] = restamp(cell.before, opts.stampFields, now);
          else delete draft[cell.store][cell.id];
          break;
        }
        const row = draft[cell.store]?.[cell.id];
        if (!row || typeof row !== "object") break;
        if (cell.hadBefore || stamp) row[cell.field] = value;
        else delete row[cell.field];
      }
    }
    if (cell.kind === "view") opts.restoreView?.(draft, cell.store, cell.before);
  }
}

/** Delete the forward's planted pending entries that still match exactly, except on skipped rows. */
export function deletePlanted(
  draft: any,
  planted: Record<string, unknown> | undefined,
  skippedRows: ReadonlyArray<{ store: string; id: string }>,
): void {
  if (!planted || !draft.pending) return;
  const skipped = skippedRows.map((r) => `${r.store}:${r.id}`);
  for (const [key, raw] of Object.entries(planted)) {
    const entry = raw as PendingEntry;
    const cur = draft.pending[key] as PendingEntry | undefined;
    if (!sameLock(cur, entry)) continue;
    if (skipped.some((p) => key === p || key.startsWith(`${p}:`))) continue;
    delete draft.pending[key];
  }
}

// ---------------------------------------------------------------------------
// Pass planning
// ---------------------------------------------------------------------------

export type ReplayPass = { inv: Invocation; cells: CellChange[] };

/**
 * How an undo reaches the server. A spec's inverse wins, its first
 * invocation carrying every cell. Otherwise each row on a key with a writer
 * becomes that writer's invocations (the first carries the row's cells), and
 * everything else rides one replay-action pass with no args, first, so view
 * cells land in the pass the view-nav declaration covers.
 */
export function planReplayPasses(
  cells: readonly CellChange[],
  state: Record<string, any>,
  config: Pick<UndoConfig, "writers" | "replayAction">,
  inverse: Invocation[] | null | undefined,
  rowKeyOf: (key: string) => string,
): ReplayPass[] {
  if (inverse && inverse.length > 0) {
    return inverse.map((inv, i) => ({ inv, cells: i === 0 ? [...cells] : [] }));
  }
  const rest: CellChange[] = [];
  const writerPasses: ReplayPass[] = [];
  const byRow = new Map<string, CellChange[]>();
  for (const cell of cells) {
    const writer = config.writers?.[cell.store];
    if (!writer || cell.kind === "view") {
      rest.push(cell);
      continue;
    }
    const k = rowKeyOfCell(cell);
    const list = byRow.get(k) ?? [];
    list.push(cell);
    byRow.set(k, list);
  }
  for (const rowCells of byRow.values()) {
    const { store, id } = rowCells[0]!;
    const writer = config.writers![store]!;
    const current = readCell(state, { store, id, shape: rowCells[0]!.shape }, rowKeyOf).value;
    const rowCell = rowCells.find((c) => c.field === undefined);
    let invs: Invocation[] = [];
    if (rowCell && rowCell.hadBefore && !rowCell.hadAfter && writer.restoreRow) {
      invs = writer.restoreRow(id, rowCell.before, state);
    } else if (rowCell && !rowCell.hadBefore && rowCell.hadAfter && writer.removeRow) {
      invs = writer.removeRow(id, current, state);
    } else if (writer.fields) {
      const fields: Record<string, unknown> = {};
      for (const c of rowCells) if (c.field !== undefined) fields[c.field] = c.before;
      invs = writer.fields(id, fields, current, state);
    }
    if (invs.length === 0) {
      rest.push(...rowCells);
      continue;
    }
    invs.forEach((inv, i) => writerPasses.push({ inv, cells: i === 0 ? rowCells : [] }));
  }
  const passes: ReplayPass[] = [];
  if (rest.length > 0 || writerPasses.length === 0) {
    passes.push({ inv: { action: config.replayAction, args: [] }, cells: rest });
  }
  return [...passes, ...writerPasses];
}

/**
 * The server half of a partial undo. The spec's inverse is asked again with
 * the skipped rows' cells, and any single cells someone changed since
 * (`conflicts`, mirror cells the guard left alone), taken out of `changes`,
 * so an inverse that derives its invocations from the changed cells sends
 * none for them. If an invocation still names a skipped id (an inverse that
 * reads its ids from the args), it cannot be narrowed and the result is null:
 * the undo is refused whole, because sending it would overwrite the skipped
 * row's later change on the server.
 */
export function narrowInverse(
  inverse: NonNullable<UndoSpec["inverse"]>,
  ctx: UndoCtx,
  skippedRows: ReadonlyArray<{ store: string; id: string }>,
  conflicts: readonly CellChange[] = [],
): Invocation[] | null {
  const skippedKeys = new Set(skippedRows.map(rowKeyOfCell));
  const skippedIds = skippedRows.map((r) => r.id).filter((id) => id !== "");
  const conflicted = new Set(conflicts);
  const changes = ctx.changes.filter(
    (c) => !conflicted.has(c) && !skippedKeys.has(rowKeyOfCell(c)) && !skippedIds.includes(c.id),
  );
  const invs = inverse({ ...ctx, changes }) ?? [];
  // rekeyIds hands back the same reference unless the value names the id.
  const names = (inv: Invocation, id: string) => rekeyIds(inv.args, id, `${id}\u0000`) !== inv.args;
  if (invs.length === 0 || invs.some((inv) => skippedIds.some((id) => names(inv, id)))) return null;
  return invs;
}

/**
 * The cells an undo writes, with each unset before value on a writer's
 * `clears` field replaced by the value the server stores for a clear. The
 * replay then writes, locks and later compares that value, so the echo of the
 * writer's clear retires the lock and a redo finds the row where it left it.
 */
export function spellClears(cells: CellChange[], writers: UndoConfig["writers"]): CellChange[] {
  let out: CellChange[] | null = null;
  cells.forEach((cell, i) => {
    const clears = writers?.[cell.store]?.clears;
    if (!clears || cell.field === undefined || cell.before != null || !(cell.field in clears)) return;
    out ??= [...cells];
    out[i] = { ...cell, before: clears[cell.field], hadBefore: true };
  });
  return out ?? cells;
}

/** A cell seen from the other side: its after value becomes the one to write back. */
const flipCell = (c: CellChange): CellChange => ({
  ...c,
  before: c.after,
  after: c.before,
  hadBefore: c.hadAfter,
  hadAfter: c.hadBefore,
});

// ---------------------------------------------------------------------------
// Controller (one per store)
// ---------------------------------------------------------------------------

type Flags = { act: boolean; asyncAct: boolean; receipt: boolean; syn: boolean };

export type UndoControllerDeps = {
  config: UndoConfig;
  get: () => any;
  runAction: (
    key: string,
    flags: Flags,
    recipe: (draft: any) => unknown,
    args: any[],
    opts?: {
      onCommitted?: (commit: { outboxId: string }) => void;
      after?: readonly string[];
      reverses?: readonly string[];
      vet?: (commit: { state: any; nextState: any; patches: Patch[] }) => boolean;
    },
  ) => any;
  rawCreator: (name: string) => any;
  flagsOf: (fn: any) => Flags;
  shape: CaptureShape;
};

// `frame` is the rest of the capture's UndoCtx, kept so a partial undo can
// ask the spec's inverse again over the rows it applies (narrowInverse).
type Internal = {
  inverse: Invocation[] | null;
  applied: CellChange[];
  /**
   * Cells the guard cleared for the undo that its spec's spell left out. They
   * still hold their after value, and a redo judges them by it.
   */
  left: CellChange[];
  frame: Pick<UndoCtx, "before" | "after" | "result">;
  /**
   * Stub rekeys the frame has not followed yet. Its states are whole store
   * snapshots, so they are rewritten only when a spec is asked again.
   */
  frameRekeys?: ReadonlyArray<readonly [string, string]>;
};

// The capture's frame with every stub rekey since applied, the way the
// entry's cells and args already follow them.
const frameOf = (internal: Internal): Internal["frame"] => {
  let frame = internal.frame;
  for (const [oldId, newId] of internal.frameRekeys ?? []) {
    frame = {
      before: rekeyIds(frame.before, oldId, newId),
      after: rekeyIds(frame.after, oldId, newId),
      result: rekeyIds(frame.result, oldId, newId),
    };
  }
  if (internal.frameRekeys?.length) {
    internal.frame = frame;
    internal.frameRekeys = undefined;
  }
  return frame;
};

/**
 * Outbox ids a send must follow, and the subset it wholly writes back. It may
 * overtake one of `reverses` still on its first attempt (that send is then
 * not retried); every other id in `after` it waits for.
 */
export type SendOrder = { after: readonly string[]; reverses: readonly string[] };

export type UndoController = {
  /** Whether a call of `key` should be captured right now. */
  wants: (key: string, flags: Flags) => boolean;
  /** The sends a call made right now must not overtake: a redo's re-invoke follows its undo's sends. */
  orderAfter: () => SendOrder | undefined;
  /** The judge of a call of `key` made right now: a redo's re-invoke, once. */
  vetFor: (key: string) => ((commit: { state: any; nextState: any; patches: Patch[] }) => boolean) | undefined;
  capture: (
    key: string,
    args: unknown[],
    commit: { state: any; finalState: any; patches: Patch[]; outboxId: string; returnValue: unknown },
  ) => void;
};

const swallow = (value: unknown) => {
  if (value && typeof (value as Promise<unknown>).then === "function") {
    (value as Promise<unknown>).then(undefined, () => {});
  }
};

export function createUndoController(deps: UndoControllerDeps): UndoController {
  const { config, get, shape } = deps;
  const rowKeyOf = shape.rowKeyOf;
  const internals = new WeakMap<UndoEntry, Internal>();
  configureUndoStack({
    keyboardWindowMs: config.keyboardWindowMs,
    stackLimit: config.stackLimit,
    historyLimit: config.historyLimit,
    stampFields: config.stampFields,
  });
  // The inverse invocations and the applied cells live here, not on the
  // entry, so a stub rekey reaches them through the stack's hook.
  onUndoRekey((entry, oldId, newId) => {
    const sends = lastSend.get(`#${oldId}`);
    if (sends) {
      lastSend.delete(`#${oldId}`);
      lastSend.set(`#${newId}`, new Map([...sends, ...(lastSend.get(`#${newId}`) ?? [])]));
    }
    // The cells a send wrote, named under the id it was sent with.
    const stub = `\u0000${oldId}\u0000`;
    for (const [id, wrote] of sentCells) {
      if (![...wrote].some((k) => k.includes(stub))) continue;
      sentCells.set(id, new Set([...wrote].map((k) => k.split(stub).join(`\u0000${newId}\u0000`))));
    }
    const internal = internals.get(entry);
    if (!internal) return false;
    const inverse = internal.inverse?.map((inv) => ({ ...inv, args: rekeyIds(inv.args, oldId, newId) })) ?? null;
    const applied = rekeyCells(internal.applied, oldId, newId);
    const left = rekeyCells(internal.left, oldId, newId);
    const touched = applied !== internal.applied || left !== internal.left || inverse?.some((inv, i) => inv.args !== internal.inverse![i]!.args) === true;
    // A spec reads its frame by the ids its cells and args name, so the frame
    // follows only a rekey of one of those (the stack has moved them already).
    const names = (v: unknown) => rekeyIds(v, newId, `${newId}\u0000`) !== v;
    const frameRekeys =
      touched || names(entry.changes) || names(entry.args)
        ? [...(internal.frameRekeys ?? []), [oldId, newId] as const]
        : internal.frameRekeys;
    if (touched || frameRekeys !== internal.frameRekeys) internals.set(entry, { ...internal, inverse, applied, left, frameRekeys });
    return touched;
  });

  // The applied cells a redo is judged by follow every rebase of the entry's
  // own cells (a redo's fresh stamp, a refused write under it).
  onUndoRebase((entry, rebase) => {
    const internal = internals.get(entry);
    if (internal) internals.set(entry, { ...internal, applied: rebase(internal.applied) });
  });

  // A reset history (an account boundary) takes its send order with it.
  onUndoReset(() => {
    lastSend.clear();
    sentCells.clear();
  });

  const isStamp = (c: CellChange) => c.field !== undefined && !!config.stampFields?.has(c.field);
  const cellKey = (c: CellChange) => `${rowKeyOfCell(c)}\u0000${c.field ?? "\u0001"}`;
  const guardOpts = {
    rowKeyOf,
    rowGroupOf: shape.rowGroupOf,
    stampFields: config.stampFields,
    optionalClearFields: shape.optionalClearFields,
    serverAssignedFields: config.serverAssignedFields,
    tombstone: config.tombstone,
  };

  // The sends of the last step that wrote each cell: a forward, or every
  // pass of an undo replay or a redo. A step of a walk reverses what those
  // sends wrote, so it goes out after all of them; sends wait for the sends
  // they follow, so the newest step per cell is enough. A step's passes are
  // noted together because a pass may carry none of the cells it writes (an
  // inverse) and any of them can be the one still retrying. Keyed by row id
  // (two stores can hold copies of one row) and field, "\u0001" for the
  // whole row; a row with no id is keyed by store.
  const lastSend = new Map<string, Map<string, readonly string[]>>();
  const SEND_ROWS_LIMIT = 1000;
  const scopeOf = (c: { store: string; id: string }) => (c.id !== "" ? `#${c.id}` : `@${c.store}`);
  const WHOLE = "\u0001";
  // The cells each send wrote (the whole step's, for a pass): a later step
  // may overtake a send only when it writes every one of them back. A send
  // that also carried something its cells leave out (a field the spec's
  // ignoreFields keeps out of capture) holds UNCOVERED, which no step writes
  // back, so every later step waits for it.
  const sentCells = new Map<string, ReadonlySet<string>>();
  const UNCOVERED = "\u0002";
  const noteSends = (cells: readonly CellChange[], outboxIds: readonly string[], carriedMore = false) => {
    const wrote = new Set(cells.filter((c) => !isStamp(c)).map(cellKey));
    if (carriedMore) wrote.add(UNCOVERED);
    for (const id of outboxIds) {
      sentCells.delete(id);
      sentCells.set(id, wrote);
    }
    while (sentCells.size > SEND_ROWS_LIMIT * 4) sentCells.delete(sentCells.keys().next().value!);
    for (const c of cells) {
      if (isStamp(c)) continue;
      const scope = scopeOf(c);
      const fields = lastSend.get(scope) ?? new Map<string, readonly string[]>();
      lastSend.delete(scope);
      fields.set(c.field ?? WHOLE, outboxIds);
      lastSend.set(scope, fields);
    }
    while (lastSend.size > SEND_ROWS_LIMIT) lastSend.delete(lastSend.keys().next().value!);
  };
  // What a step writing `cells` must follow (`after`), and the subset it
  // wholly writes back (`reverses`): only those may it overtake, since a
  // dropped failure of one leaves nothing on the server the step does not
  // overwrite. The rest it waits for.
  const sendsBefore = (cells: readonly CellChange[], own: readonly string[]): SendOrder => {
    const out = new Set(own);
    for (const c of cells) {
      if (isStamp(c)) continue;
      const fields = lastSend.get(scopeOf(c));
      if (!fields) continue;
      const named = c.field === undefined ? [...fields.values()] : [fields.get(c.field), fields.get(WHOLE)];
      for (const ids of named) for (const id of ids ?? []) out.add(id);
    }
    const writes = new Set(cells.filter((c) => !isStamp(c)).map(cellKey));
    const wholeRows = new Set(cells.filter((c) => !isStamp(c) && c.field === undefined).map(rowKeyOfCell));
    const covers = (key: string) =>
      key !== UNCOVERED && (writes.has(key) || wholeRows.has(key.slice(0, key.lastIndexOf("\u0000"))));
    const after = [...out];
    const reverses = after.filter((id) => {
      const wrote = sentCells.get(id);
      return !!wrote && [...wrote].every(covers);
    });
    return { after, reverses };
  };

  // A redo re-invokes its action, which may write a value the first run did
  // not (a fresh Date.now() stamp). The next undone entry recorded the first
  // run's value as its before, so its redo would read the fresh one as a
  // change made since. Each cell the redo moved is rebased onto the new value
  // in the nearest undone entry that touches it.
  const rebaseUndoneAfter = (entry: UndoEntry, was: readonly CellChange[], now: readonly CellChange[]) => {
    const nowByKey = new Map(now.map((c) => [cellKey(c), c] as const));
    const moved = new Map<string, UndoCellMove>();
    for (const from of was) {
      const to = nowByKey.get(cellKey(from));
      if (!to || (to.hadAfter === from.hadAfter && sameShape(to.after, from.after))) continue;
      moved.set(cellKey(from), { from, to });
    }
    if (moved.size > 0) rebaseUndoCells(undoneAfter(entry), moved);
  };

  const internalOf = (spec: UndoSpec, ctx: UndoCtx): Internal => ({
    inverse: spec.inverse?.(ctx) ?? null,
    applied: [],
    left: [],
    frame: { before: ctx.before, after: ctx.after, result: ctx.result },
  });

  // The sends a redo's re-invoke follows, while it runs.
  let redoAfter: SendOrder | undefined;
  // The judge of the redo's re-invoke, taken by its one call.
  let redoVet: { action: string; judge: (commit: { state: any; nextState: any; patches: Patch[] }) => boolean } | undefined;

  const runPass = (
    entry: UndoEntry,
    pass: ReplayPass,
    first: boolean,
    skippedRows: Array<{ store: string; id: string }>,
    order: SendOrder,
    writes: readonly CellChange[],
  ) => {
    const target = deps.rawCreator(pass.inv.action);
    const flags: Flags = target ? deps.flagsOf(target) : { act: true, asyncAct: false, receipt: false, syn: false };
    const recipe = (draft: any) => {
      if (first) deletePlanted(draft, entry.planted, skippedRows);
      let result: unknown;
      if (pass.inv.runDraft !== false && typeof target === "function") result = target.apply(draft, pass.inv.args);
      writeBeforeValues(draft, pass.cells, { rowKeyOf, stampFields: config.stampFields, restoreView: config.restoreView });
      return result;
    };
    const result = withoutUndo(() =>
      deps.runAction(pass.inv.action, flags, recipe, pass.inv.args as any[], {
        onCommitted: ({ outboxId }) => {
          entry.replayOutboxIds = [...(entry.replayOutboxIds ?? []), outboxId];
          // The step's sends so far: the last pass notes all of them.
          noteSends(writes, entry.replayOutboxIds);
        },
        // A reversal never overtakes a write it does not wholly reverse.
        after: order.after,
        reverses: order.reverses,
      }),
    );
    swallow(result);
  };

  // A step of `entry` starts: its replay (or, with no `sent`, a redo's
  // re-invoke, which the history follows by its forward dispatch) supersedes
  // the replay before it. That one stays findable until this step settles
  // (supersededReplay), and rebases deferred under it lapse.
  const beginStep = (entry: UndoEntry, dir: "undo" | "redo", sent: readonly CellChange[] | undefined) => {
    entry.supersededReplay = entry.replayOutboxIds?.length && entry.replayDir
      ? { ids: entry.replayOutboxIds, dir: entry.replayDir }
      : undefined;
    entry.replayOutboxIds = sent ? [] : undefined;
    entry.replayDir = sent ? dir : undefined;
    entry.replaySent = sent?.filter((c) => !isStamp(c));
    entry.replayDeferred = undefined;
  };

  const undoGeneric = (entry: UndoEntry): UndoOutcome => {
    const state = get();
    const spec = entry.action ? config.specs[entry.action] : undefined;
    const guarded = guardUndo(entry.changes ?? [], state, { ...guardOpts, restoreView: spec?.restoreView });
    const { skippedRows, held, mirrorConflicts } = guarded;
    const cleared = spellClears(guarded.apply, config.writers);
    const internal = internals.get(entry);
    const recorded = (): UndoCtx | undefined =>
      internal && { ...frameOf(internal), action: entry.action!, args: entry.args ?? [], changes: entry.changes ?? [] };
    const apply = spec?.spell ? spec.spell(cleared, recorded()) : cleared;
    entry.skipped = skippedRows;
    // No row applies when every protected row conflicted, even if a mirror
    // could still be restored: a mirror alone is not the user's change.
    const rowApplied = apply.some((c) => c.kind === "protected" && !isStamp(c));
    if (apply.length === 0 && skippedRows.length === 0 && mirrorConflicts.length === 0) {
      // Every row already holds its before value: nothing to take back.
      if (internal) {
        internal.applied = [];
        internal.left = [];
      }
      return { ok: false, reason: "already" };
    }
    if (apply.length === 0 || (skippedRows.length > 0 && !rowApplied)) return { ok: false, reason: "conflict" };
    let inverse = internal?.inverse;
    if (inverse?.length && (skippedRows.length > 0 || mirrorConflicts.length > 0)) {
      // A mirror row whose every cell changed since is left whole, like a
      // skipped protected row: an inverse may not name it at all.
      const writes = new Set(apply.map(rowKeyOfCell));
      const goneMirrorRows = [...new Map(mirrorConflicts.map((c) => [rowKeyOfCell(c), c])).values()]
        .filter((c) => !writes.has(rowKeyOfCell(c)))
        .map((c) => ({ store: c.store, id: c.id }));
      inverse = spec?.inverse
        ? narrowInverse(
            spec.inverse,
            recorded()!,
            [...held, ...goneMirrorRows],
            mirrorConflicts,
          )
        : null;
      if (!inverse) return { ok: false, reason: "conflict" };
    }
    config.beforeReplay?.(entry, "undo");
    const passes = planReplayPasses(apply, state, config, inverse, rowKeyOf);
    const after = sendsBefore(apply, [...(entry.outboxIds ?? []), ...(entry.replayOutboxIds ?? [])]);
    beginStep(entry, "undo", apply);
    passes.forEach((pass, i) => runPass(entry, pass, i === 0, held, after, apply));
    if (internal) {
      internal.applied = apply;
      const kept = new Set(apply.map(cellKey));
      internal.left = cleared.filter((c) => !isStamp(c) && !kept.has(cellKey(c)));
    }
    config.afterReplay?.(entry, "undo", apply, "replay");
    return { ok: true, applied: apply.filter((c) => !isStamp(c)).length, skipped: skippedRows.length };
  };

  // Redo after a partial undo. Re-invoking the action would write its
  // forward value over the rows the undo left, which hold someone's later
  // change. Instead the cells the undo applied get their after values back,
  // the mirror of the undo's replay, on the same server route. An inverse
  // spec's server half has no such mirror, so its redo is refused.
  const redoPartial = (entry: UndoEntry, state: any, applied: readonly CellChange[]): UndoOutcome => {
    if (internals.get(entry)?.inverse?.length) return { ok: false, reason: "conflict" };
    const spec = entry.action ? config.specs[entry.action] : undefined;
    const { apply } = guardUndo(applied.map(flipCell), state, { ...guardOpts, restoreView: spec?.restoreView });
    if (!apply.some((c) => !isStamp(c))) return { ok: false, reason: "conflict" };
    config.beforeReplay?.(entry, "redo");
    const passes = planReplayPasses(apply, state, config, null, rowKeyOf);
    const after = sendsBefore(apply, [...(entry.outboxIds ?? []), ...(entry.replayOutboxIds ?? [])]);
    beginStep(entry, "redo", apply);
    passes.forEach((pass) => runPass(entry, pass, false, [], after, apply));
    config.afterReplay?.(entry, "redo", apply, "replay");
    return { ok: true, applied: apply.filter((c) => !isStamp(c)).length, skipped: entry.skipped?.length ?? 0 };
  };

  const redoGeneric = (entry: UndoEntry): UndoOutcome => {
    const state = get();
    const applied = internals.get(entry)?.applied ?? [];
    if (entry.skipped?.length) {
      for (const cell of applied) {
        if (cell.kind !== "protected" || isStamp(cell)) continue;
        if (!holdsBefore(cell, state, guardOpts)) return { ok: false, reason: "conflict" };
      }
      return redoPartial(entry, state, applied);
    }
    // Re-invoking the action writes every cell it touches, not only the ones
    // the undo wrote: a mirror cell, or a row that was already back at its
    // before value. So every captured cell must still hold its before value,
    // or the redo would overwrite a change someone made since the undo. A
    // cell the undo wrote is judged by the value it wrote (a writer's
    // spelled clear), a cell its spell left out by the after value it was
    // left at, and the rest by their captured before value.
    // A spell may turn a row the forward added into field cells (the row is
    // kept, as the server keeps it): those stand in for the captured row cell.
    const wrote = new Set(applied.map(cellKey));
    const judgedBy = new Map<string, CellChange>([
      ...(internals.get(entry)?.left ?? []).map((c) => [cellKey(c), flipCell(c)] as const),
      ...applied.map((c) => [cellKey(c), c] as const),
    ]);
    const capturedKeys = new Set((entry.changes ?? []).map(cellKey));
    const respelled = applied.filter((c) => !capturedKeys.has(cellKey(c)));
    const respelledRows = new Set(respelled.map(rowKeyOfCell));
    const stoodIn = (c: CellChange) => c.field === undefined && !wrote.has(cellKey(c)) && respelledRows.has(rowKeyOfCell(c));
    for (const captured of [...(entry.changes ?? []).filter((c) => !stoodIn(c)), ...respelled]) {
      const cell = judgedBy.get(cellKey(captured)) ?? captured;
      if (cell.kind === "view" || isStamp(cell)) continue;
      if (!holdsBefore(cell, state, guardOpts)) return { ok: false, reason: "conflict" };
    }
    const fn = entry.action ? state?.[entry.action] : undefined;
    if (typeof fn !== "function") return { ok: false, reason: "gone" };
    // Capture records only cells whose value changed, yet the re-invoke
    // writes every cell the action touches, including ones the forward wrote
    // with the value they already held. So the re-invoke is judged on its own
    // draft: a cell outside the ones judged above that it would change
    // (someone changed it since) drops the call, and the redo writes only the
    // captured after values instead, as after a partial undo. A row it adds
    // where none stands overwrites nothing.
    const judgedKeys = new Set(judgedBy.keys());
    for (const c of entry.changes ?? []) judgedKeys.add(cellKey(c));
    const spec = config.specs[entry.action!];
    let vetoed = false;
    const judge = (commit: { state: any; nextState: any; patches: Patch[] }) => {
      vetoed = captureCells(commit.patches, commit.state, commit.nextState, shape, spec).some(
        (c) => c.kind !== "view" && !isStamp(c) && !judgedKeys.has(cellKey(c)) && (c.field !== undefined || c.hadBefore),
      );
      return !vetoed;
    };
    config.beforeReplay?.(entry, "redo");
    // The undo's replay is superseded now: a late refusal of it does not
    // move a redone entry, unless this redo is refused and rolls back past
    // it (supersededReplay).
    const prior = {
      replayOutboxIds: entry.replayOutboxIds,
      replayDir: entry.replayDir,
      replaySent: entry.replaySent,
      supersededReplay: entry.supersededReplay,
      replayDeferred: entry.replayDeferred,
    };
    const after = sendsBefore(entry.changes ?? [], entry.replayOutboxIds ?? []);
    beginStep(entry, "redo", undefined);
    const priorAfter = redoAfter;
    const priorVet = redoVet;
    redoAfter = after;
    redoVet = { action: entry.action!, judge };
    try {
      withUndoRefresh(entry, () => swallow(fn(...(entry.args ?? []))));
    } finally {
      redoAfter = priorAfter;
      redoVet = priorVet;
    }
    if (vetoed) {
      Object.assign(entry, prior);
      return redoPartial(entry, get(), applied);
    }
    config.afterReplay?.(entry, "redo", entry.changes ?? [], "reinvoke");
    return { ok: true, applied: (entry.changes ?? []).filter((c) => !isStamp(c)).length, skipped: 0 };
  };

  return {
    wants(key, flags) {
      return (flags.act || flags.asyncAct) && !!config.specs[key] && !isUndoSuppressed();
    },
    orderAfter() {
      return redoAfter;
    },
    vetFor(key) {
      if (redoVet?.action !== key) return undefined;
      const { judge } = redoVet;
      redoVet = undefined;
      return judge;
    },
    capture(key, args, commit) {
      const spec = config.specs[key];
      if (!spec) return;
      // What the send carries, then what the entry keeps: the spec's ignored
      // fields go out with the send but are never undone.
      const sent = captureCells(commit.patches, commit.state, commit.finalState, shape, { captureKeys: spec.captureKeys });
      const ignored = new Set(spec.ignoreFields ?? []);
      const changes = ignored.size ? sent.filter((c) => c.field === undefined || !ignored.has(c.field)) : sent;
      const carriedMore = changes.length !== sent.length;
      const meaningful = changes.some((c) => !isStamp(c));
      const ctx: UndoCtx = {
        action: key,
        args,
        before: commit.state,
        after: commit.finalState,
        result: commit.returnValue,
        changes,
      };
      const planted = plantedEntries(commit.state?.pending, commit.finalState?.pending);

      const refresh = undoRefreshTarget();
      if (refresh && refresh.action === key) {
        if (!meaningful) return;
        // Everything that runs app code first, so a throwing spec leaves the
        // entry as it was rather than half refreshed.
        const internal = internalOf(spec, ctx);
        rebaseUndoneAfter(refresh, refresh.changes ?? [], changes);
        refresh.changes = changes;
        refresh.planted = planted;
        refresh.outboxIds = [commit.outboxId];
        noteSends(changes, [commit.outboxId], carriedMore);
        refresh.objects = objectsOf(changes);
        internals.set(refresh, internal);
        return;
      }

      if (!meaningful && !spec.external) return;
      const label = spec.label(ctx);
      if (label == null) return;
      const id = newUndoEntryId();
      if (spec.external) {
        recordUndoEntry({
          id,
          label,
          ts: Date.now(),
          status: "external",
          external: spec.external,
          action: key,
          args,
          mode: "generic",
          undo: () => ({ ok: false, reason: "gone" }),
          redo: () => ({ ok: false, reason: "gone" }),
        });
        return;
      }
      const entry: UndoEntry = {
        id,
        label,
        ts: Date.now(),
        status: "done",
        mode: "generic",
        action: key,
        args,
        changes,
        planted,
        outboxIds: [commit.outboxId],
        objects: objectsOf(changes),
        ...((typeof spec.confirm === "function" ? spec.confirm(ctx) : spec.confirm) ? { confirm: true } : {}),
        undo: () => undoGeneric(entry),
        redo: () => redoGeneric(entry),
      };
      internals.set(entry, internalOf(spec, ctx));
      noteSends(changes, [commit.outboxId], carriedMore);
      recordUndoEntry(entry, { toast: spec.toast, coalesce: spec.coalesce });
    },
  };
}
