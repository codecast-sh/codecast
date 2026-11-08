// Moving one live Claude session between the tmux and SDK backends. The
// session keeps its id and transcript: the old backend stops at a safe point
// (no turn running, or after the person agreed to interrupt it), then the
// other backend resumes the same session. The daemon supplies each step
// (switchConversationBackend in daemon.ts); this file owns the order, the
// hold that keeps anything else from starting the session meanwhile, and the
// honest outcome.

import type { ClaudeBackend } from "./select.js";

export interface BackendSwitchDeps {
  /** Which backend runs the conversation now. */
  current: () => ClaudeBackend;
  /** The running turn's status ("working", …), or null when no turn runs. */
  busy: () => Promise<string | null>;
  /** Why the SDK backend cannot run this session, or null. Asked only before a move to the SDK. */
  sdkRefusal: () => Promise<string | null>;
  /** Interrupt the running turn on the current backend. */
  interrupt: () => Promise<void>;
  /** Wait for a resume already under way (a delivery, a Restart) to finish, so the stop sees what it started. */
  settleResumes: () => Promise<void>;
  /** Stop the current backend: pane or host gone, open permission cards cancelled. */
  stop: () => Promise<void>;
  /** Resume the same session in an SDK host. Throws with the reason when it does not come up. */
  startSdk: () => Promise<void>;
  /** Resume the same session with `claude --resume` in a new pane. False when it did not start. */
  startTmux: () => Promise<boolean>;
  /** Put messages the old backend took but never echoed back to pending, for whatever runs the session now. */
  requeue: () => Promise<void>;
  log: (line: string) => void;
  /** How long an interrupted turn may take to wind down. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type BackendSwitchOutcome =
  | { ok: true; backend: ClaudeBackend; already?: boolean; fellBack?: string }
  | { ok: false; reason: "busy" | "refused" | "failed"; message: string };

// Conversations and session ids mid-switch. While one is held, no automatic
// resume, delivery-driven resume or second switch may start its session: the
// switch is the only thing that brings it back (backendSwitchHeld).
const held = new Set<string>();

/** A delivery that reached a session mid-switch: held, retried at this pace without spending its retry budget. */
export class BackendSwitchHoldError extends Error {
  readonly holdReason = "its backend is switching";
  constructor(readonly recheckMs = 3000) {
    super("the session is moving between the terminal and the Agent SDK");
  }
}

// Held keys a kill or a park asked to stop: the switch ends without starting the other backend.
const cancelled = new Set<string>();

// Each running switch by its hold keys, so a kill can wait for a cancelled one to let go.
const running = new Map<string, Promise<unknown>>();

/**
 * A kill of a session being switched: the switch stops it and starts nothing.
 * Resolves once that switch has let go of the session, so a resume right
 * behind the kill (a Restart) is not refused by a hold already cancelled.
 */
export async function cancelBackendSwitch(...keys: (string | undefined)[]): Promise<void> {
  const runs = new Set<Promise<unknown>>();
  for (const k of keys) {
    if (!k || !held.has(k)) continue;
    cancelled.add(k);
    const run = running.get(k);
    if (run) runs.add(run);
  }
  await Promise.all([...runs].map((r) => r.catch(() => {})));
}

/** Is a backend switch moving this conversation or session right now? */
export function backendSwitchHeld(...keys: (string | undefined)[]): boolean {
  return keys.some((k) => !!k && held.has(k));
}

export async function switchClaudeBackend(
  deps: BackendSwitchDeps,
  req: { target: ClaudeBackend; interrupt: boolean; holdKeys: string[] },
): Promise<BackendSwitchOutcome> {
  if (backendSwitchHeld(...req.holdKeys)) return { ok: false, reason: "busy", message: "This session is already switching" };
  for (const k of req.holdKeys) held.add(k);
  const switching = run(deps, req);
  for (const k of req.holdKeys) running.set(k, switching);
  try {
    return await switching;
  } finally {
    for (const k of req.holdKeys) { held.delete(k); cancelled.delete(k); running.delete(k); }
  }
}

async function run(deps: BackendSwitchDeps, req: { target: ClaudeBackend; interrupt: boolean; holdKeys: string[] }): Promise<BackendSwitchOutcome> {
  const killed = () => req.holdKeys.some((k) => cancelled.has(k));
  const from = deps.current();
  if (from === req.target) return { ok: true, backend: from, already: true };

  // Refused before anything stops, so a session that cannot run on the SDK keeps running where it is.
  if (req.target === "sdk") {
    const refusal = await deps.sdkRefusal();
    if (refusal) return { ok: false, reason: "refused", message: `Stays in the terminal: ${refusal}` };
  }

  const status = await deps.busy();
  if (status) {
    if (!req.interrupt) return { ok: false, reason: "busy", message: `A turn is running (${status}); switching would interrupt it` };
    await deps.interrupt();
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (deps.settleMs ?? 30_000);
    let still: string | null = status;
    while (still && !killed() && Date.now() < deadline) {
      await sleep(250);
      still = await deps.busy();
    }
    // Past the deadline the stop below ends the turn anyway; the person already agreed to that.
    if (still) deps.log(`[backend-switch] turn still ${still} after the interrupt; stopping it`);
  }

  if (!killed()) await deps.settleResumes();
  await deps.stop();
  const stoppedMeanwhile: BackendSwitchOutcome = { ok: false, reason: "failed", message: "The session was stopped during the switch" };
  if (killed()) return stoppedMeanwhile;
  const outcome = await start(deps, req.target);
  // A kill that landed while the new backend came up wins: stop it again, and put nothing back to pending.
  if (killed()) {
    await deps.stop();
    return stoppedMeanwhile;
  }
  // Only now: a message put back while nothing ran the session would have resumed it on the old backend.
  await deps.requeue();
  return outcome;
}

async function start(deps: BackendSwitchDeps, target: ClaudeBackend): Promise<BackendSwitchOutcome> {
  if (target === "tmux") {
    return (await deps.startTmux())
      ? { ok: true, backend: "tmux" }
      : { ok: false, reason: "failed", message: "Claude did not start in a terminal; the next message resumes it" };
  }
  try {
    await deps.startSdk();
    return { ok: true, backend: "sdk" };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    deps.log(`[backend-switch] SDK host did not come up (${why}); resuming in tmux`);
    // The session was stopped for the move: it runs again in the terminal rather than not at all.
    return (await deps.startTmux())
      ? { ok: true, backend: "tmux", fellBack: why }
      : { ok: false, reason: "failed", message: `Neither backend started: ${why}` };
  }
}
