import { describe, expect, test } from "bun:test";
import type { AgentStatus } from "@codecast/shared/contracts";
import type { HibernationPassIo } from "./daemon.js";
import { createHibernationHarness } from "./test-helpers/hibernationHarness.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { functionBlock } from "./test-helpers/sourceRegion.js";
import { resolveAgentPid } from "./daemon.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const h = createHibernationHarness();
  const calls: string[] = [];
  h.trackSessionPaneForTests("session", "pane", { status: "idle" });
  const io: HibernationPassIo = {
    policy: () => ({ maxLive: 1, idleMs: 1, maxPerPass: 5 }),
    tmuxSessions: async () => new Map([["pane", 0]]),
    terminal: async () => ({ stdout: "" }),
    inspectTarget: async () => null,
    awakeIdleMs: () => 100_000,
    subagentActiveAgoMs: () => Infinity,
    conversationIds: () => ({ session: "conversation" }),
    askSidecarMtimeMs: async () => { calls.push("sidecar"); return null; },
    transcriptLastRealMs: async () => { calls.push("transcript"); return null; },
    lifecycle: async () => {
      calls.push("lifecycle");
      return { status: "active", hideStateKnown: true, source: "lifecycle", inboxPinnedAt: null, hasPendingMessages: false, inboxKilledAt: null, inboxDismissedAt: null, inboxStashedAt: null };
    },
    canReapPidTree: () => { calls.push("ownership"); return true; },
    deliveryActive: (id) => h.state.resumeInFlight.has(id),
    park: async () => { calls.push("park"); return true; },
    now: () => 1_000_000,
  };
  return { h, io, calls };
}

const unavailable = { result: "skipped_target-unverified", error: "not parked: target-unverified" };
const nonLogEffects = (h: ReturnType<typeof createHibernationHarness>) => h.effects.filter((effect) => effect.kind !== "log");

describe("parking fallback executes production bodies without daemon initialization", () => {
  for (const lifecycle of ["unavailable", "unknown", "optimistic"] as const) {
    for (const ownership of ["unknown", "borrowed", "owned"] as const) {
      test(`manual and enabled automatic refuse ${lifecycle} lifecycle / ${ownership} ownership`, async () => {
        const { h, io, calls } = fixture();
        const before = h.sessionParkStateForTests("session");
        if (lifecycle === "unavailable") io.lifecycle = async () => { calls.push("lifecycle"); return null; };
        if (lifecycle === "unknown") io.lifecycle = async () => { calls.push("lifecycle"); throw new Error("unavailable evidence"); };
        if (lifecycle === "optimistic") io.lifecycle = async () => { calls.push("lifecycle"); return { status: "active", hideStateKnown: false, source: "status" } as any; };
        io.canReapPidTree = () => { calls.push("ownership"); return ownership === "owned"; };
        const reason = lifecycle === "unavailable" ? "lifecycle-unknown" : lifecycle === "unknown" ? "evidence-unavailable" : "lifecycle-degraded";
        expect(await h.hibernateSessionNow("session", "conversation", io)).toEqual({ result: `skipped_${reason}`, error: `not parked: ${reason}` });
        expect(await h.runHibernationPass(io)).toBe(0);
        expect(calls).toEqual(["sidecar", "lifecycle", "sidecar", "lifecycle"]);
        expect(h.sessionParkStateForTests("session")).toEqual(before);
        expect(nonLogEffects(h)).toEqual([]);
      });
    }
  }

  test("manual refusal is independent of both automatic defaults", async () => {
    const { h, io, calls } = fixture();
    io.policy = () => ({ maxLive: 0, idleMs: 0, maxPerPass: 5 });
    expect(await h.hibernateSessionNow("session", undefined, io)).toEqual(unavailable);
    expect(calls).toEqual(["sidecar", "lifecycle", "ownership"]);
    expect(nonLogEffects(h)).toEqual([]);
  });

  for (const mode of ["manual", "automatic"] as const) {
    test(`${mode} delayed listing cannot cancel a new resume reservation or working status`, async () => {
      const { h, io, calls } = fixture();
      const listing = deferred<Map<string, number>>();
      io.tmuxSessions = () => listing.promise;
      const result = mode === "manual" ? h.hibernateSessionNow("session", undefined, io) : h.runHibernationPass(io);
      const resume = deferred<boolean>();
      h.state.resumeInFlight.set("session", resume.promise);
      h.state.lastSentAgentStatus.set("session", "working");
      listing.resolve(new Map([["pane", 0]]));
      if (mode === "manual") expect(await result).toMatchObject({ result: "skipped_status-working" });
      else expect(await result).toBe(0);
      expect(h.state.resumeInFlight.get("session")).toBe(resume.promise);
      expect(h.sessionParkStateForTests("session")).toEqual({ parked: false, beating: true, paneTracked: true, status: "working" });
      expect(calls).toEqual([]);
      expect(nonLogEffects(h)).toEqual([]);
      resume.resolve(true);
      expect(await resume.promise).toBe(true);
    });
  }

  test("concurrent commands and passes release their reservations after refusing unverified targets", async () => {
    const { h, io, calls } = fixture();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => i % 2
      ? h.hibernateSessionNow("session", undefined, io)
      : h.runHibernationPass(io)));
    expect(results.filter((r) => r === 0)).toHaveLength(10);
    expect(results.filter((r) => typeof r === "object").every((r) => r.result?.startsWith("skipped_"))).toBe(true);
    expect(h.state.resumeInFlight.size).toBe(0);
    expect(h.state.tmuxTargetLocks.size).toBe(0);
    expect(calls).not.toContain("park");
    expect(nonLogEffects(h)).toEqual([]);
  });

  test("direct parkAs refuses before capture, kill ACK, tracking, heartbeat, or status writes", async () => {
    const { h } = fixture();
    const before = h.sessionParkStateForTests("session");
    expect(await h.reapOneTerminal("session", "pane", "conversation", 12, { parkAs: "hibernated" })).toBe(false);
    expect(h.sessionParkStateForTests("session")).toEqual(before);
    expect(h.effects).toEqual([]);
  });

  test("refused park cannot emit a late write after a healthy wake and injection", async () => {
    const { h, io } = fixture();
    const listing = deferred<Map<string, number>>();
    io.tmuxSessions = () => listing.promise;
    const refusal = h.hibernateSessionNow("session", undefined, io);
    const writes: unknown[][] = [];
    const sync = { updateSessionAgentStatus: async (...args: unknown[]) => { writes.push(args); } };
    h.sendAgentStatus(sync, "conversation", "session", "working", 300);
    await h.injectViaTmux("pane:0.0", "continue", "claude");
    listing.resolve(new Map([["pane", 0]]));
    expect(await refusal).toMatchObject({ result: "skipped_status-working" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[1]).toBe("working");
    expect(writes[0]?.[6]).toBeUndefined();
    expect(h.state.lastSentAgentStatus.get("session")).toBe("working");
    expect(h.state.tmuxTargetLocks.size).toBe(0);
    expect(nonLogEffects(h)).toEqual([{ kind: "inject", args: ["pane:0.0", "continue", "claude"] }]);
  });

  test("healthy working, resuming and background statuses retain their diagnosis and tracking", async () => {
    const diagnoses = { working: "status-working", resuming: "status-resuming", waiting: "open-background-work" };
    for (const [status, reason] of Object.entries(diagnoses)) {
      const { h, io } = fixture();
      h.trackSessionPaneForTests("session", "pane", { status: status as AgentStatus });
      expect(await h.hibernateSessionNow("session", undefined, io)).toMatchObject({ result: `skipped_${reason}` });
      expect(h.sessionParkStateForTests("session")).toEqual({ parked: false, beating: true, paneTracked: true, status: status as AgentStatus });
      expect(nonLogEffects(h)).toEqual([]);
    }
  });

  test("already parked requires an existing local mark; absence alone is not proof", async () => {
    const { h, io } = fixture();
    io.tmuxSessions = async () => new Map();
    expect(await h.hibernateSessionNow("session", undefined, io)).toMatchObject({ result: "skipped_no-live-pane" });
    h.trackSessionPaneForTests("session", "pane", { parked: true, status: "hibernated" });
    expect(await h.hibernateSessionNow("session", undefined, io)).toEqual({ result: "already_parked" });
    expect(nonLogEffects(h)).toEqual([]);
  });
});

// Turning hibernation on means reading what it would do to a real fleet before
// it does anything. The preview must run the gates and reach no kill.
describe("dry run reports without parking", () => {
  const target = { session: "$1", pane: "%1", pid: 4242, start: "Thu Sep 18 00:00:00 2026", stamp: "session", conversationStamp: "conversation" };
  const logs = (h: ReturnType<typeof createHibernationHarness>) =>
    h.effects.filter((e) => e.kind === "log").map((e) => String(e.args[0] ?? "")).join("\n");

  test("a session that passes every gate is named, and nothing is killed", async () => {
    const { h, io, calls } = fixture();
    io.policy = () => ({ maxLive: 1, idleMs: 1, maxPerPass: 5, dryRun: true });
    io.inspectTarget = async () => target;
    expect(await h.runHibernationPass(io)).toBe(0);
    expect(calls).not.toContain("park");
    expect(nonLogEffects(h)).toEqual([]);
    expect(logs(h)).toContain("hibernation DRY RUN");
    expect(logs(h)).toContain("would park 1");
    expect(logs(h)).toContain("session@");
  });

  test("a refusal is reported as the skip it would be, and still parks nothing", async () => {
    const { h, io, calls } = fixture();
    io.policy = () => ({ maxLive: 1, idleMs: 1, maxPerPass: 5, dryRun: true });
    io.inspectTarget = async () => target;
    io.lifecycle = async () => ({ status: "active", hideStateKnown: true, source: "lifecycle", inboxPinnedAt: null, hasPendingMessages: true, inboxKilledAt: null, inboxDismissedAt: null, inboxStashedAt: null });
    expect(await h.runHibernationPass(io)).toBe(0);
    expect(calls).not.toContain("park");
    expect(logs(h)).toContain("would park 0");
    expect(logs(h)).toContain("pending-messages");
  });

  test("a target it cannot verify is not counted as parkable", async () => {
    const { h, io } = fixture();
    io.policy = () => ({ maxLive: 1, idleMs: 1, maxPerPass: 5, dryRun: true });
    io.inspectTarget = async () => null;
    expect(await h.runHibernationPass(io)).toBe(0);
    expect(logs(h)).toContain("would park 0");
    expect(logs(h)).toContain("target-unverified");
  });
});

// refuseTarget records a reason and returns null so a refusal reads as one
// expression. In a function that answers a BOOLEAN, `return !refuseTarget(...)`
// is `return true` — it turns every refusal into an approval. Nothing in the
// type system catches it, so the shape is banned outright.
test("a recorded refusal never reads as an approval", () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "daemon.ts"), "utf8");
  expect(src).not.toContain("!refuseTarget(");
  const clear = functionBlock(src, "hibernationChildHistoryIsClear").text;
  expect(clear).toContain("refuseTarget(");
  // Every refusal inside the boolean gate says false in the same statement.
  for (const line of clear.split("\n").filter((l) => l.includes("refuseTarget("))) {
    expect(line, line.trim()).toContain("return false;");
  }
});

// The pane process is not always the agent: the daemon starts an agent inside a
// login shell, so tmux's pane_pid is that shell. On 2026-09-18 all 69 agent
// panes on this machine had that shape, and reading the pane process alone
// refused every one as "argv-session-mismatch", so nothing could ever park.
describe("finding the agent inside its pane", () => {
  const SID = "f4147e5a-bebc-41cc-b6fa-6f8fa6435b09";
  const row = (pid: number, ppid: number, command: string) => ({ pid, ppid, command, uid: 501 } as any);
  const shell = row(75564, 1, "-bash");
  const agent = row(75706, 75564, `/Users/ashot/.codecast/bin/claude --permission-mode bypassPermissions --session-id ${SID} --model fable`);

  test("the agent under a shell is found", () => {
    expect(resolveAgentPid([shell, agent], 75564, "-bash", SID)).toBe(75706);
  });

  test("a pane that exec'd the agent still answers itself", () => {
    expect(resolveAgentPid([agent], 75706, agent.command, SID)).toBe(75706);
  });

  test("a pane running anything besides the agent refuses", () => {
    const extra = row(80000, 75564, "vim notes.md");
    expect(resolveAgentPid([shell, agent, extra], 75564, "-bash", SID)).toBeNull();
    // A lone child that is not an agent is not one either.
    expect(resolveAgentPid([shell, extra], 75564, "-bash", SID)).toBeNull();
    // An empty shell has nothing to park.
    expect(resolveAgentPid([shell], 75564, "-bash", SID)).toBeNull();
  });

  test("another session's agent in the pane is never adopted", () => {
    const other = row(75706, 75564, "/Users/ashot/.codecast/bin/claude --session-id 11111111-2222-3333-4444-555555555555");
    expect(resolveAgentPid([shell, other], 75564, "-bash", SID)).toBeNull();
  });
});
