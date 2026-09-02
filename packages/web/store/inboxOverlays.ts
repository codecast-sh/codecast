// DECLARED OVERLAYS — the ONLY local adjustments a replica may make to the
// shared inbox projection (docs/architecture/sync-convergence.md C5).
//
// Every client-side deviation from "place the replicated rows with the shared
// module" is enumerated HERE, named, and bounded. The digest compare (C6)
// drops overlay-affected ids from its diff instead of reporting them as
// drift, so an overlay that is not on this list is, by definition, a bug the
// compare will catch. Presentation lenses (chip filters, label lenses,
// schedule grouping) are NOT overlays — they narrow rendered rows and can
// never change headline tallies or membership.
//
// This module is a LEAF: it must not import from inboxStore (the store
// imports it), only types and pure helpers.
import { isConvexId } from "../lib/entityLinks";

// The exact overlay alphabet, per the pinned contract:
//
// | overlay        | effect                          | bound                                    |
// |----------------|---------------------------------|------------------------------------------|
// | create_stub    | appears in Working              | until the server row supersedes (altKey) |
// | triage_gesture | moves or removes the row        | until ack or HIDDEN_OVERRIDE_SETTLE_MS   |
// | focused        | stays visible while open        | while focused; never counted outside WS  |
// | pending_send   | Needs Input → Working           | while the queue/outbox holds the send    |
// | revive         | Needs Input → Working           | BLOCKED_REVIVE_TTL_MS (120s)             |
// | draft_blank    | renders a `new` row locally     | rendering only, never counts             |
export const DECLARED_INBOX_OVERLAYS = [
  "create_stub",
  "triage_gesture",
  "focused",
  "pending_send",
  "revive",
  "draft_blank",
] as const;

export type DeclaredInboxOverlay = (typeof DECLARED_INBOX_OVERLAYS)[number];

// How long a blocked-banner revive request keeps its sessions rendered as
// WORKING before the (still-set) server blocked flag is allowed to resurface.
// A switch revive is kill + account swap + restart + resume + first output
// sync — tens of seconds on a healthy daemon. Past this window with the flag
// still set, the revive evidently failed and hiding the blocked state would
// lie. This is the `revive` overlay's bound.
export const BLOCKED_REVIVE_TTL_MS = 120_000;

// How long a triage field override keeps outranking authoritative rows. The
// override exists to protect an IN-FLIGHT local change; its dispatch settles
// within seconds, and its acknowledgement retires it at the write's log
// position (stampSyncAck / retireAckedPending). This bound covers the lock
// with no acknowledgement to come — a bridge-planted retained value, a write
// superseded elsewhere before its echo — which would otherwise re-assert its
// value over every authoritative row forever (ct-36973). This is the
// `triage_gesture` overlay's bound.
export const HIDDEN_OVERRIDE_SETTLE_MS = 5 * 60 * 1000;

// The triage fields whose in-flight pending locks make a row overlay-affected:
// exactly the coupled set the hide/pin gestures stamp (hideSessionInDraft and
// the gesture bridge), plus the park/defer twins that move a row between rest
// buckets.
export const TRIAGE_PENDING_FIELDS = [
  "inbox_dismissed_at",
  "inbox_stashed_at",
  "inbox_pinned_at",
  "is_pinned",
  "inbox_killed_at",
  "inbox_dormant_at",
  "is_dormant",
  "inbox_deferred_at",
  "is_deferred",
] as const;

// A queued/optimistic outbound message is a "pending send" until the server
// echoes it back (which prunes it) or it fails. This is the durable,
// persisted, local-first signal that we've sent something and are waiting to
// confirm delivery — independent of whether ConversationView is mounted.
export function convHasPendingSend(pending?: Array<{ _isFailed?: boolean }>): boolean {
  return !!pending?.some((m) => !m._isFailed);
}

// Conversation ids that currently have an unconfirmed outbound message.
export function sessionsWithPendingSend(
  pendingMessages: Record<string, Array<{ _isFailed?: boolean }>>,
): Set<string> {
  const ids = new Set<string>();
  for (const id in pendingMessages) {
    if (convHasPendingSend(pendingMessages[id])) ids.add(id);
  }
  return ids;
}

// Session ids whose blocked-banner revive request is still inside the trust
// window — the `revive` overlay's member set. The chokepoint folds these into
// the in-flight set (the same "the user already acted" forcing a queued send
// gets) and the banner/pill excludes them, so clicking continue/switch moves
// the fleet instantly.
export function freshReviveRequestIds(
  reviveRequestedAt: Record<string, number> | undefined,
  now: number,
): Set<string> {
  const ids = new Set<string>();
  if (!reviveRequestedAt) return ids;
  for (const id in reviveRequestedAt) {
    if (now - reviveRequestedAt[id] < BLOCKED_REVIVE_TTL_MS) ids.add(id);
  }
  return ids;
}

// The store state the overlay predicates read. Structural (never the store
// type itself) so the compare module and tests can hand in plain objects.
export type InboxOverlayState = {
  sessions: Record<string, { _id: string; _hasDraft?: boolean } & Record<string, any>>;
  pending: Record<string, { type: string; ts?: number } & Record<string, any>>;
  pendingMessages?: Record<string, Array<{ _isFailed?: boolean }>>;
  pendingSessionCreates: Record<string, unknown>;
  currentSessionId: string | null;
  sessionsWithQueuedMessages: ReadonlySet<string>;
  blockedReviveRequestedAt: Record<string, number>;
};

// Deps snapshot: the resolved per-id sets the predicates below consume. Built
// once per compare/placement pass (collectInboxOverlayDeps), then O(1) per id.
export type InboxOverlayDeps = {
  now: number;
  focusedId: string | null;
  /** Ids with an in-flight create (stub ids themselves are also create_stub). */
  pendingCreateIds: ReadonlySet<string>;
  /** Ids with a live pending lock on a triage field (bounded by HIDDEN_OVERRIDE_SETTLE_MS). */
  triagePendingIds: ReadonlySet<string>;
  /** Queued (Ctrl+Enter) or optimistic pending sends still unconfirmed. */
  pendingSendIds: ReadonlySet<string>;
  /** Blocked-banner revive stamps still inside BLOCKED_REVIVE_TTL_MS. */
  reviveIds: ReadonlySet<string>;
  /** Kept-draft blank stubs (`_hasDraft`) rendered as local `new` rows. */
  draftIds: ReadonlySet<string>;
};

// Ids with a live (unexpired) pending lock on a triage field. Keys follow the
// pending-protection convention `${collection}:${id}:${field}` for the two
// collections a triage gesture writes (sessions + conversations).
export function collectTriagePendingIds(
  pending: Record<string, { type: string; ts?: number } & Record<string, any>>,
  now: number,
): Set<string> {
  const ids = new Set<string>();
  for (const key in pending) {
    const entry = pending[key];
    if (!entry || entry.type !== "field") continue;
    const parts = key.split(":");
    if (parts.length < 3) continue;
    const [coll, id, field] = [parts[0], parts[1], parts.slice(2).join(":")];
    if (coll !== "sessions" && coll !== "conversations") continue;
    if (!(TRIAGE_PENDING_FIELDS as readonly string[]).includes(field)) continue;
    // An undated entry cannot be aged — keep protecting it (same rule as the
    // reconcile's lockedLocal).
    if (entry.ts != null && now - entry.ts >= HIDDEN_OVERRIDE_SETTLE_MS) continue;
    ids.add(id);
  }
  return ids;
}

export function collectInboxOverlayDeps(
  state: InboxOverlayState,
  now: number,
  opts?: { pendingSendIds?: ReadonlySet<string> },
): InboxOverlayDeps {
  const draftIds = new Set<string>();
  for (const id in state.sessions) {
    if (state.sessions[id]?._hasDraft) draftIds.add(id);
  }
  // The pending_send members: a queued (Ctrl+Enter) send and an optimistic
  // outbox entry are the same "the user already acted" signal.
  const pendingSendIds = opts?.pendingSendIds
    ?? new Set([...state.sessionsWithQueuedMessages, ...sessionsWithPendingSend(state.pendingMessages ?? {})]);
  return {
    now,
    focusedId: state.currentSessionId ?? null,
    pendingCreateIds: new Set(Object.keys(state.pendingSessionCreates ?? {})),
    triagePendingIds: collectTriagePendingIds(state.pending ?? {}, now),
    pendingSendIds,
    reviveIds: freshReviveRequestIds(state.blockedReviveRequestedAt, now),
    draftIds,
  };
}

// Which declared overlays currently touch this id. Order matches the alphabet.
// THE predicate list: the compare's carve-out and the chokepoint's keep /
// in-flight rules all derive from this one function, so an overlay cannot be
// honored by the renderer and missed by the compare (or the reverse).
export function overlaysAffecting(id: string, deps: InboxOverlayDeps): DeclaredInboxOverlay[] {
  const out: DeclaredInboxOverlay[] = [];
  if (!isConvexId(id) || deps.pendingCreateIds.has(id)) out.push("create_stub");
  if (deps.triagePendingIds.has(id)) out.push("triage_gesture");
  if (deps.focusedId != null && id === deps.focusedId) out.push("focused");
  if (deps.pendingSendIds.has(id)) out.push("pending_send");
  if (deps.reviveIds.has(id)) out.push("revive");
  if (deps.draftIds.has(id)) out.push("draft_blank");
  return out;
}

// The compare's carve-out predicate (C6): an id any declared overlay touches
// is dropped from the per-row diff — local deviation there is intentional,
// bounded, and self-healing, never drift.
export function isOverlayAffected(id: string, deps: InboxOverlayDeps): boolean {
  return overlaysAffecting(id, deps).length > 0;
}

// True while ANY declared overlay is active — the digest short-circuit gate:
// with no overlay active a matching digest proves convergence outright; with
// one active the compare must fall through to the per-row diff so it can drop
// exactly the affected ids. Derived from the deps sizes: every per-id set in
// overlaysAffecting, plus the focused id.
export function anyOverlayActive(deps: InboxOverlayDeps): boolean {
  return (
    deps.focusedId != null ||
    deps.pendingCreateIds.size > 0 ||
    deps.triagePendingIds.size > 0 ||
    deps.pendingSendIds.size > 0 ||
    deps.reviveIds.size > 0 ||
    deps.draftIds.size > 0
  );
}
