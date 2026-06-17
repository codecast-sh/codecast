import { DISMISS_RECONCILE_WINDOW_MS, InboxSession, isConvexId } from "../store/inboxStore";

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
// A stranded stub the user typed into is a STUCK message, not cruft — heal it
// (re-create + re-send) rather than prune. The floor only lets a normal
// in-flight create (or an outbox replay mid-boot) settle first; once the create
// has been given up nothing else will ever resolve it.
export const STUB_HEAL_MIN_AGE_MS = 60 * 1000;

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
): { stubs: string[]; candidates: string[]; strandedStubs: string[] } {
  const me = store.currentUser?._id?.toString?.();
  const mine = (s: InboxSession) => !s.user_id || !!(me && s.user_id.toString() === me);
  const blankAndIdle = (s: InboxSession, cutoff: number) =>
    (s.message_count ?? 0) === 0
    && !s.has_pending
    && !s.is_pinned
    && !store.pendingMessages[s._id]?.length
    && !store.pendingSessionCreates[s._id]
    && s._id !== store.currentSessionId
    && mine(s)
    && (s.started_at ?? s.updated_at ?? 0) < cutoff;
  const all = Object.values(store.sessions);
  const stubs = all
    .filter((s) => !isConvexId(s._id) && blankAndIdle(s, now - STUB_SWEEP_MIN_AGE_MS))
    .map((s) => s._id);
  const candidates = all
    .filter((s) => isConvexId(s._id) && blankAndIdle(s, now - GHOST_SWEEP_MIN_AGE_MS))
    .map((s) => s._id)
    .slice(0, 200);
  // A stub (no server conversation) that holds a queued/failed user message and
  // has NO create in flight: its create was given up, so the message can never
  // deliver and the blank-prune above skips it (non-empty) — a permanent stuck
  // ghost. Disjoint from `stubs` by construction (that filter requires zero
  // pending messages). Re-create + re-send heals it; capped because each entry
  // costs a create dispatch.
  //
  // Require a project/git path: the heal re-creates from these stub fields, and
  // a pathless re-create yields a real conversation the daemon still can't spawn
  // (no dir) — i.e. NOT actually unstuck, just a different stuck. This AUTOMATIC
  // sweep stays conservative and skips those; a user who explicitly retries goes
  // through awaitConvexId, which re-creates regardless (a real conv they can
  // re-point still beats a dead ghost). A create site that can resolve a
  // pathless project (e.g. doc-review "New agent" with empty recents) must seed
  // a path for its typed-into stubs to auto-heal here.
  const strandedStubs = all
    .filter((s) =>
      !isConvexId(s._id)
      && !store.pendingSessionCreates[s._id]
      && (store.pendingMessages[s._id]?.length ?? 0) > 0
      && !!(s.project_path || s.git_root)
      && mine(s)
      && (s.started_at ?? s.updated_at ?? 0) < (now - STUB_HEAL_MIN_AGE_MS))
    .map((s) => s._id)
    .slice(0, 20);
  return { stubs, candidates, strandedStubs };
}

// RESURRECTION SUSPECTS — the dismiss/stash reconcile's final CLEAR pass reads
// "hidden locally but absent from the server's hidden set" as "restored on
// another device" and un-hides the row. For a conversation hard-deleted
// server-side that absence means GONE, not restored: the blank-row guard in the
// clear pass doesn't cover deleted rows WITH messages, dispatch.applyPatches
// silently drops hide patches on a missing doc (so the user's dismiss can never
// persist), and the blank-only sweep above never collects them — every dismiss
// resurrects ~5min later, forever (ct-37110). Before applying a complete
// reconcile, the caller runs this would-be-cleared set through the same
// existence verify; confirmed-gone ids are pruned instead of restored.
//
// Own rows only: existingConversationIds vouches solely for the caller's
// conversations, so a teammate's live session would read as "gone" and a prune
// here would blind this client to it (the sticky exclude outlives the mistake).
export function collectHiddenResurrectionSuspects(
  store: {
    sessions: Record<string, InboxSession>;
    currentUser?: { _id?: { toString(): string } } | null;
  },
  field: "inbox_dismissed_at" | "inbox_stashed_at",
  serverHiddenIds: ReadonlySet<string>,
  now: number = Date.now(),
): string[] {
  const me = store.currentUser?._id?.toString?.();
  const cutoff = now - DISMISS_RECONCILE_WINDOW_MS;
  return Object.values(store.sessions)
    .filter((s) => {
      const at = s[field];
      return isConvexId(s._id)
        && !!at && at >= cutoff
        && !serverHiddenIds.has(s._id)
        && (!s.user_id || !!(me && s.user_id.toString() === me));
    })
    .map((s) => s._id)
    .slice(0, 200);
}
