import { describe, expect, test } from "bun:test";
import { caseRefs, lineFilterParam, lineSelectionPushes, lineSelectionSearch, lineViewForGoKey, lineWorkspaceHref, lineWorkspaceRedirect, readLineSelection, resolveLineProject, lineViewHome } from "../lineWorkspaceUrl";

const q = (s: string) => new URLSearchParams(s);

describe("the line app's selection in the URL", () => {
  test("reads every key; no view is For you, an unknown one too; no project is every project", () => {
    expect(readLineSelection(q("project=pr-1&view=problems&graph=agentwatch&step=prove&run=r1&case=t1&need=sd-6"))).toEqual({ view: "problems", mode: "table", project: "pr-1", graph: "agentwatch", step: "prove", tab: null, run: "r1", case: "t1", source: null, finding: null, row: null, ask: false, card: null, decision: null, need: "sd-6", status: null, process: null, quiet: false, found: null, q: null, sort: null, win: null, show: null, stage: null, item: null, who: null, kind: null, area: null, order: null, group: null, deploy: null });
    expect(readLineSelection(q("step=dissolve&steptab=try")).tab).toBe("try");
    expect(readLineSelection(q("step=dissolve&tab=try")).tab).toBe("try");
    expect(readLineSelection(q("tab=line&step=dissolve")).tab).toBeNull();
    expect(readLineSelection(q("")).view).toBe("foryou");
    expect(readLineSelection(q("view=nope")).view).toBe("foryou");
    expect(readLineSelection(q("")).project).toBeNull();
    expect(readLineSelection(q("project=all")).project).toBeNull();
  });

  test("every earlier view name reads as the page that holds its job now (LJ5)", () => {
    expect(readLineSelection(q("view=inbox")).view).toBe("foryou");
    expect(readLineSelection(q("view=runs&run=r1")).view).toBe("problems");
    expect(readLineSelection(q("view=runs")).view).toBe("problems");
    expect(readLineSelection(q("view=sources&source=x"))).toMatchObject({ view: "line", source: "x" });
    expect(readLineSelection(q("view=process"))).toMatchObject({ view: "line", mode: "map" });
    expect(readLineSelection(q("view=graph"))).toMatchObject({ view: "line", mode: "map" });
    expect(readLineSelection(q("view=notebook"))).toMatchObject({ view: "line", mode: "table" });
    expect(readLineSelection(q("view=process&mode=notebook")).mode).toBe("table");
    expect(readLineSelection(q("view=replay")).view).toBe("problems");
    expect(readLineSelection(q("view=timeline")).view).toBe("problems");
    // Chat's job is a step's instructions.
    expect(readLineSelection(q("view=chat&step=prove"))).toMatchObject({ view: "line", step: "prove", tab: "instructions" });
  });

  test("an earlier name in the address is rewritten to the new one by the next move", () => {
    expect(lineSelectionSearch(q("view=inbox&decision=sd-5"), { need: "sd-5", decision: null })).toBe("?need=sd-5");
    expect(lineSelectionSearch(q("view=process&mode=notebook&step=prove"), { mode: "map" })).toBe("?view=line&step=prove&mode=map");
    expect(lineSelectionSearch(q("view=chat&step=prove"), {})).toBe("?view=line&step=prove&steptab=instructions");
    // Problems' process narrowing is the list's own place: kept while a problem opens, dropped for another view.
    expect(lineSelectionSearch(q("view=problems&process=agentwatch"), { case: "ct-4" })).toBe("?view=problems&process=agentwatch&case=ct-4");
    expect(lineSelectionSearch(q("view=problems&process=agentwatch"), { view: "foryou" })).toBe("");
    expect(lineSelectionSearch(q("view=runs&run=r1"), { case: "t1", run: "r1" })).toBe("?view=problems&run=r1&case=t1");
  });

  test("a run brings its case; a new case drops the old case's run; the defaults are left out", () => {
    expect(lineSelectionSearch(q("project=p&view=problems"), { run: "r1" }, "t1")).toBe("?project=p&view=problems&run=r1&case=t1");
    expect(lineSelectionSearch(q("view=problems&run=r1&case=t1"), { case: "t2" })).toBe("?view=problems&case=t2");
    // A decision belongs to its problem: opening another problem, or none, drops it; naming one keeps it.
    expect(lineSelectionSearch(q("view=problems&case=t1&decision=sd-5"), { case: "t2", run: null })).toBe("?view=problems&case=t2");
    expect(lineSelectionSearch(q("view=problems&case=t1&decision=sd-5"), { case: null })).toBe("?view=problems");
    expect(lineSelectionSearch(q("view=line&mode=map&step=prove"), { mode: "table" })).toBe("?view=line&step=prove");
    expect(lineSelectionSearch(q("view=problems"), { view: "foryou" })).toBe("");
    expect(lineSelectionSearch(q(""), { view: "problems" })).toBe("?view=problems");
  });

  test("an earlier view name in a patch writes the page and mode that hold it", () => {
    expect(lineSelectionSearch(q(""), { view: "notebook" })).toBe("?view=line");
    expect(lineSelectionSearch(q(""), { view: "graph" })).toBe("?view=line&mode=map");
    expect(lineSelectionSearch(q("view=problems&case=t1"), { view: "replay", run: "r1" })).toBe("?view=problems&case=t1&run=r1");
    expect(lineSelectionSearch(q(""), { view: "timeline", case: "t1" })).toBe("?view=problems&case=t1");
    expect(lineSelectionSearch(q(""), { view: "inbox", decision: "sd-5" })).toBe("?decision=sd-5");
    expect(lineSelectionSearch(q("view=line&step=prove"), { view: "chat" })).toBe("?view=line&step=prove&steptab=instructions");
  });

  test("another problem drops what was open on the last one's page", () => {
    expect(lineSelectionSearch(q("view=problems&case=t1&finding=f1&row=r2"), { case: "t2" })).toBe("?view=problems&case=t2");
    expect(lineSelectionSearch(q("view=problems&case=t1"), { row: "r2" })).toBe("?view=problems&case=t1&row=r2");
  });
  test("another source drops the finding of the old one", () => {
    expect(lineSelectionSearch(q("view=line&source=sentry&finding=s1"), { source: "posthog" })).toBe("?view=line&source=posthog");
    expect(lineSelectionSearch(q("view=line&source=sentry"), { finding: "s2" })).toBe("?view=line&source=sentry&finding=s2");
  });

  test("another graph drops the step, run and case, which name things in the old one", () => {
    expect(lineSelectionSearch(q("view=problems&graph=line&step=prove&run=r1&case=t1"), { graph: "agentwatch" })).toBe("?view=problems&graph=agentwatch");
    expect(lineSelectionSearch(q("view=problems&graph=line&run=r1&case=t1"), { graph: "agentwatch", run: "r1", case: "t1" })).toBe("?view=problems&graph=agentwatch&run=r1&case=t1");
    // A correction onto the problem's own process keeps the whole selection, its question included.
    expect(lineSelectionSearch(q("view=problems&graph=line&case=t1&ask=1"), { graph: "agentwatch", case: "t1", ask: "1" })).toBe("?view=problems&graph=agentwatch&case=t1&ask=1");
  });

  test("a decision opened from For you does not follow the run or problem links out of it", () => {
    const at = new URLSearchParams("decision=sd-600");
    expect(lineSelectionSearch(at, { view: "problems", run: "r1" }, "t1")).toBe("?view=problems&run=r1&case=t1");
    expect(lineSelectionSearch(at, { view: "problems", case: "t1" })).toBe("?view=problems&case=t1");
    // A link that names the decision keeps it.
    expect(lineSelectionSearch(at, { view: "problems", case: "t1", decision: "sd-600" })).toBe("?decision=sd-600&view=problems&case=t1");
  });

  test("another page keeps only the selection it reads", () => {
    expect(lineSelectionSearch(q("view=problems&run=r1&case=t1&step=prove"), { view: "line" })).toBe("?view=line");
    expect(lineSelectionSearch(q("view=problems&case=t1"), { view: "foryou" })).toBe("");
    expect(lineSelectionSearch(q("need=sd-5"), { view: "problems" })).toBe("?view=problems");
    expect(lineSelectionSearch(q("view=line&source=s&step=x"), { view: "problems", case: "t1" })).toBe("?view=problems&source=s&case=t1");
    // A step open on Line never follows to a page with no step of its own.
    expect(lineSelectionSearch(q("view=line&graph=agentwatch&step=dissolve&steptab=work"), { view: "problems" })).toBe("?view=problems&graph=agentwatch");
    // The decision a run waits on opens over the run: closing it lands back on the run.
    expect(lineSelectionSearch(q("view=problems&run=r1&case=t1"), { decision: "sd-600" })).toBe("?view=problems&run=r1&case=t1&decision=sd-600");
    expect(lineSelectionSearch(q("view=problems&run=r1&case=t1&decision=sd-600"), { decision: null })).toBe("?view=problems&run=r1&case=t1");
  });

  test("a step picked where no step is drawn opens on Line; inside an open run it is the run's playhead", () => {
    expect(lineSelectionSearch(q("view=problems&case=t1"), { step: "prove" })).toBe("?view=line&step=prove");
    expect(lineSelectionSearch(q(""), { step: "prove" })).toBe("?view=line&step=prove");
    expect(lineSelectionSearch(q("view=problems&run=r1"), { step: "prove" })).toBe("?view=problems&run=r1&step=prove");
  });

  test("keys the line does not own survive every move: the project page's tab stays on Line", () => {
    const from = q("tab=line");
    expect(lineSelectionSearch(from, { view: "problems" })).toBe("?tab=line&view=problems");
    expect(lineSelectionSearch(from, { step: "plan" })).toBe("?tab=line&view=line&step=plan");
    expect(lineSelectionSearch(q("tab=line&step=plan"), { tab: "work" })).toBe("?tab=line&step=plan&steptab=work");
    expect(lineSelectionSearch(q("tab=line&view=line&step=plan&steptab=work"), { step: "build" })).toBe("?tab=line&view=line&step=build");
    expect(lineSelectionSearch(q("tab=line&view=line&step=plan"), { view: "foryou" })).toBe("?tab=line");
    // The Problems page's own keys ride along untouched.
    expect(lineSelectionSearch(q("view=problems&status=failed"), { case: "t1" })).toBe("?view=problems&status=failed&case=t1");
  });

  test("an older link's drawer tab settles on the drawer's own key", () => {
    expect(lineSelectionSearch(q("step=plan&tab=decisions"), { run: null })).toBe("?step=plan&steptab=decisions");
  });

  test("another project drops what named things in the old one, and keeps the page", () => {
    expect(lineSelectionSearch(q("project=a&view=problems&graph=g&step=s&run=r&case=c"), { project: "b" })).toBe("?project=b&view=problems");
    expect(lineSelectionSearch(q("project=a&view=problems"), { project: null })).toBe("?view=problems");
  });
});

describe("For you: a list with the open need beside it", () => {
  test("the open need is its own key; an older link's decision or card stays readable until it settles", () => {
    expect(lineSelectionSearch(q(""), { need: "ct-58311" })).toBe("?need=ct-58311");
    expect(readLineSelection(q("decision=sd-600")).decision).toBe("sd-600");
    expect(readLineSelection(q("card=tc-3")).card).toBe("tc-3");
    expect(lineSelectionSearch(q("decision=sd-600"), { need: "sd-600", decision: null, card: null })).toBe("?need=sd-600");
  });

  test("arriving from another page opens the list, unless the move names the need", () => {
    expect(lineSelectionSearch(q("view=problems&run=r1&case=t1&step=s"), { view: "foryou" })).toBe("");
    expect(lineSelectionSearch(q("view=problems"), { view: "foryou", need: "sd-5" })).toBe("?need=sd-5");
    expect(lineSelectionSearch(q("view=problems"), lineViewHome("foryou"))).toBe("");
  });
});

describe("history: which moves Back and Forward walk", () => {
  const push = (a: string, b: string) => lineSelectionPushes(q(a), q(b));
  test("a new page, need, problem, run, step, source, process or project is an entry", () => {
    expect(push("", "view=problems")).toBe(true);
    expect(push("", "need=sd-1")).toBe(true);
    expect(push("need=sd-1", "need=sd-2")).toBe(true);
    expect(push("view=problems", "view=problems&case=t1")).toBe(true);
    expect(push("view=problems&case=t1", "view=problems&case=t1&run=r1")).toBe(true);
    expect(push("view=problems&run=r1&step=a", "view=problems&run=r1&step=b")).toBe(true);
    expect(push("", "decision=sd-1")).toBe(true);
    expect(push("view=line", "view=line&source=sentry")).toBe(true);
    expect(push("", "graph=agentwatch")).toBe(true);
    expect(push("", "project=pr-1")).toBe(true);
  });

  test("what only changes how a place reads replaces it: a tab, a mode, the answer box's focus, a search, a default named", () => {
    expect(push("step=s", "step=s&steptab=work")).toBe(false);
    expect(push("view=line", "view=line&mode=map")).toBe(false);
    expect(push("view=problems&case=t1", "view=problems&case=t1&ask=1")).toBe(false);
    // What is open on a problem's page (a finding, a run row) is how the page reads: reload and Back keep it.
    expect(push("view=problems&case=t1", "view=problems&case=t1&finding=f1")).toBe(false);
    expect(push("view=problems&case=t1", "view=problems&case=t1&row=r2")).toBe(false);
    expect(push("view=problems", "view=problems&q=eval")).toBe(false);
    expect(push("", "view=foryou")).toBe(false);
    expect(push("tab=line", "tab=line&other=1")).toBe(false);
  });
});

describe("the line app's address", () => {
  test("G then F, P or L opens the pages; no digit opens anything", () => {
    expect(["f", "p", "s", "F"].map(lineViewForGoKey)).toEqual(["foryou", "problems", "line", "foryou"]);
    expect(["1", "2", "3", "x", "l"].map(lineViewForGoKey)).toEqual([null, null, null, null, null]);
  });

  test("one project is a filter on /line", () => {
    expect(lineWorkspaceHref("pr-12")).toBe("/line?project=pr-12");
    expect(lineWorkspaceHref(null)).toBe("/line");
    expect(lineWorkspaceHref("pr-12", { view: "replay", run: "r1" })).toBe("/line?project=pr-12&view=problems&run=r1");
  });

  test("/line/<project> opens the app filtered to it, keeping what the address named", () => {
    expect(lineWorkspaceRedirect(q(""), "pr-12")).toBe("/line?project=pr-12");
    expect(lineWorkspaceRedirect(q("view=replay&run=r1&case=t1"), "pr-12")).toBe("/line?project=pr-12&view=problems&run=r1&case=t1");
    expect(lineWorkspaceRedirect(q("graph=agentwatch&step=prove"), "pr-12")).toBe("/line?project=pr-12&graph=agentwatch&step=prove&view=line");
  });

  test("/line itself stays", () => {
    expect(lineWorkspaceRedirect(q(""))).toBeNull();
    expect(lineWorkspaceRedirect(q("project=pr-12"))).toBeNull();
    expect(lineWorkspaceRedirect(q("project=pr-12&view=runs"))).toBeNull();
  });

  test("what the old map's address opened keeps its meaning", () => {
    expect(lineWorkspaceRedirect(q("project=pr-12&node=investigate"))).toBe("/line?project=pr-12&view=line&step=investigate");
    expect(lineWorkspaceRedirect(q("project=pr-12&edge=prove->card"))).toBe("/line?project=pr-12&view=line&step=prove");
    expect(lineWorkspaceRedirect(q("project=pr-12&node=causes&section=health"))).toBe("/line?project=pr-12&view=problems");
    expect(lineWorkspaceRedirect(q("project=pr-12&node=line&section=health"))).toBe("/line/settings?project=pr-12&section=health");
    expect(lineWorkspaceRedirect(q("project=pr-12&trace=ct-1"))).toBe("/line/trace/ct-1");
    expect(lineWorkspaceRedirect(q("project=pr-12&node=prove&window=30d&graph=agentwatch"))).toBe("/line?project=pr-12&graph=agentwatch&view=line&step=prove");
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

test("the nav opens a page's home: nothing open elsewhere rides along, and the page in front closes its detail", () => {
  const from = new URLSearchParams("view=inbox&case=t1&decision=sd-5&graph=agentwatch&project=union");
  // From the old Inbox with a problem open, Problems is the list.
  expect(lineSelectionSearch(from, lineViewHome("problems"))).toBe("?graph=agentwatch&project=union&view=problems");
  expect(lineSelectionSearch(new URLSearchParams("need=sd-5"), lineViewHome("foryou"))).toBe("");
  // Clicking Problems on a problem's page goes back to the list.
  expect(lineSelectionSearch(new URLSearchParams("view=problems&case=t1&decision=sd-5"), lineViewHome("problems"))).toBe("?view=problems");
  expect(lineSelectionSearch(new URLSearchParams("view=line&source=agentwatch&finding=s1"), lineViewHome("line"))).toBe("?view=line");
  // A link that names a problem still opens it.
  expect(lineSelectionSearch(from, { view: "problems" })).toContain("case=t1");
});

test("a problem is named by its ref in the address and by its row id in the views", () => {
  const refs = caseRefs([{ _id: "mh7b6n1nc960", short_id: "ct-56770" }, { _id: "kq2", short_id: null }]);
  expect(refs.ref("mh7b6n1nc960")).toBe("ct-56770");
  expect(refs.id("ct-56770")).toBe("mh7b6n1nc960");
  // Either form turns into either; a value no problem holds stays as it is, so a cold link still reads.
  expect(refs.ref("ct-56770")).toBe("ct-56770");
  expect(refs.id("mh7b6n1nc960")).toBe("mh7b6n1nc960");
  expect(refs.ref("kq2")).toBe("kq2");
  expect(refs.id("ct-1")).toBe("ct-1");
});

describe("a leading stage open over the Map", () => {
  test("reads and writes stage and item, dropping an unknown stage", () => {
    const q = new URLSearchParams("view=line&mode=map&stage=judges&item=comms");
    expect(readLineSelection(q).stage).toBe("judges");
    expect(readLineSelection(q).item).toBe("comms");
    expect(readLineSelection(new URLSearchParams("view=line&stage=nope")).stage).toBeNull();
  });
  test("another stage drops the open item; a step closes the stage and a stage closes the step", () => {
    const q = new URLSearchParams("view=line&mode=map&stage=judges&item=comms");
    expect(lineSelectionSearch(q, { stage: "moments" })).toBe("?view=line&mode=map&stage=moments");
    expect(lineSelectionSearch(q, { step: "prove" })).toBe("?view=line&mode=map&step=prove");
    expect(lineSelectionSearch(new URLSearchParams("view=line&mode=map&step=prove&show=failed"), { stage: "dispatch" })).toBe("?view=line&mode=map&stage=dispatch");
  });
  test("opening or closing a stage is a place Back walks", () => {
    expect(lineSelectionPushes(new URLSearchParams("view=line&mode=map"), new URLSearchParams("view=line&mode=map&stage=grouping"))).toBe(true);
    expect(lineSelectionPushes(new URLSearchParams("view=line&mode=map&stage=moments"), new URLSearchParams("view=line&mode=map&stage=moments&item=mo-4"))).toBe(true);
  });
  test("a view's home closes the stage", () => {
    expect(lineSelectionSearch(new URLSearchParams("view=line&mode=map&stage=judges&item=comms"), lineViewHome("line"))).toBe("?view=line&mode=map");
  });
});

describe("For you's list in the address", () => {
  test("who, kind, area, order and group ride with For you and leave with it", () => {
    const on = lineSelectionSearch(q(""), { who: "me", kind: "judge", area: "p1", order: "age", group: "who" });
    expect(readLineSelection(q(on))).toMatchObject({ who: "me", kind: "judge", area: "p1", order: "age", group: "who" });
    const next = lineSelectionSearch(q(on), { need: "sd-4" });
    expect(readLineSelection(q(next))).toMatchObject({ who: "me", order: "age", need: "sd-4" });
    const away = lineSelectionSearch(q(next), { view: "problems" });
    expect(readLineSelection(q(away))).toMatchObject({ who: null, kind: null, area: null, order: null, group: null });
  });
});
