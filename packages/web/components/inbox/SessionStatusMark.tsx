import { Mark } from "../Mark";
import { SESSION_STATUS, type SessionStatus } from "../../lib/sessionStatus";
import { STATUS_MARK_SHAPES } from "../../lib/sessionStatusShapes";

// The status vocabulary's visual half (lib/sessionStatus): the mark and the
// word every Modern surface draws for a session's state, so a card, a board
// tile, a /sessions row and a section header can never draw one differently.
// The shapes live in lib/sessionStatusShapes, which the phone draws too.

/** A state's mark, in its colour, named on hover. `labeled` when the state's
 *  word sits beside it, so the icon legend leaves it out. `markId` names
 *  another meaning drawn in a session's mark (a plan's state). `quiet` when
 *  it sits inside a mark that already names it (Mark quiet). */
export function SessionStatusMark({ status, size = 10, className = "", labeled, quiet, markId }: { status: SessionStatus; size?: number; className?: string; labeled?: boolean; quiet?: boolean; markId?: string }) {
  const meta = SESSION_STATUS[status];
  return (
    <Mark id={markId ?? `session.${status}`} labeled={labeled} quiet={quiet}>
      <svg data-status-mark={status} viewBox="0 0 10 10" width={size} height={size} aria-hidden className={`shrink-0 ${meta.text} ${className}`}>
        {STATUS_MARK_SHAPES[meta.mark]}
      </svg>
    </Mark>
  );
}

/** A state's word, in its colour. The tooltip says what the word means, or
 *  the reason behind it when the caller has one. */
export function SessionStatusWord({ status, title, className = "", word }: { status: SessionStatus; title?: string; className?: string; word?: string | null }) {
  const meta = SESSION_STATUS[status];
  return (
    <span data-status-word={status} title={title ?? meta.meaning} className={`${meta.text} ${className}`}>
      {word ?? meta.word}
    </span>
  );
}

/** Mark then word: a state named on its own (a /sessions row, a board count). */
export function SessionStatusLabel({ status, title, className = "" }: { status: SessionStatus; title?: string; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${className}`}>
      <SessionStatusMark status={status} labeled />
      <SessionStatusWord status={status} title={title} className="font-medium" />
    </span>
  );
}
