// The triage lab's fact model: a small set of switches a person can flip,
// turned into the two inputs the real code takes (today's placeInboxRow input
// and the triage facts), so the lab shows what the shipped rules do with them,
// never a re-implementation.
import { placeInboxRow, type InboxPlacement, type InboxPlacementInput, type UserRest } from "@codecast/shared/contracts";
import { triageOf, type Triage, type TriageFacts, type TriageReason } from "@codecast/shared/contracts/triage";
import { DORMANT_CLAIM_TTL_MS } from "@codecast/shared/contracts";

export type LabAgent = "none" | "starting" | "working" | "compacting" | "idle" | "permission_blocked" | "stopped" | "hibernated";
export type LabDeclared = "none" | "working" | "blocked" | "done" | "dormant";
export type LabVerdict = "none" | "done" | "needs_input";
export type LabApiError = "none" | "limit" | "throttle" | "auth" | "context" | "fatal";
export type LabTrigger = "none" | "standing" | "once";
export type LabParked = "none" | "blocker" | "wait" | "run";
export type LabPr = "none" | "open" | "draft" | "merged" | "closed";
export type LabRest = "none" | UserRest;
export type LabSnooze = "none" | "future" | "due";

export interface LabFacts {
  messages: boolean;
  agent: LabAgent;
  question: boolean;
  decide: boolean;
  declared: LabDeclared;
  verdict: LabVerdict;
  apiError: LabApiError;
  sessionError: boolean;
  unresponsive: boolean;
  queued: boolean;
  worker: boolean;
  loop: boolean;
  trigger: LabTrigger;
  parked: LabParked;
  backgroundTask: boolean;
  claimOld: boolean;
  pr: LabPr;
  rest: LabRest;
  pinned: boolean;
  stashed: boolean;
  snooze: LabSnooze;
  killed: boolean;
  anchor: boolean;
  unread: boolean;
}

export const LAB_DEFAULTS: LabFacts = {
  messages: true, agent: "idle", question: false, decide: false, declared: "none", verdict: "none",
  apiError: "none", sessionError: false, unresponsive: false, queued: false, worker: false, loop: false,
  trigger: "none", parked: "none", backgroundTask: false, claimOld: false, pr: "none", rest: "none",
  pinned: false, stashed: false, snooze: "none", killed: false, anchor: false, unread: true,
};

const HOUR = 3_600_000;

export type LabResult = { today: InboxPlacement; triage: Triage };

/** Runs the shipped placement and triage over the lab's switches at `now`. */
export function runLab(f: LabFacts, now: number): LabResult {
  const messageCount = f.messages ? 12 : 0;
  // A declaration rides the daemon's settle status while the session is live,
  // the way the status hook carries `cast state --status` (done / dormant).
  const settledAgent = f.agent === "idle" && (f.declared === "done" || f.declared === "dormant") ? f.declared : f.agent;
  const agentStatus = settledAgent === "none" ? undefined : settledAgent;
  const isIdle = f.agent !== "starting" && f.agent !== "working" && f.agent !== "compacting";
  const verifiedWake = f.worker || f.loop || f.trigger !== "none" || f.parked !== "none" || f.backgroundTask;
  const updatedAt = now - (f.claimOld ? DORMANT_CLAIM_TTL_MS + HOUR : 10 * 60_000);
  const claimExpired = f.declared === "dormant" && !verifiedWake && f.claimOld;
  const snoozedUntil = f.snooze === "future" ? now + 3 * HOUR : f.snooze === "due" ? now - 60_000 : null;
  const asking = (f.question || f.decide || f.agent === "permission_blocked") && f.messages;
  const userRest = f.rest === "none" ? null : f.rest;
  const placementInput: InboxPlacementInput = {
    agentStatus,
    isIdle,
    awaitingInput: f.question && f.messages,
    hasPending: f.queued,
    isUnresponsive: f.unresponsive,
    messageCount,
    killed: f.killed,
    userRest,
    snoozed: f.snooze === "future",
    snoozeDue: f.snooze === "due",
    armedTriggerHome: f.trigger === "standing",
    armedOnceTriggerHome: f.trigger === "once",
    armedLoopHome: f.loop,
    childProducing: f.worker,
    settleVerdict: f.verdict === "none" ? null : f.verdict,
    declaredStatus: f.declared === "none" ? null : f.declared,
    verifiedWake,
    dormantClaimExpired: claimExpired,
    pendingApiError: f.apiError !== "none",
    sessionError: f.sessionError,
    dismissed: false,
    stashed: f.stashed,
    pinned: f.pinned,
    isAnchor: f.anchor,
    asking,
  };
  const today = placeInboxRow(placementInput);
  const facts: TriageFacts = {
    messageCount,
    updatedAt,
    agentStatus: claimExpired ? "idle" : agentStatus ?? null,
    awaitingInput: placementInput.awaitingInput,
    asking,
    askKind: f.decide ? "decide" : f.agent === "permission_blocked" ? "permission" : f.question ? "question" : null,
    declaredStatus: placementInput.declaredStatus,
    settleVerdict: placementInput.settleVerdict,
    apiError: f.apiError !== "none",
    apiErrorKind: f.apiError === "none" ? null : f.apiError,
    sessionError: f.sessionError,
    unresponsive: f.unresponsive,
    hasPending: f.queued,
    childProducing: f.worker,
    loopArmed: f.loop,
    loopWakeAt: f.loop ? now + 25 * 60_000 : null,
    triggerKind: f.trigger === "none" ? null : f.trigger,
    parkedWakeKind: f.parked === "none" ? null : f.parked,
    openTasks: f.backgroundTask ? 1 : 0,
    pr: f.pr === "none" ? null : { number: 4182, state: f.pr },
    userRest,
    pinned: f.pinned,
    stashed: f.stashed,
    snoozedUntil,
    killed: f.killed,
  };
  return { today, triage: triageOf({ placement: today, facts, unread: f.unread, now }) };
}

export interface LabScenario {
  id: string;
  title: string;
  facts: Partial<LabFacts>;
  /** What the new model should say; the lab test holds every scenario to it. */
  expect: TriageReason;
  expectSection?: "pinned" | "you" | "agent" | "parked" | "settled" | "snoozed" | "stashed" | "retired" | null;
}

/** The situations a person meets, one per row of the lab's gallery. */
export const LAB_SCENARIOS: LabScenario[] = [
  { id: "running", title: "Agent is mid-turn", facts: { agent: "working" }, expect: "running", expectSection: "agent" },
  { id: "starting", title: "Just launched", facts: { agent: "starting" }, expect: "starting", expectSection: "agent" },
  { id: "sending", title: "You sent a message it hasn't picked up", facts: { agent: "idle", queued: true }, expect: "sending", expectSection: "agent" },
  { id: "question", title: "Asked a question (AskUserQuestion)", facts: { question: true }, expect: "question", expectSection: "you" },
  { id: "permission", title: "Waiting on a permission prompt", facts: { agent: "permission_blocked" }, expect: "permission", expectSection: "you" },
  { id: "decide", title: "Queued a cast decide", facts: { decide: true }, expect: "decide", expectSection: "you" },
  { id: "blocked", title: "Declared blocked", facts: { declared: "blocked" }, expect: "blocked", expectSection: "you" },
  { id: "asked-read", title: "Asked in prose, you read it", facts: { verdict: "needs_input", unread: false }, expect: "asked", expectSection: "you" },
  { id: "crashed", title: "Process died with output", facts: { agent: "stopped" }, expect: "stopped", expectSection: "you" },
  { id: "api-fatal", title: "API error that won't retry", facts: { apiError: "fatal" }, expect: "error", expectSection: "you" },
  { id: "login", title: "Signed out of the provider", facts: { apiError: "auth" }, expect: "login", expectSection: "you" },
  { id: "limit", title: "Hit the usage limit", facts: { apiError: "limit" }, expect: "limit", expectSection: "parked" },
  { id: "stale-claim", title: "Said it would wait, nothing will wake it", facts: { declared: "dormant", claimOld: true }, expect: "stale_wait", expectSection: "you" },
  { id: "done-unread", title: "Delivered, not read yet", facts: { declared: "done" }, expect: "delivered", expectSection: "you" },
  { id: "done-read", title: "Delivered, you read it", facts: { declared: "done", unread: false }, expect: "done", expectSection: "settled" },
  { id: "pr-open", title: "Delivered with an open PR", facts: { declared: "done", unread: false, pr: "open" }, expect: "pr_open", expectSection: "you" },
  { id: "pr-merged", title: "Its PR merged", facts: { declared: "done", pr: "merged" }, expect: "merged", expectSection: "settled" },
  { id: "turn-unread", title: "Turn ended, no verdict, unread", facts: {}, expect: "turn_ended", expectSection: "you" },
  { id: "turn-read", title: "Turn ended, no verdict, read", facts: { unread: false }, expect: "idle", expectSection: "settled" },
  { id: "worker", title: "Waiting on its subagent", facts: { declared: "dormant", worker: true }, expect: "worker", expectSection: "parked" },
  { id: "loop", title: "Sleeping on a /loop wakeup", facts: { loop: true }, expect: "loop", expectSection: "parked" },
  { id: "trigger", title: "Home of a standing trigger", facts: { trigger: "standing" }, expect: "trigger", expectSection: "parked" },
  { id: "pr-checks", title: "Waiting on PR checks", facts: { declared: "dormant", parked: "wait", pr: "open" }, expect: "pr_checks", expectSection: "parked" },
  { id: "promise", title: "Said it will wait (fresh claim)", facts: { declared: "dormant" }, expect: "promised", expectSection: "parked" },
  { id: "compacting", title: "Compacting its context", facts: { agent: "compacting" }, expect: "compacting", expectSection: "agent" },
  { id: "context", title: "Context window full", facts: { apiError: "context" }, expect: "context", expectSection: "you" },
  { id: "throttle", title: "Provider throttled it, retry queued", facts: { apiError: "throttle" }, expect: "retrying", expectSection: "parked" },
  { id: "blocker", title: "Its task is blocked by another task", facts: { declared: "dormant", parked: "blocker" }, expect: "blocker", expectSection: "parked" },
  { id: "run", title: "Waiting on a workflow run it started", facts: { declared: "dormant", parked: "run" }, expect: "run", expectSection: "parked" },
  { id: "wait", title: "Waiting on a decision or a time", facts: { declared: "dormant", parked: "wait" }, expect: "waiting", expectSection: "parked" },
  { id: "background", title: "Background task still running", facts: { declared: "dormant", backgroundTask: true }, expect: "background", expectSection: "parked" },
  { id: "follow-up", title: "Delivered, follow-up trigger armed", facts: { declared: "done", trigger: "once" }, expect: "follow_up", expectSection: "parked" },
  { id: "parked-by-you", title: "You moved it to Dormant", facts: { rest: "dormant" }, expect: "parked_by_you", expectSection: "parked" },
  { id: "flagged", title: "You moved it to Needs you", facts: { rest: "needs_input", declared: "done", unread: false }, expect: "flagged", expectSection: "you" },
  { id: "snoozed", title: "You snoozed it", facts: { snooze: "future", declared: "done" }, expect: "snoozed", expectSection: "snoozed" },
  { id: "snooze-due", title: "Snooze ran out", facts: { snooze: "due", declared: "done" }, expect: "snooze_ended", expectSection: "you" },
  { id: "stash-quiet", title: "Stashed, still running", facts: { stashed: true, agent: "working" }, expect: "running", expectSection: "stashed" },
  { id: "stash-asks", title: "Stashed, then it asked", facts: { stashed: true, question: true }, expect: "question", expectSection: "you" },
  { id: "pinned-working", title: "Pinned and running", facts: { pinned: true, agent: "working" }, expect: "running", expectSection: "pinned" },
  { id: "killed", title: "You killed it", facts: { killed: true }, expect: "retired", expectSection: "retired" },
  { id: "new", title: "Blank session", facts: { messages: false }, expect: "new", expectSection: "settled" },
  { id: "anchor", title: "Role's standing session, running its own turns", facts: { anchor: true, trigger: "standing" }, expect: "trigger", expectSection: null },
];
