"use client";
import { memo, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { isHostedAgentType } from "@codecast/shared/contracts";
import type { NoticeKind } from "@codecast/shared/contracts/assistant";
import type { InboxSession, PlacedInbox } from "../../store/inboxStore";
import { getProjectName } from "../../store/inboxStore";
import { splitStatusBands, type StatusBandOpts } from "../../lib/statusBands";
import { SESSION_STATUS, STATUS_BANDS, type SessionStatus, type StatusBand } from "../../lib/sessionStatus";
import { sessionCardLine } from "../../lib/sessionCardLine";
import { formatRowTime, sessionCardTitle } from "../../lib/sessionCard";
import { sessionCardSummary } from "../../lib/sessionSummary";
import { threadStateView } from "../../lib/threadState";
import { fleetProgress } from "../fleetBands";
import { cleanUserMessage } from "../sessionMessage";
import { SessionMark } from "../identity";
import { SessionStatusMark, SessionStatusWord } from "../inbox/SessionStatusMark";
import { ModernBranchChip, ModernProjectChip } from "../inbox/ModernCardParts";

// The fleet board in the Modern style (FleetBoard chooses it by the person's
// style). Its bands are the rail's sections and its tiles say the rail's words
// (lib/statusBands, lib/sessionStatus): Needs you (with any Error), Working
// (with Starting), Done, Dormant, Idle. A tile is the session card's anatomy
// at board size, from the same parts: the agent mark and the title, the time,
// the state's mark and word with the one line about the work, the project and
// the branch or PR, laid out as one list row per session. Nothing on it moves;
// a working row's recency bar is a still width the coarse clock sets.

const BAND_STATUS: Record<StatusBand, SessionStatus> = {
  needs_you: "needs_you",
  working: "working",
  done: "done",
  dormant: "dormant",
  idle: "idle",
};

// Done, Dormant and Idle are the bands nobody scans; past this many tiles they
// wait for a press.
const QUIET_TILE_CAP = 24;

type TileProps = {
  session: InboxSession;
  status: SessionStatus;
  /** The row's status is its band's: the heading above already says it, so
   *  the row leads with the work, not the word. */
  bandSays: boolean;
  /** The clock's words and the recency bar, as plain values: a coarse tick
   *  re-renders only the tiles whose words or bar moved. */
  time: string;
  reason: string | null;
  text: string;
  progress: number;
  onOpen: (id: string) => void;
  onContextMenu?: (e: ReactMouseEvent, session: InboxSession) => void;
};

const ModernFleetTile = memo(function ModernFleetTile({ session, status, bandSays, time, reason, text, progress, onOpen, onContextMenu }: TileProps) {
  const meta = SESSION_STATUS[status];
  const title = sessionCardTitle(session) || "Untitled";
  const project = getProjectName(session.git_root, session.project_path);
  // One row of the board's list: the mark; the title; the state's word with
  // the one line about the work; the project and branch; the time on the
  // right edge. A list scans down at fleet size where a grid of tiles made
  // the eye zig-zag, and it reads the way the rail does.
  return (
    <div
      role="button"
      tabIndex={0}
      data-session-tile={session._id}
      data-mc-status={status}
      onClick={() => onOpen(session._id)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(session._id); } }}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, session) : undefined}
      aria-label={`${title}, ${meta.word}${reason ? `, ${reason}` : ""}, ${time}`}
      className="group relative grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 overflow-hidden rounded-control px-2 py-2 text-left transition-colors hover:bg-sol-text/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--focus-ring)]"
    >
      <span className="flex min-w-0 items-start gap-2.5">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <SessionMark session={session as any} size={20} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-semibold text-sol-text">{title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-ui">
            {!bandSays && <SessionStatusMark status={status} />}
            <span className="min-w-0 truncate">
              {!bandSays && <SessionStatusWord status={status} className="font-medium" />}
              {reason && <span className={meta.text}>{!bandSays && <span aria-hidden className="text-sol-text-dim"> · </span>}{reason}</span>}
              {text && <span className="text-sol-text-muted">{(!bandSays || reason) && <span aria-hidden className="text-sol-text-dim"> · </span>}{text}</span>}
            </span>
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden empty:hidden">
            <ModernProjectChip project={project} label={null} directory={session.git_root || session.project_path} className="shrink-[100] min-w-[3rem]" />
            <ModernBranchChip session={session} showBranch={false} className="shrink min-w-[3rem]" />
          </span>
        </span>
      </span>
      <span className="pt-0.5 text-meta tabular-nums text-sol-text-dim">{time}</span>
      {(status === "working" || status === "starting") && (
        <span aria-hidden className="absolute bottom-0 left-9 right-2 h-px bg-sol-border/40">
          <span className="block h-full bg-sol-green/70" style={{ width: `${progress}%` }} />
        </span>
      )}
    </div>
  );
});

function BandHeader({ band, count }: { band: StatusBand; count: number }) {
  const status = BAND_STATUS[band];
  return (
    <h3 className="mb-2 flex h-6 items-center gap-2">
      <SessionStatusMark status={status} />
      <span className="text-mark font-semibold uppercase tracking-[0.08em] text-sol-text-muted">{SESSION_STATUS[status].word}</span>
      <span className="text-mark tabular-nums text-sol-text-dim">{count}</span>
      <span aria-hidden className="h-px flex-1 bg-sol-border" />
    </h3>
  );
}

function Band({ band, tiles, now, stoppedOf, onOpen, onTileContextMenu }: {
  band: StatusBand;
  tiles: Array<{ session: InboxSession; status: SessionStatus }>;
  now: number;
  stoppedOf: (s: InboxSession) => NoticeKind | null;
  onOpen: (id: string) => void;
  onTileContextMenu?: (e: ReactMouseEvent, session: InboxSession) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const quiet = band === "done" || band === "dormant" || band === "idle";
  if (tiles.length === 0 && band !== "needs_you") return null;
  const capped = quiet && !showAll && tiles.length > QUIET_TILE_CAP;
  const shown = capped ? tiles.slice(0, QUIET_TILE_CAP) : tiles;
  return (
    <section data-fleet-band={band}>
      <BandHeader band={band} count={tiles.length} />
      {tiles.length === 0 ? (
        <div className="pl-5 text-ui text-sol-text-dim">Nothing needs you right now</div>
      ) : (
        <div className="-mx-2 flex flex-col">
          {shown.map(({ session: s, status }) => {
            const stateView = threadStateView(s, s.message_count ?? 0, now);
            const line = sessionCardLine({
              row: s,
              status,
              now,
              live: { stoppedKind: stoppedOf(s) },
              stateLine: stateView?.cardLine,
              summary: sessionCardSummary(s),
              prompt: cleanUserMessage(s.last_user_message),
              hosted: isHostedAgentType(s.agent_type),
            });
            return (
              <ModernFleetTile
                key={s._id}
                session={s}
                status={status}
                bandSays={status === BAND_STATUS[band]}
                time={formatRowTime(s.updated_at, isHostedAgentType(s.agent_type), now)}
                reason={line.reason}
                text={line.text}
                progress={status === "working" || status === "starting" ? Math.round(fleetProgress(s, now) * 100) : 0}
                onOpen={onOpen}
                onContextMenu={onTileContextMenu}
              />
            );
          })}
        </div>
      )}
      {capped && (
        <button type="button" onClick={() => setShowAll(true)} className="mt-2 pl-5 text-ui font-medium text-sol-text-dim hover:text-sol-text">
          Show all {tiles.length}
        </button>
      )}
    </section>
  );
}

/** The Modern board's body: a count per state, then a band per state. */
export function ModernFleetBody({ placed, opts, onOpen, onTileContextMenu }: {
  placed: PlacedInbox;
  opts: StatusBandOpts & { stopped: (s: InboxSession) => NoticeKind | null };
  onOpen: (id: string) => void;
  onTileContextMenu?: (e: ReactMouseEvent, session: InboxSession) => void;
}) {
  const bands = useMemo(() => splitStatusBands(placed, opts), [placed, opts]);
  const total = STATUS_BANDS.reduce((n, b) => n + bands[b].length, 0);
  if (total === 0) {
    return <div className="rounded-card border border-sol-border px-4 py-10 text-center text-ui text-sol-text-dim">No sessions yet. Start one from the CLI or the composer.</div>;
  }
  return (
    <div className="flex flex-col gap-5">
      <div data-fleet-counts className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui text-sol-text-muted">
        {STATUS_BANDS.map((b) => bands[b].length > 0 && (
          <span key={b} className="inline-flex items-center gap-1.5">
            <SessionStatusMark status={BAND_STATUS[b]} />
            <span className="tabular-nums text-sol-text">{bands[b].length}</span>
            {SESSION_STATUS[BAND_STATUS[b]].word}
          </span>
        ))}
      </div>
      {STATUS_BANDS.map((b) => (
        <Band key={b} band={b} tiles={bands[b]} now={opts.now} stoppedOf={opts.stopped} onOpen={onOpen} onTileContextMenu={onTileContextMenu} />
      ))}
    </div>
  );
}
