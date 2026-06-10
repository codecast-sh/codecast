import { InboxSession, isConvexId } from "../store/inboxStore";

// GHOST SWEEP policy — the sessions cache is never-prune, so a conversation
// hard-deleted server-side would leave a permanent ghost card. The sweep
// collects cached blank rows (empty, our own, no local pending state) and
// VERIFIES against the server which still exist; only confirmed-gone ids are
// pruned (the planted excludes are sticky, so a wrong local delete would blind
// the client to a live session — verify-then-prune makes that impossible).

// Verify-then-prune only drops confirmed-gone ids, so sweeping young blank rows
// is safe at any age — this floor just avoids re-verifying the blank a summon
// only just minted. It used to sit above the GC's 24h grace (back then deletion
// could ONLY happen after it); now dismissing a blank reaps it
// (dispatch.applyPatches → cleanup.reapEmptyConversation) and the hard-delete
// can land at ANY age: immediately when the pre-warm's agent is already dead,
// or deferred behind the agent kill + next GC pass when it was live. While the
// dismissed row still exists, the dismiss reconcile carries its state to other
// clients; once hard-deleted there is NO sync channel (absent from the live
// set, gone from by_user_dismissed) — this sweep is the only healer for their
// cached copies, so it must ask while rows are young or ghosts ride the
// never-prune cache (and IDB) across reloads.
export const GHOST_SWEEP_MIN_AGE_MS = 15 * 60 * 1000;
// Orphaned stubs only need to outlive the create/outbox-replay handoff (seconds
// in practice); past this they can never become sessions — pure local cruft.
export const STUB_SWEEP_MIN_AGE_MS = 2 * 60 * 60 * 1000;

// Pure candidate selection, exported for tests. Stubs (optimistic ids whose
// create never landed) exist only in this client's cache — there is nothing to
// verify, so they're directly prunable. Convex-id blanks are only candidates
// for the server existence check.
export function collectGhostSweepCandidates(
  store: {
    sessions: Record<string, InboxSession>;
    pendingMessages: Record<string, unknown[]>;
    pendingSessionCreates: Record<string, unknown>;
    currentSessionId: string | null;
    currentUser?: { _id?: { toString(): string } } | null;
  },
  now: number = Date.now(),
): { stubs: string[]; candidates: string[] } {
  const me = store.currentUser?._id?.toString?.();
  const blankAndIdle = (s: InboxSession, cutoff: number) =>
    (s.message_count ?? 0) === 0
    && !s.has_pending
    && !s.is_pinned
    && !store.pendingMessages[s._id]?.length
    && !store.pendingSessionCreates[s._id]
    && s._id !== store.currentSessionId
    && (!s.user_id || !!(me && s.user_id.toString() === me))
    && (s.started_at ?? s.updated_at ?? 0) < cutoff;
  const all = Object.values(store.sessions);
  const stubs = all
    .filter((s) => !isConvexId(s._id) && blankAndIdle(s, now - STUB_SWEEP_MIN_AGE_MS))
    .map((s) => s._id);
  const candidates = all
    .filter((s) => isConvexId(s._id) && blankAndIdle(s, now - GHOST_SWEEP_MIN_AGE_MS))
    .map((s) => s._id)
    .slice(0, 200);
  return { stubs, candidates };
}
