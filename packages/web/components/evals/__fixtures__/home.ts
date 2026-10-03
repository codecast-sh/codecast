// The wall's fixtures (U7): GET /overview from the fixture world at a fixed
// clock, and a quiet variant with nothing worse, nothing moved, no bisect and
// no Multiplayer sim session, for the empty states.

import type { OverviewResponse } from "@codecast/shared/contracts/evalsApi";
import { evalsFixtureWorld } from "./world";

export const HOME_NOW = Date.parse("2026-10-03T12:00:00.000Z");

export function homeFixture(opts: { now?: number; cadence?: string } = {}): OverviewResponse {
  const world = evalsFixtureWorld({ now: opts.now ?? HOME_NOW });
  return world.answer("GET /overview", {}, { cadence: opts.cadence ?? "all" }) as OverviewResponse;
}

/** The same wall with every story taken out: no row separated worse and nothing to report. */
export function quietHomeFixture(opts: { now?: number } = {}): OverviewResponse {
  const base = homeFixture(opts);
  return {
    ...base,
    surfaces: base.surfaces.map((s) => ({
      ...s,
      landing: false,
      latest: s.latest ? { ...s.latest, separation: { kind: "not-separated", p: 0.5 }, regression: false, flips: [] } : null,
    })),
    moved: [],
    bisects: [],
    sim: null,
  };
}
