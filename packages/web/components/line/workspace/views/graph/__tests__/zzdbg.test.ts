import { test } from "bun:test";
import { buildLineModel } from "../../../../../../lib/line/lineModel";
import { agentwatchGraph } from "../../../../../../lib/line/__tests__/agentwatchGraph.fixture";
import { computeLayout } from "../graphLayout";
test("dbg", () => {
  const m = buildLineModel({ runs: [{ _id: "r0", task_id: "t1", workflow_slug: "agentwatch", created_at: 1, updated_at: 1, graph_nodes: [{ id: "dissolve" }] } as any], tasks: [] , graph: agentwatchGraph }, "agentwatch");
  const L = computeLayout(m.graph, { mode: "essence", wrap: 1500 });
  for (const n of L.list) console.log(n.id.padEnd(16), "row", n.row, "lane", n.lane, "x", Math.round(n.x), "y", Math.round(n.y), "w", n.w, "h", n.h, n.dot ? "dot" : "");
  console.log(JSON.stringify(L.lanes));
  for (const e of L.edges) if (e.shape === "wrap" || e.shape === "back") console.log(e.id, e.shape);
});
