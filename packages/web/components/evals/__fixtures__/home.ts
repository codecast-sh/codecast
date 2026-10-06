// The wall's fixtures (U7): GET /overview from the fixture world on today's
// clock (the handler weighs the wall against the real one: its 30-day window
// and a batch still landing), and a quiet variant with nothing worse, nothing moved, no bisect and
// no Multiplayer sim session, for the empty states.

import type { OverviewResponse } from "@codecast/shared/contracts/evalsApi";
import { evalsFixtureWorld, fixtureWorldNow } from "./world";

export const HOME_NOW = fixtureWorldNow();

export function homeFixture(opts: { now?: number; cadence?: string } = {}): Promise<OverviewResponse> {
  return evalsFixtureWorld({ now: opts.now ?? HOME_NOW }).answer("GET /overview", {}, { cadence: opts.cadence ?? "all" });
}

/** The same wall with every story taken out: no row separated worse and nothing to report. */
export async function quietHomeFixture(opts: { now?: number } = {}): Promise<OverviewResponse> {
  const base = await homeFixture(opts);
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
