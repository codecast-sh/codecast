// Hydration-time retention policy for the persisted caches, shared by both
// persistence engines (web Dexie idbCache.ts + native kv-store
// idbCache.native.ts) the same way idbCollectionDiff is. The generic partition
// and tombstone expiry live in @platform/engine (cacheRetention / idbCache
// there); this module injects codecast's session-shaped policy.
import { WORKING_SET_RECENCY_MS } from "@codecast/shared/contracts";
import {
  partitionCacheRetention,
  deriveRegistryMaps,
  expireExcludeTombstones as engineExpireExcludeTombstones,
} from "@platform/engine";
import { isConvexId } from "../lib/entityLinks";
import { PR_STATE_OF_KIND, SESSION_COMMIT_KINDS, SESSION_PUSH_KIND, prThreadKey } from "../lib/externalEventOutcomes";
import { CLIENT_SYNC_REGISTRY } from "./clientSyncRegistry";

// The message page the server sends on open (useConversationMessages' snapshot
// fetch). The persisted cache keeps the same tail per conversation, applied
// when a write flushes, never inside a store draft (a copy made there holds
// draft proxies that are revoked before the flush). Persisting every message
// wrote one 24 MB row for an 8337 message transcript, serialized it again on
// every push to that conversation, and made a phone parse 78 MB of such rows
// at boot. Older rows load from the server through hasMoreAbove, exactly as
// they do after a cold open.
export const MESSAGE_PAGE_SIZE = 200;

export function persistedMessageTail<T>(
  messages: readonly T[],
  pagination: Record<string, unknown> | undefined,
): { messages: T[]; pagination: Record<string, unknown> | undefined } {
  if (messages.length <= MESSAGE_PAGE_SIZE) return { messages: messages as T[], pagination };
  return { messages: messages.slice(-MESSAGE_PAGE_SIZE), pagination: { ...(pagination ?? {}), hasMoreAbove: true } };
}

// Retention for the persisted sessions collection, applied at hydration. The
// in-memory sessions map is never-prune BY DESIGN (rows the UI holds must not
// vanish mid-session), which means the on-disk cache is append-only across
// months: every team-board visit, deep link, and crawl top-up leaves a row
// forever. A long-lived install was measured hydrating ~7,000 rows (5k+ older
// than 30 days, 4k belonging to teammates) into a map whose live inbox renders
// ~134 — and every O(N) pass (syncTable, wake signatures, placeInboxRows,
// sortSessions) paid the 7k price on each liveness flip, pinning the main
// thread. Boot is the one safe moment to shed that weight: nothing holds refs
// yet, and everything the UI can actually reach is kept —
//   • the server-authoritative live inbox set (liveInboxIdList),
//   • the restored focus target,
//   • optimistic stubs (non-Convex ids — local truths the server can't restore),
//   • pinned rows (an explicit keep),
//   • stashed/dismissed rows inside the reconcile window (the Stashed/Killed
//     browse views),
//   • anything touched inside the TTL, capped at the newest MAX_CACHED_SESSIONS.
// Anything older is dropped from memory AND disk; it stays reachable via
// search/deep-link, which re-fetch from the server and re-seed the cache.
export const SESSION_CACHE_TTL_MS = WORKING_SET_RECENCY_MS; // the shared recency horizon (server scan, selection, reconcile window)
export const MAX_CACHED_SESSIONS = 1200;

const sessionStampedAt = (row: any): number =>
  Math.max(row.updated_at ?? 0, row._creationTime ?? 0, row.inbox_stashed_at ?? 0, row.inbox_dismissed_at ?? 0);

/**
 * The session rows a change stream may add to a replica that does not hold
 * them: the ones hydration would keep if they were already in the cache beside
 * the rows it holds (in the live inbox, pinned, or inside the TTL and among the
 * newest MAX_CACHED_SESSIONS). The in-memory map never prunes, so whatever a
 * feeder adds stays until the next boot; asking the hydration policy here is
 * what keeps a feeder from adding what that boot would drop. A row that
 * carries no stamp at all cannot be judged old, and is let in.
 */
export function admitUnheldSessions<T extends { _id: string }>(
  candidates: T[],
  held: any[],
  liveInboxIdList: string[] | undefined,
  lastFocusedId: string | null | undefined,
  now: number,
): T[] {
  if (!candidates.length) return candidates;
  const kept = new Set(
    partitionSessionRetention([...held, ...candidates], liveInboxIdList, lastFocusedId, now).keep.map((r) => r._id),
  );
  return candidates.filter((r) => sessionStampedAt(r) === 0 || kept.has(r._id));
}

export function partitionSessionRetention(
  rows: any[],
  liveInboxIdList: string[] | undefined,
  lastFocusedId: string | null | undefined,
  now: number,
): { keep: any[]; drop: string[] } {
  const liveIds = new Set(liveInboxIdList ?? []);
  return partitionCacheRetention(rows, now, {
    ttlMs: SESSION_CACHE_TTL_MS,
    maxRows: MAX_CACHED_SESSIONS,
    alwaysKeep: (row) =>
      liveIds.has(row._id) || row._id === lastFocusedId || !isConvexId(row._id) || !!row.is_pinned,
    stampedAt: sessionStampedAt,
    sortStamp: (row) => row.updated_at ?? 0,
  });
}

// Retention for the persisted docDetails collection (doc bodies + detail
// joins), applied at hydration. Rows enter only when a doc is OPENED (the
// detail query) or body-prefetched for the recent list page, so growth tracks
// what the user actually reads — but nothing ever removed rows, and bodies are
// the heavy bytes the thin `docs` list cache deliberately sheds. Cap by
// last-open recency (`_cachedAt`, stamped by the sync hook) with the doc's own
// updated_at as the fallback for rows from older builds. A dropped body stays
// one round-trip away: opening the doc re-fetches and re-seeds it.
export const DOC_DETAIL_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_CACHED_DOC_DETAILS = 200;

export function partitionDocDetailRetention(
  rows: any[],
  now: number,
): { keep: any[]; drop: string[] } {
  return partitionCacheRetention(rows, now, {
    ttlMs: DOC_DETAIL_CACHE_TTL_MS,
    maxRows: MAX_CACHED_DOC_DETAILS,
    alwaysKeep: (row) => !isConvexId(row._id) || !!row.pinned,
    stampedAt: (row) => Math.max(row._cachedAt ?? 0, row.updated_at ?? 0),
    sortStamp: (row) => Math.max(row._cachedAt ?? 0, row.updated_at ?? 0),
  });
}

// Exclude tombstones never clear for delta tables (absence ≠ deletion in
// applySyncTable), so every kill/dismiss adds a permanent `pending` entry —
// measured at 1,832 entries after a heavy agent fan-out, and each one rides
// every sync push and every persisted pending blob. A tombstone only matters
// while the server could still resend the row, which is bounded by the same
// 30d window as the cache retention above — age them out at hydration. Legacy
// entries without a timestamp get stamped `now` and age out one window later.
// include/field entries are local-first writes awaiting server acknowledgment:
// never expired — except field locks on fields the registry declares
// unprotected (tasks.comments), which no current build can create; stale ones
// persisted by older builds would override every server push forever.
const { isUnprotectedField } = deriveRegistryMaps(CLIENT_SYNC_REGISTRY as any);

export function expireExcludeTombstones(
  pending: Record<string, any>,
  now: number,
): Record<string, any> {
  return engineExpireExcludeTombstones(pending, now, SESSION_CACHE_TTL_MS, isUnprotectedField);
}

// The Messages feed's own sends (mySends): the newest rows, contiguous from
// the top, so "load older" always resumes below the oldest held row. Older
// history stays one page (or one search) away on the server.
export const MAX_CACHED_MY_SENDS = 10_000;

// Retention for the persisted externalEvents collection (git and GitHub
// events), applied at hydration. The team feeder is a window onto the newest
// 200 events and the key is a delta overlay, so every event that ever passed
// through that window stayed in memory and on disk: a busy team adds about
// 3,900 a day. Measured 2026-11-14 on a five-week-old cache: 153,681 rows,
// most of a 223 MB IndexedDB. Every write into the collection then cost about
// 190 ms of main thread (one per incoming event, in bursts during a CI run),
// and the Activity page held its loader for 2 s in a fresh window.
//
// The key has ten readers. Four have a feeder that reaches back in time by an
// index and returns that thing's newest 200 whenever its view mounts: a
// conversation (ConversationView), a pull request (the PR page), a task by its
// `task_id` (the task page), a repository (the commits rail). The rest read
// rows no feeder brings back once they leave a window (the team's newest 200;
// for a plan or a project, a filter over the team's newest 500), so boot
// keeps exactly what each of those reads:
//   - the newest MAX_CACHED_EXTERNAL_EVENTS of each team, of any kind: ten
//     times the window a new device starts with;
//   - each repository's last event, at any age (the Repositories list);
//   - every row that names a plan, a project or a list of tasks, at any age:
//     a plan's "Git & issues" list (PlanDetailPanel), a project's timeline
//     (ProjectTimeline), the task page's `task_ids` match and RepositoryLinks
//     read them by those fields. They are few (1,152 of 153,867);
//   - what the Activity page derives each session's PR chips and commit count
//     from (prThreads and indexOutcomes in components/activity/activityModel):
//     every event that moves a PR's state, the newest event of each PR (its
//     `at`), the newest event tying each PR to each session, and every commit
//     and push a session made. Those rules live in lib/externalEventOutcomes,
//     which the model reads too.
// The last rule works on whole pull requests and whole sessions, never on
// single rows: a PR or a session is live when any of its events is inside the
// working-set horizon or is kept by the rules above it, and whatever a live
// one is tied to is live with it (a session's PRs, a PR's sessions). A live
// PR or session keeps all of the above at any age, so its chips and count
// read the same before and after; one with nothing live goes whole. A live
// session also keeps its own newest event, whatever its kind: a session whose
// only recent event is a pull or a checkout is live by a row no other rule
// keeps, and without that row the next boot would find it dead and drop the
// commits this one kept. Every reason a PR or session is live is a row the
// pass keeps, so a second pass over its own output drops nothing. A cut by
// row would leave a PR merged 31 days ago and touched yesterday reading
// "open" with no title, and a long session with a fifth of its commits. A
// test holds the model's answer equal before and after this pass.
// What goes is the bulk no reader derives anything from once it is old: check
// runs, edits, synchronizes and reviews of a PR beyond the newest one, and
// commits and pushes no session made. A view whose feeder reaches back gets
// its newest 200 again when it mounts, as on a new device; rows past those
// 200 that only this cache held are gone (old check runs of a very long PR).
// (ActivityFeed's team mode also reads this key, filtered by person or
// project, but nothing in the app mounts that mode.)
export const MAX_CACHED_EXTERNAL_EVENTS = 2_000;
export const EXTERNAL_EVENT_OUTCOME_TTL_MS = WORKING_SET_RECENCY_MS;

const externalEventStampedAt = (row: any): number => row.created_at ?? row._creationTime ?? 0;
/** Names a plan, a project or a list of tasks: read by views whose feeders only filter a window of the team's newest rows. */
const externalEventNamesWork = (row: any): boolean =>
  !!(row.plan_ids?.length || row.project_ids?.length || row.task_ids?.length || row.plan_id || row.project_id);
const externalEventPr = (row: any): string | null =>
  row.repository && row.pr_number !== undefined ? prThreadKey(row.repository, row.pr_number) : null;

export function partitionExternalEventRetention(
  rows: any[],
  now: number,
): { keep: any[]; drop: string[] } {
  // Under one team's window nothing can be past it: skip the sort.
  if (rows.length <= MAX_CACHED_EXTERNAL_EVENTS) return { keep: rows, drop: [] };
  const newestFirst = [...rows].sort((a, b) => externalEventStampedAt(b) - externalEventStampedAt(a));
  const horizon = now - EXTERNAL_EVENT_OUTCOME_TTL_MS;

  // First pass, newest first: the rows kept for themselves (a team's window, a
  // repository's last event, a row naming a plan, project or tasks), which PRs
  // and sessions are live, and which rows are the newest of their PR or tie.
  const kept = new Set<any>();
  const newestOfPrOrTie = new Set<any>();
  const newestOfSession = new Set<any>();
  const sessionsSeen = new Set<string>();
  const livePrs = new Set<string>();
  const liveSessions = new Set<string>();
  const sessionsOfPr = new Map<string, Set<string>>();
  const prsOfSession = new Map<string, Set<string>>();
  const perTeam = new Map<string, number>();
  const repositories = new Set<string>();
  const prsSeen = new Set<string>();
  const tiesSeen = new Set<string>();
  for (const row of newestFirst) {
    const team = String(row.team_id ?? "");
    const seenInTeam = perTeam.get(team) ?? 0;
    perTeam.set(team, seenInTeam + 1);
    const lastOfRepository = !!row.repository && !repositories.has(row.repository);
    if (row.repository) repositories.add(row.repository);
    const inWindow = seenInTeam < MAX_CACHED_EXTERNAL_EVENTS || lastOfRepository || externalEventNamesWork(row) || !isConvexId(row._id);
    if (inWindow) kept.add(row);

    const pr = externalEventPr(row);
    const session: string | null = row.conversation_id ? String(row.conversation_id) : null;
    const live = inWindow || externalEventStampedAt(row) >= horizon;
    if (pr) {
      if (!prsSeen.has(pr)) { prsSeen.add(pr); newestOfPrOrTie.add(row); }
      if (live) livePrs.add(pr);
    }
    if (session) {
      if (!sessionsSeen.has(session)) { sessionsSeen.add(session); newestOfSession.add(row); }
      if (live) liveSessions.add(session);
    }
    if (pr && session) {
      const tie = `${pr}|${session}`;
      if (!tiesSeen.has(tie)) {
        tiesSeen.add(tie);
        newestOfPrOrTie.add(row);
        let sessions = sessionsOfPr.get(pr);
        if (!sessions) sessionsOfPr.set(pr, (sessions = new Set()));
        sessions.add(session);
        let prs = prsOfSession.get(session);
        if (!prs) prsOfSession.set(session, (prs = new Set()));
        prs.add(pr);
      }
    }
  }

  // Live spreads along ties, so no live session reads a PR with half its
  // events and no live PR is tied to a session with half its commits.
  const prQueue = [...livePrs];
  const sessionQueue = [...liveSessions];
  while (prQueue.length || sessionQueue.length) {
    const pr = prQueue.pop();
    if (pr !== undefined) {
      for (const session of sessionsOfPr.get(pr) ?? []) {
        if (!liveSessions.has(session)) { liveSessions.add(session); sessionQueue.push(session); }
      }
    }
    const session = sessionQueue.pop();
    if (session !== undefined) {
      for (const tied of prsOfSession.get(session) ?? []) {
        if (!livePrs.has(tied)) { livePrs.add(tied); prQueue.push(tied); }
      }
    }
  }

  const keep: any[] = [];
  const drop: string[] = [];
  for (const row of newestFirst) {
    const kind = row.kind ?? "";
    const pr = externalEventPr(row);
    const session = row.conversation_id ? String(row.conversation_id) : null;
    const outcome =
      (!!pr && livePrs.has(pr) && (kind in PR_STATE_OF_KIND || newestOfPrOrTie.has(row))) ||
      (!!session && liveSessions.has(session) && (SESSION_COMMIT_KINDS.has(kind) || kind === SESSION_PUSH_KIND || newestOfSession.has(row)));
    if (kept.has(row) || outcome) keep.push(row);
    else drop.push(row._id);
  }
  return { keep, drop };
}

// Hydration retention per persisted collection, applied by every cache
// engine (idbCache, idbCache.native). Sessions take the live inbox and the
// focused id as well, so they keep their own call.
export const COLLECTION_RETENTION: Record<string, (rows: any[], now: number) => { keep: any[]; drop: string[] }> = {
  docDetails: partitionDocDetailRetention,
  externalEvents: partitionExternalEventRetention,
  mySends: (rows, now) => partitionCacheRetention(rows, now, {
    ttlMs: Number.POSITIVE_INFINITY,
    maxRows: MAX_CACHED_MY_SENDS,
    alwaysKeep: () => false,
    stampedAt: (row) => row.timestamp ?? 0,
  }),
};
