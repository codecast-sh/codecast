import { expect, test } from "bun:test";
import { assertResumePaneReplaceable, headlessAgentInPanes, panePresenceFromProcesses } from "./daemon";
import type { LivenessVerdict } from "@codecast/shared/contracts";

test("a failed or incomplete process snapshot cannot prove an agent exited", () => {
  expect(panePresenceFromProcesses([10], [])).toBe("unverifiable");
  expect(panePresenceFromProcesses([10], [{ pid: 11, ppid: 1, command: "bash" }])).toBe("unverifiable");
  expect(panePresenceFromProcesses([10], [
    { pid: 10, ppid: 1, command: "bash" },
    { pid: 10, ppid: 1, command: "bash" },
  ])).toBe("unverifiable");
});

test("one snapshot recognizes both agents and their starting runtime", () => {
  for (const command of ["/bin/claude --resume example", "/usr/bin/bun main.ts _disclaimed"]) {
    expect(panePresenceFromProcesses([10], [
      { pid: 10, ppid: 1, command: "bash" },
      { pid: 11, ppid: 10, command },
    ])).toBe("live");
  }
  expect(panePresenceFromProcesses([10], [{ pid: 10, ppid: 1, command: "bash" }])).toBe("exited");
});

test("resume refuses to replace live or unverifiable panes", async () => {
  for (const verdict of ["live", "unverifiable"] as LivenessVerdict[]) {
    await expect(assertResumePaneReplaceable("pane", {
      exec: async () => ({ stdout: "", stderr: "" }),
      presence: async () => verdict,
    })).rejects.toThrow("AGENT_STDIN_NOT_READY");
  }
  await assertResumePaneReplaceable("pane", {
    exec: async () => ({ stdout: "", stderr: "" }),
    presence: async () => "exited",
  });
});

test("missing panes can start but timed out tmux probes remain pending", async () => {
  const presence = async (): Promise<LivenessVerdict> => { throw new Error("must not inspect absent pane"); };
  await assertResumePaneReplaceable("pane", {
    exec: async () => { throw new Error("can't find session: pane"); }, presence,
  });
  await expect(assertResumePaneReplaceable("pane", {
    exec: async () => { throw new Error("tmux timed out"); }, presence,
  })).rejects.toThrow("AGENT_STDIN_NOT_READY");
});

// jx74025, 2026-11-12: a spawned trigger run is `bash task.sh` -> `claude -p`.
// It draws no composer, so delivery must hold rather than retry into it.
test("a pane running a headless agent run is named; interactive agents are not", () => {
  const pane = (command: string) => [
    { pid: 10, ppid: 1, command: "bash /tmp/codecast-task-8fjjes.sh" },
    { pid: 11, ppid: 10, command },
  ];
  expect(headlessAgentInPanes([10], pane("claude -p [Codecast Task: X] --dangerously-skip-permissions --session-id abc"))).toBe("claude -p");
  expect(headlessAgentInPanes([10], pane("node /usr/local/bin/claude --print hi"))).toBe("claude -p");
  expect(headlessAgentInPanes([10], pane("/opt/homebrew/bin/codex exec do it"))).toBe("codex exec");
  expect(headlessAgentInPanes([10], pane("claude --resume abc --dangerously-skip-permissions"))).toBeNull();
  expect(headlessAgentInPanes([10], pane("codex resume abc"))).toBeNull();
  expect(headlessAgentInPanes([10], [{ pid: 12, ppid: 1, command: "claude -p elsewhere" }])).toBeNull();
});
