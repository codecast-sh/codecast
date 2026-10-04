// What the surface page decides (evals-ui.md 4.2): its filters, the pinned
// pair and the ledger's order. Pure, beside SurfaceView.

import type { LedgerRow, VerdictFlip } from "@codecast/shared/contracts/evalsApi";
import type { SurfaceColumn } from "./seismographModel";

/**
 * The freezes that flipped between the pinned pair first (broke before
 * fixed), then most lifetime flips, then by name: the freezes that moved are
 * the ones to read, and the pinned pair's are the ones that explain it.
 */
export function ledgerOrder(rows: readonly LedgerRow[], pairFlips: ReadonlyMap<string, VerdictFlip["direction"]> | null = null): LedgerRow[] {
  const rank = (r: LedgerRow) => (pairFlips?.get(r.freezeId) === "broke" ? 0 : pairFlips?.has(r.freezeId) ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || b.flips - a.flips || a.name.localeCompare(b.name));
}

export type SurfaceCadence = "all" | "nightly" | "named";

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
