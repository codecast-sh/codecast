import { describe, expect, test } from "bun:test";
import {
  SharedTreeLedger,
  WAIT_FOR_STATUSES,
  migrateRow,
  runBatch,
  type BeginResult,
  type RunnerBatch,
  type RunnerIo,
  type RunnerRow,
} from "./runner.js";

// The runner's sequencing against a scripted world: what it asks for, in what
// order, and what it tells the server at every step. No SSH, no git, no clock.

type Call = [string, ...unknown[]];

function row(over: Partial<RunnerRow> = {}): RunnerRow {
  return {
    migration_id: "m1", conversation_id: "c1", session_id: "s1", title: "A", short_id: "aaaaaaa",
    direction: "to_cloud", from_device_id: "laptop", to_device_id: "box", status: "queued", position: 0,
    source_path: null, destination_path: null, ...over,
  };
}

function facts(over: Partial<Extract<BeginResult, { ok: true }>> = {}): Extract<BeginResult, { ok: true }> {
  return {
    ok: true, conversation_id: "c1", session_id: "s1", direction: "to_cloud", owner_device_id: "laptop",
    owner_is_remote: false, owner_online: true, owner_label: "MacBook", to_device_id: "box", to_label: "Linux box",
    project_path: "/Users/me/src/repo/.codecast/worktrees/a", git_root: "/Users/me/src/repo", git_remote_url: null,
    worktree_name: "a", worktree_branch: "feat", agent_status: null, title: "A", ...over,
  };
}

/**
 * A world with a clock that only advances when the runner sleeps, a queue of
 * agent statuses the idle poll walks through, and scripted command results.
 */
function world(opts: {
  batch?: Partial<RunnerBatch>;
  rows?: RunnerRow[];
  begin?: Record<string, BeginResult>;
  statuses?: string[];
  quiesceResults?: Array<{ quiesced: boolean; reason?: string } | { error: string }>;
  resumeError?: string | null;
  resumeNeverExecutes?: boolean;
  transferError?: string;
  cancelAfterPolls?: number;
  deviceOnline?: boolean;
}) {
  const calls: Call[] = [];
  let now = 1_000_000;
  const statuses = [...(opts.statuses ?? [])];
  const quiesce = [...(opts.quiesceResults ?? [{ quiesced: true }])];
  const commands = new Map<string, { executed_at: number | null; result: string | null; error: string | null }>();
  let commandSeq = 0;
  let polls = 0;
  const rows = opts.rows ?? [row()];
  const batch: RunnerBatch = { batch_id: "mg-test", to_device_id: "box", cancelled_at: null, wait_for_idle_ms: 10 * 60_000, concurrency: 1, rows, ...(opts.batch ?? {}) };
  const io: RunnerIo = {
    now: () => now,
    sleep: async (ms) => { now += ms; calls.push(["sleep", ms]); },
    log: (line) => { calls.push(["log", line]); },
    deviceId: () => "laptop",
    loadBatch: async () => batch,
    begin: async (id) => { calls.push(["begin", id]); return opts.begin?.[id] ?? facts({ agent_status: statuses.shift() ?? null }); },
    facts: async (id) => {
      calls.push(["facts", id]);
      polls++;
      return { status: "waiting_idle", batch_cancelled: opts.cancelAfterPolls !== undefined && polls >= opts.cancelAfterPolls, owner_device_id: "laptop", owner_online: true, agent_status: statuses.length ? statuses.shift()! : null, fenced: true };
    },
    report: async (id, patch) => { calls.push(["report", id, patch.status, patch.stage]); },
    enqueueQuiesce: async (id, mode) => {
      calls.push(["quiesce", id, mode]);
      const cmdId = `q${++commandSeq}`;
      const r = quiesce.shift() ?? { quiesced: true };
      commands.set(cmdId, "error" in r ? { executed_at: now + 1, result: null, error: r.error } : { executed_at: now + 1, result: JSON.stringify(r), error: null });
      return { command_id: cmdId, target_device_id: "laptop" };
    },
    commandStatus: async (cmdId) => { calls.push(["commandStatus", cmdId]); return commands.get(cmdId) ?? null; },
    finish: async (id, args) => {
      calls.push(["finish", id, args]);
      const cmdId = `r${++commandSeq}`;
      commands.set(cmdId, opts.resumeNeverExecutes ? { executed_at: null, result: null, error: null } : { executed_at: now + 1, result: "{}", error: opts.resumeError ?? null });
      return { ok: true, resume_command_id: cmdId };
    },
    confirm: async (id, ok, detail) => { calls.push(["confirm", id, ok, detail?.error ?? detail?.stage]); },
    fail: async (id, error, cancelled) => { calls.push(["fail", id, error, !!cancelled]); },
    sendNotice: async (convId, text) => { calls.push(["notice", convId, text]); },
    deviceOnline: async (d) => { calls.push(["deviceOnline", d]); return opts.deviceOnline ?? true; },
    prepareHost: async (d) => { calls.push(["prepareHost", d]); },
    transferToCloud: async (f, o) => {
      calls.push(["transferToCloud", f.session_id, o.skipTree]);
      if (opts.transferError) throw new Error(opts.transferError);
      return { destinationPath: `/home/ubuntu/work/${f.worktree_name}`, gitRoot: `/home/ubuntu/work/${f.worktree_name}`, sourcePath: f.project_path!, verification: "heads match", localCwd: f.project_path! };
    },
    transferToLocal: async (f) => {
      calls.push(["transferToLocal", f.session_id]);
      if (opts.transferError) throw new Error(opts.transferError);
      return { destinationPath: `/Users/me/src/repo/.codecast/worktrees/${f.worktree_name}`, sourcePath: f.project_path!, verification: "pulled" };
    },
    notice: () => "you moved",
  };
  const kinds = () => calls.filter((c) => c[0] !== "log" && c[0] !== "sleep" && c[0] !== "commandStatus").map((c) => c[0]);
  return { io, batch, calls, kinds, clock: () => now };
}

describe("migrateRow — a session to the cloud", () => {
  test("idle session: fence, stop, wake host, push, flip, notice, confirm", async () => {
    const w = world({ statuses: ["idle"] });
    const out = await migrateRow(w.io, w.batch, row(), new SharedTreeLedger());
    expect(out.outcome).toBe("done");
    expect(w.kinds()).toEqual([
      "begin", "quiesce", "report", "prepareHost", "deviceOnline", "report", "transferToCloud", "report", "finish", "notice", "confirm",
    ]);
    expect(w.calls.find((c) => c[0] === "quiesce")).toEqual(["quiesce", "m1", "idle"]);
    expect(w.calls.find((c) => c[0] === "transferToCloud")).toEqual(["transferToCloud", "s1", false]);
    expect(w.calls.find((c) => c[0] === "finish")).toEqual(["finish", "m1", {
      project_path: "/home/ubuntu/work/a", git_root: "/home/ubuntu/work/a", verification: "heads match", source_path: "/Users/me/src/repo/.codecast/worktrees/a",
    }]);
    expect(w.calls.find((c) => c[0] === "confirm")).toEqual(["confirm", "m1", true, "running on Linux box"]);
    expect(w.calls.some((c) => c[0] === "fail")).toBe(false);
  });

  test("mid-turn session: waits, polling, until the turn ends — then stops it gently", async () => {
    const w = world({ statuses: ["working", "working", "thinking", "idle"] });
    const out = await migrateRow(w.io, w.batch, row(), new SharedTreeLedger());
    expect(out.outcome).toBe("done");
    const waits = w.calls.filter((c) => c[0] === "report" && c[2] === "waiting_idle");
    expect(waits).toHaveLength(3);
    expect(String(waits[0][3])).toContain("waiting for the current turn to finish (working");
    expect(w.calls.filter((c) => c[0] === "facts")).toHaveLength(3);
    expect(w.calls.find((c) => c[0] === "quiesce")).toEqual(["quiesce", "m1", "idle"]);
    // The fence went up BEFORE the wait: begin precedes every facts poll.
    expect(w.kinds().indexOf("begin")).toBeLessThan(w.kinds().indexOf("facts"));
  });

  test("past the idle window the turn is interrupted, and the confirmation says so", async () => {
    const w = world({ batch: { wait_for_idle_ms: 12_000 }, statuses: Array(10).fill("working") });
    const out = await migrateRow(w.io, w.batch, row(), new SharedTreeLedger());
    expect(out.outcome).toBe("done");
    expect(w.calls.find((c) => c[0] === "quiesce")).toEqual(["quiesce", "m1", "force"]);
    expect(w.calls.find((c) => c[0] === "confirm")?.[3]).toContain("interrupted");
    // Bounded: only as many polls as the window allows (5s cadence into 12s).
    expect(w.calls.filter((c) => c[0] === "facts").length).toBeLessThanOrEqual(3);
  });

  test("wait window of zero interrupts at once", async () => {
    const w = world({ batch: { wait_for_idle_ms: 0 }, statuses: ["working"] });
    await migrateRow(w.io, w.batch, row(), new SharedTreeLedger());
    expect(w.calls.filter((c) => c[0] === "facts")).toHaveLength(0);
    expect(w.calls.find((c) => c[0] === "quiesce")).toEqual(["quiesce", "m1", "force"]);
  });

  test("a permission prompt is not waited on — the answer could never arrive through the fence", async () => {
    const w = world({ statuses: ["permission_blocked"] });
    await migrateRow(w.io, w.batch, row(), new SharedTreeLedger());
    expect(w.calls.filter((c) => c[0] === "facts")).toHaveLength(0);
    expect(w.calls.find((c) => c[0] === "quiesce")).toEqual(["quiesce", "m1", "idle"]);
    expect(WAIT_FOR_STATUSES.has("permission_blocked")).toBe(false);
    expect(WAIT_FOR_STATUSES.has("working")).toBe(true);
  });

  test("a turn that starts between the check and the stop is waited out, then stopped", async () => {
    const w = world({ statuses: ["idle"], quiesceResults: [{ quiesced: false, reason: "status-working" }, { quiesced: true }] });
    const out = await migrateRow(w.io, w.batch, row(), new SharedTreeLedger());
    expect(out.outcome).toBe("done");
    expect(w.calls.filter((c) => c[0] === "quiesce").map((c) => c[2])).toEqual(["idle", "idle"]);
    expect(w.calls.some((c) => c[0] === "report" && String(c[3]).includes("a turn started"))).toBe(true);
  });

  test("the stop command dying in the queue fails the row before anything is transferred", async () => {
    const w = world({ statuses: ["idle"] });
    // Never executes: commandStatus keeps answering "not yet".
    w.io.enqueueQuiesce = async () => ({ command_id: "dead", target_device_id: "laptop" });
    const out = await migrateRow(w.io, w.batch, row(), new SharedTreeLedger());
    expect(out.outcome).toBe("failed");
    expect(out.detail).toContain("did not pick up the stop command");
    expect(w.calls.some((c) => c[0] === "transferToCloud")).toBe(false);
    expect(w.calls.find((c) => c[0] === "fail")?.[3]).toBe(false);
  });

  test("a transfer error fails the row (fence lifted by fail) and never flips ownership", async () => {
    const w = world({ statuses: ["idle"], transferError: "rsync: connection unexpectedly closed" });
    const out = await migrateRow(w.io, w.batch, row(), new SharedTreeLedger());
    expect(out).toEqual({ migration_id: "m1", outcome: "failed", detail: "rsync: connection unexpectedly closed" });
    expect(w.calls.some((c) => c[0] === "finish")).toBe(false);
    expect(w.calls.find((c) => c[0] === "fail")).toEqual(["fail", "m1", "rsync: connection unexpectedly closed", false]);
  });

  test("a resume that errors on the destination is reported as a failure of the moved session", async () => {
    const w = world({ statuses: ["idle"], resumeError: "No local checkout" });
    const out = await migrateRow(w.io, w.batch, row(), new SharedTreeLedger());
    expect(out.outcome).toBe("failed");
    expect(w.calls.find((c) => c[0] === "confirm")).toEqual(["confirm", "m1", false, "moved, but the resume on Linux box failed: No local checkout"]);
  });

  test("a resume nobody confirms still counts as moved, with an honest stage", async () => {
    const w = world({ statuses: ["idle"], resumeNeverExecutes: true });
    const out = await migrateRow(w.io, w.batch, row(), new SharedTreeLedger());
    expect(out.outcome).toBe("done");
    expect(w.calls.find((c) => c[0] === "confirm")?.[3]).toContain("has not confirmed the resume yet");
  });

  test("a refused begin is a skip, not a failure", async () => {
    const w = world({ begin: { m1: { ok: false, reason: "row is cancelled" } } });
    const out = await migrateRow(w.io, w.batch, row(), new SharedTreeLedger());
    expect(out).toEqual({ migration_id: "m1", outcome: "skipped", detail: "row is cancelled" });
    expect(w.kinds()).toEqual(["begin"]);
  });

  test("cancelling the batch during the idle wait releases the row as cancelled", async () => {
    const w = world({ statuses: ["working", "working", "working"], cancelAfterPolls: 2 });
    const out = await migrateRow(w.io, w.batch, row(), new SharedTreeLedger());
    expect(out.outcome).toBe("cancelled");
    expect(w.calls.find((c) => c[0] === "fail")).toEqual(["fail", "m1", "cancelled before the transfer started", true]);
    expect(w.calls.some((c) => c[0] === "quiesce")).toBe(false);
  });

  test("a cloud host that never comes online fails the row after the stop", async () => {
    const w = world({ statuses: ["idle"], deviceOnline: false });
    const out = await migrateRow(w.io, w.batch, row(), new SharedTreeLedger());
    expect(out.outcome).toBe("failed");
    expect(out.detail).toBe("Linux box never came online");
    expect(w.calls.some((c) => c[0] === "transferToCloud")).toBe(false);
  });
});

describe("migrateRow — a session back to the laptop", () => {
  test("wakes the box, stops the session THERE, pulls, flips to this machine", async () => {
    const w = world({ begin: { m1: facts({ direction: "to_local", owner_device_id: "box", owner_is_remote: true, owner_label: "Linux box", to_device_id: "laptop", to_label: "MacBook", project_path: "/home/ubuntu/work/repo/.codecast/worktrees/a", agent_status: "idle" }) } });
    const out = await migrateRow(w.io, w.batch, row({ direction: "to_local", from_device_id: "box", to_device_id: "laptop" }), new SharedTreeLedger());
    expect(out.outcome).toBe("done");
    expect(w.kinds()).toEqual(["begin", "report", "prepareHost", "deviceOnline", "quiesce", "report", "transferToLocal", "report", "finish", "notice", "confirm"]);
    expect(w.calls.find((c) => c[0] === "prepareHost")).toEqual(["prepareHost", "box"]);
    expect(w.calls.find((c) => c[0] === "finish")?.[2]).toMatchObject({ project_path: "/Users/me/src/repo/.codecast/worktrees/a", source_path: "/home/ubuntu/work/repo/.codecast/worktrees/a" });
  });
});

describe("shared worktrees", () => {
  test("two sessions in one worktree push the tree once; the second waits and pushes only its transcript", async () => {
    const w = world({
      batch: { concurrency: 2 },
      rows: [row(), row({ migration_id: "m2", conversation_id: "c2", session_id: "s2", short_id: "bbbbbbb", position: 1 })],
      begin: { m1: facts({ agent_status: "idle" }), m2: facts({ conversation_id: "c2", session_id: "s2", agent_status: "idle" }) },
    });
    const outcomes = await runBatch(w.io);
    expect(outcomes.map((o) => o.outcome)).toEqual(["done", "done"]);
    const pushes = w.calls.filter((c) => c[0] === "transferToCloud");
    expect(pushes).toHaveLength(2);
    const trees = pushes.filter((c) => c[2] === false);
    const transcripts = pushes.filter((c) => c[2] === true);
    expect(trees).toHaveLength(1);
    expect(transcripts).toHaveLength(1);
    // The tree push finished before the transcript-only push began.
    expect(w.calls.indexOf(trees[0])).toBeLessThan(w.calls.indexOf(transcripts[0]));
  });

  test("a failed tree push releases the followers to push the tree themselves", async () => {
    const ledger = new SharedTreeLedger();
    expect(ledger.claim("k")).toBe(true);
    expect(ledger.claim("k")).toBe(false);
    let followerRan = false;
    const follower = ledger.awaitPushed("k").then(() => { followerRan = true; });
    ledger.release("k");
    await follower;
    expect(followerRan).toBe(true);
    // After the release the key is free again: the follower becomes the owner.
    expect(ledger.claim("k")).toBe(true);
  });
});

describe("runBatch", () => {
  test("takes only this batch's queued rows, in position order, and tallies", async () => {
    const w = world({
      rows: [row({ migration_id: "m3", position: 2 }), row({ migration_id: "m1", position: 0 }), row({ migration_id: "m2", position: 1, status: "done" })],
      begin: { m1: facts({ agent_status: "idle" }), m3: facts({ agent_status: "idle" }) },
    });
    const outcomes = await runBatch(w.io);
    expect(outcomes.map((o) => o.migration_id)).toEqual(["m1", "m3"]);
    expect(w.calls.filter((c) => c[0] === "begin").map((c) => c[1])).toEqual(["m1", "m3"]);
    expect(String(w.calls.at(-1)?.[1])).toContain("2 done");
  });

  test("no batch → throws", async () => {
    const w = world({});
    w.io.loadBatch = async () => null;
    await expect(runBatch(w.io)).rejects.toThrow("no such batch");
  });
});
