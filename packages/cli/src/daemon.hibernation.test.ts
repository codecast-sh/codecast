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
  inProcessWorkRefusal,
  noteSubagentActivity,
  resetHibernationRefusalsForTests,
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
import { defaultConfigDir } from "./config/configDir.js";
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
    inspectTarget: async (id) => ({ session: "$1", pane: "%1", pid: 100, agentPid: 100, start: "start", stamp: id, conversationStamp: "" }),
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
  loopState: null,
  source: "lifecycle",
  ...over,
});
const armedLoop = (wakeupAt: number) => ({ status: "armed" as const, wakeup_at: wakeupAt, armed_at: wakeupAt - 600_000, event_at: wakeupAt - 600_000 });

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
      name: "an armed /loop wakeup would die with the pane, and nothing resumes it when due",
      reason: "loop-armed",
      opts: { lifecycle: (id: string) => (id === target ? lifecycleOf({ loopState: armedLoop(NOW + 600_000) }) : lifecycleOf({})) },
    },
    {
      name: "a server too old to report the loop state",
      reason: "lifecycle-degraded",
      opts: { lifecycle: (id: string) => (id === target ? lifecycleOf({ loopState: undefined }) : lifecycleOf({})) },
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

test("a /loop wakeup long overdue is a dead harness, and holds nothing back", async () => {
  const f = fixture({ count: 1, lifecycle: () => lifecycleOf({ loopState: armedLoop(NOW - 3_600_000) }) });
  expect(await f.hibernate(f.sessions[0])).toEqual({ result: "hibernated" });
});

describe("a subagent quiet past the window", () => {
  const target = "hib-test-002";
  beforeEach(resetHibernationRefusalsForTests);

  test("does not hold its parent from the pass or the command", async () => {
    const opts = { count: 3, maxLive: 1, awakeIdleMs: (i: number) => i * 1000, subagentActiveAgoMs: (id: string) => (id === target ? 11 * 60_000 : Infinity) };
    const pass = fixture(opts);
    await runHibernationPass(pass.io);
    expect(pass.parked).toContain(target);
    for (const id of tracked.splice(0)) trackSessionPaneForTests(id, null);
    const command = fixture(opts);
    expect(await command.hibernate(target)).toEqual({ result: "hibernated" });
  });
});

// A refused session backs off for an hour, so without its own line the reason
// it stays awake was invisible: the pass line only said "refused-recently".
describe("a refusal is named once and carried by the pass line", () => {
  const REAPER_LOG = path.join(process.env.TMPDIR || "/tmp", "codecast-test-reaper.log");
  const target = "hib-test-002";
  const logSize = () => (fs.existsSync(REAPER_LOG) ? fs.statSync(REAPER_LOG).size : 0);
  // Other test runs on this machine append to the same file, so read only what
  // came after `from`, and look for lines rather than count the file.
  const logSince = (from: number) => {
    const all = fs.existsSync(REAPER_LOG) ? fs.readFileSync(REAPER_LOG) : Buffer.alloc(0);
    return (all.length >= from ? all.subarray(from) : all).toString("utf8");
  };
  beforeEach(resetHibernationRefusalsForTests);
  afterEach(resetHibernationRefusalsForTests);

  test("the refusal writes one line naming the session, and the next pass buckets it by reason", async () => {
    // Only the target is past the idle bar, and a question is still open in it.
    const f = fixture({
      count: 3,
      idleMs: 1000,
      awakeIdleMs: (i) => (i === 2 ? 5000 : 0),
      sidecarMtimeMs: (id) => (id === target ? 2000 : null),
      transcriptLastRealMs: () => 1000,
    });
    const refusalLine = `hibernation refused ${target.slice(0, 8)} tmux=cc-resume-${target} conv=conv-2: pending-question`;

    const first = logSize();
    await runHibernationPass(f.io);
    const firstLog = logSince(first);
    expect(f.parked).toEqual([]);
    expect(firstLog).toContain(refusalLine);
    expect(firstLog).toMatch(/hibernation pass: 3 live, cap=0, hibernated 0, skipped: .*pending-question×1/);

    const second = logSize();
    await runHibernationPass(f.io);
    const secondLog = logSince(second);
    expect(secondLog).not.toContain(refusalLine);
    expect(secondLog).toMatch(/hibernation pass: 3 live, cap=0, hibernated 0, skipped: .*refused-recently\(pending-question\)×1/);
  });
});

// The verdict the park and the idle reaper share on work running inside the
// agent's process, read from a real transcript on disk.
describe("inProcessWorkRefusal", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
  const lead = (spawnedAt: number) => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "in-process-work-"));
    dirs.push(dir);
    const sessionId = "lead-session";
    const file = path.join(dir, `${sessionId}.jsonl`);
    const timestamp = new Date(spawnedAt).toISOString();
    fs.writeFileSync(file, [
      { type: "assistant", sessionId, timestamp, message: { content: [{ type: "tool_use", id: "t1", name: "Agent", input: { name: "reviewer", team_name: "t" } }] } },
      { type: "user", sessionId, timestamp, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Spawned successfully.\nagent_id: areviewer-0a1b\nname: reviewer\n" }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    return { sessionId, file };
  };

  test("a lead whose current process spawned a teammate that never shut down is team-active", async () => {
    resetSubagentActivityForTests();
    const now = Date.now();
    const { sessionId, file } = lead(now - 5 * 3600_000);
    expect(await inProcessWorkRefusal(sessionId, file, now - 6 * 3600_000)).toBe("team-active");
  });

  test("a teammate an earlier process spawned is not", async () => {
    resetSubagentActivityForTests();
    const now = Date.now();
    const { sessionId, file } = lead(now - 5 * 3600_000);
    expect(await inProcessWorkRefusal(sessionId, file, now - 3600_000)).toBeNull();
  });
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

  test("a full recorder reads a dropped write as unknown, never as no children", () => {
    resetSubagentActivityForTests();
    for (let i = 0; i < 600; i++) noteSubagentActivity(`${PROJ}/busy-${i}/subagents/c.jsonl`, NOW);
    expect(subagentActiveAgoMs("busy-0", NOW)).toBe(0);
    expect(subagentActiveAgoMs("busy-599", NOW)).toBeNaN();
    expect(subagentActiveAgoMs("unrecorded", NOW)).toBeNaN();
    resetSubagentActivityForTests();
  });

  test("a full recorder makes room from writes past the quiet window instead of latching", () => {
    // It used to latch: after 500 parents every unseen session read NaN, and
    // hibernation refused it, until the daemon restarted.
    resetSubagentActivityForTests();
    const old = NOW - HIBERNATE_SUBAGENT_QUIET_MS * 2;
    for (let i = 0; i < 500; i++) noteSubagentActivity(`${PROJ}/old-${i}/subagents/c.jsonl`, old);
    noteSubagentActivity(`${PROJ}/${parent}/subagents/c.jsonl`, NOW);
    expect(subagentActiveAgoMs(parent, NOW)).toBe(0);
    expect(subagentActiveAgoMs("old-0", NOW)).toBe(Infinity);
    expect(subagentActiveAgoMs("unrecorded", NOW)).toBe(Infinity);
    resetSubagentActivityForTests();
  });

  test("a dropped write stops reading unknown once it is past the quiet window", () => {
    resetSubagentActivityForTests();
    for (let i = 0; i < 501; i++) noteSubagentActivity(`${PROJ}/busy-${i}/subagents/c.jsonl`, NOW);
    expect(subagentActiveAgoMs("busy-500", NOW + HIBERNATE_SUBAGENT_QUIET_MS - 1)).toBeNaN();
    expect(subagentActiveAgoMs("busy-500", NOW + HIBERNATE_SUBAGENT_QUIET_MS)).toBe(Infinity);
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

  test("the idle reaper reads the park's verdict on in-process work", () => {
    // It used to check only the subagent recorder, so a lead idle five hours
    // had its live in-process team reaped with it.
    const reaper = functionBlock(src, "reapIdleOrphanTerminals").text;
    expect(reaper).toContain("await inProcessWorkRefusal(sessionId, transcript.path, startMs)");
    // And backs off like the park, so a refused pane's transcript is not
    // scanned again every pass, while the pass line still names the reason.
    expect(reaper).toContain("if (recent && now - recent.at < HIBERNATE_REFUSAL_BACKOFF_MS) { skips.push(refusedRecentlySkip(recent.reason)); continue; }");
    expect(reaper).toContain(`if (work) { skips.push(work); noteHibernationRefusal("reaper",`);
    expect(functionBlock(src, "hibernationChildHistoryIsClear").text).toContain("await inProcessWorkRefusal(sessionId, file.path, processStartMs)");
  });

  test("the reaper and the park's child-history gate read the policy's subagent verdict", () => {
    // Both once tested `!== Infinity`, which holds a parent forever once any
    // subagent has run. The same window as hibernationBlockReason, or the
    // policy picks a session the gate then refuses every hour.
    const verdict = "subagentRecentlyActive(subagentActiveAgoMs(sessionId))";
    expect(functionBlock(src, "reapIdleOrphanTerminals").text).toContain(`subagentsLive: ${verdict}`);
    expect(functionBlock(src, "hibernationChildHistoryIsClear").text).toContain(`if (${verdict}) { refuseTarget(sessionId, "live-subagents")`);
    expect(functionBlock(src, "inProcessWorkRefusal").text).toContain(`if (${verdict}) return "live-subagents";`);
  });

  test("the ingest path records subagent appends", () => {
    const wrapper = functionBlock(src, "processSessionFile").text;
    expect(wrapper).toContain("runTranscriptPass(args[1], path.resolve(args[0]), () => processSessionFilePass(...args))");
    const serialized = functionBlock(src, "runTranscriptPass").text;
    expect(serialized).toContain("serializeTranscript(`ingest-session:${sessionId}`");
    expect(serialized).toContain("serializeTranscript(file,");
    const body = functionBlock(src, "processSessionFilePass").text;
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

describe("after a daemon restart", () => {
  // The in-memory status is gone after every restart and an idle session never
  // speaks again, so the hook's own file is the status the pass must read.
  const statusFile = (id: string) => path.join(defaultConfigDir(), "agent-status", `${id}.json`);
  const written: string[] = [];
  afterEach(() => { for (const f of written.splice(0)) fs.rmSync(f, { force: true }); });
  const writeStatus = (id: string, status: AgentStatus) => {
    fs.mkdirSync(path.dirname(statusFile(id)), { recursive: true });
    fs.writeFileSync(statusFile(id), JSON.stringify({ status, ts: NOW }));
    written.push(statusFile(id));
  };

  test("a session idle on disk parks though the daemon never heard it speak", async () => {
    const f = fixture({ count: 1, facts: () => ({ status: undefined }) });
    writeStatus(f.sessions[0], "idle");
    expect(await f.hibernate(f.sessions[0])).toEqual({ result: "hibernated" });
  });

  test("a session working on disk still keeps its pane", async () => {
    const f = fixture({ count: 1, facts: () => ({ status: undefined }) });
    writeStatus(f.sessions[0], "working");
    expect((await f.hibernate(f.sessions[0])).result).toBe("skipped_status-working");
    expect(f.parked).toEqual([]);
  });
});
