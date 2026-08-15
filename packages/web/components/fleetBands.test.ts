import { describe, expect, it } from "bun:test";
import { fleetBandFor, splitFleetBands, fleetTileMeta, fleetProgress } from "./fleetBands";
import type { InboxSession } from "../store/inboxStore";

const NOW = 1_700_000_000_000;
const noQueue = { queued: new Set<string>(), pendingSendIds: new Set<string>(), now: NOW };

let seq = 0;
const sess = (extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: `c${++seq}`,
  session_id: `s${seq}`,
  // Fresh by default: within the liveness TTLs relative to NOW.
  updated_at: NOW - 10_000,
  agent_type: "claude_code",
  message_count: 3,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: "t",
  ...extra,
});

describe("fleetBandFor", () => {
  it("puts a running agent in RUNNING", () => {
    expect(fleetBandFor(sess({ is_idle: false, agent_status: "working" }), noQueue)).toBe("running");
  });

  it("keeps a finished turn with a live background task in RUNNING, not FINISHED", () => {
    // "waiting" is an ACTIVE agent status: the harness will re-invoke the
    // agent when its background task ends, so the ball is not with the human.
    expect(fleetBandFor(sess({ is_idle: false, agent_status: "waiting" }), noQueue)).toBe("running");
  });

  it("puts a plain finished turn in FINISHED, not NEEDS YOU", () => {
    expect(fleetBandFor(sess({ is_idle: true, message_count: 12 }), noQueue)).toBe("finished");
  });

  it("escalates an open question to NEEDS YOU", () => {
    expect(fleetBandFor(sess({ awaiting_input: true }), noQueue)).toBe("needsYou");
  });

  it("escalates a permission prompt to NEEDS YOU", () => {
    expect(fleetBandFor(sess({ agent_status: "permission_blocked", is_idle: false }), noQueue)).toBe("needsYou");
  });

  it("escalates an API/rate-limit error to NEEDS YOU", () => {
    expect(fleetBandFor(sess({ pending_api_error: true, pending_api_error_kind: "limit" }), noQueue)).toBe("needsYou");
  });

  it("escalates a session error to NEEDS YOU", () => {
    expect(fleetBandFor(sess({ session_error: "daemon exploded" }), noQueue)).toBe("needsYou");
  });

  it("treats a cleanly finished run (stopped + idle) as FINISHED, never NEEDS YOU", () => {
    // "stopped" + idle is the NORMAL end state of a run in real accounts (the
    // inbox's needs-input bucket counts these; the board must not).
    expect(fleetBandFor(sess({ agent_status: "stopped", is_idle: true, message_count: 40 }), noQueue)).toBe("finished");
  });

  it("escalates a mid-task death (stopped while NOT idle) to NEEDS YOU", () => {
    expect(
      fleetBandFor(sess({ agent_status: "stopped", is_idle: false, updated_at: NOW - 10 * 60_000 }), noQueue),
    ).toBe("needsYou");
  });

  it("escalates an unresponsive non-idle agent to NEEDS YOU", () => {
    expect(fleetBandFor(sess({ is_unresponsive: true, is_idle: false, agent_status: "working" }), noQueue)).toBe("needsYou");
  });

  it("escalates an active-looking agent that went silent past the liveness TTL", () => {
    // agent_status frozen on "working" but nothing heard for 2h → the status
    // is a lie; a silently dead worker is the user's to revive.
    expect(
      fleetBandFor(sess({ is_idle: false, agent_status: "working", updated_at: NOW - 2 * 60 * 60_000 }), noQueue),
    ).toBe("needsYou");
  });

  it("escalates a fresh declared-blocked thread state even when idle", () => {
    const s = sess({
      is_idle: true,
      thread_state: "Blocked: needs a prod key before the last check",
      thread_state_status: "blocked",
      thread_state_at: NOW - 60_000,
      thread_state_msg_count: 3,
    });
    expect(fleetBandFor(s, noQueue)).toBe("needsYou");
  });

  it("an in-flight send outranks everything — the tile reads RUNNING", () => {
    const s = sess({ awaiting_input: true });
    expect(fleetBandFor(s, { ...noQueue, queued: new Set([s._id]) })).toBe("running");
  });
});

describe("splitFleetBands", () => {
  it("orders NEEDS YOU longest-waiting first and FINISHED most recent first", () => {
    const oldBlocked = sess({ awaiting_input: true, updated_at: NOW - 3 * 60 * 60_000 });
    const newBlocked = sess({ awaiting_input: true, updated_at: NOW - 5 * 60_000 });
    const oldDone = sess({ updated_at: NOW - 2 * 60 * 60_000 });
    const newDone = sess({ updated_at: NOW - 60_000 });
    const bands = splitFleetBands(
      { pinned: [], needsInput: [newBlocked, oldBlocked], working: [oldDone, newDone], newSessions: [] },
      noQueue,
    );
    expect(bands.needsYou.map((s) => s._id)).toEqual([oldBlocked._id, newBlocked._id]);
    expect(bands.finished.map((s) => s._id)).toEqual([newDone._id, oldDone._id]);
  });

  it("includes a just-spawned blank as RUNNING but drops never-engaged stubs", () => {
    const starting = sess({ message_count: 0, agent_status: "starting", is_idle: false });
    const stub = sess({ message_count: 0 });
    const bands = splitFleetBands(
      { pinned: [], needsInput: [], working: [], newSessions: [starting, stub] },
      noQueue,
    );
    expect(bands.running.map((s) => s._id)).toEqual([starting._id]);
    expect(bands.finished).toHaveLength(0);
  });

  it("classifies pinned rows by state like any other tile", () => {
    const pinnedRunning = sess({ is_pinned: true, is_idle: false, agent_status: "working" });
    const bands = splitFleetBands(
      { pinned: [pinnedRunning], needsInput: [], working: [], newSessions: [] },
      noQueue,
    );
    expect(bands.running.map((s) => s._id)).toEqual([pinnedRunning._id]);
  });
});

describe("fleetTileMeta", () => {
  it("NEEDS YOU shows the actual blocker, not generic status", () => {
    const s = sess({
      awaiting_input: true,
      thread_state: "Blocked: which schema wins?",
      thread_state_status: "blocked",
      thread_state_at: NOW - 60_000,
      thread_state_msg_count: 3,
    });
    const meta = fleetTileMeta(s, "needsYou", NOW);
    expect(meta.text).toContain("which schema wins?");
    expect(meta.tone).toBe("amber");
  });

  it("falls back to the idle summary for a question with no thread state", () => {
    const s = sess({ awaiting_input: true, idle_summary: "Asked which port to bind" });
    expect(fleetTileMeta(s, "needsYou", NOW).text).toBe("asks: Asked which port to bind");
  });

  it("labels rate limits in red", () => {
    const meta = fleetTileMeta(sess({ pending_api_error: true, pending_api_error_kind: "limit" }), "needsYou", NOW);
    expect(meta.text).toContain("rate limited");
    expect(meta.tone).toBe("red");
  });

  it("tells a fatal api error apart from a self-retrying one", () => {
    // A terminal status (400/404/…) parks the turn for good, so the tile names
    // the remedy; a retryable 429/5xx is still being retried by the CLI and
    // must not claim the user has to act.
    const fatal = fleetTileMeta(sess({ pending_api_error: true, pending_api_error_kind: "fatal" }), "needsYou", NOW);
    expect(fatal.text).toContain("send continue");
    const retrying = fleetTileMeta(sess({ pending_api_error: true, pending_api_error_kind: "error" }), "needsYou", NOW);
    expect(retrying.text).toContain("retrying");
  });

  it("RUNNING shows model, message count, and elapsed", () => {
    const s = sess({ is_idle: false, model: "claude-opus-5", message_count: 789, updated_at: NOW - 12 * 60_000 });
    expect(fleetTileMeta(s, "running", NOW).text).toBe("opus-5 · 789 msgs · 12m");
  });

  it("FINISHED shows a relative completion time", () => {
    const s = sess({ updated_at: NOW - 3 * 60 * 60_000 });
    expect(fleetTileMeta(s, "finished", NOW).text).toBe("finished · 3h ago");
  });
});

describe("fleetProgress", () => {
  it("uses real workflow progress when present", () => {
    const s = sess({ workflow_run_agents_done: 3, workflow_run_agents_total: 4 });
    expect(fleetProgress(s, NOW)).toBe(0.75);
  });

  it("decays with silence otherwise, never below the visible floor", () => {
    const fresh = fleetProgress(sess({ updated_at: NOW }), NOW);
    const quiet = fleetProgress(sess({ updated_at: NOW - 10 * 60_000 }), NOW);
    const dead = fleetProgress(sess({ updated_at: NOW - 60 * 60_000 }), NOW);
    expect(fresh).toBe(1);
    expect(quiet).toBeLessThan(fresh);
    expect(dead).toBe(0.05);
  });
});
