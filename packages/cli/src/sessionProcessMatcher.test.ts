import { describe, expect, test } from "bun:test";
import {
  choosePreferredCodexCandidate,
  collectAncestorPids,
  hasCodexSessionFileOpen,
  isRecognizedAgentComm,
  isResumeInvocation,
  matchSingleFreshStartedConversation,
  matchStartedConversation,
  parsePidPpidMap,
  resolveSpawnerSessionId,
} from "./sessionProcessMatcher.js";

describe("isRecognizedAgentComm", () => {
  // Fixtures are the exact `ps -o comm=` values observed from real tmux sessions
  // on 2026-07-17 (opencode 1.18.3, pi @mariozechner/pi-coding-agent, codex, claude).

  test("recognizes opencode (compiled binary, comm 'opencode')", () => {
    // opencode is a Mach-O binary; comm is its own name, matched via the registry
    // binary. The old allowlist (claude/codex/gemini/node/bun/deno) missed it —
    // "opencode" contains "code" but not "node"/"codex".
    expect(isRecognizedAgentComm("opencode")).toBe(true);
  });

  test("recognizes pi (node script that sets process.title='pi', comm 'pi')", () => {
    // pi's dist/cli.js runs `process.title = "pi"` as its first line, so comm is
    // "pi", NOT "node" — the old allowlist missed it.
    expect(isRecognizedAgentComm("pi")).toBe(true);
  });

  test("still recognizes codex via its node interpreter (comm 'node')", () => {
    // codex is a node script that does NOT rename itself: comm 'node',
    // args 'node /Users/ashot/.bun/bin/codex'.
    expect(isRecognizedAgentComm("node")).toBe(true);
    expect(isRecognizedAgentComm("/opt/homebrew/bin/node")).toBe(true);
  });

  test("still recognizes claude (bun-compiled binary, comm 'claude')", () => {
    expect(isRecognizedAgentComm("claude")).toBe(true);
    expect(isRecognizedAgentComm("/Users/ashot/.local/bin/claude")).toBe(true);
  });

  test("recognizes bun and deno interpreters", () => {
    expect(isRecognizedAgentComm("bun")).toBe(true);
    expect(isRecognizedAgentComm("deno")).toBe(true);
  });

  test("rejects unrelated processes, incl. names that merely contain 'pi'", () => {
    // Basename-exact for binary names keeps the short "pi" id from substring-hitting
    // unrelated tools.
    for (const comm of ["", "bash", "pip", "pipenv", "python3", "vim", "/usr/bin/ssh"]) {
      expect(isRecognizedAgentComm(comm)).toBe(false);
    }
  });
});

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

  test("returns null when multiple entries match same projectPath within TTL", () => {
    const match = matchStartedConversation(
      [
        ["conv-1", { tmuxSession: "cc-claude-aaa", projectPath: "/repo", startedAt: 4800 }],
        ["conv-2", { tmuxSession: "cc-claude-bbb", projectPath: "/repo", startedAt: 4900 }],
      ],
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

    // No tmuxSessionName → cwd fallback path, which must still consume an
    // iterator (not just an array) without throwing.
    const match = matchStartedConversation(entries.entries(), {
      projectPath: "/repo",
      now: 5000,
      ttlMs: 300,
    });

    expect(match).toBe("conv-1");
  });

  test("does NOT cwd-hijack when the candidate lives in an unrelated tmux", () => {
    // Regression: session ec7a32bf ran in tmux cc-claude-4atddd87bmnx (owned by
    // another conversation). The only conversation waiting in this cwd was
    // jx7cz32, so the old projectPath fallback stole the session for it.
    const match = matchStartedConversation(
      [["jx7cz32", { tmuxSession: "cc-claude-a3438587a2bs", projectPath: "/repo", startedAt: 4900 }]],
      {
        tmuxSessionName: "cc-claude-4atddd87bmnx",
        projectPath: "/repo",
        now: 5000,
        ttlMs: 300,
      }
    );
    expect(match).toBeNull();
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

describe("spawn-parent resolution", () => {
  test("parsePidPpidMap parses ps -axo pid=,ppid= output with irregular whitespace", () => {
    const psOut = "    1     0\n  500     1\n 8123   500\n98765  8123\n\nbad line\n";
    const map = parsePidPpidMap(psOut);
    expect(map.get(98765)).toBe(8123);
    expect(map.get(8123)).toBe(500);
    expect(map.get(500)).toBe(1);
    expect(map.has(NaN)).toBe(false);
  });

  test("collectAncestorPids walks nearest-first and stops at pid 1", () => {
    // codex(98765) <- bash(8123) <- claude(500) <- zsh(400) <- launchd(1)
    const map = new Map([[98765, 8123], [8123, 500], [500, 400], [400, 1], [1, 0]]);
    expect(collectAncestorPids(map, 98765)).toEqual([8123, 500, 400]);
  });

  test("collectAncestorPids is cycle-safe and depth-capped", () => {
    const cyclic = new Map([[10, 20], [20, 30], [30, 10]]);
    expect(collectAncestorPids(cyclic, 10)).toEqual([20, 30]);

    const deep = new Map<number, number>();
    for (let pid = 100; pid < 200; pid++) deep.set(pid, pid + 1);
    expect(collectAncestorPids(deep, 100, 5)).toHaveLength(5);
  });

  test("resolveSpawnerSessionId returns the nearest registered ancestor", () => {
    const registry = new Map([
      [500, "parent-session"],
      [400, "grandparent-session"],
    ]);
    const sid = resolveSpawnerSessionId(
      [8123, 500, 400],
      (pid) => registry.get(pid) ?? null,
      "child-session",
    );
    expect(sid).toBe("parent-session");
  });

  test("resolveSpawnerSessionId skips an ancestor registered with the child's own session id", () => {
    // A claude child registers its own pid; if the walk ever includes it
    // (or a wrapper re-registered the same session), it must not self-link.
    const registry = new Map([
      [8123, "child-session"],
      [500, "parent-session"],
    ]);
    const sid = resolveSpawnerSessionId(
      [8123, 500],
      (pid) => registry.get(pid) ?? null,
      "child-session",
    );
    expect(sid).toBe("parent-session");
  });

  test("resolveSpawnerSessionId returns null when no ancestor is registered", () => {
    const sid = resolveSpawnerSessionId([8123, 500, 400], () => null, "child-session");
    expect(sid).toBeNull();
  });
});
