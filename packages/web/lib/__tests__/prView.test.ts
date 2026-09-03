import { describe, expect, it } from "bun:test";
import {
  buildPrTimeline,
  checkOutcome,
  compareChecks,
  dayLabel,
  foldChecks,
  groupCommentsByFileLine,
  mergeStateMeta,
  prComments,
  prStateKey,
  threadResolved,
  unresolvedThreadCount,
  type CodeCommentRow,
  type PrCheck,
} from "../prView";

const check = (over: Partial<PrCheck>): PrCheck => ({
  name: "build",
  status: "completed",
  updated_at: 1,
  ...over,
});

const comment = (over: Partial<CodeCommentRow>): CodeCommentRow => ({
  _id: "c1",
  content: "hi",
  created_at: 1,
  ...over,
});

describe("checks", () => {
  it("reads the conclusion when the run ended and the status while it runs", () => {
    expect(checkOutcome(check({ conclusion: "success" }))).toBe("passed");
    expect(checkOutcome(check({ conclusion: "neutral" }))).toBe("passed");
    expect(checkOutcome(check({ conclusion: "failure" }))).toBe("failed");
    expect(checkOutcome(check({ conclusion: "timed_out" }))).toBe("failed");
    expect(checkOutcome(check({ conclusion: "skipped" }))).toBe("skipped");
    expect(checkOutcome(check({ status: "in_progress" }))).toBe("pending");
    expect(checkOutcome(check({ status: "queued" }))).toBe("pending");
    // A commit status carries its state in `status` with no conclusion.
    expect(checkOutcome(check({ status: "success" }))).toBe("passed");
    expect(checkOutcome(check({ status: "failure" }))).toBe("failed");
  });

  it("folds counts and puts failures first", () => {
    const checks = [
      check({ name: "a", conclusion: "success" }),
      check({ name: "b", status: "in_progress" }),
      check({ name: "c", conclusion: "failure" }),
      check({ name: "d", conclusion: "skipped" }),
    ];
    expect(foldChecks(checks)).toEqual({ passed: 1, failed: 1, pending: 1, skipped: 1, total: 4 });
    expect(foldChecks(undefined).total).toBe(0);
    expect([...checks].sort(compareChecks).map((c) => c.name)).toEqual(["c", "b", "a", "d"]);
  });
});

describe("PR state", () => {
  it("treats an open draft as its own state and merged as terminal", () => {
    expect(prStateKey({ state: "open" })).toBe("open");
    expect(prStateKey({ state: "open", draft: true })).toBe("draft");
    expect(prStateKey({ state: "merged", draft: true })).toBe("merged");
    expect(prStateKey({ state: "closed" })).toBe("closed");
  });

  it("says the one thing blocking the merge, and nothing once it landed", () => {
    expect(mergeStateMeta({ state: "open", mergeable_state: "dirty" })?.label).toBe("Conflicts");
    expect(mergeStateMeta({ state: "open", behind_by: 3 })?.label).toBe("Behind by 3");
    expect(mergeStateMeta({ state: "open", mergeable_state: "clean" })?.label).toBe("Ready to merge");
    expect(mergeStateMeta({ state: "open", mergeable_state: "unknown" })).toBeNull();
    expect(mergeStateMeta({ state: "merged", mergeable_state: "clean" })).toBeNull();
  });
});

describe("code comments", () => {
  const rows = [
    comment({ _id: "a", file_path: "src/x.ts", line_number: 10, created_at: 2 }),
    comment({ _id: "b", file_path: "src/x.ts", line_number: 10, created_at: 1 }),
    comment({ _id: "c", file_path: "src/y.ts", line_number: 4, resolved: true }),
    comment({ _id: "d", created_at: 5 }),
    comment({ _id: "e", parent_id: "d", created_at: 6 }),
    comment({ _id: "f", file_path: "src/z.ts" }),
  ];

  it("groups by file and line, oldest first, and drops unanchored rows", () => {
    const grouped = groupCommentsByFileLine(rows);
    expect([...grouped.keys()]).toEqual(["src/x.ts", "src/y.ts"]);
    expect(grouped.get("src/x.ts")!.get(10)!.map((c) => c._id)).toEqual(["b", "a"]);
  });

  it("counts only threads with something still open", () => {
    expect(unresolvedThreadCount(rows)).toBe(1);
    expect(threadResolved([comment({ resolved_at: 7 })])).toBe(true);
    expect(threadResolved([comment({ resolved: true }), comment({ _id: "x" })])).toBe(false);
    expect(threadResolved([])).toBe(false);
  });

  it("keeps replies out of the PR level list", () => {
    expect(prComments(rows).map((c) => c._id)).toEqual(["d"]);
  });
});

describe("timeline", () => {
  it("merges events, reviews and comments oldest first and hangs replies off their parent", () => {
    const timeline = buildPrTimeline({
      events: [{ _id: "e1", created_at: 30 }],
      reviews: [{ _id: "r1", state: "approved", submitted_at: 20 }],
      comments: [
        comment({ _id: "d", created_at: 10 }),
        comment({ _id: "e", parent_id: "d", created_at: 40 }),
      ],
    });
    expect(timeline.map((i) => i.key)).toEqual(["c:d", "r:r1", "e:e1"]);
    const first = timeline[0];
    expect(first.kind === "comment" && first.replies.map((r) => r._id)).toEqual(["e"]);
  });
});

describe("dayLabel", () => {
  it("names the recent days and dates the rest", () => {
    const now = new Date(2026, 8, 3, 12).getTime();
    expect(dayLabel(new Date(2026, 8, 3, 1).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 8, 2, 23).getTime(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 7, 20).getTime(), now)).toBe("Aug 20");
    expect(dayLabel(new Date(2025, 7, 20).getTime(), now)).toBe("Aug 20, 2025");
  });
});
