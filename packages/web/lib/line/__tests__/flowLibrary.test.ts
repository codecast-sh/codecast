import { describe, expect, test } from "bun:test";
import { appPool } from "../flowPool";
import { flowBaseOf, flowLibrary, libraryEntry, libraryFlows, variantChange, type LibraryRow } from "../flowLibrary";

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id[0].toUpperCase() + id.slice(1), type: "agent", ...extra });
const edges = [{ from: "start", to: "investigate" }, { from: "investigate", to: "dissolve" }, { from: "dissolve", to: "exit" }];

const spine: LibraryRow = {
  _id: "w1", slug: "agentwatch", name: "agentwatch", label: "Union fix flow", serves: ["judge:agent-review"],
  source: 'digraph agentwatch { graph [label="Union fix flow", goal="$task_title"] }',
  nodes: [node("start", { type: "start" }), node("investigate", { timeout: 600 }), node("dissolve", { prompt: "a" }), { id: "failed_at_green", label: "Failed", type: "command" }, { id: "failed_at_push", label: "Failed", type: "command" }, node("exit", { type: "exit" })],
  edges,
};
const system: LibraryRow = {
  _id: "w2", slug: "agentwatch-system", name: "agentwatch_system", serves: ["sdk:union-errors", "union.eval"],
  source: 'digraph agentwatch_system { graph [extends="agentwatch.cast", serves="sdk:union-errors union.eval"] }',
  nodes: [node("start", { type: "start" }), node("investigate", { timeout: 900 }), node("dissolve", { prompt: "b" }), { id: "failed_at_push", label: "Failed", type: "command" }, node("exit", { type: "exit" })],
  edges,
};
const probe: LibraryRow = { _id: "w3", slug: "station-probe", name: "station_probe", source: "digraph p { graph [goal=\"x\"] }", nodes: [node("a")], edges: [] };
const saved: LibraryRow = { _id: "w4", slug: "calls-fix", name: "calls_fix", variant_of: "agentwatch-system", source: 'digraph c { graph [kind="line"] }', nodes: system.nodes, edges };

describe("the flow library", () => {
  test("a variant names its base by extends= or variant_of", () => {
    expect(flowBaseOf(system)).toBe("agentwatch");
    expect(flowBaseOf({ source: 'graph [extends="../line/agentwatch.cast"]' })).toBe("agentwatch");
    expect(flowBaseOf(saved)).toBe("agentwatch-system");
    expect(flowBaseOf(probe)).toBeNull();
  });

  test("a variant shows only what it changes: steps changed and how, steps removed, the sources it serves", () => {
    const c = variantChange(spine, system);
    expect(c.changed).toEqual([{ id: "investigate", label: "Investigate", what: ["time limit"] }, { id: "dissolve", label: "Dissolve", what: ["prompt"] }]);
    // A station named like its siblings ("Failed") reads by its id.
    expect(c.removed).toEqual([{ id: "failed_at_green", label: "Failed at green" }]);
    expect(c.added).toEqual([]);
    expect(c.serves).toEqual(["sdk:union-errors", "union.eval"]);
  });

  test("the spine leads, its variants nest under it, a row extending nothing in the library stays out", () => {
    const lib = flowLibrary(appPool([]), [spine, system, probe, saved], { id: "w1", slug: "agentwatch" });
    expect(lib.lines[0].flow.slug).toBe("agentwatch");
    expect(lib.lines[0].spine).toBe(true);
    expect(lib.lines[0].flow.label).toBe("Union fix flow");
    expect(lib.lines[0].variants.map((v) => v.flow.slug)).toEqual(["agentwatch-system"]);
    expect(lib.lines[0].variants[0].variants.map((v) => v.flow.slug)).toEqual(["calls-fix"]);
    expect(libraryEntry(lib, "agentwatch-system")?.change?.changed.map((s) => s.id)).toEqual(["investigate", "dissolve"]);
    expect(libraryFlows(lib).some((f) => f.slug === "station-probe")).toBe(false);
    // The shipped lines are roots after the spine; the shipped segments are the shelf.
    expect(lib.lines.slice(1).every((e) => !e.spine)).toBe(true);
    expect(lib.segments.length).toBeGreaterThan(0);
  });

  test("a change inside a segment reads as the segment's steps; a session's draft stays out of the library", () => {
    const seg = (id: string, label: string, type = "command") => ({ id, label, type });
    const change: LibraryRow = { _id: "c1", slug: "change", name: "change", source: 'graph [kind="line", label="Change"]', edges: [],
      nodes: [seg("start", "start", "start"), seg("check", "Check", "conditional"), seg("check__verify", "Verify"), seg("check__passed", "Passed"), seg("check__failed", "Checks failed", "exit"), seg("exit", "Done", "exit")] };
    const flaky: LibraryRow = { _id: "c2", slug: "flaky-fix", name: "flaky_fix", source: 'graph [extends="change", label="Change, flaky test"]', edges: [],
      nodes: [seg("start", "start", "start"), seg("check", "Check", "conditional"), seg("check__reproduce", "check__reproduce", "agent"), seg("check__prove", "check__prove"), seg("exit", "Done", "exit")] };
    expect(variantChange(change, flaky)).toEqual({ added: [], removed: [], changed: [{ id: "check", label: "Check", what: ["steps"] }], serves: null });
    const draft = { ...flaky, source: 'graph [extends="change", draft="jx7bhm0"]' };
    expect(libraryEntry(flowLibrary(appPool([]), [change, draft], null), "flaky-fix")).toBeNull();
    expect(libraryEntry(flowLibrary(appPool([]), [change, flaky], null), "flaky-fix")?.base).toBe("change");
  });

  test("with no live flow the spine is not drawn, and its variants have nothing to hang from", () => {
    const lib = flowLibrary(appPool([]), [spine, system], null);
    expect(libraryEntry(lib, "agentwatch")).toBeNull();
    expect(libraryEntry(lib, "agentwatch-system")).toBeNull();
  });
});
