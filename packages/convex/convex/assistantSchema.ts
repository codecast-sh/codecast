// The hosted assistant's tables (plan pl-840, docs/architecture/hosted-assistant.md
// "Data model"). Spliced into schema.ts as `...assistantTables` (the
// capabilitiesSchema.ts pattern). The value lists live in the shared contract
// (contracts/assistant), so the engine, the wallet and the clients spell every
// status, reason and plan the same way.
import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  LEDGER_KINDS,
  PLAN_IDS,
  RULE_DECISIONS,
  TURN_REASONS,
  TURN_STATUSES,
  WAKE_CAUSES,
} from "@codecast/shared/contracts/assistant";
import type { RuleDecision, ToolRisk, TurnReason } from "@codecast/shared/contracts/assistant";
import type { GateVerdict, StopReason, ToolRisk as HarnessToolRisk } from "@platform/agent";

// The contract's lists restate unions the harness (@platform/agent) defines,
// so clients can read them without depending on the harness. This fails to
// compile when either side gains or loses a value.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const harnessVocabularyMatches: [Same<TurnReason, StopReason>, Same<ToolRisk, HarnessToolRisk>, Same<RuleDecision, GateVerdict>] = [
  true,
  true,
  true,
];
void harnessVocabularyMatches;

export const turnStatusValidator = v.union(...TURN_STATUSES.map((s) => v.literal(s)));
export const turnReasonValidator = v.union(...TURN_REASONS.map((r) => v.literal(r)));
export const wakeCauseValidator = v.union(...WAKE_CAUSES.map((c) => v.literal(c)));
export const ruleDecisionValidator = v.union(...RULE_DECISIONS.map((d) => v.literal(d)));
export const ledgerKindValidator = v.union(...LEDGER_KINDS.map((k) => v.literal(k)));
export const planIdValidator = v.union(...PLAN_IDS.map((p) => v.literal(p)));

/** The tool call a turn stopped on to ask the person (gate `ask`). The
 *  answer wakes a new turn that executes or declines exactly this call. */
export const pendingCallValidator = v.object({
  tool_call_id: v.string(),
  tool: v.string(),
  // The model's arguments as it sent them; the approval card shows the draft
  // or event built from these.
  args: v.any(),
  // The blocking decision the person answers (sessionDecisions.askCore).
  decision_id: v.optional(v.id("session_decisions")),
});

export const assistantTables = {
  // One row per run of the loop. Only one turn per conversation is ever
  // `running` (the lease); input that arrives meanwhile stays queued as
  // pending messages and the running turn picks it up before it stops.
  assistant_turns: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    status: turnStatusValidator,
    // Why it stopped. Absent while queued or running.
    reason: v.optional(turnReasonValidator),
    model: v.optional(v.string()),
    // The ceiling reserved from the wallet when the lease was taken.
    cost_reserved_usd: v.number(),
    // What the turn actually cost, charged at the finish.
    cost_usd: v.optional(v.number()),
    input_tokens: v.optional(v.number()),
    output_tokens: v.optional(v.number()),
    started_at: v.optional(v.number()),
    ended_at: v.optional(v.number()),
    error: v.optional(v.string()),
    // The turn this one resumes (after an approval was answered).
    continues: v.optional(v.id("assistant_turns")),
    pending_call: v.optional(pendingCallValidator),
    // Write calls this turn started (the harness's onToolStart), recorded
    // before each one runs. A later turn hands them to the run as
    // startedCalls, so a call whose run died before its result was stored is
    // never done twice.
    started_calls: v.optional(v.array(v.string())),
    // True while the turn holds a wallet reservation (lib/wallet.ts). The
    // amount lives in the ledger; this flag only lets the leak scan find every
    // holding turn however old it is.
    holding: v.optional(v.boolean()),
  })
    .index("by_conversation_status", ["conversation_id", "status"])
    // Concurrent turns per person (PLANS[plan].concurrent_turns).
    .index("by_user_status", ["user_id", "status"])
    .index("by_user_holding", ["user_id", "holding"]),

  // What the person has allowed a write tool to do. The gate reads these;
  // "Always allow" on an approval writes one. No row means `ask`.
  assistant_rules: defineTable({
    user_id: v.id("users"),
    tool: v.string(),
    decision: ruleDecisionValidator,
    // Narrows the rule to one target (a recipient, a calendar). Absent means
    // every call of the tool.
    match: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_user_tool", ["user_id", "tool"]),

  // One wallet per person: the plan, this period's allowance and what is spent
  // or held against it. A turn reserves its ceiling in the same mutation that
  // checks the cap, so concurrent turns can never overspend.
  wallets: defineTable({
    user_id: v.id("users"),
    plan: planIdValidator,
    period_start: v.number(),
    period_end: v.number(),
    period_cap_usd: v.number(),
    period_cost_usd: v.number(),
    period_reserved_usd: v.number(),
    // Bought on top of the plan; spent after the period allowance. Below zero
    // after a refund or dispute of credit already spent (lib/wallet.ts refundTopup).
    topup_usd: v.number(),
    stripe_customer_id: v.optional(v.string()),
    stripe_subscription_id: v.optional(v.string()),
    // Stripe's subscription status, verbatim ("active", "past_due", ...).
    subscription_status: v.optional(v.string()),
    // The moment every period boundary counts from once a paid subscription
    // set one (the start of Stripe's billing cycle); the wallet's creation
    // before that. Written only by lib/wallet's alignPeriod.
    period_anchor: v.optional(v.number()),
    // The end of the last period Stripe confirmed paid, while a live
    // subscription bills this wallet; absent otherwise. A period ending later
    // grants the free allowance until its payment lands (lib/wallet
    // allowancePlan), so a renewal that is never paid grants nothing.
    paid_through: v.optional(v.number()),
    // When billing last read this wallet's subscription from Stripe. A read
    // older than this one is a stale snapshot and is not applied (billing.ts).
    subscription_read_at: v.optional(v.number()),
  })
    .index("by_user", ["user_id"])
    .index("by_stripe_customer", ["stripe_customer_id"]),

  // A provider that could not serve the assistant (an empty account, a bad
  // key, an outage), one open row per provider while it lasts. The first
  // failure opens it and alerts the operator once (assistant/incidents.ts);
  // the next turn the provider serves closes it.
  assistant_incidents: defineTable({
    provider: v.string(),
    fault: v.string(),
    model: v.string(),
    error: v.string(),
    first_at: v.number(),
    last_at: v.number(),
    count: v.number(),
    closed_at: v.optional(v.number()),
  }).index("by_provider_closed", ["provider", "closed_at"]),

  // Every movement of a wallet, append only.
  wallet_ledger: defineTable({
    user_id: v.id("users"),
    kind: ledgerKindValidator,
    amount_usd: v.number(),
    turn_id: v.optional(v.id("assistant_turns")),
    conversation_id: v.optional(v.id("conversations")),
    model: v.optional(v.string()),
    // The outside event a credit came from (a Stripe event or payment intent
    // id). Billing reads by_external_id before writing a topup or grant, so a
    // webhook delivered twice credits once.
    external_id: v.optional(v.string()),
    at: v.number(),
  })
    .index("by_user_at", ["user_id", "at"])
    .index("by_turn", ["turn_id"])
    .index("by_external_id", ["external_id"]),
};
