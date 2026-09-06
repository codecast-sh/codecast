import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TaskScheduler, buildRunLaunch } from "./taskScheduler.js";
import { deviceId } from "./remote/device.js";
import { runTriggerPrecheck } from "./precheckRunner.js";
import { triggerPrecheckPassed } from "@codecast/shared/contracts";

/**
 * Device-affinity regression tests (ct-36854): a daemon must never claim a
 * scheduled task it cannot serve. The original bug ran an apply-mode task in
 * the remote Mac's $HOME because the spawn path silently fell back when the
 * task's project_path didn't exist on the claiming machine.
 */

let dir: string;
let savedRemoteEnv: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasksched-"));
  savedRemoteEnv = process.env.CODECAST_REMOTE_DEVICE;
  delete process.env.CODECAST_REMOTE_DEVICE;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedRemoteEnv === undefined) delete process.env.CODECAST_REMOTE_DEVICE;
  else process.env.CODECAST_REMOTE_DEVICE = savedRemoteEnv;
});

interface MockCalls {
  claimed: string[];
  failed: Array<{ taskId: string; error: string }>;
  injected: string[];
  completed: string[];
  /** The exact prompt each injection carried. */
  prompts: string[];
  /** Firings the precheck gate refused, with what it reported. */
  skipped: Array<{
    taskId: string;
    reason: string;
    command: string;
    exitCode?: number;
    timedOut: boolean;
    source: string;
  }>;
}

function makeScheduler(
  dueTasks: any[],
  opts: { claimResult?: (task: any) => any; filing?: "stashed" | "killed" | null } = {},
) {
  const calls: MockCalls = { claimed: [], failed: [], injected: [], completed: [], prompts: [], skipped: [] };
  const byId = new Map(dueTasks.map((t) => [t._id, t]));
  const syncService = {
    getDueTasks: async () => dueTasks,
    claimTask: async (taskId: string) => {
      calls.claimed.push(taskId);
      const task = byId.get(taskId);
      // Default: halt executeTask right after the claim attempt so tests never
      // reach the tmux spawn. Tests of post-claim behavior override this.
      return opts.claimResult ? opts.claimResult(task) : null;
    },
    failTaskRun: async (taskId: string, _daemonId: string, error: string) => {
      calls.failed.push({ taskId, error });
    },
    sendMessageToSession: async (conversationId: string, prompt: string) => {
      calls.injected.push(conversationId);
      calls.prompts.push(prompt);
    },
    completeTaskRun: async (taskId: string) => {
      calls.completed.push(taskId);
    },
    renewTaskLease: async () => true,
    // The injection path reads the session's inbox filing to decide whether to
    // append the stashed preamble. The real one fails open (null on any error);
    // the fake must exist at all, or the read throws and the whole injection is
    // reported as a failed run.
    getSessionFiling: async () => opts.filing ?? null,
    skipTaskRun: async (taskId: string, _daemonId: string, result: any, reason: string, source: string) => {
      calls.skipped.push({
        taskId,
        reason,
        command: result.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        source,
      });
      return true;
    },
  };
  const scheduler = new TaskScheduler({
    syncService: syncService as any,
    config: {},
    log: () => {},
  });
  return { scheduler: scheduler as any, calls };
}

const spawnTask = (id: string, projectPath?: string) => ({
  _id: id,
  title: `task ${id}`,
  prompt: "do the thing",
  project_path: projectPath,
});

describe("TaskScheduler device affinity", () => {
  it("does not claim a spawn task whose project_path is missing locally", async () => {
    const { scheduler, calls } = makeScheduler([spawnTask("t1", path.join(dir, "nope"))]);
    await scheduler.poll();
    expect(calls.claimed).toEqual([]);
    expect(calls.failed).toEqual([]);
  });

  it("claims a spawn task whose project_path exists locally", async () => {
    const { scheduler, calls } = makeScheduler([spawnTask("t1", dir)]);
    await scheduler.poll();
    expect(calls.claimed).toEqual(["t1"]);
  });

  it("an ineligible task does not shadow an eligible one behind it", async () => {
    const { scheduler, calls } = makeScheduler([
      spawnTask("wrong-machine", path.join(dir, "nope")),
      spawnTask("here", dir),
    ]);
    await scheduler.poll();
    expect(calls.claimed).toEqual(["here"]);
  });

  it("claims a path-less task on a local device but not on a remote one", async () => {
    const local = makeScheduler([spawnTask("t1")]);
    await local.scheduler.poll();
    expect(local.calls.claimed).toEqual(["t1"]);

    process.env.CODECAST_REMOTE_DEVICE = "1";
    const remote = makeScheduler([spawnTask("t1")]);
    await remote.scheduler.poll();
    expect(remote.calls.claimed).toEqual([]);
  });

  it("claims injection tasks regardless of project_path (server routes delivery)", async () => {
    const task = { ...spawnTask("t1", path.join(dir, "nope")), originating_conversation_id: "conv123" };
    const { scheduler, calls } = makeScheduler([task], { claimResult: (t) => t });
    await scheduler.poll();
    expect(calls.claimed).toEqual(["t1"]);
    expect(calls.injected).toEqual(["conv123"]);
    // Nothing about the inbox filing when the session is plainly visible.
    expect(calls.prompts[0]).not.toContain("STASHED");
    expect(calls.completed).toEqual(["t1"]);
  });

  it("claims a task created on this device", async () => {
    const task = { ...spawnTask("t1", dir), created_device_id: deviceId() };
    const { scheduler, calls } = makeScheduler([task]);
    await scheduler.poll();
    expect(calls.claimed).toEqual(["t1"]);
  });

  it("never claims a task created on another device, even with the checkout present", async () => {
    const task = { ...spawnTask("t1", dir), created_device_id: "some-other-device" };
    const { scheduler, calls } = makeScheduler([task]);
    await scheduler.poll();
    expect(calls.claimed).toEqual([]);
  });

  it("device binding outranks the injection exemption", async () => {
    const task = {
      ...spawnTask("t1", dir),
      created_device_id: "some-other-device",
      originating_conversation_id: "conv123",
    };
    const { scheduler, calls } = makeScheduler([task]);
    await scheduler.poll();
    expect(calls.claimed).toEqual([]);
    expect(calls.injected).toEqual([]);
  });

  it("fails loudly (no $HOME fallback) when the checkout vanishes after the claim", async () => {
    const task = spawnTask("t1", path.join(dir, "vanished"));
    const { scheduler, calls } = makeScheduler([task], { claimResult: (t) => t });
    await scheduler.executeTask(task);
    expect(calls.failed.length).toBe(1);
    expect(calls.failed[0].taskId).toBe("t1");
    expect(calls.failed[0].error).toContain("not found on this device");
  });
});

describe("wake-time self-knowledge", () => {
  const injectTask = () => ({
    ...spawnTask("t1"),
    originating_conversation_id: "conv123",
  });

  it("tells a stashed session nobody is watching", async () => {
    const { scheduler, calls } = makeScheduler([injectTask()], {
      claimResult: (t) => t,
      filing: "stashed",
    });
    await scheduler.poll();
    expect(calls.prompts[0]).toContain("This session is STASHED");
    expect(calls.failed).toEqual([]);
  });

  it("says nothing when the filing cannot be read", async () => {
    const { scheduler, calls } = makeScheduler([injectTask()], {
      claimResult: (t) => t,
      filing: null,
    });
    await scheduler.poll();
    expect(calls.injected).toEqual(["conv123"]);
    expect(calls.prompts[0]).not.toContain("STASHED");
  });
});

describe("spawned run launch flags", () => {
  it("pins the trigger's model after the configured flags, so it wins", () => {
    const { agentBin, extraAgentArgs } = buildRunLaunch(
      { ...spawnTask("t1"), mode: "apply", model: "opus" },
      { agent_args: { claude: "--model fable" } } as any,
    );
    expect(agentBin).toBe("claude");
    const last = extraAgentArgs.lastIndexOf("--model");
    expect(extraAgentArgs[last + 1]).toBe("opus");
    expect(extraAgentArgs.indexOf("--model")).toBeLessThan(last);
  });

  it("launches on the agent's saved default when no model is pinned", () => {
    const { extraAgentArgs } = buildRunLaunch({ ...spawnTask("t1"), mode: "apply" }, {} as any);
    expect(extraAgentArgs).not.toContain("--model");
  });

  it("uses codex's -m for a codex trigger", () => {
    const { agentBin, extraAgentArgs } = buildRunLaunch(
      { ...spawnTask("t1"), agent_type: "codex", model: "gpt-5.3-codex" },
      {} as any,
    );
    expect(agentBin).toBe("codex");
    expect(extraAgentArgs).toContain("-m");
    expect(extraAgentArgs[extraAgentArgs.indexOf("-m") + 1]).toBe("gpt-5.3-codex");
  });
});

// `cast trigger add --precheck`: the gate decides whether a firing spends a
// session at all. A refused firing must spawn nothing, inject nothing, and
// leave a skip record — the only trace that the trigger fired.
describe("precheck gate", () => {
  const injectTask = (precheck: string, extra: Record<string, any> = {}) => ({
    ...spawnTask("t1"),
    originating_conversation_id: "conv123",
    schedule_type: "recurring",
    precheck,
    ...extra,
  });

  it("exit 0 lets the run proceed and records no skip", async () => {
    const { scheduler, calls } = makeScheduler([injectTask("exit 0")], { claimResult: (t) => t });
    await scheduler.poll();
    expect(calls.injected).toEqual(["conv123"]);
    expect(calls.completed).toEqual(["t1"]);
    expect(calls.skipped).toEqual([]);
  });

  it("a non-zero exit skips the run: nothing injected, nothing failed, a skip recorded", async () => {
    const { scheduler, calls } = makeScheduler([injectTask("exit 3")], { claimResult: (t) => t });
    await scheduler.poll();
    expect(calls.claimed).toEqual(["t1"]);
    expect(calls.injected).toEqual([]);
    expect(calls.completed).toEqual([]);
    // A skip is not a failure: retrying it would just re-run the same gate.
    expect(calls.failed).toEqual([]);
    expect(calls.skipped).toHaveLength(1);
    expect(calls.skipped[0]).toMatchObject({ taskId: "t1", command: "exit 3", exitCode: 3, timedOut: false });
    expect(calls.skipped[0].reason).toBe("precheck exited 3");
  });

  it("gates a spawn run too — the tmux spawn is never reached", async () => {
    const task = { ...spawnTask("t1", dir), schedule_type: "recurring", precheck: "exit 1" };
    const { scheduler, calls } = makeScheduler([task], { claimResult: (t) => t });
    await scheduler.executeTask(task);
    expect(calls.skipped).toHaveLength(1);
    expect(calls.failed).toEqual([]);
  });

  it("a precheck that never answers skips the run rather than stalling the trigger", async () => {
    // The scheduler's gate is the 60s production timeout, so drive the runner
    // it calls with a short one — the contract under test is that a timeout
    // fails closed, which is what turns into a skip above.
    const started = Date.now();
    const result = await runTriggerPrecheck({ command: "sleep 30", cwd: dir, timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(triggerPrecheckPassed(result)).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("an event trigger ignores the precheck — the webhook already is the evidence", async () => {
    const task = injectTask("exit 1", { schedule_type: "event" });
    const { scheduler, calls } = makeScheduler([task], { claimResult: (t) => t });
    await scheduler.poll();
    expect(calls.skipped).toEqual([]);
    expect(calls.injected).toEqual(["conv123"]);
  });

  it("runs ungated when the named directory is gone, rather than answering about $HOME", async () => {
    const task = injectTask("exit 1", { project_path: path.join(dir, "vanished") });
    const { scheduler, calls } = makeScheduler([task], { claimResult: (t) => t });
    await scheduler.poll();
    expect(calls.skipped).toEqual([]);
    expect(calls.injected).toEqual(["conv123"]);
  });

  it("a trigger with no precheck runs exactly as before", async () => {
    const task = { ...spawnTask("t1"), originating_conversation_id: "conv123" };
    const { scheduler, calls } = makeScheduler([task], { claimResult: (t) => t });
    await scheduler.poll();
    expect(calls.skipped).toEqual([]);
    expect(calls.injected).toEqual(["conv123"]);
  });

  // ct-49673: claimTask settles who asked for this firing and hands the answer
  // back on the claimed row (last_run_source). The gate reads it, so `cast
  // trigger run` and the web Run now button are never answered with silence.
  describe("firing source", () => {
    const claimedAs = (source: string, extra: Record<string, any> = {}) =>
      injectTask("exit 1", { last_run_source: source, ...extra });

    it("a manual firing bypasses a gate that would refuse it", async () => {
      const { scheduler, calls } = makeScheduler([claimedAs("manual")], { claimResult: (t) => t });
      await scheduler.poll();
      expect(calls.skipped).toEqual([]);
      expect(calls.injected).toEqual(["conv123"]);
      expect(calls.completed).toEqual(["t1"]);
    });

    it("a manual firing of a one-shot trigger bypasses it too", async () => {
      const task = claimedAs("manual", { schedule_type: "once" });
      const { scheduler, calls } = makeScheduler([task], { claimResult: (t) => t });
      await scheduler.poll();
      expect(calls.skipped).toEqual([]);
      expect(calls.injected).toEqual(["conv123"]);
    });

    it("a scheduled firing is gated, and the skip says which source it refused", async () => {
      const task = claimedAs("scheduled", { schedule_type: "once" });
      const { scheduler, calls } = makeScheduler([task], { claimResult: (t) => t });
      await scheduler.poll();
      expect(calls.injected).toEqual([]);
      expect(calls.skipped).toHaveLength(1);
      expect(calls.skipped[0]).toMatchObject({ taskId: "t1", source: "scheduled", exitCode: 1 });
    });

    it("a recurring firing is gated", async () => {
      const { scheduler, calls } = makeScheduler([claimedAs("recurring")], { claimResult: (t) => t });
      await scheduler.poll();
      expect(calls.injected).toEqual([]);
      expect(calls.skipped).toHaveLength(1);
      expect(calls.skipped[0]).toMatchObject({ source: "recurring" });
    });

    it("an event firing is not gated", async () => {
      const task = claimedAs("event", { schedule_type: "event" });
      const { scheduler, calls } = makeScheduler([task], { claimResult: (t) => t });
      await scheduler.poll();
      expect(calls.skipped).toEqual([]);
      expect(calls.injected).toEqual(["conv123"]);
    });

    // The due row is the pre-claim snapshot, so its source names the PREVIOUS
    // firing. Read that one and a single Run now would leave the gate off for
    // every firing after it.
    it("reads the source the claim settled, not the stale one on the due row", async () => {
      const { scheduler, calls } = makeScheduler([claimedAs("manual")], {
        claimResult: (t) => ({ ...t, last_run_source: "recurring" }),
      });
      await scheduler.poll();
      expect(calls.injected).toEqual([]);
      expect(calls.skipped).toHaveLength(1);
      expect(calls.skipped[0]).toMatchObject({ source: "recurring" });
    });

    // A daemon can outrun the server it talks to. Against one that never
    // stamped a source, every firing is the schedule's own — which is what
    // they all were before Run now could say otherwise.
    it("falls back to the schedule when the claimed row carries no source", async () => {
      const { scheduler, calls } = makeScheduler([injectTask("exit 1")], { claimResult: (t) => t });
      await scheduler.poll();
      expect(calls.skipped).toHaveLength(1);
      expect(calls.skipped[0]).toMatchObject({ source: "recurring" });
    });
  });
});
