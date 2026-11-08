// Moving a session between tmux and the SDK: the order of steps with stub
// deps, then both directions against real SDK hosts running the replaying
// fake claude (testing/fakeClaude.ts).

import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { ClaudeSdkBackend, type ClaudeSdkBackendDeps } from "./backend.js";
import { backendSwitchHeld, cancelBackendSwitch, switchClaudeBackend, type BackendSwitchDeps } from "./switchBackend.js";
import type { ClaudeBackend } from "./select.js";
import { fakeWorld, until, type FakeWorld } from "./testing/harness.js";
import type { SdkActivity } from "./protocol.js";

function stubDeps(over: Partial<BackendSwitchDeps> & { from?: ClaudeBackend; statuses?: string[] } = {}) {
  const steps: string[] = [];
  const statuses = [...(over.statuses ?? ["idle"])];
  let backend: ClaudeBackend = over.from ?? "tmux";
  const deps: BackendSwitchDeps = {
    current: () => backend,
    busy: async () => {
      const st = statuses.length > 1 ? statuses.shift()! : statuses[0];
      return st === "idle" ? null : st;
    },
    sdkRefusal: async () => null,
    interrupt: async () => { steps.push("interrupt"); },
    settleResumes: async () => { steps.push("settle resumes"); },
    stop: async () => { steps.push(`stop ${backend}`); },
    startSdk: async () => { steps.push("start sdk"); backend = "sdk"; },
    startTmux: async () => { steps.push("start tmux"); backend = "tmux"; return true; },
    requeue: async () => { steps.push("requeue"); },
    log: () => {},
    sleep: async () => {},
    settleMs: 1_000,
    ...over,
  };
  return { deps, steps };
}

describe("switchClaudeBackend", () => {
  test("an idle tmux session stops its pane, then resumes in an SDK host", async () => {
    const { deps, steps } = stubDeps();
    expect(await switchClaudeBackend(deps, { target: "sdk", interrupt: false, holdKeys: ["conv1"] })).toEqual({ ok: true, backend: "sdk" });
    expect(steps).toEqual(["settle resumes", "stop tmux", "start sdk", "requeue"]);
  });

  test("an idle SDK session stops its host, then resumes in a pane", async () => {
    const { deps, steps } = stubDeps({ from: "sdk" });
    expect(await switchClaudeBackend(deps, { target: "tmux", interrupt: false, holdKeys: ["conv1"] })).toEqual({ ok: true, backend: "tmux" });
    expect(steps).toEqual(["settle resumes", "stop sdk", "start tmux", "requeue"]);
  });

  test("a running turn is refused without consent and touches nothing", async () => {
    const { deps, steps } = stubDeps({ statuses: ["working"] });
    const out = await switchClaudeBackend(deps, { target: "sdk", interrupt: false, holdKeys: ["conv1"] });
    expect(out).toMatchObject({ ok: false, reason: "busy" });
    expect(steps).toEqual([]);
  });

  test("with consent the turn is interrupted and the switch waits for it to settle", async () => {
    const { deps, steps } = stubDeps({ statuses: ["working", "working", "working", "idle"] });
    expect(await switchClaudeBackend(deps, { target: "sdk", interrupt: true, holdKeys: ["conv1"] })).toEqual({ ok: true, backend: "sdk" });
    expect(steps).toEqual(["interrupt", "settle resumes", "stop tmux", "start sdk", "requeue"]);
  });

  test("a refusal (an old Claude) is reported before the pane stops", async () => {
    const { deps, steps } = stubDeps({ sdkRefusal: async () => "Claude Code 2.0.1 is older than 2.1.248" });
    const out = await switchClaudeBackend(deps, { target: "sdk", interrupt: true, holdKeys: ["conv1"] });
    expect(out).toEqual({ ok: false, reason: "refused", message: "Stays in the terminal: Claude Code 2.0.1 is older than 2.1.248" });
    expect(steps).toEqual([]);
  });

  test("an SDK host that does not come up resumes the session in tmux and says why", async () => {
    const { deps, steps } = stubDeps({ startSdk: async () => { steps.push("start sdk"); throw new Error("Claude Code did not finish starting"); } });
    const out = await switchClaudeBackend(deps, { target: "sdk", interrupt: false, holdKeys: ["conv1"] });
    expect(out).toEqual({ ok: true, backend: "tmux", fellBack: "Claude Code did not finish starting" });
    expect(steps).toEqual(["settle resumes", "stop tmux", "start sdk", "start tmux", "requeue"]);
  });

  test("while a switch runs the session is held: a second switch is refused and resumes can ask", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const seen: boolean[] = [];
    const { deps } = stubDeps({ stop: async () => { seen.push(backendSwitchHeld("sess1"), backendSwitchHeld(undefined, "conv1")); await gate; } });
    const first = switchClaudeBackend(deps, { target: "sdk", interrupt: false, holdKeys: ["conv1", "sess1"] });
    await new Promise((r) => setTimeout(r, 10));
    expect(await switchClaudeBackend(stubDeps({ from: "sdk" }).deps, { target: "tmux", interrupt: false, holdKeys: ["conv1", "sess1"] }))
      .toEqual({ ok: false, reason: "busy", message: "This session is already switching" });
    release();
    expect(await first).toEqual({ ok: true, backend: "sdk" });
    expect(seen).toEqual([true, true]);
    expect(backendSwitchHeld("conv1", "sess1")).toBe(false);
  });

  test("messages go back to pending only once the new backend runs the session, even when it fails", async () => {
    const { deps, steps } = stubDeps({ startTmux: async () => { steps.push("start tmux"); return false; } });
    const out = await switchClaudeBackend({ ...deps, current: () => "sdk" }, { target: "tmux", interrupt: false, holdKeys: ["conv1"] });
    expect(out).toMatchObject({ ok: false, reason: "failed" });
    expect(steps.at(-1)).toBe("requeue");
    expect(backendSwitchHeld("conv1")).toBe(false);
  });

  test("a session already on the target is left alone", async () => {
    const { deps, steps } = stubDeps({ from: "sdk" });
    expect(await switchClaudeBackend(deps, { target: "sdk", interrupt: false, holdKeys: ["conv1"] })).toEqual({ ok: true, backend: "sdk", already: true });
    expect(steps).toEqual([]);
  });
});

// ── Real hosts ────────────────────────────────────────────────────────────────

const castArgv = [process.execPath, path.join(import.meta.dir, "..", "main.ts")];
const worlds: FakeWorld[] = [];
const backends: ClaudeSdkBackend[] = [];
afterEach(async () => {
  for (const b of backends.splice(0)) for (const c of b.conversations()) await b.stop(c, { forget: true });
  for (const w of worlds.splice(0)) w.cleanup();
});

function realBackend(world: FakeWorld, over: Partial<ClaudeSdkBackendDeps> = {}) {
  const activity: SdkActivity[] = [];
  const deps: ClaudeSdkBackendDeps = {
    log: (l) => { if (process.env.DEBUG_SDK) console.log(`[dbg] ${l}`); },
    castArgv: () => castArgv,
    shellPrefix: () => "",
    activity: (_c, _s, a) => activity.push(a),
    permission: async () => null,
    turnError: () => {},
    stopped: () => {},
    tooOld: () => {},
    sessionChanged: () => {},
    transcriptHas: async () => false,
    mayResume: async () => true,
    resumeAccount: async (_c, saved) => saved,
    resumeModelEffort: () => ({ model: [], effort: [] }),
    transcriptExists: () => true,
    ...over,
  };
  const backend = new ClaudeSdkBackend(deps, world.hostDir, { noLaunchd: true, startTimeoutMs: 240_000, initTimeoutMs: 240_000 });
  backends.push(backend);
  return { backend, activity };
}

const T = 600_000;

describe("switching against real SDK hosts", () => {
  test("tmux to SDK resumes the same session id with the model the transcript last ran", async () => {
    const world = fakeWorld(["resume"]);
    worlds.push(world);
    const { backend, activity } = realBackend(world, { resumeModelEffort: () => ({ model: ["--model", "opus"], effort: [] }) });
    const sessionId = world.spec().sessionId;
    let paneStopped = false;
    const out = await switchClaudeBackend({
      current: () => (backend.owns("conv1") ? "sdk" : "tmux"),
      busy: async () => null,
      sdkRefusal: async () => null,
      interrupt: async () => {},
      settleResumes: async () => {},
      requeue: async () => {},
      stop: async () => { paneStopped = true; },
      // What the daemon's startSdk does: a start of the existing session, which resumes it.
      startSdk: async () => { await backend.start("conv1", world.spec({ resume: true })); },
      startTmux: async () => { throw new Error("must not fall back"); },
      log: () => {},
    }, { target: "sdk", interrupt: false, holdKeys: ["conv1"] });
    expect(out).toEqual({ ok: true, backend: "sdk" });
    expect(paneStopped).toBe(true);
    expect(backend.sessionFor("conv1")).toBe(sessionId);
    const spawn = world.fakeLog().find((l) => l.startsWith("spawn "))!;
    expect(spawn).toContain(`session=${sessionId}`);
    expect(spawn).toContain(`--resume=${sessionId}`);
    expect(spawn).toContain("--model=opus");
    await backend.deliver("conv1", "m1", "continue");
    await until(() => activity.some((a) => a.turnCompletedAt), 240_000, "resumed turn end");
  }, T);

  test("SDK to tmux stops the host, drops the binding, and only then starts the pane", async () => {
    const world = fakeWorld(["text"]);
    worlds.push(world);
    const { backend } = realBackend(world);
    await backend.start("conv1", world.spec());
    const { readHostState } = await import("./client.js");
    const pid = readHostState(world.spec().sessionId, world.hostDir)!.pid;
    let ownedAtPaneStart = null as boolean | null;
    let hostAliveAtPaneStart = null as boolean | null;
    const out = await switchClaudeBackend({
      current: () => (backend.owns("conv1") ? "sdk" : "tmux"),
      busy: async () => null,
      sdkRefusal: async () => null,
      interrupt: async () => {},
      settleResumes: async () => {},
      requeue: async () => {},
      stop: async () => { await backend.stop("conv1", { forget: true }); },
      startSdk: async () => {},
      startTmux: async () => {
        ownedAtPaneStart = backend.owns("conv1");
        try { process.kill(pid, 0); hostAliveAtPaneStart = true; } catch { hostAliveAtPaneStart = false; }
        return true;
      },
      log: () => {},
    }, { target: "tmux", interrupt: false, holdKeys: ["conv1"] });
    expect(out).toEqual({ ok: true, backend: "tmux" });
    expect(ownedAtPaneStart).toBe(false);
    expect(hostAliveAtPaneStart).toBe(false);
  }, T);
});

describe("a kill or a park during a switch", () => {
  test("a kill while the old backend stops: nothing starts and nothing is put back to pending", async () => {
    const { deps, steps } = stubDeps({ stop: async () => { steps.push("stop"); void cancelBackendSwitch("conv9"); } });
    const out = await switchClaudeBackend(deps, { target: "sdk", interrupt: false, holdKeys: ["conv9"] });
    expect(out).toEqual({ ok: false, reason: "failed", message: "The session was stopped during the switch" });
    expect(steps).toEqual(["settle resumes", "stop"]);
    expect(backendSwitchHeld("conv9")).toBe(false);
  });

  test("a kill while the new backend comes up: it is stopped again", async () => {
    const { deps, steps } = stubDeps({ startSdk: async () => { steps.push("start sdk"); void cancelBackendSwitch(undefined, "sess9"); } });
    const out = await switchClaudeBackend(deps, { target: "sdk", interrupt: false, holdKeys: ["conv9", "sess9"] });
    expect(out).toMatchObject({ ok: false, reason: "failed" });
    expect(steps).toEqual(["settle resumes", "stop tmux", "start sdk", "stop tmux"]);
  });

  test("a kill waits for the switch it cancelled to let go, so a resume right behind it is not refused", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { deps } = stubDeps({ stop: async () => { await gate; } });
    const switching = switchClaudeBackend(deps, { target: "sdk", interrupt: false, holdKeys: ["conv11"] });
    await new Promise((r) => setTimeout(r, 5));
    let killDone = false;
    const kill = cancelBackendSwitch("conv11").then(() => { killDone = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(killDone).toBe(false);
    release();
    await kill;
    expect(backendSwitchHeld("conv11")).toBe(false);
    expect(await switching).toMatchObject({ ok: false, message: "The session was stopped during the switch" });
  });

  test("cancelling a session nobody is switching is a no-op for its next switch", async () => {
    await cancelBackendSwitch("conv10");
    const { deps } = stubDeps();
    expect(await switchClaudeBackend(deps, { target: "sdk", interrupt: false, holdKeys: ["conv10"] })).toEqual({ ok: true, backend: "sdk" });
  });
});
