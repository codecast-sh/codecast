import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parseWorkflowSource } from "./parser";
import { PRESENTER_BASE, presentsDecision, stationBrief } from "./runner";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates";

const graphWith = (gate: string) => parseWorkflowSource(`digraph g {
  start [shape=Mdiamond] exit [shape=Msquare]
  build [label="Build", backend=session, prompt="Build it for $task_id."]
  present [label="Present", backend=session, prompt="This line's addendum for $task_id."]
  decide [label="Decide", shape=hexagon${gate}, prompt="Ship it?"]
  start -> build -> present -> decide
  decide -> exit [label="[S] Ship"]
}`);

describe("the base presenter", () => {
  test("a station a human gate names as its asker reads the base, then its own prompt as the line's addendum", () => {
    const graph = graphWith(", asker=present");
    const brief = stationBrief(graph.nodes.get("present")!, graph, { task_id: "ct-7" });
    const base = brief.indexOf(PRESENTER_BASE);
    const addendum = brief.indexOf("This line's addendum for ct-7.");
    expect(base).toBeGreaterThan(-1);
    expect(addendum).toBeGreaterThan(base);
    expect(brief.slice(base, addendum)).toContain("# This line");
  });

  test("every other station, and a graph whose gate names no asker, gets its prompt alone", () => {
    const asked = graphWith(", asker=present");
    expect(stationBrief(asked.nodes.get("build")!, asked, { task_id: "ct-7" })).not.toContain(PRESENTER_BASE);
    const unasked = graphWith("");
    expect(presentsDecision(unasked.nodes.get("present")!, unasked)).toBe(false);
    expect(stationBrief(unasked.nodes.get("present")!, unasked, { task_id: "ct-7" })).not.toContain(PRESENTER_BASE);
  });

  test("only a human gate's asker presents: an asker attribute elsewhere does not", () => {
    const graph = parseWorkflowSource(`digraph g { start [shape=Mdiamond] exit [shape=Msquare]
      a [backend=session, prompt="a"] b [shape=box, asker=a, prompt="b"] start -> a -> b -> exit }`);
    expect(presentsDecision(graph.nodes.get("a")!, graph)).toBe(false);
  });

  test("the base is product-neutral, short, and written without emdashes", () => {
    expect(PRESENTER_BASE).toContain("cast decide");
    expect(PRESENTER_BASE).not.toMatch(/Union|AgentWatch|codecast's line/);
    expect(PRESENTER_BASE).not.toContain("\u2014");
    expect(PRESENTER_BASE.split(/\s+/).length).toBeLessThan(1100);
    // The base reads no run variables: a line's addendum names its own record.
    expect(PRESENTER_BASE).not.toMatch(/\$[a-z_]+/);
  });

  test("the shipped templates get it from the runner: no template inlines a copy of it", () => {
    const opening = PRESENTER_BASE.split("\n").slice(2, 4).join("\\n");
    for (const source of Object.values(BUILTIN_WORKFLOW_TEMPLATES)) expect(source).not.toContain(opening);
    expect(fs.existsSync(path.join(import.meta.dir, "presenter.md"))).toBe(true);
  });
});
