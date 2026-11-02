// The hibernation policy decides which live sessions the daemon kills the pane
// of, so every rule that keeps a session alive is worth a test of its own: a
// rule that silently stops blocking costs a working agent its turn.

import { describe, expect, test } from "bun:test";
import { MID_TURN_AGENT_STATUSES, type AgentStatus } from "@codecast/shared/contracts";
import {
  DEFAULT_HIBERNATE_IDLE_MS,
  DEFAULT_MAX_LIVE_SESSIONS,
  HIBERNATE_MAX_PER_PASS,
  HIBERNATE_RESUME_GRACE_MS,
  HIBERNATE_SUBAGENT_QUIET_MS,
  agentForeignDescendants,
  hibernationBlockReason,
  selectHibernationCandidates,
  type HibernationCandidate,
} from "./hibernation.js";
import type { ProcRow } from "./processTable.js";

const candidate = (over: Partial<HibernationCandidate> = {}): HibernationCandidate => ({
  sessionId: over.sessionId ?? "s1",
  tmux: over.tmux ?? `cc-resume-${over.sessionId ?? "s1"}`,
  conversationId: "conv1",
  status: "idle",
  awakeIdleMs: 0,
  statusDwellMs: 0,
  attachedClients: 0,
  sharedPane: false,
  subagentActiveAgoMs: Infinity,
  resumedAgoMs: Infinity,
  messagesInFlight: false,
  ...over,
});

const fleet = (n: number, over: (i: number) => Partial<HibernationCandidate> = () => ({})): HibernationCandidate[] =>
  Array.from({ length: n }, (_, i) => candidate({ sessionId: `s${String(i).padStart(3, "0")}`, ...over(i) }));

const policy = (over: Partial<{ maxLive: number; idleMs: number; maxPerPass: number }> = {}) => ({
  maxLive: 0,
  idleMs: 0,
  maxPerPass: HIBERNATE_MAX_PER_PASS,
  ...over,
});

describe("hibernationBlockReason", () => {
  test("nothing to object to reads null", () => {
    expect(hibernationBlockReason(candidate())).toBeNull();
  });

  for (const status of ["working", "thinking", "compacting", "permission_blocked"] as const) {
    test(`${status} blocks: parking it would kill the turn, not park it`, () => {
      expect(hibernationBlockReason(candidate({ status }))).toBe("status-working");
    });
  }

  test("every mid-turn status blocks, so a new one is covered the day it lands", () => {
    for (const status of MID_TURN_AGENT_STATUSES) {
      expect(hibernationBlockReason(candidate({ status: status as AgentStatus }))).toBe("status-working");
    }
  });

  test("waiting blocks: the pane's tree holds the background work it waits on", () => {
    expect(hibernationBlockReason(candidate({ status: "waiting" }))).toBe("open-background-work");
  });

  for (const status of ["resuming", "starting"] as const) {
    test(`${status} blocks: the session is still coming up`, () => {
      expect(hibernationBlockReason(candidate({ status }))).toBe("status-resuming");
    });
  }

  test("an attached tmux client blocks: a human has the pane open", () => {
    expect(hibernationBlockReason(candidate({ attachedClients: 1 }))).toBe("attached");
  });

  test("a shared pane blocks: a parent runs its subagent in that pane", () => {
    expect(hibernationBlockReason(candidate({ sharedPane: true }))).toBe("shared-pane");
  });

  test("a parent whose subagent is still writing blocks", () => {
    // The child has no pane of its own: it is a process inside this pane's
    // tree, so the teardown would kill it mid-turn.
    expect(hibernationBlockReason(candidate({ subagentActiveAgoMs: HIBERNATE_SUBAGENT_QUIET_MS - 1 })))
      .toBe("live-subagents");
    expect(hibernationBlockReason(candidate({ subagentActiveAgoMs: HIBERNATE_SUBAGENT_QUIET_MS }))).toBe("live-subagents");
    expect(hibernationBlockReason(candidate({ subagentActiveAgoMs: 0 }))).toBe("live-subagents");
  });

  test("a resume inside the grace window blocks", () => {
    expect(hibernationBlockReason(candidate({ resumedAgoMs: HIBERNATE_RESUME_GRACE_MS - 1 }))).toBe("recently-resumed");
    expect(hibernationBlockReason(candidate({ resumedAgoMs: HIBERNATE_RESUME_GRACE_MS }))).toBeNull();
  });

  test("messages on their way block: parking would buy a resume next tick", () => {
    expect(hibernationBlockReason(candidate({ messagesInFlight: true }))).toBe("in-flight-messages");
  });

  test("a quiet session does not block — that is exactly what to park", () => {
    // "waiting" is deliberately absent: it is a settle verdict, but the one
    // that names live background work inside the pane.
    for (const status of ["idle", "dormant", "done"] as const) {
      expect(hibernationBlockReason(candidate({ status }))).toBeNull();
    }
  });
});

describe("selectHibernationCandidates: the shipping defaults do nothing", () => {
  test("no cap and no idle bar picks nothing, however large the fleet", () => {
    const { picked } = selectHibernationCandidates(
      fleet(200, () => ({ awakeIdleMs: 99 * 3600_000 })),
      policy({ maxLive: DEFAULT_MAX_LIVE_SESSIONS, idleMs: DEFAULT_HIBERNATE_IDLE_MS }),
    );
    expect(picked).toEqual([]);
  });
});

describe("selectHibernationCandidates: cap math", () => {
  test("a fleet at or under the cap with nobody past the bar picks nothing", () => {
    const { picked } = selectHibernationCandidates(fleet(10), policy({ maxLive: 10, idleMs: 3600_000 }));
    expect(picked).toEqual([]);
  });

  test("the overage is exactly how many get parked, even when all are fresh", () => {
    const { picked } = selectHibernationCandidates(fleet(13), policy({ maxLive: 10 }));
    expect(picked.length).toBe(3);
  });

  test("maxLive 0 means no cap, so only the idle bar fires", () => {
    const under = fleet(3, (i) => ({ awakeIdleMs: i === 0 ? 3 * 3600_000 : 1000 }));
    const { picked } = selectHibernationCandidates(under, policy({ maxLive: 0, idleMs: 2 * 3600_000 }));
    expect(picked.map((c) => c.sessionId)).toEqual(["s000"]);
  });

  test("the bar and the overage together never exceed maxPerPass", () => {
    const all = fleet(40, () => ({ awakeIdleMs: 9 * 3600_000 }));
    const { picked, skips } = selectHibernationCandidates(all, policy({ maxLive: 10, idleMs: 3600_000 }));
    expect(picked.length).toBe(HIBERNATE_MAX_PER_PASS);
    expect(skips.filter((s) => s === "pass-cap").length).toBe(all.length - HIBERNATE_MAX_PER_PASS);
  });

  test("a blocked session counts toward the fleet size but can never fill the overage", () => {
    // Twelve live sessions against a cap of ten, but every one of them is
    // working: the machine is over its cap and the pass still parks nobody.
    const all = fleet(12, () => ({ status: "working" as const }));
    const { picked, skips } = selectHibernationCandidates(all, policy({ maxLive: 10 }));
    expect(picked).toEqual([]);
    expect(skips.filter((s) => s === "status-working").length).toBe(12);
  });

  test("blocked sessions still make the fleet over its cap, so the eligible ones go", () => {
    const all = [
      ...fleet(8, () => ({ status: "working" as const })),
      candidate({ sessionId: "z1", awakeIdleMs: 5000 }),
      candidate({ sessionId: "z2", awakeIdleMs: 9000 }),
    ];
    const { picked } = selectHibernationCandidates(all, policy({ maxLive: 8 }));
    expect(picked.map((c) => c.sessionId)).toEqual(["z2", "z1"]);
  });
});

describe("selectHibernationCandidates: a refused head does not starve the pass", () => {
  // The regression (2026-09-21): the five longest idle sessions were refused by
  // the daemon's durable gates, the order is deterministic, and ten passes in a
  // row offered the same five while 24 to 36 parkable sessions waited.
  const bar = 8 * 3600_000;
  const fleetPastBar = Array.from({ length: 12 }, (_, i) =>
    candidate({ sessionId: `s${String(i).padStart(2, "0")}`, tmux: `t${i}`, awakeIdleMs: bar + (12 - i) * 60_000 }));

  test("the first pass picks the longest idle, and the next pass moves past the ones it refused", () => {
    const first = selectHibernationCandidates(fleetPastBar, policy({ idleMs: bar }));
    expect(first.picked.map((c) => c.sessionId)).toEqual(["s00", "s01", "s02", "s03", "s04"]);
    const refused = new Set(first.picked.map((c) => c.sessionId));
    const second = selectHibernationCandidates(fleetPastBar, policy({ idleMs: bar }), refused);
    expect(second.picked.map((c) => c.sessionId)).toEqual(["s05", "s06", "s07", "s08", "s09"]);
    expect(second.skips.filter((r) => r === "refused-recently")).toHaveLength(5);
  });

  test("a refused session still counts toward the fleet size for the cap", () => {
    const refused = new Set(["s00"]);
    const { picked } = selectHibernationCandidates(fleetPastBar, policy({ maxLive: 10 }), refused);
    expect(picked.map((c) => c.sessionId)).toEqual(["s01", "s02"]);
  });
});

describe("selectHibernationCandidates: ordering", () => {
  test("longest awake idle first", () => {
    const all = [
      candidate({ sessionId: "a", awakeIdleMs: 1000 }),
      candidate({ sessionId: "b", awakeIdleMs: 9000 }),
      candidate({ sessionId: "c", awakeIdleMs: 5000 }),
    ];
    const { picked } = selectHibernationCandidates(all, policy({ maxLive: 1 }));
    expect(picked.map((c) => c.sessionId)).toEqual(["b", "c"]);
  });

  test("equal idle falls to the longer status dwell", () => {
    const all = [
      candidate({ sessionId: "a", awakeIdleMs: 1000, statusDwellMs: 10 }),
      candidate({ sessionId: "b", awakeIdleMs: 1000, statusDwellMs: 900 }),
    ];
    const { picked } = selectHibernationCandidates(all, policy({ maxLive: 1 }));
    expect(picked.map((c) => c.sessionId)).toEqual(["b"]);
  });

  test("both equal falls to the session id, so a shuffled fleet picks the same sessions", () => {
    const all = fleet(9);
    const shuffled = [...all].reverse();
    const one = selectHibernationCandidates(all, policy({ maxLive: 6 }));
    const two = selectHibernationCandidates(shuffled, policy({ maxLive: 6 }));
    expect(one.picked.map((c) => c.sessionId)).toEqual(two.picked.map((c) => c.sessionId));
    expect(one.picked.map((c) => c.sessionId)).toEqual(["s000", "s001", "s002"]);
  });
});

describe("selectHibernationCandidates: the idle bar", () => {
  test("past the bar parks whatever the fleet size", () => {
    const all = [
      candidate({ sessionId: "old", awakeIdleMs: 3 * 3600_000 }),
      candidate({ sessionId: "new", awakeIdleMs: 60_000 }),
    ];
    const { picked } = selectHibernationCandidates(all, policy({ maxLive: 100, idleMs: 2 * 3600_000 }));
    expect(picked.map((c) => c.sessionId)).toEqual(["old"]);
  });

  test("exactly at the bar parks; one millisecond short does not", () => {
    const bar = 2 * 3600_000;
    const at = selectHibernationCandidates([candidate({ awakeIdleMs: bar })], policy({ idleMs: bar }));
    const under = selectHibernationCandidates([candidate({ awakeIdleMs: bar - 1 })], policy({ idleMs: bar }));
    expect(at.picked.length).toBe(1);
    expect(under.picked).toEqual([]);
  });

  test("a blocked session past the bar is still blocked", () => {
    const all = [candidate({ awakeIdleMs: 99 * 3600_000, attachedClients: 2 })];
    const { picked, skips } = selectHibernationCandidates(all, policy({ maxLive: 1, idleMs: 1000 }));
    expect(picked).toEqual([]);
    expect(skips).toEqual(["attached"]);
  });
});

describe("agentForeignDescendants", () => {
  // The shapes `ps -o pid,ppid,pgid` showed under a live Claude Code agent on
  // 2026-11-01: the agent leads its own group, its MCP servers stay in it, and
  // each Bash tool shell is detached into a group of its own.
  const AGENT = 98132;
  const row = (pid: number, ppid: number, pgid: number | undefined, command: string): ProcRow => ({ pid, ppid, pgid, command });
  const agent = row(AGENT, 97474, AGENT, "claude --session-id s1");
  const shell = row(97474, 97347, 97474, "-bash");
  const gmail = row(98248, AGENT, AGENT, "npm exec @gongrzhe/server-gmail-autoauth-mcp");
  const gmailNode = row(99411, 98248, AGENT, "node /Users/x/.npm/_npx/9524/node_modules/.bin/gmail-mcp");
  const imessage = row(98250, AGENT, AGENT, "node /Users/x/code/imessage-mcp-server/build/index.js");
  const bash = row(1154, AGENT, 1154, "/usr/local/bin/bash -c source snapshot.sh && eval 'sleep 120'");
  const sleep = row(1160, 1154, 1154, "sleep 120");

  test("MCP children only: nothing foreign, the agent may park", () => {
    expect(agentForeignDescendants([shell, agent, imessage], AGENT)).toEqual([]);
  });

  test("a nested MCP server (npm exec, then node) is the agent's own", () => {
    expect(agentForeignDescendants([shell, agent, gmail, gmailNode], AGENT)).toEqual([]);
  });

  test("MCP children plus a Bash tool shell: the shell and its work are foreign", () => {
    expect(agentForeignDescendants([shell, agent, gmail, gmailNode, imessage, bash, sleep], AGENT)).toEqual([bash, sleep]);
  });

  test("a dev server under a Bash shell is foreign even when it outlives the shell's command", () => {
    const server = row(1170, 1154, 1154, "node vite --port 3200");
    expect(agentForeignDescendants([agent, bash, server], AGENT)).toEqual([bash, server]);
  });

  test("a table read without process groups fails closed", () => {
    expect(agentForeignDescendants([row(AGENT, 1, undefined, "claude"), row(98248, AGENT, undefined, "npm exec x")], AGENT)).toHaveLength(1);
    expect(agentForeignDescendants([agent, row(98248, AGENT, undefined, "npm exec x")], AGENT)).toHaveLength(1);
  });

  test("an absent agent yields nothing to judge", () => {
    expect(agentForeignDescendants([shell, gmail], AGENT)).toEqual([]);
  });
});

