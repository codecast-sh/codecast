import { describe, expect, test } from "bun:test";
import { lineSelectionSearch, lineViewForKey, lineWorkspaceHref, lineWorkspaceRedirect, readLineSelection } from "../lineWorkspaceUrl";

const q = (s: string) => new URLSearchParams(s);

describe("the workspace selection in the URL", () => {
  test("reads every key, and an unknown view is the graph", () => {
    expect(readLineSelection(q("view=replay&graph=agentwatch&step=prove&run=r1&case=t1"))).toEqual({ view: "replay", graph: "agentwatch", step: "prove", tab: null, run: "r1", case: "t1" });
    expect(readLineSelection(q("step=dissolve&tab=try")).tab).toBe("try");
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

describe("the workspace's address", () => {
  test("digits 1 to 5 open the views in switch order", () => {
    expect(["1", "2", "3", "4", "5"].map(lineViewForKey)).toEqual(["graph", "notebook", "replay", "chat", "timeline"]);
    expect(lineViewForKey("0")).toBeNull();
    expect(lineViewForKey("6")).toBeNull();
    expect(lineViewForKey("a")).toBeNull();
  });

  test("a project's workspace carries the selection", () => {
    expect(lineWorkspaceHref("pr-12")).toBe("/line/pr-12");
    expect(lineWorkspaceHref("pr-12", { view: "replay", step: "prove" })).toBe("/line/pr-12?view=replay&step=prove");
  });

  test("an old one-project address opens the workspace, keeping its graph", () => {
    expect(lineWorkspaceRedirect(q("project=pr-12"))).toBe("/line/pr-12");
    expect(lineWorkspaceRedirect(q("project=pr-12&graph=agentwatch"))).toBe("/line/pr-12?graph=agentwatch");
  });

  test("the overview stays where it is", () => {
    expect(lineWorkspaceRedirect(q(""))).toBeNull();
    expect(lineWorkspaceRedirect(q("project=all"))).toBeNull();
    expect(lineWorkspaceRedirect(q("project=none"))).toBeNull();
  });

  test("what the old map's address opened keeps its meaning in the workspace", () => {
    expect(lineWorkspaceRedirect(q("project=pr-12&node=investigate"))).toBe("/line/pr-12?step=investigate");
    expect(lineWorkspaceRedirect(q("project=pr-12&edge=prove->card"))).toBe("/line/pr-12?step=prove");
    expect(lineWorkspaceRedirect(q("project=pr-12&node=causes&section=health"))).toBe("/line/pr-12?view=timeline");
    expect(lineWorkspaceRedirect(q("project=pr-12&node=line&section=health"))).toBe("/line/settings?project=pr-12&section=health");
    expect(lineWorkspaceRedirect(q("project=pr-12&trace=ct-1"))).toBe("/line/trace/ct-1");
    expect(lineWorkspaceRedirect(q("project=pr-12&window=30d&graph=agentwatch"))).toBe("/line/pr-12?graph=agentwatch");
  });
});
