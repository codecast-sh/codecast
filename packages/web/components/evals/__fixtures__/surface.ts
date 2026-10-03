// The surface page's fixtures (U8): GET /surface/:id from the fixture world at
// a fixed clock, the newest worse pair (the batch before the regression and
// the regressed one) with its GET /batches answer, and the newest epoch with
// its GET /epoch answer. settle carries the regression, insight the model
// move, title the judge ruler move.

import type { BatchesResponse, EpochResponse, SurfaceResponse } from "@codecast/shared/contracts/evalsApi";
import { evalsFixtureWorld } from "./world";

export const SURFACE_NOW = Date.parse("2026-10-03T12:00:00.000Z");

export interface SurfaceFixture {
  data: SurfaceResponse;
  /** The newest two graded batches, earlier first: on settle, the regression. */
  pair: [string, string];
  batches: BatchesResponse;
  epoch: EpochResponse;
}

export function surfaceFixture(opts: { surface?: string; now?: number; query?: Record<string, string> } = {}): SurfaceFixture {
  const world = evalsFixtureWorld({ now: opts.now ?? SURFACE_NOW });
  const id = opts.surface ?? "settle";
  const data = world.answer("GET /surface/:id", { id }, opts.query ?? {}) as SurfaceResponse;
  const graded = data.batches.filter((b) => !b.dry);
  const pair: [string, string] = [graded[graded.length - 2].batch, graded[graded.length - 1].batch];
  const batches = world.answer("GET /batches", {}, { surface: id, a: pair[0], b: pair[1] }) as BatchesResponse;
  const newest = Math.max(...data.epochs.map((e) => e.n));
  const epoch = world.answer("GET /epoch", {}, { surface: id, n: String(newest) }) as EpochResponse;
  return { data, pair, batches, epoch };
}
