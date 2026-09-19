import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DORMANT_CLAIM_TTL_MS, OPEN_TASKS_FRESH_MS, placeProjectableRow, type ProjectableInboxRow } from "@codecast/shared/contracts";
import { acquireSessionProcessOwnership, findSessionFile, openTasksRefreshDue, paneReconcileTarget, primeSessionFileIndexAtBoot, reconciledStatusWithTasks, resetSessionFileIndexForTests, resolveTurnEndStatus } from "./daemon.js";
import { closeDaemonWorkers, configureDaemonWorkers } from "./workers/bridge.js";
import { writeThreadStatePulse } from "./threadStateStamp.js";

const START = 1_800_000_000_000;
const task = { id: "bjmsej5ia", kind: "background" as const };
const dormant = (openTasksAt: number): ProjectableInboxRow => ({
  _id: "dormant-background-wait",
  updated_at: START,
  message_count: 275,
  agent_status: "dormant",
  thread_state_status: "dormant",
  is_idle: true,
  open_tasks: [task],
  open_tasks_at: openTasksAt,
});

describe("dormant background task refresh", () => {
  test("boot restores discovered dormant transcripts while the remaining scan is pending", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dormant-slow-scan-"));
    const priorHome = process.env.HOME;
    const priorConfig = process.env.CODECAST_DIR;
    const id = "dddddddd-0000-4000-8000-000000000089";
    const project = path.join(home, ".claude", "projects", "project");
    const file = path.join(project, `${id}.jsonl`);
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const original = fs.promises.readdir;
    const read = spyOn(fs.promises, "readdir").mockImplementation((async (dir: unknown, ...args: unknown[]) => {
      if (String(dir) === path.join(home, ".codex", "sessions")) { reached(); await held; }
      return (original as any)(dir, ...args);
    }) as any);
    let warm: Promise<void> | undefined;
    try {
      process.env.HOME = home;
      process.env.CODECAST_DIR = path.join(home, ".codecast");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ type: "user", sessionId: id, timestamp: new Date(Date.now() - 60_000).toISOString(), message: { role: "user", content: "Wait for the machine" } }) + "\n");
      writeThreadStatePulse(id, "dormant");
      resetSessionFileIndexForTests();
      warm = primeSessionFileIndexAtBoot();
      await entered;
      expect(findSessionFile(id, { staleOk: true })?.path).toBe(file);
      expect(resolveTurnEndStatus(id)).toBe("dormant");
    } finally {
      release();
      await warm;
      read.mockRestore();
      process.env.HOME = priorHome;
      if (priorConfig === undefined) delete process.env.CODECAST_DIR;
      else process.env.CODECAST_DIR = priorConfig;
      resetSessionFileIndexForTests();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("boot rediscovers a dormant wait despite unrelated transcript symlinks", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dormant-restart-"));
    const priorHome = process.env.HOME;
    const priorConfig = process.env.CODECAST_DIR;
    const id = "dddddddd-0000-4000-8000-000000000088";
    const project = path.join(home, ".claude", "projects", "project");
    const file = path.join(project, `${id}.jsonl`);
    try {
      process.env.HOME = home;
      process.env.CODECAST_DIR = path.join(home, ".codecast");
      fs.mkdirSync(project, { recursive: true });
      fs.writeFileSync(file, [
        { type: "user", sessionId: id, timestamp: new Date(Date.now() - 60_000).toISOString(), message: { role: "user", content: "Wait for the machine" } },
        { type: "user", sessionId: id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "wait", content: "Command running in background with ID: live-wait. Output is being written to: /tmp/live-wait.output" }] } },
        { type: "assistant", sessionId: id, message: { role: "assistant", content: "The background job wakes me." } },
      ].map(row => JSON.stringify(row)).join("\n") + "\n");
      fs.symlinkSync("missing.jsonl", path.join(project, "unrelated.jsonl"));
      writeThreadStatePulse(id, "dormant");
      resetSessionFileIndexForTests();
      await configureDaemonWorkers(true, {}, { invocation: { command: process.execPath, args: [path.resolve(import.meta.dir, "main.ts"), "_worker", "scan"] } });
      await primeSessionFileIndexAtBoot();
      expect(findSessionFile(id, { staleOk: true })?.path).toBe(file);
      expect(resolveTurnEndStatus(id)).toBe("dormant");

      const codex = path.join(home, ".codex", "sessions");
      fs.mkdirSync(codex, { recursive: true });
      fs.symlinkSync(file, path.join(codex, `rollout-${id}.jsonl`));
      expect(await acquireSessionProcessOwnership(id)).toBe("unknown");
    } finally {
      closeDaemonWorkers();
      process.env.HOME = priorHome;
      if (priorConfig === undefined) delete process.env.CODECAST_DIR;
      else process.env.CODECAST_DIR = priorConfig;
      resetSessionFileIndexForTests();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("a verified background wait stays dormant beyond the two-hour claim expiry", () => {
    const row = dormant(START);
    const end = START + DORMANT_CLAIM_TTL_MS + OPEN_TASKS_FRESH_MS;
    let refreshes = 0;
    for (let now = START; now <= end; now += 90_000) {
      expect(paneReconcileTarget("idle", "dormant")).toBe("idle");
      expect(reconciledStatusWithTasks("dormant", "idle", true, "dormant")).toBeNull();
      if (openTasksRefreshDue("dormant", 1, row.open_tasks_at!, now)) {
        row.open_tasks_at = now;
        refreshes++;
      }
      expect(placeProjectableRow(row, false, now)).toEqual({ bucket: "dormant", work_state: "dormant" });
    }
    expect(refreshes).toBeGreaterThan(1);
    expect(placeProjectableRow(dormant(START), false, end).work_state).toBe("needs_input");
  });

  test("completed work and lost daemon reports still expire", () => {
    const now = START + DORMANT_CLAIM_TTL_MS;
    expect(openTasksRefreshDue("dormant", 0, START, now)).toBe(false);
    expect(placeProjectableRow({ ...dormant(now), open_tasks: [] }, false, now).work_state).toBe("needs_input");
    expect(placeProjectableRow(dormant(now - OPEN_TASKS_FRESH_MS), false, now).work_state).toBe("needs_input");
  });

  test("refreshes are throttled and do not publish active or completed verdicts", () => {
    for (const status of ["dormant", "waiting"] as const) {
      expect(openTasksRefreshDue(status, 1, START, START + 90_000)).toBe(false);
      expect(openTasksRefreshDue(status, 1, START, START + 4 * 60_000)).toBe(true);
      expect(openTasksRefreshDue(status, 1, undefined, START)).toBe(true);
    }
    for (const status of ["working", "thinking", "done", "idle", "permission_blocked"] as const) {
      expect(openTasksRefreshDue(status, 1, START, START + OPEN_TASKS_FRESH_MS)).toBe(false);
    }
  });

  test("fresh wait evidence cannot conceal a question, error, or wake", () => {
    const now = START + DORMANT_CLAIM_TTL_MS;
    for (const block of [{ awaiting_input: true }, { pending_api_error: true }, { agent_status: "permission_blocked" }, { thread_state_status: "blocked", agent_status: "idle" }]) {
      expect(placeProjectableRow({ ...dormant(now), ...block }, true, now).work_state).toBe("needs_input");
    }
    expect(paneReconcileTarget("busy", "dormant")).toBe("working");
    expect(reconciledStatusWithTasks("dormant", "active", true)).toBe("working");
  });
});
