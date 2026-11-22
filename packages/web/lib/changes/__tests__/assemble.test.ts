/**
 * One repository's rows in, its changes and their nows out: a worktree branch with a red pull request, a shared main
 * checkout's pass, a branch on two devices, merged and closed pull requests, a commit waiting on a target, a branch
 * only GitHub knows, and every reference form findChange takes.
 */
import { describe, expect, test } from "bun:test";
import type { CheckoutRow, CheckoutSession } from "@codecast/shared/contracts/checkouts";
import type { QueueCommit } from "@codecast/shared/contracts/deployTargets";
import type { DeployReach } from "@codecast/shared/contracts/deployReach";
import { assemble, findChange, withReach, type AssembledChange, type ChangePullRequest, type ChangeTarget } from "../assemble";
import { changeLifecycle } from "../lifecycle";
import { isQuiet } from "../rows";

const now = 1_790_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const repo = "acme/app";

const session = (id: string, state: CheckoutSession["state"], paths: string[]): CheckoutSession => ({
  conversation_id: id, session_id: `s-${id}`, client: "claude", state, last_activity: now - 5 * MIN, paths, more: 0,
});

const checkout = (over: Partial<CheckoutRow> & Pick<CheckoutRow, "path" | "branch" | "device_id">): CheckoutRow => ({
  _id: `${over.device_id}:${over.path}`, workspace: "team:t1", reported_at: now - 2 * MIN, device_label: "Ashot Main Mac",
  repository: repo, upstream: "origin/main", head_sha: "aaaaaaa1111", ahead: 0, behind: 0, fetched_at: now - 10 * MIN,
  uncommitted: { total: 0, sessions: [], unattributed: [], unattributed_more: 0 }, level: { state: "off", reason: "a worktree" },
  ...over,
});

const pr = (over: Partial<ChangePullRequest> & Pick<ChangePullRequest, "number" | "state">): ChangePullRequest => ({
  repository: repo, title: `PR ${over.number}`, updated_at: now - 30 * MIN, ...over,
});

const queued = (sha: string, subject: string, ci: QueueCommit["ci"] = "passed"): QueueCommit => ({
  sha, subject, at: now - 20 * MIN, author: "ashot", session: { conversation_id: "c-queue", short_id: "jx7abcd", title: null }, tasks: [], ci, ci_url: null,
});

const titles: Record<string, string> = { "c-chip": "Change chips", "c-a": "Deploy pill words", "c-b": "PR deploy band", "c-c": "Live needs evidence", "c-two": "Budget checks" };

const checkouts: CheckoutRow[] = [
  // The device's main checkout: three sessions' uncommitted work, one pass.
  checkout({
    device_id: "mac-1", path: "/Users/ashot/code/app", branch: "main", level: { state: "level", levelled_at: now - 3 * MIN },
    uncommitted: { total: 9, sessions: [session("c-a", "finished", ["a.ts"]), session("c-b", "idle", ["b.ts"]), session("c-c", "finished", ["c.ts"])], unattributed: [], unattributed_more: 0 },
  }),
  // A worktree on a branch with an open pull request whose CI failed.
  checkout({ device_id: "mac-1", path: "/Users/ashot/code/app/.codecast/worktrees/change-chips", branch: "change-chips", ahead: 3, head_sha: "c0ffee12345" }),
  // One branch on two devices: the older report's session is still a writer.
  checkout({ device_id: "mac-1", path: "/Users/ashot/code/app/.codecast/worktrees/budget", branch: "evals/budget", ahead: 2, reported_at: now - 40 * MIN,
    uncommitted: { total: 1, sessions: [session("c-old", "finished", ["x.ts"])], unattributed: [], unattributed_more: 0 } }),
  checkout({ device_id: "box-2", device_label: "union-shared", path: "/home/ashot/app/worktrees/budget", branch: "evals/budget", ahead: 4, reported_at: now - 1 * MIN,
    uncommitted: { total: 6, sessions: [session("c-two", "working", ["y.ts", "z.ts"])], unattributed: [], unattributed_more: 0 } }),
  // A worktree with nothing main lacks: not a change.
  checkout({ device_id: "mac-1", path: "/Users/ashot/code/app/.codecast/worktrees/idle", branch: "idle-tree" }),
];

const prs: ChangePullRequest[] = [
  pr({ number: 101, state: "open", head_ref: "change-chips", head_sha: "c0ffee12345", checks_state: "failure", review_decision: "approved", linked_session_ids: ["c-chip"],
    checks: [{ name: "test-web", status: "completed", conclusion: "failure" }, { name: "lint", status: "completed", conclusion: "success" }, { name: "typecheck", status: "completed", conclusion: "success" }] }),
  pr({ number: 90, state: "merged", head_ref: "deploy-pill", merge_commit_sha: "beefbeef0001", merged_at: now - 2 * 60 * MIN, checks_state: "success", review_decision: "approved" }),
  pr({ number: 91, state: "closed", head_ref: "abandoned", closed_at: now - DAY, checks_state: "failure" }),
  pr({ number: 50, state: "merged", head_ref: "ancient", merge_commit_sha: "0ld0ld0ld01", merged_at: now - 30 * DAY }),
];

const targets: ChangeTarget[] = [
  { name: "backend", repository: repo, queue: { groups: [{ commits: [queued("beefbeef0001aaaa", "Deploy pill words (#90)"), queued("d15ec7d15ec7", "Fix the deploy pill", "failed")] }] } },
  { name: "web", repository: repo, queue: { groups: [{ commits: [queued("d15ec7d15ec7", "Fix the deploy pill", "failed")] }] } },
];

const branches = {
  default_branch: "main",
  branches: [
    { name: "main", sha: "m41n", committed_at: now - MIN, ahead_by: 0, open_pr: null },
    { name: "evals/budget", sha: "b4d6e7", committed_at: now - 3 * MIN, ahead_by: 4, open_pr: null },
    { name: "remote-only", sha: "r3m07e0001", committed_at: now - 15 * MIN, ahead_by: 2, open_pr: null },
    { name: "merged-away", sha: "aa11bb22", committed_at: now - 5 * DAY, ahead_by: 0, open_pr: null },
  ],
};

const changes = assemble({ repository: "Acme/App", now, checkouts, pullRequests: prs, targets, branches, titleOf: (id) => titles[id] });
const byKey = Object.fromEntries(changes.map((c) => [c.key, c])) as Record<string, AssembledChange>;
const nowWords = (c: AssembledChange) => {
  const l = changeLifecycle(c.facts);
  return `${l.now.stage}: ${l.now.word}${l.now.detail ? ` · ${l.now.detail}` : ""} (${l.now.tone})`;
};

describe("assemble", () => {
  test("one change per thing heading to production, and nothing for an idle worktree or an old pull request", () => {
    expect(changes.map((c) => c.key).sort()).toEqual([
      "branch:change-chips",
      "branch:evals/budget",
      "branch:remote-only",
      "commit:d15ec7d15ec7",
      "pass:mac-1:/Users/ashot/code/app",
      "pr:90",
      "pr:91",
    ]);
  });

  test("each change's now, in the lifecycle's words", () => {
    expect(Object.fromEntries(changes.map((c) => [c.key, nowWords(c)]))).toEqual({
      "branch:change-chips": "check: checks failed · test-web (red)",
      "branch:evals/budget": "work: editing (yellow)",
      "branch:remote-only": "check: not checked (muted)",
      "commit:d15ec7d15ec7": "check: red on main (red)",
      "pass:mac-1:/Users/ashot/code/app": "work: between turns (muted)",
      "pr:90": "land: landed (green)",
      "pr:91": "check: closed (dim)",
    });
  });

  test("a worktree branch joins its open pull request: failing checks by name, the worktree, the PR page", () => {
    const c = byKey["branch:change-chips"];
    expect(c.facts.vehicle).toEqual({ kind: "branch", name: "change-chips", worktree: "/Users/ashot/code/app/.codecast/worktrees/change-chips", pr: 101 });
    expect(c.facts.check).toEqual({ ci: "failure", review: "approved", failing: ["test-web"], passed: 2 });
    expect(c.facts.work).toMatchObject({ uncommitted: 0, ahead: 3, pushed: true });
    expect(c.links).toEqual({ href: "/pr/acme/app/101", pr: "/pr/acme/app/101", deploys: [], action: null });
    expect(c.writers).toEqual([{ conversation_id: "c-chip", title: "Change chips", state: "finished", href: "/conversation/c-chip" }]);
    expect(c.where).toBe("change-chips · Ashot Main Mac");
    expect(c.reach_ref).toBeNull();
  });

  test("the shared main checkout's three sessions are one pass", () => {
    const c = byKey["pass:mac-1:/Users/ashot/code/app"];
    expect(c.facts.vehicle).toEqual({ kind: "pass", folder: "/Users/ashot/code/app", sessions: 3, files: 9 });
    expect(c.writers.map((w) => `${w.title}:${w.state}`)).toEqual(["Deploy pill words:finished", "PR deploy band:idle", "Live needs evidence:finished"]);
    expect(c.links.href).toBeNull();
  });

  test("a branch on two devices is one change: the freshest report's counts, every report's writers, pushed per GitHub", () => {
    const c = byKey["branch:evals/budget"];
    expect(c.facts.work).toMatchObject({ uncommitted: 6, ahead: 4, pushed: true });
    expect(c.facts.vehicle).toMatchObject({ worktree: "/home/ashot/app/worktrees/budget" });
    expect(c.writers.map((w) => w.title)).toEqual(["Budget checks", null]);
    expect(c.where).toBe("budget · union-shared +1");
    expect(c.links.href).toBe("/repo/acme/app/compare/main...evals%2Fbudget");
    // Updated is the newest work on it (here its last pushed commit), never when a daemon last reported the checkout.
    expect(c.updated_at).toBe(now - 3 * MIN);
  });

  test("a merged pull request is landed with a reach ref; its commit waiting on a target is not a second change", () => {
    const c = byKey["pr:90"];
    expect(c.facts.land).toEqual({ state: "landed", how: "merged", sha: "beefbeef0001", at: now - 2 * 60 * MIN });
    expect(c.reach_ref).toBe("acme/app#90");
    expect(c.facts.deploys).toBe(true);
  });

  test("a closed pull request stops where it was", () => {
    expect(byKey["pr:91"].facts.closed).toEqual({ at: now - DAY });
  });

  test("a commit on main a target has not deployed is a pushed commit, once though two targets wait on it", () => {
    const c = byKey["commit:d15ec7d15ec7"];
    expect(c.facts).toMatchObject({ vehicle: { kind: "commit", sha: "d15ec7d15ec7" }, land: { state: "landed", how: "pushed" }, check: { ci: "failure", after_land: true } });
    expect(c.reach_ref).toBe("acme/app@d15ec7d15ec7");
    expect(c.links.href).toBe("/commit/acme/app/d15ec7d15ec7");
  });

  test("a repository without deploy targets lands at the end", () => {
    const [only] = assemble({ repository: repo, now, pullRequests: [prs[1]], targets: [] });
    expect(only.facts.deploys).toBe(false);
    expect(nowWords(only)).toBe("land: landed (green)");
  });

  test("its reach laid on moves it to Deploy and links the deploys", () => {
    const reach: DeployReach = { state: "going_out", sha: "beefbeef0001", targets: [
      { target: "backend", state: "going_out", deploy: { short_id: "dp-12", status: "running", sha: "beefbeef0001", at: now - 4 * MIN, url: null }, now: null },
      { target: "web", state: "live", deploy: { short_id: "dp-11", status: "live", sha: "beefbeef0001", at: now - 9 * MIN, url: null }, now: null },
    ] };
    const c = withReach(byKey["pr:90"], reach);
    expect(nowWords(c)).toBe("deploy: deploying · 1 of 2 live (yellow)");
    expect(c.links.deploys).toEqual([{ id: "dp-12", href: "/deploys?deploy=dp-12" }, { id: "dp-11", href: "/deploys?deploy=dp-11" }]);
  });
});

describe("assemble, a branch after its pull request merged", () => {
  const merged = pr({ number: 70, state: "merged", head_ref: "feat/next", head_sha: "bbbbbbb2222", merge_commit_sha: "ccccccc3333", merged_at: now - 2 * 60 * MIN });
  test("new work in its checkout is a change of its own, and the merged pull request keeps its row", () => {
    const wt = checkout({ path: "/w/next", branch: "feat/next", device_id: "d1", head_sha: "ddddddd4444", ahead: 1, uncommitted: { total: 3, sessions: [session("c-chip", "working", ["a.ts"])], unattributed: [], unattributed_more: 0 } });
    const got = assemble({ repository: repo, now, checkouts: [wt], pullRequests: [merged], titleOf: (id) => titles[id] });
    const branch = got.find((c) => c.key === "branch:feat/next")!;
    expect(changeLifecycle(branch.facts).now.word).toBe("editing");
    expect(branch.refs.pr).toBeNull();
    expect(got.some((c) => c.key === "pr:70" && c.facts.land?.state === "landed")).toBe(true);
  });
  test("a checkout still at the merged head is that pull request's change", () => {
    const wt = checkout({ path: "/w/next", branch: "feat/next", device_id: "d1", head_sha: "bbbbbbb2222", ahead: 1 });
    const got = assemble({ repository: repo, now, checkouts: [wt], pullRequests: [merged], titleOf: (id) => titles[id] });
    expect(got.map((c) => c.key)).toEqual(["branch:feat/next"]);
    expect(got[0].facts.land?.state).toBe("landed");
  });
  test("a draft, auto-merge and a review a person owes reach the facts", () => {
    const open = (n: number, over: Partial<ChangePullRequest>) => pr({ number: n, state: "open", head_ref: `x/${n}`, checks_state: "success", ...over });
    const got = assemble({ repository: repo, now, pullRequests: [open(81, { draft: true }), open(82, { auto_merge: { method: "squash" }, review_decision: "APPROVED" }), open(83, { review_decision: "REVIEW_REQUIRED" })] });
    const word = (n: number) => changeLifecycle(got.find((c) => c.refs.pr === n)!.facts).now.word;
    expect([word(81), word(82), word(83)]).toEqual(["draft", "landing", "needs review"]);
  });
});

describe("assemble and the grid, for work nobody's session still holds", () => {
  test("a worktree branch committed but never pushed dates from its checkout's report, so it is not quiet the moment it is made", () => {
    const wt = checkout({ path: "/w/done", branch: "feat/done", device_id: "d1", head_sha: "eeeeeee5555", ahead: 2, reported_at: now - 10 * MIN });
    const c = assemble({ repository: repo, now, checkouts: [wt] }).find((x) => x.key === "branch:feat/done")!;
    expect(c.updated_at).toBe(now - 10 * MIN);
    const row = { key: c.key, lifecycle: changeLifecycle(c.facts), updated_at: c.updated_at };
    expect(row.lifecycle.now.word).toBe("not shipped");
    expect(isQuiet(row, now)).toBe(false);
    expect(isQuiet(row, now + 4 * DAY)).toBe(true);
  });
  test("a person's turn and a failure never go quiet, however old", () => {
    const old = (number: number, over: Partial<ChangePullRequest>) => pr({ number, state: "open", head_ref: `x/${number}`, created_at: now - 9 * DAY, files_synced_at: now - 9 * DAY, ...over });
    const got = assemble({ repository: repo, now, pullRequests: [old(91, { checks_state: "success", review_decision: "REVIEW_REQUIRED" }), old(92, { checks_state: "failure" }), old(93, { draft: true, checks_state: "success" })] });
    const quiet = (n: number) => { const c = got.find((x) => x.refs.pr === n)!; return isQuiet({ key: c.key, lifecycle: changeLifecycle(c.facts), updated_at: c.updated_at }, now); };
    expect([quiet(91), quiet(92), quiet(93)]).toEqual([false, false, true]);
  });
});

describe("findChange", () => {
  const key = (ref: string) => findChange(changes, ref)?.key ?? null;
  test("every reference form", () => {
    expect(key("change-chips")).toBe("branch:change-chips");
    expect(key("evals/budget")).toBe("branch:evals/budget");
    expect(key("#101")).toBe("branch:change-chips");
    expect(key("acme/app#90")).toBe("pr:90");
    expect(key("Acme/App#91")).toBe("pr:91");
    expect(key("c0ffee1")).toBe("branch:change-chips");
    expect(key("acme/app@beefbeef0001")).toBe("pr:90");
    expect(key("acme/app@d15ec7d")).toBe("commit:d15ec7d15ec7");
  });
  test("what names nothing here", () => {
    expect(key("other/repo#90")).toBeNull();
    expect(key("#999")).toBeNull();
    expect(key("abc12")).toBeNull();
    expect(key("no-such-branch")).toBeNull();
  });
});
