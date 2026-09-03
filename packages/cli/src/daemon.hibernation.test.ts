// The hibernation pass wiring: which facts it gathers, which gates it applies,
// and what it hands to the teardown. The verdict itself is tested in
// hibernation.test.ts; this is about the three gates too expensive to run
// fleet-wide, and about the pass never parking a session the policy did not
// pick.
//
// Every dependency comes through the injected io (the TmuxSubmitVerifyIO
// pattern from daemon.inject-submit-verify.test.ts), so no tmux, no Convex and
// no transcript is needed here.

import { afterEach, describe, expect, test } from "bun:test";
import { runHibernationPass, trackSessionPaneForTests, type HibernationPassIo } from "./daemon.js";
import type { ConversationLifecycle } from "./syncService.js";

const HOUR = 3600_000;

type Fixture = {
  io: HibernationPassIo;
  parked: string[];
  sessions: string[];
};

const tracked: string[] = [];

function fixture(opts: {
  count: number;
  maxLive?: number;
  idleMs?: number;
  maxPerPass?: number;
  attached?: (i: number) => number;
  awakeIdleMs?: (i: number) => number;
  sidecarMtimeMs?: (id: string) => number | null;
  transcriptLastRealMs?: (id: string) => number | null;
  lifecycle?: (id: string) => ConversationLifecycle | null;
  canReapPidTree?: (id: string) => boolean;
}): Fixture {
  const sessions = Array.from({ length: opts.count }, (_, i) => `hib-test-${String(i).padStart(3, "0")}`);
  const tmuxOf = (id: string) => `cc-resume-${id}`;
  const conversationIds: Record<string, string> = {};
  sessions.forEach((id, i) => {
    trackSessionPaneForTests(id, tmuxOf(id));
    tracked.push(id);
    conversationIds[id] = `conv-${i}`;
  });
  const parked: string[] = [];
  const io: HibernationPassIo = {
    policy: () => ({ maxLive: opts.maxLive ?? 0, idleMs: opts.idleMs ?? 0, maxPerPass: opts.maxPerPass ?? 5 }),
    tmuxSessions: async () => {
      const m = new Map<string, number>();
      sessions.forEach((id, i) => m.set(tmuxOf(id), opts.attached ? opts.attached(i) : 0));
      return m;
    },
    awakeIdleMs: (id) => (opts.awakeIdleMs ? opts.awakeIdleMs(sessions.indexOf(id)) : 0),
    conversationIds: () => conversationIds,
    askSidecarMtimeMs: async (id) => (opts.sidecarMtimeMs ? opts.sidecarMtimeMs(id) : null),
    transcriptLastRealMs: async (id) => (opts.transcriptLastRealMs ? opts.transcriptLastRealMs(id) : null),
    lifecycle: async (_conv, id) => (opts.lifecycle ? opts.lifecycle(id) : null),
    canReapPidTree: (id) => (opts.canReapPidTree ? opts.canReapPidTree(id) : true),
    park: async (id) => { parked.push(id); },
    now: () => 1_000_000_000_000,
  };
  return { io, parked, sessions };
}

const lifecycleOf = (over: Partial<ConversationLifecycle>): ConversationLifecycle => ({
  status: "active",
  inboxKilledAt: null,
  inboxStashedAt: null,
  inboxDismissedAt: null,
  inboxPinnedAt: null,
  hideStateKnown: true,
  source: "lifecycle",
  ...over,
});

afterEach(() => {
  for (const id of tracked.splice(0)) trackSessionPaneForTests(id, null);
});

describe("runHibernationPass", () => {
  test("both knobs off parks nothing and never asks tmux", async () => {
    let asked = false;
    const f = fixture({ count: 20 });
    const io = { ...f.io, tmuxSessions: async () => { asked = true; return new Map(); } };
    expect(await runHibernationPass(io)).toBe(0);
    expect(asked).toBe(false);
  });

  test("parks exactly the sessions the policy picked, longest idle first", async () => {
    // Ten live, cap of seven: the three longest idle go.
    const f = fixture({ count: 10, maxLive: 7, awakeIdleMs: (i) => i * 1000 });
    expect(await runHibernationPass(f.io)).toBe(3);
    expect(f.parked).toEqual([f.sessions[9], f.sessions[8], f.sessions[7]]);
  });

  test("a session with no live pane is not a candidate", async () => {
    const f = fixture({ count: 4, maxLive: 1 });
    // tmux lists only the first two panes: the other two are already gone, so
    // the fleet is two sessions against a cap of one.
    const io = { ...f.io, tmuxSessions: async () => new Map([[`cc-resume-${f.sessions[0]}`, 0], [`cc-resume-${f.sessions[1]}`, 0]]) };
    expect(await runHibernationPass(io)).toBe(1);
    expect(f.parked.every((id) => id === f.sessions[0] || id === f.sessions[1])).toBe(true);
  });

  test("tmux unreachable parks nothing", async () => {
    const f = fixture({ count: 10, maxLive: 1 });
    const io = { ...f.io, tmuxSessions: async () => { throw new Error("no server"); } };
    expect(await runHibernationPass(io)).toBe(0);
    expect(f.parked).toEqual([]);
  });

  test("an attached client keeps its session live", async () => {
    const f = fixture({ count: 3, maxLive: 1, attached: (i) => (i === 2 ? 1 : 0) });
    await runHibernationPass(f.io);
    expect(f.parked).not.toContain(f.sessions[2]);
  });

  test("a pending question skips the pick", async () => {
    // The sidecar was written after the last real message: the agent is still
    // waiting on the answer.
    const f = fixture({
      count: 3,
      maxLive: 2,
      awakeIdleMs: (i) => i * 1000,
      sidecarMtimeMs: (id) => (id === "hib-test-002" ? 2000 : null),
      transcriptLastRealMs: () => 1000,
    });
    await runHibernationPass(f.io);
    expect(f.parked).toEqual([]);
  });

  test("an answered question does not skip: the sidecar predates the last message", async () => {
    const f = fixture({
      count: 3,
      maxLive: 2,
      awakeIdleMs: (i) => i * 1000,
      sidecarMtimeMs: () => 1000,
      transcriptLastRealMs: () => 2000,
    });
    await runHibernationPass(f.io);
    expect(f.parked).toEqual([f.sessions[2]]);
  });

  test("a pinned conversation skips", async () => {
    const f = fixture({
      count: 3, maxLive: 2, awakeIdleMs: (i) => i * 1000,
      lifecycle: (id) => (id === "hib-test-002" ? lifecycleOf({ inboxPinnedAt: 123 }) : lifecycleOf({})),
    });
    await runHibernationPass(f.io);
    expect(f.parked).toEqual([]);
  });

  test("undelivered messages skip", async () => {
    const f = fixture({
      count: 3, maxLive: 2, awakeIdleMs: (i) => i * 1000,
      lifecycle: (id) => (id === "hib-test-002" ? lifecycleOf({ hasPendingMessages: true }) : lifecycleOf({})),
    });
    await runHibernationPass(f.io);
    expect(f.parked).toEqual([]);
  });

  test("a null lifecycle PROCEEDS — the opposite of the reaper, on purpose", async () => {
    // Hibernation retires nothing, so an unreachable backend is not a reason to
    // keep burning a pane. stampedPaneReapEligibility fails closed because a
    // reap is permanent; this one is undone by the next message.
    const f = fixture({ count: 3, maxLive: 2, awakeIdleMs: (i) => i * 1000, lifecycle: () => null });
    expect(await runHibernationPass(f.io)).toBe(1);
  });

  test("a borrowed process skips, so a parent is never killed on a child's behalf", async () => {
    const f = fixture({
      count: 3, maxLive: 2, awakeIdleMs: (i) => i * 1000,
      canReapPidTree: (id) => id !== "hib-test-002",
    });
    await runHibernationPass(f.io);
    expect(f.parked).toEqual([]);
  });

  test("never more than maxPerPass, however far over the cap the fleet is", async () => {
    const f = fixture({ count: 40, maxLive: 1, maxPerPass: 5 });
    expect(await runHibernationPass(f.io)).toBe(5);
  });

  test("a skipped pick does not promote the next candidate in the same pass", async () => {
    // The gates run on the picks the policy made, not on a refilled list: one
    // pass parks at most what it picked, and the next pass re-picks with fresh
    // facts. This is what keeps a pass bounded when many candidates are gated.
    const f = fixture({
      count: 6, maxLive: 4, awakeIdleMs: (i) => i * 1000,
      canReapPidTree: () => false,
    });
    expect(await runHibernationPass(f.io)).toBe(0);
    expect(f.parked).toEqual([]);
  });
});
