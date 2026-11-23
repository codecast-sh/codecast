// Placing an inbox row: the wake and pin inputs of classifyWorkState read off
// the row (rowWakeInputs: the wakes the system can stand behind, with the
// server-seen park rowParkedWakeLive, and whether a turn opened after the
// row's pin, rowPinPredatesTurn), the row's placement (placeProjectableRow),
// the instants that placement can flip (rowLiveDeadlines), and the whole
// projection in one call (projectInbox). placeProjectableRow,
// cast sessions and the needs-input push all take the wake inputs from here,
// so the inbox, the CLI and the push agree.
//
// Imported by path (@codecast/shared/contracts/inboxPlacement), never through
// the contracts barrel: the barrel is on the CLI's boot graph
// (bench/bootGraph.guard.test.ts), and no CLI command places inbox rows.
//
// PURE isomorphic code, like inboxProjection.ts.
import { AGENT_IDLE_GRACE_MS, DORMANT_CLAIM_TTL_MS, HEARTBEAT_ALIVE_MS, STATUS_TRUST_TTL_MS } from "./agentStatus";
import { isLoopFresh, LOOP_OVERDUE_GRACE_MS } from "./loopState";
import { openTasksVouchForWaiting } from "./openTasks";
import { isHostedAgentType } from "./agentClients";
import {
  childProducingAt,
  computeFold,
  digestProjection,
  emptyInboxTally,
  isSettleVerdictCurrent,
  placeInboxRow,
  rideLeadPlacements,
  rowLastTurnAllowsPark,
  rowHeartbeatAliveAt,
  selectWorkingSet,
  userRestOf,
  type InboxBucket,
  type InboxPlacement,
  type InboxTally,
  type InboxTruncation,
  type LiveFactsRow,
  type ProjectableInboxRow,
  type WorkingSetWindow,
  type WorkStateInput,
} from "./inboxProjection";

// How long a server-seen "wait" or "run" (conversations.parked_wake_kind)
// vouches for a quiet session: a wait settles on a webhook or a job that can be
// lost, and a run can hang with a live pid or run out of resumes, so neither
// stamp may park a row forever. A run counts besides only while its session's
// daemon reports. A task blocker is exact, so it has no TTL (rowParkedWakeLive).
export const PARKED_WAKE_TTL_MS = 72 * 60 * 60 * 1000;

// Every instant at which one of the row's time terms crosses its threshold
// (design C2): the idle grace on activity and on the status change, the
// heartbeat window (which also ends an open-task vouch), the trust TTL, the
// daemon and production deadlines, and an armed loop going overdue. The server's time flip
// and the replica's recompute scheduler both read this list, so a deadline
// cannot exist on one side only.
export function rowLiveDeadlines(row: LiveFactsRow): Array<number | null> {
  const u = row.updated_at;
  return [
    u + AGENT_IDLE_GRACE_MS,
    u + HEARTBEAT_ALIVE_MS,
    u + STATUS_TRUST_TTL_MS,
    row.agent_status_updated_at != null ? row.agent_status_updated_at + AGENT_IDLE_GRACE_MS : null,
    row.last_heartbeat != null ? row.last_heartbeat + HEARTBEAT_ALIVE_MS : null,
    row.daemon_alive_until ?? null,
    row.producing_until ?? null,
    row.child_asking_until ?? null,
    row.inbox_snoozed_until ?? null,
    row.loop_state?.status === "armed" ? row.loop_state.wakeup_at + LOOP_OVERDUE_GRACE_MS : null,
    // A bare dormant claim outliving its trust (placeProjectableRow).
    u + DORMANT_CLAIM_TTL_MS,
    // A server-seen wake stamp outliving its trust (placeProjectableRow).
    u + PARKED_WAKE_TTL_MS,
  ];
}

// A server-seen park (parked_wake_kind) still vouched for, by what can go
// wrong with each kind. "blocker", an open task on the held task's
// blocked_by, is recomputed on every task write, so it is exact. "wait" (a PR,
// decision or time wait) rests on a webhook or a job that can be lost, so it
// counts only for PARKED_WAKE_TTL_MS of quiet. "run" executes on the
// spawner's machine, whose daemon resumes its runner and tells the subject, so
// it counts only while that session's daemon heartbeat is alive, and, since a
// hung runner is never resumed and a runner that keeps dying runs out of
// resumes, only for PARKED_WAKE_TTL_MS of quiet too.
export function rowParkedWakeLive(row: Pick<ProjectableInboxRow, "parked_wake_kind" | "updated_at" | "last_heartbeat">, epoch: number): boolean {
  const quiet = epoch - row.updated_at < PARKED_WAKE_TTL_MS;
  switch (row.parked_wake_kind) {
    case "blocker": return true;
    case "wait": return quiet;
    case "run": return quiet && rowHeartbeatAliveAt(row, epoch);
    default: return false;
  }
}

// How much later than the pin a person's message must be to take the pin down
// (convex lib/userSend personTurnAnswersPinPatch): the message's time is the
// machine's clock and the pin's the server's, and a daemon can sync the message
// the agent answered by pinning after the pin. Taking the pin down is not
// trusting it: the classifier compares strictly (rowPinPredatesTurn).
export const PIN_TURN_SLACK_MS = 10_000;

// A turn opened after the pin was written (WorkStateInput.pinPredatesTurn).
// Strict, as the daemon compares: a send delivered seconds after a done pin
// opened a turn the pin never answered. A row with no last_turn_at (no turn
// since the stamp existed) falls back to pinPredatesUserMessage.
export function rowPinPredatesTurn(row: Pick<ProjectableInboxRow, "last_turn_at" | "thread_state_at" | "pin_predates_user_message"> & { last_user_message_at?: number | null }): boolean {
  if (row.last_turn_at != null) return row.last_turn_at > (row.thread_state_at ?? 0);
  return row.pin_predates_user_message ?? pinPredatesUserMessage(row);
}

// The fallback for a row with no last_turn_at: the newest user-role message
// came more than LEGACY_PIN_SLACK_MS after the pin. That timestamp also moves
// on tool results (the pin's own `cast state` result lands milliseconds after
// it), hence the slack. Inbox rows carry the answer
// (pin_predates_user_message, computed in enrichInboxSessionRow), never the
// timestamp, which changes on every tool call; readers of the conversation
// doc (cast sessions, the push, the server placement) compute it here.
export const LEGACY_PIN_SLACK_MS = 60_000;
export function pinPredatesUserMessage(conv: { last_turn_at?: number | null; last_user_message_at?: number | null; thread_state_at?: number | null }): boolean {
  return conv.last_turn_at == null && conv.last_user_message_at != null && conv.last_user_message_at > (conv.thread_state_at ?? 0) + LEGACY_PIN_SLACK_MS;
}

// The wakes the system can stand behind (WorkStateInput.verifiedWake). Trigger
// and loop homes are counted raw here (not gated on `park`): a human who spoke
// last starts a turn that re-derives the status anyway, and the question is
// only whether SOMETHING will wake the session. A hosted conversation's
// routine never parks it (rowArmedHomes), so its trigger counts for nothing.
// A child still producing (a --subagent worker the session waits on) is a
// wake too: its result is the next turn. So is a park the server sees
// (parked_wake_kind): a live workflow run the session spawned, an open
// blocker on the task it holds, or a wait (rowParkedWakeLive).
export function rowVerifiedWake(
  row: Pick<ProjectableInboxRow, "armed_trigger_kind" | "agent_type" | "parked_wake_kind" | "updated_at" | "producing_until" | "loop_state" | "open_tasks" | "open_tasks_at" | "last_heartbeat">,
  epoch: number,
): boolean {
  const loop = row.loop_state;
  return (
    (!isHostedAgentType(row.agent_type) && (row.armed_trigger_kind ?? "none") !== "none") ||
    rowParkedWakeLive(row, epoch) ||
    childProducingAt(row, epoch) ||
    (!!loop && loop.status === "armed" && isLoopFresh(loop, epoch)) ||
    openTasksVouchForWaiting(row.open_tasks_at, row.open_tasks?.length ?? 0, rowHeartbeatAliveAt(row, epoch))
  );
}

export type WakeInputs = Pick<WorkStateInput, "verifiedWake" | "pinPredatesTurn" | "pinSpeaks" | "dormantClaimExpired">;

// The wake and pin inputs of classifyWorkState, from the row. Every caller
// (placeProjectableRow, cast sessions, the needs-input push) takes them from
// here, so the inbox, the CLI and the push agree. `agentStatus` is the
// trusted status; `childProducing` is a caller's own read of a producing
// child (the inbox reads it off the row). dormantClaimExpired: a live dormant
// claim (the daemon's, or a fresh dormant pin speaking over a settled idle)
// with no verified wake, quiet past DORMANT_CLAIM_TTL_MS.
export function rowWakeInputs(
  row: Parameters<typeof rowVerifiedWake>[0] & Pick<ProjectableInboxRow, "last_turn_at" | "thread_state_at" | "thread_state_status">,
  status: { trusted: string | null | undefined; raw: string | null | undefined },
  epoch: number,
  childProducing = false,
): WakeInputs {
  const verifiedWake = childProducing || rowVerifiedWake(row, epoch);
  const pinPredatesTurn = rowPinPredatesTurn(row);
  const pinSpeaks = status.trusted === "idle" && status.raw === "working" && row.last_turn_at != null && !pinPredatesTurn;
  const claim = status.trusted === "dormant" || (pinSpeaks && row.thread_state_status === "dormant");
  return {
    verifiedWake,
    pinPredatesTurn,
    pinSpeaks,
    dormantClaimExpired: claim && !verifiedWake && epoch - row.updated_at >= DORMANT_CLAIM_TTL_MS,
  };
}

// The structural parks a row's facts stand behind: a standing or once trigger
// that injects into it, or a fresh /loop wakeup. Each holds only while the
// machine delivered the last turn, and a hosted conversation's routine never
// parks it (its answers file like any turn).
export function rowArmedHomes(
  row: Pick<ProjectableInboxRow, "armed_trigger_kind" | "loop_state" | "agent_type" | "last_turn_allows_park" | "last_message_preview" | "last_user_message">,
  epoch: number,
): { armedTriggerHome: boolean; armedOnceTriggerHome: boolean; armedLoopHome: boolean } {
  const park = rowLastTurnAllowsPark(row);
  const kind = row.armed_trigger_kind ?? "none";
  const hosted = isHostedAgentType(row.agent_type);
  const loop = row.loop_state;
  return {
    armedTriggerHome: kind === "standing" && park && !hosted,
    armedOnceTriggerHome: kind === "once" && park && !hosted,
    armedLoopHome: !!loop && loop.status === "armed" && isLoopFresh(loop, epoch) && park,
  };
}

// The one row → placement adapter: builds the InboxPlacementInput from
// replicated fields and runs the shared placeInboxRow. The server's
// placeConversationRow and every replica surface delegate here, so a rule can
// never exist on one side only.
export function placeProjectableRow(
  row: ProjectableInboxRow,
  asking: boolean,
  epoch: number,
): InboxPlacement {
  return placeInboxRow({
    agentStatus: row.agent_status ?? undefined,
    isIdle: !!row.is_idle,
    awaitingInput: !!row.awaiting_input,
    hasPending: !!row.has_pending_messages,
    isUnresponsive: !!row.is_unresponsive,
    messageCount: row.message_count ?? 0,
    killed: !!row.inbox_killed_at,
    snoozed: !!row.inbox_snoozed_until && row.inbox_snoozed_until > epoch,
    snoozeDue: !!row.inbox_snoozed_until && row.inbox_snoozed_until <= epoch,
    userRest: userRestOf(row),
    ...rowArmedHomes(row, epoch),
    childProducing: childProducingAt(row, epoch),
    settleVerdict: isSettleVerdictCurrent(row as { settle_verdict_at?: number | null; updated_at: number }) ? (row.settle_verdict ?? null) : null,
    declaredStatus: row.thread_state_status ?? null,
    ...rowWakeInputs(row, { trusted: row.agent_status, raw: row.raw_agent_status ?? row.agent_status }, epoch),
    sessionBoundary: row.agent_status_boundary === true,
    pendingApiError: row.pending_api_error === true,
    sessionError: !!row.session_error,
    dismissed: !!row.inbox_dismissed_at,
    stashed: !!row.inbox_stashed_at,
    pinned: !!row.inbox_pinned_at,
    isAnchor: !!row.anchor_id,
    personTurn: row.last_turn_origin === "person",
    asking,
  });
}

// ── The whole projection in one call (design C5/C6) ─────────────────────────

// Inputs a replica derives outside the row (never stored on it): the asking
// flag — own open prompt, pending `cast decide`, or a child's open ask.
export type InboxProjectionInputs = {
  asking?: (id: string) => boolean;
};

// Membership, fold, placement, tallies and digest over a replica's rows at one
// epoch. The show-old view key does not enter the computation — it names which
// tally is the headline (`shown` vs `shown + folded`); both are always
// returned so a toggle costs no recompute. Hidden-bucket rows enter `entries`
// and the digest but never the tallies.
export function projectInbox<Row extends ProjectableInboxRow>(
  rows: Iterable<Row>,
  epoch: number,
  overlays?: InboxProjectionInputs,
): {
  entries: Array<readonly [string, InboxBucket, boolean]>;
  placements: Map<string, InboxPlacement & { below_fold: boolean }>;
  tally: { shown: InboxTally; folded: InboxTally };
  set_digest: string;
  truncated: InboxTruncation[];
  /** Each member's windows — the compare drops a member whose every window
   *  overflowed (C6), so it needs the selection's view of the row. */
  windows: Map<string, WorkingSetWindow[]>;
} {
  const { members, truncated } = selectWorkingSet(rows, epoch);
  const { belowFold } = computeFold(members);
  const entries: Array<readonly [string, InboxBucket, boolean]> = [];
  const placements = new Map<string, InboxPlacement & { below_fold: boolean }>();
  const windows = new Map<string, WorkingSetWindow[]>();
  const tally = { shown: emptyInboxTally(), folded: emptyInboxTally() };
  for (const [id, m] of members) {
    const asking = overlays?.asking?.(id) ?? false;
    placements.set(id, { ...placeProjectableRow(m.row as ProjectableInboxRow, asking, epoch), below_fold: belowFold.has(id) });
    windows.set(id, m.windows);
  }
  // Every member placed on its own facts first, then riders take their lead's
  // place (rideLeadPlacements); the entries and the tally read the final map.
  rideLeadPlacements(placements, (id) => members.get(id)?.row);
  for (const [id, p] of placements) {
    entries.push([id, p.bucket, p.below_fold]);
    if (p.bucket !== "hidden") (p.below_fold ? tally.folded : tally.shown)[p.bucket]++;
  }
  return { entries, placements, tally, set_digest: digestProjection(entries), truncated, windows };
}
