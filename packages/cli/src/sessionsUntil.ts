// `cast sessions <ids> -w --until <states>`: the watch exits once every
// watched session rests in one of the named work states. A plain -w never
// exits, so an agent that waits on it in a background shell is never woken by
// the shell ending: the session sat "waiting" on an open task for days after
// every worker it watched had finished.
import { WORK_STATES } from "@codecast/shared/contracts";

// Everything but "working": the session's turn is over, whoever acts next.
export const SETTLED_STATES: readonly string[] = WORK_STATES.filter((s) => s !== "working");

/** Parse the flag's value: "settled" (or no value), or a comma list of work
 *  states in either spelling ("needs-input", "needs_input"). Throws on an
 *  unknown state so a typo cannot turn into a watch that never ends. */
export function parseUntilStates(value: string | boolean | undefined): Set<string> {
  const raw = typeof value === "string" ? value : "settled";
  const states = new Set<string>();
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase().replace(/-/g, "_")).filter(Boolean)) {
    if (part === "settled") SETTLED_STATES.forEach((s) => states.add(s));
    else if ((WORK_STATES as readonly string[]).includes(part)) states.add(part);
    else throw new Error(`--until: unknown state "${part}" (use settled, or any of ${WORK_STATES.join(", ")})`);
  }
  if (states.size === 0) throw new Error("--until: name at least one state");
  return states;
}

/** The watch may stop: it has seen at least one session, and every session it
 *  still holds rests in one of `states`. A session that left the set (killed,
 *  dismissed) has nothing more to report, so it does not hold the watch open. */
export function untilReached(states: ReadonlySet<string>, current: Record<string, { state: string }>, seenAny: boolean): boolean {
  if (!seenAny) return false;
  return Object.values(current).every((r) => states.has(r.state));
}
