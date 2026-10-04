// The freeze page's fixture: settle's regression from the fixture world, on a
// freeze that broke in the newest epoch, with the surface ledger row, the
// footing, the default pair and both cards' run records. FreezeView takes it as
// props in the mount test and in a static rig.

import type { FootingMarker, FreezeResponse, LedgerCell, RunResponse, SurfaceResponse } from "@codecast/shared/contracts/evalsApi";
import { defaultFreezePair, type DefaultFreezePair } from "../FreezeView";
import { evalsFixtureWorld } from "./world";

export interface FreezeFixture {
  freeze: FreezeResponse;
  cells: Record<string, LedgerCell>;
  footing: FootingMarker[];
  pick: DefaultFreezePair;
  runs: Record<string, RunResponse>;
  /** The same freeze with every flip taken out of its ledger row: the no-flip fallback. */
  steady: { freeze: FreezeResponse; cells: Record<string, LedgerCell> };
}

export function freezeFixture(now = Date.parse("2026-10-03T12:00:00.000Z")): FreezeFixture {
  const world = evalsFixtureWorld({ now });
  const surface = world.answer("GET /surface/:id", { id: "settle" }, {}) as SurfaceResponse;
  // settle's regression: unresolvable-error held for a month, then broke at the newest epoch, where the prompt changed.
  const flipped = surface.ledger.find((r) => r.name === "unresolvable-error")!;
  const freeze = world.answer("GET /freeze/:id", { id: flipped.freezeId }, {}) as FreezeResponse;
  const pick = defaultFreezePair(freeze.runs, flipped.cells, null);
  const runs: Record<string, RunResponse> = {};
  for (const r of freeze.runs) runs[r.id] = world.answer("GET /run/:id", { id: r.id }, {}) as RunResponse;
  return {
    freeze,
    cells: flipped.cells,
    footing: surface.footing,
    pick,
    runs,
    steady: { freeze, cells: Object.fromEntries(Object.entries(flipped.cells).map(([b, c]) => [b, { ...c, flip: null }])) },
  };
}
