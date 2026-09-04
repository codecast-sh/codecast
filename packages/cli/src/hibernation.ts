// Which live sessions the daemon parks to keep the fleet under its cap.
//
// Hibernation is the reaper's teardown applied for a different reason. The
// reaper retires a terminal nobody is coming back to: five hours of transcript
// silence, an idle pane, a finished turn, and the conversation already out of
// the inbox. Hibernation touches sessions that are perfectly healthy and only
// asks whether the machine can afford to keep them warm. So it needs its own
// verdict, and this module is that verdict and nothing else: no filesystem, no
// tmux, no daemon import, so the test for it never loads daemon.ts.
//
// The expensive per-session gates (a pending question, the conversation
// lifecycle, process ownership) stay in the daemon, applied only to the handful
// this module picks. Everything cheap enough to hold in memory lives here.

import { MID_TURN_AGENT_STATUSES, type AgentStatus } from "@codecast/shared/contracts";

// Absent config = hibernation does nothing. 0 means "no cap" for the fleet size
// and "no idle bar" for the age, so a daemon nobody configured never parks a
// session by surprise.
//
// The fleet plan settles on 60 live sessions and two hours of awake idle, and
// those are the values to set here once the inbox reads a parked session as
// parked rather than as a crashed one. Until then the knobs ship off and a
// person turns them on in config.json. See config/types.ts.
//
// Shipping off is a deliberate deviation from the plan, not an oversight: on a
// fleet of about 200 a cap of 60 parks roughly 140 sessions over the first few
// hours, and every one of them reads as an ordinary cold session until the
// inbox learns the parked state. The founder holds the open decision on the
// value (cast decide k97v0wxs85cg7z6gq5s7g2p3ks8drt7t); do not raise these
// numbers before it is answered.
export const DEFAULT_MAX_LIVE_SESSIONS = 0;
export const DEFAULT_HIBERNATE_IDLE_MS = 0;

// The reaper's gentle drain, for the same reason: the first kills of any pass
// stay small enough to read in reaper.log, and each pick costs a lifecycle
// query, so this also bounds the pass's fan-out to Convex.
export const HIBERNATE_MAX_PER_PASS = 5;

// A session resumed this recently is one somebody just asked for. Parking it
// would undo a resume that is still settling, and the resume itself may not have
// produced any activity yet.
export const HIBERNATE_RESUME_GRACE_MS = 10 * 60 * 1000;

// How long a subagent's own transcript must stay quiet before the daemon stops
// treating its parent as busy. A headless child (a Task tool agent, a `claude
// -p` the agent launched) runs inside the parent pane's process tree, and the
// teardown takes that tree down, so the parent has to outlive the child. Ten
// minutes matches the resume grace: long enough to cover a child between two
// tool calls, short enough that a finished child stops protecting its parent.
export const HIBERNATE_SUBAGENT_QUIET_MS = 10 * 60 * 1000;

export type HibernationCandidate = {
  sessionId: string;
  /** The tmux session holding the pane. */
  tmux: string;
  conversationId?: string;
  /** Last status the daemon sent for this session. */
  status?: AgentStatus;
  /** Idle time that excludes machine sleep (getSessionAwakeIdleMs). */
  awakeIdleMs: number;
  /** How long the session has held its current status. Breaks idle ties. */
  statusDwellMs: number;
  /** tmux clients attached to this session — a human is watching. */
  attachedClients: number;
  /** Another session's pane is the same tmux: a parent and its subagent. */
  sharedPane: boolean;
  /**
   * Since a subagent of this session last wrote to its own transcript.
   * Infinity when this session has no subagent the daemon has ever seen run.
   */
  subagentActiveAgoMs: number;
  /** Since the last resume of this session. Infinity when it never resumed. */
  resumedAgoMs: number;
  /** Undelivered or in-flight messages for the conversation. */
  messagesInFlight: boolean;
};

export type HibernationPolicy = {
  /** Live sessions allowed before the cap starts parking. 0 = no cap. */
  maxLive: number;
  /** Awake idle age that parks a session on its own. 0 = no idle bar. */
  idleMs: number;
  maxPerPass: number;
};

/**
 * Why this session must stay live, or null when it may be parked. One stable
 * string per rule, in the reaper's vocabulary, so summarizeReapSkips can bucket
 * them into the pass line.
 */
export function hibernationBlockReason(c: HibernationCandidate): string | null {
  // Mid-turn work: parking it would kill the turn, not park it. The shared set
  // rather than a second copy of the list, so a status added there is blocked
  // here on the same day. It carries "permission_blocked" for a reason that
  // matters most to hibernation: that turn is not over, it is stopped on a
  // prompt, and the human's answer would arrive at a pane that no longer runs.
  if (MID_TURN_AGENT_STATUSES.has(c.status ?? "")) return "status-working";
  // A resume in progress has no pane worth killing yet and would just retry.
  if (c.status === "resuming" || c.status === "starting") return "status-resuming";
  // "waiting" is the daemon's verdict that the harness holds live background
  // work inside this pane's process tree: a run_in_background command, a
  // Monitor, a workflow that will re-invoke the agent. The teardown kills the
  // whole tree, so parking one of these kills the very process the session is
  // waiting on, and no completion, notification or wake ever arrives.
  if (c.status === "waiting") return "open-background-work";
  // A human has the pane open in a terminal.
  if (c.attachedClients > 0) return "attached";
  // The pane belongs to another session too (a parent running its subagent
  // inside its own process): killing it takes down a session we did not pick.
  if (c.sharedPane) return "shared-pane";
  // A subagent this session launched is still producing. It has no pane of its
  // own: it runs as a child process inside this pane's tree, so the teardown
  // would kill it mid-turn and nothing would ever report its result.
  if (c.subagentActiveAgoMs < HIBERNATE_SUBAGENT_QUIET_MS) return "live-subagents";
  if (c.resumedAgoMs < HIBERNATE_RESUME_GRACE_MS) return "recently-resumed";
  // Work is on its way to this session; parking it would trade the pane for a
  // resume on the very next delivery.
  if (c.messagesInFlight) return "in-flight-messages";
  return null;
}

/**
 * Pick the sessions to park this pass.
 *
 * Two independent reasons to park, both bounded by maxPerPass: the fleet is
 * over its cap (park the longest idle down toward the cap), and a session has
 * been awake and idle past the bar (park it whatever the fleet size). Ordering
 * is longest awake idle first, then longest time in its current status, then
 * session id, so a shuffled input always yields the same picks.
 *
 * A blocked session still COUNTS toward the fleet size — it is live, it costs
 * the machine the same — but it can never be picked to satisfy the overage. A
 * fleet where every candidate is blocked therefore parks nothing.
 */
export function selectHibernationCandidates(
  candidates: HibernationCandidate[],
  policy: HibernationPolicy,
): { picked: HibernationCandidate[]; skips: string[] } {
  const skips: string[] = [];
  const eligible: HibernationCandidate[] = [];
  for (const c of candidates) {
    const reason = hibernationBlockReason(c);
    if (reason) skips.push(reason);
    else eligible.push(c);
  }

  eligible.sort((a, b) =>
    b.awakeIdleMs - a.awakeIdleMs ||
    b.statusDwellMs - a.statusDwellMs ||
    (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
  );

  const over = policy.maxLive > 0 ? Math.max(0, candidates.length - policy.maxLive) : 0;
  const picked: HibernationCandidate[] = [];
  for (let i = 0; i < eligible.length; i++) {
    const c = eligible[i];
    const pastBar = policy.idleMs > 0 && c.awakeIdleMs >= policy.idleMs;
    if (i >= over && !pastBar) continue;
    if (picked.length >= policy.maxPerPass) { skips.push("pass-cap"); continue; }
    picked.push(c);
  }
  return { picked, skips };
}
