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
  })
    .index("by_conversation_status", ["conversation_id", "status"])
    // Concurrent turns per person (PLANS[plan].concurrent_turns).
    .index("by_user_status", ["user_id", "status"]),

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
    // Bought on top of the plan; spent after the period allowance.
    topup_usd: v.number(),
    stripe_customer_id: v.optional(v.string()),
    stripe_subscription_id: v.optional(v.string()),
    // Stripe's subscription status, verbatim ("active", "past_due", ...).
    subscription_status: v.optional(v.string()),
  })
    .index("by_user", ["user_id"])
    .index("by_stripe_customer", ["stripe_customer_id"]),

  // Every movement of a wallet, append only.
  wallet_ledger: defineTable({
    user_id: v.id("users"),
    kind: ledgerKindValidator,
    amount_usd: v.number(),
    turn_id: v.optional(v.id("assistant_turns")),
    conversation_id: v.optional(v.id("conversations")),
    model: v.optional(v.string()),
    at: v.number(),
  })
    .index("by_user_at", ["user_id", "at"])
    .index("by_turn", ["turn_id"]),
};
