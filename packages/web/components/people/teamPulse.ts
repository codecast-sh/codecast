// The team in one line: who is here, what is running, who is waiting on a
// person, and how many huddles are open. Read from data the roster already
// holds, so it costs no subscription and can never disagree with the rows.
// React-free so it is unit-testable under bun.
import { memberPresenceVisual, type FleetSummary } from "../presence/memberPresence";

export type PulseTone = "here" | "idle" | "away" | "working" | "needsInput" | "huddle" | "quiet";

export interface PulseSegment {
  key: PulseTone;
  n: number;
  /** The words after the number: "here", "agents working". */
  word: string;
  tone: PulseTone;
}

export interface TeamPulse {
  here: number;
  idle: number;
  away: number;
  offline: number;
  working: number;
  needsInput: number;
  huddles: number;
  /** The segments worth printing, most useful first, zero counts dropped. */
  segments: PulseSegment[];
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Counts, then the segments. A zero is silence: "0 idle" tells nobody
 * anything, and a strip has room for three or four words.
 *
 * Order is what the reader can ACT on: a session waiting on somebody first
 * (that is an ask), then who is at their machine, then what is running, then
 * the quieter facts. When nobody at all is present the line says so plainly
 * rather than listing absences.
 */
export function teamPulse<T>(
  members: T[],
  fleetOf: (m: T) => FleetSummary | null | undefined,
  huddles: number,
): TeamPulse {
  let here = 0, idle = 0, away = 0, offline = 0, working = 0, needsInput = 0;
  for (const m of members) {
    if (!m) continue;
    const v = memberPresenceVisual(m);
    if (v === "active" || v === "busy") here++;
    else if (v === "idle") idle++;
    else if (v === "away") away++;
    else offline++;
    const f = fleetOf(m);
    if (f) {
      working += f.working;
      needsInput += f.needsYou;
    }
  }
  const segments: PulseSegment[] = [];
  const push = (key: PulseTone, n: number, word: string) => {
    if (n > 0) segments.push({ key, n, word, tone: key });
  };
  push("needsInput", needsInput, plural(needsInput, "needs input", "need input"));
  push("here", here, "here");
  push("working", working, plural(working, "agent working", "agents working"));
  push("huddle", huddles, plural(huddles, "huddle", "huddles"));
  push("idle", idle, "idle");
  push("away", away, "away");
  if (segments.length === 0) {
    segments.push({
      key: "quiet",
      n: 0,
      word: offline > 0 ? "nobody here" : "no teammates yet",
      tone: "quiet",
    });
  }
  return { here, idle, away, offline, working, needsInput, huddles, segments };
}

/** The line as plain words, for a title attribute or a narrow slot:
 *  "2 need input · 3 here · 9 agents working". */
export function pulseText(pulse: TeamPulse, max = Infinity): string {
  return pulse.segments
    .slice(0, max)
    .map((s) => (s.n > 0 ? `${s.n} ${s.word}` : s.word))
    .join(" · ");
}
