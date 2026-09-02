import { InboxSession, isConvexId } from "../store/inboxStore";

// STUB SWEEP policy — the sessions cache is never-prune, and an optimistic
// create that never landed server-side (a stub id) exists in this client's
// cache alone: no server channel can ever remove it, so this sweep does.
// Server-side deletions are not its job: a hard delete is a sync-log delete
// action, applied on authorized absence by the log applier.

// Orphaned stubs only need to outlive the create/outbox-replay handoff (seconds
// in practice); past this they can never become sessions — pure local cruft.
export const STUB_SWEEP_MIN_AGE_MS = 2 * 60 * 60 * 1000;
// A stranded stub the user typed into is a STUCK message, not cruft — heal it
// (re-create + re-send) rather than prune. The floor only lets a normal
// in-flight create (or an outbox replay mid-boot) settle first; once the create
// has been given up nothing else will ever resolve it.
export const STUB_HEAL_MIN_AGE_MS = 60 * 1000;

// Pure candidate selection, exported for tests.
export function collectGhostSweepCandidates(
  store: {
    sessions: Record<string, InboxSession>;
    pendingMessages: Record<string, unknown[]>;
    pendingSessionCreates: Record<string, unknown>;
    currentSessionId: string | null;
    currentUser?: { _id?: { toString(): string } } | null;
  },
  now: number = Date.now(),
): { stubs: string[]; strandedStubs: string[] } {
  const me = store.currentUser?._id?.toString?.();
  const mine = (s: InboxSession) => !s.user_id || !!(me && s.user_id.toString() === me);
  const blankAndIdle = (s: InboxSession, cutoff: number) =>
    (s.message_count ?? 0) === 0
    && !s.has_pending
    // A kept draft (compose popup's "save draft") is deliberate user state, not
    // cruft — it renders as an inbox card and must outlive every janitor until
    // sent or dismissed.
    && !s._hasDraft
    && !store.pendingMessages[s._id]?.length
    && !store.pendingSessionCreates[s._id]
    && s._id !== store.currentSessionId
    && mine(s)
    && (s.started_at ?? s.updated_at ?? 0) < cutoff;
  const all = Object.values(store.sessions);
  // Pinned STUBS are still swept: a stub with no create in flight can never
  // become a real session, and its pin exists only in this device's cache (the
  // server never had the row, so the pin patch was dropped). Exempting them
  // made a pinned orphan immortal — the one flag the user set disabled the
  // only janitor that could remove it.
  const stubs = all
    .filter((s) => !isConvexId(s._id) && blankAndIdle(s, now - STUB_SWEEP_MIN_AGE_MS))
    .map((s) => s._id);
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
  return { stubs, strandedStubs };
}
