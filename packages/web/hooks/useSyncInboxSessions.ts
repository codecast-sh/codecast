import { useRef, useCallback, useEffect, useState } from "react";
import { useQuery, useMutation, useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, InboxSession, isSessionWaitingForInput, isSub, isConvexId, DISMISS_RECONCILE_WINDOW_MS } from "../store/inboxStore";
import { toast } from "sonner";
import { soundIdle } from "../lib/sounds";
import { useConvexSync } from "./useConvexSync";
import { useRecoveryPoll } from "./useRecoveryPoll";
import { useEnsureDispatch } from "./useEnsureDispatch";
import { useWatchEffect } from "./useWatchEffect";
import { runReconcileCrawl, syncMetaKey } from "./reconcileCrawl";
import { collectGhostSweepCandidates, collectHiddenResurrectionSuspects } from "./ghostSweep";

// Background reconcile for the inbox session list. The live listInboxSessions
// subscription returns only the ~200 most-recently-updated sessions, so idle ones
// sink below that window and are absent from a cold cache. This crawl pages EVERY
// inbox session once and overlays them into the never-prune sessions cache, so the
// completeness floor isn't the live window's recency cap. Per-session enrichment
// (message read + children + plan/task gets) is heavy, so pages stay small — a big
// page times out the UDF. Throttle/incremental semantics mirror the tasks crawl.
// The completeness crawl only backfills the last 30 days of sessions; older ones
// stay reachable via search/open. Mirrors the inbox window — see the server's
// INBOX_SESSION_WINDOW_MS and inbox_30day_session_window.
const SESSIONS_CRAWL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SESSIONS_RECONCILE_PAGE_SIZE = 75;
const SESSIONS_RECONCILE_PAGE_DELAY_MS = 60;
const SESSIONS_RECONCILE_THROTTLE_MS = 30 * 60 * 1000;
// Ghost-sweep policy (age floors + candidate selection) lives in ./ghostSweep
// so the selection is unit-testable without this hook's React/Convex imports.

export function waitingSoundKey(session: InboxSession, queued: Set<string>): string | null {
  if (!isSessionWaitingForInput(session, queued)) return null;
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
    if (session.inbox_dismissed_at) continue;
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

export function useSyncInboxSessions() {
  // Wire the store's server dispatch (split out so a screen can ensure dispatch
  // without these inbox subscriptions — see useEnsureDispatch).
  useEnsureDispatch();

  const convex = useConvex();
  const showAll = useInboxStore((s) => s.clientState.ui?.show_old_sessions ?? true);
  // include_liveness:false — heartbeat-derived liveness rides the separate
  // sessionsLiveness overlay below, so this heavy list re-runs only on real
  // conversation changes instead of on every ~1s heartbeat. The overlay merges
  // agent_status/is_idle/... back onto the cached rows per id via syncOverlay.
  const inboxSessions = useQuery(api.conversations.listInboxSessions, { show_all: showAll, include_liveness: false });
  const sessionLiveness = useQuery(api.conversations.sessionsLiveness, {});
  const clientState = useQuery(api.client_state.get, {});
  const currentUser = useQuery(api.users.getCurrentUser);
  const bgFetchingRef = useRef(new Set<string>());

  const syncTable = useInboxStore((s) => s.syncTable);
  const pruneDrafts = useMutation(api.client_state.pruneDeadDrafts);
  const prunedRef = useRef(false);

  const prevActiveIdsRef = useRef<Set<string> | null>(null);
  const prevWaitingMapRef = useRef<Map<string, boolean> | null>(null);
  const notifiedWaitingKeysRef = useRef(new Map<string, string>());
  const lastSyncRef = useRef(Date.now());
  const lastLivenessSyncRef = useRef(Date.now());
  const lastUserSyncRef = useRef(Date.now());

  // Background-sync messages for inbox sessions so clicks are instant.
  // When session metadata updates arrive, detect sessions with new messages
  // and fetch the delta from Convex. Results go into the store + IDB via mergeMessages.
  const bgSyncMessages = useCallback((sessions: any[]) => {
    const store = useInboxStore.getState();
    for (const session of sessions) {
      const id = session._id as string;
      if (!isConvexId(id) || bgFetchingRef.current.has(id)) continue;
      const storedMsgs = store.messages[id];
      const storedCount = storedMsgs?.length ?? 0;
      const serverCount = session.message_count ?? 0;
      // Skip if we already have all messages or session is empty
      if (serverCount === 0 || (storedCount > 0 && storedCount >= serverCount)) continue;
      const lastTimestamp = storedCount > 0 ? storedMsgs[storedCount - 1].timestamp : 0;
      bgFetchingRef.current.add(id);
      const fetchPage = async (after: number): Promise<void> => {
        const result = await convex.query(api.conversations.getNewMessages, {
          conversation_id: id as Id<"conversations">,
          after_timestamp: after,
        });
        if (!result?.messages?.length) return;
        useInboxStore.getState().mergeMessages(id, result.messages, "append", { initialized: true });
        if (result.has_more && result.last_timestamp != null) {
          await fetchPage(result.last_timestamp);
        }
      };
      fetchPage(lastTimestamp).finally(() => {
        bgFetchingRef.current.delete(id);
      });
    }
  }, [convex]);

  useConvexSync(inboxSessions, useCallback((data: any) => {
    const sessions = data.sessions ?? data;
    // This payload carries null liveness (include_liveness:false); the
    // idle/needs-input sound is driven off the sessionsLiveness overlay below,
    // which is where liveness actually changes. preserveFields on the sessions
    // config keeps the overlay's values from being clobbered by this null.
    syncTable("sessions", sessions as unknown as InboxSession[]);
    if (typeof data.hidden_count === "number") {
      useInboxStore.setState({ hiddenSessionCount: data.hidden_count });
    }
    bgSyncMessages(sessions);
    lastSyncRef.current = Date.now();
  }, [syncTable, bgSyncMessages]), { coalesceMs: 300 });

  // Liveness overlay: a small {convId: {agent_status/is_idle/...}} map merged onto
  // the cached rows (syncOverlay). The ONLY inbox channel that re-runs on heartbeats,
  // and it ships a tiny map instead of the full session list. The idle/needs-input
  // sound lives here because "went idle" IS a liveness change — it reads the post-merge
  // store rows (bounded to the payload's ids) so it sees the overlaid values.
  useConvexSync(sessionLiveness, useCallback((data: any) => {
    const liveness = data?.liveness ?? data;
    if (!liveness || typeof liveness !== "object") return;
    useInboxStore.getState().syncOverlay("sessions", liveness as Record<string, Record<string, any>>);
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

  // Recovery heartbeat: a Convex subscription can silently stall after
  // sleep/wake or WebSocket reconnection, and each one stalls independently.
  // Poll a one-shot query to catch divergence — same pattern as
  // useConversationMessages' watermark loop.
  useRecoveryPoll(lastSyncRef, useCallback(async () => {
    // `_probe` makes this a novel query token so Convex round-trips instead of
    // serving the (possibly stalled) cache of the live listInboxSessions
    // subscription — otherwise the "recovery" just re-reads the staleness.
    const fresh: any = await convex.query(api.conversations.listInboxSessions, { show_all: showAll, include_liveness: false, _probe: Date.now() });
    if (!fresh) return;
    const sessions = fresh.sessions ?? fresh;
    syncTable("sessions", sessions as unknown as InboxSession[]);
    if (typeof fresh.hidden_count === "number") {
      useInboxStore.setState({ hiddenSessionCount: fresh.hidden_count });
    }
    bgSyncMessages(sessions);
    lastSyncRef.current = Date.now();
  }, [convex, showAll, syncTable, bgSyncMessages]), 15_000);

  // Liveness can stall independently of the base list — recover it on the same
  // cadence so a frozen subscription doesn't leave every session reading a stale
  // (or null) agent_status after a sleep/reconnect.
  useRecoveryPoll(lastLivenessSyncRef, useCallback(async () => {
    const fresh: any = await convex.query(api.conversations.sessionsLiveness, { _probe: Date.now() });
    const liveness = fresh?.liveness;
    if (!liveness) return;
    useInboxStore.getState().syncOverlay("sessions", liveness as Record<string, Record<string, any>>);
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
  useEffect(() => {
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
  const sessWsKey = `inbox:${showAll}`;
  const [reconcileNonce, setReconcileNonce] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setReconcileNonce((n) => n + 1), SESSIONS_RECONCILE_THROTTLE_MS);
    // Timers freeze while a tab/window is backgrounded, so a sleeping client
    // misses its ticks exactly while it accumulates staleness — the "ghost
    // cards after wake" vector. Re-tick on wake: the crawls behind this nonce
    // are durably throttled per wsKey (a bump inside the window is a no-op)
    // and the ghost sweep costs nothing when it finds no candidates.
    // `document` is web-only — this hook also runs in the Expo app (no DOM),
    // where backgrounding/wake is handled by the native AppState lifecycle.
    if (typeof document === "undefined") return () => clearInterval(id);
    const onWake = () => {
      if (document.visibilityState === "visible") setReconcileNonce((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    // Incremental top-up after a full backfill; the FIRST pass seeds since=now-30d
    // so the completeness floor only pulls the last 30 days (older sessions stay
    // accessible via search/open). This MUST be a single stable value for the whole
    // crawl — it becomes the paginated index lower bound, and a wall-clock value
    // recomputed per page would make each page a different query (InvalidCursor).
    const meta = useInboxStore.getState().syncMeta[syncMetaKey("sessions", sessWsKey)];
    const crawlSince = meta?.backfilledAt ? meta.cursor : Date.now() - SESSIONS_CRAWL_WINDOW_MS;
    runReconcileCrawl({
      namespace: "sessions",
      wsKey: sessWsKey,
      throttleMs: SESSIONS_RECONCILE_THROTTLE_MS,
      pageDelayMs: SESSIONS_RECONCILE_PAGE_DELAY_MS,
      maxPages: 200,
      fetchPage: async (cursor) => {
        const page: any = await convex.query(api.conversations.listInboxSessionsPaginated, {
          ...(crawlSince !== undefined ? { since: crawlSince } : {}),
          paginationOpts: { numItems: SESSIONS_RECONCILE_PAGE_SIZE, cursor },
        });
        return { rows: page.page ?? [], isDone: page.isDone, continueCursor: page.continueCursor };
      },
      // syncTable("sessions") is isDelta/never-prune (SYNC_REGISTRY) — additive overlay.
      onPage: (rows) => useInboxStore.getState().syncTable("sessions", rows as unknown as InboxSession[]),
      onComplete: (all) => useInboxStore.getState().syncTable("sessions", all as unknown as InboxSession[]),
    });
  }, [convex, sessWsKey, reconcileNonce, hydrated]); // eslint-disable-line react-hooks/exhaustive-deps

  // GHOST SWEEP — the sessions cache is never-prune, so a conversation
  // hard-deleted server-side (cleanup.gcEmptyConversations sweeps abandoned
  // blank "New Session" rows after 24h) would leave a permanent ghost card.
  // Collect cached blank rows old enough for the GC (empty, our own, no local
  // pending state) and VERIFY against the server which still exist; only
  // confirmed-gone ids are pruned (the planted excludes are sticky, so a wrong
  // local delete would blind this client to a live session — verify-then-prune
  // makes that impossible). Runs post-hydration and on the reconcile tick;
  // normally finds zero candidates and costs nothing.
  const lastGhostSweepRef = useRef(0);
  useEffect(() => {
    if (!hydrated) return;
    // Wake events can bump the nonce in bursts (cmd-tab flurries); one
    // existence probe a minute is plenty for a sweep that exists to catch
    // hard-deleted rows.
    if (Date.now() - lastGhostSweepRef.current < 60 * 1000) return;
    lastGhostSweepRef.current = Date.now();
    const store = useInboxStore.getState();
    const { stubs, candidates } = collectGhostSweepCandidates(store);
    if (stubs.length) store.pruneGhostSessions(stubs);
    if (!candidates.length) return;
    convex.query(api.conversations.existingConversationIds, { ids: candidates })
      .then((existing: string[]) => {
        const exists = new Set(existing);
        const gone = candidates.filter((id) => !exists.has(id));
        if (gone.length) useInboxStore.getState().pruneGhostSessions(gone);
      })
      .catch(() => {});
  }, [convex, reconcileNonce, hydrated]);

  // A COMPLETE reconcile's clear pass un-hides every local row absent from the
  // server's hidden set — correct for cross-device restores, catastrophic for
  // conversations hard-deleted server-side (their absence means GONE; un-hiding
  // resurrects a ghost the user can never dismiss again, because dispatch drops
  // patches on missing docs). Disambiguate BEFORE applying: verify the
  // would-be-cleared set's existence and prune confirmed-gone ids (same
  // verify-then-prune contract as the ghost sweep), then run the reconcile —
  // its clear pass now only touches rows that really exist. Suspects are empty
  // in the steady state, so this normally adds no server traffic. On a failed
  // verify (offline/transient) we still apply: a ghost may transiently
  // resurrect, and the next crawl re-verifies.
  const applyHiddenReconcileVerified = useCallback(async (
    rows: Array<{ _id: string }>,
    complete: boolean,
    field: "inbox_dismissed_at" | "inbox_stashed_at",
    apply: (rows: Array<{ _id: string }>, final: boolean) => void,
  ) => {
    if (complete) {
      const suspects = collectHiddenResurrectionSuspects(
        useInboxStore.getState(),
        field,
        new Set(rows.map((r) => r._id)),
      );
      if (suspects.length) {
        try {
          const existing: string[] = await convex.query(api.conversations.existingConversationIds, { ids: suspects });
          const exists = new Set(existing);
          const gone = suspects.filter((id) => !exists.has(id));
          if (gone.length) useInboxStore.getState().pruneGhostSessions(gone);
        } catch {}
      }
    }
    apply(rows, complete);
  }, [convex]);

  // DISMISS RECONCILE — durable cross-device dismiss/un-dismiss propagation.
  // The live listInboxSessions channel only reaches a CONNECTED client, and the
  // session crawl above can't carry a dismiss (dismiss doesn't move updated_at,
  // and the crawl skips dismissed rows). So a device asleep at dismiss time never
  // learns, and the never-prune cache keeps the session active forever. This
  // lightweight crawl pages the CURRENT dismissed set keyed on inbox_dismissed_at
  // ({_id, ts} only — cheap) and overlays it via applyDismissedReconcile: SET on
  // each page, SET + CLEAR on completion. Full scan (no `since`) — a dismiss-only
  // write has no updated_at watermark to resume from, and the set is small.
  useEffect(() => {
    if (!hydrated) return;
    // STABLE window bound for the WHOLE crawl — computed once here, never inside
    // the server handler. The lite queries range-scan their index from this lower
    // bound; a per-page Date.now() would shift the range so each continuation
    // cursor is InvalidCursor, capping the crawl at its first page (~500 rows)
    // and leaving a heavy account's older dismisses unreconciled — they then
    // resurface on other tabs/devices. Mirrors the sessions crawl's `crawlSince`.
    // Must equal the server's INBOX_DISMISSED_WINDOW_MS.
    const hiddenSince = Date.now() - DISMISS_RECONCILE_WINDOW_MS;
    runReconcileCrawl({
      namespace: "dismissed",
      wsKey: sessWsKey,
      throttleMs: SESSIONS_RECONCILE_THROTTLE_MS,
      pageDelayMs: SESSIONS_RECONCILE_PAGE_DELAY_MS,
      maxPages: 50,
      fetchPage: async (cursor) => {
        const page: any = await convex.query(api.conversations.listDismissedSessionsLite, {
          since: hiddenSince,
          paginationOpts: { numItems: 1000, cursor },
        });
        return { rows: page.page ?? [], isDone: page.isDone, continueCursor: page.continueCursor };
      },
      onPage: (rows) => useInboxStore.getState().applyDismissedReconcile(rows as any, false),
      // CLEAR (un-dismiss propagation) runs ONLY on a provably-complete crawl:
      // `complete` is false if the crawl stopped at maxPages, so a truncated set
      // can never wrongly un-dismiss the un-fetched tail.
      onComplete: (all, complete) => applyHiddenReconcileVerified(all as any, complete, "inbox_dismissed_at",
        (rows, final) => useInboxStore.getState().applyDismissedReconcile(rows as any, final)),
    });
    // Stashed twin — same mechanics, keyed on inbox_stashed_at.
    runReconcileCrawl({
      namespace: "stashed",
      wsKey: sessWsKey,
      throttleMs: SESSIONS_RECONCILE_THROTTLE_MS,
      pageDelayMs: SESSIONS_RECONCILE_PAGE_DELAY_MS,
      maxPages: 50,
      fetchPage: async (cursor) => {
        const page: any = await convex.query(api.conversations.listStashedSessionsLite, {
          since: hiddenSince,
          paginationOpts: { numItems: 1000, cursor },
        });
        return { rows: page.page ?? [], isDone: page.isDone, continueCursor: page.continueCursor };
      },
      onPage: (rows) => useInboxStore.getState().applyStashedReconcile(rows as any, false),
      onComplete: (all, complete) => applyHiddenReconcileVerified(all as any, complete, "inbox_stashed_at",
        (rows, final) => useInboxStore.getState().applyStashedReconcile(rows as any, final)),
    });
  }, [convex, sessWsKey, reconcileNonce, hydrated]); // eslint-disable-line react-hooks/exhaustive-deps

  return { activeSessions: inboxSessions };
}
