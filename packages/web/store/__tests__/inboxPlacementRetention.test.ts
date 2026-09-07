import { afterEach, expect, it } from "bun:test";
import { __resetInboxPlacementCacheForTests, placeInboxRows, type InboxSession, type PlaceInboxState } from "../inboxStore";

afterEach(__resetInboxPlacementCacheForTests);

function populatePlacementCache() {
  const now = Date.now();
  const me = "u".repeat(32);
  const id = "a".repeat(32);
  const states: WeakRef<PlaceInboxState>[] = [];
  const results: WeakRef<ReturnType<typeof placeInboxRows>>[] = [];
  for (let generation = 0; generation < 50; generation++) {
    const row = {
      _id: id, session_id: "retention-test", agent_type: "claude_code", user_id: me,
      status: "active", message_count: 6, is_idle: false, has_pending: false,
      title: `generation-${generation}`, updated_at: now, last_heartbeat: now, daemon_alive_until: now + 90_000,
    } as InboxSession;
    const state = {
      sessions: { [id]: row }, sessionsWithQueuedMessages: new Set(), pendingMessages: {},
      clientState: { ui: { inbox_scope: "mine", inbox_show_old: true } }, currentUser: { _id: me },
      sessionDecisions: {}, questionResolutions: {}, pendingSessionCreates: {}, blockedReviveRequestedAt: {},
      currentSessionId: null, sessionsProjection: {}, teamInboxIds: new Set(), pending: {},
    } as unknown as PlaceInboxState;
    states.push(new WeakRef(state));
    results.push(new WeakRef(placeInboxRows(state, { scope: "mine", now })));
  }
  return { states, results };
}

it("bounds retained placement results and input states across recomputations", async () => {
  __resetInboxPlacementCacheForTests();
  const { states, results } = populatePlacementCache();
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    Bun.gc(true);
  }
  expect(states.filter((ref) => ref.deref()).length).toBeLessThanOrEqual(8);
  expect(results.filter((ref) => ref.deref()).length).toBeLessThanOrEqual(8);
});
