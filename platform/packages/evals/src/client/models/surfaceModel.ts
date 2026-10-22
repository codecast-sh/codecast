// What the surface page decides (evals-ui.md 4.2): its filters, the pinned
// pair and the ledger's order. Pure, beside SurfaceView.

import { flipDirection, majorityOfCount } from "../../analysis";
import type { LedgerCell, LedgerRow, VerdictFlip } from "../../contract";
import type { SurfaceColumn } from "./seismographModel";

/** One column of the ledger's plate: a batch, or every batch of one day. */
export interface LedgerColumn {
  /** The batch name, or the day's (YYYY-MM-DD, local). */
  key: string;
  at: number;
  /** Its batches, oldest first. */
  batches: string[];
  /** The batch a click pins and a hover marks: its newest. */
  batch: string;
}

export interface PlateRow extends LedgerRow {
  /** By column key: the newest batch the freeze ran in that column, which its well opens. */
  batchOf: Record<string, string>;
}

export interface LedgerPlate {
  by: "batch" | "day";
  columns: LedgerColumn[];
  /** Cells keyed by column; flips as the server counted them, run to run. */
  rows: PlateRow[];
}

/** Below this share of the surface's freezes in its typical batch, the plate draws a column per day. */
export const SPARSE_BATCH_SHARE = 0.5;

const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * The ledger's columns, chosen from the surface's batch density. Where a
 * typical batch runs most freezes, one column per batch, the rows as the
 * server sent them. Where it runs few (a product whose gate runs take one or
 * two cases), a column per batch is a blank plate, so a column holds a day:
 * each well pools every rep of the freeze that day, its majority taken over
 * all of them, and its notch marks that majority moving from the freeze's
 * previous day with one. A row's flips stay the server's count, run to run on
 * the same footing, so the ranking reads the same at either density.
 */
export function ledgerPlate(rows: readonly LedgerRow[], columns: readonly SurfaceColumn[]): LedgerPlate {
  const counts = columns.map((c) => rows.filter((r) => r.cells[c.batch]).length).sort((a, b) => a - b);
  const typical = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
  if (!rows.length || typical >= rows.length * SPARSE_BATCH_SHARE) {
    return {
      by: "batch",
      columns: columns.map((c) => ({ key: c.batch, at: c.at, batches: [c.batch], batch: c.batch })),
      rows: rows.map((r) => ({ ...r, batchOf: Object.fromEntries(Object.keys(r.cells).map((b) => [b, b])) })),
    };
  }
  const days = new Map<string, LedgerColumn>();
  for (const c of [...columns].sort((a, b) => a.at - b.at)) {
    const key = dayKey(c.at);
    const day = days.get(key) ?? days.set(key, { key, at: c.at, batches: [], batch: c.batch }).get(key)!;
    day.batches.push(c.batch);
    day.batch = c.batch;
  }
  const plate = [...days.values()];
  return {
    by: "day",
    columns: plate,
    rows: rows.map((r) => {
      const row: PlateRow = { ...r, cells: {}, batchOf: {} };
      let before: boolean | null = null;
      for (const col of plate) {
        const ran = col.batches.filter((b) => r.cells[b]);
        if (!ran.length) continue;
        const cells = ran.map((b) => r.cells[b]!);
        const scored = cells.filter((c) => c.majority !== null);
        const reps = cells.reduce((s, c) => s + c.reps, 0);
        const meant = cells.filter((c) => c.mean !== null);
        const meanReps = meant.reduce((s, c) => s + c.reps, 0);
        const majority = scored.length ? majorityOfCount(scored.reduce((s, c) => s + c.passed, 0), scored.reduce((s, c) => s + c.reps, 0)) : null;
        const flip = before !== null && majority !== null ? flipDirection(before, majority) : null;
        if (majority !== null) before = majority;
        const cell: LedgerCell = {
          reps,
          passed: cells.reduce((s, c) => s + c.passed, 0),
          mean: meanReps ? meant.reduce((s, c) => s + c.mean! * c.reps, 0) / meanReps : null,
          majority,
          flip,
        };
        row.cells[col.key] = cell;
        row.batchOf[col.key] = ran.at(-1)!;
      }
      return row;
    }),
  };
}

/** The plate's column holding a batch (a pin or a ?batch= link), or null when none does. */
export const plateColumnOf = (plate: LedgerPlate, batch: string | null): LedgerColumn | null => (batch ? plate.columns.find((c) => c.batches.includes(batch)) ?? null : null);

/**
 * The freezes that flipped between the pinned pair first (broke before
 * fixed), then most lifetime flips, then by name: the freezes that moved are
 * the ones to read, and the pinned pair's are the ones that explain it.
 */
export function ledgerOrder<T extends LedgerRow>(rows: readonly T[], pairFlips: ReadonlyMap<string, VerdictFlip["direction"]> | null = null): T[] {
  const rank = (r: LedgerRow) => (pairFlips?.get(r.freezeId) === "broke" ? 0 : pairFlips?.has(r.freezeId) ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || b.flips - a.flips || a.name.localeCompare(b.name));
}

/** `all`, `named` (outside any cadence), or one cadence by name. */
export type SurfaceCadence = string;

/** What the page asks the api for (cadence, model, dry, bisect) and what it hides itself (dirty). */
export interface SurfaceFilters {
  cadence: SurfaceCadence;
  model: string | null;
  dry: boolean;
  bisect: boolean;
  dirty: boolean;
}

export const DEFAULT_SURFACE_FILTERS: SurfaceFilters = { cadence: "all", model: null, dry: false, bisect: false, dirty: true };

/** The order of two pinned batches: the earlier is the baseline. */
export function orderedPair(cols: Map<string, SurfaceColumn>, x: string, y: string): [string, string] {
  const ax = cols.get(x)?.at ?? 0;
  const ay = cols.get(y)?.at ?? 0;
  return ax <= ay ? [x, y] : [y, x];
}

/** Clicking pins one batch; shift-clicking pins a second. Clicking the only pin again unpins it. */
export function nextPins(pinned: string | null, compare: string | null, batch: string, second: boolean): [string | null, string | null] {
  if (!second || !pinned) return pinned === batch && !compare ? [null, null] : [batch, null];
  if (batch === pinned) return [pinned, null];
  return [pinned, batch];
}
