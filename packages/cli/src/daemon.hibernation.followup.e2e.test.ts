import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  clearHibernationPark, flushHibernationStamps, hibernateSessionNow,
  hibernationConcurrencyForTests as internals, inspectHibernationTarget,
  noteSubagentActivity, publishHookStatus, resetSubagentActivityForTests,
  runHibernationPass, sessionParkStateForTests, acquireSessionProcessOwnership, setSyncServiceForTests,
  trackSessionPaneForTests, type HibernationPassIo,
} from "./daemon.js";
import { buildShimScript } from "./test-helpers/fakeClaudeShim.js";
import { spawnHarness, waitFor, type Harness } from "./test-helpers/messagingHarness.js";
import { descendantPids, snapshotProcessTableAsync } from "./processTable.js";
import { hasTmux, tmuxRun, tmuxRunAsync } from "./tmux.js";
import type { SyncService } from "./syncService.js";
import type { AgentStatus } from "@codecast/shared/contracts";

const harnesses: Harness[] = [];
const roots: string[] = [];
const children: ChildProcess[] = [];
const life = { status: "active", source: "lifecycle" as const, hideStateKnown: true, inboxPinnedAt: null, hasPendingMessages: false };
const alive = (h: Harness) => tmuxRun(["has-session", "-t", `=${h.tmuxSession}`]).status === 0;
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function terminal(args: string[]) {
  const result = await tmuxRunAsync(args, { timeout: 3000 });
  if (result.status !== 0) throw new Error(result.stderr);
  return result;
}
async function fixture() {
  const id = crypto.randomUUID();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e1-fix2-pane-")); roots.push(root);
  const registry = path.join(root, "registry"); fs.mkdirSync(registry);
  const script = path.join(root, "claude");
  fs.writeFileSync(script, buildShimScript({ sessionId: id }), { mode: 0o755 });
  const h = spawnHarness({ sessionId: id, tmuxPrefix: `cc-e1-fix2-${process.pid}`, command: `exec '${script}' --session-id ${id}` }); harnesses.push(h);
  await waitFor(() => h.paneHasPrompt(), { timeoutMs: 5000 });
  trackSessionPaneForTests(id, h.tmuxSession, { status: "idle" });
  const pid = Number(tmuxRun(["display-message", "-p", "-t", `=${h.tmuxSession}:`, "#{pane_pid}"]).stdout.trim());
  const conv = `conv-${id}`;
  const writes: unknown[][] = [];
  const completed: string[] = [];
  const sync = {
    updateSessionAgentStatus: async (...args: unknown[]) => { writes.push(args); return true; },
    markSessionCompleted: async (id: string) => { completed.push(id); },
  } as unknown as SyncService;
  setSyncServiceForTests(sync);
  const io: Partial<HibernationPassIo> = {
    policy: () => ({ maxLive: 0, idleMs: 1, maxPerPass: 5 }),
    awakeIdleMs: () => 10000,
    conversationIds: () => ({ [id]: conv }),
    lifecycle: async () => life,
    inspectTarget: (id, name, conv) => inspectHibernationTarget(id, name, conv, registry),
  };
  const claim = (sessionId: string, ts = Date.now() / 1000) => {
    fs.writeFileSync(path.join(registry, `${sessionId}.json`), JSON.stringify({ pid, ts, term: "tmux" }));
  };
  const hook = (status: AgentStatus) => publishHookStatus(sync, conv, id, { status, ts: Date.now() / 1000 }, true);
  return { id, h, pid, conv, io, registry, claim, hook, writes, completed };
}
afterEach(async () => {
  internals.setResumeInner(null);
  setSyncServiceForTests(null);
  for (const child of children.splice(0)) {
    if (child.exitCode === null) { const ended = new Promise<void>(r => child.once("exit", () => r())); child.kill("SIGKILL"); await ended; }
  }
  for (const h of harnesses.splice(0)) { trackSessionPaneForTests(h.sessionId, null); h.tearDown(); }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  resetSubagentActivityForTests();
  await flushHibernationStamps();
});

for (const mode of ["pass", "manual"] as const) describe.skipIf(!hasTmux())(`${mode} E1 follow-up real panes`, () => {
  const run = (f: Awaited<ReturnType<typeof fixture>>) => mode === "pass" ? runHibernationPass(f.io) : hibernateSessionNow(f.id, undefined, f.io);
  async function refused(f: Awaited<ReturnType<typeof fixture>>) {
    const result = await run(f);
    expect(mode === "pass" ? result === 0 : (result as { result: string }).result.startsWith("skipped_")).toBe(true);
    expect(alive(f.h)).toBe(true);
    expect(f.writes).toEqual([]);
    expect(sessionParkStateForTests(f.id)).toMatchObject({ parked: false, paneTracked: true, beating: true });
  }
  async function parked(f: Awaited<ReturnType<typeof fixture>>) {
    const result = await run(f);
    expect(mode === "pass" ? result : (result as { result: string }).result).toBe(mode === "pass" ? 1 : "hibernated");
    expect(alive(f.h)).toBe(false);
    expect(sessionParkStateForTests(f.id)).toMatchObject({ parked: true, paneTracked: false, beating: true, status: "hibernated" });
    await flushHibernationStamps();
    expect(f.writes.map(w => w[1])).toEqual(["hibernated"]);
  }
  for (const phase of ["initial", "final-capture"] as const) test(`current claim B overrides launch A at ${phase}`, async () => {
    const f = await fixture();
    f.claim(f.id);
    expect(await acquireSessionProcessOwnership(f.id)).toBe("owned");
    expect(await inspectHibernationTarget(f.id, f.h.tmuxSession, f.conv, f.registry), JSON.stringify({ pid: f.pid, claims: await internals.freshClaims(f.pid, f.registry) })).not.toBeNull();
    const foreign = crypto.randomUUID();
    const change = () => {
      f.claim(foreign, Date.now() / 1000 + 1);
      const old = new Date(Date.now() - 5 * 86400_000);
      fs.utimesSync(path.join(f.registry, `${foreign}.json`), old, old);
    };
    let changed = false;
    if (phase === "initial") change();
    else f.io.terminal = async args => { const result = await terminal(args); if (args[0] === "capture-pane") { change(); changed = true; } return result; };
    await refused(f);
    if (phase === "final-capture") expect(changed).toBe(true);
  }, 15000);

  for (const evidence of ["missing", "unreadable", "malformed"] as const) test(`refuses ${evidence} current registry evidence`, async () => {
    const f = await fixture();
    if (evidence === "missing") fs.rmdirSync(f.registry);
    if (evidence === "unreadable") fs.mkdirSync(path.join(f.registry, "unreadable.json"));
    if (evidence === "malformed") fs.writeFileSync(path.join(f.registry, "partial.json"), "{");
    await refused(f);
  }, 15000);

  for (const evidence of ["old-overflow", "recent-overflow", "already-full", "cold-files", "cold-history", "cold-unreadable", "cold-malformed"] as const) test(`preserves a parent with detached live sidecar and ${evidence}`, async () => {
    const f = await fixture();
    const child = spawn("/bin/sleep", ["120"], { detached: true, stdio: "ignore" }); children.push(child);
    expect(descendantPids(await snapshotProcessTableAsync(), f.pid)).not.toContain(child.pid!);
    const childPath = `/fake/${f.id}/subagents/sidecar.jsonl`;
    if (evidence === "old-overflow" || evidence === "recent-overflow") {
      noteSubagentActivity(childPath, Date.now() - (evidence === "old-overflow" ? 3600_000 : 0));
      await refused(f);
    }
    if (evidence.includes("overflow") || evidence === "already-full") {
      for (let i = 0; i < 1000; i++) noteSubagentActivity(`/fake/parent-${i}/subagents/child.jsonl`);
      if (evidence === "already-full") noteSubagentActivity(childPath);
      expect(internals.subagentActivityByParent.size).toBeLessThanOrEqual(500);
    } else {
      resetSubagentActivityForTests();
      if (evidence === "cold-files" || evidence === "cold-unreadable") {
        const parentDir = path.join(path.dirname(f.h.jsonlPath), f.id); roots.push(parentDir);
        fs.mkdirSync(parentDir, { recursive: true });
        if (evidence === "cold-unreadable") fs.writeFileSync(path.join(parentDir, "subagents"), "not a directory");
        else {
          fs.mkdirSync(path.join(parentDir, "subagents"));
          fs.writeFileSync(path.join(parentDir, "subagents", "sidecar.jsonl"), "{}\n");
        }
      } else if (evidence === "cold-malformed") fs.appendFileSync(f.h.jsonlPath, "{\n");
      else fs.appendFileSync(f.h.jsonlPath, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Agent", id: "sidecar" }] } }) + "\n");
    }
    await refused(f);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
  }, 15000);

  test("a genuine leaf with cold empty evidence still parks", async () => { await parked(await fixture()); }, 15000);

  for (const phase of ["committing", "delayed"] as const) test(`expected SessionEnd/stopped ${phase} does not cancel park or complete`, async () => {
    const f = await fixture();
    let dispatched = false;
    if (phase === "committing") f.io.terminal = async args => {
      const result = await terminal(args);
      if (args[0] === "if-shell" && result.stdout.trim() === "parked") { f.hook("stopped"); dispatched = true; }
      return result;
    };
    await parked(f);
    if (phase === "delayed") { f.hook("stopped"); dispatched = true; }
    expect(dispatched).toBe(true);
    expect(f.completed).toEqual([]);
    expect(sessionParkStateForTests(f.id)).toMatchObject({ parked: true, paneTracked: false, status: "hibernated" });
    clearHibernationPark(f.id, f.conv);
    await flushHibernationStamps();
    f.hook("stopped");
    expect(f.completed).toEqual([f.conv]);
    expect(sessionParkStateForTests(f.id).status).toBe("stopped");
  }, 15000);

  test("a refused guarded kill replays the deferred real stop", async () => {
    const f = await fixture();
    f.io.terminal = async args => {
      if (args[0] === "if-shell") { f.hook("stopped"); return { stdout: "refused" }; }
      return terminal(args);
    };
    const result = await run(f);
    expect(mode === "pass" ? result === 0 : (result as { result: string }).result.startsWith("skipped_")).toBe(true);
    expect(alive(f.h)).toBe(true);
    expect(f.completed).toEqual([f.conv]);
    expect(sessionParkStateForTests(f.id)).toMatchObject({ parked: false, paneTracked: true, status: "stopped" });
  }, 15000);

  test("resume during a successful kill consumes the expected stop without completing", async () => {
    const f = await fixture();
    const entered = defer(), commit = defer();
    let calls = 0;
    internals.setResumeInner(async () => { calls++; return true; });
    f.io.terminal = async args => {
      if (args[0] !== "if-shell") return terminal(args);
      entered.resolve();
      await commit.promise;
      const result = await terminal(args);
      f.hook("stopped");
      return result;
    };
    const park = run(f);
    await Promise.race([entered.promise, park.then(result => { throw new Error(`Commit not reached: ${JSON.stringify(result)}`); })]);
    const wake = internals.autoResumeSession(f.id, "", {}, undefined, undefined, "claude", { userInitiated: true });
    try {
      await waitFor(() => internals.hibernationInFlight.get(f.id)?.cancelled === true, { timeoutMs: 1000 });
      expect(calls).toBe(0);
      expect(internals.tmuxTargetLocks.has(f.h.tmuxSession)).toBe(true);
    } finally { commit.resolve(); await park; await wake; }
    expect(calls).toBe(1);
    expect(alive(f.h)).toBe(false);
    expect(f.completed).toEqual([]);
    expect(f.writes.some(w => w[1] === "stopped" || w[1] === "hibernated")).toBe(false);
    expect(sessionParkStateForTests(f.id)).toMatchObject({ parked: false, paneTracked: false });
    f.hook("stopped");
    expect(f.completed).toEqual([f.conv]);
  }, 15000);

  test("acknowledged kill consumes its stop even when post-kill inspection fails", async () => {
    const f = await fixture();
    let killed = false;
    f.io.terminal = async args => {
      if (killed && args[0] === "list-panes" && args[1] === "-a") throw new Error("post-kill inspection unavailable");
      const result = await terminal(args);
      if (args[0] === "if-shell" && result.stdout.trim() === "parked") { killed = true; f.hook("stopped"); }
      return result;
    };
    const result = await run(f);
    expect(mode === "pass" ? result === 0 : (result as { result: string }).result.startsWith("skipped_")).toBe(true);
    expect(killed).toBe(true);
    expect(alive(f.h)).toBe(false);
    f.hook("stopped");
    expect(f.completed).toEqual([]);
    expect(f.writes).toEqual([]);
    expect(sessionParkStateForTests(f.id)).toMatchObject({ parked: false, paneTracked: false });
    clearHibernationPark(f.id, f.conv);
    await flushHibernationStamps();
    f.hook("stopped");
    expect(f.completed).toEqual([f.conv]);
  }, 15000);

  for (const status of ["working", "waiting", "permission_blocked", "stopped"] as const) test(`actual ${status} before kill preserves the pane`, async () => {
    const f = await fixture();
    let killCalls = 0;
    let dispatched = false;
    f.io.terminal = async args => {
      if (args[0] === "if-shell") killCalls++;
      const result = await terminal(args);
      if (args[0] === "capture-pane") { f.hook(status); dispatched = true; }
      return result;
    };
    const result = await run(f);
    expect(mode === "pass" ? result === 0 : (result as { result: string }).result.startsWith("skipped_")).toBe(true);
    expect(dispatched).toBe(true);
    expect(killCalls).toBe(0);
    expect(alive(f.h)).toBe(true);
    expect(sessionParkStateForTests(f.id).parked).toBe(false);
  }, 15000);
});

test.skipIf(!hasTmux())("two resume callers waiting for cancelled parking share one inner operation", async () => {
  const f = await fixture();
  const arrived = defer(), parkGate = defer(), resumeGate = defer();
  let calls = 0;
  internals.setResumeInner(async () => { calls++; await resumeGate.promise; return true; });
  f.io.lifecycle = async () => { arrived.resolve(); await parkGate.promise; return life; };
  const park = hibernateSessionNow(f.id, undefined, f.io);
  await arrived.promise;
  const parking = internals.hibernationInFlight.get(f.id)!;
  const first = internals.autoResumeSession(f.id, "", {}, undefined, undefined, "claude", { userInitiated: true });
  const second = internals.autoResumeSession(f.id, "", {}, undefined, undefined, "claude", { userInitiated: true });
  try {
    await waitFor(() => calls > 0, { timeoutMs: 1000 });
    expect(parking.cancelled).toBe(true);
    expect(calls).toBe(1);
    parkGate.resolve();
    expect((await park).result).toStartWith("skipped_");
    await waitFor(() => calls > 0, { timeoutMs: 1000 });
    expect(calls).toBe(1);
    expect(alive(f.h)).toBe(true);
  } finally {
    parkGate.resolve(); resumeGate.resolve();
    expect(await Promise.all([first, second])).toEqual([true, true]);
  }
}, 15000);

for (const trigger of ["resume", "deadline", "injection"] as const) test.skipIf(!hasTmux())(`hung lifecycle loses authority after ${trigger} and its late response cannot park`, async () => {
  const f = await fixture();
  const arrived = defer(), evidence = defer();
  let calls = 0;
  internals.setResumeInner(async () => { calls++; return true; });
  f.io.attemptTimeoutMs = trigger === "deadline" ? 40 : 5000;
  f.io.lifecycle = async () => { arrived.resolve(); await evidence.promise; return life; };
  const park = hibernateSessionNow(f.id, undefined, f.io);
  await arrived.promise;
  const parking = internals.hibernationInFlight.get(f.id)!;
  let wake: Promise<unknown> | undefined;
  try {
    if (trigger === "resume") wake = internals.autoResumeSession(f.id, "", {}, undefined, undefined, "claude", { userInitiated: true });
    if (trigger === "injection") {
      const { injectViaTmux } = await import("./daemon.js");
      wake = injectViaTmux(f.h.tmuxSession + ":0.0", "e1-cancelled-park-injection", "claude");
    }
    expect((await park).result).toBe("skipped_evidence-cancelled");
    expect(internals.hibernationInFlight.has(f.id)).toBe(false);
    expect(internals.tmuxTargetLocks.get(f.h.tmuxSession)).not.toBe(parking.done);
    if (wake) await wake;
    if (trigger === "resume") expect(calls).toBe(1);
    if (trigger === "injection") expect(fs.readFileSync(f.h.jsonlPath, "utf8")).toContain("e1-cancelled-park-injection");
    expect(alive(f.h)).toBe(true);
    expect(f.writes.some(w => typeof w[6] === "number")).toBe(false);
    const oldWork = internals.hibernationEvidenceJobs.get(f.id);
    expect(oldWork).toBeDefined();
    evidence.resolve();
    await oldWork;
    expect(alive(f.h)).toBe(true);
    expect(sessionParkStateForTests(f.id)).toMatchObject({ parked: false, paneTracked: true });
    expect(f.writes.some(w => w[1] === "hibernated")).toBe(false);
    expect(internals.hibernationEvidenceJobs.has(f.id)).toBe(false);
    expect(internals.tmuxTargetLocks.has(f.h.tmuxSession)).toBe(false);
  } finally { evidence.resolve(); await park; if (wake) await wake; }
}, 15000);


test.skipIf(!hasTmux())("outer resume clears the expected-exit guard before a later genuine stop", async () => {
  const f = await fixture();
  expect(await hibernateSessionNow(f.id, undefined, f.io)).toEqual({ result: "hibernated" });
  f.hook("stopped");
  expect(f.completed).toEqual([]);
  internals.setResumeInner(async () => true);
  expect(await internals.autoResumeSession(f.id, "", {}, undefined, undefined, "claude", { userInitiated: true })).toBe(true);
  f.hook("stopped");
  expect(f.completed).toEqual([f.conv]);
  expect(sessionParkStateForTests(f.id)).toMatchObject({ parked: false, status: "stopped" });
}, 15000);
