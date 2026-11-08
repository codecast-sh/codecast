// The daemon's own turn-claim wiring (makeTurnClaimRecovery and the pane time
// rule), lifted out of daemon.ts and driven with the real ledger and pass, as
// daemon.heartbeat-health.test.ts does for the heartbeat. What it proves: a live
// pane is never resumed and costs no server lookup; a pane that died with the
// machine is resumed once, through the shared revive queue; a process the table
// still finds (a cc-resume-* copy) is never resumed beside; a message already
// waiting holds the continue back; an SDK host's pid decides for SDK sessions;
// and giving up cancels the continue still queued.

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authorizesTeardown, verdictFromProbe } from "@codecast/shared/contracts";
import { functionBlock } from "./test-helpers/sourceRegion.js";
import { TurnClaimLedger, TurnClaimRecovery, awaitingResume, MAX_TURN_RESUME_ATTEMPTS } from "./turnClaims.js";
import { recentRevives, stationHandsFirst } from "./midWorkRevive.js";

const source = fs.readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  ["paneStaleEnough", "staleSessionLivenessVerdict", "staleSessionVerdictFromProbe", "makeTurnClaimRecovery"]
    .map((name) => functionBlock(source, name).text.replace(/^export /, ""))
    .join("\n"),
);

const MIN = 60_000;
const BOOTED_AT = Date.now() - 60 * MIN;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

type World = ReturnType<typeof world>;
function world(over: { sdk?: "live" | "exited"; process?: boolean; pending?: boolean; interrupted?: boolean; offline?: boolean; statusAt?: number; openedAt?: number; continueOutcome?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-claims-wiring-"));
  dirs.push(dir);
  // The ledger's clock is when the claim was opened; the pass judges it now.
  const ledger = new TurnClaimLedger(path.join(dir, "claims.json"), () => over.openedAt ?? Date.now());
  const calls: string[] = [];
  const lastHookStatus = new Map<string, { ts: number }>();
  if (over.statusAt !== undefined) lastHookStatus.set("sess", { ts: over.statusAt / 1000 });
  const deps = {
    TurnClaimRecovery,
    turnClaims: () => ledger,
    log: () => {},
    admitRevive: () => true,
    stationHandSessions: async () => new Set<string>(),
    stationHandsFirst,
    claudeSdkBackend: over.sdk ? { owns: () => true, hostVerdict: async () => over.sdk } : null,
    lastHookStatus,
    recentRevives,
    priorRevives: () => [],
    REVIVE_LEDGER_FILE: path.join(dir, "revives.json"),
    awaitingResume,
    pendingMessageOutcome: async () => over.continueOutcome ?? "open",
    resumeInFlight: new Map(),
    restartingSessionIds: new Map(),
    WATCHDOG_IDLE_STALE_MS: 10 * MIN,
    WATCHDOG_ACTIVE_STALE_MS: 30 * MIN,
    MACHINE_BOOTED_AT: BOOTED_AT,
    observedDeadPanes: new Set<string>(),
    findReapTranscript: () => null,
    lastSignOfLifeMs: async () => 0,
    verdictFromProbe,
    authorizesTeardown,
    findSessionProcess: async () => { calls.push("probe"); return over.process ? { pid: 42 } : null; },
    detectSessionAgentType: () => "claude",
    deadSessionFacts: async () => {
      calls.push("lifecycle");
      return { lifecycle: over.offline ? undefined : { hideStateKnown: true, hasPendingMessages: !!over.pending }, transcript: null, interruptedByUser: !!over.interrupted, limitParked: false, turnFailed: false, lastLifeAt: 0 };
    },
    ownedByAnotherDevice: (info: { ownerDeviceId?: string } | null) => !!info && info.ownerDeviceId !== "here",
    queueRevive: async () => { calls.push("queue"); return "msg-1"; },
    forgetStatusFile: () => {},
    markDeadSessionCompleted: () => calls.push("completed"),
    sendAgentStatus: (_s: unknown, _c: string, _id: string, status: string) => calls.push(`status:${status}`),
    logConvexFailure: () => {},
  };
  const syncService = {
    getConversationOwnerInfo: async () => { calls.push("owner"); return { ownerDeviceId: "here" }; },
    setSessionError: async (_c: string, message: string) => { calls.push(`error:${message.slice(0, 20)}`); },
    cancelPendingMessage: async (id: string) => { calls.push(`cancel:${id}`); },
  };
  const make = new Function(...Object.keys(deps), `${code}; return makeTurnClaimRecovery;`)(...Object.values(deps));
  const recovery = make(syncService) as TurnClaimRecovery;
  return { ledger, recovery, calls, deps };
}

const claim = (w: World, at: number) => w.ledger.apply("sess", "conv", "working", { at });

test("a live pane mid-turn is never resumed and costs no server lookup", async () => {
  const w = world({ statusAt: Date.now() - MIN });
  claim(w, Date.now() - MIN);
  await w.recovery.request();
  expect(w.calls).toEqual([]);
  expect(w.ledger.get("sess")?.attempts).toBe(0);
});

test("a pane that died with the machine is resumed once through the revive queue", async () => {
  const w = world({ statusAt: BOOTED_AT - MIN });
  claim(w, BOOTED_AT - MIN);
  await w.recovery.request();
  expect(w.calls).toEqual(["probe", "lifecycle", "owner", "queue"]);
  expect(w.ledger.get("sess")).toMatchObject({ attempts: 1, continueId: "msg-1" });
  await w.recovery.request(); // its continue is still queued: no second one
  expect(w.calls.filter((c) => c === "queue")).toHaveLength(1);
});

test("a process the table still finds (a cc-resume copy) is never resumed beside", async () => {
  const w = world({ statusAt: BOOTED_AT - MIN, process: true });
  claim(w, BOOTED_AT - MIN);
  await w.recovery.request();
  expect(w.calls).toEqual(["probe"]);
});

test("a pane the heartbeat saw disappear skips the time rule but still asks the process table", async () => {
  const w = world({ statusAt: Date.now() - MIN });
  claim(w, Date.now() - MIN);
  w.deps.observedDeadPanes.add("sess");
  await w.recovery.request();
  expect(w.calls).toEqual(["probe", "lifecycle", "owner", "queue"]);
});

test("a message already waiting for the session holds the continue back", async () => {
  const w = world({ statusAt: BOOTED_AT - MIN, pending: true });
  claim(w, BOOTED_AT - MIN);
  await w.recovery.request();
  expect(w.calls).toEqual(["probe", "lifecycle", "owner"]);
  expect(w.ledger.get("sess")?.attempts).toBe(0);
});

test("an SDK session is decided by its host's pid, with no pane time rule", async () => {
  const live = world({ sdk: "live", statusAt: Date.now() - MIN });
  claim(live, Date.now() - MIN);
  await live.recovery.request();
  expect(live.calls).toEqual([]);
  const dead = world({ sdk: "exited", statusAt: Date.now() - MIN });
  claim(dead, Date.now() - MIN);
  await dead.recovery.request();
  expect(dead.calls).toEqual(["lifecycle", "owner", "queue"]);
});

test("a turn interrupted days before its pane died is completed quietly, not failed as died mid-turn", async () => {
  const twoDaysAgo = Date.now() - 48 * 60 * MIN;
  const w = world({ statusAt: twoDaysAgo, interrupted: true, openedAt: twoDaysAgo });
  claim(w, twoDaysAgo);
  await w.recovery.request();
  expect(w.calls).toContain("completed");
  expect(w.calls.some((c) => c.startsWith("error:"))).toBe(false);
  expect(w.calls).not.toContain("queue");
});

// The resumed pane never came up and delivery gave the continue up: the
// server still flags the conversation as having a pending message (the stalled
// continue itself), which must not hold the next attempt back.
test("a stalled continue lets the next attempt go, though the conversation still flags it pending", async () => {
  const w = world({ statusAt: BOOTED_AT - MIN, pending: true, continueOutcome: "stalled" });
  claim(w, BOOTED_AT - MIN);
  w.ledger.beginAttempt("sess", Date.now() - 31 * MIN);
  w.ledger.setContinue("sess", "msg-1");
  await w.recovery.request();
  expect(w.calls).toContain("queue");
  // The stalled one is withdrawn, or the server would put it back once the session is up again.
  expect(w.calls).toContain("cancel:msg-1");
  expect(w.calls.indexOf("cancel:msg-1")).toBeLessThan(w.calls.indexOf("queue"));
  expect(w.ledger.get("sess")).toMatchObject({ attempts: 2 });
});

// A reboot with the network still down: the lookups fail, which is no answer.
test("a dead pane whose lookups fail is kept for the next pass, never completed", async () => {
  const w = world({ statusAt: BOOTED_AT - MIN, offline: true });
  claim(w, BOOTED_AT - MIN);
  await w.recovery.request();
  expect(w.calls).not.toContain("completed");
  expect(w.calls).not.toContain("queue");
  expect(w.ledger.get("sess")).toBeDefined();
});

test("giving up cancels the continue still queued and says why on the session", async () => {
  const w = world({ statusAt: BOOTED_AT - MIN });
  claim(w, BOOTED_AT - MIN);
  for (let i = 0; i < MAX_TURN_RESUME_ATTEMPTS; i++) {
    w.ledger.beginAttempt("sess", Date.now() - 31 * MIN);
    w.ledger.setContinue("sess", "msg-old");
    w.ledger.apply("sess", "conv", "idle", { sessionBoundary: true, at: Date.now() }); // it came up, then died
  }
  await w.recovery.request();
  expect(w.calls).toContain("cancel:msg-old");
  expect(w.calls.some((c) => c.startsWith("error:Codecast restarted"))).toBe(true);
  expect(w.calls).toContain("status:stopped");
  expect(w.ledger.get("sess")).toBeUndefined();
});

// Wiring no behavioural test above reaches, pinned at its source.
test("the status sink, teardown, the CC-FLEET restart and the warm pool keep their claim wiring", () => {
  const sink = functionBlock(source, "handleStatusData").text;
  // Applied before the idle settle re-enters asynchronously (boot ordering).
  expect(sink.indexOf("turnClaims().apply(")).toBeGreaterThan(-1);
  expect(sink.indexOf("turnClaims().apply(")).toBeLessThan(sink.indexOf("primeOpenTaskScan(transcript"));
  expect(sink).toContain("turnEnded: !!data.turn_completed_at");
  const teardown = functionBlock(source, "teardownConversationBackendsLive").text;
  expect(teardown).toContain("if (!opts.keepTurnClaims) turnClaims().releaseConversation(conversationId);");
  expect(source).toMatch(/\[CC-FLEET\][\s\S]{0,400}keepTurnClaims: true/);
  expect(functionBlock(source, "prewarmRecentlyActiveSessions").text).toContain("if (turnClaims().get(sessionId)) continue;");
  expect(functionBlock(source, "handleDeadSession").text).toContain("observedDeadPanes.add(sessionId)");
});
