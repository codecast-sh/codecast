// How long a hand station waits on its hand (ct-98764). A hand is given up on
// when it shows no work for a while, never for working long: reviews died at a
// fixed 30 minutes on a machine at load 250-314 while still writing. The quiet
// window stretches with the machine's load, as a loaded machine slows every
// hand down, and a hard cap still ends a hand that never stops.
import { loadScaledMs, machineLoadFactor } from "../machineLoad.js";
import type { ParkedClock } from "./parkedClock.js";

/** The quiet a hand may keep before it is given up on, and the most it may run at all (ms). */
export type HandTimeouts = { idleMs: number; capMs: number };

const HAND_IDLE_MS = 30 * 60_000;
const HAND_CAP_MS = 4 * 60 * 60_000;
// A loaded machine stretches the quiet window this many times at most.
const MAX_LOAD_STRETCH = 4;

/**
 * A hand's quiet window is 30 minutes (RunOptions.agentTimeout, which no flag sets, overrides it); its cap
 * is its node's `timeout` (seconds) when the graph sets one, since a station
 * that replays evals under load needs more than one that writes criteria, else
 * four hours.
 */
export function handTimeouts(node: { timeout?: number }, options: { agentTimeout?: number }): HandTimeouts {
  return { idleMs: options.agentTimeout || HAND_IDLE_MS, capMs: node.timeout ? node.timeout * 1000 : HAND_CAP_MS };
}

/** The clock of one hand's wait: how long it has run (parked time left out, ParkedClock) and when it last showed work. */
export class HandWatch {
  private activeAt: number;
  constructor(private readonly clock: ParkedClock, private readonly limits: HandTimeouts, private readonly loadFactor: () => number = () => machineLoadFactor()) {
    this.activeAt = clock.elapsed();
  }

  /** The hand showed work this poll: its transcript grew, it reads working, or it waits on work it declared. */
  active(): void {
    this.activeAt = this.clock.elapsed();
  }

  /** The quiet window now: stretched for the machine's load. */
  idleWindowMs(): number {
    return loadScaledMs(this.limits.idleMs, MAX_LOAD_STRETCH, this.loadFactor());
  }

  /** Null while the hand may go on; else why its wait is over, in words. */
  over(): string | null {
    const elapsed = this.clock.elapsed();
    if (elapsed >= this.limits.capMs) return `ran ${Math.round(this.limits.capMs / 60_000)}m, its station's limit`;
    const idle = this.idleWindowMs();
    if (elapsed - this.activeAt >= idle) return `showed no work for ${Math.round(idle / 60_000)}m`;
    return null;
  }
}

/** A pane's tail as work shows in it: an agent TUI's status line ticks its spinner and elapsed clock every second even
 *  when the agent is hung ("✻ Thinking… (12m 3s · ↓ 1.2k tokens · esc to interrupt)"), so of that line only its token
 *  count, which moves only when the agent does, is kept. */
export function steadyTail(text: string): string {
  return text.split("\n").map((line) => /esc to interrupt/i.test(line) ? (line.match(/[\d.,]+k?\s*tokens/gi) ?? []).join(" ") : line).join("\n");
}
