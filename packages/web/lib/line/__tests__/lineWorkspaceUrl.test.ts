import { describe, expect, test } from "bun:test";
import { lineSelectionSearch, lineViewForKey, lineWorkspaceHref, lineWorkspaceRedirect, readLineSelection } from "../lineWorkspaceUrl";

const q = (s: string) => new URLSearchParams(s);

describe("the line app's selection in the URL", () => {
  test("reads every key; no view is the Inbox, an unknown one too; no project is every project", () => {
    expect(readLineSelection(q("project=pr-1&view=runs&graph=agentwatch&step=prove&run=r1&case=t1"))).toEqual({ view: "runs", mode: "graph", project: "pr-1", graph: "agentwatch", step: "prove", tab: null, run: "r1", case: "t1", source: null, finding: null, ask: false });
    expect(readLineSelection(q("step=dissolve&tab=try")).tab).toBe("try");
    expect(readLineSelection(q("view=nope")).view).toBe("inbox");
    expect(readLineSelection(q("")).project).toBeNull();
    expect(readLineSelection(q("project=all")).project).toBeNull();
  });

  test("the earlier view names read as the view that holds them now", () => {
    expect(readLineSelection(q("view=graph"))).toMatchObject({ view: "process", mode: "graph" });
    expect(readLineSelection(q("view=notebook"))).toMatchObject({ view: "process", mode: "notebook" });
    expect(readLineSelection(q("view=replay")).view).toBe("runs");
    expect(readLineSelection(q("view=timeline")).view).toBe("problems");
    expect(readLineSelection(q("view=process&mode=notebook")).mode).toBe("notebook");
  });

  test("a run brings its case; a new case drops the old case's run; the defaults are left out", () => {
    expect(lineSelectionSearch(q("project=p"), { run: "r1" }, "t1")).toBe("?project=p&run=r1&case=t1");
    expect(lineSelectionSearch(q("run=r1&case=t1"), { case: "t2" })).toBe("?case=t2");
    expect(lineSelectionSearch(q("view=process&mode=notebook&step=prove"), { mode: "graph" })).toBe("?view=process&step=prove");
    expect(lineSelectionSearch(q("view=runs"), { view: "inbox" })).toBe("");
  });

  test("an earlier view name in a patch writes the view and mode that hold it", () => {
    expect(lineSelectionSearch(q(""), { view: "notebook" })).toBe("?view=process&mode=notebook");
    expect(lineSelectionSearch(q("view=notebook&step=s"), { view: "replay", run: "r1" })).toBe("?view=runs&step=s&run=r1");
    expect(lineSelectionSearch(q(""), { view: "timeline", case: "t1" })).toBe("?view=problems&case=t1");
    expect(lineSelectionSearch(q("view=process&mode=notebook"), { view: "chat" })).toBe("?view=chat");
  });

  test("another source drops the finding of the old one", () => {
    expect(lineSelectionSearch(q("view=sources&source=sentry&finding=s1"), { source: "posthog" })).toBe("?view=sources&source=posthog");
    expect(lineSelectionSearch(q("view=sources&source=sentry"), { finding: "s2" })).toBe("?view=sources&source=sentry&finding=s2");
  });

  test("another graph drops the step, run and case, which name things in the old one", () => {
    expect(lineSelectionSearch(q("graph=line&step=prove&run=r1&case=t1"), { graph: "agentwatch" })).toBe("?graph=agentwatch");
    expect(lineSelectionSearch(q("graph=line&run=r1&case=t1"), { graph: "agentwatch", run: "r1", case: "t1" })).toBe("?graph=agentwatch&run=r1&case=t1");
  });

  test("another view keeps only the selection it reads", () => {
    expect(lineSelectionSearch(q("view=runs&run=r1&case=t1&step=prove"), { view: "process" })).toBe("?view=process&step=prove");
    expect(lineSelectionSearch(q("view=problems&case=t1"), { view: "inbox" })).toBe("");
    expect(lineSelectionSearch(q("view=sources&source=s&case=t1"), { view: "problems" })).toBe("?view=problems&case=t1");
    expect(lineSelectionSearch(q("view=inbox"), { view: "runs", run: "r1" }, "t1")).toBe("?view=runs&run=r1&case=t1");
  });

  test("another project drops what named things in the old one, and keeps the view", () => {
    expect(lineSelectionSearch(q("project=a&view=runs&graph=g&step=s&run=r&case=c"), { project: "b" })).toBe("?project=b&view=runs");
    expect(lineSelectionSearch(q("project=a&view=runs"), { project: null })).toBe("?view=runs");
  });
});

describe("the line app's address", () => {
  test("digits 1 to 6 open the views in nav order", () => {
    expect(["1", "2", "3", "4", "5", "6"].map(lineViewForKey)).toEqual(["inbox", "sources", "problems", "runs", "process", "chat"]);
    expect(lineViewForKey("0")).toBeNull();
    expect(lineViewForKey("7")).toBeNull();
    expect(lineViewForKey("a")).toBeNull();
  });

  test("one project is a filter on /line", () => {
    expect(lineWorkspaceHref("pr-12")).toBe("/line?project=pr-12");
    expect(lineWorkspaceHref(null)).toBe("/line");
    expect(lineWorkspaceHref("pr-12", { view: "replay", step: "prove" })).toBe("/line?project=pr-12&view=runs&step=prove");
  });

  test("/line/<project> opens the app filtered to it, keeping what the address named", () => {
    expect(lineWorkspaceRedirect(q(""), "pr-12")).toBe("/line?project=pr-12");
    expect(lineWorkspaceRedirect(q("view=replay&run=r1&case=t1"), "pr-12")).toBe("/line?project=pr-12&view=runs&run=r1&case=t1");
    expect(lineWorkspaceRedirect(q("graph=agentwatch&step=prove"), "pr-12")).toBe("/line?project=pr-12&graph=agentwatch&step=prove");
  });

  test("/line itself stays", () => {
    expect(lineWorkspaceRedirect(q(""))).toBeNull();
    expect(lineWorkspaceRedirect(q("project=pr-12"))).toBeNull();
    expect(lineWorkspaceRedirect(q("project=pr-12&view=runs"))).toBeNull();
  });

  test("what the old map's address opened keeps its meaning", () => {
    expect(lineWorkspaceRedirect(q("project=pr-12&node=investigate"))).toBe("/line?project=pr-12&step=investigate");
    expect(lineWorkspaceRedirect(q("project=pr-12&edge=prove->card"))).toBe("/line?project=pr-12&step=prove");
    expect(lineWorkspaceRedirect(q("project=pr-12&node=causes&section=health"))).toBe("/line?project=pr-12&view=problems");
    expect(lineWorkspaceRedirect(q("project=pr-12&node=line&section=health"))).toBe("/line/settings?project=pr-12&section=health");
    expect(lineWorkspaceRedirect(q("project=pr-12&trace=ct-1"))).toBe("/line/trace/ct-1");
    expect(lineWorkspaceRedirect(q("project=pr-12&node=prove&window=30d&graph=agentwatch"))).toBe("/line?project=pr-12&graph=agentwatch&step=prove");
  });
});
