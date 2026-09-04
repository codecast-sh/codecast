import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearHibernationPark, flushHibernationStamps, hibernateSessionNow, injectViaTmux,
  noteSubagentActivity, resetSubagentActivityForTests, runHibernationPass,
  sessionParkStateForTests, sessionProcessOwnership, setSyncServiceForTests,
  trackSessionPaneForTests, type HibernationPassIo,
} from "./daemon.js";
import { buildShimScript } from "./test-helpers/fakeClaudeShim.js";
import { spawnHarness, waitFor, type Harness } from "./test-helpers/messagingHarness.js";
import { hasTmux, tmuxRun, tmuxRunAsync } from "./tmux.js";
import type { SyncService } from "./syncService.js";

const prefix = `cc-e1-safe-${process.pid}-${crypto.randomUUID().slice(0, 6)}`;
const harnesses: Harness[] = [];
const roots: string[] = [];
const childPids: number[] = [];
const attachers: ReturnType<typeof Bun.spawn>[] = [];
const life = { status: "active", source: "lifecycle" as const, hideStateKnown: true, inboxPinnedAt: null, hasPendingMessages: false };
const alive = (h: Harness) => tmuxRun(["has-session", "-t", `=${h.tmuxSession}`]).status === 0;

async function fixture(opts: { child?: boolean; verifiable?: boolean; space?: boolean } = {}) {
  const sessionId = crypto.randomUUID();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e1-hibernate-"));
  roots.push(root);
  const script = path.join(root, "claude");
  const source = buildShimScript({ sessionId });
  fs.writeFileSync(script, opts.child ? source.replace("\nemit_meta\n", "\nsleep 120 &\necho $! > child.pid\nemit_meta\n") : source, { mode: 0o755 });
  const h = spawnHarness({ sessionId, tmuxPrefix: `${prefix}${opts.space ? " space" : ""}`, command: `exec '${script}'${opts.verifiable === false ? "" : ` --session-id ${sessionId}`}` });
  harnesses.push(h);
  await waitFor(() => h.paneHasPrompt(), { timeoutMs: 10000 });
  if (opts.child) childPids.push(Number(fs.readFileSync(path.join(h.cwd, "child.pid"), "utf8")));
  trackSessionPaneForTests(h.sessionId, h.tmuxSession, { status: "idle" });
  const stampResult = tmuxRun(["set-option", "-t", `=${h.tmuxSession}:`, "@codecast_session_id", h.sessionId]);
  expect(stampResult.status, stampResult.stderr).toBe(0);
  const conv = `conv-${sessionId}`;
  const io: Partial<HibernationPassIo> = {
    policy: () => ({ maxLive: 0, idleMs: 1, maxPerPass: 5 }),
    awakeIdleMs: () => 10000,
    conversationIds: () => ({ [h.sessionId]: conv }),
    lifecycle: async () => life,
  };
  return { h, conv, io };
}

afterEach(async () => {
  setSyncServiceForTests(null);
  for (const child of attachers.splice(0)) { child.kill(); await child.exited; }
  for (const h of harnesses.splice(0)) {
    trackSessionPaneForTests(h.sessionId, null);
    h.tearDown();
  }
  for (const pid of childPids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  resetSubagentActivityForTests();
  await flushHibernationStamps();
});

async function terminal(args: string[]) {
  const result = await tmuxRunAsync(args, { timeout: 3000 });
  if (result.status !== 0) throw new Error(`tmux failed: ${result.stderr}`);
  return result;
}

for (const mode of ["pass", "command"] as const) describe.skipIf(!hasTmux())(`${mode} preserves real adversarial panes`, () => {
  async function refused(f: Awaited<ReturnType<typeof fixture>>) {
    if (mode === "pass") expect(await runHibernationPass(f.io)).toBe(0);
    else expect((await hibernateSessionNow(f.h.sessionId, undefined, f.io)).result).toStartWith("skipped_");
    expect(alive(f.h)).toBe(true);
    expect(sessionParkStateForTests(f.h.sessionId)).toMatchObject({ parked: false, paneTracked: true, beating: true });
  }

  for (const stage of ["before", "at-kill"]) test(`attached human ${stage}`, async () => {
    const f = await fixture();
    const attach = async () => {
      const client = Bun.spawn(["tmux", "-C", "attach-session", "-t", `=${f.h.tmuxSession}`], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      attachers.push(client);
      await waitFor(() => tmuxRun(["display-message", "-p", "-t", `=${f.h.tmuxSession}:`, "#{session_attached}"]).stdout.trim() === "1", { timeoutMs: 3000 });
    };
    if (stage === "before") await attach();
    else f.io.terminal = async args => { if (args[0] === "if-shell") await attach(); return terminal(args); };
    await refused(f);
  }, 30000);

  for (const extra of ["split-window", "new-window"]) test(extra, async () => {
    const f = await fixture();
    expect(tmuxRun([extra, "-d", "-t", `=${f.h.tmuxSession}:`, "sleep", "120"]).status).toBe(0);
    await refused(f);
    expect(tmuxRun(["list-panes", "-s", "-t", `=${f.h.tmuxSession}:`, "-F", "#{pane_id}"]).stdout.trim().split("\n")).toHaveLength(2);
  }, 30000);

  test("stale A-to-B cache despite owned A transcript", async () => {
    const a = await fixture();
    const b = await fixture();
    trackSessionPaneForTests(b.h.sessionId, null);
    expect(sessionProcessOwnership(a.h.sessionId)).toBe("owned");
    trackSessionPaneForTests(a.h.sessionId, b.h.tmuxSession, { status: "idle" });
    await refused(a);
    expect(alive(b.h)).toBe(true);
  }, 30000);

  test("unverifiable unstamped process", async () => {
    const f = await fixture({ verifiable: false });
    tmuxRun(["set-option", "-u", "-t", `=${f.h.tmuxSession}:`, "@codecast_session_id"]);
    await refused(f);
  }, 30000);

  test("wrong conversation stamp", async () => {
    const f = await fixture();
    tmuxRun(["set-option", "-t", `=${f.h.tmuxSession}:`, "@codecast_conversation_id", "another-conversation"]);
    await refused(f);
  }, 30000);

  test("rejected target name retains tracking and never reports parked", async () => {
    const f = await fixture({ space: true });
    await refused(f);
  }, 30000);

  for (const recorder of ["cold", "old"]) test(`silent live child with ${recorder} recorder`, async () => {
    const f = await fixture({ child: true });
    const child = childPids.at(-1)!;
    expect(() => process.kill(child, 0)).not.toThrow();
    expect(sessionProcessOwnership(f.h.sessionId)).toBe("owned");
    if (recorder === "old") noteSubagentActivity(`/fake/${f.h.sessionId}/subagents/child.jsonl`, Date.now() - 60 * 60_000);
    await refused(f);
    expect(() => process.kill(child, 0)).not.toThrow();
  }, 30000);

  test("Codex parent with unobservable in-process children is non-parkable", async () => {
    const f = await fixture();
    fs.mkdirSync(path.join(os.homedir(), ".codex", "sessions"), { recursive: true });
    const root = fs.mkdtempSync(path.join(os.homedir(), ".codex", "sessions", "e1-safe-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, `rollout-${f.h.sessionId}.jsonl`), JSON.stringify({
      type: "session_meta", payload: { id: f.h.sessionId, cwd: f.h.cwd, source: "cli", originator: "codex_cli_rs" },
    }) + "\n");
    expect(sessionProcessOwnership(f.h.sessionId)).toBe("owned");
    await refused(f);
  }, 30000);

  test("waiting arrives while the final capture is outstanding", async () => {
    const f = await fixture();
    let captured = false;
    f.io.terminal = async args => {
      const result = await terminal(args);
      if (args[0] === "capture-pane") {
        captured = true;
        trackSessionPaneForTests(f.h.sessionId, f.h.tmuxSession, { status: "waiting" });
      }
      return result;
    };
    await refused(f);
    expect(captured).toBe(true);
  }, 30000);

  for (const change of ["second-pane", "second-window", "wrong-stamp", "respawn"]) test(`tmux atomic guard refuses ${change} after the final validation`, async () => {
    const f = await fixture();
    let injected = false;
    f.io.terminal = async args => {
      if (args[0] === "if-shell") {
        injected = true;
        if (change === "second-pane") tmuxRun(["split-window", "-d", "-t", `=${f.h.tmuxSession}:`, "sleep", "120"]);
        if (change === "second-window") tmuxRun(["new-window", "-d", "-t", `=${f.h.tmuxSession}:`, "sleep", "120"]);
        if (change === "wrong-stamp") tmuxRun(["set-option", "-t", `=${f.h.tmuxSession}:`, "@codecast_session_id", "different-session"]);
        if (change === "respawn") tmuxRun(["respawn-pane", "-k", "-t", args[3], "sleep", "120"]);
      }
      return terminal(args);
    };
    await refused(f);
    expect(injected).toBe(true);
  }, 30000);

  test("local injection cancels parking under the exact pane lock", async () => {
    const f = await fixture();
    let captured!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(r => { captured = r; });
    const gate = new Promise<void>(r => { release = r; });
    let paneId = "";
    f.io.terminal = async args => {
      const result = await terminal(args);
      if (args[0] === "capture-pane") { paneId = args[4]; captured(); await gate; }
      return result;
    };
    const park = mode === "pass" ? runHibernationPass(f.io) : hibernateSessionNow(f.h.sessionId, undefined, f.io);
    await reached;
    const injection = injectViaTmux(paneId, "e1-lock-message", "claude");
    release();
    const outcome = await park;
    expect(mode === "pass" ? outcome === 0 : (outcome as { result: string }).result.startsWith("skipped_")).toBe(true);
    await injection;
    expect(alive(f.h)).toBe(true);
    expect(fs.readFileSync(f.h.jsonlPath, "utf8")).toContain("e1-lock-message");
  }, 30000);

  test("failed kill command preserves the live pane and publishes no park", async () => {
    const f = await fixture();
    const writes: unknown[][] = [];
    setSyncServiceForTests({ updateSessionAgentStatus: async (...args: unknown[]) => { writes.push(args); return true; } } as unknown as SyncService);
    let attempted = false;
    f.io.terminal = async args => {
      if (args[0] === "if-shell") { attempted = true; throw new Error("injected tmux kill failure"); }
      return terminal(args);
    };
    await refused(f);
    expect(attempted).toBe(true);
    expect(writes).toEqual([]);
  }, 30000);
});

test.skipIf(!hasTmux())("a delayed park write is followed by the wake clear, never a later parked write", async () => {
  const f = await fixture();
  let release!: () => void;
  let persisted: number | null = null;
  const writes: unknown[][] = [];
  setSyncServiceForTests({ updateSessionAgentStatus: async (...args: unknown[]) => {
    writes.push(args);
    if (typeof args[6] === "number") await new Promise<void>(r => { release = r; });
    persisted = args[6] as number | null;
    return true;
  } } as unknown as SyncService);
  expect(await hibernateSessionNow(f.h.sessionId, undefined, f.io)).toEqual({ result: "hibernated" });
  clearHibernationPark(f.h.sessionId, f.conv);
  expect(sessionParkStateForTests(f.h.sessionId).status).toBe("connected");
  release();
  await flushHibernationStamps();
  await flushHibernationStamps();
  expect(persisted).toBeNull();
  expect(writes.map(w => w[1])).toEqual(["hibernated", "connected"]);
}, 30000);
