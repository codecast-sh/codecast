/**
 * Wedge detection and recovery guidance, in one place.
 *
 * Every layer that talks to the browser can hit the same three failures: the
 * browser is gone, the browser exists but is not answering, or one tab's
 * renderer is blocked while the rest of Chrome is fine. Each demands a
 * different reaction from the agent, and the wrong reaction is destructive —
 * "restart it" on an overloaded shared browser kills every other agent's tabs
 * (the 2026-08-14 stampede). So the classification and the words that go with
 * it live here, and both the direct CLI path and the daemon-resident driver
 * import them rather than each phrasing its own version.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { CdpTimeout, type CdpClient } from "./cdp.js";
import type { InstanceState, Liveness } from "./instance.js";

/** Raised when a tab's renderer will not answer, with the way out. */
export class TabUnresponsive extends Error {
  constructor(
    public readonly targetId: string,
    detail: string,
  ) {
    super(
      `tab ${targetId.slice(0, 8)} did not respond (${detail}).\n` +
        `  Usually its renderer is blocked — a modal JavaScript dialog waiting on a click, or a script in a tight loop.\n` +
        `  It can also just be busy: this browser is shared with every other agent on the machine.\n` +
        `  Try the command again first. If it keeps failing: cast browser close --tab ${targetId.slice(0, 8)}`,
    );
    this.name = "TabUnresponsive";
  }
}

/**
 * `instanceof` does not survive a trip through the daemon: an error raised in
 * the resident host arrives at the CLI as `{name, message}` and is rebuilt as a
 * plain Error carrying the name. Callers that branch on this failure ask here.
 */
export function isTabUnresponsive(err: unknown): boolean {
  return err instanceof TabUnresponsive || (err instanceof Error && err.name === "TabUnresponsive");
}

/** Rebuild an error that crossed the daemon boundary, keeping its name. */
export function reviveError(wire: { name?: string; message: string }): Error {
  const err = new Error(wire.message);
  if (wire.name) err.name = wire.name;
  return err;
}

/**
 * Turn on the domains every command needs, with a bounded wait that separates
 * "busy" from "blocked".
 *
 * Each enable needs the renderer to answer, so a wedged tab hangs here rather
 * than anywhere interesting. It is retried once, because a single slow answer
 * is not proof of a wedge: one Chrome serves every agent on the machine, and a
 * burst of parallel work makes a healthy tab miss a ten-second deadline —
 * condemning it then tells the agent to close a page that was only busy. A
 * truly blocked renderer stays blocked, so a second attempt tells them apart.
 */
export interface EnablePatience {
  /** First attempt, then the retry. Ten and fifteen seconds in production. */
  attemptsMs: [number, number];
  pauseMs: number;
}
export const DEFAULT_ENABLE_PATIENCE: EnablePatience = { attemptsMs: [10_000, 15_000], pauseMs: 500 };

export async function enablePageDomains(
  conn: CdpClient,
  sessionId: string,
  targetId: string,
  patience: EnablePatience = DEFAULT_ENABLE_PATIENCE,
): Promise<void> {
  // In parallel: five round trips to the renderer collapse into one. CDP
  // executes them in order on the session either way; only the waiting is
  // overlapped, and a fresh CLI process pays this on every single command.
  const enableAll = (timeoutMs: number) =>
    Promise.all(
      ["Page", "DOM", "Runtime", "Accessibility", "Network"].map((domain) =>
        conn.send(`${domain}.enable`, {}, sessionId, timeoutMs),
      ),
    ).then(() => undefined);
  try {
    await enableAll(patience.attemptsMs[0]);
  } catch (err) {
    if (!(err instanceof CdpTimeout)) throw err;
    await sleep(patience.pauseMs);
    try {
      await enableAll(patience.attemptsMs[1]);
    } catch (retryErr) {
      if (retryErr instanceof CdpTimeout) throw new TabUnresponsive(targetId, retryErr.message);
      throw retryErr;
    }
  }
}

/** True when a CDP session id no longer exists — the tab was closed under us. */
export function isStaleSession(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Session with given id not found|Target closed|No session with given id/i.test(msg);
}

/** Name the likely killer when the socket dies under a command. */
export function explainConnectionLoss(msg: string): string {
  return msg.includes("CDP connection closed") || msg.includes("CDP connection is not open")
    ? `${msg} — the browser was stopped or restarted (usually by another agent) mid-command. Run the command again.`
    : msg;
}

export interface Problem {
  message: string;
  hint: string;
}

/**
 * Thrown when a command needs a live browser and there is none. Carries the
 * verdict so the CLI can print the matching guidance and, for "dead", offer to
 * start one — the reaction differs by verdict, so the verdict must travel.
 */
export class BrowserNotLive extends Error {
  constructor(
    public readonly liveness: Liveness,
    public readonly state: InstanceState | null,
  ) {
    super(livenessProblem(liveness, state)?.message ?? `browser is ${liveness}`);
    this.name = "BrowserNotLive";
  }
  get problem(): Problem {
    return livenessProblem(this.liveness, this.state)!;
  }
}

/**
 * What to tell the agent when the browser is not usable. "gone" and "not
 * answering" get different messages on purpose: a dead browser should be
 * restarted, while an overloaded one must NOT be — the recovery agents reach
 * for on "no browser is running" is stop/start, which kills every other
 * agent's tabs. Returns null when the browser is fine.
 */
export function livenessProblem(liveness: Liveness, state: InstanceState | null): Problem | null {
  if (liveness === "live") return null;
  if (liveness === "unresponsive") {
    return {
      message: `the managed browser (pid ${state?.pid}) is not answering CDP right now`,
      hint: "it is likely overloaded, not gone — retry in a few seconds. Do not stop/start it: other agents' tabs die with it.",
    };
  }
  return {
    message: "no managed browser is running",
    hint: "start one with `cast browser start` (it clones your Chrome profile, so you stay logged in)",
  };
}
