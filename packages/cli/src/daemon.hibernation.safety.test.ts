import { afterEach, describe, expect, test } from "bun:test";
import { MID_TURN_AGENT_STATUSES, type AgentStatus } from "@codecast/shared/contracts";
import {
  clearHibernationPark, flushHibernationStamps, hibernateSessionNow,
  registerManagedStartedSession, runHeartbeatFlush, runHibernationPass, sessionParkStateForTests,
  setSyncServiceForTests, trackSessionPaneForTests, type HibernationPassIo,
} from "./daemon.js";
import { SyncService, type ConversationLifecycle } from "./syncService.js";

const tracked: string[] = [];
const life = (): ConversationLifecycle => ({ status: "active", source: "lifecycle", hideStateKnown: true, inboxPinnedAt: null, hasPendingMessages: false });
function fixture() {
  const id = `e1-${crypto.randomUUID()}`;
  const tmux = `cc-e1-${id}`;
  const conv = `conv-${id}`;
  const ids: Record<string, string> = { [id]: conv };
  const parked: string[] = [];
  tracked.push(id);
  trackSessionPaneForTests(id, tmux, { status: "idle" });
  const io: HibernationPassIo = {
    terminal: async () => ({ stdout: "" }),
    policy: () => ({ maxLive: 0, idleMs: 1, maxPerPass: 5 }),
    tmuxSessions: async () => new Map([[tmux, 0]]),
    awakeIdleMs: () => 10000,
    subagentActiveAgoMs: () => Infinity,
    conversationIds: () => ids,
    askSidecarMtimeMs: async () => null,
    transcriptLastRealMs: async () => null,
    lifecycle: async () => life(),
    canReapPidTree: () => true,
    deliveryActive: () => false,
    inspectTarget: async () => ({ session: "$1", pane: "%1", pid: 99, start: "start", stamp: id, conversationStamp: conv }),
    park: async (id) => { parked.push(id); return true; },
    now: () => Date.now(),
  };
  return { id, tmux, conv, ids, io, parked };
}

afterEach(async () => {
  setSyncServiceForTests(null);
  for (const id of tracked.splice(0)) trackSessionPaneForTests(id, null);
  await flushHibernationStamps();
});

for (const mode of ["pass", "command"] as const) {
  const run = async (f: ReturnType<typeof fixture>) => {
    if (mode === "pass") expect(await runHibernationPass(f.io)).toBe(0);
    else expect((await hibernateSessionNow(f.id, undefined, f.io)).result).toStartWith("skipped_");
    expect(f.parked).toEqual([]);
    expect(sessionParkStateForTests(f.id)).toMatchObject({ parked: false, paneTracked: true, beating: true });
  };
  describe(`${mode} fails closed`, () => {
    for (const status of [undefined, "connected", "stopped", "unknown", "waiting", "resuming", "starting", ...MID_TURN_AGENT_STATUSES]) {
      test(`preserves status ${status}`, async () => {
        const f = fixture();
        trackSessionPaneForTests(f.id, null);
        trackSessionPaneForTests(f.id, f.tmux, { status: status as AgentStatus });
        await run(f);
      });
    }
    const facts: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
      ["null lifecycle", f => { f.io.lifecycle = async () => null; }],
      ["unknown lifecycle", f => { f.io.lifecycle = async () => ({ ...life(), status: null }); }],
      ["degraded lifecycle", f => { f.io.lifecycle = async () => ({ ...life(), hideStateKnown: false }); }],
      ["unknown pin", f => { f.io.lifecycle = async () => ({ ...life(), inboxPinnedAt: undefined }); }],
      ["unknown pending messages", f => { f.io.lifecycle = async () => ({ ...life(), hasPendingMessages: undefined }); }],
      ["missing conversation", f => { delete f.ids[f.id]; }],
      ["unknown attachment", f => { f.io.tmuxSessions = async () => new Map([[f.tmux, NaN]]); }],
      ["failed sidecar read", f => { f.io.askSidecarMtimeMs = async () => { throw new Error("EACCES"); }; }],
      ["unknown target identity", f => { f.io.inspectTarget = async () => null; }],
      ["silent known child", f => { f.io.subagentActiveAgoMs = () => 30 * 60_000; }],
      ["status changes during lifecycle", f => { f.io.lifecycle = async () => { trackSessionPaneForTests(f.id, f.tmux, { status: "waiting" }); return life(); }; }],
      ["identity mapping changes during lifecycle", f => { f.io.lifecycle = async () => { trackSessionPaneForTests(f.id, "different-tmux"); return life(); }; }],
      ["pin appears on recheck", f => { let calls = 0; f.io.lifecycle = async () => ({ ...life(), inboxPinnedAt: ++calls > 1 ? 123 : null }); }],
      ["pending message appears on recheck", f => { let calls = 0; f.io.lifecycle = async () => ({ ...life(), hasPendingMessages: ++calls > 1 }); }],
      ["attachment appears on recheck", f => { let calls = 0; f.io.tmuxSessions = async () => new Map([[f.tmux, ++calls > 1 ? 1 : 0]]); }],
      ["pane recreated during awaits", f => { let calls = 0; f.io.inspectTarget = async () => ({ session: "$1", pane: `%${++calls}`, pid: 99, start: "start", stamp: f.id, conversationStamp: f.conv }); }],
      ["park fails", f => { f.io.park = async () => false; }],
      ["park throws", f => { f.io.park = async () => { throw new Error("tmux failed"); }; }],
    ];
    for (const [name, change] of facts) test(name, async () => { const f = fixture(); change(f); await run(f); });

    test("concurrent parks have one owner", async () => {
      const f = fixture();
      let unblock!: () => void;
      let entered!: () => void;
      const arrived = new Promise<void>(r => { entered = r; });
      let calls = 0;
      f.io.lifecycle = async () => { if (++calls === 1) { entered(); await new Promise<void>(r => { unblock = r; }); } return life(); };
      const first = hibernateSessionNow(f.id, undefined, f.io);
      await arrived;
      await run(f);
      f.io.lifecycle = async () => life();
      unblock();
      expect(await first).toEqual({ result: "hibernated" });
      expect(f.parked).toEqual([f.id]);
    });
  });
}

test("command fallback is checked for pin and pending work before parking", async () => {
  for (const patch of [{ inboxPinnedAt: 123 }, { hasPendingMessages: true }]) {
    const f = fixture();
    delete f.ids[f.id];
    const queried: string[] = [];
    f.io.lifecycle = async conv => { queried.push(conv); return { ...life(), ...patch }; };
    expect((await hibernateSessionNow(f.id, "explicit-conversation", f.io)).result).toStartWith("skipped_");
    expect(queried).toEqual(["explicit-conversation"]);
    expect(f.parked).toEqual([]);
  }
});

test("conflicting command and cached conversations refuse", async () => {
  const f = fixture();
  expect((await hibernateSessionNow(f.id, "different-conversation", f.io)).result).toBe("skipped_conversation-conflict");
  expect(f.parked).toEqual([]);
});

test("wake retries an unavailable service and keeps local status active", async () => {
  const f = fixture();
  trackSessionPaneForTests(f.id, f.tmux, { parked: true, status: "hibernated" });
  clearHibernationPark(f.id, f.conv);
  expect(sessionParkStateForTests(f.id)).toMatchObject({ parked: false, status: "connected" });
  const writes: unknown[][] = [];
  setSyncServiceForTests({ updateSessionAgentStatus: async (...args: unknown[]) => { writes.push(args); return true; } } as unknown as SyncService);
  await flushHibernationStamps();
  expect(writes).toHaveLength(1);
  expect(writes[0][1]).toBe("connected");
  expect(writes[0][6]).toBeNull();
});

test("a missing mapping remains retryable", async () => {
  const f = fixture();
  const writes: unknown[][] = [];
  setSyncServiceForTests({ updateSessionAgentStatus: async (...args: unknown[]) => { writes.push(args); return true; } } as unknown as SyncService);
  clearHibernationPark(f.id);
  await flushHibernationStamps();
  expect(writes).toHaveLength(0);
  clearHibernationPark(f.id, f.conv);
  await flushHibernationStamps();
  expect(writes).toHaveLength(1);
});

for (const failure of ["false", "throw"] as const) test(`a ${failure} status write retries until acknowledged`, async () => {
  const f = fixture();
  let calls = 0;
  let stamp: number | null = 123;
  setSyncServiceForTests({ updateSessionAgentStatus: async (...args: unknown[]) => {
    if (++calls === 1) { if (failure === "throw") throw new Error("offline"); return false; }
    stamp = args[6] as null;
    return true;
  } } as unknown as SyncService);
  clearHibernationPark(f.id, f.conv);
  await flushHibernationStamps();
  expect(stamp).toBe(123);
  await flushHibernationStamps();
  expect(calls).toBe(2);
  expect(stamp).toBeNull();
  clearHibernationPark(f.id, f.conv);
  await flushHibernationStamps();
  expect(calls).toBe(2);
});

test("actual adoption after restart clears the persisted stamp without a local mark", async () => {
  const f = fixture();
  registerManagedStartedSession(f.conv, f.id, f.tmux);
  const writes: unknown[][] = [];
  setSyncServiceForTests({ updateSessionAgentStatus: async (...args: unknown[]) => { writes.push(args); return true; } } as unknown as SyncService);
  await flushHibernationStamps();
  expect(writes).toHaveLength(1);
  expect(writes[0][6]).toBeNull();
});

test("sync status acknowledgment reflects transport success and missing credentials", async () => {
  const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "test" });
  let fail = true;
  (sync as any).client = { mutation: async () => { if (fail) throw new Error("offline"); } };
  expect(await sync.updateSessionAgentStatus("conv", "connected", 1, undefined, undefined, undefined, null)).toBe(false);
  fail = false;
  expect(await sync.updateSessionAgentStatus("conv", "connected", 2, undefined, undefined, undefined, null)).toBe(true);
  (sync as any).apiToken = undefined;
  expect(await sync.updateSessionAgentStatus("conv", "connected")).toBe(false);
});


test("a routine heartbeat preserves a still parked session", async () => {
  const f = fixture();
  trackSessionPaneForTests(f.id, f.tmux, { parked: true, status: "hibernated" });
  const statuses: unknown[] = [];
  const writes: unknown[] = [];
  setSyncServiceForTests({
    heartbeatManagedSessionsBatch: async (rows: unknown[]) => { statuses.push(...rows); },
    updateSessionAgentStatus: async (...args: unknown[]) => { writes.push(args); return true; },
  } as unknown as SyncService);
  await runHeartbeatFlush();
  expect(sessionParkStateForTests(f.id)).toMatchObject({ parked: true, status: "hibernated" });
  expect(writes).toEqual([]);
  expect(statuses).toContainEqual(expect.objectContaining({ session_id: f.id, agent_status: "hibernated" }));
});

test("a wake between heartbeat batches cannot resend the pre-wake parked status", async () => {
  const fleet = Array.from({ length: 26 }, fixture);
  const target = fleet.at(-1)!;
  trackSessionPaneForTests(target.id, target.tmux, { parked: true, status: "hibernated" });
  const batches: Array<Array<{ session_id: string; agent_status?: string }>> = [];
  setSyncServiceForTests({
    heartbeatManagedSessionsBatch: async (rows: Array<{ session_id: string; agent_status?: string }>) => {
      batches.push(rows);
      if (batches.length === 1) clearHibernationPark(target.id, target.conv);
    },
    updateSessionAgentStatus: async () => true,
  } as unknown as SyncService);
  await runHeartbeatFlush();
  await flushHibernationStamps();
  const delivered = batches.flat().find(row => row.session_id === target.id);
  expect(delivered?.agent_status).toBe("connected");
});


test("stamp acknowledgment belongs to the conversation that acknowledged it", async () => {
  const f = fixture();
  const writes: string[] = [];
  setSyncServiceForTests({ updateSessionAgentStatus: async (conv: string) => { writes.push(conv); return true; } } as unknown as SyncService);
  clearHibernationPark(f.id, "old-conversation");
  await flushHibernationStamps();
  clearHibernationPark(f.id, "new-conversation");
  await flushHibernationStamps();
  expect(writes).toEqual(["old-conversation", "new-conversation"]);
});
