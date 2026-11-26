/**
 * ct-101824: a pull request whose checks failed, that waits for review, or that is ready to land, and that nobody has
 * touched in three days, is not on its way anywhere: it parks, and leaves the Needs attention group and its count.
 * A fresh one in the same state stays in Needs attention.
 */
import { describe, expect, test } from "bun:test";
import { assemble, type ChangePullRequest } from "../assemble";
import { changeLifecycle } from "../lifecycle";
import { groupChanges, groupOf, isParked, type ChangeRow } from "../rows";

const now = 1_790_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const repo = "acme/app";

const at = (number: number, age: number, over: Partial<ChangePullRequest>): ChangePullRequest => ({
  repository: repo, number, state: "open", title: `PR ${number}`, head_ref: `x/${number}`,
  created_at: now - age, updated_at: now - age, files_synced_at: now - age, ...over,
});
const FAILED = { checks_state: "failure" } as const;
const REVIEW = { checks_state: "success", review_decision: "REVIEW_REQUIRED" } as const;
const READY = { checks_state: "success", review_decision: "APPROVED" } as const;

const changes = assemble({
  repository: repo,
  now,
  pullRequests: [
    at(1, 9 * DAY, FAILED), at(2, 9 * DAY, REVIEW), at(3, 9 * DAY, READY),
    at(11, 1 * DAY, FAILED), at(12, 1 * DAY, REVIEW), at(13, 1 * DAY, READY),
  ],
});
const rows: ChangeRow[] = changes.map((c) => ({ key: c.key, lifecycle: changeLifecycle(c.facts), updated_at: c.updated_at }) as ChangeRow);
const row = (n: number) => rows[changes.findIndex((c) => c.refs.pr === n)]!;

describe("stale pull requests leave Needs attention (ct-101824)", () => {
  test("the fixtures are the states the cause names", () => {
    expect([1, 2, 3].map((n) => row(n).lifecycle.now.word)).toEqual(["checks failed", "needs review", "ready to land"]);
    expect([1, 2, 3].map((n) => row(n).lifecycle.now.tone)).toEqual(["red", "blue", "blue"]);
  });

  test("failed, waiting-for-review and ready-to-land PRs untouched for 9 days are parked", () => {
    expect([1, 2, 3].map((n) => isParked(row(n), now))).toEqual([true, true, true]);
    expect([1, 2, 3].map((n) => groupOf(row(n), now))).toEqual(["parked", "parked", "parked"]);
  });

  test("the same states touched a day ago still need attention", () => {
    expect([11, 12, 13].map((n) => groupOf(row(n), now))).toEqual(["you", "you", "you"]);
  });

  test("the Needs attention count holds only the fresh ones", () => {
    const you = groupChanges(rows, now).find((g) => g.id === "you");
    expect(you?.rows.map((r) => changes[rows.indexOf(r)]!.refs.pr).sort((a, b) => a! - b!)).toEqual([11, 12, 13]);
  });
});
