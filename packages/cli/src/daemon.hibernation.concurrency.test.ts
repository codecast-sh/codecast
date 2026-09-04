import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  clearHibernationPark, flushHibernationStamps, hibernationConcurrencyForTests as h,
  runHeartbeatFlush, setSyncServiceForTests, trackSessionPaneForTests,
} from "./daemon.js";
import type { SyncService } from "./syncService.js";
import { waitFor } from "./test-helpers/messagingHarness.js";
import { processDeclaredSessionId } from "./sessionProcessMatcher.js";

const defer = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const ids: string[] = [];
function id() { const id = `e1-fix2-${crypto.randomUUID()}`; ids.push(id); return id; }
afterEach(async () => {
  h.setResumeInner(null);
  setSyncServiceForTests(null);
  for (const sessionId of ids.splice(0)) trackSessionPaneForTests(sessionId, null);
  await Promise.all([...h.sessionStatusWrites.values()]);
});

test("501 ordinary statuses coalesce behind a stalled write and another session still sends", async () => {
  const sessionId = id(), other = id(), gate = defer();
  const seen: unknown[][] = [];
  const sync = { updateSessionAgentStatus: async (...args: unknown[]) => {
    seen.push(args);
    if (seen.length === 1) await gate.promise;
    return true;
  } } as unknown as SyncService;
  h.sendAgentStatus(sync, "conv", sessionId, "thinking");
  await waitFor(() => seen.length === 1, { timeoutMs: 1000 });
  try {
    for (let i = 0; i < 500; i++) h.sendAgentStatus(sync, "conv", sessionId, i % 2 ? "thinking" : "idle");
    expect(h.sessionStatusQueues.get(sessionId)?.status).toBeDefined();
    expect(h.sessionStatusQueues.get(sessionId)?.stamp).toBeUndefined();
    h.sendAgentStatus(sync, "other-conv", other, "working");
    await h.sessionStatusWrites.get(other);
    expect(seen.map(row => row[0])).toEqual(["conv", "other-conv"]);
  } finally { gate.resolve(); }
  await h.sessionStatusWrites.get(sessionId);
  expect(seen.filter(row => row[0] === "conv").map(row => row[1])).toEqual(["thinking", "thinking"]);
  expect(h.sessionStatusQueues.has(sessionId)).toBe(false);
});

test("superseded callers settle false, only actual successful writes acknowledge true", async () => {
  const sessionId = id(), gate = defer();
  const writes: number[] = [];
  const first = h.serializeSessionStatus(sessionId, async () => { writes.push(0); await gate.promise; return true; });
  await waitFor(() => writes.length === 1, { timeoutMs: 1000 });
  const rest = Array.from({ length: 501 }, (_, i) => h.serializeSessionStatus(sessionId, async () => { writes.push(i + 1); return true; }));
  try {
    expect(await Promise.all(rest.slice(0, -1))).toEqual(Array(500).fill(false));
    expect(writes).toEqual([0]);
  } finally { gate.resolve(); }
  expect(await first).toBe(true);
  expect(await rest.at(-1)).toBe(true);
  expect(writes).toEqual([0, 501]);
});

test("a rejected write settles false and the current pending write still runs", async () => {
  const sessionId = id(), gate = defer();
  const first = h.serializeSessionStatus(sessionId, async () => { await gate.promise; throw new Error("synthetic transport failure"); });
  await Promise.resolve();
  const next = h.serializeSessionStatus(sessionId, async () => true);
  gate.resolve();
  expect(await Promise.all([first, next])).toEqual([false, true]);
});

test("coalescing preserves permission mode and current settle task payload, active state clears stale tasks", async () => {
  const sessionId = id(), gate = defer();
  const seen: unknown[][] = [];
  const sync = { updateSessionAgentStatus: async (...args: unknown[]) => { seen.push(args); if (seen.length === 1) await gate.promise; return true; } } as unknown as SyncService;
  h.sendAgentStatus(sync, "conv", sessionId, "thinking");
  await waitFor(() => seen.length === 1, { timeoutMs: 1000 });
  const tasks = [{ id: "background-1", kind: "background" as const }];
  try {
    h.pendingOpenTaskReports.set(sessionId, tasks);
    h.sendAgentStatus(sync, "conv", sessionId, "waiting", 100, "bypassPermissions");
    h.sendAgentStatus(sync, "conv", sessionId, "waiting", 101);
    expect(h.sessionStatusQueues.get(sessionId)?.status?.payload).toMatchObject({ permissionMode: "bypassPermissions", openTasks: tasks });
  } finally { gate.resolve(); }
  await h.sessionStatusWrites.get(sessionId);
  expect(seen.at(-1)?.slice(1, 5)).toEqual(["waiting", 101, "bypassPermissions", tasks]);

  const activeGate = defer();
  let entered = false;
  const held = h.serializeSessionStatus(sessionId, async () => { entered = true; await activeGate.promise; return true; });
  await waitFor(() => entered, { timeoutMs: 1000 });
  try {
    h.pendingOpenTaskReports.set(sessionId, tasks);
    h.sendAgentStatus(sync, "conv", sessionId, "waiting", 102, "bypassPermissions");
    h.sendAgentStatus(sync, "conv", sessionId, "thinking", 103);
    expect(h.sessionStatusQueues.get(sessionId)?.status?.payload).toMatchObject({ permissionMode: "bypassPermissions", openTasks: undefined });
  } finally { activeGate.resolve(); }
  await held;
  await h.sessionStatusWrites.get(sessionId);
  expect(seen.at(-1)?.slice(1, 5)).toEqual(["thinking", 103, "bypassPermissions", undefined]);
});

test("pending park is superseded by wake, and wake is not acknowledged while transport stalls", async () => {
  const sessionId = id(), gate = defer(), clearGate = defer();
  const writes: unknown[][] = [];
  const sync = { updateSessionAgentStatus: async (...args: unknown[]) => {
    writes.push(args);
    if (writes.length === 1) await gate.promise;
    if (args[6] === null) await clearGate.promise;
    return true;
  } } as unknown as SyncService;
  setSyncServiceForTests(sync);
  h.sendAgentStatus(sync, "conv", sessionId, "idle");
  await waitFor(() => writes.length === 1, { timeoutMs: 1000 });
  trackSessionPaneForTests(sessionId, "own-fake", { parked: true, status: "hibernated" });
  h.pendingHibernationStamps.set(sessionId, { conversationId: "conv", at: Date.now() });
  const parkFlush = flushHibernationStamps();
  clearHibernationPark(sessionId, "conv");
  for (let i = 0; i < 501; i++) h.sendAgentStatus(sync, "conv", sessionId, "thinking");
  try {
    expect(h.hibernationStampCleared.has(sessionId)).toBe(false);
    expect(h.sessionStatusQueues.get(sessionId)?.stamp).toBeDefined();
    gate.resolve();
    await parkFlush;
    await waitFor(() => writes.some(w => w[6] === null), { timeoutMs: 1000 });
    expect(writes.some(w => typeof w[6] === "number")).toBe(false);
    expect(h.hibernationStampCleared.has(sessionId)).toBe(false);
  } finally { gate.resolve(); clearGate.resolve(); }
  await flushHibernationStamps();
  expect(h.hibernationStampCleared.get(sessionId)).toBe("conv");
  expect(writes.length).toBeLessThanOrEqual(3);
});

test("four hung stamps do not block the fifth session or grow work on repeated heartbeats", async () => {
  const fleet = Array.from({ length: 5 }, id), gate = defer();
  const seen: string[] = [];
  for (const sessionId of fleet) clearHibernationPark(sessionId, sessionId);
  setSyncServiceForTests({
    updateSessionAgentStatus: async (conv: string) => { seen.push(conv); if (conv !== fleet[4]) await gate.promise; return true; },
    heartbeatManagedSessionsBatch: async () => {},
  } as unknown as SyncService);
  try {
    await runHeartbeatFlush();
    await waitFor(() => seen.length === 5, { timeoutMs: 1000 });
    const running = fleet.slice(0, 4).map(sessionId => h.hibernationStampWrites.get(sessionId));
    for (let i = 0; i < 50; i++) await runHeartbeatFlush();
    expect(seen).toHaveLength(5);
    expect(fleet.slice(0, 4).map(sessionId => h.hibernationStampWrites.get(sessionId))).toEqual(running);
    for (const sessionId of fleet.slice(0, 4)) {
      expect(h.sessionStatusQueues.get(sessionId)?.status).toBeUndefined();
      expect(h.sessionStatusQueues.get(sessionId)?.stamp).toBeUndefined();
    }
    expect(h.hibernationStampCleared.get(fleet[4])).toBe(fleet[4]);
  } finally { gate.resolve(); }
  await flushHibernationStamps();
});

test("resume reserves before owner awaits and all waiters share its result", async () => {
  const sessionId = id(), ownerGate = defer(), innerGate = defer();
  let ownerCalls = 0, innerCalls = 0;
  setSyncServiceForTests({
    getConversationOwnerInfo: async () => { ownerCalls++; await ownerGate.promise; return null; },
    updateSessionAgentStatus: async () => true,
  } as unknown as SyncService);
  h.setResumeInner(async () => { innerCalls++; await innerGate.promise; return true; });
  const resume = () => h.autoResumeSession(sessionId, "", {}, undefined, "conv", "claude", { userInitiated: true });
  const first = resume(), second = resume();
  try {
    expect(h.resumeInFlight.has(sessionId)).toBe(true);
    await waitFor(() => ownerCalls > 0, { timeoutMs: 1000 });
    expect(ownerCalls).toBe(1);
    ownerGate.resolve();
    await waitFor(() => innerCalls > 0, { timeoutMs: 1000 });
    expect(innerCalls).toBe(1);
  } finally { ownerGate.resolve(); innerGate.resolve(); }
  expect(await Promise.all([first, second])).toEqual([true, true]);
});

test("old resume finally cannot delete a newer reservation or clear its park", async () => {
  const sessionId = id(), oldGate = defer(), newGate = defer();
  let calls = 0;
  h.setResumeInner(async () => { const n = ++calls; await (n === 1 ? oldGate.promise : newGate.promise); return true; });
  const resume = () => h.autoResumeSession(sessionId, "", {}, undefined, undefined, "claude", { userInitiated: true });
  const old = resume();
  await waitFor(() => calls === 1, { timeoutMs: 1000 });
  h.resumeInFlight.delete(sessionId);
  h.resumeInFlightStarted.delete(sessionId);
  const newer = resume();
  await waitFor(() => calls === 2, { timeoutMs: 1000 });
  const reservation = h.resumeInFlight.get(sessionId);
  try {
    oldGate.resolve();
    expect(await old).toBe(true);
    expect(h.resumeInFlight.get(sessionId)).toBe(reservation);
    expect(h.resumeInFlightStarted.has(sessionId)).toBe(true);
    expect(h.pendingHibernationStamps.has(sessionId)).toBe(false);
    const waiter = resume();
    await Promise.resolve();
    expect(calls).toBe(2);
    newGate.resolve();
    expect(await Promise.all([newer, waiter])).toEqual([true, true]);
    expect(h.resumeInFlight.has(sessionId)).toBe(false);
  } finally { oldGate.resolve(); newGate.resolve(); await Promise.all([old, newer]); }
});

test("fresh claims retain old valid lifetime evidence beyond the cached routing cutoff", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e1-fix2-claims-"));
  const now = Date.now() / 1000;
  try {
    const claim = path.join(root, "new-session.json");
    fs.writeFileSync(claim, JSON.stringify({ pid: 4242, ts: now - 3 * 86400, term: "tmux" }));
    const old = new Date((now - 4 * 86400) * 1000); fs.utimesSync(claim, old, old);
    const claims = await h.freshClaims(4242, root);
    expect(claims).toHaveLength(1);
    expect(processDeclaredSessionId({ argvId: "launch-session", claims: claims!, processStartSec: now - 5 * 86400 })).toBe("new-session");
    fs.writeFileSync(claim, "{");
    expect(await h.freshClaims(4242, root)).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("actual hook dispatcher gates expected stops before publishing status or completion", () => {
  const source = fs.readFileSync(path.join(import.meta.dir, "daemon.ts"), "utf8");
  const start = source.indexOf("  function handleStatusData(");
  const end = source.indexOf("  function handleStatusFile(", start);
  const body = source.slice(start, end);
  expect(body).toContain("deferHibernationHookStop(sessionId, data.status, () => handleStatusData");
  expect(body).toContain("publishHookStatus(syncService, convId, sessionId, data, statusChanged");
  expect(body.indexOf("deferHibernationHookStop")).toBeLessThan(body.indexOf("lastHookStatus.set"));
  expect(body).not.toContain("markSessionCompleted(");
});

test("acknowledgment deadlines settle every caller without releasing the transport ordering barrier", async () => {
  const sessionId = id(), gate = defer();
  const writes: string[] = [];
  const first = h.serializeSessionStatus(sessionId, async () => { writes.push("park"); await gate.promise; return true; }, "stamp", undefined, 20);
  await Promise.resolve();
  const next = h.serializeSessionStatus(sessionId, async () => { writes.push("wake"); return true; }, "stamp", undefined, 20);
  try {
    expect(await Promise.all([first, next])).toEqual([false, false]);
    expect(writes).toEqual(["park"]);
    expect(h.sessionStatusQueues.get(sessionId)?.stamp).toBeDefined();
    expect(h.sessionStatusWrites.has(sessionId)).toBe(true);
  } finally { gate.resolve(); }
  await h.sessionStatusWrites.get(sessionId);
  expect(writes).toEqual(["park", "wake"]);
  expect(h.sessionStatusQueues.has(sessionId)).toBe(false);
});
