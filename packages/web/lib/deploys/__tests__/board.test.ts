import { describe, expect, test } from "bun:test";
import {
  after, attemptGroups, carriedOfAttempts, carriedOfDeploy, carriedOfQueue, fold, mineSessionIds, queueCommits, repositoryOfRun, rowsFor,
  recordedOf, runOwner, runState, shipperOf, shippingRuns, splitQueue, stepper, tasksOnMain, upTo, withLines, yourSessions,
  type BoardDeploy, type BoardQueueCommit,
} from "../board";
import type { ShippingRun, ShippingShipper } from "@codecast/shared/contracts/deployTargets";

const DAY = 24 * 60 * 60_000;
const NOW = 100 * DAY;

// Verdicts, PRs and merges as the tests name them: only the fields the model reads.
const run = (id: string, extra: Record<string, unknown> = {}): ShippingRun => ({
  _id: id, status: "running", task_id: null, task_short_id: null, task_title: null, workflow_slug: "change", workflow_label: null,
  current_node_id: null, current_node_label: null, node_statuses: [], pr: { repository: "o/r", number: 1 }, fail_reason: null,
  gate_node_id: null, gate_prompt: null, gate_decision_short_id: null, gate_decision_status: null, spawner_conversation_id: null,
  primary_conversation_id: null, project_path: null, user_id: "someone", created_at: NOW - DAY, updated_at: NOW - 60_000, ...extra,
}) as ShippingRun;
const sess = (id: string, user_id?: string, title: string | null = `Session ${id}`) => ({ conversation_id: id, short_id: null, title, user_id });
const commit = (sha: string, at: number, extra: Partial<BoardQueueCommit> & { task?: string } = {}): BoardQueueCommit => ({
  sha, subject: `Change ${sha}`, at, main_at: at, author: "a", ci: "passed", ci_url: null, session: null,
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
    expect(repositoryOfRun({ pr: { repository: "O/R", number: 3 } } as Pick<ShippingRun, "pr" | "project_path">, checkouts)).toBe("o/r");
    expect(repositoryOfRun({ pr: null, project_path: "/code/app/packages" }, checkouts)).toBe("o/app");
    expect(repositoryOfRun({ pr: null, project_path: "/code/app/.codecast/worktrees/x" }, checkouts)).toBe("o/other");
    expect(repositoryOfRun({ pr: null, project_path: "/code/application" }, checkouts)).toBeNull();
    expect(repositoryOfRun({ pr: null, project_path: null }, checkouts)).toBeNull();
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
    run("recorded", { merge: { sha: "abc1234" } }),
    run("elsewhere", { pr: { repository: "o/x", number: 2 } }),
  ];
  const o = { repository: "o/r", checkouts: [], now: NOW, mine: false };
  test("stopped, then waiting on a person, then moving, newest first; a week without movement is dropped", () => {
    const { moving, dropped } = shippingRuns(runs, o);
    expect(moving.map((r) => r._id)).toEqual(["stopped", "paused", "moving-new", "moving-old"]);
    expect(dropped.map((r) => r._id)).toEqual(["dropped"]);
    // A pull request merged by hand on GitHub is on main: its run leaves Shipping.
    const handMerged = [...runs, run("hand-merged", { pr: { repository: "o/r", number: 41 } })];
    expect(shippingRuns(handMerged, o).moving.map((r) => r._id)).toContain("hand-merged");
    expect(shippingRuns(handMerged, { ...o, landedPrs: new Set([41]) }).moving.map((r) => r._id)).not.toContain("hand-merged");
  });
  test("keep narrows them, and Mine reads the owner of the session that pressed Ship before the run's own user", () => {
    expect(shippingRuns(runs, { ...o, keep: (r) => r.user_id === "me" }).moving.map((r) => r._id)).toEqual(["stopped", "moving-new"]);
    const shippers = [{ run_id: "paused", user_id: "me" }, { run_id: "stopped", user_id: null }, { run_id: "moving-new", user_id: "ana" }];
    expect(runs.filter((r) => runOwner(r, shippers) === "me").map((r) => r._id)).toEqual(["paused", "stopped"]);
    // A stand-in spawner (the project lead's standing session) is nobody's Ship: the run is its runner's.
    expect(runOwner({ _id: "paused", user_id: "runner", stand_in: true }, shippers)).toBe("runner");
  });
});

describe("the PR · CI · Review · Merge stepper", () => {
  const ns = (...xs: Array<[string, string]>) => xs.map(([node_id, status]) => ({ node_id, status })) as ShippingRun["node_statuses"];
  test("a stopped run is red on exactly one step: earlier ones done, later ones idle", () => {
    const r = run("s", { status: "failed", node_statuses: ns(["land__pr", "completed"], ["land__ci", "failed"], ["land__review", "failed"]) });
    expect(stepper(r)).toEqual(["done", "failed", "idle", "idle"]);
  });
  test("a stopped run with no failed station is red where it was, else at its last station, else the first unfinished step", () => {
    expect(stepper(run("s", { status: "failed", current_node_id: "land__review", node_statuses: ns(["land__pr", "completed"]) }))).toEqual(["done", "done", "failed", "idle"]);
    expect(stepper(run("s", { status: "failed", current_node_id: "fix", node_statuses: ns(["pr", "completed"], ["ci", "completed"], ["fix", "failed"]) }))).toEqual(["done", "failed", "idle", "idle"]);
    expect(stepper(run("s", { status: "failed", pr: undefined }))).toEqual(["failed", "idle", "idle", "idle"]);
  });
  test("facts outrank stations: verdicts and the merge decide their steps", () => {
    const node_statuses = ns(["ci", "failed"], ["review", "completed"]);
    expect(stepper(run("f", { node_statuses, ci_verdict: { green: true }, review_verdict: { verdict: "changes" } }))).toEqual(["done", "done", "active", "idle"]);
    expect(stepper(run("m", { ci_verdict: { green: true }, review_verdict: { verdict: "ship" }, merge: { sha: "abc1234" } }))).toEqual(["done", "done", "done", "done"]);
    expect(stepper(run("r", { status: "failed", ci_verdict: { green: true }, review_verdict: { verdict: "rejected" } }))).toEqual(["done", "done", "failed", "idle"]);
  });
  test("without a verdict a completed CI station counts as done, in either flow's naming", () => {
    expect(stepper(run("c", { pr: undefined, node_statuses: ns(["pr", "completed"], ["checks", "completed"], ["ci", "completed"], ["review", "running"]) }))).toEqual(["done", "done", "active", "idle"]);
    expect(stepper(run("u", { node_statuses: ns(["land__ci_alone", "completed"], ["land__retest", "skipped"], ["land__changes", "running"]) }))).toEqual(["done", "done", "active", "idle"]);
  });
  test("trouble is active while the run fixes it; a paused run is blue on the step it waits at", () => {
    const node_statuses = ns(["land__pr", "completed"], ["land__ci", "completed"], ["land__review", "failed"]);
    expect(stepper(run("f", { node_statuses }))).toEqual(["done", "done", "active", "idle"]);
    expect(stepper(run("p", { status: "paused", node_statuses }))).toEqual(["done", "done", "waiting", "idle"]);
    expect(stepper(run("g", { status: "paused", current_node_id: "land__card__decide", gate_node_id: "land__merge", node_statuses }))).toEqual(["done", "done", "active", "waiting"]);
    expect(stepper(run("c", { status: "paused", current_node_id: "ci", node_statuses: ns(["pr", "completed"]) }))).toEqual(["done", "waiting", "idle", "idle"]);
  });
});

describe("the run's state in words", () => {
  test("stopped carries its reason, a person's turn is blue", () => {
    expect(runState(run("s", { status: "failed", fail_reason: "Stopped: CI could not start" }))).toEqual({ word: "Stopped", tone: "red", detail: "CI could not start" });
    expect(runState(run("p", { status: "paused", gate_prompt: "Merge it?" }))).toEqual({ word: "Waiting on a decision", tone: "blue" });
  });
  test("fixing names what it fixes, from the verdict first", () => {
    const fix = { current_node_label: "Fix findings" };
    expect(runState(run("c", { ...fix, node_statuses: [{ node_id: "land__ci", status: "failed" }] })).word).toBe("Fixing CI failures");
    expect(runState(run("v", { ...fix, ci_verdict: { green: false } })).word).toBe("Fixing CI failures");
    expect(runState(run("w", { ...fix, ci_verdict: { green: true }, node_statuses: [{ node_id: "ci", status: "failed" }] })).word).toBe("Fixing review findings");
    expect(runState(run("b", { current_node_label: "CI and review" }))).toEqual({ word: "CI and review running", tone: "yellow" });
    expect(runState(run("o", { current_node_label: "Open PR" }))).toEqual({ word: "Open PR", tone: "yellow" });
  });
});

describe("crediting a commit to the session that pressed Ship", () => {
  const entry = (run_id: string, extra: Partial<ShippingShipper>): ShippingShipper => ({ run_id, task_short_id: "ct-1", merged_sha: null, spawner_conversation_id: run_id, user_id: null, stand_in: false, created_at: 10, ...extra });
  const credit = shipperOf([
    entry("first", { merged_sha: "aaaaaaa1ffff", user_id: "me" }),
    entry("second", { created_at: 20 }),
    entry("stand-in", { task_short_id: "ct-2", merged_sha: "bbbbbbb1", stand_in: true, created_at: 5 }),
    entry("nobody", { task_short_id: "ct-3", spawner_conversation_id: null }),
  ]);
  const own = { id: "review-station", short_id: null, title: "Review · ct-1", user_id: null, priority: { id: "p1", title: "Launch" } };
  test("the run that merged this very commit decides, before any newer run of its task", () => {
    expect(credit({ sha: "aaaaaaa1", at: 30, tasks: ["ct-1"] }, own)).toEqual({ id: "first", short_id: null, title: null, user_id: "me", priority: null });
  });
  test("else the newest run of its task started before the commit", () => {
    expect(credit({ sha: "ccccccc1", at: 30, tasks: ["ct-1"] }, own)?.id).toBe("second");
    expect(credit({ sha: "ccccccc1", at: 15, tasks: ["ct-1"] }, own)?.id).toBe("first");
    expect(credit({ sha: "ccccccc1", at: 5, tasks: ["ct-1"] }, own)).toBe(own);
  });
  test("stand-ins and runs without a spawner credit nobody; the commit keeps its own session", () => {
    expect(credit({ sha: "ccccccc1", at: 30, tasks: ["ct-2"] }, own)).toBe(own);
    expect(credit({ sha: "bbbbbbb1", at: 30, tasks: ["ct-1"] }, own)).toBe(own);
    expect(credit({ sha: "ccccccc1", at: 30, tasks: ["ct-3"] }, own)).toBe(own);
    expect(credit({ tasks: [] }, null)).toBeNull();
  });
  test("a credited session keeps the trailer's priority only when it is the same session", () => {
    const same = { ...own, id: "second" };
    expect(credit({ at: 30, tasks: ["ct-1"] }, same)?.priority).toEqual({ id: "p1", title: "Launch" });
    expect(credit({ at: 30, tasks: ["ct-1"] }, own)?.priority).toBeNull();
  });
  test("both columns credit the same way: queue and deploy rows land on the shipper", () => {
    const q = carriedOfQueue([commit("ddddddd1", 30, { task: "ct-1", session: sess("review-station"), insertions: 5, deletions: 1 })], credit);
    const d = carriedOfDeploy(deploy("dp-1", 30, { commits: 1, sessions: [sess("review-station")], commit_rows: [{ sha: "ddddddd2", subject: "x", conversation_id: "review-station", tasks: ["ct-1"] }] }), credit);
    expect(q.sessions.map((s) => s.id)).toEqual(["second"]);
    expect(d.sessions.map((s) => s.id)).toEqual(["second"]);
  });
  test("a deploy's session beyond its listed rows is credited through the tasks it names, else kept as listed", () => {
    const rows = [{ sha: "eeeeeee1", subject: "x", conversation_id: "s2", branch: null }];
    const station = { ...sess("review-station"), task_short_ids: ["ct-1"] };
    const d = carriedOfDeploy(deploy("dp-1", 30, { commits: 3, sessions: [station, sess("s2")], commit_rows: rows }), credit);
    expect(d.sessions.map((s) => [s.id, s.title])).toEqual([["s2", "Session s2"], ["second", null]]);
    // Its one commit names no branch: Branches has nothing to list.
    expect(d.branchesKnown).toBe(false);
    const old = carriedOfDeploy(deploy("dp-1", 30, { commits: 3, sessions: [sess("review-station"), sess("s2")], commit_rows: rows }), credit);
    expect(old.sessions.map((s) => s.id)).toEqual(["s2", "review-station"]);
  });
});

describe("the queue in main's order", () => {
  const groups = [
    { key: "a", session: null, ci: "passed" as const, commits: [commit("c1aaaaaa", 9, { main_at: 1 }), commit("c3aaaaaa", 3, { main_at: 3 })] },
    { key: "b", session: null, ci: "passed" as const, commits: [commit("c2aaaaaa", 2, { main_at: 2 }), commit("c4aaaaaa", 4, { main_at: 4 })] },
  ];
  const q = queueCommits(groups);
  test("by when each reached main, never by commit time; a row without its place on main sorts by commit time", () => {
    expect(q.map((c) => c.sha)).toEqual(["c4aaaaaa", "c3aaaaaa", "c2aaaaaa", "c1aaaaaa"]);
    const old = [{ ...groups[0]!, commits: [{ ...commit("o1aaaaaa", 5), main_at: undefined as unknown as number }, commit("o2aaaaaa", 1, { main_at: 9 })] }];
    expect(queueCommits(old).map((c) => c.sha)).toEqual(["o2aaaaaa", "o1aaaaaa"]);
  });
  test("a deploy sends its commit and older, Next deploy keeps the newer", () => {
    expect(upTo(q, "c2aaaaa").map((c) => c.sha)).toEqual(["c2aaaaaa", "c1aaaaaa"]);
    expect(after(q, "c2aaaaa").map((c) => c.sha)).toEqual(["c4aaaaaa", "c3aaaaaa"]);
  });
  test("a sha not waiting sends nothing new and leaves everything next", () => {
    expect(upTo(q, "ffffffff")).toEqual([]);
    expect(after(q, "ffffffff")).toHaveLength(4);
    const going = deploy("dp-3", 3, { status: "running", sha: "ffffffff" });
    expect(splitQueue(q, [going])).toMatchObject({ going: { short_id: "dp-3" }, sending: [] });
    expect(splitQueue(q, [deploy("dp-4", 4, { status: "running", sha: "c2aaaaaa" })]).next.map((c) => c.sha)).toEqual(["c4aaaaaa", "c3aaaaaa"]);
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
  test("a finished card's lines are read for the attempt it lists and matched by sha; unread ones stay unknown", () => {
    const rows = [{ sha: "l1aaaaaa", subject: "x", conversation_id: "s1" }, { sha: "l2aaaaaa", subject: "y", conversation_id: "s1" }];
    const group = [deploy("dp-8", 8, { sha: "x", status: "cancelled" }), deploy("dp-7", 7, { sha: "x", commits: 2, sessions: [sess("s1")], commit_rows: rows })];
    expect(recordedOf(group, [])?.short_id).toBe("dp-7");
    const lines = new Map([["dp-7", [{ sha: "l1aaaaaa", insertions: 4, deletions: 1, pr_number: 9, branch: "jb/x" }]]]);
    const c = carriedOfAttempts(group, [], noRuns, lines);
    expect(c.commits.map((x) => [x.sha, x.insertions, x.pr, x.branch])).toEqual([["l1aaaaaa", 4, 9, "jb/x"], ["l2aaaaaa", undefined, null, null]]);
    expect(c.sessions[0]).toMatchObject({ id: "s1", commits: 2, insertions: 4, deletions: 1 });
    expect(withLines(group[1]!, undefined)).toBe(group[1]);
    // A deploy sending the waiting commits reads none: its lines come with the queue.
    expect(recordedOf([deploy("dp-9", 9, { status: "running", sha: "q1aaaaaa" })], [commit("q1aaaaaa", 1)])).toBeNull();
    // It also sends the oldest commits the queue counted but did not list, and says how many.
    expect(carriedOfAttempts([deploy("dp-9", 9, { status: "running", sha: "q1aaaaaa" })], [commit("q1aaaaaa", 1)], shipperOf([]), undefined, 7).more).toBe(7);
  });
  test("an unfinished deploy at a sha no longer waiting lists what it recorded", () => {
    const queue = [commit("e2aaaaaa", 2, { session: sess("s2") })];
    const going = deploy("dp-6", 6, { status: "running", sha: "f9aaaaaa", commits: 1, commit_rows: [{ sha: "f9aaaaaa", subject: "y", conversation_id: "s7" }] });
    expect(carriedOfAttempts([going], queue, noRuns).sessions.map((s) => s.id)).toEqual(["s7"]);
  });
});

describe("deploy cards", () => {
  test("every attempt at one sha shares a card, the newest leading", () => {
    const ds = [deploy("dp-9", 9, { sha: "s2" }), deploy("dp-8", 8, { sha: "s1" }), deploy("dp-7", 7, { sha: "s2", status: "failed" }), deploy("dp-6", 6, { sha: null })];
    expect(attemptGroups(ds).map((g) => g.map((d) => d.short_id))).toEqual([["dp-9", "dp-7"], ["dp-8"], ["dp-6"]]);
  });
  test("a rollback or redeploy stands on its own card, never folded with a deploy of the same sha", () => {
    const ds = [deploy("dp-4", 4, { sha: "s1", action: "rollback" }), deploy("dp-3", 3, { sha: "s1", action: "redeploy" }), deploy("dp-2", 2, { sha: "s1" }), deploy("dp-1", 1, { sha: "s1", status: "failed" })];
    expect(attemptGroups(ds).map((g) => g.map((d) => d.short_id))).toEqual([["dp-4"], ["dp-3"], ["dp-2", "dp-1"]]);
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

  test("a task's newest place on main: next, the deploy sending it, else the newest deploy that carried it", () => {
    const queue = [commit("q2aaaaaa", 6, { task: "ct-3" }), commit("q1aaaaaa", 5, { task: "ct-1" })];
    const ds = [
      deploy("dp-1", 1, { tasks: [{ short_id: "ct-2" }] }),
      deploy("dp-2", 2, { commit_rows: [{ sha: "z", subject: "z", tasks: ["ct-1", "ct-2", "ct-4"] }] }),
      deploy("dp-3", 3, { status: "running", sha: "q1aaaaaa" }),
    ];
    expect(Object.fromEntries(tasksOnMain(queue, ds))).toEqual({ "ct-3": "next", "ct-1": "dp-3", "ct-2": "dp-2", "ct-4": "dp-2" });
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
    // Commits naming no branch are "not recorded", never the default branch.
    expect(rowsFor(c, "branches", isMine).map((r) => [r.key, r.label, r.commits, r.insertions])).toEqual([["feat", "feat", 2, 5], ["no-branch", null, 2, 1]]);
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
