// The surface chart's geometry (evals-ui.md 4.2): one x per batch shared by
// every track, epoch bands, and where a rep sits. Pure, beside Seismograph.

import type { BatchStats, Epoch, RunRow } from "@codecast/shared/contracts/evalsApi";
import { linear } from "./charts/scale";

// ── Columns: one x per batch, shared by every track on the page ─────────────

export type SurfaceAxis = "time" | "ordinal";

export interface SurfaceColumn {
  batch: string;
  at: number;
  x: number;
  stats: BatchStats;
}

export interface SurfaceColumns {
  list: SurfaceColumn[];
  /** By batch name. */
  byBatch: Map<string, SurfaceColumn>;
  /** The x of a time; in ordinal mode, the x of the column at or after it. */
  xOfTime: (at: number) => number;
  /** A typical distance between neighbouring columns, px. */
  gap: number;
  width: number;
  padL: number;
  padR: number;
  axis: SurfaceAxis;
}

export const SEIS_PAD_L = 38;
export const SEIS_PAD_R = 14;
export const HOUR = 3_600_000;

/** Where each batch sits across `width`: by when it began, or evenly by order. */
export function surfaceColumns(batches: readonly BatchStats[], axis: SurfaceAxis, width: number, padL = SEIS_PAD_L, padR = SEIS_PAD_R): SurfaceColumns {
  const sorted = [...batches].sort((a, b) => Date.parse(a.batchAt) - Date.parse(b.batchAt));
  const ats = sorted.map((b) => Date.parse(b.batchAt));
  const inner = Math.max(40, width - padL - padR);
  let xs: number[];
  let xOfTime: (at: number) => number;
  if (axis === "time" && sorted.length > 0) {
    const span = ats[ats.length - 1] - ats[0];
    const margin = Math.max(span * 0.02, 2 * HOUR);
    const x = linear(ats[0] - margin, ats[ats.length - 1] + margin, padL, padL + inner);
    xs = ats.map(x);
    xOfTime = x;
  } else {
    const step = inner / Math.max(1, sorted.length);
    xs = sorted.map((_, i) => padL + (i + 0.5) * step);
    xOfTime = (at) => {
      const i = ats.findIndex((t) => t >= at);
      return i < 0 ? padL + inner : xs[i];
    };
  }
  const gaps = xs.slice(1).map((v, i) => v - xs[i]).sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : inner;
  const list = sorted.map((stats, i) => ({ batch: stats.batch, at: ats[i], x: xs[i], stats }));
  return { list, byBatch: new Map(list.map((c) => [c.batch, c])), xOfTime, gap, width, padL, padR, axis };
}

/** What the epoch bands need of a column layout: each batch's x and time, and the plot's edges. The freeze page's strip lays its own columns out and draws the same bands. */
export interface ColumnRail {
  list: ReadonlyArray<{ batch: string; at: number; x: number }>;
  width: number;
  padL: number;
  padR: number;
}

/** The x where an epoch begins: halfway between the last column before it and its first. Null when it begins after the window. */
export function epochStartX(cols: ColumnRail, epoch: Pick<Epoch, "firstBatch" | "firstBatchAt">): number | null {
  const at = Date.parse(epoch.firstBatchAt);
  const i = cols.list.findIndex((c) => c.batch === epoch.firstBatch || c.at >= at);
  if (i < 0) return null;
  if (i === 0) return cols.padL;
  return (cols.list[i - 1].x + cols.list[i].x) / 2;
}

export interface EpochBand {
  n: number;
  x0: number;
  x1: number;
  /** A perforation marks where it began: every epoch but one that opens the window. */
  boundary: boolean;
  changed: number;
}

/** Each epoch's span across the columns, clipped to the plot. */
export function epochBandsOf(cols: ColumnRail, epochs: readonly Epoch[]): EpochBand[] {
  const { list, width: w, padL, padR } = cols;
  const sorted = [...epochs].sort((a, b) => a.n - b.n);
  const out: EpochBand[] = [];
  sorted.forEach((e, i) => {
    const start = epochStartX(cols, e);
    if (start === null) return;
    const next = sorted[i + 1] ? epochStartX(cols, sorted[i + 1]) : null;
    const x0 = Math.max(padL, start);
    const x1 = Math.min(w - padR, next ?? w - padR);
    if (x1 <= padL || x0 >= w - padR || x1 - x0 < 1) return;
    const firstCol = list.find((c) => c.batch === e.firstBatch || c.at >= Date.parse(e.firstBatchAt));
    out.push({ n: e.n, x0, x1, boundary: e.n > 1 && !!firstCol && firstCol !== list[0], changed: e.changedFreezes.length });
  });
  return out;
}

// ── One rep's mark, shared with the freeze page's strip ─────────────────────

export const REP_HATCH_ID = "ev-sf-hatch";

export const scoredRep = (r: RunRow) => r.score !== null && (r.status === "pass" || r.status === "fail");
/** A failed hard gate: the rep is drawn at 0 with a red tick, whatever the judge scored. */
export const gateDropped = (r: RunRow) => r.status === "fail" && r.gatesFailed.length > 0;

/** Where a rep sits on a score axis: a gate failure at 0, an unscored rep just under the axis, else its score. */
export function repY(row: RunRow, y: (v: number) => number): number {
  if (!scoredRep(row)) return y(0) + 9;
  return y(gateDropped(row) ? 0 : (row.score as number));
}

/** The median of a list, or null for an empty one. */
export function medianOf(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
