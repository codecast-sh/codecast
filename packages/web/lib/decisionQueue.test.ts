import { describe, expect, it } from "bun:test";
import {
  decisionQueueItems,
  queueTier,
  sessionHasOpenQuestion,
  sortQueue,
  type QueueItem,
} from "./decisionQueue";
import type { InboxSession, SessionDecisionItem } from "../store/inboxStore";

const T0 = 1_700_000_000_000;

function session(over: Partial<InboxSession> = {}): InboxSession {
  return { _id: "s1", agent_status: "idle", ...(over as any) } as InboxSession;
}

function item(over: Partial<QueueItem> = {}): QueueItem {
  return {
    key: "k",
    source: "decide",
    conversationId: "s1",
    question: "q",
    options: [],
    blocking: true,
    createdAt: T0,
    ...over,
  };
}

describe("queueTier", () => {
  it("puts a blocked question on a reachable session first", () => {
    expect(queueTier(item({ session: session() }))).toBe(1);
  });

  // The bug this guards: ranking on "is the agent producing tokens" demoted
  // every genuinely blocked agent to tier 2, because an agent parked on a
  // question is by definition not producing tokens.
  it.each(["idle", "permission_blocked", "waiting", "working"])(
    "keeps a parked session in tier 1 at status %s",
    (agent_status) => {
      expect(queueTier(item({ session: session({ agent_status }) }))).toBe(1);
    }
  );

  it("demotes a blocked question whose session is unresponsive", () => {
    const s = session({ is_unresponsive: true } as any);
    expect(queueTier(item({ session: s }))).toBe(2);
  });

  it("demotes a blocked question whose session was stopped", () => {
    expect(queueTier(item({ session: session({ agent_status: "stopped" }) }))).toBe(2);
  });

  it("demotes a blocked question whose session was torn down", () => {
    const s = session({ inbox_killed_at: T0 } as any);
    expect(queueTier(item({ session: s }))).toBe(2);
  });

  it("treats a session we know nothing about as unreachable", () => {
    expect(queueTier(item({ session: undefined }))).toBe(2);
  });

  it("puts advisory questions last regardless of liveness", () => {
    expect(queueTier(item({ blocking: false, session: session() }))).toBe(3);
  });
});

describe("sortQueue", () => {
  it("orders by tier, then oldest first inside a tier", () => {
    const live = session();
    const dead = session({ agent_status: "stopped" });
    const out = sortQueue([
      item({ key: "advisory-old", blocking: false, session: live, createdAt: T0 - 9000 }),
      item({ key: "live-new", session: live, createdAt: T0 + 500 }),
      item({ key: "dead-old", session: dead, createdAt: T0 - 5000 }),
      item({ key: "live-old", session: live, createdAt: T0 - 1000 }),
    ]);
    expect(out.map((i) => i.key)).toEqual(["live-old", "live-new", "dead-old", "advisory-old"]);
  });

  it("never reorders equal-tier items by anything but age", () => {
    // Age is the only within-tier signal on purpose: a queue that reshuffles
    // under the cursor is unusable. A long question must not outrank an older
    // short one.
    const live = session();
    const out = sortQueue([
      item({ key: "b", session: live, createdAt: T0 + 1, question: "x".repeat(500) }),
      item({ key: "a", session: live, createdAt: T0, question: "x" }),
    ]);
    expect(out.map((i) => i.key)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const live = session();
    const input = [
      item({ key: "new", session: live, createdAt: T0 + 10 }),
      item({ key: "old", session: live, createdAt: T0 }),
    ];
    sortQueue(input);
    expect(input.map((i) => i.key)).toEqual(["new", "old"]);
  });
});

describe("decisionQueueItems", () => {
  const base: SessionDecisionItem = {
    _id: "d1",
    conversation_id: "s1",
    question: "Ship it?",
    options: [{ label: "Yes" }, { label: "No" }],
    blocking: true,
    status: "pending",
    created_at: T0,
  } as SessionDecisionItem;

  it("carries the authored payload through to the card", () => {
    const [q] = decisionQueueItems({ d1: { ...base, context_md: "why", report_slug: "r1" } as any }, {});
    expect(q.source).toBe("decide");
    expect(q.decisionId).toBe("d1");
    expect(q.contextMd).toBe("why");
    expect(q.reportSlug).toBe("r1");
    expect(q.options).toHaveLength(2);
  });

  it("skips rows that are no longer pending", () => {
    const rows: any = {
      d1: base,
      d2: { ...base, _id: "d2", status: "answered" },
      d3: { ...base, _id: "d3", status: "dismissed" },
    };
    expect(decisionQueueItems(rows, {}).map((i) => i.decisionId)).toEqual(["d1"]);
  });

  it("attaches the session so ranking can see liveness", () => {
    const s = session({ _id: "s1" });
    const [q] = decisionQueueItems({ d1: base } as any, { s1: s });
    expect(q.session).toBe(s);
    expect(queueTier(q)).toBe(1);
  });
});

describe("sessionHasOpenQuestion", () => {
  it("accepts the server's awaiting_input flag", () => {
    expect(sessionHasOpenQuestion(session({ awaiting_input: true } as any))).toBe(true);
  });

  it("accepts a permission-blocked row, which awaiting_input misses once idle", () => {
    expect(sessionHasOpenQuestion(session({ agent_status: "permission_blocked" }))).toBe(true);
  });

  it("ignores a session with neither signal", () => {
    expect(sessionHasOpenQuestion(session())).toBe(false);
  });

  it("ignores a killed session even while it still carries the flag", () => {
    const s = session({ awaiting_input: true, inbox_killed_at: T0 } as any);
    expect(sessionHasOpenQuestion(s)).toBe(false);
  });

  // An infrastructure park is not a decision: the session is blocked on
  // plumbing the queue cannot resolve, and the inbox already badges it.
  for (const kind of ["limit", "auth", "connection", "fatal"]) {
    it(`ignores a session parked on a "${kind}" banner`, () => {
      const s = session({ awaiting_input: true, pending_api_error_kind: kind } as any);
      expect(sessionHasOpenQuestion(s)).toBe(false);
    });
  }

  // "error" is the deliberate exclusion from BLOCKED_BANNER_KINDS — the CLI is
  // still retrying those on its own, so the session is not parked.
  it("still accepts a session whose banner kind is the self-retrying 'error'", () => {
    const s = session({ awaiting_input: true, pending_api_error_kind: "error" } as any);
    expect(sessionHasOpenQuestion(s)).toBe(true);
  });
});
