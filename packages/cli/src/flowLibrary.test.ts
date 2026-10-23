// The library as `cast flow ls` and `cast flow show` read it: a published variant parses on top of the published
// flow it extends, sits under it in the tree, and says what it changes; a live flow's flow is the spine.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { holdUntil, libraryTree, liveFlowLines, namesLiveFlow, variantChangeLines, variantChanges, variantSummary, type LiveFlow } from "./flowLibrary.js";
import { poolFlows, type PushedPoolRow } from "./workflow/flowPool.js";
import { parseWorkflowFile } from "./workflow/parser.js";

const tmp: string[] = [];
const mkdtemp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "flowlib-")); tmp.push(d); return d; };
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const SPINE = `digraph agentwatch {
  graph [kind=line, label="Union fix flow", serves="judge:agent-review person"]
  start [shape=Mdiamond]
  investigate [label="Investigate", prompt="@agentwatch/investigate.md"]
  prove [label="Prove", prompt="Prove it."]
  ship [label="Ship", type=command, script="echo ship"]
  exit [shape=Msquare]
  start -> investigate -> prove -> ship -> exit
}`;
const VARIANT = `digraph agentwatch_system {
  graph [extends="agentwatch.cast", kind=line, label="Union fix flow for system findings", serves="sdk:union-errors posthog:union-posthog"]
  investigate [prompt="@agentwatch-system/investigate.md"]
  reproduce [label="Reproduce", prompt="Reproduce it."]
  prove [removed=true]
  investigate -> reproduce
  reproduce -> ship
}`;

const rows: PushedPoolRow[] = [
  {
    _id: "kvariant", slug: "agentwatch-system", name: "agentwatch_system", source: VARIANT, workspace: "team:t1", by: "Ana", mine: false,
    nodes: [{ id: "investigate", prompt: "Read the system finding." }, { id: "reproduce", prompt: "Reproduce it." }],
    origin: { file: "outreach/line/agentwatch-system.cast", files: [{ node: "investigate", prompt: "outreach/line/agentwatch-system/investigate.md" }] },
  },
  {
    _id: "kspine", slug: "agentwatch", name: "agentwatch", source: SPINE, workspace: "team:t1", by: "Ana", mine: false,
    nodes: [{ id: "investigate", prompt: "Read the review finding." }],
    origin: { file: "outreach/line/agentwatch.cast", files: [{ node: "investigate", prompt: "outreach/line/agentwatch/investigate.md" }] },
  },
];

const live: LiveFlow = {
  _id: "lf1", flow: { id: "kspine", slug: "agentwatch", label: "Union fix flow" }, sources: null, on: true,
  caps: { hands_per_day: 40 }, hands_today: 12, load: { working: 4, cap: 6 }, waiting: null, watcher: { role_id: "r1", handle: "agent-quality" },
  queue: [
    { task_id: "t1", short_id: "ct-1", title: "Calls drop", score: 82, scored: true, findings: 3, family: "calling", waiting: null },
    { task_id: "t2", short_id: "ct-2", title: "Deal stuck", score: null, scored: false, findings: 1, family: null, waiting: null },
  ],
};

describe("the library", () => {
  const pool = () => poolFlows(mkdtemp(), null, rows, mkdtemp());

  test("a published variant parses on its published base, with each one's own station files", () => {
    const variant = pool().find((f) => f.slug === "agentwatch-system")!;
    expect([variant.errors, variant.extends, variant.stations.filter((s) => s.main).map((s) => s.label)]).toEqual([[], "agentwatch", ["Investigate", "Reproduce", "Ship"]]);
    expect(parseWorkflowFile(variant.file!).nodes.get("investigate")?.prompt).toBe("Read the system finding.");
  });

  test("the live flow's flow is the spine, its variant sits under it, segments on their own shelf", () => {
    const tree = libraryTree(pool(), [live]);
    expect(tree.spine.map((n) => [n.flow.slug, n.variants.map((v) => v.flow.slug)])).toEqual([["agentwatch", ["agentwatch-system"]]]);
    expect(tree.flows.map((n) => n.flow.slug)).toContain("change");
    expect(tree.flows.some((n) => n.flow.slug === "agentwatch-system")).toBe(false);
    expect(tree.segments.every((n) => n.flow.kind === "segment")).toBe(true);
    // No live flow: the spine section is empty and the flow is one of the whole flows.
    expect(libraryTree(pool()).spine).toEqual([]);
  });

  test("a variant says what it changes from the flow it extends", () => {
    const p = pool();
    const graph = (slug: string) => parseWorkflowFile(p.find((f) => f.slug === slug)!.file!);
    const c = variantChanges(graph("agentwatch"), graph("agentwatch-system"));
    expect(c.added).toEqual(["Reproduce"]);
    expect(c.removed).toEqual(["Prove"]);
    expect(c.changed).toEqual([{ station: "Investigate", fields: ["prompt"] }]);
    expect(c.rerouted).toEqual(["Investigate"]);
    expect(c.graph.map((g) => g.key)).toEqual(["label", "serves"]);
    expect(variantSummary(c)).toBe("1 station added, 1 removed, 1 changed, 1 rerouted, own sources");
    expect(variantChangeLines(c)).toContain("~ Investigate: prompt");
  });
});

describe("a live flow", () => {
  const plain = { bold: (s: string) => s, dim: (s: string) => s };

  test("names itself by its flow's slug, label or id, or its own id", () => {
    for (const n of ["agentwatch", "Union fix flow", "kspine", "lf1"]) expect(namesLiveFlow(live, n)).toBe(true);
    expect(namesLiveFlow(live, "agentwatch-system")).toBe(false);
  });

  test("prints its switch, sources, queue, running and watcher, never an area's lead", () => {
    const text = liveFlowLines(live, { top: 1, ...plain }).join("\n");
    expect(text).toContain("● on   Union fix flow  agentwatch");
    expect(text).toContain("sources  every source");
    expect(text).toContain("queue    2 waiting");
    expect(text).toContain("running  4 of 6  · 12 of 40 sessions today");
    expect(text).toContain("watcher  @agent-quality");
    expect(text).toContain("ct-1  Calls drop  score 82 · 3 findings · calling");
    expect(text).toContain("and 1 more");
    const off = liveFlowLines({ ...live, on: false, sources: ["sdk:union-errors"], watcher: null, queue: [], waiting: "off: a person switches it on" }, { top: 3, ...plain }).join("\n");
    expect(off).toContain("○ off");
    expect(off).toContain("sources  sdk:union-errors");
    expect(off).toContain("queue    empty");
    expect(off).toContain("waiting: off: a person switches it on");
    expect(off).not.toContain("watcher");
  });

  test("a hold shows its end and why; a full page of queue says more wait behind it", () => {
    const until = Date.parse("2026-10-24T09:00:00");
    const text = liveFlowLines({ ...live, hold: { why: "the day's tokens are spent", until, by: "a hand" } }, { top: 1, ...plain }).join("\n");
    expect(text).toMatch(/held     until \w{3},? 09:00: the day's tokens are spent  · a hand/);
    const full = Array.from({ length: 50 }, (_, i) => ({ ...live.queue![0], short_id: `ct-${i}` }));
    expect(liveFlowLines({ ...live, queue: full }, { top: 3, ...plain }).join("\n")).toContain("and 47+ more");
  });

  test("a hold ends at a duration from now or a date and time, within 48 hours", () => {
    const now = Date.parse("2026-10-23T12:00:00");
    expect(holdUntil("90m", now)).toBe(now + 90 * 60_000);
    expect(holdUntil("2d", now)).toBe(now + 48 * 3_600_000);
    expect(holdUntil("2026-10-24 09:00", now)).toBe(Date.parse("2026-10-24T09:00"));
    expect(holdUntil("3d", now)).toEqual({ error: expect.stringContaining("at most 48 hours") });
    expect(holdUntil("2026-10-22T09:00", now)).toEqual({ error: expect.stringContaining("already passed") });
    expect(holdUntil("soon", now)).toEqual({ error: expect.stringContaining("is not a time") });
  });
});
