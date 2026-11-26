import { describe, expect, test } from "bun:test";
import { placedRailPlacement, placeInboxRows, railRowPlacement, type InboxSession, type PlacedInbox } from "../../store/inboxStore";
import { fleetBandFor, type FleetBand } from "../../components/fleetBands";
import {
  bandOfStatus,
  sectionOfBucket,
  sectionOfRailKey,
  sessionStatusOf,
  statusOfStanding,
  SECTION_HEADER_STATUS,
  SECTION_STATUSES,
  SESSION_STATUS,
  SESSION_STATUSES,
  type SessionStatus,
  type StatusLive,
} from "../sessionStatus";
import { sessionCardLine } from "../sessionCardLine";
import { splitStatusBands } from "../statusBands";

// The status vocabulary (lib/sessionStatus) against the two rules it replaces
// on screen: the rail's sections (placeInboxRows, the placement chokepoint the
// panel renders, and railRowPlacement, the same per-row step a card reads where
// no section decides) and the Classic board's bands (components/fleetBands
// fleetBandFor). Every case
// says the state, the section the rail files the row under, and the band the
// Classic board gave it, so the table is also the record of where INBOX-1's
// surfaces disagreed and which way each disagreement was settled.

const NOW = 1_700_000_000_000;
let seq = 0;
// A Convex-shaped id: the rail places only real rows (isMemberCandidate).
const row = (extra: Partial<InboxSession> & Record<string, unknown> = {}): InboxSession => ({
  _id: `jx7${String(++seq).padStart(29, "0")}`,
  session_id: `s${seq}`,
  agent_type: "claude_code",
  title: "t",
  message_count: 6,
  // Settled past the idle grace, inside the status trust window.
  updated_at: NOW - 5 * 60_000,
  agent_status_updated_at: NOW - 5 * 60_000,
  started_at: NOW - 30 * 60_000,
  last_heartbeat: NOW - 5_000,
  is_idle: true,
  has_pending: false,
  is_connected: true,
  ...extra,
}) as InboxSession;

const STATE = (text: string, status: string) => ({ thread_state: text, thread_state_status: status, thread_state_at: NOW - 60_000, thread_state_msg_count: 6 });

type Case = {
  name: string;
  row: InboxSession;
  live?: StatusLive;
  /** The state every Modern surface shows. */
  status: SessionStatus;
  /** The bucket the rail's placement files it under. */
  bucket: string;
  /** The band the Classic board gave it (null: the board never showed it). */
  board: FleetBand | null;
};

const CASES: Case[] = [
  { name: "an agent running", row: row({ is_idle: false, agent_status: "working" }), status: "working", bucket: "working", board: "running" },
  // An open prompt files under Decisions (the questions bucket): an ask.
  { name: "an open question", row: row({ awaiting_input: true, agent_status: "idle" }), status: "needs_you", bucket: "questions", board: "needsYou" },
  { name: "a permission prompt", row: row({ agent_status: "permission_blocked", is_idle: false }), status: "needs_you", bucket: "questions", board: "needsYou" },
  { name: "the agent's declared block", row: row({ agent_status: "idle", ...STATE("Migrating\nBlocked: needs a prod key", "blocked") }), status: "needs_you", bucket: "needs_input", board: "needsYou" },
  // INBOX-1: the classifier read an ask in the last message. The rail said
  // Needs You, the board said FINISHED; it is an ask, so Needs you everywhere.
  { name: "a turn that ended on an ask (settle classifier)", row: row({ agent_status: "idle", settle_verdict: "needs_input" }), status: "needs_you", bucket: "needs_input", board: "finished" },
  // A settle the classifier has not read yet files under Needs You on purpose
  // (the safe side: a missed ask stalls work silently), and the card agrees
  // with the section it sits in.
  { name: "a settled turn not yet classified", row: row({ agent_status: "idle" }), status: "needs_you", bucket: "needs_input", board: "finished" },
  { name: "a snooze that came due", row: row({ agent_status: "idle", settle_verdict: "done", inbox_snoozed_until: NOW - 120_000 }), status: "needs_you", bucket: "needs_input", board: "needsYou" },
  { name: "filed under Needs You by the person", row: row({ agent_status: "idle", settle_verdict: "done", user_rest: "needs_input" }), status: "needs_you", bucket: "needs_input", board: "finished" },
  // INBOX-1: failures were yellow in the rail, red or amber text on the board,
  // an amber chip on the card. They are Error, red, everywhere.
  { name: "an API error banner (usage limit)", row: row({ agent_status: "idle", pending_api_error: true, pending_api_error_kind: "limit" }), status: "error", bucket: "needs_input", board: "needsYou" },
  { name: "a crash with output", row: row({ agent_status: "stopped", session_error: "daemon exploded" }), status: "error", bucket: "needs_input", board: "needsYou" },
  { name: "an agent that died mid-task", row: row({ agent_status: "stopped", is_idle: false }), status: "error", bucket: "needs_input", board: "needsYou" },
  { name: "an unresponsive agent", row: row({ agent_status: "idle", is_idle: false, is_unresponsive: true, last_role_is_user: true }), status: "error", bucket: "needs_input", board: "needsYou" },
  // INBOX-1: delivered work was cyan in the rail and grey FINISHED with a
  // yellow dot on the board. Done, cyan.
  { name: "work the classifier calls delivered", row: row({ agent_status: "idle", settle_verdict: "done" }), status: "done", bucket: "done", board: "finished" },
  { name: "work the agent declared done", row: row({ agent_status: null, ...STATE("Shipped the retry fix", "done") }), status: "done", bucket: "done", board: "finished" },
  { name: "a run that exited after declaring done", row: row({ agent_status: "stopped", ...STATE("Shipped", "done") }), status: "done", bucket: "done", board: "finished" },
  // A turn opened after the done pin and the process stopped in it: that turn got no answer.
  { name: "an exit after a turn the done pin never answered", row: row({ agent_status: "stopped", ...STATE("Shipped", "done"), last_turn_at: NOW - 30_000 }), status: "error", bucket: "needs_input", board: "finished" },
  // An exit after the agent parked itself as dormant ended its turn. With a
  // standing trigger into it the trigger resumes it, so it parks; with only
  // its own word for the wake it is the person's move, never a crash.
  { name: "a trigger-run session that exited between runs", row: row({ agent_status: "stopped", armed_trigger_kind: "standing", ...STATE("Waiting on the nightly", "dormant") }), status: "dormant", bucket: "dormant", board: "finished" },
  { name: "an exit after a dormant claim nothing backs", row: row({ agent_status: "stopped", ...STATE("Next nightly wakes me", "dormant") }), status: "needs_you", bucket: "needs_input", board: "finished" },
  // A dormant pin older than the latest turn exempts nothing: the stop is a death to read.
  { name: "an exit after a turn the dormant pin never answered", row: row({ agent_status: "stopped", ...STATE("Next nightly wakes me", "dormant"), last_turn_at: NOW - 30_000 }), status: "error", bucket: "needs_input", board: "finished" },
  { name: "filed as done by the person", row: row({ agent_status: "idle", user_rest: "done" }), status: "done", bucket: "done", board: "finished" },
  // INBOX-1: parked was a dim header in the rail, blue in the lenses and
  // FINISHED on the board. Dormant, blue-grey.
  { name: "an agent parked on a declared wake", row: row({ agent_status: "dormant" }), status: "dormant", bucket: "dormant", board: "finished" },
  { name: "parked by the person", row: row({ agent_status: "idle", user_rest: "dormant" }), status: "dormant", bucket: "dormant", board: "finished" },
  { name: "a snooze still running", row: row({ agent_status: "idle", inbox_snoozed_until: NOW + 3_600_000 }), status: "dormant", bucket: "snoozed", board: null },
  { name: "a blank session coming up", row: row({ message_count: 0, is_connected: false, started_at: NOW - 5_000, updated_at: NOW - 5_000 }), status: "starting", bucket: "new", board: null },
  { name: "a blank session ready for its first message", row: row({ message_count: 0, started_at: NOW - 90_000, updated_at: NOW - 90_000 }), status: "idle", bucket: "new", board: null },
  { name: "stashed", row: row({ agent_status: "idle", inbox_stashed_at: NOW - 1_000 }), status: "stashed", bucket: "stashed", board: null },
  { name: "killed", row: row({ agent_status: "idle", inbox_killed_at: NOW - 1_000, inbox_dismissed_at: NOW - 1_000 }), status: "killed", bucket: "dismissed", board: null },
  // Pinned is where, not what: the row keeps its own verdict.
  { name: "pinned, its turn ended on an ask", row: row({ agent_status: "idle", settle_verdict: "needs_input", inbox_pinned_at: NOW - 1_000, is_pinned: true }), status: "needs_you", bucket: "pinned", board: "finished" },
  { name: "pinned, running", row: row({ is_idle: false, agent_status: "working", inbox_pinned_at: NOW - 1_000, is_pinned: true }), status: "working", bucket: "pinned", board: "running" },
];

const noQueue = { queued: new Set<string>(), pendingSendIds: new Set<string>(), now: NOW };

// A row no placement covers (a process the inbox does not hold) keeps the
// coarse fallback, but with the shared pin and wake rules.
describe("the fallback for a row the inbox does not place", () => {
  const bare = (extra: Record<string, unknown>) => sessionStatusOf({ row: { message_count: 5, updated_at: NOW - 60_000, ...extra } as any, now: NOW });
  test("a done pin older than the latest turn is not done", () => {
    expect(bare({ thread_state_status: "done", thread_state_at: NOW - 120_000 })).toBe("done");
    expect(bare({ thread_state_status: "done", thread_state_at: NOW - 120_000, last_turn_at: NOW - 60_000 })).toBe("idle");
  });
  test("a daemon dormant claim with no verified wake expires; a pinned dormant with no status parks only on a wake", () => {
    // An inbox row spells unset facts as null: it carries them.
    expect(bare({ agent_status: "dormant", agent_status_updated_at: NOW - 3 * 3_600_000, updated_at: NOW - 3 * 3_600_000, last_heartbeat: NOW - 5_000, thread_state_status: null, parked_wake_kind: null })).toBe("needs_you");
    expect(bare({ thread_state_status: "dormant", thread_state_at: NOW - 120_000, parked_wake_kind: "blocker" })).toBe("dormant");
    expect(bare({ thread_state_status: "dormant", thread_state_at: NOW - 120_000 })).toBe("idle");
  });
  test("a hibernated process follows the same pin and wake rules", () => {
    const hib = { agent_status: "hibernated", agent_status_updated_at: NOW - 120_000, last_heartbeat: NOW - 5_000 };
    expect(bare({ ...hib, thread_state_status: "dormant", thread_state_at: NOW - 120_000, parked_wake_kind: "blocker" })).toBe("dormant");
    expect(bare({ ...hib, thread_state_status: "dormant", thread_state_at: NOW - 120_000 })).toBe("idle");
    expect(bare({ ...hib, thread_state_status: "done", thread_state_at: NOW - 120_000 })).toBe("done");
  });
  // The /sessions row for a foreign process carries status, count and
  // heartbeat only (ModernSessionRow): it cannot expire a claim, so it keeps
  // the coarse mapping, and a failure flag still wins over hibernated.
  test("a row without the pin and wake facts keeps the coarse mapping", () => {
    const quiet = { agent_status_updated_at: NOW - 3 * 3_600_000, updated_at: NOW - 3 * 3_600_000, last_heartbeat: NOW - 5_000 };
    expect(bare({ ...quiet, agent_status: "dormant" })).toBe("dormant");
    expect(bare({ ...quiet, agent_status: "hibernated" })).toBe("dormant");
    expect(bare({ ...quiet, agent_status: "hibernated", session_error: "boom" })).toBe("error");
  });
});

describe("the status vocabulary", () => {
  test("nine states, each with its own word, mark and theme colour", () => {
    const words = SESSION_STATUSES.map((s) => SESSION_STATUS[s].word);
    expect(new Set(words).size).toBe(SESSION_STATUSES.length);
    expect(words).toEqual(["Needs you", "Error", "Working", "Starting", "Done", "Sleeping", "Idle", "Stashed", "Closed"]);
    expect(new Set(SESSION_STATUSES.map((s) => SESSION_STATUS[s].mark)).size).toBe(SESSION_STATUSES.length);
    for (const s of SESSION_STATUSES) {
      // Colours come from the sol-* theme tokens only.
      expect(SESSION_STATUS[s].text).toMatch(/^text-(sol-[a-z-]+|\[color:color-mix\(in_srgb,var\(--sol-[a-z-]+\)_\d+%,var\(--sol-[a-z-]+\)\)\])$/);
      expect(SESSION_STATUS[s].color).toMatch(/var\(--sol-/);
    }
    expect(SESSION_STATUS.working.text).toBe("text-sol-green");
    expect(SESSION_STATUS.needs_you.text).toBe("text-sol-yellow");
    expect(SESSION_STATUS.done.text).toBe("text-sol-cyan");
    expect(SESSION_STATUS.error.text).toBe("text-sol-red");
  });

  // The rail's own placement over every case at once, as the panel runs it.
  const rail = placeInboxRows({
    sessions: Object.fromEntries(CASES.map((c) => [c.row._id, c.row])),
    sessionsWithQueuedMessages: new Set<string>(),
    pendingMessages: {},
    clientState: { ui: { inbox_show_old: true } },
    currentUser: { _id: "me" },
    teamInboxIds: new Set<string>(),
    currentSessionId: null,
  } as never, { now: NOW });
  const LISTS: Array<[keyof PlacedInbox, string]> = [
    ["questions", "questions"], ["pinned", "pinned"], ["newSessions", "new"], ["needsInput", "needs_input"], ["done", "done"],
    ["dormant", "dormant"], ["working", "working"], ["stashed", "stashed"], ["snoozed", "snoozed"], ["dismissed", "dismissed"],
  ];
  const railBucketOf = (id: string) => LISTS.find(([list]) => (rail[list] as InboxSession[]).some((r) => r._id === id))?.[1] ?? null;

  for (const c of CASES) {
    test(c.name, () => {
      // The rail files it where the case says (a never-engaged blank it does
      // not draw at all), and the card's word agrees with that section: handed
      // the section, as the panel hands it, the mapping says the state, one the
      // section allows.
      const railBucket = railBucketOf(c.row._id);
      if (railBucket) {
        expect(railBucket).toBe(c.bucket);
        const section = sectionOfBucket(railBucket);
        if (section) {
          expect(SECTION_STATUSES[section]).toContain(c.status);
          expect(sessionStatusOf({ row: c.row, section, now: NOW, live: c.live })).toBe(c.status);
        }
        expect(sessionStatusOf({ row: c.row, placement: placedRailPlacement(rail, c.row._id), now: NOW, live: c.live })).toBe(c.status);
      }
      // Where no section decides (Pinned, the flat and grouped lenses, a
      // nested row, /windows), the row's own placement gives the same word.
      expect(sessionStatusOf({ row: c.row, placement: railRowPlacement(c.row, NOW), now: NOW, live: c.live })).toBe(c.status);
      // The Classic board's band, recorded: the Modern board bands by the
      // rail's placement instead, through the same mapping.
      if (c.board) expect(fleetBandFor(c.row, noQueue)).toBe(c.board);
    });
  }

  test("the rail draws the cases a person can see", () => {
    expect(CASES.filter((c) => c.bucket !== "new").every((c) => railBucketOf(c.row._id) !== null)).toBe(true);
  });

  test("the Modern board bands every row by its rail section, in the case's word", () => {
    const bands = splitStatusBands(rail, { queued: new Set(), pendingSendIds: new Set(), now: NOW });
    const expected = new Map(CASES.map((c) => [c.row._id, c.status]));
    let n = 0;
    for (const [band, tiles] of Object.entries(bands)) {
      for (const t of tiles) {
        n++;
        expect(bandOfStatus(t.status)).toBe(band as never);
        expect(t.status).toBe(expected.get(t.session._id)!);
      }
    }
    // Every case the rail draws in a section the board shows (not set aside,
    // not a blank) has a tile.
    expect(n).toBe(CASES.filter((c) => !["new", "stashed", "snoozed", "dismissed"].includes(c.bucket)).length);
    // Errors ride with Needs you, as they sit in the rail's Needs You section.
    expect(new Set(bands.needs_you.map((t) => t.status))).toEqual(new Set(["needs_you", "error"]));
    // Longest waiting first where the person moves next.
    const waits = bands.needs_you.map((t) => t.session.updated_at ?? 0);
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
  });

  test("facts outside the row: a send in flight, a hosted stop, a pending decide", () => {
    const settled = row({ agent_status: "idle", settle_verdict: "done" });
    expect(sessionStatusOf({ row: settled, now: NOW, placement: railRowPlacement(settled, NOW), live: { pendingSend: true } })).toBe("working");
    expect(sessionStatusOf({ row: settled, now: NOW, placement: railRowPlacement(settled, NOW), live: { asking: true } })).toBe("needs_you");
    expect(sessionStatusOf({ row: settled, now: NOW, section: "needs_input", live: { stopped: true } })).toBe("error");
    expect(sessionStatusOf({ row: settled, now: NOW, section: "hosted_stopped" })).toBe("error");
    expect(sessionStatusOf({ row: settled, now: NOW, section: "questions" })).toBe("needs_you");
    // A banner the person already acted on (a revive or a send) is not an error.
    const limited = row({ agent_status: "idle", pending_api_error: true, pending_api_error_kind: "limit" });
    expect(sessionStatusOf({ row: limited, now: NOW, section: "needs_input", live: { blocked: false } })).toBe("needs_you");
  });

  test("every rail section key the header marks maps to a section the mapping knows", () => {
    for (const [key, status] of Object.entries(SECTION_HEADER_STATUS)) {
      const section = sectionOfRailKey(key);
      expect(section).not.toBeNull();
      expect(SECTION_STATUSES[section!]).toContain(status!);
    }
  });

  test("the palette's standing reads the same words", () => {
    const r = row();
    expect(statusOfStanding({ state: "working", shelf: null }, r, NOW)).toBe("working");
    expect(statusOfStanding({ state: "needs_input", shelf: null }, r, NOW)).toBe("needs_you");
    expect(statusOfStanding({ state: "needs_input", shelf: null }, row({ session_error: "boom" }), NOW)).toBe("error");
    expect(statusOfStanding({ state: "done", shelf: "stashed" }, r, NOW)).toBe("stashed");
    expect(statusOfStanding({ state: "done", shelf: "snoozed" }, r, NOW)).toBe("dormant");
    expect(statusOfStanding({ state: null, shelf: null }, r, NOW)).toBeNull();
  });
});

// A Claude Code subagent drawn under its parent runs inside its parent's turn
// and hands its result back there: once its turn ended it waits on nobody. A
// spawned worker is a session of its own, and one that stopped still waits on
// the person; so does a subagent standing as its own card.
describe("a nested subagent whose turn ended", () => {
  const status = (r: InboxSession, section?: "needs_input", nested = true) =>
    sessionStatusOf({ row: r, now: NOW, section: section ?? null, placement: railRowPlacement(r, NOW), nested });

  test("a finished Claude Code subagent reads Done, not Needs you", () => {
    const sub = row({ is_subagent: true, parent_conversation_id: "jx7parent" });
    expect(railRowPlacement(sub, NOW).bucket).toBe("needs_input");
    expect(status(sub)).toBe("done");
  });

  // The real shape: a child its owners-model parent owns, finished, with no
  // live status. The agent-answers rule files its settled wait Working
  // ("With <owner>"), which used to read Working in every mode.
  test("a finished subagent its session owns reads Done, not the agent-answers Working", () => {
    const sub = row({ is_subagent: true, parent_conversation_id: "jx7parent", owner_session_id: "jx7parent", owners_model: true, owned_by_me: false, status: "completed", agent_status: undefined, is_idle: undefined });
    expect(sessionStatusOf({ row: sub, now: NOW, placement: railRowPlacement(sub, NOW) })).toBe("working");
    expect(status(sub)).toBe("done");
  });

  test("a subagent standing as its own card reads its placement", () => {
    const sub = row({ is_subagent: true, parent_conversation_id: "jx7parent" });
    expect(status(sub, undefined, false)).toBe("needs_you");
    expect(status(row({ is_subagent: true, parent_conversation_id: "jx7parent", inbox_adopted_at: NOW - 1000 }), undefined, false)).toBe("needs_you");
  });

  test("a spawned worker waiting on the person still reads Needs you", () => {
    expect(status(row({ is_subagent: true, spawned_by_conversation_id: "jx7parent" }))).toBe("needs_you");
    expect(status(row({ spawned_by_conversation_id: "jx7parent", agent_status: "idle" }))).toBe("needs_you");
  });

  test("a subagent still producing, with a live status, a pending ask or a send keeps it", () => {
    expect(status(row({ is_subagent: true, agent_status: "idle" }))).toBe("needs_you");
    const busy = row({ is_subagent: true, agent_status: undefined, is_idle: false, updated_at: NOW - 2_000 });
    expect(status(busy)).not.toBe("done");
    const sub = row({ is_subagent: true });
    expect(sessionStatusOf({ row: sub, now: NOW, placement: railRowPlacement(sub, NOW), live: { asking: true }, nested: true })).toBe("needs_you");
    expect(sessionStatusOf({ row: sub, now: NOW, placement: railRowPlacement(sub, NOW), live: { pendingSend: true }, nested: true })).toBe("working");
    expect(status(row({ is_subagent: true, pending_api_error: true, pending_api_error_kind: "limit" }))).toBe("error");
    expect(status(row({ is_subagent: true, inbox_stashed_at: NOW - 1000 }))).toBe("stashed");
  });

  test("a section the row sits in still decides", () => {
    expect(status(row({ is_subagent: true }), "needs_input")).toBe("needs_you");
  });
});

describe("the card's second line", () => {
  test("a failure says what failed", () => {
    const r = row({ agent_status: "idle", pending_api_error: true, pending_api_error_kind: "limit", idle_summary: "Refactor the retry path" });
    const line = sessionCardLine({ row: r, status: "error", now: NOW, summary: "Refactor the retry path" });
    expect(line.reason).toBe("Limit");
    expect(line.text).toBe("Refactor the retry path");
  });

  test("the agent's own line outranks the summary, and the summary the prompt", () => {
    const r = row({ idle_summary: "Summary", last_user_message: "do it" });
    expect(sessionCardLine({ row: r, status: "done", now: NOW, stateLine: "Pinned line", summary: "Summary", prompt: "do it" })).toMatchObject({ text: "Pinned line", prompt: false, rest: ["Summary", "> do it"] });
    expect(sessionCardLine({ row: r, status: "done", now: NOW, summary: "Summary", prompt: "do it" })).toMatchObject({ text: "Summary", rest: ["> do it"] });
    expect(sessionCardLine({ row: r, status: "done", now: NOW, prompt: "do it" })).toMatchObject({ text: "do it", prompt: true, rest: [] });
  });

  test("the person's own move in flight is said whatever the state", () => {
    const r = row();
    expect(sessionCardLine({ row: r, status: "needs_you", now: NOW, live: { restarting: true } }).reason).toBe("Restarting");
    expect(sessionCardLine({ row: r, status: "done", now: NOW, live: { pendingSend: true } }).reason).toBe("Sending");
    expect(sessionCardLine({ row: r, status: "stashed", now: NOW, live: { pendingSend: true } }).reason).toBeNull();
  });

  test("a snooze says when it ends; a draft shows its words", () => {
    const snoozed = row({ inbox_snoozed_until: NOW + 3_600_000 });
    expect(sessionCardLine({ row: snoozed, status: "dormant", now: NOW }).reason).toMatch(/^Until /);
    const draft = row({ message_count: 0, _hasDraft: true });
    expect(sessionCardLine({ row: draft, status: "idle", now: NOW, draft: "try the retry budget" })).toMatchObject({ reason: "Draft", text: "try the retry budget" });
  });
});
