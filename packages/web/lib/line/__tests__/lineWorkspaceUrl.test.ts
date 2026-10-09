import { describe, expect, test } from "bun:test";
import { lineSelectionSearch, readLineSelection } from "../lineWorkspaceUrl";

const q = (s: string) => new URLSearchParams(s);

describe("the workspace selection in the URL", () => {
  test("reads every key, and an unknown view is the graph", () => {
    expect(readLineSelection(q("view=replay&graph=agentwatch&step=prove&run=r1&case=t1"))).toEqual({ view: "replay", graph: "agentwatch", step: "prove", run: "r1", case: "t1" });
    expect(readLineSelection(q("view=nope")).view).toBe("graph");
  });

  test("a run brings its case; a new case drops the old case's run; the default view is left out", () => {
    expect(lineSelectionSearch(q("project=p"), { run: "r1" }, "t1")).toBe("?project=p&run=r1&case=t1");
    expect(lineSelectionSearch(q("run=r1&case=t1"), { case: "t2" })).toBe("?case=t2");
    expect(lineSelectionSearch(q("view=notebook&step=prove"), { view: "graph" })).toBe("?step=prove");
  });

  test("another graph drops the step and run, which name things in the old one", () => {
    expect(lineSelectionSearch(q("graph=line&step=prove&run=r1&case=t1"), { graph: "agentwatch" })).toBe("?graph=agentwatch&case=t1");
  });
});
