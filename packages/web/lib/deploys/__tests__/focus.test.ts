import { describe, expect, test } from "bun:test";
import { carriedMatches, commitMatches, deployMatches, deploysFocusHref, focusOf, focusOfRef, focusRef, focusRepository, mineOf, reachAnyDeploy, focusTarget, reachDeployOn, rowMatches, runMatches, viewOf } from "../focus";
import { carriedOfQueue, rowsFor, shipperOf } from "../board";

const params = (q: string) => new URLSearchParams(q);
const commit = (sha: string, subject: string, extra: Partial<{ tasks: any[]; session: any }> = {}) => ({
  sha, subject, at: 1, author: "a", ci: "passed" as const, ci_url: null,
  tasks: extra.tasks ?? [], session: extra.session ?? null,
});
const target = (name: string, commits: ReturnType<typeof commit>[]) => ({
  _id: name, name, repository: "o/r",
  queue: { groups: [{ key: "g", session: null, ci: "passed" as const, commits }] },
}) as any;
const deploy = (short_id: string, target: string, created_at: number, rows: any[] = [], extra: any = {}) => ({
  _id: short_id, short_id, target, repository: "o/r", status: "live", sha: null, created_at, sessions: [], commit_rows: rows, tasks: [], ...extra,
}) as any;

describe("what a link into Deploys points at", () => {
  test("each kind reads from its own param; a change named beside a deploy is the focus, the deploy only opens", () => {
    expect(focusOf(params("pr=4431"))).toEqual({ kind: "pr", pr: 4431 });
    expect(focusOf(params("pr=%234431"))).toEqual({ kind: "pr", pr: 4431 });
    expect(focusOf(params("sha=ABC1234"))).toEqual({ kind: "sha", sha: "abc1234" });
    expect(focusOf(params("task=ct-98647"))).toEqual({ kind: "task", id: "ct-98647" });
    expect(focusOf(params("session=jx7b0m0"))).toEqual({ kind: "session", id: "jx7b0m0" });
    expect(focusOf(params("deploy=dp-2314&pr=1"))).toEqual({ kind: "pr", pr: 1 });
    expect(focusOf(params("deploy=dp-2314"))).toEqual({ kind: "deploy", id: "dp-2314" });
  });
  test("nonsense names nothing", () => {
    expect(focusOf(params("pr=abc"))).toBeNull();
    expect(focusOf(params("sha=xyz"))).toBeNull();
    expect(focusOf(params(""))).toBeNull();
  });
});

describe("the view the switch opens at", () => {
  test("sessions by default; a link opens at the view that lists what it points at", () => {
    expect(viewOf(params(""), null)).toBe("sessions");
    expect(viewOf(params("task=ct-1"), focusOf(params("task=ct-1")))).toBe("tasks");
    expect(viewOf(params("pr=7"), focusOf(params("pr=7")))).toBe("prs");
    expect(viewOf(params("deploy=dp-1"), focusOf(params("deploy=dp-1")))).toBe("sessions");
  });
  test("the address's own choice wins; an older link's list opens at the first view it names", () => {
    expect(viewOf(params("show=branches&task=ct-1"), focusOf(params("task=ct-1")))).toBe("branches");
    expect(viewOf(params("show=pr,sha"), null)).toBe("prs");
    expect(viewOf(params("show=session,pr"), null)).toBe("sessions");
    expect(viewOf(params("show=nonsense,task"), null)).toBe("tasks");
    expect(viewOf(params("show="), null)).toBe("sessions");
  });
  test("Mine is on for mine=1 and for an older link's per-column mine", () => {
    expect(mineOf(params("mine=1"))).toBe(true);
    expect(mineOf(params("mine=coming,waiting"))).toBe(true);
    expect(mineOf(params("mine=0"))).toBe(false);
    expect(mineOf(params(""))).toBe(false);
  });
});

describe("finding the linked thing", () => {
  const c = commit("abc1234ff", "Fix the thing (#4431)", { tasks: [{ task_id: "t1", short_id: "ct-7", title: null }], session: { conversation_id: "conv1", short_id: "jx7aaaa", title: null } });
  test("a waiting commit matches by PR, SHA prefix, task, or session", () => {
    expect(commitMatches(c, { kind: "pr", pr: 4431 })).toBe(true);
    expect(commitMatches(c, { kind: "pr", pr: 443 })).toBe(false);
    expect(commitMatches(c, { kind: "sha", sha: "abc12" })).toBe(true);
    expect(commitMatches(c, { kind: "task", id: "ct-7" })).toBe(true);
    expect(commitMatches(c, { kind: "session", id: "jx7aaaa" })).toBe(true);
    expect(commitMatches(c, { kind: "session", id: "conv1" })).toBe(true);
    expect(commitMatches(c, { kind: "deploy", id: "dp-1" })).toBe(false);
    expect(commitMatches(c, null)).toBe(false);
  });
  test("a deploy matches itself, or what it carried", () => {
    const d = deploy("dp-9", "web", 5, [{ sha: "def5678aa", subject: "Other (#12)", conversation_id: "conv2", tasks: ["ct-8"] }], { sha: "fff0000" });
    expect(deployMatches(d, { kind: "deploy", id: "dp-9" })).toBe(true);
    expect(deployMatches(d, { kind: "pr", pr: 12 })).toBe(true);
    expect(deployMatches(d, { kind: "sha", sha: "def56" })).toBe(true);
    expect(deployMatches(d, { kind: "sha", sha: "fff00" })).toBe(true);
    expect(deployMatches(d, { kind: "task", id: "ct-8" })).toBe(true);
    expect(deployMatches(d, { kind: "session", id: "conv2" })).toBe(true);
    expect(deployMatches(d, { kind: "pr", pr: 4431 })).toBe(false);
  });
  test("the target still waiting on it opens, else the one that took it out last", () => {
    const web = target("web", []);
    const api = target("api", [c]);
    const f = { kind: "pr", pr: 12 } as const;
    expect(focusTarget([web, api], [], { kind: "pr", pr: 4431 })?.name).toBe("api");
    const ds = [deploy("dp-1", "web", 1, [{ sha: "d1", subject: "x (#12)" }]), deploy("dp-2", "api", 2, [{ sha: "d1", subject: "x (#12)" }])];
    expect(focusTarget([web, api], ds, f)?.name).toBe("api");
    expect(focusTarget([web, api], ds, { kind: "pr", pr: 99 })).toBeNull();
    expect(focusTarget([web, api], ds, { kind: "deploy", id: "dp-1" })).toBeNull();
  });
});

test("a link names the team, target, thing and IDs it opens with", () => {
  expect(deploysFocusHref({ team: "T", target: "production", focus: { kind: "pr", pr: 4431 } })).toBe("/deploys?team=T&target=production&pr=4431");
  expect(deploysFocusHref({ focus: { kind: "task", id: "ct-7" }, show: ["task", "sha"] })).toBe("/deploys?task=ct-7&show=task%2Csha");
  expect(deploysFocusHref({})).toBe("/deploys");
});

describe("a PR or commit found by its reach", () => {
  const ref = (short_id: string, at: number) => ({ short_id, status: "live" as const, sha: "s", at, url: null });
  const reach = (targets: Array<[string, any, any]>) => ({ state: "live" as const, sha: "s", targets: targets.map(([target, state, deploy]) => ({ target, state, deploy, now: null })) });
  test("the ref names the repository the link means, or the one every target shares", () => {
    expect(focusRef({ kind: "pr", pr: 4473 }, "o/r")).toBe("o/r#4473");
    expect(focusRef({ kind: "sha", sha: "abc1234" }, "o/r")).toBe("o/r@abc1234");
    expect(focusRef({ kind: "task", id: "ct-1" }, "o/r")).toBeNull();
    expect(focusRef({ kind: "pr", pr: 1 }, null)).toBeNull();
    expect(focusRepository(null, [{ repository: "o/r" }, { repository: "o/r" }])).toBe("o/r");
    expect(focusRepository(null, [{ repository: "o/r" }, { repository: "o/s" }])).toBeNull();
    expect(focusRepository("o/s", [{ repository: "o/r" }])).toBe("o/s");
  });
  test("a deploy that listed only its newest commits is still found: reach picks the target and the deploy", () => {
    const web = target("web", []);
    const prod = target("production", []);
    const dash = target("dashboard", []);
    // dashboard's record names the PR, production's does not; reach says both hold it.
    const ds = [deploy("dp-2303", "dashboard", 5, [{ sha: "x", subject: "y (#4473)" }]), deploy("dp-2310", "production", 9)];
    const r = reach([["dashboard", "live", ref("dp-2303", 5)], ["production", "going_out", ref("dp-2310", 9)]]);
    expect(focusTarget([web, dash, prod], ds, { kind: "pr", pr: 4473 }, r)?.name).toBe("production");
    expect(reachDeployOn(r, "production")).toEqual({ short_id: "dp-2310", state: "going_out" });
    expect(reachDeployOn(r, "web")).toBeNull();
  });
  test("live everywhere: the newest deploy's target opens", () => {
    const r = reach([["dashboard", "live", ref("dp-1", 5)], ["production", "live", ref("dp-2", 9)]]);
    expect(focusTarget([target("dashboard", []), target("production", [])], [], { kind: "pr", pr: 1 }, r)?.name).toBe("production");
  });
  test("still waiting on a target beats anything reach says", () => {
    const c = commit("abc", "z (#7)");
    const r = reach([["dashboard", "live", ref("dp-1", 5)]]);
    expect(focusTarget([target("dashboard", []), target("production", [c])], [], { kind: "pr", pr: 7 }, r)?.name).toBe("production");
  });
});

test("a pill's reach ref reads back as a Deploys link, and its reach names a deploy that finds the team", () => {
  expect(focusOfRef("union-ai/union-mobile#4473")).toEqual({ repository: "union-ai/union-mobile", focus: { kind: "pr", pr: 4473 } });
  expect(focusOfRef("o/r@ABC1234")).toEqual({ repository: "o/r", focus: { kind: "sha", sha: "abc1234" } });
  expect(focusOfRef("ct-12")).toBeNull();
  const f = focusOfRef("o/r#9")!;
  expect(deploysFocusHref({ repository: f.repository, target: "production", focus: f.focus })).toBe("/deploys?repo=o%2Fr&target=production&pr=9");
  const at = (short_id: string) => ({ short_id, status: "live" as const, sha: null, at: 1, url: null });
  expect(reachAnyDeploy({ state: "waiting", sha: null, targets: [{ target: "a", state: "waiting", deploy: null, now: at("dp-5") }] })).toBe("dp-5");
  expect(reachAnyDeploy({ state: "waiting", sha: null, targets: [{ target: "a", state: "waiting", deploy: null, now: null }] })).toBeNull();
  expect(reachAnyDeploy(null)).toBeNull();
});

test("a branch link finds the waiting commit that came from it, and opens at Branches", () => {
  expect(focusOf(params("branch=jb/x"))).toEqual({ kind: "branch", name: "jb/x" });
  expect(viewOf(params("branch=jb/x"), focusOf(params("branch=jb/x")))).toBe("branches");
  const c = { ...commit("abc", "y"), branch: "jb/x" };
  expect(commitMatches(c, { kind: "branch", name: "jb/x" })).toBe(true);
  expect(commitMatches(c, { kind: "branch", name: "jb/y" })).toBe(false);
  expect(focusTarget([target("web", []), target("api", [c])], [], { kind: "branch", name: "jb/x" })?.name).toBe("api");
  expect(deploysFocusHref({ focus: { kind: "branch", name: "jb/x" } })).toBe("/deploys?branch=jb%2Fx");
});

describe("one list of link kinds, and when a link's target is settled", () => {
  const { FOCUS_PARAMS, focusSettled } = require("../focus");
  test("every kind in the list is one the address reader reads, by its own param", () => {
    const sample: Record<string, string> = { deploy: "dp-1", pr: "12", sha: "abc1234", task: "ct-1", session: "jx7aaaa", branch: "jb/x" };
    for (const k of FOCUS_PARAMS) expect(focusOf(params(`${k}=${encodeURIComponent(sample[k]!)}`))?.kind).toBe(k);
    expect(Object.keys(sample).sort()).toEqual([...FOCUS_PARAMS].sort());
  });
  test("a PR waiting somewhere is settled at once; one waiting nowhere waits for its reach; other kinds never wait", () => {
    const waiting = target("web", [commit("abc", "x (#7)")]);
    const none = target("api", []);
    const r = { state: "live" as const, sha: null, targets: [] };
    expect(focusSettled([waiting, none], { kind: "pr", pr: 7 }, null)).toBe(true);
    expect(focusSettled([none], { kind: "pr", pr: 7 }, null)).toBe(false);
    expect(focusSettled([none], { kind: "pr", pr: 7 }, r)).toBe(true);
    expect(focusSettled([none], { kind: "task", id: "ct-1" }, null)).toBe(true);
    expect(focusSettled([none], null, r)).toBe(false);
  });
});

describe("the target a link opens, when two repositories both have one of that name", () => {
  const { pickTarget, targetKey } = require("../focus");
  const a = { _id: "ta", name: "production", repository: "org/a" };
  const b = { _id: "tb", name: "production", repository: "org/b" };
  test("?repo=org/b&target=production opens org/b's, not the first one listed", () => {
    expect(pickTarget([a, b], targetKey("production", "org/b"))?._id).toBe("tb");
    expect(pickTarget([a, b], targetKey("production", "org/a"))?._id).toBe("ta");
  });
  test("a bare name opens the first of that name, an id opens exactly that one, nothing opens the first", () => {
    expect(pickTarget([a, b], targetKey("production", null))?._id).toBe("ta");
    expect(pickTarget([a, b], "tb")?._id).toBe("tb");
    expect(pickTarget([a, b], null)?._id).toBe("ta");
    expect(pickTarget([a, b], "staging")?._id).toBe("ta");
    expect(targetKey(null, "org/b")).toBeNull();
  });
});

describe("the view and Mine, in the address", () => {
  const read = (href: string) => new URLSearchParams(href.split("?")[1] ?? "");
  test("a link carries the view and Mine and reads back as the same page, beside the link's own params", () => {
    const p = read(deploysFocusHref({ team: "t1", target: "web", focus: { kind: "pr", pr: 4552 }, show: "tasks", mine: true }));
    expect(viewOf(p, focusOf(p))).toBe("tasks");
    expect(mineOf(p)).toBe(true);
    expect(focusOf(p)).toEqual({ kind: "pr", pr: 4552 });
  });
  test("the default view and Mine off leave no param", () => {
    expect(deploysFocusHref({ team: "t1", show: "sessions", mine: false })).toBe("/deploys?team=t1");
  });
});

describe("finding the linked thing on the board", () => {
  const sess = (id: string) => ({ conversation_id: id, short_id: id.slice(0, 7), title: id });
  const q = (sha: string, extra: any) => ({ sha, subject: `S ${sha}`, at: 1, main_at: 1, author: "a", ci: "passed" as const, ci_url: null, tasks: [], session: null, ...extra });
  const c = carriedOfQueue([
    q("aaaaaaa1", { session: sess("jx7sessionone"), pr_number: 7, branch: "jb/x", tasks: [{ task_id: "t1", short_id: "ct-1", title: null }] }),
    q("bbbbbbb2", { session: sess("jx7sessiontwo") }),
  ], shipperOf([]));
  test("a carried commit matches by PR, SHA prefix, task, session (or its short id) and branch", () => {
    const x = c.commits[0]!;
    for (const f of [{ kind: "pr", pr: 7 }, { kind: "sha", sha: "aaaaa" }, { kind: "task", id: "ct-1" }, { kind: "session", id: "jx7sess" }, { kind: "branch", name: "jb/x" }] as const) expect(carriedMatches(x, f)).toBe(true);
    expect(carriedMatches(c.commits[1]!, { kind: "pr", pr: 7 })).toBe(false);
  });
  test("a row holds the link when it is that thing or one of its commits is, in every view", () => {
    const hit = (view: Parameters<typeof rowsFor>[1], f: any) => rowsFor(c, view, () => false).filter((r) => rowMatches(r, c, f)).map((r) => r.key);
    expect(hit("sessions", { kind: "pr", pr: 7 })).toEqual(["jx7sessionone"]);
    expect(hit("shas", { kind: "pr", pr: 7 })).toEqual(["aaaaaaa1"]);
    expect(hit("prs", { kind: "sha", sha: "bbbbbbb" })).toEqual(["bbbbbbb2"]);
    expect(hit("tasks", { kind: "session", id: "jx7sessionone" })).toEqual(["ct-1"]);
    expect(hit("branches", { kind: "sha", sha: "bbbbbbb2" })).toEqual(["no-branch"]);
    expect(hit("branches", { kind: "branch", name: "jb/x" })).toEqual(["jb/x"]);
    expect(hit("sessions", { kind: "deploy", id: "dp-1" })).toEqual([]);
  });
  test("a Ship run matches by its task, PR, the session that pressed Ship, or the branch it merged", () => {
    const r = { task_short_id: "ct-1", task_id: "t1", pr: { repository: "o/r", number: 7, first_head_sha: "", head_sha: "", at: 1 }, spawner_conversation_id: "jx7sessionone", merge: null };
    expect(runMatches(r, { kind: "task", id: "ct-1" })).toBe(true);
    expect(runMatches(r, { kind: "pr", pr: 7 })).toBe(true);
    expect(runMatches(r, { kind: "session", id: "jx7sess" })).toBe(true);
    // A session id reads in any case; too short to be a short id, it names nothing.
    expect(runMatches(r, { kind: "session", id: "JX7SESS" })).toBe(true);
    expect(carriedMatches(c.commits[0]!, { kind: "session", id: "JX7SESSIONONE" })).toBe(true);
    expect(runMatches(r, { kind: "session", id: "jx7" })).toBe(false);
    expect(runMatches(r, { kind: "sha", sha: "aaaaaaa" })).toBe(false);
  });
});
