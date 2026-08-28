import { pulseText, type PulseTone, type TeamPulse } from "./teamPulse";


/** Same colour language as the rest of the app: presence cyan for here,
 *  yellow for idle, the fleet's green for running agents, its orange for a
 *  session waiting on a person, the huddle's violet. */
const TONE: Record<PulseTone, { text: string; dot: string }> = {
  needsInput: { text: "text-sol-orange", dot: "bg-sol-orange" },
  here: { text: "text-sol-cyan", dot: "bg-sol-cyan" },
  working: { text: "text-sol-green", dot: "bg-sol-green" },
  huddle: { text: "text-sol-violet", dot: "bg-sol-violet" },
  idle: { text: "text-sol-yellow", dot: "bg-sol-yellow" },
  away: { text: "text-sol-text-muted", dot: "bg-sol-text-muted" },
  quiet: { text: "text-sol-text-dim", dot: "bg-sol-text-dim" },
};

/**
 * One line, the count in its colour and the word dimmed after it, so the eye
 * reads the numbers first and the words only when it wants them.
 *
 * A segment is shown WHOLE or not at all. When the line cannot wrap it still
 * flex-wraps — onto a second row the container clips — so a segment that does
 * not fit vanishes instead of shedding its word and leaving a bare count
 * ("· 4" faded mid-phrase was worse than nothing). The title and aria-label
 * always carry the full sentence.
 *
 * Only a person-needed dot breathes. Agents working is this team's all-day
 * steady state, and a pinned window must not pulse in the corner of the eye
 * for eight hours; a session waiting on a HUMAN is the one fact worth motion.
 */
export function TeamPulseLine({
  pulse,
  wrap = false,
  className = "",
}: {
  pulse: TeamPulse;
  /** Let the segments genuinely run onto more lines (a header has the
   *  height; a strip does not). */
  wrap?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      className={`people-pulse flex min-w-0 flex-wrap items-center gap-x-2 whitespace-nowrap leading-none ${
        wrap ? "gap-y-1.5" : "max-h-[1.2em] gap-y-4 overflow-hidden"
      } ${className}`}
      title={pulseText(pulse)}
      aria-label={`Team: ${pulseText(pulse)}`}
    >
      {pulse.segments.map((seg) => (
        <span key={seg.key} className="flex shrink-0 items-center gap-1" aria-hidden="true">
          <span
            className={`people-pulse-dot h-1.5 w-1.5 rounded-full ${TONE[seg.tone].dot}`}
            data-live={seg.tone === "needsInput" ? "1" : undefined}
          />
          {seg.n > 0 && (
            <span className={`text-[1.15em] font-semibold tabular-nums ${TONE[seg.tone].text}`}>
              {seg.n}
            </span>
          )}
          <span className="text-sol-text-dim">{seg.word}</span>
        </span>
      ))}
    </div>
  );
}
