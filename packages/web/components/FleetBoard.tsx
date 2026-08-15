"use client";
import { memo, useCallback, useEffect, useMemo } from "react";
import {
  useInboxStore,
  useTrackedStore,
  sessionsWakeSig,
  categorizeSessions,
  filterInboxScope,
  partitionOldSessions,
  sessionsWithPendingSend,
  resolveShowOld,
  resolveInboxHome,
  type InboxSession,
} from "../store/inboxStore";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { LivenessDot, sessionLivenessState } from "./LivenessDot";
import { SegmentedToggle } from "./SegmentedToggle";
import { ErrorBoundary } from "./ErrorBoundary";
import { InboxConversation } from "./GlobalSessionPanel";
import { cleanTitle } from "../lib/conversationProcessor";
import { animatedHideSession } from "../store/undoActions";
import { getSessionRenderKey } from "../store/inboxStore";
import { splitFleetBands, fleetTileMeta, fleetTileContext, fleetTileSummary, fleetProgress, type FleetBand, type FleetBands } from "./fleetBands";

// The fleet board: the inbox home surface when clientState.ui.inbox_home is
// "board" (the default). Every visible session as a dense two-line tile,
// grouped into NEEDS YOU / RUNNING / FINISHED bands — supervision by scanning,
// not reading. Clicking a tile drills in as an OVERLAY over the board (the
// workspace `secondary` slot, presentation "overlay"); close or Escape returns
// to the board. It is never a navigation — the board never unmounts.
//
// PERF CONTRACT (store/wakeSig.ts): with ~30 live sessions heartbeating every
// second, the whole `sessions` collection ref flips constantly. This component
// subscribes ONLY to sessionsWakeSig — a projection of the structural fields
// the bands branch on — so heartbeats never re-render it. Everything
// time-driven (elapsed clocks, TTL reclassification, the progress cue) rides
// useCoarseNow(15s), one shared timer. Do not add a dep on `s.sessions` or on
// a whole row here.

const TONE_CLASS: Record<string, string> = {
  amber: "text-sol-yellow",
  red: "text-sol-red",
  green: "text-sol-text-dim",
  dim: "text-sol-text-dim",
};

const BAND_META: Record<FleetBand, { label: string; accent: string; box: string }> = {
  needsYou: { label: "NEEDS YOU", accent: "text-sol-yellow", box: "border-sol-yellow/30 bg-sol-yellow/[0.03]" },
  running: { label: "RUNNING", accent: "text-sol-green", box: "border-sol-border/40" },
  finished: { label: "FINISHED", accent: "text-sol-text-dim", box: "border-sol-border/30" },
};

/** The Board / Feed switch — writes the persisted per-user pref. */
export function InboxHomeToggle() {
  const value = useInboxStore((s) => resolveInboxHome(s.clientState.ui));
  return (
    <SegmentedToggle
      value={value}
      onChange={(k) => useInboxStore.getState().updateClientUI({ inbox_home: k as "board" | "feed" })}
      items={[
        { key: "board", label: "Board", title: "Fleet board — every session, grouped by state" },
        { key: "feed", label: "Feed", title: "Chronological activity feed" },
      ]}
    />
  );
}

const FleetTile = memo(function FleetTile({
  session,
  band,
  now,
  onOpen,
}: {
  session: InboxSession;
  band: FleetBand;
  now: number;
  onOpen: (id: string) => void;
}) {
  const meta = fleetTileMeta(session, band, now);
  const context = fleetTileContext(session);
  // The blocker line already carries the substance on a needs-you tile; the
  // summary only earns its rows where the state line is generic.
  const summary = band === "needsYou" ? "" : fleetTileSummary(session, now);
  const title = cleanTitle(session.title ?? "") || "Untitled";
  return (
    <button
      onClick={() => onOpen(session._id)}
      title={`${title}\n${context}\n${meta.text}${summary ? `\n${summary}` : ""}`}
      className="relative flex flex-col items-stretch text-left min-w-0 rounded-md border border-sol-border/40 bg-sol-card hover:border-sol-blue/50 hover:bg-sol-bg-highlight/40 transition-colors px-2 pt-1.5 pb-2 overflow-hidden"
    >
      <span className="flex items-center gap-1.5 min-w-0">
        <LivenessDot state={sessionLivenessState(session)} size="xs" className="flex-shrink-0" />
        <span className="truncate text-xs font-medium text-sol-text leading-4">{title}</span>
      </span>
      {context && <span className="block truncate text-[10px] leading-4 text-sol-text-dim/80">{context}</span>}
      {/* line-clamp sets display:-webkit-box — do not add `block`, it wins the
          display war and the clamp silently stops clamping. */}
      <span className={`text-[10px] leading-4 ${TONE_CLASS[meta.tone]} ${band === "needsYou" ? "line-clamp-2" : "block truncate"}`}>
        {meta.text}
      </span>
      {summary && (
        <span className="text-[10px] leading-4 text-sol-text-muted/90 line-clamp-2">{summary}</span>
      )}
      {band === "running" && (
        <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-sol-border/30">
          <span
            className="block h-full bg-sol-green/60"
            style={{ width: `${Math.round(fleetProgress(session, now) * 100)}%` }}
          />
        </span>
      )}
    </button>
  );
});

function BandSection({
  band,
  rows,
  now,
  onOpen,
}: {
  band: FleetBand;
  rows: InboxSession[];
  now: number;
  onOpen: (id: string) => void;
}) {
  const m = BAND_META[band];
  if (rows.length === 0 && band !== "needsYou") return null;
  return (
    <section className={`rounded-lg border p-2 ${m.box}`}>
      <h3 className={`px-1 pb-1.5 text-[10px] font-semibold tracking-[0.15em] ${m.accent}`}>
        {m.label} ({rows.length})
      </h3>
      {rows.length === 0 ? (
        <div className="px-1 pb-1 text-[11px] text-sol-text-dim">nothing needs you right now</div>
      ) : (
        <div className="grid items-stretch gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
          {rows.map((s) => (
            <FleetTile key={s._id} session={s} band={band} now={now} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The drill-in overlay: the conversation in the workspace `secondary` slot
 * with presentation "overlay". Rendered INSIDE the board's stage container so
 * the board stays mounted (and visible at the edges) underneath — a visit,
 * not a home. Esc / ✕ / backdrop click all return to the board.
 */
function FleetDrillIn() {
  const s = useTrackedStore([
    (st) => {
      const sec = st.workspace.secondary;
      return sec.pane?.kind === "conversation" && sec.presentation === "overlay" ? sec.pane.ref : null;
    },
    // Only this row — the whole map would re-render the overlay on every
    // other session's heartbeat (same rule as StageCompanion).
    (st) => {
      const sec = st.workspace.secondary;
      const id = sec.pane?.kind === "conversation" && sec.presentation === "overlay" ? sec.pane.ref : null;
      return id ? st.sessions[id] : null;
    },
  ]);
  const sec = s.workspace.secondary;
  const id = sec.pane?.kind === "conversation" && sec.presentation === "overlay" ? sec.pane.ref : null;
  const session = id ? (s.sessions[id] ?? null) : null;

  const handleClose = useCallback(() => {
    // remember:false — the board owns this slot; closing is bookkeeping, and a
    // sticky dismissal would block the next tile's auto rules for no reason.
    useInboxStore.getState().wsHide("secondary", { remember: false });
  }, []);

  const handleExpand = useCallback(() => {
    if (!id) return;
    // ⤢ leaves the board on purpose: the conversation takes the stage.
    const store = useInboxStore.getState();
    store.wsHide("secondary", { remember: false });
    store.navigateToSession(id);
    store.setShowMySessions(false);
  }, [id]);

  const handleSendAndDismiss = useCallback(() => {
    if (!id) return;
    animatedHideSession(id, "stash");
    useInboxStore.getState().wsHide("secondary", { remember: false });
  }, [id]);

  const open = !!id && !!session;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      // Escape inside an input means "leave the field", not "leave the visit".
      if (t?.closest("input, textarea, [contenteditable='true'], [contenteditable=true]")) return;
      e.preventDefault();
      handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, handleClose]);

  // A drilled-in row that vanished (killed, pruned) closes itself.
  if (!open || !id || !session) return null;

  return (
    <div className="absolute inset-0 z-30 flex" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-sol-bg/70 backdrop-blur-[2px]" onClick={handleClose} />
      <div className="relative m-auto flex h-[94%] w-[min(1100px,96%)] flex-col overflow-hidden rounded-lg border border-sol-border bg-sol-bg shadow-2xl">
        <ErrorBoundary name="FleetDrillIn" level="panel">
          <InboxConversation
            key={getSessionRenderKey(session) || id}
            sessionId={id}
            isIdle={session.is_idle}
            onSendAndAdvance={handleClose}
            onSendAndDismiss={handleSendAndDismiss}
            lastUserMessage={session.last_user_message}
            sessionError={session.session_error}
            onExpandToMain={handleExpand}
            onClose={handleClose}
          />
        </ErrorBoundary>
      </div>
    </div>
  );
}

export function FleetBoard() {
  // Dev probe: render count, inspectable as __fleetBoardRenders in the console.
  // The perf contract above predicts ~1 render per coarse tick (15s) while
  // idle; ~1 per heartbeat (1s × N live sessions) means the wake gating broke.
  if (import.meta.env.DEV) {
    (window as any).__fleetBoardRenders = ((window as any).__fleetBoardRenders ?? 0) + 1;
  }
  const s = useTrackedStore([
    (st) => sessionsWakeSig(st.sessions),
    (st) => st.sessionsWithQueuedMessages,
    (st) => st.pendingMessages,
    (st) => st.liveInboxIds,
    (st) => resolveShowOld(st.clientState.ui),
    (st) => st.clientState.ui?.inbox_scope ?? "mine",
    (st) => st.currentUser?._id?.toString?.() ?? null,
    (st) => st.teamInboxIds,
    (st) => st.currentSessionId,
    (st) => st.pendingSessionCreates,
    (st) => st.blockedReviveRequestedAt,
  ]);
  // Time-driven freshness (elapsed clocks, liveness TTL, blocked-state aging)
  // gets its own low-frequency ticker; the data subscription above only wakes
  // on structural change. 15s is well under every TTL in play.
  const coarseNow = useCoarseNow(15_000);

  const showOld = resolveShowOld(s.clientState.ui);
  const inboxScope = s.clientState.ui?.inbox_scope ?? "mine";
  const meId = s.currentUser?._id?.toString?.() ?? null;
  const focusedId = s.currentSessionId;

  const scoped = useMemo(
    () => filterInboxScope(s.sessions, inboxScope, meId, s.teamInboxIds, focusedId),
    [s.sessions, inboxScope, meId, s.teamInboxIds, focusedId],
  );
  const { visibleSessions } = useMemo(
    () =>
      inboxScope === "team"
        ? { visibleSessions: scoped, oldCount: 0 }
        : partitionOldSessions(scoped, s.liveInboxIds, showOld, focusedId),
    [scoped, inboxScope, s.liveInboxIds, showOld, focusedId],
  );
  const pendingSendIds = useMemo(() => sessionsWithPendingSend(s.pendingMessages), [s.pendingMessages]);
  const blankOpts = useMemo(
    () => ({
      currentSessionId: focusedId,
      pendingCreateIds: new Set(Object.keys(s.pendingSessionCreates)),
      reviveRequestedAt: s.blockedReviveRequestedAt,
    }),
    [focusedId, s.pendingSessionCreates, s.blockedReviveRequestedAt],
  );
  const categorized = useMemo(
    () => categorizeSessions(visibleSessions, s.sessionsWithQueuedMessages, pendingSendIds, blankOpts),
    // coarseNow: categorize reads Date.now() internally for the trust-TTL
    // sweep; the coarse clock re-runs it without heartbeat coupling.
    [visibleSessions, s.sessionsWithQueuedMessages, pendingSendIds, blankOpts, coarseNow],
  );
  const bands: FleetBands = useMemo(
    () => splitFleetBands(categorized, { queued: s.sessionsWithQueuedMessages, pendingSendIds, now: coarseNow }),
    [categorized, s.sessionsWithQueuedMessages, pendingSendIds, coarseNow],
  );

  const handleOpen = useCallback((id: string) => {
    useInboxStore.getState().wsShow("secondary", { kind: "conversation", ref: id }, { presentation: "overlay" });
  }, []);

  const total = bands.needsYou.length + bands.running.length + bands.finished.length;

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto" data-main-scroll>
        <div className="mx-auto max-w-6xl px-4 pb-8 pt-4 sm:px-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-3">
              <h2 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.2em] text-sol-text">
                <span className="h-1.5 w-1.5 rounded-full bg-sol-green animate-pulse" />
                FLEET
              </h2>
              <span className="truncate text-[10px] tracking-[0.1em] text-sol-text-dim">
                {bands.running.length} RUNNING · {bands.needsYou.length} NEED YOU · {bands.finished.length} FINISHED
              </span>
            </div>
            <InboxHomeToggle />
          </div>
          {total === 0 ? (
            <div className="rounded-lg border border-sol-border/30 px-4 py-10 text-center text-sm text-sol-text-dim">
              No sessions yet — start one from the CLI or the composer.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <BandSection band="needsYou" rows={bands.needsYou} now={coarseNow} onOpen={handleOpen} />
              <BandSection band="running" rows={bands.running} now={coarseNow} onOpen={handleOpen} />
              <BandSection band="finished" rows={bands.finished} now={coarseNow} onOpen={handleOpen} />
            </div>
          )}
        </div>
      </div>
      <FleetDrillIn />
    </div>
  );
}
