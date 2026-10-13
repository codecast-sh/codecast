// A run lit on the Graph view (line-workspace.md LW1): where each step first
// sits in its path, the edges it crossed, and how often it came back.
import type { LineRunModel } from "../../../../../lib/line/lineModel";

export type LitRun = { order: Map<string, number>; times: Map<string, number>; hot: Set<string> };
export function litRun(run: LineRunModel | null | undefined): LitRun | null {
  if (!run) return null;
  const order = new Map<string, number>();
  const times = new Map<string, number>();
  const hot = new Set<string>();
  run.visits.forEach((v, i) => {
    if (!order.has(v.node)) order.set(v.node, i + 1);
    times.set(v.node, (times.get(v.node) ?? 0) + 1);
    const next = run.visits[i + 1];
    if (next) hot.add(`${v.node}->${next.node}`);
  });
  return { order, times, hot };
}

