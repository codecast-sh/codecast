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

// How long a hide/un-hide field override keeps outranking the server's
// authoritative hidden set. The override exists to protect an IN-FLIGHT local
// change; its dispatch settles within seconds. Past this, a disagreement with
// the reconcile crawl means the value was overturned elsewhere (another
// device, or a server-side restore) — and since hidden rows leave the live
// channel, no echo will ever arrive to clear the override. Without this
// release the originating device pins the row hidden FOREVER (ct-36973).
// This is the `triage_gesture` overlay's bound.
export const HIDDEN_OVERRIDE_SETTLE_MS = 5 * 60 * 1000;

// The triage fields whose in-flight pending locks make a row overlay-affected:
// exactly the coupled set the hide/pin gestures stamp (see
// applyHiddenReconcileInDraft's retire list, plus the park/defer twins that
// move a row between rest buckets).
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

// The store state the overlay predicates read. Structural (never the store
// type itself) so the compare module and tests can hand in plain objects.
export type InboxOverlayState = {
  sessions: Record<string, { _id: string; _hasDraft?: boolean } & Record<string, any>>;
  pending: Record<string, { type: string; ts?: number } & Record<string, any>>;
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
  /** Blocked-banner revive stamps (bounded by BLOCKED_REVIVE_TTL_MS). */
  reviveRequestedAt: Readonly<Record<string, number>>;
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
  return {
    now,
    focusedId: state.currentSessionId ?? null,
    pendingCreateIds: new Set(Object.keys(state.pendingSessionCreates ?? {})),
    triagePendingIds: collectTriagePendingIds(state.pending ?? {}, now),
    pendingSendIds: opts?.pendingSendIds ?? new Set([...state.sessionsWithQueuedMessages]),
    reviveRequestedAt: state.blockedReviveRequestedAt ?? {},
    draftIds,
  };
}

// Which declared overlays currently touch this id. Order matches the alphabet.
export function overlaysAffecting(id: string, deps: InboxOverlayDeps): DeclaredInboxOverlay[] {
  const out: DeclaredInboxOverlay[] = [];
  if (!isConvexId(id) || deps.pendingCreateIds.has(id)) out.push("create_stub");
  if (deps.triagePendingIds.has(id)) out.push("triage_gesture");
  if (deps.focusedId != null && id === deps.focusedId) out.push("focused");
  if (deps.pendingSendIds.has(id)) out.push("pending_send");
  const revivedAt = deps.reviveRequestedAt[id];
  if (revivedAt != null && deps.now - revivedAt < BLOCKED_REVIVE_TTL_MS) out.push("revive");
  if (deps.draftIds.has(id)) out.push("draft_blank");
  return out;
}

// The compare's carve-out predicate (C6): an id any declared overlay touches
// is dropped from the per-row diff — local deviation there is intentional,
// bounded, and self-healing, never drift.
export function isOverlayAffected(id: string, deps: InboxOverlayDeps): boolean {
  if (!isConvexId(id) || deps.pendingCreateIds.has(id)) return true;
  if (deps.triagePendingIds.has(id)) return true;
  if (deps.focusedId != null && id === deps.focusedId) return true;
  if (deps.pendingSendIds.has(id)) return true;
  const revivedAt = deps.reviveRequestedAt[id];
  if (revivedAt != null && deps.now - revivedAt < BLOCKED_REVIVE_TTL_MS) return true;
  return deps.draftIds.has(id);
}

// True while ANY declared overlay is active — the digest short-circuit gate:
// with no overlay active a matching digest proves convergence outright; with
// one active the compare must fall through to the per-row diff so it can drop
// exactly the affected ids.
export function anyOverlayActive(deps: InboxOverlayDeps): boolean {
  if (deps.pendingCreateIds.size > 0) return true;
  if (deps.triagePendingIds.size > 0) return true;
  if (deps.focusedId != null) return true;
  if (deps.pendingSendIds.size > 0) return true;
  for (const id in deps.reviveRequestedAt) {
    if (deps.now - deps.reviveRequestedAt[id] < BLOCKED_REVIVE_TTL_MS) return true;
  }
  return deps.draftIds.size > 0;
}
