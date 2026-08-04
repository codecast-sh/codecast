import { describe, expect, test } from "bun:test";
import {
  choosePreferredCodexCandidate,
  collectAncestorPids,
  hasCodexSessionFileOpen,
  isRecognizedAgentComm,
  isResumeInvocation,
  matchSingleFreshStartedConversation,
  matchStartedConversation,
  parseLsofPidPaths,
  parsePidPpidMap,
  planSessionTeardown,
  resolveSpawnerSessionId,
  classifyProcessOwnership,
  shortId,
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

  test("an lsof match alone does NOT mean the process is the session's own", () => {
    // The parent TUI appends its subagent's rollout, so it holds BOTH files open.
    // hasCodexSessionFileOpen says yes to both ids for the same pid — which is why
    // ownership needs a second question rather than a stricter fd rule (a parent
    // with live subagents legitimately holds several rollouts open).
    const lsofOutput = [
      "codex 55521 jason 20w REG ... /Users/jason/.codex/sessions/2026/08/02/rollout-2026-08-02T09-15-01-019fb73a-a85c-7d31-b0a2-3f9c5e2d8a41.jsonl",
      "codex 55521 jason 21w REG ... /Users/jason/.codex/sessions/2026/08/02/rollout-2026-08-02T09-15-01-019fb73a-a740-7c02-9e11-6b4d0a7f3c88.jsonl",
    ].join("\n");
    expect(hasCodexSessionFileOpen(lsofOutput, "019fb73a-a85c-7d31-b0a2-3f9c5e2d8a41")).toBe(true);
    expect(hasCodexSessionFileOpen(lsofOutput, "019fb73a-a740-7c02-9e11-6b4d0a7f3c88")).toBe(true);
  });
});

describe("classifyProcessOwnership", () => {
  const PARENT = "019fc25f-ea9d-7f22-b8ae-8d232737fc7b";

  test("an in-process subagent THREAD borrows its parent's process", () => {
    // source.subagent is an OBJECT carrying thread_spawn — the only shape that
    // actually runs inside the parent TUI's process.
    expect(classifyProcessOwnership({
      parentThreadId: PARENT,
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } },
    })).toBe("borrowed");
  });

  test("thread_spawn alone is enough — the top-level parent id is redundant", () => {
    // thread_spawn.parent_thread_id carries the same value in all 31 real
    // rollouts, so requiring BOTH created a fail-open direction: drop the
    // top-level field and a genuine borrower read as "owned".
    expect(classifyProcessOwnership({
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT } } },
    })).toBe("borrowed");
  });

  test("a `codex exec` review child OWNS its process, despite carrying a parent", () => {
    // The over-fire that `parent_thread_id` alone would cause. A census of 214
    // local rollouts found 28 of these against 31 thread_spawn — nearly half of
    // all parent-carrying sessions. They are separate OS processes (originator
    // codex_exec, spawned via another session's Bash tool), so calling them
    // borrowers would leave a review running after the user killed its card.
    expect(classifyProcessOwnership({
      parentThreadId: PARENT,
      originator: "codex_exec",
      source: { subagent: "review" },
    })).toBe("owned");
  });

  test("a root session owns its own process", () => {
    // 019fc268 is a distinct root (originator codex_cli_rs, no parent) that the
    // daemon still matched to another root's pid. Root-to-root collisions are a
    // separate defect; this classifier must not paper over them.
    expect(classifyProcessOwnership({ originator: "codex_cli_rs", source: "cli" })).toBe("owned");
    expect(classifyProcessOwnership({ source: "exec" })).toBe("owned");
    expect(classifyProcessOwnership({})).toBe("owned");
    expect(classifyProcessOwnership(undefined)).toBe("owned");
  });

  test("a parent with an UNRECOGNIZED shape is unknown, never owned", () => {
    // Fails CLOSED. Every unrecognized shape that resolved to "owned" re-opened
    // the SIGKILL hole; "unknown" costs only a card that retires without reaping,
    // since planSessionTeardown treats unknown and borrowed identically.
    expect(classifyProcessOwnership({ parentThreadId: PARENT })).toBe("unknown");
    expect(classifyProcessOwnership({ parentThreadId: PARENT, source: { custom: "x" } })).toBe("unknown");
    // A renamed/unseen nesting under subagent — e.g. a future Codex spawn kind.
    expect(classifyProcessOwnership({
      parentThreadId: PARENT,
      source: { subagent: { process_spawn: { parent_thread_id: PARENT } } },
    })).toBe("unknown");
  });
});

describe("planSessionTeardown", () => {
  // The seam. Both destructive sites do TWO process-destroying things — reap the
  // resolved pid tree, and kill the tmux recorded in resumeSessionCache. An
  // earlier revision guarded only the reap, leaving the cached-tmux kill as a live
  // bypass: that cache is keyed by session id but its VALUE can be the PARENT's
  // tmux, since resolveLiveTmuxTarget fills it through the borrowed pid.

  test("a borrower may destroy nothing", () => {
    expect(planSessionTeardown("borrowed")).toEqual({ reapPidTree: false, killCachedResumeTmux: false });
  });

  test("unknown ownership fails CLOSED", () => {
    // An unreadable or half-written rollout must never authorize a SIGKILL.
    expect(planSessionTeardown("unknown")).toEqual({ reapPidTree: false, killCachedResumeTmux: false });
  });

  test("an owner may destroy both", () => {
    expect(planSessionTeardown("owned")).toEqual({ reapPidTree: true, killCachedResumeTmux: true });
  });
});

describe("shortId", () => {
  test("distinguishes a Codex parent from a subagent spawned in the same millisecond", () => {
    // UUIDv7: the first 48 bits are a ms timestamp, so a parent and the subagents
    // it spawns collide on 8 chars BY CONSTRUCTION. These two are 150ms apart.
    const parent = "019fb73a-a740-7c02-9e11-6b4d0a7f3c88";
    const subagent = "019fb73a-a85c-7d31-b0a2-3f9c5e2d8a41";
    expect(parent.slice(0, 8)).toBe(subagent.slice(0, 8)); // the old prefix: identical
    expect(shortId(parent)).not.toBe(shortId(subagent));
    expect(shortId(parent)).toBe("019fb73a-a740");
  });

  test("leaves ids shorter than the cutoff intact", () => {
    expect(shortId("abc")).toBe("abc");
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

  test("parseLsofPidPaths groups each process's open files under its pid", () => {
    // Real `lsof -p 46028 -F pn` shape: a p-line opens the block, n-lines follow.
    const out = [
      "p46028",
      "n/Users/j/.codex/sessions/2026/08/01/rollout-2026-08-01T23-03-27-019fbf23-9395-7c32-9946-f420e4f967b4.jsonl",
      "n/dev/null",
      "p45992",
      "n/Users/j/.claude/projects/-Users-j-code/abc.jsonl",
      "",
    ].join("\n");
    expect(parseLsofPidPaths(out)).toEqual(
      new Map([
        [46028, [
          "/Users/j/.codex/sessions/2026/08/01/rollout-2026-08-01T23-03-27-019fbf23-9395-7c32-9946-f420e4f967b4.jsonl",
          "/dev/null",
        ]],
        [45992, ["/Users/j/.claude/projects/-Users-j-code/abc.jsonl"]],
      ]),
    );
  });

  test("parseLsofPidPaths ignores n-lines with no open process block and unparseable pids", () => {
    const out = ["n/orphan/path", "pnotapid", "n/also/orphan", "p77junk", "n/still-orphan", "p77", "n/kept"].join("\n");
    expect(parseLsofPidPaths(out)).toEqual(new Map([[77, ["/kept"]]]));
  });
});
