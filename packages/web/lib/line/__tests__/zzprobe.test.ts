import { test } from "bun:test";
import { buildLineMap } from "../lineMap";
import { buildLineTrace, resolveTraceRef } from "../lineTrace";
import * as F from "./lineFixtures";
test("probe", () => {
  const m = buildLineMap({ ...F.rows, finders: F.finders, now: F.NOW, windowMs: 30 * F.DAY });
  const edges = new Set(m.edges.map((e) => e.id));
  for (const t of F.rows.tasks) {
    const tr = buildLineTrace(t as any, F.rows as any, { now: F.NOW });
    const p = tr.pathNodeIds;
    const missing = p.slice(1).map((n, i) => `${p[i]}->${n}`).filter((e) => !edges.has(e));
    console.log(t.short_id, tr.outcome, missing.join(" | "));
  }
});
