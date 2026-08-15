/**
 * `cast browser stop` on the agent-browser engine.
 *
 * The engine already isolates sessions: `close` takes down only the caller's
 * session, and other sessions keep answering (verified on 0.34.0). What is
 * NOT safe there is `close --all`, which closes every session on the machine
 * — other agents' and the human's own unnamed session alike (after one
 * session's `close --all`, `session list` was empty and every later command
 * silently launched a fresh browser with nothing in it). So the shared-fate
 * guard applies to that one path, under the same contract as the built-in
 * engine (refcount.ts): plain `stop` releases only what is yours; `--force`
 * takes everyone down and says exactly who.
 *
 * The words describe what `--force` DOES, not how sessions map onto Chrome
 * processes: on one machine `session list` reported 19 sessions against 9
 * agent-browser user-data-dirs, so "each session is its own Chrome" cannot be
 * claimed, and in `--cdp` mode the engine drives a Chrome it did not launch.
 * `engineCdpEndpoint()` (engine.ts) can resolve a session to its port when a
 * caller needs the topology; the warning here does not depend on it.
 *
 * Pure: the caller supplies the engine's session list
 * (`agent-browser session list --json` → data.sessions) and its own session
 * name (`engineSession()`), and gets back the `close` arguments to run and
 * the words to print. Nothing here shells out, so it is trivially testable
 * and independent of how the adapter reaches the engine.
 */

import { decideStop, describeHolders, type StopPlan } from "./refcount.js";

export interface EngineStopPlan {
  plan: StopPlan;
  /** Arguments after `close`: `["--all"]` for a forced teardown, else none. */
  closeArgs: string[];
  /** Printed before running, when other sessions are about to die. */
  warning: string | null;
  /** Printed after a successful close. */
  summary: string;
}

export function planEngineStop(input: { sessions: string[]; me: string; force?: boolean }): EngineStopPlan {
  const plan = decideStop({ others: input.sessions, me: input.me, force: input.force });
  const others = plan.others;
  // The engine's own vocabulary: --all is the teardown that crosses sessions.
  const crossSession = plan.action === "teardown" && (input.force ?? false) && others.length > 0;
  return {
    plan,
    closeArgs: crossSession ? ["--all"] : [],
    warning: crossSession
      ? `closes every browser session on this machine, not just yours — ${others.length} other(s) lose their tabs and state: ${describeHolders(others)}`
      : null,
    summary: crossSession
      ? `closed every browser session (${others.length + 1}), including other agents' and the human's`
      : others.length
        ? `closed this session's browser; ${others.length} other session(s) keep theirs: ${describeHolders(others)}`
        : "closed this session's browser",
  };
}
