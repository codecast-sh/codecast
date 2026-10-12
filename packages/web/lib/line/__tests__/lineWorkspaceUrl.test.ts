import { describe, expect, test } from "bun:test";
import { lineFilterParam, lineSelectionPushes, lineSelectionSearch, lineViewForKey, lineWorkspaceHref, lineWorkspaceRedirect, readLineSelection, resolveLineProject, lineViewHome } from "../lineWorkspaceUrl";

const q = (s: string) => new URLSearchParams(s);

describe("the line app's selection in the URL", () => {
  test("reads every key; no view is Problems, an unknown one too; no project is every project", () => {
    expect(readLineSelection(q("project=pr-1&view=runs&graph=agentwatch&step=prove&run=r1&case=t1"))).toEqual({ view: "runs", mode: "graph", project: "pr-1", graph: "agentwatch", step: "prove", tab: null, run: "r1", case: "t1", source: null, finding: null, ask: false, card: null, decision: null });
    expect(readLineSelection(q("step=dissolve&steptab=try")).tab).toBe("try");
    expect(readLineSelection(q("step=dissolve&tab=try")).tab).toBe("try");
    expect(readLineSelection(q("tab=line&step=dissolve")).tab).toBeNull();
    expect(readLineSelection(q("view=nope")).view).toBe("problems");
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
    // A decision belongs to its problem: opening another problem, or none, drops it; naming one keeps it.
    expect(lineSelectionSearch(q("view=problems&case=t1&decision=sd-5"), { case: "t2", run: null })).toBe("?view=problems&case=t2");
    expect(lineSelectionSearch(q("view=problems&case=t1&decision=sd-5"), { case: null })).toBe("?view=problems");
    expect(lineSelectionSearch(q("view=problems&case=ct-1&decision=sd-5"), { case: "t1", decision: "sd-5" })).toBe("?view=problems&case=t1&decision=sd-5");
    expect(lineSelectionSearch(q("view=process&mode=notebook&step=prove"), { mode: "graph" })).toBe("?view=process&step=prove");
    expect(lineSelectionSearch(q("view=runs"), { view: "inbox" })).toBe("?view=inbox");
    expect(lineSelectionSearch(q("view=runs"), { view: "problems" })).toBe("");
  });

  test("an earlier view name in a patch writes the view and mode that hold it", () => {
    expect(lineSelectionSearch(q(""), { view: "notebook" })).toBe("?view=process&mode=notebook");
    expect(lineSelectionSearch(q("view=notebook&step=s"), { view: "replay", run: "r1" })).toBe("?view=runs&step=s&run=r1");
    expect(lineSelectionSearch(q("view=notebook&step=s"), { view: "replay" })).toBe("?view=runs");
    expect(lineSelectionSearch(q(""), { view: "timeline", case: "t1" })).toBe("?case=t1");
    expect(lineSelectionSearch(q("view=process&mode=notebook"), { view: "chat" })).toBe("?view=chat");
  });

  test("another source drops the finding of the old one", () => {
    expect(lineSelectionSearch(q("view=sources&source=sentry&finding=s1"), { source: "posthog" })).toBe("?view=sources&source=posthog");
    expect(lineSelectionSearch(q("view=sources&source=sentry"), { finding: "s2" })).toBe("?view=sources&source=sentry&finding=s2");
  });

  test("another graph drops the step, run and case, which name things in the old one", () => {
    expect(lineSelectionSearch(q("graph=line&step=prove&run=r1&case=t1"), { graph: "agentwatch" })).toBe("?graph=agentwatch");
    expect(lineSelectionSearch(q("graph=line&run=r1&case=t1"), { graph: "agentwatch", run: "r1", case: "t1" })).toBe("?graph=agentwatch&run=r1&case=t1");
    // A correction onto the problem's own process keeps the whole selection, its question included.
    expect(lineSelectionSearch(q("view=problems&graph=line&case=t1&ask=1"), { graph: "agentwatch", case: "t1", ask: "1" })).toBe("?view=problems&graph=agentwatch&case=t1&ask=1");
  });

  test("another view keeps only the selection it reads", () => {
    expect(lineSelectionSearch(q("view=runs&run=r1&case=t1&step=prove"), { view: "process" })).toBe("?view=process");
    expect(lineSelectionSearch(q("view=problems&case=t1"), { view: "inbox" })).toBe("?view=inbox");
    expect(lineSelectionSearch(q("view=sources&source=s&case=t1"), { view: "problems" })).toBe("?source=s&case=t1");
    expect(lineSelectionSearch(q("view=inbox"), { view: "runs", run: "r1" }, "t1")).toBe("?view=runs&run=r1&case=t1");
    // A step open in Process never follows to a view without a drawer.
    expect(lineSelectionSearch(q("view=process&graph=agentwatch&step=dissolve&steptab=decisions"), { view: "runs" })).toBe("?view=runs&graph=agentwatch");
    expect(lineSelectionSearch(q("view=process&step=dissolve&steptab=decisions"), { view: "inbox" })).toBe("?view=inbox");
    // The decision a run waits on opens over the run, in Runs: closing it lands back on the run.
    expect(lineSelectionSearch(q("view=runs&run=r1&case=t1"), { decision: "sd-600" })).toBe("?view=runs&run=r1&case=t1&decision=sd-600");
    expect(lineSelectionSearch(q("view=runs&run=r1&case=t1&decision=sd-600"), { decision: null })).toBe("?view=runs&run=r1&case=t1");
    // Problems reads the source Sources picked.
    expect(lineSelectionSearch(q("view=sources&source=sentry&finding=f1"), { view: "problems" })).toBe("?source=sentry");
  });

  test("a step picked where no step is drawn opens the Process view", () => {
    expect(lineSelectionSearch(q("view=problems&case=t1"), { step: "prove" })).toBe("?view=process&step=prove");
    expect(lineSelectionSearch(q(""), { step: "prove" })).toBe("?view=process&step=prove");
    expect(lineSelectionSearch(q("view=runs&run=r1"), { step: "prove" })).toBe("?view=runs&run=r1&step=prove");
    expect(lineSelectionSearch(q("view=chat"), { step: "prove" })).toBe("?view=chat&step=prove");
  });

  test("Chat keeps what was open, so it rides along with the next question", () => {
    expect(lineSelectionSearch(q("view=runs&run=r1&case=c1&step=plan"), { view: "chat" })).toBe("?view=chat&run=r1&case=c1&step=plan");
  });

  test("keys the line does not own survive every move: the project page's tab stays on Line", () => {
    const from = q("tab=line");
    expect(lineSelectionSearch(from, { view: "sources" })).toBe("?tab=line&view=sources");
    expect(lineSelectionSearch(from, { step: "plan" })).toBe("?tab=line&view=process&step=plan");
    expect(lineSelectionSearch(q("tab=line&step=plan"), { tab: "decisions" })).toBe("?tab=line&step=plan&steptab=decisions");
    expect(lineSelectionSearch(q("tab=line&view=process&step=plan&steptab=prompt"), { step: "build" })).toBe("?tab=line&view=process&step=build");
    expect(lineSelectionSearch(q("tab=line&view=process&step=plan"), { view: "inbox" })).toBe("?tab=line&view=inbox");
  });

  test("an older link's drawer tab settles on the drawer's own key", () => {
    expect(lineSelectionSearch(q("step=plan&tab=decisions"), { run: null })).toBe("?step=plan&steptab=decisions");
  });

  test("another project drops what named things in the old one, and keeps the view", () => {
    expect(lineSelectionSearch(q("project=a&view=runs&graph=g&step=s&run=r&case=c"), { project: "b" })).toBe("?project=b&view=runs");
    expect(lineSelectionSearch(q("project=a&view=runs"), { project: null })).toBe("?view=runs");
  });
});

describe("the Inbox as a list with a detail beside it", () => {
  test("a row opens its problem, its run or its decision in place, and the run's step stays its playhead", () => {
    expect(lineSelectionSearch(q("view=inbox"), { case: "t1", ask: "1" })).toBe("?view=inbox&case=t1&ask=1");
    expect(lineSelectionSearch(q("view=inbox&case=t1"), { run: "r1", case: "t1" })).toBe("?view=inbox&case=t1&run=r1");
    expect(lineSelectionSearch(q("view=inbox&run=r1&case=t1"), { step: "prove" })).toBe("?view=inbox&run=r1&case=t1&step=prove");
    expect(lineSelectionSearch(q("view=inbox&case=t1"), { decision: "sd-5", case: null })).toBe("?view=inbox&decision=sd-5");
  });

  test("arriving from another view opens the list, unless the move names the detail", () => {
    expect(lineSelectionSearch(q("view=runs&run=r1&case=t1&step=s"), { view: "inbox" })).toBe("?view=inbox");
    expect(lineSelectionSearch(q("view=problems&decision=sd-5"), { view: "inbox" })).toBe("?view=inbox&decision=sd-5");
    expect(lineSelectionSearch(q("view=runs"), { view: "inbox", card: "tc-3" })).toBe("?view=inbox&card=tc-3");
  });
});

describe("history: which moves Back and Forward walk", () => {
  const push = (a: string, b: string) => lineSelectionPushes(q(a), q(b));
  test("a new view, problem, run, step, card, decision, source, process or project is an entry", () => {
    expect(push("", "view=sources")).toBe(true);
    expect(push("view=problems", "view=problems&case=t1")).toBe(true);
    expect(push("case=t1", "case=t1&run=r1")).toBe(true);
    expect(push("view=runs&run=r1&step=a", "view=runs&run=r1&step=b")).toBe(true);
    expect(push("", "card=tc-1")).toBe(true);
    expect(push("", "decision=sd-1")).toBe(true);
    expect(push("view=sources", "view=sources&source=sentry")).toBe(true);
    expect(push("", "graph=agentwatch")).toBe(true);
    expect(push("", "project=pr-1")).toBe(true);
    expect(push("view=process", "view=process&mode=notebook")).toBe(true);
  });

  test("what only changes how a place reads replaces it: the drawer's tab, a finding opened, the answer box's focus, a default named", () => {
    expect(push("step=s", "step=s&steptab=try")).toBe(false);
    expect(push("view=sources&source=x", "view=sources&source=x&finding=f1")).toBe(false);
    expect(push("view=problems&case=t1", "view=problems&case=t1&ask=1")).toBe(false);
    expect(push("", "view=problems")).toBe(false);
    expect(push("tab=line", "tab=line&other=1")).toBe(false);
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
    expect(lineWorkspaceRedirect(q("graph=agentwatch&step=prove"), "pr-12")).toBe("/line?project=pr-12&graph=agentwatch&step=prove&view=process");
  });

  test("/line itself stays", () => {
    expect(lineWorkspaceRedirect(q(""))).toBeNull();
    expect(lineWorkspaceRedirect(q("project=pr-12"))).toBeNull();
    expect(lineWorkspaceRedirect(q("project=pr-12&view=runs"))).toBeNull();
  });

  test("what the old map's address opened keeps its meaning", () => {
    expect(lineWorkspaceRedirect(q("project=pr-12&node=investigate"))).toBe("/line?project=pr-12&view=process&step=investigate");
    expect(lineWorkspaceRedirect(q("project=pr-12&edge=prove->card"))).toBe("/line?project=pr-12&view=process&step=prove");
    expect(lineWorkspaceRedirect(q("project=pr-12&node=causes&section=health"))).toBe("/line?project=pr-12");
    expect(lineWorkspaceRedirect(q("project=pr-12&node=line&section=health"))).toBe("/line/settings?project=pr-12&section=health");
    expect(lineWorkspaceRedirect(q("project=pr-12&trace=ct-1"))).toBe("/line/trace/ct-1");
    expect(lineWorkspaceRedirect(q("project=pr-12&node=prove&window=30d&graph=agentwatch"))).toBe("/line?project=pr-12&graph=agentwatch&view=process&step=prove");
  });
});

describe("resolveLineProject", () => {
  const team = { _id: "p1", short_id: "pr-1", title: "Codecast", workspace: "team:t" };
  const mine = { _id: "p2", short_id: "pr-2", title: "codecast", workspace: "user:u" };
  const other = { _id: "p3", short_id: "pr-3", title: "Agent Quality", workspace: "team:t" };
  const settings = { _id: "p4", short_id: "pr-4", title: "Settings", workspace: "team:t" };

  test("a unique slug opens the project it names", () => {
    expect(resolveLineProject("agent-quality", [team, mine, other])).toBe("p3");
  });

  test("a slug two workspaces share settles on the active workspace's", () => {
    expect(resolveLineProject("codecast", [team, mine, other])).toBeUndefined();
    expect(resolveLineProject("codecast", [team, mine, other], (p) => p.workspace === "user:u")).toBe("p2");
  });

  test("a short id or row id wins over a slug, and the line's own paths are never a slug", () => {
    expect(resolveLineProject("pr-3", [team, other])).toBe("p3");
    expect(resolveLineProject("p1", [team, other])).toBe("p1");
    expect(resolveLineProject("settings", [settings])).toBeUndefined();
    expect(lineFilterParam(settings, [settings])).toBe("pr-4");
  });

  test("the filter writes the slug only when no other project shares it", () => {
    expect(lineFilterParam(other, [team, other])).toBe("agent-quality");
    expect(lineFilterParam(team, [team, mine])).toBe("pr-1");
  });
});

test("the nav opens a view's home: nothing open elsewhere rides along, and the view in front closes its detail", () => {
  const from = new URLSearchParams("view=inbox&case=t1&decision=sd-5&graph=agentwatch&project=union");
  // From the Inbox with a problem open, Problems is the list, and Runs carries no hidden case.
  expect(lineSelectionSearch(from, lineViewHome("problems"))).toBe("?graph=agentwatch&project=union");
  expect(lineSelectionSearch(from, lineViewHome("runs"))).toBe("?view=runs&graph=agentwatch&project=union");
  // Clicking Problems on a problem's detail goes back to the list.
  expect(lineSelectionSearch(new URLSearchParams("case=t1&decision=sd-5"), lineViewHome("problems"))).toBe("");
  expect(lineSelectionSearch(new URLSearchParams("view=sources&source=agentwatch&finding=s1"), lineViewHome("sources"))).toBe("?view=sources");
  // A link that names a problem still opens it, and Chat keeps what was open as its subject.
  expect(lineSelectionSearch(from, { view: "problems" })).toContain("case=t1");
  expect(lineSelectionSearch(new URLSearchParams("view=runs&run=r1&case=t1"), lineViewHome("chat"))).toBe("?view=chat&run=r1&case=t1");
});
