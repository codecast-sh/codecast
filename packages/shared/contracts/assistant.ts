// The hosted assistant's shared vocabulary (plan pl-840, build spec
// docs/architecture/hosted-assistant.md). Pure isomorphic data: the Convex
// turn engine, the wallet, the web simple lane and the phone all read the same
// names, and every plan number lives in the one PLANS catalog below so a
// pricing change is one edit here.

/** `conversations.agent_type` of a hosted conversation: a Convex action runs
 *  its turns, and no device ever claims it. The registry entry is
 *  AGENT_CLIENTS.codecast (agentClients.ts). */
export const HOSTED_AGENT_TYPE = "codecast" as const;

/** One run of the loop (`assistant_turns.status`). `queued` waits for the
 *  running turn to pick its input up; `waiting` is parked on an approval. */
export const TURN_STATUSES = ["queued", "running", "waiting", "done", "failed"] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

/** Why a turn stopped (`assistant_turns.reason`). */
export const TURN_REASONS = ["done", "approval", "budget", "time", "error"] as const;
export type TurnReason = (typeof TURN_REASONS)[number];

/** What woke a conversation (`assistant/entry.ts: wake`). `continue` is the
 *  engine waking itself because input arrived while a turn ran. */
export const WAKE_CAUSES = ["message", "routine", "approval", "continue"] as const;
export type WakeCause = (typeof WAKE_CAUSES)[number];

/** A tool's risk level. Reads always run; writes pass the gate. */
export const TOOL_RISKS = ["read", "write"] as const;
export type ToolRisk = (typeof TOOL_RISKS)[number];

/** What the person has allowed for a write tool (`assistant_rules.decision`).
 *  With no rule the gate asks. */
export const RULE_DECISIONS = ["allow", "ask", "refuse"] as const;
export type RuleDecision = (typeof RULE_DECISIONS)[number];
export const DEFAULT_RULE_DECISION: RuleDecision = "ask";

/** One wallet movement (`wallet_ledger.kind`). */
export const LEDGER_KINDS = ["reserve", "release", "charge", "grant", "topup", "period_reset"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** How long one turn may run before it ends with reason `time`. */
export const TURN_DEADLINE_MS = 8 * 60 * 1000;

export const PLAN_IDS = ["free", "plus", "pro"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanSpec {
  id: PlanId;
  label: string;
  /** Monthly price in US dollars. */
  price_usd: number;
  /** Model usage the price includes each period, in US dollars at cost. */
  included_usd: number;
  /** The model a turn runs on unless the work calls for the strong one. */
  default_model: string;
  /** The model for hard work; the default model itself on plans without one. */
  strong_model: string;
  routines: {
    /** How many routines may be armed at once; null is unlimited. */
    max: number | null;
    /** The shortest interval a routine may repeat at; null is no floor. */
    min_interval_ms: number | null;
  };
  /** How many turns of one person may run at the same time. */
  concurrent_turns: number;
}

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Starting values pending the founder's call (spec "Plans"). Nothing else in
 *  the code may hardcode a price, an allowance or a limit. */
export const PLANS: Record<PlanId, PlanSpec> = {
  free: {
    id: "free",
    label: "Free",
    price_usd: 0,
    included_usd: 2,
    default_model: HAIKU,
    strong_model: HAIKU,
    routines: { max: 3, min_interval_ms: DAY_MS },
    concurrent_turns: 1,
  },
  plus: {
    id: "plus",
    label: "Plus",
    price_usd: 20,
    included_usd: 12,
    default_model: SONNET,
    strong_model: SONNET,
    routines: { max: 25, min_interval_ms: null },
    concurrent_turns: 2,
  },
  pro: {
    id: "pro",
    label: "Pro",
    price_usd: 60,
    included_usd: 40,
    default_model: SONNET,
    strong_model: OPUS,
    routines: { max: null, min_interval_ms: null },
    concurrent_turns: 3,
  },
};

/** The plan for a stored id; anything unknown or absent is the free plan. */
export function planOf(id: string | null | undefined): PlanSpec {
  return id && (PLAN_IDS as readonly string[]).includes(id) ? PLANS[id as PlanId] : PLANS.free;
}

/** The routine fields a plan limits. */
export interface RoutineShape {
  schedule_type: string;
  interval_ms?: number;
}

function describeInterval(ms: number): string {
  const days = ms / DAY_MS;
  if (Number.isInteger(days)) return days === 1 ? "day" : `${days} days`;
  const hours = Math.round(ms / (60 * 60 * 1000));
  return hours <= 1 ? "hour" : `${hours} hours`;
}

/** Why `plan` refuses a routine on a hosted conversation, or null when it
 *  fits. `armedBefore` counts the person's other armed hosted routines that
 *  were created before this one, so when a plan shrinks the oldest routines
 *  keep running. A plan with an interval floor runs routines on a schedule
 *  only, because an event trigger has no bound on how often it fires. */
export function routineRefusal(plan: PlanSpec, routine: RoutineShape, armedBefore: number): string | null {
  const { max, min_interval_ms: floor } = plan.routines;
  if (max !== null && armedBefore >= max) {
    return `The ${plan.label} plan runs up to ${max} routines at a time`;
  }
  if (floor !== null) {
    if (routine.schedule_type === "event") {
      return `The ${plan.label} plan runs routines on a schedule, not on events`;
    }
    if (routine.schedule_type === "recurring" && (routine.interval_ms ?? 0) < floor) {
      return `The ${plan.label} plan repeats a routine at most once every ${describeInterval(floor)}`;
    }
  }
  return null;
}
