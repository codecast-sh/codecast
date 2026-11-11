"use client";
import { memo, useCallback, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
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
import { rowSigExcluding } from "../store/wakeSig";
import { SessionMark } from "./identity";
import { compactAge } from "../lib/threadState";
import { SegmentedToggle } from "./SegmentedToggle";
import { ErrorBoundary } from "./ErrorBoundary";
import { InboxConversation } from "./GlobalSessionPanel";
import { cleanTitle } from "../lib/conversationProcessor";
import { animatedHideSession } from "../store/undoActions";
import { getSessionRenderKey } from "../store/inboxStore";
import { splitFleetBands, fleetTileMeta, fleetTileContext, fleetTileSummary, type FleetBand, type FleetBands } from "./fleetBands";
import { useTitlebarHead } from "../hooks/useTitlebarHead";
import { overlayConversationId } from "../store/workspace";
import { useContextMenu, ContextMenu } from "./ui/context-menu";
import { SessionMenuItems } from "./menus/ObjectContextMenus";
import { isForeignSession } from "../lib/liveEntities";
import { useTriggerKillNotice } from "../hooks/useTriggerKillNotice";

import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
// The fleet board: the inbox home surface when clientState.ui.inbox_home is
// "board" (the default). Every visible session as a three-line list row,
// grouped into Needs you / Running / Finished bands — supervision by scanning,
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

// Three lines per row, in reading order: the title (medium, full ink), the
// blocker on a row that waits on you (the accent, red when broken) or the
// summary elsewhere (muted), and ID · project · model · msgs (dim), with the
// age on the right edge. Colour marks only what waits on you.
const TONE: Record<string, { text: string }> = {
  // Your move is the accent; a failure stays red; the rest is ink.
  amber: { text: "text-sol-cyan" },
  red: { text: "text-sol-red" },
  green: { text: "text-sol-text-muted" },
  dim: { text: "text-sol-text-dim" },
};

const BAND_META: Record<FleetBand, { label: string }> = {
  needsYou: { label: "Needs you" },
  running: { label: "Working" },
  finished: { label: "Done" },
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

/** One session as a list row: title; the state or the summary; ID ·
 *  project · model · msgs; the age on the right edge. */
const FleetRow = memo(function FleetRow({
  session,
  band,
  metaText,
  metaTone,
  summary,
  progress,
  onOpen,
  onContextMenu,
}: {
  session: InboxSession;
  band: FleetBand;
  metaText: string;
  metaTone: keyof typeof TONE;
  summary: string;
  /** The running bar's width, a whole percent. */
  progress: number;
  onOpen: (id: string) => void;
  onContextMenu?: (e: ReactMouseEvent, session: InboxSession) => void;
}) {
  const meta = fleetTileMeta(session, band, now);
  const tone = TONE[meta.tone];
  const title = cleanTitle(session.title ?? "") || "Untitled";
  // The blocker is the line that matters on a row that waits on you; elsewhere
  // the summary says what the agent is about, and the band already says state.
  // A working row's live status ("thinking") is worth a line; a done row's
  // state only repeats its heading, and its age sits on the right.
  const line = band === "needsYou" ? meta.text : fleetTileSummary(session, now) || (band === "running" ? meta.text : "");
  // The short ID cast prints (jx7c6zk): the stored one, else the id's first seven.
  const shortId = (session as { short_id?: string }).short_id ?? String(session._id).slice(0, 7);
  const context = [shortId, fleetTileContext(session)].filter(Boolean).join(" · ");
  const age = compactAge(now - (session.updated_at ?? now));
  return (
    <button
      onClick={() => onOpen(session._id)}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, session) : undefined}
      title={`${title}\n${line}`}
      className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 rounded-md px-3 py-2 text-left transition-colors duration-150 hover:bg-sol-bg-highlight motion-reduce:transition-none"
    >
      <span className="flex min-w-0 items-start gap-2.5">
        <SessionMark session={session as any} size={20} className="flex-shrink-0" />
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-medium leading-5 text-sol-text">{title}</span>
          {line && <span className={`block truncate text-[13px] leading-5 ${band === "needsYou" ? tone.text : "text-sol-text-muted"}`}>{line}</span>}
          {context && <span className="block truncate text-[12px] leading-5 text-sol-text-dim">{context}</span>}
        </span>
      </span>
      <span className="pt-0.5 text-meta leading-5 tabular-nums text-sol-text-dim">{age}</span>
    </button>
  );
});

// FINISHED is the band nobody scans; past this many tiles it waits for a press.
const FINISHED_TILE_CAP = 24;

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
  const [showAll, setShowAll] = useState(false);
  if (rows.length === 0 && band !== "needsYou") return null;
  const capped = band === "finished" && !showAll && rows.length > FINISHED_TILE_CAP;
  const shown = capped ? rows.slice(0, FINISHED_TILE_CAP) : rows;
  return (
    <section>
      <h3 className="mb-2 flex items-baseline gap-2 text-[13px] font-medium text-sol-text-muted">
        {m.label}
        <span className={`tabular-nums ${band === "needsYou" && rows.length > 0 ? "text-sol-cyan" : "text-sol-text-dim"}`}>{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <div className="pb-1 text-[13px] text-sol-text-dim">Nothing needs you right now.</div>
      ) : (
        <div className="-mx-3 flex flex-col">
          {rows.map((s) => (
            <FleetRow key={s._id} session={s} band={band} now={now} onOpen={onOpen} onContextMenu={onTileContextMenu} />
          ))}
        </div>
      )}
      {capped && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 px-1 text-meta font-medium text-sol-text-dim hover:text-sol-text"
        >
          Show all {rows.length}
        </button>
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
// The row fields a heartbeat moves and the drill-in never reads.
const DRILL_IN_LIVENESS_FIELDS = new Set(["updated_at", "last_heartbeat", "last_metrics_at", "last_active_at", "last_message_at"]);

function FleetDrillIn() {
  const s = useTrackedStore([
    (st) => overlayConversationId(st.workspace),
    // Only this row, and only its fields that are not liveness: the whole map
    // would re-render the overlay on every other session's heartbeat, and the
    // whole row on every beat of this one (same rule as the stage's SessionPane).
    (st) => {
      const id = overlayConversationId(st.workspace);
      return id ? rowSigExcluding(st.sessions[id], DRILL_IN_LIVENESS_FIELDS) : null;
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

  useWatchEffect(() => {
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
  useMountEffect(() => {
    return () => {
      const st = useInboxStore.getState();
      if (st.workspace.secondary.presentation === "overlay" && st.workspace.secondary.pane?.kind === "conversation") {
        st.wsHide("secondary", { remember: false });
      }
    };
  });

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
    <div className="absolute inset-0 z-30 flex" role="dialog" aria-modal="false">
      <div className="absolute inset-0 bg-sol-bg/80" onClick={handleClose} />
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
  const pendingSendIds = useMemo(() => sessionsWithPendingSend(s.pendingMessages, coarseNow), [s.pendingMessages, coarseNow]);
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
        <div className="px-5 pb-8 pt-4">
          <div ref={titlebarRef} className="mb-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-3">
              <h2 className="shrink-0 whitespace-nowrap text-[18px] font-semibold text-sol-text">Inbox</h2>
              <span className="hidden min-w-0 truncate text-[13px] text-sol-text-dim sm:block">
                {bands.needsYou.length} need you · {bands.running.length} working · {bands.finished.length} done
              </span>
            </div>
            <div className="shrink-0 whitespace-nowrap"><InboxHomeToggle /></div>
          </div>
          {total === 0 ? (
            <div className="px-4 py-16 text-center text-[13px] text-sol-text-dim">
              No sessions yet — start one from the CLI or the composer.
            </div>
          ) : (
            <div className="flex flex-col gap-6">
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
