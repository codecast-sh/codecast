import { describe, expect, it } from "bun:test";
import { fleetBandFor, fleetCountedSessions, fleetSessionSig, fleetSessionsWakeSig, splitFleetBands, fleetTileMeta, fleetTileContext, fleetTileSummary, fleetProgress } from "./fleetBands";
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

  it("files a finished turn with a live background task as FINISHED, never NEEDS YOU", () => {
    // "waiting" is a settle verdict, not production: the harness will re-invoke
    // the agent when its background task ends, so the ball is not with the
    // human — but nothing is running either, so the tile must not read as such.
    // The server settles is_idle for it; a still-unsettled row rides the same
    // liveness rule as any other quiet status.
    expect(fleetBandFor(sess({ is_idle: true, agent_status: "waiting" }), noQueue)).toBe("finished");
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

  it("RUNNING shows the live status and elapsed; context line carries model and count", () => {
    const s = sess({ is_idle: false, agent_status: "thinking", model: "claude-opus-5", message_count: 789, updated_at: NOW - 12 * 60_000, git_root: "/Users/x/src/codecast" });
    expect(fleetTileMeta(s, "running", NOW).text).toBe("thinking · 12m");
    expect(fleetTileContext(s)).toBe("codecast · opus-5 · 789 msgs");
  });

  it("context line includes the worktree when the session runs in one", () => {
    const s = sess({ git_root: "/Users/x/src/codecast", worktree_name: "fix-auth", model: "claude-fable-5" });
    expect(fleetTileContext(s)).toBe("codecast/fix-auth · fable-5 · 3 msgs");
  });

  it("FINISHED shows a relative completion time", () => {
    const s = sess({ updated_at: NOW - 3 * 60 * 60_000 });
    expect(fleetTileMeta(s, "finished", NOW).text).toBe("finished · 3h ago");
  });
});

describe("fleetTileSummary", () => {
  it("prefers a fresh thread-state line, falls back to the idle summary", () => {
    const withState = sess({
      idle_summary: "Session insight headline",
      thread_state: "Status: deploying pass 3\nNext: verify",
      thread_state_status: "working",
      thread_state_at: NOW - 60_000,
      thread_state_msg_count: 3,
    });
    // threadStateCardLine strips the Status:/Blocked: prefix.
    expect(fleetTileSummary(withState, NOW)).toBe("deploying pass 3");
    expect(fleetTileSummary(sess({ idle_summary: "Session insight headline" }), NOW)).toBe("Session insight headline");
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

describe("fleetSessionSig — the wake gate for always-mounted fleet surfaces", () => {
  // The point of the signature: the people window's roster is open for hours,
  // and every live session on the team heartbeats at it the whole time.
  it("does NOT move on a heartbeat", () => {
    const before = sess({ updated_at: NOW - 10_000 });
    const after = { ...before, updated_at: NOW, last_heartbeat: NOW } as InboxSession;
    expect(fleetSessionSig(after)).toBe(fleetSessionSig(before));
  });

  it("does NOT move while a reply streams in", () => {
    // message_count climbs token by token. The band asks only whether there is
    // ANY output, so 3 messages and 40 sign the same.
    const before = sess({ message_count: 3 });
    const after = { ...before, message_count: 40 } as InboxSession;
    expect(fleetSessionSig(after)).toBe(fleetSessionSig(before));
  });

  it("DOES move when the first message lands, because that flips hasOutput", () => {
    const before = sess({ message_count: 0 });
    const after = { ...before, message_count: 1 } as InboxSession;
    expect(fleetSessionSig(after)).not.toBe(fleetSessionSig(before));
  });

  it("DOES move when a pinned state goes stale from messages piling up", () => {
    const before = sess({ thread_state: "x", thread_state_msg_count: 10, message_count: 12 });
    const after = { ...before, message_count: 10 + 200 } as InboxSession;
    expect(fleetSessionSig(after)).not.toBe(fleetSessionSig(before));
  });

  it("DOES move on every field the band actually branches on", () => {
    const base = sess();
    const changes: Array<Partial<InboxSession>> = [
      { agent_status: "working" },
      { is_idle: false },
      { awaiting_input: true },
      { session_error: "boom" },
      { pending_api_error: true },
      { is_unresponsive: true },
      { has_pending: true },
      { inbox_killed_at: NOW },
      { inbox_dismissed_at: NOW },
      { inbox_stashed_at: NOW },
      { is_pinned: true },
      { is_anchor: true } as Partial<InboxSession>,
      { user_id: "u2" },
      { title: "other" },
      { thread_state: "parked" },
      { thread_state_at: NOW },
      { thread_state_status: "blocked" },
    ];
    for (const change of changes) {
      expect(fleetSessionSig({ ...base, ...change } as InboxSession)).not.toBe(
        fleetSessionSig(base),
      );
    }
  });

  it("the collection signature is stable across a heartbeat on any member", () => {
    const a = sess({ _id: "a" });
    const b = sess({ _id: "b" });
    const before = { a, b };
    // A new collection ref with one row heartbeating — exactly what a mutative
    // store push looks like, and exactly what must NOT wake the roster.
    const after = { a, b: { ...b, updated_at: NOW, message_count: 99 } as InboxSession };
    expect(fleetSessionsWakeSig(after)).toBe(fleetSessionsWakeSig(before));
    const real = { a, b: { ...b, awaiting_input: true } as InboxSession };
    expect(fleetSessionsWakeSig(real)).not.toBe(fleetSessionsWakeSig(before));
  });
});

describe("fleetCountedSessions", () => {
  // Convex-shaped ids (32 lowercase alphanumerics) so the working-set
  // selection actually engages — a non-Convex id is an optimistic stub,
  // always visible.
  const cid = (n: number) => `c${String(n).padStart(31, "0")}`;
  const byId = (rows: InboxSession[]) => Object.fromEntries(rows.map((r) => [r._id, r]));
  const ids = (rows: InboxSession[]) => rows.map((r) => r._id).sort();
  const countOpts = (
    team: string[] = [],
    meId: string | null = "me",
  ) => ({ ...noQueue, teamInboxIds: new Set(team), meId });

  it("never counts a row the user set aside, even with a live agent", () => {
    const working = sess({ _id: cid(1), is_idle: false, agent_status: "working" });
    const stashed = sess({ _id: cid(2), is_idle: false, agent_status: "working", inbox_stashed_at: NOW });
    const dismissed = sess({ _id: cid(3), awaiting_input: true, inbox_dismissed_at: NOW });
    const killed = sess({ _id: cid(4), awaiting_input: true, inbox_killed_at: NOW });
    const rows = fleetCountedSessions(byId([working, stashed, dismissed, killed]), countOpts());
    expect(ids(rows)).toEqual([cid(1)]);
  });

  it("counts a needs-input row still in the inbox window regardless of age", () => {
    // The 21-hour-old triggered-task session on another machine/project: the
    // inbox shows it, so the card must count it — this is what the old 6h
    // recency filter silently dropped. A lone stale row has no fresher
    // neighbor to open the fold gap, so it stays above the fold.
    const old = sess({ _id: cid(1), awaiting_input: true, updated_at: NOW - 21 * 3600_000 });
    const rows = fleetCountedSessions(byId([old]), countOpts());
    expect(ids(rows)).toEqual([cid(1)]);
    expect(fleetBandFor(old, noQueue)).toBe("needsYou");
  });

  it("hides a row below the fold (the 12h activity-gap cut), pinned exempt", () => {
    // computeFold: a >12h gap in the recent members' activity puts everything
    // STRICTLY OLDER than the row at the gap below the fold; the gap row
    // itself is the cut and stays. Pinned rows are a deliberate window — fold
    // exempt, and they can't bridge the gap either.
    const inWindow = sess({ _id: cid(3), is_idle: false, agent_status: "working" });
    const edge = sess({ _id: cid(4), updated_at: NOW - 15 * 3600_000 });
    const aged = sess({ _id: cid(1), awaiting_input: true, updated_at: NOW - 16 * 3600_000 });
    const pinnedAged = sess({ _id: cid(2), awaiting_input: true, is_pinned: true, updated_at: NOW - 17 * 3600_000 });
    const rows = fleetCountedSessions(byId([aged, pinnedAged, inWindow, edge]), countOpts());
    expect(ids(rows)).toEqual([cid(2), cid(3), cid(4)]);
  });

  it("counts teammate rows only while the team subscription reports them", () => {
    const mine = sess({ _id: cid(1), user_id: "me", is_idle: false, agent_status: "working" });
    const teammate = sess({ _id: cid(2), user_id: "them", is_idle: false, agent_status: "working" });
    // Team scope: their row rides teamInboxIds.
    expect(ids(fleetCountedSessions(byId([mine, teammate]), countOpts([cid(2)]))))
      .toEqual([cid(1), cid(2)]);
    // Mine scope (team set cleared): the working-set selection doesn't read
    // authorship, but the cached teammate row has frozen liveness and must
    // not be counted (the isForeignRow arm).
    expect(ids(fleetCountedSessions(byId([mine, teammate]), countOpts())))
      .toEqual([cid(1)]);
  });

  it("drops never-engaged blank stubs; a spawn counts once its first message lands", () => {
    // Same rule as the board: a pre-warm blank isn't work, and a remote spawn
    // enters via the working bucket the moment it carries a message.
    const spawned = sess({ _id: cid(1), message_count: 1, is_idle: false, agent_status: "working" });
    const stub = sess({ _id: cid(2), message_count: 0 });
    const rows = fleetCountedSessions(byId([spawned, stub]), countOpts());
    expect(ids(rows)).toEqual([cid(1)]);
  });
});
