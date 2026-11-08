// `cast sessions <ids> --until [states]`: block until every watched session
// rests in one of the states, instead of a hand-rolled sleep loop. With -w the
// change stream runs as usual and exits at the same point. A plain -w never
// exits, so an agent that waits on it in a background shell is never woken by
// the shell ending: a session sat "waiting" on an open task for days after
// every worker it watched had finished.

import { normalizeWorkStateFilter, threadStateHeadline, WORK_STATES } from "@codecast/shared/contracts";

// Everything but "working": the session's turn is over, whoever acts next.
export const SETTLED_STATES: readonly string[] = WORK_STATES.filter((s) => s !== "working");

/** The states `--until` waits for: "settled" (the default when the flag has no
 *  value), or a comma list of work states in either spelling ("needs-input",
 *  "needs_input"). Throws on anything else so a typo cannot become a wait that
 *  never ends. */
export function parseUntilStates(value: string | boolean | undefined): Set<string> {
  const raw = typeof value === "string" ? value : "settled";
  const out = new Set<string>();
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (part.toLowerCase() === "settled") {
      SETTLED_STATES.forEach((s) => out.add(s));
      continue;
    }
    const state = normalizeWorkStateFilter(part);
    if (!state || !(WORK_STATES as readonly string[]).includes(state)) {
      throw new Error(`--until takes settled or work states: ${WORK_STATES.map((s) => s.replace("_", "-")).join(", ")} (comma separated); '${part}' is not one`);
    }
    out.add(state);
  }
  if (out.size === 0) throw new Error("--until needs at least one state");
  return out;
}

/** -w --until may stop: it has seen at least one session, and every session it
 *  still holds rests in one of `states`. A session that left the set (killed,
 *  dismissed) has nothing more to report, so it does not hold the watch open. */
export function untilReached(states: ReadonlySet<string>, current: Record<string, { state: string }>, seenAny: boolean): boolean {
  if (!seenAny) return false;
  return Object.values(current).every((r) => states.has(r.state));
}

export interface SettleEvent {
  id: string;
  short_id: string;
  title: string | null;
  to: string;
  thread_state: string | null;
}

/**
 * The watched rows that newly reached a wanted state (or were killed: a
 * retired session will not settle any further), marking them in `settled`.
 */
export function settleRows(rows: any[], watched: Set<string>, settled: Set<string>, wanted: Set<string>): SettleEvent[] {
  const out: SettleEvent[] = [];
  for (const r of rows) {
    if (!watched.has(r.id) || settled.has(r.id)) continue;
    const to = r.is_killed ? "killed" : String(r.work_state);
    if (to !== "killed" && !wanted.has(to)) continue;
    settled.add(r.id);
    out.push({
      id: r.id,
      short_id: r.short_id ?? String(r.id).slice(0, 7),
      title: r.title ?? null,
      to,
      thread_state: threadStateHeadline(r.thread_state || "") || null,
    });
  }
  return out;
}
