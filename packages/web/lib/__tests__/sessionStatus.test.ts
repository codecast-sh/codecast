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

describe("the status vocabulary", () => {
  test("nine states, each with its own word, mark and theme colour", () => {
    const words = SESSION_STATUSES.map((s) => SESSION_STATUS[s].word);
    expect(new Set(words).size).toBe(SESSION_STATUSES.length);
    expect(words).toEqual(["Needs you", "Error", "Working", "Starting", "Done", "Dormant", "Idle", "Stashed", "Killed"]);
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
