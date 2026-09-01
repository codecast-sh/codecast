"use client";
import { memo, useCallback, useEffect, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import {
  useInboxStore,
  useTrackedStore,
  sessionsWakeSig,
  pendingSendWakeSig,
  placeInboxRows,
  sessionsWithPendingSend,
  resolveShowOld,
  resolveInboxHome,
  type InboxSession,
} from "../store/inboxStore";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { LivenessDot } from "./LivenessDot";
import { sessionLivenessState } from "../lib/liveness";
import { SegmentedToggle } from "./SegmentedToggle";
import { ErrorBoundary } from "./ErrorBoundary";
import { InboxConversation } from "./GlobalSessionPanel";
import { cleanTitle } from "../lib/conversationProcessor";
import { animatedHideSession } from "../store/undoActions";
import { getSessionRenderKey } from "../store/inboxStore";
import { splitFleetBands, fleetTileMeta, fleetTileContext, fleetTileSummary, fleetProgress, type FleetBand, type FleetBands } from "./fleetBands";
import { useTitlebarHead } from "../hooks/useTitlebarHead";
import { overlayConversationId } from "../store/workspace";
import { useContextMenu, ContextMenu } from "./ui/context-menu";
import { SessionMenuItems } from "./menus/ObjectContextMenus";
import { isForeignSession } from "../lib/liveEntities";
import { useTriggerKillNotice } from "../hooks/useTriggerKillNotice";

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

// Four visual levels per tile, in reading order:
//   1. TITLE   — the anchor: largest, heaviest, full-contrast.
//   2. STATE   — the second beat: bold, COLORED by meaning (amber = your move,
//                red = broken, green = alive, grey = done). This is what you
//                scan a band by, so it must be the loudest thing after the title.
//   3. BODY    — the summary: normal weight, muted, readable, clamped.
//   4. FOOTER  — project · model · msgs: smallest, dimmest, uppercase tracking
//                so it reads as metadata, not content.
// A colored rail on the tile's left edge repeats the state color so a band
// reads as a color field even before you read a word.
const TONE: Record<string, { text: string; rail: string }> = {
  amber: { text: "text-sol-yellow", rail: "bg-sol-yellow" },
  red: { text: "text-sol-red", rail: "bg-sol-red" },
  green: { text: "text-sol-green", rail: "bg-sol-green" },
  dim: { text: "text-sol-text-dim", rail: "bg-sol-border" },
};

const BAND_META: Record<FleetBand, { label: string; accent: string; box: string; count: string }> = {
  needsYou: {
    label: "NEEDS YOU",
    accent: "text-sol-yellow",
    box: "border-sol-yellow/40 bg-sol-yellow/[0.05]",
    count: "bg-sol-yellow text-sol-bg",
  },
  running: {
    label: "RUNNING",
    accent: "text-sol-green",
    box: "border-sol-green/30 bg-sol-green/[0.045]",
    count: "bg-sol-green text-sol-bg",
  },
  finished: {
    label: "FINISHED",
    accent: "text-sol-text-dim",
    box: "border-transparent bg-sol-bg-alt/40",
    count: "bg-sol-border/60 text-sol-text-dim",
  },
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
  onContextMenu,
}: {
  session: InboxSession;
  band: FleetBand;
  now: number;
  onOpen: (id: string) => void;
  onContextMenu?: (e: ReactMouseEvent, session: InboxSession) => void;
}) {
  const meta = fleetTileMeta(session, band, now);
  const tone = TONE[meta.tone];
  const context = fleetTileContext(session);
  // The blocker line already carries the substance on a needs-you tile; the
  // summary only earns its rows where the state line is generic.
  const summary = band === "needsYou" ? "" : fleetTileSummary(session, now);
  const title = cleanTitle(session.title ?? "") || "Untitled";
  const finished = band === "finished";
  return (
    <button
      onClick={() => onOpen(session._id)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, session) : undefined}
      title={`${title}\n${context}\n${meta.text}${summary ? `\n${summary}` : ""}`}
      className={`group relative flex min-w-0 flex-col items-stretch overflow-hidden rounded-md border text-left transition-colors ${
        band === "needsYou"
          ? "border-sol-yellow/50 bg-sol-card shadow-sm hover:border-sol-yellow hover:shadow"
          : band === "running"
          ? "border-sol-green/35 bg-[color-mix(in_srgb,var(--sol-green)_6%,var(--sol-card))] shadow-sm hover:border-sol-green/70 hover:shadow"
          : "border-sol-border/30 bg-transparent hover:bg-sol-card hover:border-sol-border/60"
      } pl-3 pr-2.5 pt-2 pb-2.5`}
    >
      {/* State rail: the band's color, at the edge, before any text. */}
      <span className={`absolute inset-y-0 left-0 ${finished ? "w-[2px] opacity-30" : "w-[4px] opacity-100"} ${tone.rail}`} />

      {/* 1. Title — the anchor. */}
      <span className="flex items-start gap-1.5 min-w-0">
        <LivenessDot state={sessionLivenessState(session)} size="xs" className="mt-[5px] flex-shrink-0" />
        <span className={`line-clamp-2 text-[13px] leading-[1.2] tracking-tight ${finished ? "font-medium text-sol-text-muted" : "font-bold text-sol-text"}`}>
          {title}
        </span>
      </span>

      {/* 2. State — bold and colored; the scan target. line-clamp sets
          display:-webkit-box, so no `block` here or the clamp stops working. */}
      <span className={`mt-1.5 leading-4 ${tone.text} ${finished ? "text-[10.5px] font-medium" : "text-[11.5px] font-bold"} ${band === "needsYou" ? "line-clamp-2" : "truncate"}`}>
        {meta.text}
      </span>

      {/* 3. Body — the summary, readable but clearly subordinate. */}
      {summary && (
        <span className={`mt-0.5 line-clamp-2 text-[11px] leading-[1.35] ${finished ? "text-sol-text-dim" : "text-sol-text-muted"}`}>{summary}</span>
      )}

      {/* 4. Footer — metadata, deliberately the quietest thing on the tile. */}
      {context && (
        <span className="mt-auto pt-1.5 block truncate text-[9.5px] uppercase tracking-[0.08em] text-sol-text-dim/70">
          {context}
        </span>
      )}

      {band === "running" && (
        <span className="absolute bottom-0 left-[3px] right-0 h-[2px] bg-sol-border/25">
          <span
            className="block h-full bg-sol-green/70"
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
  onTileContextMenu,
}: {
  band: FleetBand;
  rows: InboxSession[];
  now: number;
  onOpen: (id: string) => void;
  onTileContextMenu?: (e: ReactMouseEvent, session: InboxSession) => void;
}) {
  const m = BAND_META[band];
  if (rows.length === 0 && band !== "needsYou") return null;
  return (
    <section className={`rounded-lg border px-2.5 pb-2.5 pt-2 ${m.box}`}>
      <h3 className={`mb-2 flex items-center gap-2 px-0.5 text-[11px] font-bold tracking-[0.18em] ${m.accent}`}>
        {m.label}
        <span className={`rounded-full px-1.5 py-px text-[10px] font-bold tabular-nums tracking-normal ${m.count}`}>
          {rows.length}
        </span>
      </h3>
      {rows.length === 0 ? (
        <div className="px-1 pb-1 text-[11px] text-sol-text-dim">nothing needs you right now</div>
      ) : (
        <div className="grid items-stretch gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}>
          {rows.map((s) => (
            <FleetTile key={s._id} session={s} band={band} now={now} onOpen={onOpen} onContextMenu={onTileContextMenu} />
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
    (st) => overlayConversationId(st.workspace),
    // Only this row — the whole map would re-render the overlay on every
    // other session's heartbeat (same rule as the stage's SessionPane).
    (st) => {
      const id = overlayConversationId(st.workspace);
      return id ? st.sessions[id] : null;
    },
  ]);
  const id = overlayConversationId(s.workspace);
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
      if (e.key !== "Escape") return;
      const t = e.target;
      // Escape inside an input means "leave the field", not "leave the visit".
      if (t instanceof HTMLElement && t.closest("input, textarea, [contenteditable='true'], [contenteditable=true]")) return;
      // Capture phase + stopPropagation: the key must not also drive whatever
      // sits under the overlay. The global shortcut registry (also capture,
      // registered at boot, so it runs first) keeps its one Escape claim —
      // clearing a message selection — and declines otherwise, which is the
      // right order: first Esc clears the selection, the next one closes.
      e.preventDefault();
      e.stopPropagation();
      handleClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, handleClose]);

  // The board OWNS this slot, so leaving the board takes the visit with it.
  // Without this, navigating to another surface mid-drill-in stranded the
  // overlay pane in the store: nothing rendered it, yet overlayConversationId
  // kept answering — and the triage chords (stash/defer/kill) target exactly
  // that id, so a destructive key could hit an invisible session.
  useEffect(() => {
    return () => {
      const st = useInboxStore.getState();
      if (st.workspace.secondary.presentation === "overlay" && st.workspace.secondary.pane?.kind === "conversation") {
        st.wsHide("secondary", { remember: false });
      }
    };
  }, []);

  // A drilled-in row that vanished (killed, pruned) closes itself.
  if (!open || !id || !session) return null;

  return (
    // Deliberately NOT aria-modal: hasOpenModal() keys on that attribute, and
    // it would stand down the global shortcut dispatcher (the triage chords —
    // stash/defer/dormant/kill — target exactly this drilled-in session via
    // focusedActionSessionId) AND the hosted ConversationView's own key
    // handlers and composer autofocus. The drill-in is the conversation
    // surface itself, presented as an overlay — not a dialog that owns the
    // keyboard against it. Escape/backdrop dismissal is handled above.
    <div className="absolute inset-0 z-30 flex" role="dialog">
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
  const s = useTrackedStore([
    (st) => sessionsWakeSig(st.sessions),
    (st) => st.sessionsWithQueuedMessages,
    (st) => st.pendingMessages,
    (st) => resolveShowOld(st.clientState.ui),
    (st) => st.clientState.ui?.inbox_scope ?? "mine",
    (st) => st.currentUser?._id?.toString?.() ?? null,
    (st) => st.teamInboxIds,
    (st) => st.currentSessionId,
    (st) => st.pendingSessionCreates,
    (st) => st.blockedReviveRequestedAt,
  ]);
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  // Time-driven freshness (elapsed clocks, liveness TTL, blocked-state aging)
  // gets its own low-frequency ticker; the data subscription above only wakes
  // on structural change. 15s is well under every TTL in play.
  const coarseNow = useCoarseNow(15_000);

  const showOld = resolveShowOld(s.clientState.ui);
  const inboxScope = s.clientState.ui?.inbox_scope ?? "mine";
  const meId = s.currentUser?._id?.toString?.() ?? null;
  const focusedId = s.currentSessionId;

  // THE placement chokepoint (placeInboxRows, sync-convergence C5): scope →
  // shared working-set selection → fold → placed sections — the same set the
  // panel renders, one call for the whole board.
  const categorized = useMemo(
    () => placeInboxRows(s, { focusedId, now: coarseNow }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionsWakeSig(s.sessions), inboxScope, meId, s.teamInboxIds, showOld, focusedId, s.sessionsWithQueuedMessages, pendingSendWakeSig(s.pendingMessages), s.pendingSessionCreates, s.blockedReviveRequestedAt, coarseNow],
  );
  const pendingSendIds = useMemo(() => sessionsWithPendingSend(s.pendingMessages), [s.pendingMessages]);
  const bands: FleetBands = useMemo(
    () => splitFleetBands(categorized, { queued: s.sessionsWithQueuedMessages, pendingSendIds, now: coarseNow }),
    [categorized, s.sessionsWithQueuedMessages, pendingSendIds, coarseNow],
  );

  const handleOpen = useCallback((id: string) => {
    useInboxStore.getState().wsShow("secondary", { kind: "conversation", ref: id }, { presentation: "overlay" });
  }, []);

  // Right-click triage on a tile: the same shared session menu every list row
  // renders (pin/label/stash/defer/dormant/kill), so the board is a first-class
  // triage surface, not just a launcher.
  const tileMenu = useContextMenu<{ session: InboxSession; isForeign: boolean }>();
  const openTileMenu = tileMenu.open;
  const handleTileContextMenu = useCallback(
    (e: ReactMouseEvent, session: InboxSession) => {
      const meId = useInboxStore.getState().currentUser?._id?.toString?.();
      openTileMenu(e, { session, isForeign: isForeignSession(session, undefined, meId) });
    },
    [openTileMenu],
  );
  const { killWithNotice } = useTriggerKillNotice();

  const total = bands.needsYou.length + bands.running.length + bands.finished.length;

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto" data-main-scroll>
        <div className="mx-auto max-w-6xl px-4 pb-8 pt-4 sm:px-6">
          <div ref={titlebarRef} className="mb-3 flex items-center justify-between gap-3">
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
              <BandSection band="needsYou" rows={bands.needsYou} now={coarseNow} onOpen={handleOpen} onTileContextMenu={handleTileContextMenu} />
              <BandSection band="running" rows={bands.running} now={coarseNow} onOpen={handleOpen} onTileContextMenu={handleTileContextMenu} />
              <BandSection band="finished" rows={bands.finished} now={coarseNow} onOpen={handleOpen} onTileContextMenu={handleTileContextMenu} />
            </div>
          )}
        </div>
      </div>
      <ContextMenu state={tileMenu}>
        {({ session, isForeign }) => (
          <SessionMenuItems
            session={session}
            isForeign={isForeign}
            onOpen={() => handleOpen(session._id)}
            onKill={() => killWithNotice(session._id)}
          />
        )}
      </ContextMenu>
      <FleetDrillIn />
    </div>
  );
}
