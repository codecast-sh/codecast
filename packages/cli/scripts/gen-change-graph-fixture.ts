#!/usr/bin/env bun
// Writes the journey presenter's test graph (packages/web/lib/ship/__tests__/changeGraph.fixture.json) from a change
// flow's source, parsed with its segments expanded as the web's shipped snapshot is (shippedFlows.ts), plus each
// station's timeout, which the run card turns into a deadline, and whether an exit is the machine's.
//
//   bun packages/cli/scripts/gen-change-graph-fixture.ts [path/to/change.cast]
//   git show <ref>:packages/cli/src/workflow/templates/change.cast > /tmp/change.cast   # a flow another branch holds
import * as fs from "fs";
import * as path from "path";
import { parseWorkflowSource } from "../src/workflow/parser";

const root = path.resolve(import.meta.dir, "../../..");
const src = fs.readFileSync(process.argv[2] ?? path.join(root, "packages/cli/src/workflow/templates/change.cast"), "utf8");
const FIELDS = ["id", "label", "shape", "type", "backend", "segment", "segment_flow", "segment_entry", "segment_exit", "slot", "stop", "max_visits", "timeout", "machine", "fold"] as const;
const graph = parseWorkflowSource(src);
const nodes = [...graph.nodes.values()].map((n) => Object.fromEntries(FIELDS.filter((k) => n[k] !== undefined).map((k) => [k, n[k]])));
const edges = graph.edges.map((e) => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}), ...(e.condition ? { condition: e.condition } : {}) }));
const out = path.join(root, "packages/web/lib/ship/__tests__/changeGraph.fixture.json");
fs.writeFileSync(out, `${JSON.stringify({ nodes, edges }, null, 2)}\n`);
console.log(`wrote ${out}: ${nodes.length} nodes, ${edges.length} edges`);
