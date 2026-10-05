// The hosted assistant's wallet as functions (plan pl-840,
// docs/architecture/hosted-assistant.md). The rules live in lib/wallet.ts;
// the turn engine calls those helpers inside its own lease and finish
// mutations, so a reservation shares a transaction with the turn it pays for.
// These wrappers are for everything else: billing (setPlan, topup), credit
// given by hand (grant, from the Convex dashboard or `run.sh`), a release
// from an action, and the plan screen's query.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { internalMutation, query } from "./functions";
import { planIdValidator } from "./assistantSchema";
import {
  credit,
  ensureWallet,
  reconcileWallet,
  releaseTurn,
  reserve as reserveTurn,
  setPlan as setWalletPlan,
  settleTurn,
  walletSummary,
  type WalletSummary,
} from "./lib/wallet";

/** The signed-in person's plan screen: plan, cap, usage, holds, what is left,
 *  the period's end, the top-up balance, and recent cost per conversation.
 *  Null when signed out. Feeds the web store key `wallet`. */
export const mine = query({
  args: {},
  handler: async (ctx): Promise<WalletSummary | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return walletSummary(ctx, userId);
  },
});

/** Makes the person's wallet if they have none and rolls it into the current period. */
export const ensure = internalMutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    const wallet = await ensureWallet(ctx, args.user_id);
    return wallet._id;
  },
});

/** Reserves more for a turn already running (a ceiling raised mid-run).
 *  The first reservation belongs in the lease mutation, through lib/wallet's
 *  `reserve`, so the turn and its money are taken together. */
export const reserve = internalMutation({
  args: { user_id: v.id("users"), turn_id: v.id("assistant_turns"), amount_usd: v.number() },
  handler: async (ctx, args): Promise<boolean> => reserveTurn(ctx, args.user_id, args.turn_id, args.amount_usd),
});

/** The true-up at a turn's end; idempotent per turn. The turn engine settles
 *  inside its finish mutation through lib/wallet's `settleTurn`; this wrapper
 *  is for repair by hand. Ending a turn and settling it apart leaves the hold
 *  to the leak scan once LEAK_GRACE_MS has passed. */
export const settle = internalMutation({
  args: { turn_id: v.id("assistant_turns"), cost_usd: v.number(), model: v.optional(v.string()) },
  handler: async (ctx, args) => settleTurn(ctx, args.turn_id, args.cost_usd, args.model),
});

/** Gives back what a turn holds without charging it; idempotent. */
export const release = internalMutation({
  args: { turn_id: v.id("assistant_turns") },
  handler: async (ctx, args): Promise<number> => releaseTurn(ctx, args.turn_id),
});

/** Credit given by hand or by a promotion; spent after the plan allowance. */
export const grant = internalMutation({
  args: { user_id: v.id("users"), amount_usd: v.number(), external_id: v.optional(v.string()) },
  handler: async (ctx, args): Promise<boolean> => credit(ctx, args.user_id, "grant", args.amount_usd, args.external_id),
});

/** A purchased top-up; `external_id` (the Stripe payment) makes a redelivery land once. */
export const topup = internalMutation({
  args: { user_id: v.id("users"), amount_usd: v.number(), external_id: v.string() },
  handler: async (ctx, args): Promise<boolean> => credit(ctx, args.user_id, "topup", args.amount_usd, args.external_id),
});

/** Moves a person to a plan; billing passes the Stripe facts with it. */
export const setPlan = internalMutation({
  args: {
    user_id: v.id("users"),
    plan: planIdValidator,
    stripe_customer_id: v.optional(v.string()),
    stripe_subscription_id: v.optional(v.string()),
    subscription_status: v.optional(v.string()),
  },
  handler: async (ctx, { user_id, plan, ...subscription }) => {
    const wallet = await setWalletPlan(ctx, user_id, plan, subscription);
    return wallet._id;
  },
});

/** The hourly leak sweep (crons.ts): pages every wallet and schedules
 *  reconcileOne for each that holds anything, so each person's heavier
 *  reconcile runs in its own transaction. The lease only frees leaked holds
 *  it can see cheaply; this catches the rest, holds whose turn row was
 *  deleted included. Safe to rerun. */
export const reconcile = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ scanned: number; scheduled: number; done: boolean }> => {
    const page = await ctx.db.query("wallets").paginate({ cursor: args.cursor ?? null, numItems: 200 });
    const holding = page.page.filter((wallet) => wallet.period_reserved_usd > 0);
    for (const wallet of holding) await ctx.scheduler.runAfter(0, internal.wallet.reconcileOne, { user_id: wallet.user_id });
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.wallet.reconcile, { cursor: page.continueCursor });
    return { scanned: page.page.length, scheduled: holding.length, done: page.isDone };
  },
});

/** Gives back one person's leaked holds (lib/wallet's reconcileWallet). */
export const reconcileOne = internalMutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args): Promise<number> => {
    const released = await reconcileWallet(ctx, args.user_id);
    if (released > 0) console.log("wallet_reconcile", { user_id: args.user_id, released });
    return released;
  },
});
