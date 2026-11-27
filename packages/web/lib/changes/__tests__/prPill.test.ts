import { describe, expect, test } from "bun:test";
import { prRowState } from "../prPill";
import { prFace } from "../../prStateGlyph";
import type { ChangePullRequest } from "../pullRequest";

const state = (p: Partial<ChangePullRequest>) => prRowState({ state: "open", ...p });

describe("a pull request row reads as one of its chips' states", () => {
  test("its life: open, draft, merged, closed", () => {
    expect(state({})).toBe("open");
    expect(state({ draft: true })).toBe("draft");
    expect(state({ state: "merged", merged_at: 1 })).toBe("merged");
    expect(state({ state: "closed", closed_at: 1 })).toBe("closed");
  });

  test("what it waits on, most pressing first, in the lifecycle's order", () => {
    expect(state({ mergeable_state: "dirty", checks_state: "failure" })).toBe("conflicts");
    expect(state({ checks_state: "failure", draft: true })).toBe("ci_red");
    expect(state({ review_decision: "changes_requested", checks_state: "pending" })).toBe("changes_requested");
    expect(state({ checks_state: "pending" })).toBe("ci_pending");
    expect(state({ review_decision: "review_required", checks_state: "success" })).toBe("review_pending");
    expect(state({ review_decision: "approved", checks_state: "pending" })).toBe("ci_pending");
    expect(state({ review_decision: "approved", checks_state: "success" })).toBe("ready");
    expect(state({ mergeable_state: "behind" })).toBe("behind");
  });
});

describe("a pull request's face is the same everywhere it is drawn", () => {
  test("its glyph says its life and the glyph after it what it waits on, in whose-problem color", () => {
    expect(prFace("open")).toMatchObject({ mark: "pr.open", accent: "green", settled: false });
    expect(prFace("open").After).toBeUndefined();
    expect(prFace("ci_red")).toMatchObject({ mark: "pr.open", afterMark: "pr.failing", accent: "red" });
    expect(prFace("conflicts")).toMatchObject({ afterMark: "pr.conflicts", accent: "red" });
    expect(prFace("review_pending")).toMatchObject({ afterMark: "pr.review_pending", accent: "yellow" });
    expect(prFace("draft")).toMatchObject({ mark: "pr.draft", accent: "muted" });
  });

  test("merged is a quiet green: settled once live or deploying nothing, bright with its reach until then", () => {
    expect(prFace("merged")).toMatchObject({ mark: "pr.merged", accent: "green", settled: true });
    expect(prFace("merged").After).toBeUndefined();
    expect(prFace("merged", "live")).toMatchObject({ settled: true, phrase: "merged and live" });
    expect(prFace("merged", "going_out")).toMatchObject({ settled: false, afterMark: "deploy.going_out", accent: "yellow" });
    expect(prFace("merged", "failed")).toMatchObject({ settled: false, afterMark: "deploy.failed", accent: "red" });
    expect(prFace("closed")).toMatchObject({ mark: "pr.closed", settled: true });
  });
});
