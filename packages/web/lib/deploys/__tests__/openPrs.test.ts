// Every open pull request on the Deploys page: the ones no Ship run carries (openPrs), their stepper and words read
// from GitHub (prStepper, prState), a link to one (prMatches) and the focus chip's words for it (changeSpot). None
// fold away for age: a push to main restamps every open PR's updated_at at once.
import { describe, expect, test } from "bun:test";
import { openPrs, prState, prStepper, queueCommits, type OpenPr } from "../board";
import { prMatches } from "../focus";
import { changeSpot } from "../spot";

const DAY = 24 * 60 * 60_000;
const NOW = 100 * DAY;

const pr = (number: number, extra: Partial<OpenPr> = {}): OpenPr => ({
  _id: `pr${number}`, repository: "o/r", number, title: `PR ${number}`, state: "open", created_at: NOW - 60_000, ...extra,
});
const carrying = (number: number, repository = "o/r") => ({ pr: { repository, number }, task_id: null });

describe("openPrs", () => {
  test("keeps the repository's open PRs no run carries and whose commit is not on main, newest opened first", () => {
    const prs = [
      pr(1, { created_at: NOW - 3 * DAY }),
      pr(2),
      pr(3, { state: "merged" }),
      pr(4, { repository: "o/other" }),
      pr(5),
      pr(6, { created_at: NOW - 2 * DAY }),
      pr(8, { created_at: NOW - 30 * DAY }),
    ];
    const got = openPrs(prs, { repository: "O/R", runs: [carrying(5)], landedPrs: new Set([6]) });
    expect(got.map((p) => p.number)).toEqual([2, 1, 8]);
  });

  test("a run that recorded no PR carries the PRs that name its task", () => {
    const runs = [{ pr: null, task_id: "t1" }];
    expect(openPrs([pr(1, { task_ids: ["t1"] }), pr(2, { task_ids: ["t2"] })], { repository: "o/r", runs }).map((p) => p.number)).toEqual([2]);
  });

  test("a run on another repository with the same number carries nothing here", () => {
    expect(openPrs([pr(7)], { repository: "o/r", runs: [carrying(7, "o/other")] }).map((p) => p.number)).toEqual([7]);
  });

  test("keep narrows them (Mine)", () => {
    const prs = [pr(1, { author_github_username: "me" }), pr(2, { author_github_username: "you" })];
    expect(openPrs(prs, { repository: "o/r", runs: [], keep: (p) => p.author_github_username === "me" }).map((p) => p.number)).toEqual([1]);
  });
});

describe("prStepper and prState", () => {
  test("a fresh PR with nothing known waits on review", () => {
    expect(prStepper({})).toEqual(["done", "idle", "idle", "idle"]);
    expect(prState({})).toEqual({ word: "Waiting on review", tone: "blue" });
  });

  test("a draft is the author's turn on the PR step", () => {
    expect(prStepper({ draft: true, checks_state: "success" })).toEqual(["waiting", "done", "idle", "idle"]);
    expect(prState({ draft: true, checks_state: "failure" }).word).toBe("Draft");
  });

  test("red CI, conflicts and requested changes stop it, in that order", () => {
    expect(prStepper({ checks_state: "failure", review_decision: "changes_requested", mergeable_state: "dirty" })).toEqual(["done", "failed", "failed", "failed"]);
    expect(prState({ checks_state: "failure", mergeable_state: "dirty" })).toEqual({ word: "CI failing", tone: "red" });
    expect(prState({ checks_state: "success", mergeable_state: "dirty", review_decision: "changes_requested" }).word).toBe("Merge conflicts");
    expect(prState({ checks_state: "success", review_decision: "changes_requested" }).word).toBe("Changes requested");
  });

  test("running CI is moving; an approved green PR is ready, and says when it is behind main", () => {
    expect(prStepper({ checks_state: "pending" })).toEqual(["done", "active", "idle", "idle"]);
    expect(prState({ checks_state: "pending" })).toEqual({ word: "CI running", tone: "yellow" });
    expect(prStepper({ checks_state: "success", review_decision: "approved" })).toEqual(["done", "done", "done", "idle"]);
    expect(prState({ checks_state: "success", review_decision: "approved", mergeable_state: "behind", behind_by: 13 })).toEqual({ word: "Ready to merge", tone: "blue", detail: "behind main by 13" });
  });
});

describe("a link to an open PR", () => {
  test("prMatches by number, or by its branch", () => {
    expect(prMatches(pr(3, { head_ref: "fix/x" }), { kind: "pr", pr: 3 })).toBe(true);
    expect(prMatches(pr(3, { head_ref: "fix/x" }), { kind: "branch", name: "fix/x" })).toBe(true);
    expect(prMatches(pr(3), { kind: "pr", pr: 4 })).toBe(false);
    expect(prMatches(pr(3), null)).toBe(false);
  });

  test("the focus chip finds a PR no run carries, however old, instead of saying it is not here", () => {
    const target = { policy: "press", runs: "here", can_deploy: true, queue: { known: true, truncated: false, commits: 0, untouched: 0, head_sha: null, head_ci: "none", head_ci_url: null, shown: 0, groups: [] } } as any;
    const base = { target, queue: queueCommits([]), history: [], live: null, focusDeploys: [], reach: null, paused: false, shipping: { moving: [], dropped: [] } };
    const old = pr(73, { created_at: NOW - 20 * DAY, checks_state: "failure" });
    expect(changeSpot({ ...base, focus: { kind: "pr", pr: 73 }, openPrs: [old] })).toEqual({ kind: "pr", pr: old, word: "CI failing" });
    expect(changeSpot({ ...base, focus: { kind: "pr", pr: 99 }, openPrs: [old] })).toEqual({ kind: "absent" });
  });
});
