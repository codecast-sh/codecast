// A flow's stations as the phone lists them, top to bottom: the main path
// numbered, the branches of a fan-out lettered under it, and each step's ways
// out that the list's order does not already say. A side step hangs under the
// route that leads to it (check failed → Fix check, back to Check), so the
// main path reads straight down. Pure, so it is tested without React Native.
import type { FlowStation, FoldedFlow } from '@codecast/shared/contracts/flowPool';

export type StepRoute = {
  when: string | null;
  to: string;
  toId: string;
  /** back: to an earlier step (a loop); side: to a step off the main path; end: the run ends. */
  kind: 'back' | 'side' | 'end';
  /** The side step this route leads to, drawn under it the first time a route reaches it. */
  detour?: StepRow;
};

export type StepRow = {
  station: FlowStation;
  /** "1", "2", "3a" on the main path; null for a side step. */
  mark: string | null;
  /** A branch of a fan-out: it runs beside its siblings. */
  branch: boolean;
  routes: StepRoute[];
};

/** The main path's rows, each side step under the first route to reach it, and
 *  the side steps no route on the path reaches (`loose`). `end` is where a
 *  passing run ends, when the path's last step says so. */
export function flowSteps(flow: Pick<FoldedFlow, 'stations'>): { rows: StepRow[]; loose: StepRow[]; end: string | null } {
  const at = new Map(flow.stations.map((s, i) => [s.id, i]));
  const byId = new Map(flow.stations.map((s) => [s.id, s]));
  const branchOf = new Map<string, string>();
  for (const s of flow.stations) if (s.kind === 'parallel') for (const n of s.next) branchOf.set(n.toId, s.id);
  const main = flow.stations.filter((s) => s.main);
  // Where a passing step goes on to: the next main station that is not a sibling branch.
  const onward = new Map<string, string>();
  for (let i = 0; i < main.length; i++) {
    const parent = branchOf.get(main[i].id);
    const next = main.slice(i + 1).find((m) => !parent || branchOf.get(m.id) !== parent);
    if (next) onward.set(main[i].id, next.id);
  }
  const placed = new Set(main.map((s) => s.id));
  const routesOf = (s: FlowStation, nest: boolean): StepRoute[] => {
    const i = at.get(s.id)!;
    const out: StepRoute[] = [];
    for (const r of s.next) {
      if (s.kind === 'parallel' && branchOf.get(r.toId) === s.id) continue;
      if (onward.get(s.id) === r.toId) continue;
      const target = byId.get(r.toId);
      const j = at.get(r.toId);
      const route: StepRoute = { when: r.when, to: r.to, toId: r.toId, kind: j === undefined ? 'end' : target?.main || j <= i ? 'back' : 'side' };
      if (nest && target && !target.main && !placed.has(target.id)) {
        placed.add(target.id);
        route.kind = 'side';
        route.detour = { station: target, mark: null, branch: false, routes: routesOf(target, true) };
      }
      out.push(route);
    }
    return out;
  };
  let n = 0;
  let letter = 0;
  let lastParallel: string | null = null;
  const rows = main.map((s) => {
    const parent = branchOf.get(s.id);
    let mark: string;
    if (parent && parent === lastParallel) mark = `${n}${String.fromCharCode(97 + letter++)}`;
    else { n += 1; letter = 0; mark = String(n); }
    if (s.kind === 'parallel') lastParallel = s.id;
    return { station: s, mark, branch: !!parent, routes: routesOf(s, true) };
  });
  const loose = flow.stations.filter((s) => !placed.has(s.id)).map((s) => ({ station: s, mark: null, branch: false, routes: routesOf(s, false) }));
  // The path's last step ends the run where it passes to: its one unconditioned end.
  const last = rows[rows.length - 1];
  const passEnd = last?.routes.find((r) => r.kind === 'end' && !r.when) ?? (last?.routes.length === 1 && last.routes[0].kind === 'end' ? last.routes[0] : undefined);
  if (last && passEnd) last.routes = last.routes.filter((r) => r !== passEnd);
  return { rows, loose, end: passEnd?.to ?? null };
}
