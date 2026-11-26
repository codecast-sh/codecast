import { describe, expect, test } from "bun:test";
import type { Exec } from "../lineMerge";
import { spoken, waitForMain } from "./waitMain";

/** git and gh as a repository on GitHub would answer, from a script: each look at main reads the next state. */
function fakeRepo(states: Array<{ head: string; runs: Array<{ id: number; name: string; status: string; conclusion: string | null }> }>, jobs: Record<number, Array<{ name: string; conclusion: string }>> = {}) {
  let look = -1;
  const exec: Exec = (cmd, args) => {
    if (cmd === "git" && args[0] === "ls-remote") {
      look = Math.min(look + 1, states.length - 1);
      return { status: 0, stdout: `${states[look].head}\trefs/heads/main\n`, stderr: "" };
    }
    if (cmd === "gh" && args[0] === "run" && args[1] === "list") {
      const s = states[look];
      return { status: 0, stdout: JSON.stringify([...s.runs.map((r) => ({ databaseId: r.id, workflowName: r.name, headSha: s.head, status: r.status, conclusion: r.conclusion })), { databaseId: 1, workflowName: "CI", headSha: "older", status: "completed", conclusion: "failure" }]), stderr: "" };
    }
    if (cmd === "gh" && args[0] === "run" && args[1] === "view") return { status: 0, stdout: JSON.stringify({ jobs: jobs[Number(args[2])] ?? [] }), stderr: "" };
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
  let t = 0;
  return { exec, now: () => t, sleep: async (ms: number) => { t += ms; } };
}

const RED = (head: string) => ({ head, runs: [{ id: 10, name: "CI", status: "completed", conclusion: "failure" }, { id: 11, name: "Deploy", status: "completed", conclusion: "success" }] });
const GREEN = (head: string) => ({ head, runs: [{ id: 20, name: "CI", status: "completed", conclusion: "success" }, { id: 21, name: "Lint", status: "completed", conclusion: "skipped" }] });
const RUNNING = (head: string) => ({ head, runs: [{ id: 30, name: "CI", status: "in_progress", conclusion: null }] });

describe("waitForMain", () => {
  test("waits through red and a running fix, saying how long against the deadline, and ends when main's head is green", async () => {
    const repo = fakeRepo([RED("aaaaaaaaaaaa"), RUNNING("bbbbbbbbbbbb"), GREEN("bbbbbbbbbbbb")]);
    const said: string[] = [];
    const r = await waitForMain({ cwd: ".", base: "main", deadlineMs: 4 * 3600_000, intervalMs: 60_000, ...repo, say: (l) => said.push(l) });
    expect(r).toEqual({ ok: true, line: "Main CI is green at bbbbbbbbbb." });
    expect(said).toEqual([
      "Waiting for main CI to go green (red since aaaaaaaaaa; 0s of 4h)",
      "Waiting for main CI to go green (red since aaaaaaaaaa; 1m of 4h)",
    ]);
  });

  test("a head with no CI run yet is not green", async () => {
    const repo = fakeRepo([{ head: "cccccccccccc", runs: [] }, GREEN("cccccccccccc")]);
    const said: string[] = [];
    expect((await waitForMain({ cwd: ".", base: "main", deadlineMs: 3600_000, intervalMs: 60_000, ...repo, say: (l) => said.push(l) })).ok).toBe(true);
    expect(said).toEqual(["Waiting for main CI to go green (running at cccccccccc; 0s of 1h)"]);
  });

  test("past the deadline it fails, naming main's red jobs", async () => {
    const repo = fakeRepo([RED("dddddddddddd")], { 10: [{ name: "test-cli", conclusion: "failure" }, { name: "test-web", conclusion: "success" }, { name: "typecheck", conclusion: "timed_out" }] });
    const r = await waitForMain({ cwd: ".", base: "main", deadlineMs: 4 * 3600_000, intervalMs: 600_000, ...repo });
    expect(r).toEqual({ ok: false, line: "Main CI stayed red for 4h (red since dddddddddd), at dddddddddd: CI: test-cli, CI: typecheck." });
  });

  // A newer CLI takes the wait over between polls (stationReexec.ts): it hands over where the wait began and the red head.
  test("between polls it hands its place to a newer CLI, and a wait resumed from one keeps its deadline", async () => {
    const handed: unknown[] = [];
    const repo = fakeRepo([RED("eeeeeeeeeeee"), GREEN("ffffffffffff")]);
    await waitForMain({ cwd: ".", base: "main", deadlineMs: 3600_000, intervalMs: 60_000, ...repo, cli: { resumed: () => null, between: async (p) => { handed.push(p); } } });
    expect(handed).toEqual([{ start: 0, redSince: "eeeeeeeeeeee" }]);
    const resumed = fakeRepo([RED("eeeeeeeeeeee")]);
    const r = await waitForMain({ cwd: ".", base: "main", deadlineMs: 3600_000, intervalMs: 600_000, ...resumed, cli: { resumed: <T,>() => ({ start: -3000_000, redSince: "dddddddddddd" }) as T, between: async () => {} } });
    // 50 of its 60 minutes were spent on the older CLI: one more 10-minute wait, and red since the head it saw there.
    expect(r.line).toBe("Main CI stayed red for 1h (red since dddddddddd), at eeeeeeeeee: CI.");
    expect(resumed.now()).toBe(600_000);
  });

  test("spoken durations", () => {
    expect([spoken(40_000), spoken(23 * 60_000), spoken(65 * 60_000), spoken(4 * 3600_000)]).toEqual(["40s", "23m", "1h 5m", "4h"]);
  });
});
