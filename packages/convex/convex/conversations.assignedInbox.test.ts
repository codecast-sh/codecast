import { describe, expect, test } from "bun:test";
import { computeInboxSessions, scanInboxConversations } from "./conversations";
import { makeFakeDb } from "./testDb";

// A session ASSIGNED to me (session_owners row, run by another account) is a
// deliberate routing act, so it must stay in my inbox regardless of how old it
// is relative to my own activity. Regression for "cast own put 12 decision
// sessions in my inbox, they were gone the next day": the cluster cutoff (a
// >12h gap in the candidate set hides everything older) applied to assigned
// rows too, so `listInboxSessions` marked them hidden, the web reconcile then
// cleared their owned_by_me as an implied disown, and they vanished the moment
// the user clicked away.
describe("assigned sessions and the inbox cluster cutoff", () => {
  const ME = "users_me";
  const OTHER = "users_other";
  const H = 60 * 60 * 1000;
  const NOW = Date.now();

  function fixtures() {
    return makeFakeDb({
      users: [
        { _id: ME, name: "Me", email: "me@example.com" },
        { _id: OTHER, name: "Mr Bot", email: "bot@example.com", is_bot: true },
      ],
      conversations: [
        // My own live activity: now and 13h ago -> a >12h gap between them.
        { _id: "conversations_fresh", user_id: ME, status: "active", updated_at: NOW, message_count: 0 },
        { _id: "conversations_stale", user_id: ME, status: "active", updated_at: NOW - 13 * H, message_count: 0 },
        // My own row past the cutoff — the cruft the cutoff exists to hide.
        { _id: "conversations_older", user_id: ME, status: "active", updated_at: NOW - 40 * H, message_count: 0 },
        // Assigned to me, run by OTHER, last touched 6h ago. If it took part in the
        // gap analysis it would BRIDGE the gap (6h + 7h) and un-hide my stale row.
        { _id: "conversations_assigned", user_id: OTHER, status: "active", updated_at: NOW - 6 * H, message_count: 0 },
        // Assigned to me, run by OTHER, 3 days old — older than the cutoff.
        { _id: "conversations_assigned_old", user_id: OTHER, status: "active", updated_at: NOW - 72 * H, message_count: 0 },
      ],
      session_owners: [
        { _id: "so_1", conversation_id: "conversations_assigned", user_id: ME, added_by: OTHER, added_at: 1 },
        { _id: "so_2", conversation_id: "conversations_assigned_old", user_id: ME, added_by: OTHER, added_at: 2 },
      ],
      managed_sessions: [],
      messages: [],
    });
  }

  test("assigned rows are deliberate: exempt from the cutoff and absent from the gap analysis", async () => {
    const db = fixtures();
    const scan = await scanInboxConversations({ db }, ME as any, NOW, { includeLiveness: false });
    // The gap between my own rows still counts (the assigned row didn't bridge it).
    expect(scan.clusterCutoff).toBe(NOW - 13 * H);
    expect([...scan.deliberateIds].sort()).toEqual(["conversations_assigned", "conversations_assigned_old"]);
    expect(scan.ownedByMeIds.has("conversations_assigned_old")).toBe(true);
  });

  test("listInboxSessions keeps assigned rows visible while hiding my own aged-out row", async () => {
    const db = fixtures();
    const { sessions, hidden_count } = await computeInboxSessions({ db }, ME as any, {
      show_all: false,
      includeLiveness: false,
    });
    const ids = sessions.map((s: any) => s._id).sort();
    // The row AT the cutoff stays (strict <); the one past it hides; the assigned
    // rows stay regardless of age.
    expect(ids).toEqual(["conversations_assigned", "conversations_assigned_old", "conversations_fresh", "conversations_stale"]);
    expect(hidden_count).toBe(1);
    for (const id of ["conversations_assigned", "conversations_assigned_old"]) {
      expect(sessions.find((s: any) => s._id === id)?.owned_by_me).toBe(true);
    }
  });
});

describe("a session I run that I assigned away leaves my inbox", () => {
  const ME = "users_me";
  const THEM = "users_them";
  const NOW = Date.now();

  function fixtures() {
    return makeFakeDb({
      users: [
        { _id: ME, name: "Me", email: "me@example.com" },
        { _id: THEM, name: "Samvit", email: "samvit@example.com" },
      ],
      conversations: [
        {
          _id: "conversations_handed",
          user_id: ME,
          owner_user_id: THEM,
          status: "active",
          updated_at: NOW,
          message_count: 4,
          title: "Infra lead",
        },
        {
          _id: "conversations_mine",
          user_id: ME,
          owner_user_id: ME,
          status: "active",
          updated_at: NOW,
          message_count: 2,
          title: "Still mine",
        },
      ],
      session_owners: [
        { _id: "so_handed", conversation_id: "conversations_handed", user_id: THEM, added_by: ME, added_at: 1 },
        { _id: "so_mine", conversation_id: "conversations_mine", user_id: ME, added_by: ME, added_at: 1 },
      ],
      managed_sessions: [],
      messages: [],
    });
  }

  test("the runner's inbox no longer lists it; the owner's inbox does", async () => {
    const db = fixtures();
    const mine = await computeInboxSessions({ db }, ME as any, { show_all: false, includeLiveness: false });
    expect(mine.sessions.map((s: any) => s._id).sort()).toEqual(["conversations_mine"]);

    const theirs = await computeInboxSessions({ db }, THEM as any, { show_all: false, includeLiveness: false });
    expect(theirs.sessions.map((s: any) => s._id)).toEqual(["conversations_handed"]);
    expect(theirs.sessions[0].owned_by_me).toBe(true);
  });
});

// "Assignment means it is in that person's inbox, always — whatever state it is
// in." The owner seat is admitted on its own: no recency window, no status
// gate, and the hide stamps the previous holder left behind are cleared by the
// handoff itself (sessionOwnership.performReparentSession).
describe("an owned row holds its seat whatever state it is in", () => {
  const ME = "users_me";
  const RUNNER = "users_runner";
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.now();

  function fixtures() {
    return makeFakeDb({
      users: [
        { _id: ME, name: "Me", email: "me@example.com" },
        { _id: RUNNER, name: "Runner", email: "runner@example.com" },
      ],
      conversations: [
        { _id: "conversations_ancient", user_id: RUNNER, status: "active", updated_at: NOW - 90 * DAY, message_count: 7, title: "Handed over weeks ago" },
        { _id: "conversations_failed", user_id: RUNNER, status: "failed", updated_at: NOW - 2 * DAY, message_count: 3, title: "Crashed after the handoff" },
      ],
      session_owners: [
        { _id: "so_a", conversation_id: "conversations_ancient", user_id: ME, added_by: RUNNER, added_at: 1 },
        { _id: "so_f", conversation_id: "conversations_failed", user_id: ME, added_by: RUNNER, added_at: 2 },
      ],
      managed_sessions: [],
      messages: [],
    });
  }

  test("neither the 30-day window nor a non-active status drops it", async () => {
    const { sessions } = await computeInboxSessions({ db: fixtures() }, ME as any, {
      show_all: false,
      includeLiveness: false,
    });
    expect(sessions.map((s: any) => s._id).sort()).toEqual(["conversations_ancient", "conversations_failed"]);
    for (const s of sessions) expect(s.owned_by_me).toBe(true);
  });
});

// The drop that takes an assigned-away session out of the runner's inbox reads
// the OWNER SET, so it must not reach rows that are in the candidate set for
// another reason: a teammate's session on the team board, or a row the caller
// named by id.
describe("the assigned-away drop stays inside the caller's own rows", () => {
  const ME = "users_me";
  const MATE = "users_mate";
  const THIRD = "users_third";
  const NOW = Date.now();
  const TEAM = "teams_1";

  function fixtures() {
    return makeFakeDb({
      users: [
        { _id: ME, name: "Me", email: "me@example.com", team_id: TEAM },
        { _id: MATE, name: "Mate", email: "mate@example.com", team_id: TEAM },
        { _id: THIRD, name: "Third", email: "third@example.com", team_id: TEAM },
      ],
      teams: [{ _id: TEAM, name: "Team" }],
      team_memberships: [
        { _id: "tm_me", team_id: TEAM, user_id: ME },
        { _id: "tm_mate", team_id: TEAM, user_id: MATE },
        { _id: "tm_third", team_id: TEAM, user_id: THIRD },
      ],
      conversations: [
        // A teammate's session, owned by a third person. Nothing to do with me.
        { _id: "conversations_mate", user_id: MATE, owner_user_id: THIRD, status: "active", updated_at: NOW, message_count: 5, team_id: TEAM, is_private: false, title: "Mate's work" },
        // Mine, handed to a teammate.
        { _id: "conversations_handed", user_id: ME, owner_user_id: MATE, status: "active", updated_at: NOW, message_count: 5, title: "Handed over" },
      ],
      session_owners: [
        { _id: "so_mate", conversation_id: "conversations_mate", user_id: THIRD, added_by: MATE, added_at: 1 },
        { _id: "so_handed", conversation_id: "conversations_handed", user_id: MATE, added_by: ME, added_at: 2 },
      ],
      managed_sessions: [],
      messages: [],
    });
  }

  test("team scope keeps the teammate's row; my own handed-over row still goes", async () => {
    const scan = await scanInboxConversations({ db: fixtures() }, ME as any, NOW, {
      includeLiveness: false,
      teamScope: TEAM as any,
    });
    const ids = scan.conversations.map((c: any) => c._id.toString()).sort();
    expect(ids).toEqual(["conversations_mate"]);
  });

  test("naming the id brings my handed-over row back", async () => {
    const scan = await scanInboxConversations({ db: fixtures() }, ME as any, NOW, {
      includeLiveness: false,
      extraConvIds: ["conversations_handed"],
    });
    expect(scan.conversations.map((c: any) => c._id.toString())).toEqual(["conversations_handed"]);
  });
});
