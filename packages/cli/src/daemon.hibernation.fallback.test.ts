import { describe, expect, test } from "bun:test";
import type { AgentStatus } from "@codecast/shared/contracts";
import type { HibernationPassIo } from "./daemon.js";
import { createHibernationHarness } from "./test-helpers/hibernationHarness.js";

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

const unavailable = { result: "skipped_parking-safety-unavailable", error: "not parked: parking-safety-unavailable" };
const nonLogEffects = (h: ReturnType<typeof createHibernationHarness>) => h.effects.filter((effect) => effect.kind !== "log");

describe("parking fallback executes production bodies without daemon initialization", () => {
  for (const lifecycle of ["unavailable", "unknown", "optimistic"] as const) {
    for (const ownership of ["unknown", "borrowed", "owned"] as const) {
      test(`manual and enabled automatic refuse ${lifecycle} lifecycle / ${ownership} ownership`, async () => {
        const { h, io, calls } = fixture();
        const before = h.sessionParkStateForTests("session");
        if (lifecycle === "unavailable") io.lifecycle = async () => { calls.push("lifecycle"); return null; };
        if (lifecycle === "unknown") io.lifecycle = async () => { calls.push("lifecycle"); throw new Error("unavailable evidence"); };
        io.canReapPidTree = () => { calls.push("ownership"); return ownership === "owned"; };
        expect(await h.hibernateSessionNow("session", "conversation", io)).toEqual(unavailable);
        expect(await h.runHibernationPass(io)).toBe(0);
        expect(calls).toEqual([]);
        expect(h.sessionParkStateForTests("session")).toEqual(before);
        expect(nonLogEffects(h)).toEqual([]);
      });
    }
  }

  test("manual refusal is independent of both automatic defaults", async () => {
    const { h, io, calls } = fixture();
    io.policy = () => ({ maxLive: 0, idleMs: 0, maxPerPass: 5 });
    expect(await h.hibernateSessionNow("session", undefined, io)).toEqual(unavailable);
    expect(calls).toEqual([]);
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

  test("concurrent commands and passes all refuse without creating a park reservation", async () => {
    const { h, io, calls } = fixture();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => i % 2
      ? h.hibernateSessionNow("session", undefined, io)
      : h.runHibernationPass(io)));
    expect(results.filter((r) => r === 0)).toHaveLength(10);
    expect(results.filter((r) => typeof r === "object")).toEqual(Array(10).fill(unavailable));
    expect(h.state.resumeInFlight.size).toBe(0);
    expect(calls).toEqual([]);
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
      expect(h.sessionParkStateForTests("session")).toEqual({ parked: false, beating: true, paneTracked: true, status });
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
