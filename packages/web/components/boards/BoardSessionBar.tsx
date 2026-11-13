// The workshop controls at the board's top left: a dot vote and a shared timer.
// Idle, they are two buttons; running, each shows its own state (votes left,
// time left) beside the control that ends it.
import { memo, useState } from "react";
import { useNowWhen } from "../../hooks/useCoarseNow";
import { Timer as TimerIcon, Vote } from "lucide-react";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { clock, votesOf, type BoardSession } from "./boardSession";
import { elementBounds } from "@codecast/shared/artifacts/board";
import type { BoardEl } from "./boardTypes";

const TIMER_MINUTES = [1, 3, 5, 10];

type Props = {
  session: BoardSession;
  /** My votes left in an open vote. */
  left: number;
  voted: number;
  /** Bumped each time a vote is refused because none are left. */
  outOfVotes: number;
  readOnly: boolean;
  compact: boolean;
  onVote(action: "start" | "end" | "clear"): void;
  onTimer(ms: number | null, addMs?: number): void;
};

export const BoardSessionBar = memo(function BoardSessionBar({ session, left, voted, outOfVotes, readOnly, compact, onVote, onTimer }: Props) {
  const [menu, setMenu] = useState(false);
  const { voting, timer } = session;
  // The shared clock re-renders the bar when the shown second changes; the time shown is read fresh,
  // since the clock's last tick may predate the timer.
  useNowWhen((t) => (timer ? clock(timer.ends_at - t) : ""), 250);
  const now = Date.now();
  if (readOnly && !voting && !timer) return null;
  const remaining = timer ? timer.ends_at - now : 0;
  const done = !!timer && remaining <= 0;
  return (
    <div className={`board-session${compact ? " is-compact" : ""}`} data-board-ui role="group" aria-label="Workshop">
      {voting ? (
        <div key={voting.open ? `v${outOfVotes}` : "r"} className={`board-session-chip${voting.open ? " is-live" : ""}${voting.open && outOfVotes && !left ? " is-out" : ""}`}>
          <Vote size={14} strokeWidth={1.75} aria-hidden />
          {voting.open ? (
            <>
              <span className="board-session-val" aria-label={`${left} of ${voting.per} votes left`}>{compact ? `${left}/${voting.per}` : `${left} of ${voting.per} left`}</span>
              {!readOnly && <button type="button" className="board-session-act" onClick={() => onVote("end")}>{compact ? "End" : "End vote"}</button>}
            </>
          ) : (
            <>
              <span className="board-session-val">{voted ? `${voted} voted` : "No votes"}</span>
              {!readOnly && <button type="button" className="board-session-act" onClick={() => onVote("clear")}>Clear</button>}
            </>
          )}
        </div>
      ) : (
        !readOnly && (
          <ShortcutTooltip label="Dot vote: 3 votes each on stickies" side="bottom">
            <button type="button" className="board-bar-btn" aria-label="Start a dot vote" onClick={() => onVote("start")}>
              <Vote size={14} strokeWidth={1.75} />{!compact && <span className="board-session-lbl">Vote</span>}
            </button>
          </ShortcutTooltip>
        )
      )}
      {timer ? (
        <div className={`board-session-chip${done ? " is-done" : " is-live"}`}>
          <TimerIcon size={14} strokeWidth={1.75} aria-hidden />
          <span className="board-session-val" role="timer" aria-label={done ? "Time is up" : `${clock(remaining)} left`}>{done ? "Time's up" : clock(remaining)}</span>
          {!readOnly && !done && <button type="button" className="board-session-act" aria-label="Add a minute" onClick={() => onTimer(null, 60_000)}>+1m</button>}
          {!readOnly && <button type="button" className="board-session-act" onClick={() => onTimer(null)}>{done ? "Done" : "Stop"}</button>}
          {done && <span aria-live="assertive" className="board-sr">Time is up</span>}
        </div>
      ) : (
        !readOnly && (
          <div className="board-session-timer">
            <ShortcutTooltip label="Timer everyone sees" side="bottom">
              <button type="button" className={`board-bar-btn${menu ? " is-active" : ""}`} aria-label="Start a timer" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                <TimerIcon size={14} strokeWidth={1.75} />{!compact && <span className="board-session-lbl">Timer</span>}
              </button>
            </ShortcutTooltip>
            {menu && (
              <div className="board-session-menu" role="menu" aria-label="Timer length" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setMenu(false); } }}>
                {TIMER_MINUTES.map((m) => (
                  <button key={m} type="button" role="menuitem" className="board-session-act" onClick={() => { setMenu(false); onTimer(m * 60_000); }}>{m} min</button>
                ))}
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
});

/** The dots on voted stickies: while the vote is open each person sees only their own; after it ends, the counts. */
export const BoardVoteDots = memo(function BoardVoteDots({ els, me, open }: { els: BoardEl[]; me: string; open: boolean }) {
  return (
    <>
      {els.map((e) => {
        const votes = votesOf(e);
        const n = open ? votes.filter((v) => v === me).length : votes.length;
        if (!n) return null;
        const b = elementBounds(e);
        return (
          <div key={e.key} className={`board-votes${open ? "" : " is-result"}`} style={{ left: b.x + b.w - 10, top: b.y - 10 }} aria-label={open ? `${n} of your votes` : `${n} votes`}>
            {open ? Array.from({ length: n }, (_, i) => <span key={i} className="board-vote-dot" />) : n}
          </div>
        );
      })}
    </>
  );
});
