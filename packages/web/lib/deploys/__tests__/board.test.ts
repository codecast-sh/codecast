import { describe, expect, test } from "bun:test";
import {
  after, attemptGroups, carriedOfAttempts, carriedOfDeploy, carriedOfQueue, fold, mineSessionIds, queueCommits, repositoryOfRun, rowsFor,
  runState, shipperOf, shippingRuns, stepper, tasksOnMain, upTo, yourSessions,
  type BoardDeploy, type BoardQueueCommit, type ShipRun,
} from "../board";

const DAY = 24 * 60 * 60_000;
const NOW = 100 * DAY;

const run = (id: string, extra: Partial<ShipRun> = {}): ShipRun => ({
  _id: id, status: "running", node_statuses: [], created_at: NOW - DAY, updated_at: NOW - 60_000, pr: { repository: "o/r", number: 1 }, ...extra,
});
const sess = (id: string, user_id?: string, title: string | null = `Session ${id}`) => ({ conversation_id: id, short_id: null, title, user_id });
const commit = (sha: string, at: number, extra: Partial<BoardQueueCommit> & { task?: string } = {}): BoardQueueCommit => ({
  sha, subject: `Change ${sha}`, at, author: "a", ci: "passed", ci_url: null, session: null,
  tasks: extra.task ? [{ task_id: `t-${extra.task}`, short_id: extra.task, title: `Task ${extra.task}` }] : [], ...extra,
});
const deploy = (short_id: string, created_at: number, extra: Partial<BoardDeploy> = {}): BoardDeploy => ({
  _id: short_id, workspace: "w", target: "production", repository: "o/r", short_id, status: "live", action: "deploy", rollback_of: null,
  sha: `${short_id}0000000`, previous_sha: null, version: null, url: null, started_by: "jason", note: null, commits: 0, sessions: [],
  commit_rows: [], tasks: [], created_at, live_at: created_at, finished_at: created_at, ...extra,
});
const noRuns = shipperOf([]);

describe("which repository a run ships to", () => {
  const checkouts = [{ path: "/code/app", repository: "o/app" }, { path: "/code/app/.codecast/worktrees/x", repository: "o/other" }];
  test("its PR's, else the deepest checkout holding its path, else none", () => {
    expect(repositoryOfRun({ pr: { repository: "O/R", number: 3 } }, checkouts)).toBe("o/r");
    expect(repositoryOfRun({ project_path: "/code/app/packages" }, checkouts)).toBe("o/app");
    expect(repositoryOfRun({ project_path: "/code/app/.codecast/worktrees/x" }, checkouts)).toBe("o/other");
    expect(repositoryOfRun({ project_path: "/code/application" }, checkouts)).toBeNull();
    expect(repositoryOfRun({}, checkouts)).toBeNull();
  });
});

describe("the Shipping column", () => {
  const runs = [
    run("moving-old", { updated_at: NOW - 3 * DAY }),
    run("moving-new", { updated_at: NOW - DAY, user_id: "me" }),
    run("paused", { status: "paused", updated_at: NOW - 2 * DAY }),
    run("stopped", { status: "failed", updated_at: NOW - 5 * DAY, user_id: "me" }),
    run("dropped", { updated_at: NOW - 8 * DAY }),
    run("merged", { node_statuses: [{ node_id: "land__merge", status: "completed" }] }),
    run("deploying", { current_node_id: "deploy__await" }),
    run("elsewhere", { pr: { repository: "o/x", number: 2 } }),
  ];
  const o = { repository: "o/r", checkouts: [], now: NOW, mine: false };
  test("stopped, then waiting on a person, then moving, newest first; a week without movement is dropped", () => {
    const { moving, dropped } = shippingRuns(runs, o);
    expect(moving.map((r) => r._id)).toEqual(["stopped", "paused", "moving-new", "moving-old"]);
    expect(dropped.map((r) => r._id)).toEqual(["dropped"]);
  });
  test("mine keeps the viewer's runs alone, and nothing without a viewer", () => {
    expect(shippingRuns(runs, { ...o, mine: true, mineUserId: "me" }).moving.map((r) => r._id)).toEqual(["stopped", "moving-new"]);
    expect(shippingRuns(runs, { ...o, mine: true }).moving).toEqual([]);
  });
});

describe("the PR · CI · Review · Merge stepper", () => {
  const ns = (...xs: Array<[string, string]>) => xs.map(([node_id, status]) => ({ node_id, status }));
  test("a stopped run is red on exactly one step: earlier ones done, later ones idle", () => {
    const r = run("s", { status: "failed", node_statuses: ns(["land__pr", "completed"], ["land__ci", "failed"], ["land__review", "failed"]) });
    expect(stepper(r)).toEqual(["done", "failed", "idle", "idle"]);
  });
  test("a stopped run with no failed station is red where it was", () => {
    expect(stepper(run("s", { status: "failed", current_node_id: "land__review", node_statuses: ns(["land__pr", "completed"]) }))).toEqual(["done", "done", "failed", "idle"]);
  });
  test("a failed station is active while the run fixes it, waiting while a person decides", () => {
    const node_statuses = ns(["land__pr", "completed"], ["land__ci", "completed"], ["land__review", "failed"]);
    expect(stepper(run("f", { node_statuses }))).toEqual(["done", "done", "active", "idle"]);
    expect(stepper(run("p", { status: "paused", node_statuses }))).toEqual(["done", "done", "waiting", "idle"]);
  });
  test("running and skipped stations", () => {
    expect(stepper(run("r", { node_statuses: ns(["land__pr", "completed"], ["land__checks", "skipped"], ["land__ci", "completed"], ["land__review", "running"]) }))).toEqual(["done", "done", "active", "idle"]);
  });
});

describe("the run's state in words", () => {
  test("stopped carries its reason, a person's turn is blue", () => {
    expect(runState(run("s", { status: "failed", fail_reason: "Stopped: CI could not start" }))).toEqual({ word: "Stopped", tone: "red", detail: "CI could not start" });
    expect(runState(run("p", { status: "paused", gate_prompt: "Merge it?" }))).toEqual({ word: "Waiting on a decision", tone: "blue" });
  });
  test("fixing names what it fixes", () => {
    const fix = { current_node_label: "Fix findings" };
    expect(runState(run("c", { ...fix, node_statuses: [{ node_id: "land__ci", status: "failed" }] })).word).toBe("Fixing CI failures");
    expect(runState(run("v", { ...fix, node_statuses: [{ node_id: "land__review", status: "failed" }] })).word).toBe("Fixing review findings");
    expect(runState(run("b", { current_node_label: "CI and review" }))).toEqual({ word: "CI and review running", tone: "yellow" });
    expect(runState(run("o", { current_node_label: "Open PR" }))).toEqual({ word: "Open PR", tone: "yellow" });
  });
});

describe("crediting a commit to the session that pressed Ship", () => {
  const credit = shipperOf([
    { task_short_id: "ct-1", spawner_conversation_id: "old", spawner_title: "Old", user_id: "u0", created_at: 1 },
    { task_short_id: "ct-1", spawner_conversation_id: "shipper", spawner_title: "Shipper", user_id: "me", created_at: 2 },
  ]);
  const own = { id: "review-station", short_id: null, title: "Review · ct-1", user_id: null, priority: null };
  test("through the task's newest run", () => {
    expect(credit(["ct-1"], own)).toMatchObject({ id: "shipper", title: "Shipper", user_id: "me" });
  });
  test("falls back to the commit's own session", () => {
    expect(credit(["ct-9"], own)).toBe(own);
    expect(credit([], null)).toBeNull();
  });
  test("both columns credit the same way: queue and deploy rows land on the shipper", () => {
    const q = carriedOfQueue([commit("aaaaaaa1", 2, { task: "ct-1", session: sess("review-station"), insertions: 5, deletions: 1 })], credit);
    const d = carriedOfDeploy(deploy("dp-1", 1, { commits: 1, sessions: [sess("review-station")], commit_rows: [{ sha: "bbbbbbb1", subject: "x", conversation_id: "review-station", tasks: ["ct-1"] }] }), credit);
    expect(q.sessions.map((s) => s.id)).toEqual(["shipper"]);
    expect(d.sessions.map((s) => s.id)).toEqual(["shipper"]);
  });
});

describe("queue slicing around a running deploy", () => {
  const q = queueCommits([
    { key: "a", session: null, ci: "passed", commits: [commit("c1aaaaaa", 1), commit("c3aaaaaa", 3)] },
    { key: "b", session: null, ci: "passed", commits: [commit("c2aaaaaa", 2), commit("c4aaaaaa", 4)] },
  ]);
  test("newest first; the deploy sends its commit and older, Next deploy keeps the newer", () => {
    expect(q.map((c) => c.sha)).toEqual(["c4aaaaaa", "c3aaaaaa", "c2aaaaaa", "c1aaaaaa"]);
    expect(upTo(q, "c2aaaaa").map((c) => c.sha)).toEqual(["c2aaaaaa", "c1aaaaaa"]);
    expect(after(q, "c2aaaaa").map((c) => c.sha)).toEqual(["c4aaaaaa", "c3aaaaaa"]);
  });
  test("a sha not waiting sends nothing new and leaves everything next", () => {
    expect(upTo(q, "ffffffff")).toEqual([]);
    expect(after(q, "ffffffff")).toHaveLength(4);
  });
});

describe("what a card carried", () => {
  test("queue commits: sessions summed, subject without its PR, loose commits counted", () => {
    const c = carriedOfQueue([
      commit("a1aaaaaa", 3, { subject: "Add a thing (#12)", session: sess("s1", "me"), insertions: 10, deletions: 2, branch: "b1", task: "ct-1" }),
      commit("a2aaaaaa", 2, { session: sess("s1", "me"), insertions: 1, pr_number: 13 }),
      commit("a3aaaaaa", 1),
    ], noRuns, 4);
    expect(c.sessions).toEqual([{ id: "s1", short_id: null, title: "Session s1", user_id: "me", priority: null, commits: 2, insertions: 11, deletions: 2 }]);
    expect(c.commits[0]).toMatchObject({ subject: "Add a thing", pr: 12, branch: "b1", tasks: ["ct-1"], session: "s1" });
    expect(c.commits[1].pr).toBe(13);
    expect(c).toMatchObject({ loose: 1, more: 4, branchesKnown: true, tasks: [{ short_id: "ct-1", title: "Task ct-1" }] });
  });
  test("a deploy: listed sessions beyond its rows stay, unrecorded counts stay unknown", () => {
    const c = carriedOfDeploy(deploy("dp-2", 1, { commits: 5, sessions: [sess("s1"), sess("s2")], commit_rows: [{ sha: "d1aaaaaa", subject: "x", conversation_id: "s1" }] }), noRuns);
    expect(c.sessions.map((s) => [s.id, s.commits, s.insertions])).toEqual([["s1", 1, undefined], ["s2", 0, undefined]]);
    expect(c).toMatchObject({ more: 4, branchesKnown: false });
  });
  test("an unfinished deploy lists the waiting commits up to its sha; a finished one what it recorded", () => {
    const queue = [commit("e2aaaaaa", 2, { session: sess("s2") }), commit("e1aaaaaa", 1, { session: sess("s1") })];
    const going = deploy("dp-3", 3, { status: "running", sha: "e1aaaaaa" });
    expect(carriedOfAttempts([going], queue, noRuns).sessions.map((s) => s.id)).toEqual(["s1"]);
    const retried = [deploy("dp-5", 5, { sha: "x" }), deploy("dp-4", 4, { sha: "x", status: "failed", commits: 1, commit_rows: [{ sha: "x", subject: "y", conversation_id: "s9" }] })];
    expect(carriedOfAttempts(retried, queue, noRuns).sessions.map((s) => s.id)).toEqual(["s9"]);
  });
});

describe("deploy cards", () => {
  test("every attempt at one sha shares a card, the newest leading", () => {
    const ds = [deploy("dp-9", 9, { sha: "s2" }), deploy("dp-8", 8, { sha: "s1" }), deploy("dp-7", 7, { sha: "s2", status: "failed" }), deploy("dp-6", 6, { sha: null })];
    expect(attemptGroups(ds).map((g) => g.map((d) => d.short_id))).toEqual([["dp-9", "dp-7"], ["dp-8"], ["dp-6"]]);
  });

  test("your sessions: each counted once by its newest work, each bucket linking to its card", () => {
    const next = carriedOfQueue([commit("n1aaaaaa", 9, { session: sess("a", "me") })], noRuns);
    const card = (d: BoardDeploy, ids: string[]) => ({ deploys: [d], carried: carriedOfQueue(ids.map((id, i) => commit(`${id}aaaaaaa`, i, { session: sess(id, "me") })), noRuns) });
    const cards = [
      card(deploy("dp-3", 3, { status: "running" }), ["a", "b"]),
      card(deploy("dp-2", 2), ["b", "c"]),
      card(deploy("dp-1", 1, { status: "failed" }), ["d"]),
      card(deploy("dp-0", 0), ["c", "e"]),
    ];
    const mine = mineSessionIds([next, ...cards.map((c) => c.carried)], "me");
    mine.delete("e");
    const { buckets, bySession, newer } = yourSessions(next, cards, mine);
    expect(buckets).toEqual({ waiting: { count: 1, card: "next" }, going: { count: 1, card: "dp-3" }, live: { count: 1, card: "dp-2" } });
    expect([...bySession.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(Object.fromEntries(newer)).toEqual({ a: "next", b: "dp-3" });
  });

  test("a task's newest place on main", () => {
    const queue = [commit("q1aaaaaa", 5, { task: "ct-1" })];
    const ds = [deploy("dp-1", 1, { tasks: [{ short_id: "ct-2" }] }), deploy("dp-2", 2, { commit_rows: [{ sha: "z", subject: "z", tasks: ["ct-1", "ct-2"] }] })];
    expect(Object.fromEntries(tasksOnMain(queue, ds))).toEqual({ "ct-1": "next", "ct-2": "dp-2" });
  });
});

describe("the switch's rows", () => {
  const c = carriedOfQueue([
    commit("r4aaaaaa", 4, { subject: "Other half (#7)", session: sess("theirs"), insertions: 3, deletions: 1, branch: "feat", task: "ct-2" }),
    commit("r3aaaaaa", 3, { subject: "Half (#7)", session: sess("mine", undefined, "Mine"), insertions: 2, deletions: 0, branch: "feat", task: "ct-1" }),
    commit("r2aaaaaa", 2, { subject: "Direct", session: { ...sess("mine2"), priority: { id: "p1", title: "Launch" } }, insertions: 1 }),
    commit("r1aaaaaa", 1, { subject: "Bot" }),
  ], noRuns);
  const isMine = (id: string) => id === "mine" || id === "mine2";
  test("sessions: own first, then the loose commits", () => {
    expect(rowsFor(c, "sessions", isMine).map((r) => [r.key, r.mine])).toEqual([["mine", true], ["mine2", true], ["theirs", false], ["loose", false]]);
  });
  test("PRs, SHAs and branches merge commits sharing a key and sum their counts", () => {
    const prs = rowsFor(c, "prs", isMine);
    expect(prs[0]).toMatchObject({ key: "#7", pr: 7, commits: 2, insertions: 5, deletions: 1, mine: true });
    expect(prs.map((r) => r.key)).toEqual(["#7", "r2aaaaaa", "r1aaaaaa"]);
    expect(rowsFor(c, "shas", isMine)).toHaveLength(4);
    expect(rowsFor(c, "branches", isMine).map((r) => [r.key, r.commits, r.insertions])).toEqual([["feat", 2, 5], ["main", 2, 1]]);
  });
  test("tasks carry no counts; priorities group sessions, the unprioritised last", () => {
    expect(rowsFor(c, "tasks", isMine)).toEqual([{ key: "ct-1", label: "Task ct-1", task: "ct-1", mine: true }, { key: "ct-2", label: "Task ct-2", task: "ct-2", mine: false }]);
    expect(rowsFor(c, "priorities", isMine).map((r) => [r.key, r.label, r.sessions])).toEqual([["p1", "Launch", ["mine2"]], ["none", null, ["theirs", "mine"]]]);
  });
  test("branches of a deploy that never recorded them list nothing", () => {
    expect(rowsFor({ ...c, branchesKnown: false }, "branches", isMine)).toEqual([]);
  });
});

describe("folding long lists", () => {
  test("12 rows show, but never two or fewer folded away", () => {
    expect(fold(12)).toEqual({ shown: 12, hidden: 0 });
    expect(fold(13)).toEqual({ shown: 13, hidden: 0 });
    expect(fold(14)).toEqual({ shown: 14, hidden: 0 });
    expect(fold(15)).toEqual({ shown: 12, hidden: 3 });
  });
});
