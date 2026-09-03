import { describe, expect, it } from "bun:test";
import { STATUS_TRUST_TTL_MS } from "@codecast/shared/contracts";
import {
  classifySession,
  type InboxSession,
} from "../inboxStore";
import { orderSections, placeSections } from "./placeTestHarness";

// The settled sections split by WHO ACTS NEXT: a blocked settle is Needs Input,
// a delivered one is Done, one parked on a machine wake is Dormant. These pin
// the client mirror of classifyWorkState's restState arm (the shared module):
// the same sources, the same precedence, so the web inbox and `cast sessions`
// file the same session under the same word.
// A live clock: the chokepoint runs the trust-TTL staleness net against
// Date.now(), so a fixed past timestamp would file every row as stale/settled.
const NOW = Date.now();
// A settled row as the server ships it (ct-47609): a minute of quiet, the
// last turn the agent's, and — when a status is present — the status change
// stamped past the idle grace. The replica re-derives is_idle from these facts
// at its own clock, exactly as the server does at its epoch, so a fixture that
// claimed is_idle on a row updated milliseconds ago would be a row the server
// itself could never produce.
const BASE = NOW - 60_000;
const mk = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `s-${id}`,
  updated_at: BASE,
  agent_type: "claude_code",
  message_count: 3,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  last_role_is_user: false,
  ...(extra.agent_status ? { agent_status_updated_at: BASE } : {}),
  title: id,
  ...extra,
});
const ids = (xs: InboxSession[]) => xs.map((x) => x._id);
const cat = (sessions: Record<string, InboxSession>) => placeSections(sessions, new Set());

// The rest verdict is the shared classifyWorkState restState arm, read through
// classifySession (the adapter): the same sources, the same precedence, so the
// web inbox and `cast sessions` file the same session under the same word.
const sessionRestState = (s: InboxSession) => classifySession(s).rest;

describe("the rest verdict (classifySession.rest over the shared classifier)", () => {
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

  it("a blocked pin outranks the classifier's soft verdict", () => {
    expect(sessionRestState(mk("a", { agent_status: "idle", thread_state_status: "blocked", settle_verdict: "done" }))).toBe("needs_input");
    expect(sessionRestState(mk("a", { agent_status: "done", thread_state_status: "blocked" }))).toBe("done");
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

describe("placeSections rest sections", () => {
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
    // An open ask is the QUESTIONS bucket now (asking outranks the work
    // state); the plain idle settle is the needs-input fallthrough.
    expect(ids(needsInput).sort()).toEqual(["blocked"]);
    expect(ids(done).sort()).toEqual(["judged", "shipped"]);
    expect(ids(dormant).sort()).toEqual(["parked", "userParked", "watching"]);
    expect(ids(working)).toEqual(["busy"]);
  });

  it("an open ask files under QUESTIONS, not needs input", () => {
    const { questions, needsInput } = cat({ asked: mk("asked", { awaiting_input: true }) });
    expect(ids(questions)).toEqual(["asked"]);
    expect(needsInput).toEqual([]);
  });

  it("orders dormant newest-first, done and needs input oldest-first", () => {
    const { needsInput, done, dormant } = cat({
      d1: mk("d1", { agent_status: "done", updated_at: BASE - 30 }),
      d2: mk("d2", { agent_status: "done", updated_at: BASE - 10 }),
      p1: mk("p1", { agent_status: "dormant", updated_at: BASE - 30 }),
      p2: mk("p2", { agent_status: "dormant", updated_at: BASE - 10 }),
      n1: mk("n1", { updated_at: BASE - 30 }),
      n2: mk("n2", { updated_at: BASE - 10 }),
    });
    expect(ids(done)).toEqual(["d1", "d2"]);
    expect(ids(dormant)).toEqual(["p2", "p1"]);
    expect(ids(needsInput)).toEqual(["n1", "n2"]);
  });

  it("a declared-dormant home quiet for a day stays Dormant while its daemon heartbeats; with the daemon gone it is the human's again", () => {
    // Declared verdicts skip the quiet-time decay (the agent named its wake),
    // so a day of silence changes nothing — but the dead-daemon leg still
    // applies: nobody can deliver the wake, so the row resurfaces. The
    // replica applies both legs from the replicated heartbeat fact, exactly
    // as the server does (ct-47609).
    const stale = mk("stale", { agent_status: "dormant", updated_at: Date.now() - 24 * 3_600_000, last_heartbeat: NOW - 5_000 });
    const { needsInput, dormant } = cat({ stale });
    expect(ids(dormant)).toEqual(["stale"]);
    const orphaned = mk("orphaned", { agent_status: "dormant", updated_at: Date.now() - 24 * 3_600_000, last_heartbeat: null });
    expect(ids(cat({ orphaned }).needsInput)).toEqual(["orphaned"]);
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

  it("an armed standing trigger's resting home files under Dormant as a FACT, not a pass", () => {
    // Trigger absorption used to be a panel-only pass over the trigger
    // subscription; the armed_trigger_kind fact reaches the shared classifier
    // as data, identically on every replica.
    const { dormant, needsInput } = cat({
      home: mk("home", { armed_trigger_kind: "standing", last_turn_allows_park: true }),
      human: mk("human", { armed_trigger_kind: "standing", last_turn_allows_park: false }),
    });
    expect(ids(dormant)).toEqual(["home"]);
    expect(ids(needsInput)).toEqual(["human"]);
  });
});

// ct-47520 (live prod repro, "Cameron tasks execution"): the pre-chokepoint
// web classifier derived a settled row's rest as
//   waiting && !hard ? sessionRestState(s) : "needs_input"
// so a row that entered the settled split ONLY through the trust-staleness
// net (a frozen is_idle:false copy the liveness overlay no longer refreshes)
// had waiting=false, lost its settle verdict, and filed under Needs Input
// wearing a DORMANT pill — while the server filed the same row Done. The
// chokepoint adapts a stale row exactly as the server's trustedAgentStatus /
// recency-gated is_idle do at enrichment, so the row's own verdicts decide.
describe("ct-47520: a staleness-swept row keeps its rest verdict at the chokepoint", () => {
  const AGED = NOW - (STATUS_TRUST_TTL_MS + 5 * 60_000);
  // Every field from the live card.
  const cameron = mk("cameron", {
    agent_status: "idle",
    is_idle: false,
    thread_state_status: "dormant",
    settle_verdict: "done",
    awaiting_input: false,
    is_unresponsive: false,
    has_pending: false,
    message_count: 277,
    updated_at: AGED,
  });

  it("files the verdict-done, declared-dormant, frozen row under DONE", () => {
    const placed = placeSections({ cameron }, new Set());
    expect(ids(placed.done)).toEqual(["cameron"]);
    expect(placed.needsInput).toEqual([]);
    expect(placed.dormant).toEqual([]);
    expect(placed.working).toEqual([]);
    expect(placed.placements.get("cameron")).toMatchObject({ bucket: "done", work_state: "done" });
    expect(placed.tally.shown.done).toBe(1);
    expect(placed.tally.shown.needs_input).toBe(0);
  });

  it("the sibling with no settle verdict and only a dormant declaration is NEEDS INPUT (dead-daemon rule)", () => {
    // A `dormant` promise with no daemon status behind it has no one to
    // deliver the wake — a human must look. Only `done` rides the
    // declaration fallback.
    const sibling = mk("sibling", { ...cameron, _id: "sibling", settle_verdict: null });
    const placed = placeSections({ sibling }, new Set());
    expect(ids(placed.needsInput)).toEqual(["sibling"]);
    expect(placed.done).toEqual([]);
    expect(placed.dormant).toEqual([]);
    expect(placed.placements.get("sibling")).toMatchObject({ bucket: "needs_input", work_state: "needs_input" });
  });

  it("the live twin (overlay-fresh is_idle:true) places identically — staleness changes nothing about the verdict", () => {
    const live = mk("live", { ...cameron, _id: "live", is_idle: true, updated_at: NOW - 60_000 });
    const placed = placeSections({ live }, new Set());
    expect(ids(placed.done)).toEqual(["live"]);
    expect(placed.needsInput).toEqual([]);
  });

  it("the walk order agrees with the section: the row is a DONE target, never a needs-input one", () => {
    const yourMove = orderSections({ cameron }, new Set(), null, undefined, { yourMove: true });
    expect(ids(yourMove)).toEqual(["cameron"]);
    const placed = placeSections({ cameron, fresh: mk("fresh") }, new Set());
    // needs-input (fresh) walks before done (cameron): rank and section agree.
    expect(ids(orderSections({ cameron, fresh: mk("fresh") }, new Set()))).toEqual(["fresh", "cameron"]);
    expect(ids(placed.needsInput)).toEqual(["fresh"]);
  });
});

describe("orderSections with rest sections", () => {
  it("walks the status view top-down: needs input, done, working, dormant", () => {
    const sessions = {
      n: mk("n"),
      d: mk("d", { agent_status: "done" }),
      w: mk("w", { is_idle: false, agent_status: "working" }),
      p: mk("p", { agent_status: "dormant" }),
    };
    expect(ids(orderSections(sessions, new Set()))).toEqual(["n", "d", "w", "p"]);
  });

  it("an armed trigger's resting home walks with Dormant, not its own bucket", () => {
    const sessions = {
      n: mk("n"),
      home: mk("home", { armed_trigger_kind: "standing", last_turn_allows_park: true, updated_at: BASE - 10 }),
      p: mk("p", { agent_status: "dormant" }),
    };
    expect(ids(orderSections(sessions, new Set()))).toEqual(["n", "p", "home"]);
  });

  it("a collapsed dormant section is skipped", () => {
    const sessions = { n: mk("n"), p: mk("p", { agent_status: "dormant" }) };
    expect(ids(orderSections(sessions, new Set(), null, undefined, { collapsedSections: { dormant: true } })))
      .toEqual(["n"]);
  });
});
