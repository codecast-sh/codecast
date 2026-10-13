// What moved a problem off For you while a person had it open, or before they followed a link to it
// (line-journeys.md LJ8.1): read from the problem's own newest event, so the reader says whether someone answered,
// a run took it on, or it closed, instead of only that it no longer waits.
import type { CauseHistory } from "./causeHistory";
import { ageShort } from "../lineFlow";

export type LeftWhy = {
  /** What moved it, newest event first: "Run 3 started 7m ago after a new finding", "Answered by Cam 5m ago: Ship",
   *  "Closed as fixed 2h ago". Null when its history records nothing that moved it. */
  moved: string | null;
  /** The run the event belongs to, to open beside the problem. */
  runId: string | null;
};

/** A finding this close before a run's start is what started it. */
const STARTED_BY = 2 * 3_600_000;

const CLOSED: Record<string, string> = { shipped: "Closed as fixed", dissolved: "Closed without a change", dropped: "Dropped" };

export function leftWhy(h: Pick<CauseHistory, "attempts" | "closes" | "occurrences">, names: ReadonlyMap<string, string>, now: number): LeftWhy {
  const ago = (at: number) => `${ageShort(now - at)} ago`;
  const events: Array<{ at: number; moved: string; runId: string }> = [];
  for (const [i, a] of h.attempts.entries()) {
    const prev = h.attempts[i - 1];
    const finding = h.occurrences.some((o) => o.at <= a.start && o.at >= a.start - STARTED_BY && (!prev || o.at > prev.start));
    events.push({ at: a.start, runId: a.runId, moved: `Run ${a.n} ${a.n > 1 ? "started again" : "started"} ${ago(a.start)}${finding ? " after a new finding" : ""}` });
    if (a.end != null && !a.live && !h.closes.some((c) => c.runId === a.runId)) events.push({ at: a.end, runId: a.runId, moved: `Run ${a.n} ended ${ago(a.end)}: ${a.outcome.text}` });
    const c = a.card;
    if (c?.answer && c.answeredAt) {
      const who = c.answeredBy ? names.get(c.answeredBy) ?? "a teammate" : "the line";
      events.push({ at: c.answeredAt, runId: a.runId, moved: `Answered by ${who} ${ago(c.answeredAt)}: ${c.answer}` });
    }
  }
  for (const c of h.closes) events.push({ at: c.at, runId: c.runId, moved: `${CLOSED[c.kind] ?? "Closed"} ${ago(c.at)}` });
  // The newest event; at a tie (a run's end and its close), the later-listed close says more.
  const top = events.reduce<(typeof events)[number] | null>((b, e) => (!b || e.at >= b.at ? e : b), null);
  return top ? { moved: top.moved, runId: top.runId } : { moved: null, runId: h.attempts[h.attempts.length - 1]?.runId ?? null };
}
