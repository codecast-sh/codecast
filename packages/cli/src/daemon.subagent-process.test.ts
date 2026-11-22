import { describe, expect, test } from "bun:test";
import { cwdMatchCandidates, isDaemonGuessForSubagent, isSubagentTranscriptPath } from "./daemon.js";

// A Claude subagent runs inside its parent's process, in the parent's cwd.
// Strategy C (cwd match) found exactly one unclaimed claude there, the parent,
// and the daemon registered that pid and tmux pane as the subagent's own
// (observed 2026-11-22: agent-aplacement-2 registered with its lead's pid 51356),
// so killing the subagent's card reaped the parent's pane.

const projects = "/Users/x/.claude/projects/-Users-x-code-app";
const PARENT = "60f7f0f9-b929-4a3f-a150-7c419b517518";
const parentTranscript = `${projects}/${PARENT}.jsonl`;
const subagentTranscript = `${projects}/${PARENT}/subagents/agent-a92bb00c0ffee.jsonl`;
const projectCwd = "/Users/x/code/app";

// `ps aux` lines: the parent claude in the project, an unrelated claude elsewhere, a daemon without a tty.
const PARENT_PID = 51356;
const psLines = [
  `x  ${PARENT_PID}  12.0  1.0 1 1 ttys004 S+ 9:00PM 0:10.00 claude --resume ${PARENT}`,
  `x  60001  3.0  1.0 1 1 ttys009 S+ 9:00PM 0:01.00 claude`,
  `x  60002  0.1  0.1 1 1 ?? Ss 9:00PM 0:00.10 claude-code-daemon`,
];
const cwdTable = new Map<number, string | null>([[PARENT_PID, projectCwd], [60001, "/Users/x/code/other"], [60002, projectCwd]]);

function fakeProcessTable() {
  const calls = { ps: 0, cwds: 0 };
  return {
    calls,
    read: {
      psLines: async () => { calls.ps++; return psLines; },
      cwds: async (pids: number[]) => { calls.cwds++; return new Map(pids.map((p) => [p, cwdTable.get(p) ?? null])); },
      claimedElsewhere: () => false,
    },
  };
}

describe("isSubagentTranscriptPath", () => {
  test("a Task subagent's or workflow agent's transcript has no process of its own", () => {
    expect(isSubagentTranscriptPath(subagentTranscript)).toBe(true);
    expect(isSubagentTranscriptPath(`${projects}/${PARENT}/subagents/workflows/run-1/agent-a1.jsonl`)).toBe(true);
  });

  test("a top-level session owns its process; no transcript proves nothing", () => {
    expect(isSubagentTranscriptPath(parentTranscript)).toBe(false);
    expect(isSubagentTranscriptPath(null)).toBe(false);
    expect(isSubagentTranscriptPath(undefined)).toBe(false);
  });
});

describe("Strategy C: the cwd match", () => {
  test("a subagent gets no candidate, though its parent is the one claude in its cwd, and nothing is spawned", async () => {
    const { calls, read } = fakeProcessTable();
    const { candidates, unclaimed } = await cwdMatchCandidates(subagentTranscript, projectCwd, read);
    expect(candidates).toEqual([]);
    expect(unclaimed).toEqual([]);
    expect(calls).toEqual({ ps: 0, cwds: 0 });
  });

  test("the parent itself still finds its own process from the same table", async () => {
    const { calls, read } = fakeProcessTable();
    const { unclaimed } = await cwdMatchCandidates(parentTranscript, projectCwd, read);
    expect(unclaimed.map((c) => c.pid)).toEqual([PARENT_PID]);
    expect(calls).toEqual({ ps: 1, cwds: 1 });
  });

  test("a process another session already holds is a candidate but not unclaimed", async () => {
    const { read } = fakeProcessTable();
    const { candidates, unclaimed } = await cwdMatchCandidates(parentTranscript, projectCwd, { ...read, claimedElsewhere: (pid) => pid === PARENT_PID });
    expect(candidates.map((c) => c.pid)).toEqual([PARENT_PID]);
    expect(unclaimed).toEqual([]);
  });
});

describe("Strategy 0: a registry file", () => {
  test("one the daemon wrote for a subagent is its guess at the parent, and is dropped", () => {
    expect(isDaemonGuessForSubagent({ pid: PARENT_PID, tty: "/dev/ttys004", src: "daemon" }, subagentTranscript)).toBe(true);
  });

  test("one the SessionStart hook wrote, or one for a top-level session, is kept", () => {
    expect(isDaemonGuessForSubagent({ pid: PARENT_PID, tty: "/dev/ttys004", term: "tmux", ts: 1 }, subagentTranscript)).toBe(false);
    expect(isDaemonGuessForSubagent({ pid: PARENT_PID, tty: "/dev/ttys004", src: "daemon" }, parentTranscript)).toBe(false);
  });
});
