// The Multiplayer sim catalog's grid, folded from the session history
// (docs/architecture/evals-ui.md 4.6): each scenario in each of its modes,
// with its newest result, its newest failure that left an artifact folder,
// its history per session, and how many failures each invariant caught.
//
// A leaf with no runtime imports, like replay.ts, so the eval tool's api child
// (packages/evals/src/api/simHistory.ts) and the web fixture world
// (components/evals/__fixtures__/world.ts) fold the same history the same way.
// Reading a failure's result.json is the caller's job (`invariantOf`).
import type { SimCatalogResponse, SimGridCell, SimMode, SimRunRow, SimScenario, SimSession } from "@codecast/shared/contracts/evalsApi";

/**
 * The grid over `sessions`, newest first (unsessioned legacy folders are left
 * out). `latest` is the cell's newest session: a failure with a folder there
 * wins, so its glyph says failed. `newestFailure` is the newest failing run
 * whose result.json names an invariant: what a click on the cell opens, even
 * after a later session passed, and what the invariant filter reads.
 * `invariantOf` reads that invariant (null when there is no result.json or
 * the run passed after all).
 */
export function simGridOf(
  scenarios: ReadonlyArray<Pick<SimScenario, "name" | "modes">>,
  sessions: ReadonlyArray<{ session: SimSession; runs: readonly SimRunRow[] }>,
  invariantOf: (session: string, dir: string) => string | null,
): Pick<SimCatalogResponse, "grid" | "caught"> {
  const cells = new Map<string, SimGridCell>();
  const cell = (scenario: string, mode: SimMode): SimGridCell => {
    const k = `${scenario}\x1f${mode}`;
    let c = cells.get(k);
    if (!c) {
      c = { scenario, mode, latest: null, history: [], gitHead: null, lastRunAt: null, newestFailure: null };
      cells.set(k, c);
    }
    return c;
  };
  for (const s of scenarios) for (const m of s.modes) cell(s.name, m as SimMode);
  const caught: Record<string, number> = {};
  // Oldest first, so each later session overwrites `latest` and `newestFailure`.
  for (const { session, runs } of [...sessions].filter((x) => !x.session.unsessioned).reverse()) {
    const by = new Map<string, SimRunRow[]>();
    for (const r of runs) by.set(`${r.scenario}\x1f${r.mode}`, [...(by.get(`${r.scenario}\x1f${r.mode}`) ?? []), r]);
    for (const [, rs] of by) {
      const c = cell(rs[0]!.scenario, rs[0]!.mode);
      const failed = rs.filter((r) => !r.passed);
      c.history.push({ session: session.id, seeds: rs.length, failed: failed.length });
      const pick = failed.find((r) => r.dir) ?? failed[0] ?? rs[rs.length - 1]!;
      c.latest = { session: session.id, run: pick.dir ?? null, seed: pick.seed, passed: pick.passed, at: session.startedAt };
      c.gitHead = session.gitHead;
      c.lastRunAt = session.startedAt;
      let newest: SimGridCell["newestFailure"] = null;
      for (const r of failed) {
        const inv = r.dir ? invariantOf(session.id, r.dir) : null;
        if (!inv) continue;
        caught[inv] = (caught[inv] ?? 0) + 1;
        // The session's first failure with artifacts, the run `latest` picks.
        newest ??= { session: session.id, run: r.dir!, seed: r.seed, invariant: inv, at: session.startedAt };
      }
      if (newest) c.newestFailure = newest;
    }
  }
  return { grid: [...cells.values()], caught };
}
