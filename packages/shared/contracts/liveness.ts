import { ACTIVE_AGENT_STATUSES } from "./agentStatus";

// The one vocabulary for "is this process still there?". Three answers, never two.
//
// Loss of contact is not death. A tmux probe that times out, a process table we
// could not read, a pane that vanished mid-question, a machine that stopped
// answering — none of those OBSERVED an exit, and a system that rounds them down
// to "gone" tears down live agents on a hiccup. The daemon has always known this
// and enforced it as boolean asymmetry re-derived at each call site: paneHasNoAgent
// returns false on every uncertain path, paneOwnsPid returns true on every
// uncertain path, the stale-status watchdog reaps only on a positive absence.
// Same rule, three shapes, nothing naming it. This is the name. ct-49557.
//
// Vocabulary and rule taken from Orca's docs/reference/ssh-execution-boundary.md
// (MIT): "Loss of contact is not evidence of exited. Report unverifiable, never
// exited." Do not add synonyms, and never collapse `unverifiable` into either
// neighbour.

/** live: positive contact · unverifiable: we could not ask · exited: observed gone. */
export const LIVENESS_VERDICTS = ["live", "unverifiable", "exited"] as const;

export type LivenessVerdict = (typeof LIVENESS_VERDICTS)[number];

/**
 * The ONLY sanctioned gate for a teardown — a kill, a reap, a pane rebuild, a
 * "completed" stamp. Every such decision asks this rather than testing the
 * verdict itself, so `unverifiable` can never be mistaken for a weak `exited`.
 *
 * liveness.guard.test.ts fails any code path that branches on the verdict
 * literals instead of asking here.
 */
export function authorizesTeardown(verdict: LivenessVerdict): boolean {
  return verdict === "exited";
}

/**
 * Run a probe whose FAILURE is not evidence. Anything the probe throws — a tmux
 * timeout, a killed `ps`, an EPERM on another user's process — answers
 * `unverifiable`, because a question we could not ask has no answer.
 */
export async function verdictFromProbe(
  probe: () => Promise<LivenessVerdict>,
): Promise<LivenessVerdict> {
  try {
    return await probe();
  } catch {
    return "unverifiable";
  }
}

/**
 * A verdict is only as authoritative as the device that produced it. `exited`
 * needs positive evidence from the device that OWNS the process; a probe run
 * anywhere else can report `live` (contact is contact) but never `exited` —
 * another machine's silence is silence.
 *
 * Callers supply their own ownership test rather than a device id, because the
 * daemon already has one (`ownedByAnotherLiveDevice`) and two ownership rules
 * would eventually disagree.
 */
export function confineToOwningDevice(
  verdict: LivenessVerdict,
  probedOnOwningDevice: boolean,
): LivenessVerdict {
  return verdict === "exited" && !probedOnOwningDevice ? "unverifiable" : verdict;
}

/**
 * The verdict a session ROW deserves, for readers that hold a projection rather
 * than a process — `cast sessions`, and any surface showing the same rows.
 *
 * A reader is never a prober: everything it knows came from the owning device's
 * own reports, so the three answers are exactly what those reports support. A
 * live heartbeat is contact. A retired row (killed) is an observed teardown, and
 * so is a settled status — the agent itself said it stopped. A row whose last
 * word from its device was "I am working", with no heartbeat behind it now, is
 * the honest `unverifiable`: nobody watched it end, its daemon simply stopped
 * answering. That row used to render as an ordinary settled one, which is the
 * same rounding-down this vocabulary exists to stop.
 */
export function sessionLivenessVerdict(row: {
  is_live?: boolean | null;
  is_killed?: boolean | null;
  agent_status?: string | null;
}): LivenessVerdict {
  if (row.is_live) return "live";
  if (row.is_killed) return "exited";
  return row.agent_status && ACTIVE_AGENT_STATUSES.has(row.agent_status)
    ? "unverifiable"
    : "exited";
}
