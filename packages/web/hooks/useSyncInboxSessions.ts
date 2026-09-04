import { useRef, useCallback, useState } from "react";
import { useQuery, useMutation, useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, InboxSession, classifySession, isSub, isConvexId, visualOrderViewSig } from "../store/inboxStore";
import { WORKING_SET_RECENCY_MS } from "@codecast/shared/contracts";
import { warmVisibleSessions } from "./inboxWarm";
import { toast } from "sonner";
import { soundIdle } from "../lib/sounds";
import { useConvexSync } from "./useConvexSync";
import { useRecoveryPoll } from "./useRecoveryPoll";
import { useEnsureDispatch } from "./useEnsureDispatch";
import { useLiveInboxSessions, applyLiveInboxIds, LIST_INBOX_SESSIONS_ARGS } from "./useLiveInboxSessions";
import { onSyncWake } from "./syncWake";
import { useWatchEffect } from "./useWatchEffect";
import { cancelReconcileCrawl, runReconcileCrawl, syncMetaKey } from "./reconcileCrawl";
import { collectGhostSweepCandidates } from "./ghostSweep";
import { applyEntityIds, emptyIdsByCollection } from "./useSyncChangeFeed";

import { useMountEffect } from "./useMountEffect";
// The completeness floor for the inbox session list. The live listInboxSessions
// subscription returns only the ~200 most-recently-updated sessions, so idle ones
// sink below that window and are absent from a cold cache. The floor pages EVERY
// inbox session in the shared recency horizon once into the never-prune sessions
// cache (older sessions stay reachable via search/open). Per-session enrichment
// (message read + children + plan/task gets) is heavy, so pages stay small — a
// big page times out the UDF. Cut once per cold or resynced cache; from then on
// the sync log is the only healer (see the floor effect below).
const SESSIONS_FLOOR_WINDOW_MS = WORKING_SET_RECENCY_MS;
const SESSIONS_FLOOR_PAGE_SIZE = 75;
const SESSIONS_FLOOR_PAGE_DELAY_MS = 60;
// The stub sweep's cadence: a timer plus the wake bus, because timers freeze
// while a window is backgrounded. Purely local cruft cleanup — no server call.
const STUB_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
// Stub-sweep policy (age floors + candidate selection) lives in ./ghostSweep
// so the selection is unit-testable without this hook's React/Convex imports.


export function waitingSoundKey(session: InboxSession, queued: Set<string>): string | null {
  // A message the user just queued means they already acted; a pinned row
  // lives in its own group and never chimes.
  if (queued.has(session._id) || session.is_pinned) return null;
  // Only a genuine claim on the human chimes: the SHARED verdict's
  // needs_input (a delivered or parked settle is quiet) — the server's
  // needs-input push stands down on the same verdict.
  const c = classifySession(session);
  if (!c.waiting || c.rest !== "needs_input") return null;
  const kind = session.awaiting_input
    ? "awaiting_input"
    : session.agent_status === "permission_blocked"
    ? "permission_blocked"
    : session.agent_status || (session.is_unresponsive ? "unresponsive" : "idle");
  return `${session._id}:${session.message_count}:${kind}`;
}

export function shouldPlayWaitingSound(
  sessions: InboxSession[],
  queued: Set<string>,
  prevWaiting: Map<string, boolean> | null,
  notifiedKeys: Map<string, string>,
): { play: boolean; nextWaiting: Map<string, boolean> } {
  let play = false;
  const nextWaiting = new Map<string, boolean>();

  for (const session of sessions) {
    // Stand down on every TRIAGED row — the full set the server stands down on.
    // This sound and the needs-input push (convex/notifications.ts
    // checkNeedsInput) are deliberate mirrors: the server bails on
    // `inbox_dismissed_at || inbox_stashed_at` outright, and on a killed row via
    // classifyWorkState's `killed` precedence. Setting a session aside is the
    // user saying "not now" whichever gesture they used, so all three belong
    // here. `continue` rather than a falsy key on purpose: leaving the id out of
    // nextWaiting makes a later revival re-observe the session fresh, so no
    // chime fires for a waiting episode that began while it was set aside.
    if (session.inbox_dismissed_at || session.inbox_stashed_at || session.inbox_killed_at) continue;
    const id = session._id.toString();
    const key = isSub(session) ? null : waitingSoundKey(session, queued);
    nextWaiting.set(id, !!key);
    if (!key) continue;

    const lastKey = notifiedKeys.get(id);
    if (!prevWaiting?.has(id)) {
      notifiedKeys.set(id, key);
      continue;
    }

    if (lastKey !== key) {
      play = true;
      notifiedKeys.set(id, key);
    }
  }

  return { play, nextWaiting };
}

export function inboxCrawlWsKey(principalId: string | null | undefined): string {
  return principalId ? `inbox:${principalId}` : "skip";
}

// The floor's second half, pure: the cached rows a complete floor did not
// return. A recut floor cannot carry what left the inbox scan while this
// client was away (a killed row is out of it, a deleted row is gone), so
// these are re-read by id through the authorized byIds path: returned rows
// land with their hidden stamps, omitted ids are gone or foreign and prune.
export function floorProbeIds(cached: Iterable<string>, returned: Iterable<string>): string[] {
  const seen = new Set(returned);
  const out: string[] = [];
  for (const id of cached) if (isConvexId(id) && !seen.has(id)) out.push(id);
  return out;
}

export function useSyncInboxSessions() {
  // Wire the store's server dispatch (split out so a screen can ensure dispatch
  // without these inbox subscriptions — see useEnsureDispatch).
  useEnsureDispatch();

  const convex = useConvex();
  // Favorites as full inbox rows, force-loaded regardless of the 30d window so the
  // Favorites view can resolve a months-old kept session. Merged into the SAME
  // sessions cache (delta, never-prune) but deliberately NOT into liveInboxIds —
  // an old favorite reaches the shelf without re-entering the active desk. Liveness
  // rides the sessionsLiveness overlay below, same as the inbox list.
  const favoriteSessions = useQuery(api.conversations.listFavoriteSessions, { include_liveness: false });
  const sessionLiveness = useQuery(api.conversations.sessionsLiveness, {});
  const clientState = useQuery(api.client_state.get, {});
  const currentUser = useQuery(api.users.getCurrentUser);
  // Bookmarks sync lives here (not in the Sidebar) so the store's bookmarks
  // list is populated wherever DashboardLayout mounts — the Sidebar AND every
  // conversation-view bookmark toggle read their on/off state from this one
  // local list, making toggles instant and consistent.
  const bookmarks = useQuery(api.bookmarks.listBookmarks);
  const syncTable = useInboxStore((s) => s.syncTable);
  const pruneDrafts = useMutation(api.client_state.pruneDeadDrafts);
  const prunedRef = useRef(false);

  const prevActiveIdsRef = useRef<Set<string> | null>(null);
  const prevWaitingMapRef = useRef<Map<string, boolean> | null>(null);
  const notifiedWaitingKeysRef = useRef(new Map<string, string>());
  const lastSyncRef = useRef(Date.now());
  const lastLivenessSyncRef = useRef(Date.now());
  const lastUserSyncRef = useRef(Date.now());

  // Message warming: one module-level loop driven by the RENDERED order (see
  // inboxWarm.ts). Every list push, every recovery pass and every change of what
  // the user is looking at (view mode, scope, show-old, chip filter) re-plans it;
  // it is idempotent and cheap once the visible rows sit at their tier depth.
  const warm = useCallback(() => warmVisibleSessions(convex), [convex]);
  const warmViewSig = useInboxStore(visualOrderViewSig);
  useWatchEffect(() => { warm(); }, [warm, warmViewSig]);


  // The base live session list — syncTable + liveInboxIds — is shared with the
  // standalone palette window via useLiveInboxSessions so both windows feed
  // findReusableBlankSession the SAME truth. Here we layer on the message
  // prefetch (instant clicks) and the recovery-poll watermark; the shared payload
  // carries null liveness (include_liveness:false), so the idle/needs-input sound
  // stays on the sessionsLiveness overlay below where liveness actually changes.
  const inboxSessions = useLiveInboxSessions({
    onSync: (sessions) => {
      warm();
      lastSyncRef.current = Date.now();
    },
  });

  // Merge favorites into the session cache WITHOUT touching liveInboxIds — these
  // rows back the Favorites view and the sidebar peek; they must not be treated
  // as the live recent set (that would drag old favorites onto the active desk).
  useConvexSync(favoriteSessions, useCallback((data: any) => {
    const sessions = data?.sessions ?? data;
    if (!Array.isArray(sessions)) return;
    syncTable("sessions", sessions as unknown as InboxSession[]);
    warm();
  }, [syncTable, warm]), { coalesceMs: 500 });

  // Liveness overlay: a small {convId: {facts + projection stamps}} map, plus
  // the projection envelope (sync-convergence C1). The ONLY inbox channel that
  // re-runs on heartbeats. The applier splits it: FACT fields merge onto the
  // cached rows; the STAMPS and envelope land in the "mine" slot of the
  // ephemeral sessionsProjection buffer, never on rows. The idle/needs-input
  // sound lives here because "went idle" IS a liveness change — it reads the
  // post-merge store rows (bounded to the payload's ids) so it sees the
  // overlaid values.
  useConvexSync(sessionLiveness, useCallback((data: any) => {
    const liveness = data?.liveness ?? data;
    if (!liveness || typeof liveness !== "object") return;
    useInboxStore.getState().applyInboxLivenessPayload("mine", data);
    const store = useInboxStore.getState();
    const merged = Object.keys(liveness)
      .map((id) => store.sessions[id])
      .filter(Boolean) as InboxSession[];
    const soundState = shouldPlayWaitingSound(
      merged,
      store.sessionsWithQueuedMessages,
      prevWaitingMapRef.current,
      notifiedWaitingKeysRef.current,
    );
    if (soundState.play) soundIdle();
    prevWaitingMapRef.current = soundState.nextWaiting;
    lastLivenessSyncRef.current = Date.now();
  }, []), { coalesceMs: 300 });

  useConvexSync(clientState, useCallback((data: any) => {
    useInboxStore.getState().syncTable("clientState", data);
    // One-time self-heal: if the server's client_state has accumulated more
    // drafts than Convex can patch (>~1000), prune dead entries. Otherwise
    // every subsequent dispatch that touches client_state would fail with
    // "Object has too many fields".
    if (!prunedRef.current && data?.drafts && typeof data.drafts === "object") {
      const draftCount = Object.keys(data.drafts).length;
      if (draftCount > 800) {
        prunedRef.current = true;
        pruneDrafts({}).catch((e) => console.error("[sync] prune drafts failed", e));
      }
    }
  }, [pruneDrafts]));

  useConvexSync(currentUser, useCallback((data: any) => {
    useInboxStore.getState().syncTable("currentUser", data);
    lastUserSyncRef.current = Date.now();
  }, []));

  useConvexSync(bookmarks, useCallback((data: any) => {
    useInboxStore.getState().syncTable("bookmarks", data);
  }, []));

  // Recovery heartbeat: a Convex subscription can silently stall after
  // sleep/wake or WebSocket reconnection, and each one stalls independently.
  // Poll a one-shot query to catch divergence — same pattern as
  // useConversationMessages' watermark loop.
  useRecoveryPoll(lastSyncRef, useCallback(async () => {
    // `_probe` makes this a novel query token so Convex round-trips instead of
    // serving the (possibly stalled) cache of the live listInboxSessions
    // subscription — otherwise the "recovery" just re-reads the staleness.
    const fresh: any = await convex.query(api.conversations.listInboxSessions, { ...LIST_INBOX_SESSIONS_ARGS, _probe: Date.now() });
    if (!fresh) return;
    const sessions = fresh.sessions ?? fresh;
    syncTable("sessions", sessions as unknown as InboxSession[]);
    applyLiveInboxIds(sessions);
    warm();
    lastSyncRef.current = Date.now();
  }, [convex, syncTable, warm]), 15_000);

  // Liveness can stall independently of the base list — recover it on the same
  // cadence so a frozen subscription doesn't leave every session reading a stale
  // (or null) agent_status after a sleep/reconnect.
  useRecoveryPoll(lastLivenessSyncRef, useCallback(async () => {
    const fresh: any = await convex.query(api.conversations.sessionsLiveness, { _probe: Date.now() });
    const liveness = fresh?.liveness;
    if (!liveness) return;
    // Same applier as the subscription: facts onto rows, stamps + envelope into
    // the "mine" projection slot — a recovery pass must not fork payload shapes.
    useInboxStore.getState().applyInboxLivenessPayload("mine", fresh);
    lastLivenessSyncRef.current = Date.now();
  }, [convex]), 15_000);

  // currentUser carries daemon_last_seen — the input to the CLI-offline banner.
  // Its subscription stalls independently of listInboxSessions (sessions can
  // keep syncing while the user doc freezes), which made the banner climb a
  // false "offline for Nh" while the daemon was healthy. The daemon refreshes
  // this every ~30s via heartbeat, so a 45s gap means the subscription stalled.
  //
  // Probe via getCurrentUserProbe, NOT getCurrentUser: ConvexReactClient.query()
  // returns the locally-cached result of any live subscription sharing the
  // (fn, args) token, so a bare getCurrentUser() probe reads back the exact
  // stale value it's meant to replace. getCurrentUserProbe has no live
  // subscriber, so its token is never cached and this always round-trips.
  useRecoveryPoll(lastUserSyncRef, useCallback(async () => {
    const fresh: any = await convex.query(api.users.getCurrentUserProbe, { _probe: Date.now() });
    if (fresh === undefined) return;
    useInboxStore.getState().syncTable("currentUser", fresh);
    lastUserSyncRef.current = Date.now();
  }, [convex]), 45_000);

  // When the current session becomes dismissed elsewhere and has an
  // implementation session, OFFER the hop — never take it. A server sync must
  // not move the view (that's the "desktop randomly jumps" bug class); the
  // click on the toast is the gesture that authorizes the navigation.
  // eslint-disable-next-line no-restricted-syntax -- toast side effect on session list change
  useWatchEffect(() => {
    if (!inboxSessions) return;
    const sessionsList = (inboxSessions as any).sessions ?? inboxSessions;
    const activeIds = new Set<string>(
      sessionsList.filter((s: any) => !s.inbox_dismissed_at).map((s: any) => s._id.toString())
    );
    const prev = prevActiveIdsRef.current;
    if (prev) {
      const currentSessionId = useInboxStore.getState().currentSessionId;
      const sessions = useInboxStore.getState().sessions;
      const currentSession = currentSessionId ? sessions[currentSessionId] : null;
      if (currentSession && prev.has(currentSession._id) && !activeIds.has(currentSession._id)) {
        const synced = (sessionsList as any[]).find((s) => s._id.toString() === currentSession._id);
        const implId = synced?.implementation_session?._id;
        if (implId) {
          toast.info("This session was handed off to an implementation session", {
            action: {
              label: "Open",
              onClick: () => useInboxStore.getState().navigateToSession(implId),
            },
            duration: 10_000,
          });
        }
      }
    }
    prevActiveIdsRef.current = activeIds;
  }, [inboxSessions]);

  // Publish the inbox's first-load state so the header SyncStatusChip spins
  // during the cold-open "data syncing in" phase. The live subscription returns
  // undefined until the first server response lands; after that it updates in
  // place, so this only lights up on a genuine cold open, not on warm in-app
  // navigation. Kept in `liveLoading` (not `syncProgress`) so the chip tracks
  // this fast first payload, never the minutes-long background reconcile crawl.
  useWatchEffect(() => {
    useInboxStore.getState().setLiveLoading("sessions", inboxSessions === undefined);
  }, [inboxSessions]);

  // BACKGROUND RECONCILE — backfill every inbox session beyond the live window.
  // CRAWL ONLY: we never seed the live listInboxSessions subscription from the
  // watermark. The live channel is the completeness FLOOR; turning it into a
  // since-delta would drop the very floor-only idle sessions this is meant to
  // recover (the regression we hit on tasks). First pass = full backfill; later
  // passes page only sessions changed since the persisted watermark. Gated on
  // hydration so it resumes from the restored watermark, durably throttled so a
  // relaunch within the window serves the hydrated cache. Reuses runReconcileCrawl.
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const redroveHydratedPendingRef = useRef(false);
  useWatchEffect(() => {
    if (!hydrated || redroveHydratedPendingRef.current) return;
    redroveHydratedPendingRef.current = true;
    // Covers the crash-sized gap between a parked create's by_session_id rekey
    // and the timer that queues its first message. Pending bubbles are persisted
    // with client ids, so boot redelivery is safe and server-idempotent.
    const store = useInboxStore.getState();
    store.redrivePendingMessages();
    store.resumePostCreateSessionIntents();
  }, [hydrated]);
  // THE COMPLETENESS FLOOR — once per cold or resynced cache, never on a
  // timer or a wake. It pages every session in the horizon into the cache and
  // stamps backfilledAt (the digest compare's cold-replica gate). Everything
  // after it rides the sync log: every hide, restore, pin, rename and delete
  // is a log action, so there is no set to re-crawl and nothing to reconcile.
  // The watermark clears when the log can no longer prove the gap — retention
  // passed this client's cursor, or a cursor never existed — in the applier's
  // resync path (clearCrawlMetaForScope), and the floor is recut here.
  //
  // Cut after the applier stamped the scope cursors (E8 / D9): a floor
  // queried before the stamp can miss writes that commit between its query
  // and the heads capture. Keyed by the principal: account A's floor must
  // not stand in for account B's.
  const sessWsKey = inboxCrawlWsKey(currentUser?._id?.toString());
  const floorKey = syncMetaKey("sessions", sessWsKey);
  const floorStamped = useInboxStore((s) => !!s.syncMeta[floorKey]?.backfilledAt);
  const logStamped = useInboxStore((s) => currentUser?._id != null && s.syncLogScopeStamps[`user:${String(currentUser._id)}`] !== undefined);
  // eslint-disable-next-line no-restricted-syntax -- cleanup keyed to the principal; cancels an in-flight floor on wsKey change
  useWatchEffect(() => () => cancelReconcileCrawl("sessions"), [sessWsKey]);
  useWatchEffect(() => {
    if (!hydrated || sessWsKey === "skip" || floorStamped || !logStamped) return;
    // ONE stable lower bound for the whole floor — it becomes the paginated
    // index bound, and a wall-clock value recomputed per page would make each
    // page a different query (InvalidCursor).
    const floorSince = Date.now() - SESSIONS_FLOOR_WINDOW_MS;
    const cached = Object.keys(useInboxStore.getState().sessions);
    runReconcileCrawl({
      namespace: "sessions",
      wsKey: sessWsKey,
      // The durable watermark (floorStamped) is the gate; the runner's own
      // throttle must not hold a recut floor back.
      throttleMs: 0,
      pageDelayMs: SESSIONS_FLOOR_PAGE_DELAY_MS,
      maxPages: 200,
      fetchPage: async (cursor) => {
        const page: any = await convex.query(api.conversations.listInboxSessionsPaginated, {
          since: floorSince,
          paginationOpts: { numItems: SESSIONS_FLOOR_PAGE_SIZE, cursor },
        });
        return { rows: page.page ?? [], isDone: page.isDone, continueCursor: page.continueCursor };
      },
      // syncTable("sessions") is isDelta/never-prune (SYNC_REGISTRY) — additive overlay.
      onPage: (rows) => useInboxStore.getState().syncTable("sessions", rows as unknown as InboxSession[]),
      onComplete: async (all) => {
        useInboxStore.getState().syncTable("sessions", all as unknown as InboxSession[]);
        // The warm-cache probe (floorProbeIds): only a cache that had rows
        // before this floor can hold one the floor did not return. Safe on a
        // resumed (partial) floor too — byIds answers with the truth for every
        // id, so the only cost of a wider probe is reads.
        const stale = floorProbeIds(cached, all.map((r: any) => String(r._id)));
        if (stale.length) await applyEntityIds(convex, { ...emptyIdsByCollection(), sessions: stale });
      },
    });
  }, [convex, sessWsKey, hydrated, floorStamped, logStamped]);

  // THE STUB SWEEP — local cruft only. An optimistic create that never landed
  // server-side exists in this cache alone; a stub the user typed into is a
  // stuck message and is re-created instead. Server-side deletions are not
  // this sweep's job: a hard delete is a sync-log delete action, and the log
  // applier prunes the row on authorized absence (useSyncChangeFeed).
  const [sweepNonce, setSweepNonce] = useState(0);
  useMountEffect(() => {
    const id = setInterval(() => setSweepNonce((n) => n + 1), STUB_SWEEP_INTERVAL_MS);
    const offWake = onSyncWake(() => setSweepNonce((n) => n + 1));
    return () => {
      clearInterval(id);
      offWake();
    };
  });
  const lastSweepRef = useRef(0);
  useWatchEffect(() => {
    if (!hydrated) return;
    // Wake events can bump the nonce in bursts (cmd-tab flurries).
    if (Date.now() - lastSweepRef.current < 60 * 1000) return;
    lastSweepRef.current = Date.now();
    const store = useInboxStore.getState();
    const { stubs, strandedStubs } = collectGhostSweepCandidates(store);
    if (stubs.length) store.pruneGhostSessions(stubs);
    // Stranded stubs the user typed into: re-create + re-send so a "New Session"
    // whose create was given up (offline/outage/rate-limit) stops being a
    // permanently stuck ghost. Idempotent server-side, so a stub mid outbox
    // replay just resolves to the same row.
    for (const stubId of strandedStubs) store.healStrandedStub(stubId).catch(() => {});
  }, [sweepNonce, hydrated]);

  return { activeSessions: inboxSessions };
}
