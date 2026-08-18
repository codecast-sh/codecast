import { describe, expect, it } from "bun:test";
import {
  categorizeSessions,
  classifySession,
  sessionRestState,
  visualOrderSessions,
  type InboxSession,
} from "../inboxStore";

// The settled sections split by WHO ACTS NEXT: a blocked settle is Needs Input,
// a delivered one is Done, one parked on a machine wake is Dormant. These pin
// the client mirror of classifyWorkState's restState arm (convex/inboxFilters):
// the same sources, the same precedence, so the web inbox and `cast sessions`
// file the same session under the same word.
// A live clock: categorizeSessions runs the trust-TTL staleness net against
// Date.now(), so a fixed past timestamp would file every row as stale/settled.
const NOW = Date.now();
const mk = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `s-${id}`,
  updated_at: NOW,
  agent_type: "claude_code",
  message_count: 3,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: id,
  ...extra,
});
const ids = (xs: InboxSession[]) => xs.map((x) => x._id);
const cat = (sessions: Record<string, InboxSession>) => categorizeSessions(sessions, new Set());

describe("sessionRestState", () => {
  it("declared verdicts: agent_status dormant / done, and the inferred waiting", () => {
    expect(sessionRestState(mk("a", { agent_status: "dormant" }))).toBe("dormant");
    expect(sessionRestState(mk("a", { agent_status: "waiting" }))).toBe("dormant");
    expect(sessionRestState(mk("a", { agent_status: "done" }))).toBe("done");
    expect(sessionRestState(mk("a", { agent_status: "idle" }))).toBe("needs_input");
    expect(sessionRestState(mk("a"))).toBe("needs_input");
  });

  it("the user's park stamp files as dormant, and dormant beats done", () => {
    expect(sessionRestState(mk("a", { is_dormant: true }))).toBe("dormant");
    expect(sessionRestState(mk("a", { is_dormant: true, agent_status: "done" }))).toBe("dormant");
  });

  it("the settle classifier speaks only for an undeclared settle", () => {
    expect(sessionRestState(mk("a", { settle_verdict: "done" }))).toBe("done");
    // The classifier never parks a session: a stale stored "dormant" verdict is ignored.
    expect(sessionRestState(mk("a", { agent_status: "idle", settle_verdict: "dormant" as any }))).toBe("needs_input");
    expect(sessionRestState(mk("a", { settle_verdict: "needs_input" }))).toBe("needs_input");
    expect(sessionRestState(mk("a", { agent_status: "done", settle_verdict: "needs_input" }))).toBe("done");
    expect(sessionRestState(mk("a", { agent_status: "dormant", settle_verdict: "done" }))).toBe("dormant");
  });
});

describe("classifySession.rest", () => {
  it("a hard block is needs_input whatever verdict the row carries", () => {
    for (const s of [
      mk("q", { agent_status: "dormant", awaiting_input: true }),
      mk("p", { agent_status: "done", is_idle: false, awaiting_input: true }),
      mk("e", { is_dormant: true, pending_api_error: true }),
      mk("b", { agent_status: "permission_blocked", settle_verdict: "done" }),
      mk("d", { agent_status: "stopped", is_dormant: true }),
    ]) {
      const c = classifySession(s);
      expect(c.waiting).toBe(true);
      expect(c.rest).toBe("needs_input");
    }
  });

  it("a settle with a rest verdict is still `waiting` (settled) — the verdict refines the section", () => {
    const c = classifySession(mk("a", { agent_status: "dormant" }));
    expect(c.waiting).toBe(true);
    expect(c.rest).toBe("dormant");
  });
});

describe("categorizeSessions rest sections", () => {
  it("splits settled rows into needsInput / done / dormant", () => {
    const { needsInput, done, dormant, working } = cat({
      blocked: mk("blocked"),
      asked: mk("asked", { awaiting_input: true }),
      shipped: mk("shipped", { agent_status: "done" }),
      parked: mk("parked", { agent_status: "dormant" }),
      watching: mk("watching", { agent_status: "waiting" }),
      userParked: mk("userParked", { is_dormant: true }),
      judged: mk("judged", { settle_verdict: "done" }),
      busy: mk("busy", { is_idle: false, agent_status: "working" }),
    });
    expect(ids(needsInput).sort()).toEqual(["asked", "blocked"]);
    expect(ids(done).sort()).toEqual(["judged", "shipped"]);
    expect(ids(dormant).sort()).toEqual(["parked", "userParked", "watching"]);
    expect(ids(working)).toEqual(["busy"]);
  });

  it("orders done and dormant newest-first, needs input oldest-first", () => {
    const { needsInput, done, dormant } = cat({
      d1: mk("d1", { agent_status: "done", updated_at: NOW - 30 }),
      d2: mk("d2", { agent_status: "done", updated_at: NOW - 10 }),
      p1: mk("p1", { agent_status: "dormant", updated_at: NOW - 30 }),
      p2: mk("p2", { agent_status: "dormant", updated_at: NOW - 10 }),
      n1: mk("n1", { updated_at: NOW - 30 }),
      n2: mk("n2", { updated_at: NOW - 10 }),
    });
    expect(ids(done)).toEqual(["d2", "d1"]);
    expect(ids(dormant)).toEqual(["p2", "p1"]);
    expect(ids(needsInput)).toEqual(["n1", "n2"]);
  });

  it("a declared-dormant home quiet for a day stays Dormant — the staleness net says settled, not blocked", () => {
    const stale = mk("stale", { agent_status: "dormant", updated_at: Date.now() - 24 * 3_600_000 });
    const { needsInput, dormant } = cat({ stale });
    expect(ids(dormant)).toEqual(["stale"]);
    expect(needsInput).toEqual([]);
  });

  it("pinned rows never enter the rest sections", () => {
    const { pinned, done, dormant } = cat({
      p: mk("p", { is_pinned: true, inbox_pinned_at: 1, agent_status: "done" }),
      q: mk("q", { is_pinned: true, inbox_pinned_at: 2, agent_status: "dormant" }),
    });
    expect(ids(pinned)).toEqual(["p", "q"]);
    expect(done).toEqual([]);
    expect(dormant).toEqual([]);
  });
});

describe("visualOrderSessions with rest sections", () => {
  it("walks the status view top-down: needs input, done, working, dormant", () => {
    const sessions = {
      n: mk("n"),
      d: mk("d", { agent_status: "done" }),
      w: mk("w", { is_idle: false, agent_status: "working" }),
      p: mk("p", { agent_status: "dormant" }),
    };
    expect(ids(visualOrderSessions(sessions, new Set()))).toEqual(["n", "d", "w", "p"]);
  });

  it("an absorbed settled row (a trigger's resting home) walks with Dormant, not its own bucket", () => {
    const sessions = {
      n: mk("n"),
      home: mk("home"),
      p: mk("p", { agent_status: "dormant" }),
    };
    expect(ids(visualOrderSessions(sessions, new Set(), null, undefined, { absorbedIds: new Set(["home"]) })))
      .toEqual(["n", "p", "home"]);
  });

  it("a collapsed dormant section is skipped", () => {
    const sessions = { n: mk("n"), p: mk("p", { agent_status: "dormant" }) };
    expect(ids(visualOrderSessions(sessions, new Set(), null, undefined, { collapsedSections: { dormant: true } })))
      .toEqual(["n"]);
  });
});
