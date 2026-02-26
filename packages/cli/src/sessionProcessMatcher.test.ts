import { describe, expect, test } from "bun:test";
import {
  choosePreferredCodexCandidate,
  hasCodexSessionFileOpen,
  isResumeInvocation,
  matchSingleFreshStartedConversation,
  matchStartedConversation,
} from "./sessionProcessMatcher.js";

describe("isResumeInvocation", () => {
  test("matches codex resume subcommand", () => {
    const line = "ashot 123 0.0 0.0 ... /path/to/codex/codex resume 019c9626-6f6e-7fb1-b340-cdea1d861268";
    expect(isResumeInvocation("codex", line)).toBe(true);
  });

  test("matches codex --resume flag", () => {
    const line = "ashot 123 0.0 0.0 ... codex --resume 019c9626-6f6e-7fb1-b340-cdea1d861268";
    expect(isResumeInvocation("codex", line)).toBe(true);
  });

  test("does not match codex without resume", () => {
    const line = "ashot 123 0.0 0.0 ... /path/to/codex/codex -c shell_environment_policy.inherit=all";
    expect(isResumeInvocation("codex", line)).toBe(false);
  });

  test("matches claude --resume and not plain resume subcommand", () => {
    const withFlag = "ashot 123 0.0 0.0 ... claude --resume 5b1c47b3-16c0-42d5-a6d2-82459a01f640";
    const withSubcommand = "ashot 123 0.0 0.0 ... claude resume 5b1c47b3-16c0-42d5-a6d2-82459a01f640";
    expect(isResumeInvocation("claude", withFlag)).toBe(true);
    expect(isResumeInvocation("claude", withSubcommand)).toBe(false);
  });

  test("matches gemini --resume and resume subcommand", () => {
    const withFlag = "ashot 123 0.0 0.0 ... gemini --resume latest";
    const withSubcommand = "ashot 123 0.0 0.0 ... gemini resume session-abc";
    expect(isResumeInvocation("gemini", withFlag)).toBe(true);
    expect(isResumeInvocation("gemini", withSubcommand)).toBe(true);
  });

  test("detects codex session file from lsof output", () => {
    const lsofOutput = [
      "codex 83954 ashot 20w REG ... /Users/ashot/.codex/sessions/2026/02/25/rollout-2026-02-25T10-53-47-019c9626-6f6e-7fb1-b340-cdea1d861268.jsonl",
      "codex 83954 ashot 21u unix ...",
    ].join("\n");
    expect(hasCodexSessionFileOpen(lsofOutput, "019c9626-6f6e-7fb1-b340-cdea1d861268")).toBe(true);
    expect(hasCodexSessionFileOpen(lsofOutput, "00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  test("prefers non-tmux codex candidate when both tmux and iTerm are available", () => {
    const chosen = choosePreferredCodexCandidate([
      { pid: 19347, tty: "/dev/ttys034", tmuxTarget: "cx-resume-019c9633:0.0" },
      { pid: 18506, tty: "/dev/ttys033", tmuxTarget: null },
    ]);
    expect(chosen?.pid).toBe(18506);
    expect(chosen?.tmuxTarget).toBeNull();
  });

  test("falls back to first codex candidate when all are tmux-backed", () => {
    const chosen = choosePreferredCodexCandidate([
      { pid: 11111, tty: "/dev/ttys010", tmuxTarget: "cx-resume-a:0.0" },
      { pid: 22222, tty: "/dev/ttys011", tmuxTarget: "cx-resume-b:0.0" },
    ]);
    expect(chosen?.pid).toBe(11111);
  });
});

describe("matchStartedConversation", () => {
  test("matches by tmux session first", () => {
    const match = matchStartedConversation(
      [
        ["conv-old", { tmuxSession: "cc-codex-old", projectPath: "/tmp", startedAt: 1000 }],
        ["conv-new", { tmuxSession: "cc-codex-abc", projectPath: "/repo", startedAt: 2000 }],
      ],
      {
        tmuxSessionName: "cc-codex-abc",
        projectPath: "/tmp",
        now: 5000,
      }
    );
    expect(match).toBe("conv-new");
  });

  test("falls back to fresh project-path match when tmux is missing", () => {
    const match = matchStartedConversation(
      [
        ["conv-stale", { tmuxSession: "cc-codex-1", projectPath: "/repo", startedAt: 1000 }],
        ["conv-fresh", { tmuxSession: "cc-codex-2", projectPath: "/repo", startedAt: 4900 }],
      ],
      {
        projectPath: "/repo",
        now: 5000,
        ttlMs: 300,
      }
    );
    expect(match).toBe("conv-fresh");
  });

  test("returns null when only stale path matches exist", () => {
    const match = matchStartedConversation(
      [["conv-stale", { tmuxSession: "cc-codex-1", projectPath: "/repo", startedAt: 1000 }]],
      {
        projectPath: "/repo",
        now: 5000,
        ttlMs: 300,
      }
    );
    expect(match).toBeNull();
  });

  test("supports single-pass iterator inputs (Map.entries)", () => {
    const entries = new Map<string, { tmuxSession: string; projectPath: string; startedAt: number }>([
      ["conv-1", { tmuxSession: "cc-codex-1", projectPath: "/repo", startedAt: 4900 }],
    ]);

    const match = matchStartedConversation(entries.entries(), {
      tmuxSessionName: "cc-codex-missing",
      projectPath: "/repo",
      now: 5000,
      ttlMs: 300,
    });

    expect(match).toBe("conv-1");
  });
});

describe("matchSingleFreshStartedConversation", () => {
  test("returns only fresh single candidate", () => {
    const match = matchSingleFreshStartedConversation(
      [["conv-1", { startedAt: 9800 }]],
      { now: 10_000, freshnessMs: 500 }
    );
    expect(match).toBe("conv-1");
  });

  test("returns null for multiple fresh candidates", () => {
    const match = matchSingleFreshStartedConversation(
      [
        ["conv-1", { startedAt: 9800 }],
        ["conv-2", { startedAt: 9900 }],
      ],
      { now: 10_000, freshnessMs: 500 }
    );
    expect(match).toBeNull();
  });

  test("returns null when only stale candidates exist", () => {
    const match = matchSingleFreshStartedConversation(
      [["conv-1", { startedAt: 1000 }]],
      { now: 10_000, freshnessMs: 500 }
    );
    expect(match).toBeNull();
  });
});
