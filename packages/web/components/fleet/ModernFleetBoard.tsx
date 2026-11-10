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
import { identityRowOf } from "../../lib/sessionIdentity";
import { fleetProgress } from "../fleetBands";
import { cleanUserMessage } from "../sessionMessage";
import { SessionGlyph } from "../identity";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { SessionStatusMark, SessionStatusWord } from "../inbox/SessionStatusMark";
import { ModernBranchChip, ModernProjectChip } from "../inbox/ModernCardParts";

// The fleet board in the Modern style (FleetBoard chooses it by the person's
// style). Its bands are the rail's sections and its tiles say the rail's words
// (lib/statusBands, lib/sessionStatus): Needs you (with any Error), Working
// (with Starting), Done, Dormant, Idle. A tile is the session card's anatomy
// at board size, from the same parts: the agent mark and the title, the time,
// the state's mark and word with the one line about the work, the project and
// the branch or PR. Nothing on it moves; a working tile's recency bar is a
// still width the coarse clock sets.

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
  /** The clock's words and the recency bar, as plain values: a coarse tick
   *  re-renders only the tiles whose words or bar moved. */
  time: string;
  reason: string | null;
  text: string;
  progress: number;
  onOpen: (id: string) => void;
  onContextMenu?: (e: ReactMouseEvent, session: InboxSession) => void;
};

const ModernFleetTile = memo(function ModernFleetTile({ session, status, time, reason, text, progress, onOpen, onContextMenu }: TileProps) {
  const meta = SESSION_STATUS[status];
  const title = sessionCardTitle(session) || "Untitled";
  const project = getProjectName(session.git_root, session.project_path);
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
      className="group relative flex min-w-0 cursor-pointer flex-col gap-1 overflow-hidden rounded-card border border-sol-border bg-sol-card px-3 pb-2.5 pt-2.5 text-left transition-colors hover:border-sol-text-dim/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--focus-ring)]"
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-sol-text-muted">
          <SessionGlyph row={identityRowOf(session as any)} size={18} fallback={<AgentTypeIcon agentType={session.agent_type || "claude_code"} className="h-4 w-4" />} />
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 text-body font-semibold text-sol-text">{title}</span>
        <span className="shrink-0 pt-0.5 text-meta tabular-nums text-sol-text-dim">{time}</span>
      </span>
      <span className="flex min-w-0 items-start gap-2">
        <span className="flex h-[18px] w-5 shrink-0 items-center justify-center"><SessionStatusMark status={status} /></span>
        <span className="line-clamp-2 min-w-0 flex-1 text-ui">
          <SessionStatusWord status={status} className="font-medium" />
          {reason && <span className={meta.text}><span aria-hidden className="text-sol-text-dim"> · </span>{reason}</span>}
          {text && <span className="text-sol-text-muted"><span aria-hidden className="text-sol-text-dim"> · </span>{text}</span>}
        </span>
      </span>
      <span className="mt-auto flex min-w-0 items-center gap-1 overflow-hidden pl-7 pt-0.5 empty:hidden">
        <ModernProjectChip project={project} label={null} directory={session.git_root || session.project_path} className="shrink-[100] min-w-[3rem]" />
        <ModernBranchChip session={session} showBranch={false} className="shrink min-w-[3rem]" />
      </span>
      {(status === "working" || status === "starting") && (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-sol-border/40">
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
        <div className="grid items-stretch gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
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
