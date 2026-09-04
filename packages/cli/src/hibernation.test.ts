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
  hibernationBlockReason,
  selectHibernationCandidates,
  type HibernationCandidate,
} from "./hibernation.js";

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
    expect(hibernationBlockReason(candidate({ subagentActiveAgoMs: HIBERNATE_SUBAGENT_QUIET_MS }))).toBeNull();
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
    for (const status of ["idle", "dormant", "done", "connected"] as const) {
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
