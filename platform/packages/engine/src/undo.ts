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
import { sameShape } from "./syncProtocol";
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
  onUndoRekey,
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
  spec?: Pick<UndoSpec, "ignoreFields">,
): CellChange[] {
  const ignoreFields = new Set(spec?.ignoreFields ?? []);
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
      include: (key) => !shape.ignoreKeys?.has(key),
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
};

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
  const cur = readCell(state, cell, opts.rowKeyOf);
  if (cell.field === undefined && cell.shape !== "scalar") {
    // Forward added the row: take it back only while it is the row it added.
    if (!cell.hadBefore && cell.hadAfter) {
      if (!cur.has) return "already";
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
  const cur = readCell(state, cell, opts.rowKeyOf);
  if (cell.field === undefined && cell.shape !== "scalar") {
    if (!cell.hadBefore && cell.hadAfter) return !cur.has;
    if (cell.hadBefore && !cell.hadAfter) return cur.has;
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
    if (!cur || cur.type !== entry.type || (cur.ts ?? 0) !== (entry.ts ?? 0) || !sameShape(cur.value, entry.value)) continue;
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
    opts?: { onCommitted?: (commit: { outboxId: string }) => void },
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
  frame: Pick<UndoCtx, "before" | "after" | "result">;
};

export type UndoController = {
  /** Whether a call of `key` should be captured right now. */
  wants: (key: string, flags: Flags) => boolean;
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
    const internal = internals.get(entry);
    if (!internal) return false;
    const inverse = internal.inverse?.map((inv) => ({ ...inv, args: rekeyIds(inv.args, oldId, newId) })) ?? null;
    const applied = rekeyCells(internal.applied, oldId, newId);
    const touched = applied !== internal.applied || inverse?.some((inv, i) => inv.args !== internal.inverse![i]!.args) === true;
    if (touched) internals.set(entry, { ...internal, inverse, applied });
    return touched;
  });

  const isStamp = (c: CellChange) => c.field !== undefined && !!config.stampFields?.has(c.field);
  const guardOpts = {
    rowKeyOf,
    rowGroupOf: shape.rowGroupOf,
    stampFields: config.stampFields,
    optionalClearFields: shape.optionalClearFields,
    serverAssignedFields: config.serverAssignedFields,
  };

  const internalOf = (spec: UndoSpec, ctx: UndoCtx): Internal => ({
    inverse: spec.inverse?.(ctx) ?? null,
    applied: [],
    frame: { before: ctx.before, after: ctx.after, result: ctx.result },
  });

  const runPass = (entry: UndoEntry, pass: ReplayPass, first: boolean, skippedRows: Array<{ store: string; id: string }>) => {
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
        },
      }),
    );
    swallow(result);
  };

  const undoGeneric = (entry: UndoEntry): UndoOutcome => {
    const state = get();
    const spec = entry.action ? config.specs[entry.action] : undefined;
    const guarded = guardUndo(entry.changes ?? [], state, { ...guardOpts, restoreView: spec?.restoreView });
    const { skippedRows, held, mirrorConflicts } = guarded;
    const cleared = spellClears(guarded.apply, config.writers);
    const internal = internals.get(entry);
    const recorded = (): UndoCtx | undefined =>
      internal && { ...internal.frame, action: entry.action!, args: entry.args ?? [], changes: entry.changes ?? [] };
    const apply = spec?.spell ? spec.spell(cleared, recorded()) : cleared;
    entry.skipped = skippedRows;
    // No row applies when every protected row conflicted, even if a mirror
    // could still be restored: a mirror alone is not the user's change.
    const rowApplied = apply.some((c) => c.kind === "protected" && !isStamp(c));
    if (apply.length === 0 && skippedRows.length === 0 && mirrorConflicts.length === 0) {
      // Every row already holds its before value: nothing to take back.
      if (internal) internal.applied = [];
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
    entry.replayOutboxIds = [];
    entry.replayDir = "undo";
    passes.forEach((pass, i) => runPass(entry, pass, i === 0, held));
    if (internal) internal.applied = apply;
    config.afterReplay?.(entry, "undo", apply);
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
    entry.replayOutboxIds = [];
    entry.replayDir = "redo";
    passes.forEach((pass) => runPass(entry, pass, false, []));
    config.afterReplay?.(entry, "redo", apply);
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
    // spelled clear), the rest by their captured before value.
    // A spell may turn a row the forward added into field cells (the row is
    // kept, as the server keeps it): those stand in for the captured row cell.
    const cellKey = (c: CellChange) => `${rowKeyOfCell(c)}\u0000${c.field ?? "\u0001"}`;
    const wrote = new Map(applied.map((c) => [cellKey(c), c]));
    const capturedKeys = new Set((entry.changes ?? []).map(cellKey));
    const respelled = applied.filter((c) => !capturedKeys.has(cellKey(c)));
    const respelledRows = new Set(respelled.map(rowKeyOfCell));
    const stoodIn = (c: CellChange) => c.field === undefined && !wrote.has(cellKey(c)) && respelledRows.has(rowKeyOfCell(c));
    for (const captured of [...(entry.changes ?? []).filter((c) => !stoodIn(c)), ...respelled]) {
      const cell = wrote.get(cellKey(captured)) ?? captured;
      if (cell.kind === "view" || isStamp(cell)) continue;
      if (!holdsBefore(cell, state, guardOpts)) return { ok: false, reason: "conflict" };
    }
    const fn = entry.action ? state?.[entry.action] : undefined;
    if (typeof fn !== "function") return { ok: false, reason: "gone" };
    config.beforeReplay?.(entry, "redo");
    // The undo's replay is settled business now: a late refusal of it must
    // not move a redone entry.
    entry.replayOutboxIds = undefined;
    entry.replayDir = undefined;
    withUndoRefresh(entry, () => swallow(fn(...(entry.args ?? []))));
    config.afterReplay?.(entry, "redo", entry.changes ?? []);
    return { ok: true, applied: (entry.changes ?? []).filter((c) => !isStamp(c)).length, skipped: 0 };
  };

  return {
    wants(key, flags) {
      return (flags.act || flags.asyncAct) && !!config.specs[key] && !isUndoSuppressed();
    },
    capture(key, args, commit) {
      const spec = config.specs[key];
      if (!spec) return;
      const changes = captureCells(commit.patches, commit.state, commit.finalState, shape, spec);
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
        refresh.changes = changes;
        refresh.planted = planted;
        refresh.outboxIds = [commit.outboxId];
        refresh.objects = objectsOf(changes);
        internals.set(refresh, internalOf(spec, ctx));
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
      recordUndoEntry(entry, { toast: spec.toast, coalesce: spec.coalesce });
    },
  };
}
