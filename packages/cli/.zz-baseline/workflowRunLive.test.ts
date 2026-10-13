import { expect, test } from "bun:test";
import { parseWorkflowJournal, SNAPSHOT_RACE_MARGIN_MS, snapshotIsCurrent, WORKFLOW_HOST_QUIET_MS, workflowHostGone } from "./workflowRunLive.js";

const line = (o: object) => JSON.stringify(o);

test("a resumed agent replaces the attempt the stop cut off", () => {
  // Shape of wf_83ab08aa-905: build:W1-dead started, the run was stopped and
  // resumed, the same key started again under a new id and finished.
  const journal = [
    line({ type: "launched" }),
    line({ type: "started", key: "k-dead", agentId: "a1", label: "build:W1-dead", phase: "Build" }),
    line({ type: "started", key: "k-dups", agentId: "a2", label: "build:W1-dups", phase: "Build" }),
    line({ type: "result", key: "k-dups", agentId: "a2" }),
    line({ type: "started", key: "k-dead", agentId: "a3", label: "build:W1-dead", phase: "Build" }),
    line({ type: "result", key: "k-dead", agentId: "a3" }),
    line({ type: "started", key: "k-rev", agentId: "a4", label: "review:W1-dead", phase: "Build" }),
    "{\"type\":\"star", // a half-written tail
  ].join("\n");
  expect(parseWorkflowJournal(journal)).toEqual([
    { agent_id: "a2", label: "build:W1-dups", phase: "Build", state: "done" },
    { agent_id: "a3", label: "build:W1-dead", phase: "Build", state: "done" },
    { agent_id: "a4", label: "review:W1-dead", phase: "Build", state: "running" },
  ]);
});

test("a completion snapshot speaks for the run until the run writes again", () => {
  const snap = 1_000_000;
  expect(snapshotIsCurrent(undefined, snap)).toBe(false);
  expect(snapshotIsCurrent(snap, snap - 60_000)).toBe(true);
  // The final flush that races the snapshot write.
  expect(snapshotIsCurrent(snap, snap + SNAPSHOT_RACE_MARGIN_MS)).toBe(true);
  // Resumed under the same run id after a stop.
  expect(snapshotIsCurrent(snap, snap + 10 * 60_000)).toBe(false);
});

test("a workflow's host is gone only on positive evidence", () => {
  const now = 10_000_000_000;
  const quiet = now - WORKFLOW_HOST_QUIET_MS - 1;
  const startedAt = (ms: number) => new Date(ms).toString();
  const procs = [{ pid: 42, startedAt: startedAt(quiet - 3_600_000) }];

  // The host still runs: alive however long the run has been quiet.
  expect(workflowHostGone({ now, lastActivityMs: quiet, hostPid: 42, procs })).toBe(false);
  // The host process exited.
  expect(workflowHostGone({ now, lastActivityMs: quiet, hostPid: 43, procs })).toBe(true);
  // The session restarted: its pid belongs to a process born after the run went quiet.
  expect(workflowHostGone({ now, lastActivityMs: quiet, hostPid: 42, procs: [{ pid: 42, startedAt: startedAt(quiet + 60_000) }] })).toBe(true);
  // Recent activity is never condemned (a just-launched host may not be in the snapshot yet).
  expect(workflowHostGone({ now, lastActivityMs: now - 1_000, hostPid: 43, procs })).toBe(false);
  // Unknown pid or no process table: not gone.
  expect(workflowHostGone({ now, lastActivityMs: quiet, hostPid: undefined, procs })).toBe(false);
  expect(workflowHostGone({ now, lastActivityMs: quiet, hostPid: 43, procs: undefined })).toBe(false);
  expect(workflowHostGone({ now, lastActivityMs: quiet, hostPid: 43, procs: [] })).toBe(false);
});
