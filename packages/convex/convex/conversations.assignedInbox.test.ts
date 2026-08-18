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
