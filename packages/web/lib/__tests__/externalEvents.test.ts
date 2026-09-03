import { describe, expect, it } from "bun:test";
import {
  DEFAULT_EXTERNAL_EVENT_STYLE,
  accentVar,
  commitPath,
  eventAccent,
  externalEventStyle,
  filePath,
  gitEventToExternalEvent,
  prPath,
  registerExternalEventStyles,
  shepherdStyle,
  shortSha,
} from "../externalEvents";

describe("gitEventToExternalEvent", () => {
  it("carries the codecast objects an event belongs to into refs", () => {
    const event = gitEventToExternalEvent({
      _id: "g1",
      repository: "codecast-sh/codecast",
      kind: "pr_check",
      actor_login: "ashot",
      actor_avatar_url: "https://example.test/a.png",
      title: "build",
      summary: "2 tests failed",
      url: "https://github.com/codecast-sh/codecast/runs/1",
      sha: "abcdef1234567890",
      branch: "main",
      pr_number: 42,
      conversation_id: "conv1",
      task_id: "task1",
      task_ids: ["task1", "task2"],
      plan_ids: ["plan1"],
      project_ids: ["proj1"],
      meta: { conclusion: "failure", check_name: "build" },
      created_at: 1000,
    });

    expect(event.id).toBe("g1");
    expect(event.source).toBe("github");
    expect(event.kind).toBe("pr_check");
    expect(event.at).toBe(1000);
    expect(event.refs.session_id).toBe("conv1");
    expect(event.refs.task_id).toBe("task1");
    expect(event.refs.plan_id).toBe("plan1");
    expect(event.refs.project_id).toBe("proj1");
    expect(event.refs.pr).toEqual({ repository: "codecast-sh/codecast", number: 42 });
    expect(event.refs.commit).toEqual({ repository: "codecast-sh/codecast", sha: "abcdef1234567890" });
    expect(event.actor?.login).toBe("ashot");
    expect(event.meta?.repository).toBe("codecast-sh/codecast");
    expect(event.meta?.branch).toBe("main");
  });

  it("falls back to the first task id when task_id is absent", () => {
    const event = gitEventToExternalEvent({ _id: "g2", task_ids: ["taskA"], created_at: 1 });
    expect(event.refs.task_id).toBe("taskA");
  });

  it("builds a file ref from the comment metadata", () => {
    const event = gitEventToExternalEvent({
      _id: "g3",
      repository: "o/r",
      kind: "code_comment",
      title: "nit",
      sha: "deadbeefcafe",
      meta: { file_path: "packages/web/app/page.tsx", line_number: 12 },
      created_at: 5,
    });
    expect(event.refs.file).toEqual({
      repository: "o/r",
      path: "packages/web/app/page.tsx",
      ref: "deadbeefcafe",
      line: 12,
    });
  });

  it("leaves the actor out when the row names nobody", () => {
    const event = gitEventToExternalEvent({ _id: "g4", created_at: 1 });
    expect(event.actor).toBeUndefined();
    expect(event.refs.pr).toBeUndefined();
    expect(event.refs.commit).toBeUndefined();
  });
});

describe("style registry", () => {
  it("knows every git kind", () => {
    for (const kind of [
      "commit", "push", "pr_opened", "pr_synchronize", "pr_review", "pr_review_comment",
      "pr_check", "pr_merged", "pr_closed", "pr_reopened", "pr_behind", "pr_conflict",
      "pr_ready", "pr_review_requested", "pr_ready_for_review", "pr_draft", "pr_edited",
      "code_comment",
    ]) {
      expect(externalEventStyle(kind)).not.toBe(DEFAULT_EXTERNAL_EVENT_STYLE);
    }
  });

  it("falls back to the default for a kind it has never seen", () => {
    expect(externalEventStyle("linear_issue_moved_nowhere")).toBe(DEFAULT_EXTERNAL_EVENT_STYLE);
  });

  it("takes registrations from another source", () => {
    const style = { icon: DEFAULT_EXTERNAL_EVENT_STYLE.icon, accent: "cyan" as const, verb: "moved" };
    registerExternalEventStyles({ linear_issue_state: style });
    expect(externalEventStyle("linear_issue_state")).toBe(style);
  });
});

describe("accents", () => {
  const at = 1;
  it("lets a failed check outrank its kind's color", () => {
    const failed = { id: "1", source: "github" as const, kind: "pr_check", title: "t", at, refs: {}, meta: { conclusion: "failure" } };
    expect(eventAccent(failed)).toBe("red");
  });

  it("uses the kind's color when nothing reports an outcome", () => {
    const merged = { id: "1", source: "github" as const, kind: "pr_merged", title: "t", at, refs: {} };
    expect(eventAccent(merged)).toBe("violet");
  });

  it("reads a review state case insensitively", () => {
    const review = { id: "1", source: "github" as const, kind: "pr_review", title: "t", at, refs: {}, meta: { review_state: "APPROVED" } };
    expect(eventAccent(review)).toBe("green");
  });

  it("resolves every accent to a token, never a hex", () => {
    expect(accentVar("green")).toBe("var(--sol-green)");
    expect(accentVar(undefined)).toBe("var(--sol-text-muted)");
  });
});

describe("paths", () => {
  it("addresses a pull request, a commit and a file", () => {
    expect(prPath({ repository: "o/r", number: 7 })).toBe("/pr/o/r/7");
    expect(commitPath({ repository: "o/r", sha: "abc" })).toBe("/commit/o/r/abc");
    expect(filePath({ repository: "o/r", path: "a/b.ts", ref: "main", line: 3 })).toBe("/repo/o/r/blob/main/a/b.ts#L3");
  });

  it("refuses a repository that is not owner/name", () => {
    expect(prPath({ repository: "justrepo", number: 7 })).toBeNull();
    expect(commitPath(undefined)).toBeNull();
    expect(filePath({ repository: "o/r", path: "" })).toBeNull();
  });

  it("shortens a sha to seven characters", () => {
    expect(shortSha("abcdef1234567890")).toBe("abcdef1");
    expect(shortSha(undefined)).toBe("");
  });
});

describe("shepherd states", () => {
  it("colors each state the reader must act on", () => {
    expect(shepherdStyle("ci_red").accent).toBe("red");
    expect(shepherdStyle("approved").accent).toBe("green");
    expect(shepherdStyle("merged").accent).toBe("violet");
    expect(shepherdStyle("behind").accent).toBe("orange");
  });

  it("reads an unknown state as plain open", () => {
    expect(shepherdStyle(undefined).label).toBe("open");
    expect(shepherdStyle("something_new").label).toBe("something_new");
  });
});
