import React, { useState } from "react";
import { Tag, UserCheck, CheckSquare, Square } from "lucide-react";
import { formatRelative, formatDateFull } from "../../lib/utils";
import { sessionCardTitle } from "../../lib/sessionCard";
import { sessionStartupState } from "../../lib/sessionLifecycle";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { cleanTitle } from "../../lib/conversationProcessor";
import type { InboxSession } from "../../store/inboxStore";
import { AuthErrorBadge } from "../AuthErrorBadge";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { useModeWords, useSurface } from "../../lib/surfaces";

// The pieces of the full inbox card (SessionCardView) that stand on their own:
// each draws from the row and the few facts handed to it, and every gesture
// leaves through a handler, the same contract as the view itself.

/** A teammate handed this session to the viewer and they have not taken it yet. */
export function AssignedPingStrip({
  session,
  now,
  onAckAssignment,
}: {
  session: InboxSession;
  now: number;
  onAckAssignment?: (id: string) => void;
}) {
  // Handoff note starts clamped; tapping the pill body reveals the full reason.
  const [pingExpanded, setPingExpanded] = useState(false);
  if (!session.assigned_ping) return null;
  return (
          /* mr-5 keeps the strip — and its "Got it" button — clear of the
             hover toolbar's column on the right, whose gradient would
             otherwise wash over the button. */
          <div data-sv-ping className="flex items-start gap-1.5 mt-1 mr-5 px-1.5 py-1 rounded-md bg-sol-violet/15 border border-sol-violet/30">
            <UserCheck className="w-3 h-3 text-sol-violet flex-shrink-0 mt-0.5" />
            {/* The note is the REASON for the handoff — clamped for the list,
                tap the body to read all of it without opening the session. */}
            <div
              className={`min-w-0 flex-1 text-[11px] leading-snug ${session.assigned_ping.note ? "cursor-pointer" : ""}`}
              onClick={session.assigned_ping.note ? (e) => { e.stopPropagation(); setPingExpanded((v) => !v); } : undefined}
            >
              <span className="font-semibold text-sol-violet">
                {session.assigned_ping.by_name} assigned this to you
              </span>
              <span className="text-sol-text-dim whitespace-nowrap" title={formatDateFull(session.assigned_ping.at)}>
                {" · "}{formatRelative(session.assigned_ping.at, now)}
              </span>
              {session.assigned_ping.note && (
                <div className={`text-sol-text-muted whitespace-pre-wrap break-words ${pingExpanded ? "" : "line-clamp-2"}`}>
                  “{session.assigned_ping.note}”
                </div>
              )}
            </div>
            {/* Accept right here — the handoff shouldn't require opening the
                conversation and finding the banner to retire. */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onAckAssignment?.(session._id); }}
              className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sol-violet/20 text-sol-violet border border-sol-violet/40 hover:bg-sol-violet/30 transition-colors"
            >
              Got it
            </button>
          </div>
  );
}

/** A blank session's line until its first message: the composer's "Starting… →
 *  Ready" lifecycle (lib/sessionLifecycle). A blank session often has no daemon
 *  heartbeat until its first message, so elapsed time is the fallback rather
 *  than a spinner that never ends. */
export function CardStartupLine({ session }: { session: InboxSession }) {
  // A hosted conversation has no machine to connect: it is getting started
  // until its first reply, in the words its status line uses.
  if (isHostedAgentType(session.agent_type)) {
    return <div className="mt-0.5 text-[11px] text-sol-text-dim">Getting started…</div>;
  }
  const startup = sessionStartupState({
    isConnected: session.is_connected,
    ageMs: Date.now() - (session.started_at || session.updated_at),
  });
  if (startup === "ready") {
    return (
      <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-sol-green/70">
        <span className="w-1.5 h-1.5 rounded-full bg-sol-green/70" />
        <span>Ready</span>
      </div>
    );
  }
  if (startup === "starting") {
    return (
      <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-sol-cyan/60">
        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span>Starting…</span>
      </div>
    );
  }
  return (
    <div className="text-[11px] text-sol-text-dim/60 mt-0.5">
      Waiting for connection
    </div>
  );
}

/** The open comment threads on a session. Loud only when the ball is in the
 *  viewer's court: someone ELSE (teammate or agent) spoke last in an open
 *  thread. When the viewer commented last they're waiting, not being waited
 *  on, so the chip stays but drops to the dim treatment. */
export function CommentThreadsChip({
  session,
  viewerId,
  onOpenComments,
}: {
  session: InboxSession;
  viewerId: string | null;
  onOpenComments?: (id: string) => void;
}) {
  if ((session.open_comment_threads ?? 0) <= 0) return null;
  const waitingOnViewer = !!session.last_comment_author_id
    && session.last_comment_author_id !== viewerId;
  const who = session.last_comment_author;
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold border transition-colors max-w-[9rem] ${
        waitingOnViewer
          ? "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/30 hover:bg-sol-cyan/20"
          : "bg-sol-bg-alt/60 text-sol-text-dim border-sol-border/40 hover:bg-sol-bg-alt"
      }`}
      title={`${session.open_comment_threads} open comment thread${session.open_comment_threads === 1 ? "" : "s"}${
        who && session.last_comment_excerpt ? ` — ${who}: ${session.last_comment_excerpt}` : ""
      } — open with the comment rail`}
      onClick={(e) => {
        e.stopPropagation();
        onOpenComments?.(session._id);
      }}
    >
      <svg className="w-2.5 h-2.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.9 20A9 9 0 104 16.1L2 22z" />
      </svg>
      {session.open_comment_threads}
      {waitingOnViewer && who && (
        <span className="truncate min-w-0">· {who.split(" ")[0]}</span>
      )}
    </button>
  );
}

/** The card's one live signal at the end of its meta row: blocked, errored,
 *  unresponsive, pending, idle, restarting, or working. */
export function CardStatusSignals({
  session,
  showBlockedBadge,
  isWorking,
  isLive,
  dismissed,
  isPendingWorking,
  isRowRestarting,
}: {
  session: InboxSession;
  showBlockedBadge: boolean;
  isWorking: boolean;
  isLive: boolean;
  /** The real dismissed variant: a stashed agent still runs, so it keeps its idle dot. */
  dismissed: boolean;
  isPendingWorking: boolean;
  isRowRestarting: boolean;
}) {
  // A hosted row says its state in its section; its dot is the engine's work
  // (working or thinking), never a liveness heartbeat that outlives the
  // reply, and a send in flight is not a "pending" chip.
  const hosted = isHostedAgentType(session.agent_type);
  return (
    <>
            {showBlockedBadge && <AuthErrorBadge kind={session.pending_api_error_kind} agentType={session.agent_type} />}
            {session.session_error && session.pending_api_error_kind !== "safety" && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-red" title={session.session_error} />
            )}
            {session.is_unresponsive && !session.session_error && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-orange" title="Session unresponsive" />
            )}
            {session.has_pending && !session.is_unresponsive && !isPendingWorking && !isRowRestarting && (
              <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse" title="Message pending" />
            )}
            {/* Settled with content gets the gray idle dot. Keyed on !isLive (now
                staleness-aware) rather than the raw is_idle flag, so a frozen
                is_idle:false row that's really finished shows idle, not nothing. */}
            {!isWorking && !isLive && !dismissed && !showBlockedBadge && !session.session_error && !session.is_unresponsive && !session.has_pending && !isPendingWorking && !isRowRestarting && session.message_count > 0 && (
              <span data-sv-idle-dot className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/40 ring-1 ring-sol-text-dim/20" title="Idle" />
            )}
            {/* A kill+restart owns the row's signal while it runs: the re-pended
                message and the not-yet-live status are both part of the restart,
                so the pending chip and dots yield to this one. isLive flipping
                true retires it in favor of the green working dot. */}
            {isRowRestarting && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-sol-orange/10 text-sol-orange border border-sol-orange/30" title="Kill & restart in flight">
                <span className="w-1 h-1 rounded-full bg-sol-orange animate-pulse" />
                restarting
              </span>
            )}
            {isPendingWorking && !isRowRestarting && !hosted && (
              <span className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[9px] font-semibold bg-sol-yellow/10 text-sol-yellow border border-sol-yellow/30" title="Sent — waiting to confirm delivery">
                <span className="w-1 h-1 rounded-full bg-sol-yellow animate-pulse" />
                pending
              </span>
            )}
            {(hosted ? isWorking || isPendingWorking : (isWorking || isLive) && !isPendingWorking) && !isRowRestarting && !showBlockedBadge && (
              <span data-sv-working-dot className="relative flex h-2 w-2" title="Working">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sol-green opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-sol-green" />
              </span>
            )}
    </>
  );
}

/** The links out of a card: the session that spawned this one (or that it
 *  continues, for a handoff), and the session implementing its plan. */
export function CardParentLinks({
  session,
  spawnedById,
  spawnedIsHandoff,
  spawnedByTitle,
  onOpenParent,
  onNavigateToSession,
}: {
  session: InboxSession;
  spawnedById: string | null;
  spawnedIsHandoff: boolean;
  spawnedByTitle: string | null;
  onOpenParent?: (id: string) => void;
  onNavigateToSession?: (id: string) => void;
}) {
  return (
    <>
        {spawnedById && (
          // Click-through to the session that spawned this one (its agent-team
          // lead) — same affordance shape as the implementation-session row.
          <div
            data-sv-spawned
            className="mt-1 flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-cyan cursor-pointer transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onOpenParent?.(spawnedById);
            }}
            title={spawnedIsHandoff ? "View the session this one continues" : "View the session that spawned this one"}
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            <span className="flex-shrink-0">{spawnedIsHandoff ? "handed off from" : "spawned by"}</span>
            <span className="truncate underline underline-offset-2">
              {cleanTitle(spawnedByTitle || "parent session")}
            </span>
          </div>
        )}
        {session.implementation_session && (
          <div
            className="mt-1 flex items-center gap-1 text-[11px] text-sol-cyan hover:text-sol-cyan/80 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation();
              if (onNavigateToSession) onNavigateToSession(session.implementation_session!._id);
            }}
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
            <span className="truncate underline underline-offset-2">
              {sessionCardTitle(session.implementation_session)}
            </span>
          </div>
        )}
    </>
  );
}

const PIN_PATH = "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76z";

function PinGlyph({ filled }: { filled: boolean }) {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d={PIN_PATH} />
    </svg>
  );
}

/** The row-action glyphs, one path each, all drawn the same way. */
function ActionGlyph({ d }: { d: string }) {
  return (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
    </svg>
  );
}

const CLOSE_PATH = "M6 18L18 6M6 6l12 12";
const STASH_PATH = "M7 7l10 10M17 17h-6m6 0v-6";
const RESTORE_PATH = "M17 17L7 7M7 7h6M7 7v6";

/** The ONE pin a pinned session shows: a persistent, interactive badge anchored
 *  top-right. It stays put on hover (z above the toolbar) and the hover toolbar
 *  omits its own pin button for pinned rows, so the pin never duplicates or
 *  cross-fades into a second copy. `fadeGround` is the tinted card's ground
 *  under the fade; null is the resting card. */
export function CardPinBadge({ session, fadeGround, onPin }: { session: InboxSession; fadeGround: string | null; onPin?: (id: string, e: React.MouseEvent) => void }) {
  if (!onPin || !session.is_pinned) return null;
  return (
    <div data-sv-fade data-sv-pin className="absolute top-0 right-0 py-1 pr-2 pointer-events-none z-[2]" style={{ paddingLeft: 24, background: `linear-gradient(to right, transparent, ${fadeGround ?? "var(--sol-bg-alt)"} 60%)` }}>
      <ShortcutTooltip label="Unpin" action="session.pin" side="left">
        <button
          onClick={(e) => { e.stopPropagation(); onPin(session._id, e); }}
          className="p-1 rounded text-sol-magenta transition-opacity hover:opacity-70 pointer-events-auto"
        >
          <PinGlyph filled />
        </button>
      </ShortcutTooltip>
    </div>
  );
}

/** The hover toolbar on a live card: pin, kill, label, stash. */
export function CardHoverToolbar({
  session,
  fadeGround,
  onPin,
  onDismiss,
  onOpenLabels,
  onStash,
}: {
  session: InboxSession;
  fadeGround: string | null;
  onPin?: (id: string, e: React.MouseEvent) => void;
  onDismiss?: (id: string) => void;
  onOpenLabels?: (session: InboxSession) => void;
  onStash?: (id: string, e: React.MouseEvent) => void;
}) {
  const words = useModeWords();
  const labels = useSurface("inbox.labelStrip");
  return (
        <div data-sv-fade className={`absolute top-0 bottom-0 right-0 flex flex-col items-center justify-between py-1 opacity-0 group-hover:opacity-100 transition-opacity pl-10 pr-2 pointer-events-none ${fadeGround ? '' : 'bg-gradient-to-r from-transparent via-[color-mix(in_srgb,var(--sol-bg-alt)_50%,transparent)] to-[color-mix(in_srgb,var(--sol-bg-alt)_85%,transparent)]'}`} style={fadeGround ? { background: `linear-gradient(to right, transparent, color-mix(in srgb, ${fadeGround} 50%, transparent), color-mix(in srgb, ${fadeGround} 85%, transparent))` } : undefined}>
          {/* Pin slot, first so it anchors the top of the toolbar. When the row is
              already pinned, the persistent badge above IS the pin — here we render
              only an invisible spacer the same size, so the remaining actions sit
              exactly where they do for an unpinned row and the badge has a clear slot
              to occupy. When unpinned, this is the live "Pin" affordance. */}
          {onPin && (
            session.is_pinned ? (
              <div className="p-1 pointer-events-none" aria-hidden="true">
                <div className="w-3.5 h-3.5" />
              </div>
            ) : (
              <ShortcutTooltip label="Pin" action="session.pin" side="left">
                <button
                  aria-label="Pin"
                  onClick={(e) => { e.stopPropagation(); onPin(session._id, e); }}
                  className="p-1 rounded transition-colors text-sol-text-dim hover:text-sol-magenta pointer-events-auto"
                >
                  <PinGlyph filled={false} />
                </button>
              </ShortcutTooltip>
            )
          )}
          {/* Kill — the PRIMARY remove: done with it, clears to the Killed
              group and tears the (usually idle) agent down. Undoable. */}
          {onDismiss && (
            <ShortcutTooltip label={words.killTip} action="session.kill" side="left">
              <button
                aria-label={words.kill}
                onClick={(e) => { e.stopPropagation(); onDismiss(session._id); }}
                className="p-1 rounded text-sol-text-dim hover:text-sol-red hover:bg-sol-red/10 transition-colors pointer-events-auto"
              >
                <ActionGlyph d={CLOSE_PATH} />
              </button>
            </ShortcutTooltip>
          )}
          {labels && (
            <ShortcutTooltip label="Label session" action="session.moveToBucket" side="left">
              <button
                aria-label="Label session"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenLabels?.(session);
                }}
                className="p-1 rounded text-sol-text-dim hover:text-sol-blue transition-colors pointer-events-auto"
              >
                <Tag className="w-3.5 h-3.5" />
              </button>
            </ShortcutTooltip>
          )}
          {/* Stash — the SECONDARY remove: set aside, agent keeps running. */}
          {onStash && (
            <ShortcutTooltip label={words.stashTip} action="session.stash" side="left">
              <button
                aria-label={words.stash}
                onClick={(e) => { e.stopPropagation(); onStash(session._id, e); }}
                className="p-1 rounded text-sol-text-dim hover:text-sol-yellow transition-colors pointer-events-auto"
              >
                <ActionGlyph d={STASH_PATH} />
              </button>
            </ShortcutTooltip>
          )}
        </div>
  );
}

/** Kill and restore on a stashed, snoozed or killed card. */
export function CardRestoreCluster({
  session,
  variant,
  isStashed,
  onKill,
  onRestore,
}: {
  session: InboxSession;
  variant: string;
  isStashed: boolean;
  onKill?: (id: string) => void;
  onRestore?: (id: string) => void;
}) {
  return (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-[4]">
          {onKill && (
            <ShortcutTooltip label={isStashed ? "Kill" : "Remove from list"} action={isStashed ? "session.kill" : undefined} side="left">
              <button
                onClick={(e) => { e.stopPropagation(); onKill(session._id); }}
                className="p-1 rounded-md text-sol-text-dim hover:text-sol-red bg-sol-bg/95 backdrop-blur-sm shadow-sm border border-sol-border/30"
              >
                <ActionGlyph d={CLOSE_PATH} />
              </button>
            </ShortcutTooltip>
          )}
          {onRestore && (
            <ShortcutTooltip label={variant === "snoozed" ? "Move to Needs Input now" : "Restore"} side="left">
              <button
                onClick={(e) => { e.stopPropagation(); onRestore(session._id); }}
                className="p-1 rounded-md text-sol-text-dim hover:text-sol-cyan bg-sol-bg/95 backdrop-blur-sm shadow-sm border border-sol-border/30"
              >
                <ActionGlyph d={RESTORE_PATH} />
              </button>
            </ShortcutTooltip>
          )}
        </div>
  );
}

const FORK_HUES = [30, 60, 120, 180, 200, 220, 260, 45, 90, 160, 240, 280];

function getForkColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  const hue = FORK_HUES[((h % FORK_HUES.length) + FORK_HUES.length) % FORK_HUES.length];
  return `hsl(${hue}, 65%, 55%)`;
}

export function ForkCorner({ colorKey }: { colorKey: string }) {
  const color = getForkColor(colorKey);
  return (
    <div
      className="absolute top-0 left-0 w-0 h-0"
      style={{
        borderTop: `10px solid ${color}`,
        borderRight: "10px solid transparent",
      }}
    />
  );
}

// Unread, said once. Weight carries it (the title goes bright and medium) and
// this dot marks the leading edge, the same two signals the chat rail uses —
// never a count, which turns a busy afternoon into a number that never reaches
// zero.
export function UnreadDot() {
  return (
    <span
      className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-sol-cyan"
      title="Unread: this moved since you last looked at it"
      aria-label="Unread"
    />
  );
}

/** The card's tick while a selection is live: every card shows its box, so
 *  the mode is visible, and the box itself toggles the card. */
export function SelectTick({ sessionId, isSelected, selecting, onToggle }: { sessionId: string; isSelected: boolean; selecting: boolean; onToggle?: (id: string) => void }) {
  if (!selecting) return null;
  const Icon = isSelected ? CheckSquare : Square;
  return (
    <button
      type="button"
      data-sv-check
      aria-label={isSelected ? "Remove from selection" : "Add to selection"}
      aria-pressed={isSelected}
      onClick={(e) => { e.stopPropagation(); onToggle?.(sessionId); }}
      className={`absolute right-1 top-1 z-10 rounded bg-sol-bg-alt/80 p-0.5 ${isSelected ? "text-sol-text" : "text-sol-text-dim/60 hover:text-sol-text"}`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
