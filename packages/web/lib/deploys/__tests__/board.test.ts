import { after, onPrHead, splitQueue, upTo } from "@codecast/shared/contracts/deployTargets";
import { describe, expect, test } from "bun:test";
import {
  attemptGroups, branchHref, carriedOfAttempts, carriedOfDeploy, carriedOfQueue, fold, mineSessionIds, queueCommits, repositoryOfRun, rowsFor,
  recordedOf, runOwner, runState, shipperOf, shippingRuns, stepper, stepsFor, tasksOnMain, withLines, yourSessions,
  isMerged, type BoardDeploy, type BoardQueueCommit,
} from "../board";
import { runWord } from "../spot";
import type { ShippingRun, ShippingShipper } from "@codecast/shared/contracts/deployTargets";
import { at, end, replay, stoppedAt, type ReplayedRun } from "../../ship/__tests__/replayReports";

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
    run("stopped", { status: "failed", updated_at: NOW - 30 * 60_000, user_id: "me" }),
    run("stopped-yesterday", { status: "failed", updated_at: NOW - DAY }),
    run("dropped", { updated_at: NOW - 8 * DAY }),
    run("merged", { node_statuses: [{ node_id: "land__merge", status: "completed" }] }),
    run("deploying", { current_node_id: "deploy__await" }),
    run("recorded", { merge: { sha: "abc1234" } }),
    run("elsewhere", { pr: { repository: "o/x", number: 2 } }),
  ];
  const o = { repository: "o/r", checkouts: [], now: NOW, mine: false };
  test("stopped, then waiting on a person, then moving, newest first; a week without movement, or a stop an hour old, is dropped", () => {
    const { moving, dropped } = shippingRuns(runs, o);
    expect(moving.map((r) => r._id)).toEqual(["stopped", "paused", "moving-new", "moving-old"]);
    expect(dropped.map((r) => r._id)).toEqual(["stopped-yesterday", "dropped"]);
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
  // Ship on head A, then a fix round pushed B: the verdict binds to A, and the header says nobody reviewed B.
  test("a review verdict on an earlier head says nothing of the PR's head, unless Merge only rebased it there", () => {
    const pr = { repository: "o/r", number: 1, head_sha: "bbbbbbb" };
    const node_statuses = ns(["pr", "completed"], ["ci", "completed"], ["review", "completed"]);
    expect(stepper(run("h", { pr, node_statuses, ci_verdict: { green: true }, review_verdict: { verdict: "ship", head_sha: "aaaaaaa" } }))).toEqual(["done", "done", "idle", "idle"]);
    expect(stepper(run("h", { pr, node_statuses: ns(["pr", "completed"], ["review", "running"]), review_verdict: { verdict: "ship", head_sha: "aaaaaaa" } }))[2]).toBe("active");
    expect(stepper(run("h", { pr, node_statuses, review_verdict: { verdict: "ship", head_sha: "aaaaaaa" }, station_rebases: [{ from: "aaaaaaa", to: "bbbbbbb" }] }))[2]).toBe("done");
    expect(stepper(run("h", { pr, node_statuses, review_verdict: { verdict: "ship", head_sha: "bbbbbbb" } }))[2]).toBe("done");
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

describe("a run that goes straight onto main: Check · Review · Land", () => {
  const words = (r: ShippingRun) => stepsFor(r).map((s) => s.word);
  // The personal Ship as its runner reported it (lib/ship personalReports.json), as a Ship run row carries it.
  const asRun = (r: ReplayedRun) => run("p", { ...r, pr: null, node_statuses: r.node_statuses.map(({ node_id, status }) => ({ node_id, status })) });
  const PASS = replay("a passing check and a ship verdict land on origin's main");
  // A repository's own build flow (sit build.cast: implement, then the library's check, review and ship segments), as real runs ended.
  const ns = (...xs: Array<[string, string]>) => xs.map(([node_id, status]) => ({ node_id, status })) as ShippingRun["node_statuses"];
  const BUILT = ns(["start", "completed"], ["implement", "completed"], ["check", "completed"], ["check__verify", "completed"], ["check__passed", "completed"], ["review", "completed"], ["review__review", "completed"], ["review__changes", "failed"], ["review__approved", "completed"]);
  const build = (extra: Record<string, unknown>) => run("b", { pr: null, workflow_slug: "build", ...extra });

  test("a run with a pull request, or a pr station, keeps PR · CI · Review · Merge; one with nothing to read yet too", () => {
    expect(words(run("c"))).toEqual(["PR", "CI", "Review", "Merge"]);
    expect(words(run("u", { pr: null, node_statuses: ns(["start", "completed"], ["land", "running"], ["land__pr", "running"]) }))).toEqual(["PR", "CI", "Review", "Merge"]);
    expect(words(run("n", { pr: null, node_statuses: ns(["start", "completed"]) }))).toEqual(["PR", "CI", "Review", "Merge"]);
    expect(words(asRun(at(PASS, { node: "round", status: "running" })))).toEqual(["Check", "Review", "Land"]);
    expect(words(build({ node_statuses: ns(["start", "completed"], ["implement", "running"]) }))).toEqual(["Check", "Review", "Land"]);
  });

  test("running at Check: the check runs beside the review, and Check stays at work until the check has reported", () => {
    expect(stepper(asRun(at(PASS, { node: "find_check", status: "running" })))).toEqual(["active", "idle", "idle"]);
    expect(stepper(asRun(at(PASS, { node: "review", status: "running" })))).toEqual(["active", "active", "idle"]);
    expect(stepper(asRun(at(PASS, { node: "review", status: "completed" })))).toEqual(["active", "done", "idle"]);
    expect(stepper(asRun(at(PASS, { node: "checks", status: "completed" })))).toEqual(["done", "done", "idle"]);
    expect(stepper(asRun(at(PASS, { node: "land", status: "running" })))).toEqual(["done", "done", "active"]);
  });

  test("stopped at Review: Review red, Land not reached, and the card says where", () => {
    const stopped = asRun(stoppedAt(at(PASS, { node: "review", status: "running" })));
    expect(stepper(stopped)).toEqual(["done", "failed", "idle"]);
    expect(runWord(stopped)).toBe("Stopped at Review");
    const rejected = asRun(end(replay("a rejection ends the run at Rejected")));
    expect(stepper(rejected)).toEqual(["done", "failed", "idle"]);
    // The build flow's reviewer that never finished.
    expect(stepper(build({ status: "failed", current_node_id: "review__review", node_statuses: ns(["start", "completed"], ["implement", "completed"], ["check", "completed"], ["check__verify", "completed"], ["check__passed", "completed"], ["review", "completed"], ["review__review", "failed"]) }))).toEqual(["done", "failed", "idle"]);
  });

  test("landed is merged and leaves Shipping, as a merge does; a segment's own node completing lands nothing", () => {
    const landed = asRun(at(PASS, { node: "land", status: "completed" }));
    expect(stepper(landed)).toEqual(["done", "done", "done"]);
    expect(isMerged(landed)).toBe(true);
    expect(isMerged({ ...landed, merge: null })).toBe(true);
    const shipped = build({ node_statuses: [...BUILT, ...ns(["ship", "completed"], ["ship__rebase", "completed"], ["ship__ship", "completed"], ["ship__shipped", "completed"])] });
    expect(isMerged(shipped)).toBe(true);
    expect(shippingRuns([shipped, landed], { repository: "o/r", checkouts: [], now: NOW }).moving).toEqual([]);
    // The ship segment's node completes even when its rebase conflicted: Land is red, the run still Shipping.
    const conflict = build({ status: "failed", current_node_id: "ship__conflict", node_statuses: [...BUILT, ...ns(["ship", "completed"], ["ship__rebase", "failed"], ["ship__conflict", "failed"])] });
    expect(isMerged(conflict)).toBe(false);
    expect(stepper(conflict)).toEqual(["done", "done", "failed"]);
    expect(runWord(conflict)).toBe("Stopped at Land");
    // A rebase alone only leads to Land.
    expect(stepper(build({ node_statuses: [...BUILT, ...ns(["ship", "running"], ["ship__rebase", "completed"])] }))).toEqual(["done", "done", "active"]);
  });

  test("the server's track decides; without it a land segment's node alone keeps the pull request's track", () => {
    // Every Union change opens on its land segment's node before land__pr starts.
    const opening = ns(["start", "completed"], ["land", "running"]);
    expect(words(run("u", { pr: null, current_node_id: "land", node_statuses: opening }))).toEqual(["PR", "CI", "Review", "Merge"]);
    expect(words(run("u", { pr: null, track: "pr", current_node_id: "land", node_statuses: opening }))).toEqual(["PR", "CI", "Review", "Merge"]);
    expect(stepper(run("u", { pr: null, current_node_id: "land", node_statuses: opening }))).toEqual(["idle", "idle", "idle", "idle"]);
    // A direct-track run whose land segment has just opened: the bare node says nothing of Land.
    const direct = run("d", { pr: null, track: "direct", current_node_id: "land", node_statuses: opening });
    expect(words(direct)).toEqual(["Check", "Review", "Land"]);
    expect(stepper(direct)).toEqual(["idle", "idle", "idle"]);
    expect(isMerged({ ...direct, node_statuses: ns(["start", "completed"], ["land", "completed"]) })).toBe(false);
    // The track outranks what the run did: a direct run is never read as a pull request's, nor the reverse.
    expect(words(run("t", { track: "direct" }))).toEqual(["Check", "Review", "Land"]);
    expect(words(build({ track: "pr", node_statuses: ns(["start", "completed"], ["implement", "running"]) }))).toEqual(["PR", "CI", "Review", "Merge"]);
  });

  test("a change already on main leaves Shipping: Left the run, and a Land cut off that landed", () => {
    const left = asRun(end(replay("a briefed session that puts its change on main itself stops the run")));
    expect(left.status).toBe("failed");
    expect(left.node_statuses.find((n) => n.node_id === "leftrun")?.status).toBe("completed");
    expect(isMerged({ ...left, merge: null })).toBe(true);
    const cut = asRun(end(replay("cuts off during the catch-up says the change landed, and resuming it finishes and deploys (run 1)")));
    expect(cut.node_statuses.some((n) => n.node_id === "cutlanded")).toBe(true);
    expect(isMerged({ ...cut, merge: null })).toBe(true);
    expect(shippingRuns([{ ...left, merge: null }, { ...cut, merge: null }], { repository: "o/r", checkouts: [], now: NOW }).moving).toEqual([]);
  });

  test("a build stopped at Implement, before any step started, is red nowhere", () => {
    const stopped = build({ status: "failed", current_node_id: "implement", fail_reason: "Stopped: the builder could not finish", node_statuses: ns(["start", "completed"], ["implement", "failed"]) });
    expect(stepper(stopped)).toEqual(["idle", "idle", "idle"]);
    expect(runWord(stopped)).toBe("Stopped");
  });

  test("the check's own verdict decides Check, as CI's does: red is the run's to fix while it runs, red where it stopped", () => {
    // The personal Ship's check station completes whatever it found; check.json's outcome rides on the run.
    const red = { ...asRun(at(PASS, { node: "verdicts", status: "completed" })), check_verdict: { green: false, at: 1 }, review_verdict: null };
    expect(stepper(red)).toEqual(["active", "done", "idle"]);
    expect(runState({ ...red, current_node_label: "Fix findings" }).word).toBe("Fixing check failures");
    expect(stepper({ ...red, status: "failed" })).toEqual(["failed", "idle", "idle"]);
    expect(runWord({ ...red, status: "failed" })).toBe("Stopped at Check");
    // A green verdict is done even while the fan-out still runs beside the review.
    expect(stepper({ ...asRun(at(PASS, { node: "review", status: "running" })), check_verdict: { green: true, at: 1 } })).toEqual(["done", "active", "idle"]);
  });

  test("the build flow back at work after its reviewer asked for changes, and fixing a red check", () => {
    // The review segment's node completes whichever way it ended: its exit says the reviewer asked for changes, the run's
    // to fix while it runs; an approval in a later round settles it.
    expect(stepper(build({ current_node_id: "implement", node_statuses: [...BUILT.slice(0, 7), ...ns(["review__changes", "failed"])] }))).toEqual(["done", "active", "idle"]);
    expect(stepper(build({ current_node_id: "ship__rebase", node_statuses: [...BUILT, ...ns(["ship", "running"], ["ship__rebase", "running"])] }))).toEqual(["done", "done", "active"]);
    expect(stepper(build({ current_node_id: "check__verify", node_statuses: [...BUILT.slice(0, 4), ...ns(["check__verify", "running"])] }))).toEqual(["active", "idle", "idle"]);
    expect(runState(run("f", { pr: null, current_node_label: "Fix findings", node_statuses: ns(["check", "completed"], ["check__verify", "failed"], ["check__failed", "failed"]) })).word).toBe("Fixing check failures");
    expect(runState(run("f", { pr: null, current_node_label: "Fix findings", review_verdict: { verdict: "changes", at: 1 }, node_statuses: ns(["round", "completed"], ["check", "completed"]) })).word).toBe("Fixing review findings");
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
  // ct-102514: the session the run waits on pinned blocked on a card it asked; the card read "Fixing review findings".
  test("a session that asks a person: the run waits on that person, on you when the card is yours", () => {
    const asking = { current_node_label: "Fix findings", review_verdict: { verdict: "changes", at: 1, head_sha: "h1" }, waiting_on_session: { node_id: "brief", conversation_id: "c1", since: 5, blocked: true } };
    expect(runState(run("a", asking))).toEqual({ word: "Waiting for a person", tone: "blue" });
    const ask = { id: "d1", short_id: "sd-1", question: "Merge it?", open: true };
    expect(runState(run("a", asking), { ...ask, mine: true })).toEqual({ word: "Waiting on you", tone: "blue" });
    expect(runState(run("a", asking), { ...ask, mine: false })).toEqual({ word: "Waiting for a person", tone: "blue" });
    // Answered since the wait began: the session is fixing again.
    expect(runState(run("a", asking), { ...ask, mine: true, open: false }).word).toBe("Fixing review findings");
  });
  // ct-102698: the session pushed its fix after the brief and worked on; the run waited for its turn to end.
  test("a fix pushed past the judged head waits for the session's turn; a rebase is no fix", () => {
    const fixing = { current_node_label: "Fix findings", review_verdict: { verdict: "changes", at: 1, head_sha: "h1" }, ci_verdict: { green: true, head_sha: "h1", at: 1 }, waiting_on_session: { node_id: "brief", conversation_id: "c1", since: 5 } };
    const at = (head: string, extra: Record<string, unknown> = {}) => run("f", { ...fixing, pr: { repository: "o/r", number: 1, first_head_sha: "h0", head_sha: head, at: 1 }, ...extra });
    expect(runState(at("h1")).word).toBe("Fixing review findings");
    expect(runState(at("h2"))).toEqual({ word: "Fix pushed", tone: "yellow", detail: "Waiting for its session to finish its turn" });
    expect(runState(at("h2", { station_rebases: [{ from: "h1", to: "h2" }] })).word).toBe("Fixing review findings");
    // A session waiting on a person says that, pushed or not.
    expect(runState(at("h2", { waiting_on_session: { ...fixing.waiting_on_session, blocked: true } })).word).toBe("Waiting for a person");
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
  test("a deploy at a commit the queue does not list (it touched no path here) sends what its records name, and older", () => {
    // dp-3802 went out at b819337, a commit that touched nothing of cli's: its records name the cli commits it carries.
    const going = deploy("dp-5", 5, { status: "running", sha: "b8193370", commit_rows: [{ sha: "c4aaaaaa", subject: "x" }, { sha: "c3aaaaaa", subject: "y" }] });
    expect(splitQueue(q, [going])).toMatchObject({ going: { short_id: "dp-5" }, next: [] });
    expect(splitQueue(q, [going]).sending.map((c) => c.sha)).toEqual(["c4aaaaaa", "c3aaaaaa", "c2aaaaaa", "c1aaaaaa"]);
    const partly = deploy("dp-6", 6, { status: "running", sha: "b8193370", commit_rows: [{ sha: "c2aaaaaa", subject: "x" }] });
    expect(splitQueue(q, [partly]).next.map((c) => c.sha)).toEqual(["c4aaaaaa", "c3aaaaaa"]);
  });
  test("a deploy at main's head with no records of its own (a push target's build, a bare marker) sends the whole queue", () => {
    const bare = deploy("dp-7", 7, { status: "running", sha: "beadbeef", commit_rows: [] });
    expect(splitQueue(q, [bare], "beadbeef0000")).toMatchObject({ next: [] });
    expect(splitQueue(q, [bare], "beadbeef0000").sending).toHaveLength(4);
    // Without main's head the commit cannot be placed, and nothing is claimed.
    expect(splitQueue(q, [bare]).next).toHaveLength(4);
    expect(splitQueue(q, [bare], "0123abcd").next).toHaveLength(4);
  });
});

describe("a running run's track is at its station (pl-1077 polish 3)", () => {
  test("Local CI again after Merge's conflict was fixed: CI is current, Merge's failure is an earlier round's", () => {
    // ct-102487: approved, Merge conflicted, the session fixed it, and the change went back through Local CI.
    const r = run("lc", {
      current_node_id: "local_ci", current_node_label: "Local CI",
      ci_verdict: { green: true, head_sha: "aaa", at: 1 }, review_verdict: { verdict: "ship", at: 1, head_sha: "aaa" }, pr: { repository: "o/r", number: 318, head_sha: "bbb", first_head_sha: "aaa", at: 1 },
      node_statuses: [["pr", "completed"], ["checks", "completed"], ["ci", "completed"], ["review", "completed"], ["merge", "failed"], ["fix_conflict", "completed"], ["local_ci", "running"]].map(([node_id, status]) => ({ node_id, status })),
    });
    expect(stepsFor(r).map((s) => s.word)).toEqual(["PR", "CI", "Review", "Merge"]);
    expect(stepper(r)).toEqual(["done", "active", "idle", "idle"]);
    expect(runState(r).word).toBe("Local CI");
    // The session's conflict fix lands nothing: the run is still on its way to main.
    expect(isMerged(r)).toBe(false);
  });

  test("CI still running while Review already answered on this head: Review stays done", () => {
    // CI and review run side by side; the run's station is CI while the reviewer's ship on the PR's head stands.
    const r = run("cr", {
      current_node_id: "ci", current_node_label: "CI and review",
      review_verdict: { verdict: "ship", at: 1, head_sha: "aaa" }, pr: { repository: "o/r", number: 319, head_sha: "aaa", first_head_sha: "aaa", at: 1 },
      node_statuses: [["pr", "completed"], ["checks", "running"], ["ci", "running"], ["review", "completed"]].map(([node_id, status]) => ({ node_id, status })),
    });
    expect(stepper(r)).toEqual(["done", "active", "done", "idle"]);
    // A reviewer who asked for changes on this head is still the run's to fix while CI runs.
    expect(stepper({ ...r, review_verdict: { verdict: "changes", at: 1, head_sha: "aaa" } })).toEqual(["done", "active", "active", "idle"]);
    // A verdict on an older head speaks for nothing on this one.
    expect(stepper({ ...r, review_verdict: { verdict: "changes", at: 1, head_sha: "old" } })).toEqual(["done", "active", "idle", "idle"]);
  });
});

describe("a run is judged on the PR's real head (pl-1077 polish 4)", () => {
  test("Resolve conflict force-pushed a head the run has not recorded: its review and CI on the old head say nothing", () => {
    // PR #318: the run's pr.head_sha, review and CI stayed on 396830f while GitHub's head moved to 2424e6c.
    const r = run("rc", {
      status: "running", current_node_id: "local_ci", current_node_label: "Local CI",
      ci_verdict: { green: true, ci_changed: true, head_sha: "396830f", at: 1 }, review_verdict: { verdict: "ship", at: 1, head_sha: "396830f" },
      pr: { repository: "o/r", number: 318, head_sha: "396830f", first_head_sha: "a00cbbe", at: 1 },
      node_statuses: [["pr", "completed"], ["checks", "completed"], ["ci", "completed"], ["review", "completed"], ["merge", "failed"], ["fix_conflict", "completed"], ["local_ci", "running"]].map(([node_id, status]) => ({ node_id, status })),
    });
    // On the run's own record the rail claims Review passed.
    expect(stepper(r)).toEqual(["done", "active", "done", "idle"]);
    const seen = onPrHead(r, "2424e6c");
    expect(seen.pr?.head_sha).toBe("2424e6c");
    expect(stepper(seen)).toEqual(["done", "active", "idle", "idle"]);
    // Once the run reads the new head, its verdicts there count again.
    expect(stepper(onPrHead({ ...r, review_verdict: { verdict: "ship", at: 2, head_sha: "2424e6c" }, ci_verdict: { green: true, head_sha: "2424e6c", at: 2 } }, "2424e6c"))).toEqual(["done", "active", "done", "idle"]);
    // No PR row read yet: the run's own head stands.
    expect(onPrHead(r, null)).toBe(r);
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
  test("a branch row carries the first PR its commits name", () => {
    expect(rowsFor(c, "branches", isMine).map((r) => [r.key, r.pr])).toEqual([["feat", 7], ["no-branch", undefined]]);
  });
  test("priorities: yours by rank, then teammates' by rank, then the unranked, No priority last", () => {
    const pri = (id: string, rank: number | null, user_id?: string) => ({ id, title: id, rank, user_id });
    const p = carriedOfQueue([
      commit("p7aaaaaa", 7, { session: sess("s7") }),
      commit("p6aaaaaa", 6, { session: { ...sess("s6"), priority: { id: "pri-old", title: "Cached before ranks" } } }),
      commit("p5aaaaaa", 5, { session: { ...sess("s5"), priority: pri("pri-5", null, "me") } }),
      commit("p4aaaaaa", 4, { session: { ...sess("s4"), priority: pri("pri-4", 1, "them") } }),
      commit("p3aaaaaa", 3, { session: { ...sess("s3"), priority: pri("pri-3", 2, "me") } }),
      commit("p2aaaaaa", 2, { session: { ...sess("s2"), priority: pri("pri-2", 3, "them") } }),
      commit("p1aaaaaa", 1, { session: { ...sess("s1"), priority: pri("pri-1", 1, "me") } }),
    ], noRuns);
    // The unranked keep own rows first: s5 holds one of mine.
    const keys = (me: string | null) => rowsFor(p, "priorities", (id) => id === "s5", me).map((r) => r.key);
    expect(keys("me")).toEqual(["pri-1", "pri-3", "pri-4", "pri-2", "pri-5", "pri-old", "none"]);
    // Nobody's own without a viewer: every ranked row reads as a teammate's.
    expect(keys(null)).toEqual(["pri-4", "pri-1", "pri-3", "pri-2", "pri-5", "pri-old", "none"]);
  });
  test("branches of a deploy that never recorded them list nothing", () => {
    expect(rowsFor({ ...c, branchesKnown: false }, "branches", isMine)).toEqual([]);
  });
});

describe("branchHref", () => {
  test("a branch with a PR opens the PR page; without one, the branch on GitHub", () => {
    expect(branchHref("acme/app", "jb/fix", 42)).toBe("/pr/acme/app/42");
    expect(branchHref("acme/app", "jb/fix #2", null)).toBe("https://github.com/acme/app/tree/jb/fix%20%232");
    // A repository the PR route cannot name (no owner) still opens the branch on GitHub.
    expect(branchHref("app", "main", 3)).toBe("https://github.com/app/tree/main");
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
