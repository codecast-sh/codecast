import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { execFileAsync } from "./proc.js";
import { isTmuxSessionMissingError, runTmux, tmuxRun } from "./tmux.js";
import { spawnHarness } from "./test-helpers/messagingHarness.js";
import { functionBlock } from "./test-helpers/sourceRegion.js";

const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  ["heartbeatHealthCheck", "handleDeadSession"].map(name => functionBlock(source, name).text).join("\n"),
);
const transient = [
  ["timeout", Object.assign(new Error("tmux probe timed out"), { code: "ETIMEDOUT", killed: true, signal: "SIGKILL" })],
  ["killed probe with partial stderr", { code: 1, killed: true, stderr: "can't find session: live" }],
  ["signalled probe", { code: null, signal: "SIGKILL", stderr: "" }],
  ["spawn contention", { code: "EAGAIN", stderr: "" }],
  ["missing binary", { code: "ENOENT", stderr: "" }],
  ["permission failure", { code: 1, stderr: "error connecting to /tmp/tmux (Permission denied)" }],
  ["lost connection", { code: 1, stderr: "lost server" }],
  ["unstructured failure", new Error("tmux probe failed")],
] as const;

function harness(probeError?: unknown, realTarget?: string, probe?: (args: string[], opts?: { timeout?: number }) => Promise<unknown>, claimed = false) {
  const sessionId = "heartbeat-test";
  const target = realTarget ?? "heartbeat-test-pane";
  const events: string[] = [];
  const resumeSessionCache = new Map([[sessionId, target]]);
  const deps = {
    isTmuxSessionMissingError,
    isSupersededInPass: () => false,
    swapHeld: () => false,
    resumeSessionCache,
    resumeInFlight: new Set<string>(),
    expectedHibernationExits: new Set<string>(),
    restartingSessionIds: new Map<string, number>(),
    RESTART_GUARD_TTL_MS: 30_000,
    tmuxExec: async (args: string[], opts?: { timeout?: number }) => {
      if (args[0] === "has-session" && probe) return probe(args, opts);
      if (args[0] === "has-session" && probeError !== undefined) throw probeError;
      if (args[0] === "kill-session") events.push("kill");
      return realTarget ? tmuxRun(args) : { stdout: "", stderr: "" };
    },
    log: () => {},
    launchTokenLedger: () => ({ retirePane: () => events.push("retire") }),
    stopCodexPermissionPoller: () => events.push("stop-poller"),
    stopManagedSessionHeartbeat: () => events.push("stop-heartbeat"),
    forgetHibernationPark: () => events.push("forget-park"),
    readConversationCache: () => ({}),
    syncServiceRef: null,
    workflowAgentTranscriptPathFor: async () => null,
    clearConversationDeliveryAndResumeState: async () => events.push("clear-delivery"),
    repairAndResumeSession: async () => { events.push("repair"); return true; },
    readTitleCache: () => ({}),
    turnClaims: () => ({ get: (id: string) => (claimed && id === sessionId ? { sessionId } : undefined) }),
    observedDeadPanes: new Set<string>(),
    requestTurnClaimRecovery: async () => { events.push("claim-pass"); },
  };
  const check = new Function(...Object.keys(deps), `${code}; return heartbeatHealthCheck;`)(...Object.values(deps)) as (id: string) => Promise<void>;
  return { check: () => check(sessionId), events, resumeSessionCache, sessionId, deps };
}

describe("heartbeat uncertainty preserves the session", () => {
  test.each(transient)("%s does not kill, forget, or rewrite the session", async (_name, error) => {
    const h = harness(error);
    await h.check();
    expect(h.events).toEqual([]);
    expect(h.resumeSessionCache.has(h.sessionId)).toBe(true);
  });

  test("a successful health probe leaves the session alone", async () => {
    const h = harness();
    await h.check();
    expect(h.events).toEqual([]);
  });

  test.each([
    "can't find session: gone",
    "no such session: gone",
    "session not found: gone",
    "no current target", // tmux 3.6 on a running server with no sessions
    "no server running on /tmp/tmux-501/default",
    "error connecting to /tmp/tmux-501/default (No such file or directory)",
  ])("confirmed absence still recovers: %s", async stderr => {
    const h = harness(Object.assign(new Error("tmux probe failed"), { code: 1, stderr }));
    await h.check();
    expect(h.events).toContain("repair");
    expect(h.resumeSessionCache.has(h.sessionId)).toBe(false);
  });

  // A pane that died mid-turn is continued by its turn claim (turnClaims.ts):
  // a restart here would land it idle at its prompt and lose the turn.
  test("a pane that died mid-turn hands its claim to the recovery pass instead of restarting idle", async () => {
    const h = harness({ code: 1, stderr: "can't find session: gone" }, undefined, undefined, true);
    await h.check();
    expect(h.events).toContain("claim-pass");
    expect(h.events).not.toContain("repair");
    expect(h.deps.observedDeadPanes.has(h.sessionId)).toBe(true);
  });

  test("in-flight recovery skips the probe", async () => {
    const h = harness({ code: 1, stderr: "can't find session: gone" });
    h.deps.resumeInFlight.add(h.sessionId);
    await h.check();
    expect(h.events).toEqual([]);
  });
});

describe("authoritative tmux absence", () => {
  test.each(transient)("%s is not absence", (_name, error) => {
    expect(isTmuxSessionMissingError(error)).toBe(false);
  });

  test("worker exit status and stderr prove absence", () => {
    expect(isTmuxSessionMissingError({ status: 1, stderr: "can't find session: gone" })).toBe(true);
  });
});

afterAll(killIsolatedTmuxServer);

// The probe the daemon's tmuxExec makes: routed to the session's own tmux
// server (tmuxRoute.ts). A bare `tmux` call reaches the default server, which
// holds neither session and answers "no current target" at once.
function routedProbe(args: string[], opts?: { timeout?: number }) {
  return runTmux(args, process.env, (argv) => execFileAsync("tmux", argv, { timeout: opts?.timeout, killSignal: "SIGKILL", env: { ...process.env } }), (rs) => rs[0]!);
}

test.skipIf(!Bun.which("tmux"))("a timed-out health check preserves a real live terminal", async () => {
  const pane = spawnHarness({ command: "exec sleep 600" });
  try {
    expect(tmuxRun(["has-session", "-t", pane.tmuxSession]).status).toBe(0);
    const h = harness(transient[0][1], pane.tmuxSession);
    await h.check();
    expect(tmuxRun(["has-session", "-t", pane.tmuxSession]).status).toBe(0);
    expect(h.events).toEqual([]);
    expect(h.resumeSessionCache.has(h.sessionId)).toBe(true);
  } finally {
    pane.tearDown();
  }
}, 60_000);

test.skipIf(!Bun.which("tmux"))("an actual tmux timeout preserves the live pane after its server responds again", async () => {
  const pane = spawnHarness({ command: "exec sleep 600" });
  const serverPid = Number(tmuxRun(["display-message", "-p", "-t", pane.tmuxSession, "#{pid}"]).stdout.trim());
  let paused = false;
  let failure: { killed?: boolean; signal?: string } | undefined;
  try {
    expect(serverPid).toBeGreaterThan(0);
    process.kill(serverPid, "SIGSTOP");
    paused = true;
    const h = harness(undefined, pane.tmuxSession, (args, opts) =>
      routedProbe(args, opts)
        .catch(error => { failure = error; throw error; })
        .finally(() => { process.kill(serverPid, "SIGCONT"); paused = false; }),
    );
    await h.check();
    expect(failure?.killed || failure?.signal === "SIGKILL").toBe(true);
    expect(tmuxRun(["has-session", "-t", pane.tmuxSession]).status).toBe(0);
    expect(h.events).toEqual([]);
    expect(h.resumeSessionCache.has(h.sessionId)).toBe(true);
  } finally {
    if (paused) process.kill(serverPid, "SIGCONT");
    pane.tearDown();
  }
}, 60_000);

test.skipIf(!Bun.which("tmux"))("an actual missing-session response still triggers recovery", async () => {
  const pane = spawnHarness({ command: "exec sleep 600" });
  try {
    const h = harness(undefined, `${pane.tmuxSession}-missing`, routedProbe);
    await h.check();
    expect(h.events).toContain("repair");
    expect(h.resumeSessionCache.has(h.sessionId)).toBe(false);
    expect(tmuxRun(["has-session", "-t", pane.tmuxSession]).status).toBe(0);
  } finally {
    pane.tearDown();
  }
}, 60_000);
