// Triage: the one answer every surface gives about a session, in three
// independent parts.
//
//   lane   who moves next: you, the agent, a machine wake (parked), or nobody
//          (settled).
//   ask    when the lane is `you`, what kind of act: answer a question, fix a
//          failure, or review delivered work. These differ in urgency and in
//          how long they take, so they are part of the state rather than a
//          display detail.
//   shelf  where the person filed it: pinned, snoozed, stashed or retired.
//          A shelf decides which list a row appears in and never changes the
//          lane or the ask, so a pinned or stashed row still says what it is.
//
// Every value has one reason from a closed set, which names the specific
// cause ("question", "worker", "pr_open") so a row can say why in one word.
//
// The verdict comes from the shared placement (placeInboxRow): triage
// regroups that verdict and the row's own facts, so it can never disagree with
// the rules that decide who acts next. Two rules are its own:
//   - An explicit ask (a question, a permission prompt, a `cast decide`, a
//     declared block, an ask the settle classifier read in the reply) stays
//     until it is answered. A turn that simply ended, and delivered work,
//     need the person only until they have read it; after that the session
//     is settled.
//   - A usage limit or a throttle is a machine wake (the limit resets, the
//     retry runs), so it parks instead of asking the person to fix it.
//
// PURE isomorphic code: the server, the CLI, web and mobile run the same bytes.
// Imported by path (@codecast/shared/contracts/triage), never through the
// contracts barrel, which is on the CLI's boot graph.
import { DORMANT_CLAIM_TTL_MS } from "./agentStatus";
import type { InboxBucket, InboxPlacement } from "./inboxProjection";
import type { WorkState } from "./workState";

export const TRIAGE_LANES = ["you", "agent", "parked", "settled"] as const;
export type TriageLane = (typeof TRIAGE_LANES)[number];

export const TRIAGE_ASKS = ["answer", "fix", "review"] as const;
export type TriageAsk = (typeof TRIAGE_ASKS)[number];

export const TRIAGE_SHELVES = ["pinned", "snoozed", "stashed", "retired"] as const;
export type TriageShelf = (typeof TRIAGE_SHELVES)[number];

/** Each reason belongs to exactly one lane (and, in `you`, one ask). */
export const TRIAGE_REASONS = {
  // you · answer: the agent asked, and the ask stands until it is answered.
  question: { lane: "you", ask: "answer", word: "Question" },
  permission: { lane: "you", ask: "answer", word: "Permission" },
  decide: { lane: "you", ask: "answer", word: "Decision" },
  blocked: { lane: "you", ask: "answer", word: "Blocked" },
  asked: { lane: "you", ask: "answer", word: "Asked" },
  // you · fix: it stopped on a failure only the person can clear.
  error: { lane: "you", ask: "fix", word: "Error" },
  stopped: { lane: "you", ask: "fix", word: "Stopped" },
  login: { lane: "you", ask: "fix", word: "Sign in" },
  context: { lane: "you", ask: "fix", word: "Context full" },
  stale_wait: { lane: "you", ask: "fix", word: "Wait expired" },
  // you · review: finished work the person has not read yet.
  delivered: { lane: "you", ask: "review", word: "Done" },
  turn_ended: { lane: "you", ask: "review", word: "Replied" },
  pr_open: { lane: "you", ask: "review", word: "PR open" },
  snooze_ended: { lane: "you", ask: "review", word: "Snooze ended" },
  flagged: { lane: "you", ask: "review", word: "Flagged" },
  // agent: it is moving.
  starting: { lane: "agent", ask: null, word: "Starting" },
  running: { lane: "agent", ask: null, word: "Running" },
  compacting: { lane: "agent", ask: null, word: "Compacting" },
  sending: { lane: "agent", ask: null, word: "Sending" },
  // parked: a machine owns the next move, and the reason names it.
  worker: { lane: "parked", ask: null, word: "Worker running" },
  loop: { lane: "parked", ask: null, word: "Loop" },
  trigger: { lane: "parked", ask: null, word: "Trigger" },
  follow_up: { lane: "parked", ask: null, word: "Follow-up" },
  blocker: { lane: "parked", ask: null, word: "Blocked by task" },
  pr_checks: { lane: "parked", ask: null, word: "PR checks" },
  waiting: { lane: "parked", ask: null, word: "Waiting" },
  run: { lane: "parked", ask: null, word: "Workflow run" },
  background: { lane: "parked", ask: null, word: "Background task" },
  limit: { lane: "parked", ask: null, word: "Usage limit" },
  retrying: { lane: "parked", ask: null, word: "Retrying" },
  promised: { lane: "parked", ask: null, word: "Said it will wait" },
  parked_by_you: { lane: "parked", ask: null, word: "Parked by you" },
  snoozed: { lane: "parked", ask: null, word: "Snoozed" },
  // settled: nobody owes anything.
  done: { lane: "settled", ask: null, word: "Done" },
  idle: { lane: "settled", ask: null, word: "Idle" },
  merged: { lane: "settled", ask: null, word: "Merged" },
  new: { lane: "settled", ask: null, word: "New" },
  retired: { lane: "settled", ask: null, word: "Retired" },
} as const satisfies Record<string, { lane: TriageLane; ask: TriageAsk | null; word: string }>;
export type TriageReason = keyof typeof TRIAGE_REASONS;

export const TRIAGE_LANE_WORDS: Record<TriageLane, string> = {
  you: "Needs you",
  agent: "Working",
  parked: "Parked",
  settled: "Settled",
};

export const TRIAGE_ASK_WORDS: Record<TriageAsk, string> = {
  answer: "Answer",
  fix: "Fix",
  review: "Review",
};

export const TRIAGE_SHELF_WORDS: Record<TriageShelf, string> = {
  pinned: "Pinned",
  snoozed: "Snoozed",
  stashed: "Stashed",
  retired: "Retired",
};

/** The row's facts triage reads beyond the placement verdict. Every field is
 *  optional except the ones a row always has; an absent fact reads as unknown. */
export interface TriageFacts {
  messageCount: number;
  /** When the row last changed (conversations.updated_at): the clock a bare dormant claim runs on. */
  updatedAt: number;
  /** The trusted agent status (deriveLiveAt), never the raw one. */
  agentStatus?: string | null;
  awaitingInput?: boolean;
  /** Own open prompt, a pending `cast decide`, or a child's open ask. */
  asking?: boolean;
  /** What the ask is, when the caller knows: drives the reason word only. */
  askKind?: "question" | "permission" | "decide" | null;
  /** The agent's pinned declaration (thread_state_status). */
  declaredStatus?: string | null;
  /** The settle classifier's verdict for the current settle. */
  settleVerdict?: string | null;
  /** pending_api_error_kind, set only while an API-error banner is unresolved. */
  apiErrorKind?: string | null;
  apiError?: boolean;
  sessionError?: boolean;
  unresponsive?: boolean;
  hasPending?: boolean;
  childProducing?: boolean;
  loopArmed?: boolean;
  loopWakeAt?: number | null;
  triggerKind?: string | null;
  parkedWakeKind?: string | null;
  openTasks?: number;
  pr?: { number: number; state: string } | null;
  userRest?: string | null;
  pinned?: boolean;
  stashed?: boolean;
  snoozedUntil?: number | null;
  killed?: boolean;
  dismissed?: boolean;
}

export interface TriageInput {
  /** The shared placement verdict (placeInboxRow, plus any local overlay). */
  placement: { bucket: InboxBucket | string; work_state: WorkState };
  facts: TriageFacts;
  /** The viewer has not read the session's latest turn. */
  unread: boolean;
  now: number;
}

export interface Triage {
  lane: TriageLane;
  ask: TriageAsk | null;
  reason: TriageReason;
  shelf: TriageShelf | null;
  /** A stashed row that needs an answer or a fix shows in Needs you anyway:
   *  stash hides a session until it needs you. */
  surfaced: boolean;
  /** A standing session running its own turns, kept out of every list. */
  hidden: boolean;
  /** When the parked reason resolves on its own, if known (a snooze, a loop wakeup, a claim's trust running out). */
  until: number | null;
}

const ACTIVE_STARTING = new Set(["starting", "resuming", "connected"]);
const OPEN_PR = new Set(["open", "draft"]);
const MACHINE_RECOVERED_API_ERRORS: Record<string, TriageReason> = { limit: "limit", throttle: "retrying" };
const API_ERROR_FIXES: Record<string, TriageReason> = { auth: "login", context: "context" };

function shelfOf(f: TriageFacts, bucket: string, now: number): TriageShelf | null {
  if (f.killed || f.dismissed || bucket === "dismissed") return "retired";
  if ((f.snoozedUntil ?? 0) > now || bucket === "snoozed") return "snoozed";
  if (f.stashed || bucket === "stashed") return "stashed";
  if (f.pinned) return "pinned";
  return null;
}

function answerReason(f: TriageFacts): TriageReason {
  if (f.askKind === "decide") return "decide";
  if (f.askKind === "permission" || f.agentStatus === "permission_blocked") return "permission";
  return "question";
}

function needsInputReason(f: TriageFacts, unread: boolean, now: number): TriageReason {
  if (f.userRest === "needs_input") return "flagged";
  if (f.snoozedUntil && f.snoozedUntil <= now) return "snooze_ended";
  if (f.awaitingInput || f.asking || f.agentStatus === "permission_blocked") return answerReason(f);
  if (f.declaredStatus === "blocked") return "blocked";
  if (f.apiError) {
    const kind = f.apiErrorKind ?? "";
    return MACHINE_RECOVERED_API_ERRORS[kind] ?? API_ERROR_FIXES[kind] ?? "error";
  }
  if (f.sessionError) return "error";
  if (f.agentStatus === "stopped" || f.unresponsive) return "stopped";
  if (f.declaredStatus === "dormant") return "stale_wait";
  if (f.settleVerdict === "needs_input") return "asked";
  return unread ? "turn_ended" : "idle";
}

function doneReason(f: TriageFacts, unread: boolean): TriageReason {
  const pr = f.pr?.state?.toLowerCase();
  if (pr === "merged") return "merged";
  if (f.userRest === "done") return "done";
  if (pr && OPEN_PR.has(pr)) return "pr_open";
  return unread ? "delivered" : "done";
}

function parkedReason(f: TriageFacts): TriageReason {
  if (f.userRest === "dormant") return "parked_by_you";
  if (f.childProducing) return "worker";
  if (f.loopArmed) return "loop";
  if (f.triggerKind === "standing") return "trigger";
  if (f.parkedWakeKind === "blocker") return "blocker";
  if (f.parkedWakeKind === "run") return "run";
  if (f.parkedWakeKind === "wait") return f.pr && OPEN_PR.has(f.pr.state.toLowerCase()) ? "pr_checks" : "waiting";
  if ((f.openTasks ?? 0) > 0) return "background";
  if (f.triggerKind === "once") return "follow_up";
  if (f.agentStatus === "dormant" || f.agentStatus === "waiting" || f.declaredStatus === "dormant") return "promised";
  return "waiting";
}

function workingReason(f: TriageFacts): TriageReason {
  const s = f.agentStatus ?? "";
  if (ACTIVE_STARTING.has(s)) return "starting";
  if (s === "compacting") return "compacting";
  if (s === "working" || s === "thinking") return "running";
  return f.hasPending ? "sending" : "running";
}

function reasonOf(input: TriageInput, shelf: TriageShelf | null): TriageReason {
  const { placement, facts: f, unread, now } = input;
  if (shelf === "retired") return "retired";
  if (shelf === "snoozed") return "snoozed";
  if (placement.bucket === "questions") return answerReason(f);
  switch (placement.work_state) {
    case "needs_input": return needsInputReason(f, unread, now);
    case "done": return doneReason(f, unread);
    case "dormant": return parkedReason(f);
    case "working": return workingReason(f);
    case "idle": return f.messageCount === 0 ? "new" : "idle";
  }
}

function untilOf(reason: TriageReason, f: TriageFacts): number | null {
  if (reason === "snoozed") return f.snoozedUntil ?? null;
  if (reason === "loop") return f.loopWakeAt ?? null;
  if (reason === "promised") return f.updatedAt + DORMANT_CLAIM_TTL_MS;
  return null;
}

/** One session's triage. Pure: the same facts give the same answer everywhere. */
export function triageOf(input: TriageInput): Triage {
  const shelf = shelfOf(input.facts, input.placement.bucket, input.now);
  const reason = reasonOf(input, shelf);
  const { lane, ask } = TRIAGE_REASONS[reason];
  return {
    lane,
    ask,
    reason,
    shelf,
    surfaced: shelf === "stashed" && (ask === "answer" || ask === "fix"),
    hidden: input.placement.bucket === "hidden",
    until: untilOf(reason, input.facts),
  };
}

// ── Placements a list hands in ──────────────────────────────────────────────

const LANE_BUCKETS = new Set<string>(["needs_input", "done", "dormant", "working"]);

/** A row filed under its lead's bucket rather than its own verdict
 *  (rideLeadPlacements: a role's session, an agent-team teammate). The inbox
 *  nests it under the lead's card, so it is no row of its own in a list. */
export function ridesLead(p: InboxPlacement): boolean {
  return LANE_BUCKETS.has(p.bucket) && p.bucket !== p.work_state;
}

/** The placement a shelved row the inbox did not place stands on: the shelf
 *  decides where it shows, and nothing in it claims the person. */
export function shelfPlacement(shelf: "dismissed" | "stashed" | "snoozed"): InboxPlacement {
  return { bucket: shelf, work_state: shelf === "snoozed" ? "dormant" : "idle" };
}

// ── Sections ────────────────────────────────────────────────────────────────

/** The lists a triaged row can appear in, in reading order. The four lanes are
 *  the inbox; Pinned sits above them; the shelves sit behind it. */
export const TRIAGE_SECTIONS = ["pinned", "you", "agent", "parked", "settled", "snoozed", "stashed", "retired"] as const;
export type TriageSection = (typeof TRIAGE_SECTIONS)[number];

/** The list a row appears in, or null when it appears in none (a hidden
 *  standing session). A surfaced stash shows in Needs you. */
export function triageSectionOf(t: Triage): TriageSection | null {
  if (t.hidden) return null;
  if (t.shelf === "retired" || t.shelf === "snoozed") return t.shelf;
  if (t.shelf === "stashed") return t.surfaced ? "you" : "stashed";
  if (t.shelf === "pinned") return "pinned";
  return t.lane;
}

const ASK_RANK: Record<TriageAsk, number> = { answer: 0, fix: 1, review: 2 };

/** Order inside Needs you: answers before fixes before reviews, so the act
 *  that unblocks an agent fastest is first. 0 for every other lane. */
export function triageAskRank(t: Triage): number {
  return t.ask ? ASK_RANK[t.ask] : 0;
}

/** Rows per section, plus `needs_you`: every visible row whose lane is you,
 *  pinned ones included, split by kind of act. That is the badge number, and
 *  answer + fix + review always add up to it. */
export function triageTally(rows: Iterable<Triage>): Record<TriageSection, number> & Record<TriageAsk, number> & { needs_you: number } {
  const out = { pinned: 0, you: 0, agent: 0, parked: 0, settled: 0, snoozed: 0, stashed: 0, retired: 0, answer: 0, fix: 0, review: 0, needs_you: 0 };
  for (const t of rows) {
    const section = triageSectionOf(t);
    if (!section) continue;
    out[section]++;
    if (t.ask && (section === "you" || section === "pinned")) {
      out[t.ask]++;
      out.needs_you++;
    }
  }
  return out;
}
