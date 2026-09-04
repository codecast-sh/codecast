// The hibernation wiring: which facts the pass gathers, which refusals it
// applies, and what it hands to the teardown. The verdict itself is tested in
// hibernation.test.ts; this is about the gates too expensive to run fleet-wide,
// about the pass never parking a session the policy did not pick, and about
// `cast hibernate` refusing for exactly the same reasons the pass does.
//
// Every dependency comes through the injected io (the TmuxSubmitVerifyIO
// pattern from daemon.inject-submit-verify.test.ts), so no tmux, no Convex and
// no transcript is needed here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentStatus } from "@codecast/shared/contracts";
import {
  clearHibernationPark,
  flushHibernationStamps,
  registerManagedStartedSession,
  clearSessionTrackingForKill,
  hibernateSessionNow,
  noteSubagentActivity,
  resetSubagentActivityForTests,
  runHibernationPass,
  subagentActiveAgoMs,
  sessionParkStateForTests,
  setSyncServiceForTests,
  subagentParentSessionFromPath,
  trackSessionPaneForTests,
  wakeStatusAfterPark,
  type HibernationPassIo,
} from "./daemon.js";
import { HIBERNATE_SUBAGENT_QUIET_MS, HIBERNATE_RESUME_GRACE_MS } from "./hibernation.js";
import { functionBlock } from "./test-helpers/sourceRegion.js";
import type { ConversationLifecycle } from "./syncService.js";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

const NOW = 1_000_000_000_000;

type Fixture = {
  io: HibernationPassIo;
  parked: string[];
  sessions: string[];
  /** The command path, on the same io the pass runs on. */
  hibernate(sessionId: string): Promise<{ result?: string; error?: string }>;
};

const tracked: string[] = [];

type FixtureOpts = {
  count: number;
  maxLive?: number;
  idleMs?: number;
  maxPerPass?: number;
  attached?: (i: number) => number;
  awakeIdleMs?: (i: number) => number;
  subagentActiveAgoMs?: (id: string) => number;
  sidecarMtimeMs?: (id: string) => number | null;
  transcriptLastRealMs?: (id: string) => number | null;
  lifecycle?: (id: string) => ConversationLifecycle | null;
  canReapPidTree?: (id: string) => boolean;
  deliveryActive?: (id: string) => boolean;
  /** Per-session daemon memory: the status the daemon last sent, and the resume clock. */
  facts?: (i: number) => { status?: AgentStatus; resumedAt?: number };
  /** Same tmux name for every session: a parent running a subagent in its pane. */
  onePane?: boolean;
};

function fixture(opts: FixtureOpts): Fixture {
  const sessions = Array.from({ length: opts.count }, (_, i) => `hib-test-${String(i).padStart(3, "0")}`);
  const tmuxOf = (id: string) => (opts.onePane ? "cc-resume-shared" : `cc-resume-${id}`);
  const conversationIds: Record<string, string> = {};
  sessions.forEach((id, i) => {
    trackSessionPaneForTests(id, tmuxOf(id), { status: "idle", ...(opts.facts ? opts.facts(i) : {}) });
    tracked.push(id);
    conversationIds[id] = `conv-${i}`;
  });
  const parked: string[] = [];
  const io: HibernationPassIo = {
    terminal: async () => ({ stdout: "" }),
    policy: () => ({ maxLive: opts.maxLive ?? 0, idleMs: opts.idleMs ?? 0, maxPerPass: opts.maxPerPass ?? 5 }),
    tmuxSessions: async () => {
      const m = new Map<string, number>();
      sessions.forEach((id, i) => m.set(tmuxOf(id), opts.attached ? opts.attached(i) : 0));
      return m;
    },
    awakeIdleMs: (id) => (opts.awakeIdleMs ? opts.awakeIdleMs(sessions.indexOf(id)) : 0),
    subagentActiveAgoMs: (id) => (opts.subagentActiveAgoMs ? opts.subagentActiveAgoMs(id) : Infinity),
    conversationIds: () => conversationIds,
    askSidecarMtimeMs: async (id) => (opts.sidecarMtimeMs ? opts.sidecarMtimeMs(id) : null),
    transcriptLastRealMs: async (id) => (opts.transcriptLastRealMs ? opts.transcriptLastRealMs(id) : null),
    lifecycle: async (_conv, id) => (opts.lifecycle ? opts.lifecycle(id) : lifecycleOf({})),
    canReapPidTree: (id) => (opts.canReapPidTree ? opts.canReapPidTree(id) : true),
    deliveryActive: (id) => (opts.deliveryActive ? opts.deliveryActive(id) : false),
    inspectTarget: async (id) => ({ session: "$1", pane: "%1", pid: 100, start: "start", stamp: id, conversationStamp: "" }),
    park: async (id) => { parked.push(id); return true; },
    now: () => NOW,
  };
  return { io, parked, sessions, hibernate: (id) => hibernateSessionNow(id, undefined, io) };
}

const lifecycleOf = (over: Partial<ConversationLifecycle>): ConversationLifecycle => ({
  status: "active",
  inboxKilledAt: null,
  inboxStashedAt: null,
  inboxDismissedAt: null,
  inboxPinnedAt: null,
  hideStateKnown: true,
  hasPendingMessages: false,
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

  test("an unavailable lifecycle refuses parking", async () => {
    const f = fixture({ count: 3, maxLive: 2, awakeIdleMs: (i) => i * 1000, lifecycle: () => null });
    expect(await runHibernationPass(f.io)).toBe(0);
    expect(f.parked).toEqual([]);
  });

  test("a pane that goes busy at kill time is not counted as parked", async () => {
    const f = fixture({ count: 3, maxLive: 2, awakeIdleMs: (i) => i * 1000 });
    const io = { ...f.io, park: async () => false };
    expect(await runHibernationPass(io)).toBe(0);
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

describe("cast hibernate", () => {
  test("parks the session it names, whatever the fleet size", async () => {
    // No cap and no idle bar: the pass would park nobody, and the command still
    // parks the one session a person asked for.
    const f = fixture({ count: 3 });
    expect(await runHibernationPass(f.io)).toBe(0);
    expect(await f.hibernate(f.sessions[1])).toEqual({ result: "hibernated" });
    expect(f.parked).toEqual([f.sessions[1]]);
  });

  test("a session with no known live pane is not reported parked", async () => {
    const f = fixture({ count: 1 });
    expect(await f.hibernate("nobody-here")).toEqual({ result: "skipped_no-live-pane", error: "not parked: no-live-pane" });
    expect(f.parked).toEqual([]);
  });

  test("tmux unreachable refuses rather than guessing", async () => {
    const f = fixture({ count: 2 });
    const io = { ...f.io, tmuxSessions: async () => { throw new Error("no server"); } };
    const outcome = await hibernateSessionNow(f.sessions[0], undefined, io);
    expect(outcome.result).toBeUndefined();
    expect(outcome.error).toContain("tmux");
    expect(f.parked).toEqual([]);
  });

  test("a pane that goes busy at kill time reports skipped, not parked", async () => {
    const f = fixture({ count: 2 });
    const io = { ...f.io, park: async () => false };
    expect(await hibernateSessionNow(f.sessions[0], undefined, io)).toEqual({
      result: "skipped_teardown-refused",
      error: "not parked: teardown-refused",
    });
  });
});

// The founder's standing question about this unit is whether it can ever kill a
// live running agent. Every rule that answers "no" gets a row here, and each row
// is asserted against BOTH paths: the policy pass and the explicit `cast
// hibernate`. A rule that only one path applies is the shape of the defect.
describe("a live session is refused by both the pass and the command", () => {
  type Rule = { name: string; reason: string; opts: Omit<FixtureOpts, "count"> };

  // The target is always the last session and always the longest idle, so it is
  // the pass's first pick: if the rule stopped blocking, the pass would park it.
  const target = "hib-test-002";
  const base = { count: 3, maxLive: 1, awakeIdleMs: (i: number) => i * 1000 };

  const rules: Rule[] = [
    ...(["working", "thinking", "compacting", "permission_blocked"] as const).map((status) => ({
      name: `${status}: a turn is in flight`,
      reason: "status-working",
      opts: { facts: (i: number) => (i === 2 ? { status } : {}) },
    })),
    {
      name: "waiting: the pane's process tree holds the background work",
      reason: "open-background-work",
      opts: { facts: (i: number) => (i === 2 ? { status: "waiting" as AgentStatus } : {}) },
    },
    ...(["resuming", "starting"] as const).map((status) => ({
      name: `${status}: the session is still coming up`,
      reason: "status-resuming",
      opts: { facts: (i: number) => (i === 2 ? { status } : {}) },
    })),
    {
      name: "an attached tmux client: a human is watching the pane",
      reason: "attached",
      opts: { attached: (i: number) => (i === 2 ? 1 : 0) },
    },
    {
      name: "a subagent of this session is still writing",
      reason: "live-subagents",
      opts: { subagentActiveAgoMs: (id: string) => (id === target ? HIBERNATE_SUBAGENT_QUIET_MS - 1 : Infinity) },
    },
    {
      name: "the session resumed a moment ago",
      reason: "recently-resumed",
      opts: { facts: (i: number) => (i === 2 ? { resumedAt: NOW - (HIBERNATE_RESUME_GRACE_MS - 1) } : {}) },
    },
    {
      name: "work is on its way to the session",
      reason: "in-flight-messages",
      opts: { deliveryActive: (id: string) => id === target },
    },
    {
      name: "a question is still waiting for its answer",
      reason: "pending-question",
      opts: {
        sidecarMtimeMs: (id: string) => (id === target ? 2000 : null),
        transcriptLastRealMs: () => 1000,
      },
    },
    {
      name: "the conversation is pinned",
      reason: "pinned",
      opts: { lifecycle: (id: string) => (id === target ? lifecycleOf({ inboxPinnedAt: 123 }) : lifecycleOf({})) },
    },
    {
      name: "the conversation has undelivered messages",
      reason: "pending-messages",
      opts: { lifecycle: (id: string) => (id === target ? lifecycleOf({ hasPendingMessages: true }) : lifecycleOf({})) },
    },
    {
      name: "the lifecycle answer is degraded, so the pin cannot be believed",
      reason: "lifecycle-degraded",
      opts: { lifecycle: (id: string) => (id === target ? lifecycleOf({ hideStateKnown: false }) : lifecycleOf({})) },
    },
    {
      name: "the session borrows its parent's process",
      reason: "borrowed-process",
      opts: { canReapPidTree: (id: string) => id !== target },
    },
    {
      name: "a parent running a subagent in the same pane",
      reason: "shared-pane",
      // Every session on one tmux name: killing it takes down sessions the
      // policy never picked, so no session in that pane may be parked.
      opts: { onePane: true },
    },
  ];

  for (const rule of rules) {
    test(`the pass refuses: ${rule.name}`, async () => {
      const f = fixture({ ...base, ...rule.opts });
      await runHibernationPass(f.io);
      expect(f.parked).not.toContain(target);
    });

    test(`cast hibernate refuses: ${rule.name}`, async () => {
      const f = fixture({ ...base, ...rule.opts });
      expect(await f.hibernate(target)).toEqual({
        result: `skipped_${rule.reason}`,
        error: `not parked: ${rule.reason}`,
      });
      expect(f.parked).toEqual([]);
    });
  }
});

// The "a parent with a live subagent is never parked" rule reads one recorder,
// and the rule's own tests drive that recorder through a stub. These cover the
// real one: the paths it understands, the prune that keeps it bounded, and the
// call site that feeds it.
describe("the subagent activity recorder", () => {
  const PROJ = "/Users/x/.claude/projects/-Users-x-src-app";
  const parent = "parent-session-id";

  test("both transcript layouts name the parent", () => {
    expect(subagentParentSessionFromPath(`${PROJ}/${parent}/subagents/child-1.jsonl`)).toBe(parent);
    expect(subagentParentSessionFromPath(`${PROJ}/${parent}/subagents/workflows/run-7/agent-2.jsonl`)).toBe(parent);
  });

  test("a plain session transcript names nobody", () => {
    expect(subagentParentSessionFromPath(`${PROJ}/${parent}.jsonl`)).toBeUndefined();
  });

  test("an append records the parent, and the age is measured from it", () => {
    resetSubagentActivityForTests();
    expect(subagentActiveAgoMs(parent, NOW)).toBe(Infinity);
    noteSubagentActivity(`${PROJ}/${parent}/subagents/child-1.jsonl`, NOW - 4000);
    expect(subagentActiveAgoMs(parent, NOW)).toBe(4000);
    // The later of two children is the one that keeps the parent live.
    noteSubagentActivity(`${PROJ}/${parent}/subagents/workflows/run-7/agent-2.jsonl`, NOW - 100);
    expect(subagentActiveAgoMs(parent, NOW)).toBe(100);
  });

  test("a transcript with no subagents segment records nothing", () => {
    resetSubagentActivityForTests();
    noteSubagentActivity(`${PROJ}/${parent}.jsonl`, NOW);
    expect(subagentActiveAgoMs(parent, NOW)).toBe(Infinity);
  });

  test("the map prunes parents whose children went quiet, and keeps the live ones", () => {
    // A machine that ran thousands of subagents would otherwise hold every
    // parent id for the life of the daemon.
    resetSubagentActivityForTests();
    const old = NOW - HIBERNATE_SUBAGENT_QUIET_MS * 2;
    for (let i = 0; i < 600; i++) noteSubagentActivity(`${PROJ}/old-${i}/subagents/c.jsonl`, old);
    expect(subagentActiveAgoMs("old-0", NOW)).toBe(NOW - old);
    // The next append is past the quiet window from every entry above, so the
    // size check fires and drops them.
    noteSubagentActivity(`${PROJ}/${parent}/subagents/c.jsonl`, NOW);
    expect(subagentActiveAgoMs("old-0", NOW)).toBe(Infinity);
    expect(subagentActiveAgoMs("old-599", NOW)).toBe(Infinity);
    expect(subagentActiveAgoMs(parent, NOW)).toBe(0);
    resetSubagentActivityForTests();
  });
});

// Three one-line call sites carry rules that no reachable test can fail on:
// deleting any of them leaves every test green and the rule silently gone. The
// source is the assertion, in the style of daemon.loopBudget.guard.test.ts.
describe("the wiring that has no other witness", () => {
  const src = fs.readFileSync(path.join(SRC_DIR, "daemon.ts"), "utf8");

  test("autoResumeSession clears the park", () => {
    // Without this call a parked session reports "hibernated" forever: the 30s
    // heartbeat re-asserts lastSentAgentStatus, and nothing else corrects a
    // session that has no pane. A full delivery driven wake needs Convex and a
    // real conversation, so this is what stands in for it.
    expect(functionBlock(src, "autoResumeSession").text).toContain("clearHibernationPark(");
  });

  test("registerManagedStartedSession clears the park", () => {
    // The other route by which a parked session gets a pane back: transcript
    // driven pane adoption and the warm restart scan both land here.
    expect(functionBlock(src, "registerManagedStartedSession").text).toContain("clearHibernationPark(");
  });

  test("the ingest path records subagent appends", () => {
    const body = functionBlock(src, "processSessionFile").text;
    expect(body).toContain("noteSubagentActivity(filePath)");
    expect(body).toContain("isSubagent && stats.size > lastPosition");
  });
});

// The status a wake publishes. Load bearing because the heartbeat re-sends the
// map's value every 30s: writing "hibernated" back would latch a live pane as
// parked with nothing able to correct it.
describe("wakeStatusAfterPark", () => {
  test("a stored park becomes connected", () => {
    expect(wakeStatusAfterPark("hibernated")).toBe("connected");
  });

  test("nothing stored becomes connected", () => {
    expect(wakeStatusAfterPark(undefined)).toBe("connected");
  });

  test("a status the session earned after the park is kept", () => {
    for (const status of ["working", "thinking", "waiting", "idle", "permission_blocked"] as const) {
      expect(wakeStatusAfterPark(status)).toBe(status);
    }
  });
});

// The park mark is daemon memory, and two things go wrong when it is trusted
// alone: a restart empties it, and a teardown leaves it behind.
describe("the park mark and the server stamp", async () => {
  const writes: Array<{ conversationId: string; status: string; hibernatedAt?: number | null }> = [];
  const sync = {
    updateSessionAgentStatus: async (
      conversationId: string,
      status: string,
      _clientTs?: number,
      _mode?: string,
      _tasks?: unknown,
      _presumed?: boolean,
      hibernatedAt?: number | null,
    ) => { writes.push({ conversationId, status, hibernatedAt }); return true; },
  } as unknown as import("./syncService.js").SyncService;

  const track = (id: string, facts: { status?: AgentStatus; parked?: boolean } = {}) => {
    trackSessionPaneForTests(id, `cc-resume-${id}`, facts);
    tracked.push(id);
  };

  beforeEach(() => { writes.length = 0; setSyncServiceForTests(sync); });
  afterEach(() => setSyncServiceForTests(null));

  test("a park this daemon made is cleared and logged as a wake", async () => {
    track("mark-parked", { parked: true, status: "hibernated" });
    clearHibernationPark("mark-parked", "conv-parked");
    await flushHibernationStamps();
    expect(sessionParkStateForTests("mark-parked").parked).toBe(false);
    expect(writes).toEqual([{ conversationId: "conv-parked", status: "connected", hibernatedAt: null }]);
  });

  test("the first wake after boot clears the stamp even with no local mark", async () => {
    // A restart empties the mark. The stamp on managed_sessions does not go
    // with it, and it is what tells the inbox the session is parked, so the
    // first wake has to clear it whether or not this daemon remembers parking.
    track("mark-unknown", { status: "idle" });
    clearHibernationPark("mark-unknown", "conv-unknown");
    await flushHibernationStamps();
    expect(writes).toEqual([{ conversationId: "conv-unknown", status: "idle", hibernatedAt: null }]);
  });

  test("later wakes of the same session write nothing", async () => {
    // Every message to a live session funnels through the same call, so the
    // clear must not become a Convex write per delivery.
    track("mark-repeat", { status: "idle" });
    clearHibernationPark("mark-repeat", "conv-repeat");
    await flushHibernationStamps();
    writes.length = 0;
    clearHibernationPark("mark-repeat", "conv-repeat");
    await flushHibernationStamps();
    clearHibernationPark("mark-repeat", "conv-repeat");
    await flushHibernationStamps();
    expect(writes).toEqual([]);
  });

  test("a second park in the same boot is cleared again", async () => {
    track("mark-again", { status: "idle" });
    clearHibernationPark("mark-again", "conv-again");
    await flushHibernationStamps();
    writes.length = 0;
    trackSessionPaneForTests("mark-again", `cc-resume-mark-again`, { parked: true, status: "hibernated" });
    clearHibernationPark("mark-again", "conv-again");
    await flushHibernationStamps();
    expect(writes).toEqual([{ conversationId: "conv-again", status: "connected", hibernatedAt: null }]);
  });

  test("a teardown drops the mark: a killed session is not a parked one", async () => {
    // Nothing wakes a killed session, so without this the mark stayed for the
    // life of the daemon and the live versus parked count over-reported.
    track("mark-killed", { parked: true, status: "hibernated" });
    clearSessionTrackingForKill("mark-killed");
    expect(sessionParkStateForTests("mark-killed").parked).toBe(false);
    expect(writes).toEqual([]);
  });
});
