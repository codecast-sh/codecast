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

/** One wallet movement (`wallet_ledger.kind`). A `refund` takes a top-up's
 *  credit back after Stripe returned or lost the payment (a refund, a dispute);
 *  a `repay` moves allowance onto a debt such a refund left. */
export const LEDGER_KINDS = ["reserve", "release", "charge", "grant", "topup", "period_reset", "refund", "repay"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** How long one turn may run before it ends with reason `time`. */
export const TURN_DEADLINE_MS = 8 * 60 * 1000;

/** The longest message a person may give a hosted conversation, and the
 *  longest title one may start with. Every turn spends the owner's wallet on
 *  its input, so input is bounded where it is queued. */
export const HOSTED_INPUT_MAX_CHARS = 32_000;
export const HOSTED_TITLE_MAX_CHARS = 200;

/** Why an image sent to a hosted conversation is refused: the turn engine
 *  gives the model text only. The server refuses with it where input is
 *  queued, and the composer says it the moment an image is pasted or dropped. */
export const HOSTED_IMAGE_REFUSAL = "The assistant can't read images yet. Describe what's in it, or paste the text.";

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
  /** The most one turn may reserve from the wallet, in US dollars at cost:
   *  the ceiling a single run of the loop spends up to. */
  turn_ceiling_usd: number;
}

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The shortest interval any routine repeats at, whatever the plan. Every
 *  firing wakes a paid turn with nobody watching, so a plan's own floor can
 *  raise this but nothing goes under it. */
export const ROUTINE_MIN_INTERVAL_MS = HOUR_MS;

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
    turn_ceiling_usd: 0.25,
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
    turn_ceiling_usd: 1,
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
    turn_ceiling_usd: 2,
  },
};

/** What a top-up buys: model usage, in US dollars at cost, per dollar paid
 *  before tax. Below one so a top-up keeps the margin a plan keeps (Plus is
 *  $20 for $12 of usage) and covers Stripe's fee. A starting value pending
 *  the founder's call, like PLANS. */
export const TOPUP = {
  usage_usd_per_usd: 0.6,
  /** The amounts, in whole dollars before tax, a top-up can be bought in:
   *  what the plan screen offers and the only amounts checkout accepts. */
  amounts_usd: [10, 25],
} as const;

/** The usage a top-up of `paidUsd` (before tax) credits. */
export function topupCredit(paidUsd: number): number {
  return Math.round(paidUsd * TOPUP.usage_usd_per_usd * 1e6) / 1e6;
}

/** Where Stripe sends a person back after checkout or the portal, and what
 *  `?<param>=` says happened. The server builds the URLs (convex/billing.ts)
 *  and the plan screen reads them (the web lane's plan path and its return
 *  note), so both sides name the page and the outcomes from here. */
export const BILLING_RETURN = {
  path: "/simple/plan",
  param: "billing",
  outcomes: ["done", "topup", "canceled"],
} as const;
export type BillingReturnOutcome = (typeof BILLING_RETURN.outcomes)[number];

/** The outcome a return URL's `?billing=` names, or null for anything else. */
export function billingReturnOutcome(raw: string | null | undefined): BillingReturnOutcome | null {
  return raw && (BILLING_RETURN.outcomes as readonly string[]).includes(raw) ? (raw as BillingReturnOutcome) : null;
}

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

export const HOSTED_ROUTINE_NO_EVENTS = "A hosted assistant runs routines on a schedule, not on events";

/** The shortest interval a recurring routine may repeat at on this plan: the
 *  plan's own floor, never below ROUTINE_MIN_INTERVAL_MS. Every surface that
 *  enforces or describes a routine's cadence reads it from here. */
export function routineFloor(plan: PlanSpec): number {
  return Math.max(plan.routines.min_interval_ms ?? 0, ROUTINE_MIN_INTERVAL_MS);
}

/** Why `plan` refuses a routine on a hosted conversation, or null when it
 *  fits. `armedOthers` counts the person's other armed hosted routines the
 *  routine competes with: every one when it is being armed, only the older
 *  ones when the dispatcher rechecks a routine already armed (so when a plan
 *  shrinks the oldest keep running). Every plan refuses event routines: an
 *  event's frame carries text written by outsiders (issue and comment titles)
 *  into a message sent as the owner, and nothing bounds how often it fires.
 *  Admitting them needs the turn engine to treat that block as untrusted. */
export function routineRefusal(plan: PlanSpec, routine: RoutineShape, armedOthers: number): string | null {
  if (routine.schedule_type === "event") {
    return HOSTED_ROUTINE_NO_EVENTS;
  }
  const { max, min_interval_ms: planFloor } = plan.routines;
  if (max !== null && armedOthers >= max) {
    return `The ${plan.label} plan runs up to ${max} routines at a time`;
  }
  const floor = routineFloor(plan);
  if (routine.schedule_type === "recurring" && !((routine.interval_ms ?? 0) >= floor)) {
    return planFloor !== null && planFloor >= ROUTINE_MIN_INTERVAL_MS
      ? `The ${plan.label} plan repeats a routine at most once every ${describeInterval(floor)}`
      : `A routine repeats at most once every ${describeInterval(floor)}`;
  }
  return null;
}
