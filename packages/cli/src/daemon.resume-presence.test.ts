import { expect, test } from "bun:test";
import { assertResumePaneReplaceable, panePresenceFromProcesses } from "./daemon";
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
