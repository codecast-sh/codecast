import { test } from "bun:test";
import { buildLineMap } from "../lineMap";
import * as F from "./lineFixtures";
test("probe", () => {
  const extra = { _id: "sig_old", short_id: "sg-9", task_id: "task_d", created_at: F.NOW - 20 * F.DAY, source: "sentry", kind: "bug", title: "old", observed_at: F.NOW - 20 * F.DAY } as any;
  const m = buildLineMap({ ...F.rows, signals: [...F.rows.signals, extra], finders: F.finders, now: F.NOW, windowMs: 30 * F.DAY });
  const src = m.nodes.filter((n) => n.kind === "source").map((n) => [n.id, n.through]);
  console.log(JSON.stringify(src), m.nodes.find((n) => n.id === "signals")!.through);
  for (const e of m.edges) if (e.count) console.log(e.id, e.count, e.kind);
  for (const n of m.nodes) console.log(n.id, "now", n.now.length, "through", n.through, "failed", n.failed, JSON.stringify(n.marks));
});
