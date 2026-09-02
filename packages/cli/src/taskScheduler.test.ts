import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TaskScheduler, buildRunLaunch } from "./taskScheduler.js";
import { deviceId } from "./remote/device.js";

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
}

function makeScheduler(
  dueTasks: any[],
  opts: { claimResult?: (task: any) => any; filing?: "stashed" | "killed" | null } = {},
) {
  const calls: MockCalls = { claimed: [], failed: [], injected: [], completed: [], prompts: [] };
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
