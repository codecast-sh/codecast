import { useMemo } from "react";
import { pulseText, teamPulse, type PulseTone, type TeamPulse } from "./teamPulse";
import { usePeopleRoster, type PeopleRosterData } from "./usePeopleRoster";

/** The pulse from roster data a caller already holds — no second subscription. */
export function usePulseFrom({ members, fleets, huddles }: PeopleRosterData): TeamPulse {
  return useMemo(
    () => teamPulse(members, (m: any) => fleets.get(String(m._id)), huddles),
    [members, fleets, huddles],
  );
}

/**
 * The team's pulse from the roster's own reads. The roster hook is already
 * signature-gated, so this wakes exactly when a face would.
 */
export function useTeamPulse(): TeamPulse {
  return usePulseFrom(usePeopleRoster());
}

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
 * reads the numbers first and the words only when it wants them. A running
 * fleet's dot breathes: the one thing on this line that is moving is the one
 * thing that IS moving.
 */
export function TeamPulseLine({
  pulse,
  max = Infinity,
  wrap = false,
  className = "",
}: {
  pulse: TeamPulse;
  /** Cut to the first N segments for a narrow slot. */
  max?: number;
  /** Let the segments run onto a second line (a header has the height; a
   *  strip does not). */
  wrap?: boolean;
  className?: string;
}) {
  const segments = pulse.segments.slice(0, max);
  return (
    <div
      className={`people-pulse flex min-w-0 items-center gap-x-2 whitespace-nowrap leading-none ${
        wrap ? "flex-wrap gap-y-1.5" : "overflow-hidden"
      } ${className}`}
      title={pulseText(pulse)}
      aria-label={`Team: ${pulseText(pulse)}`}
    >
      {segments.map((seg) => (
        <span key={seg.key} className="flex shrink-0 items-center gap-1">
          <span
            aria-hidden="true"
            className={`people-pulse-dot h-1.5 w-1.5 rounded-full ${TONE[seg.tone].dot}`}
            data-live={seg.tone === "working" || seg.tone === "needsInput" ? "1" : undefined}
          />
          {seg.n > 0 && (
            <span className={`font-semibold tabular-nums ${TONE[seg.tone].text}`}>{seg.n}</span>
          )}
          <span className="text-sol-text-dim">{seg.word}</span>
        </span>
      ))}
    </div>
  );
}
