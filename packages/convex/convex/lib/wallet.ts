// The hosted assistant's wallet (plan pl-840, docs/architecture/hosted-assistant.md
// "The turn" steps 3 and 6). Ported in spirit from Averil's reservation
// (eaiden gauntlet/reservation.ts): reading the cap and charging it after a
// run are two moments, and every run in flight passed the same cap, so four
// runs against a nearly full wallet all went through and overspent. Here a
// turn takes its ceiling out of the wallet in the same mutation that tests
// the room (a Convex mutation is a transaction, so the check and the write
// cannot race), and gives back the difference when it ends.
//
// The ledger is the one home of what a turn still holds: its reserve rows
// minus its release rows (by_turn). So a release or a settle called twice
// moves no money the second time, whichever path calls it (the finish, a
// failure, a crash recovery).
//
// Money is US dollars at cost, rounded to a millionth so sums of tenths
// compare the way a person reads them.
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { planOf, type PlanId, type PlanSpec } from "@codecast/shared/contracts/assistant";

const EPSILON = 1e-9;

/** Dollars rounded to a millionth. */
export function money(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

/** `at` moved by whole calendar months in UTC, the day clamped to the
 *  month's last (Jan 31 + 1 month is Feb 28 or 29). */
export function addMonths(at: number, months: number): number {
  const d = new Date(at);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/** The monthly period holding `now`, counted from `anchor` (the wallet's
 *  creation). Each boundary is computed from the anchor, never from the
 *  previous boundary, so a wallet made on the 31st does not drift to the 28th. */
export function periodAt(anchor: number, now: number): { start: number; end: number } {
  const a = new Date(anchor);
  const n = new Date(now);
  let months = (n.getUTCFullYear() - a.getUTCFullYear()) * 12 + (n.getUTCMonth() - a.getUTCMonth());
  if (months < 0) months = 0;
  while (months > 0 && addMonths(anchor, months) > now) months--;
  while (addMonths(anchor, months + 1) <= now) months++;
  return { start: addMonths(anchor, months), end: addMonths(anchor, months + 1) };
}

type PeriodFigures = Pick<Doc<"wallets">, "period_start" | "period_end" | "period_cost_usd" | "period_cap_usd" | "topup_usd">;

/** What decides a period's allowance: the plan, Stripe's status, and the end
 *  of the last period Stripe confirmed paid (absent when no live
 *  subscription bills the wallet). */
export type AllowanceFacts = {
  plan?: PlanId;
  subscription_status?: string | null;
  paid_through?: number | null;
};

/** The plan whose allowance a period ending at `periodEnd` grants. A paid
 *  plan keeps its name but grants the free allowance while its renewal is
 *  failing (Stripe's `past_due`), and for a period ending after
 *  `paid_through`: a period opens at its boundary before Stripe has charged
 *  for it, so it starts on the free allowance, and a renewal that is never
 *  paid (a lapsed card, events that stopped arriving) never grants the paid
 *  one. The paid allowance comes when the payment lands: billing moves the
 *  status on (`moveSubscription`) or confirms the period (`alignPeriod`). */
export function allowancePlan(facts: AllowanceFacts, periodEnd: number): PlanId | undefined {
  if (facts.subscription_status === "past_due") return "free";
  if (facts.paid_through != null && periodEnd > facts.paid_through) return "free";
  return facts.plan;
}

/** The allowance in dollars that `allowancePlan` grants. */
function allowanceUsd(facts: AllowanceFacts, periodEnd: number): number {
  return planOf(allowancePlan(facts, periodEnd)).included_usd;
}

/** A debt (a top-up balance below zero, left by a refund or dispute of
 *  credit already spent) paid from the allowance still left: the payment
 *  counts as usage and raises the balance by the same amount, so a debt is
 *  paid once and then gone. `repaid` is the amount moved. */
export function repayDebt(
  figures: Pick<Doc<"wallets">, "period_cap_usd" | "period_cost_usd" | "topup_usd">,
): { period_cost_usd: number; topup_usd: number; repaid: number } {
  const repaid = money(Math.min(Math.max(0, -figures.topup_usd), allowanceLeft(figures)));
  return { period_cost_usd: money(figures.period_cost_usd + repaid), topup_usd: money(figures.topup_usd + repaid), repaid };
}

/** The figures of a fresh period from `start` to `end`: usage resets, the
 *  cap follows the plan (`allowancePlan`), and the new allowance pays any
 *  debt first (`repayDebt`). Reservations of turns still in flight and the
 *  top-up balance carry over. The one rule for opening a period, whether the
 *  wallet rolled over or billing put it on Stripe's. */
function freshPeriod(facts: AllowanceFacts, start: number, end: number, topupUsd: number): PeriodFigures {
  const fresh = { period_cap_usd: allowanceUsd(facts, end), period_cost_usd: 0, topup_usd: topupUsd };
  const { period_cost_usd, topup_usd } = repayDebt(fresh);
  return { period_start: start, period_end: end, period_cap_usd: fresh.period_cap_usd, period_cost_usd, topup_usd };
}

/** The figures of the period holding `now` once the period ending at
 *  `periodEnd` is over, or null while it runs. The one rollover rule, for
 *  the stored wallet (`rolledOver`) and for a summary a client already holds
 *  (`summaryAt`). */
function nextPeriod(anchor: number, facts: AllowanceFacts, periodEnd: number, topupUsd: number, now: number): PeriodFigures | null {
  if (now < periodEnd) return null;
  const { start, end } = periodAt(anchor, now);
  return freshPeriod(facts, start, end, topupUsd);
}

/** The patch that moves a wallet into the period holding `now`, or null when
 *  it is already there. */
export function rolledOver(wallet: Doc<"wallets">, now: number): PeriodFigures | null {
  return nextPeriod(periodAnchor(wallet), wallet, wallet.period_end, wallet.topup_usd, now);
}

/** The moment a wallet's periods count from: the start of the paid billing
 *  cycle once `alignPeriod` set one, the wallet's creation before that. */
export function periodAnchor(wallet: Pick<Doc<"wallets">, "_creationTime" | "period_anchor">): number {
  return wallet.period_anchor ?? wallet._creationTime;
}

/** What is left of the period allowance, ignoring reservations. */
function allowanceLeft(wallet: Pick<Doc<"wallets">, "period_cap_usd" | "period_cost_usd">): number {
  return Math.max(0, wallet.period_cap_usd - wallet.period_cost_usd);
}

/** What a new reservation may still take: the allowance left, then the
 *  top-up balance, less what turns in flight already hold. */
export function walletRoom(wallet: Pick<Doc<"wallets">, "period_cap_usd" | "period_cost_usd" | "period_reserved_usd" | "topup_usd">): number {
  return money(Math.max(0, allowanceLeft(wallet) + wallet.topup_usd - wallet.period_reserved_usd));
}

/** How a charge splits: the period allowance first, then the top-up balance.
 *  Whatever neither covers (a turn that ran past its ceiling) still lands on
 *  the period's usage, so the meter shows the overrun honestly. */
export function splitCharge(
  wallet: Pick<Doc<"wallets">, "period_cap_usd" | "period_cost_usd" | "topup_usd">,
  amount: number,
): { periodUsd: number; topupUsd: number } {
  const fromAllowance = Math.min(amount, allowanceLeft(wallet));
  const topupUsd = Math.min(amount - fromAllowance, Math.max(0, wallet.topup_usd));
  return { periodUsd: money(amount - topupUsd), topupUsd: money(topupUsd) };
}

/** The person's stored wallet row, as written (no rollover), or null. */
export function walletRow(ctx: Pick<QueryCtx, "db">, userId: Id<"users">): Promise<Doc<"wallets"> | null> {
  return ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("user_id", userId)).first();
}

/** The wallet holding a Stripe customer, as written, or null. */
export function walletByCustomer(ctx: Pick<QueryCtx, "db">, customer: string): Promise<Doc<"wallets"> | null> {
  return ctx.db.query("wallets").withIndex("by_stripe_customer", (q) => q.eq("stripe_customer_id", customer)).first();
}

/** The plan a person is on; no wallet is the free plan. Readable from a query. */
export async function walletPlan(ctx: Pick<QueryCtx, "db">, userId: Id<"users">): Promise<PlanSpec> {
  return planOf((await walletRow(ctx, userId))?.plan);
}

async function ledger(ctx: MutationCtx, row: Omit<Doc<"wallet_ledger">, "_id" | "_creationTime" | "at"> & { at?: number }): Promise<void> {
  await ctx.db.insert("wallet_ledger", { ...row, amount_usd: money(row.amount_usd), at: row.at ?? Date.now() });
}

/** The person's wallet, made on first use (free plan, a monthly period from
 *  its creation) and rolled into the current period if the last one ended.
 *  Every wallet movement starts here, so usage never carries across a period.
 *  A new wallet's first period counts from its `_creationTime`, the anchor
 *  every later rollover counts from (`periodAnchor`), never from `now`, so the
 *  second period starts where the first ended even when a caller passes a
 *  `now` that is not the real time. */
export async function ensureWallet(ctx: MutationCtx, userId: Id<"users">, now = Date.now()): Promise<Doc<"wallets">> {
  const wallet = await walletRow(ctx, userId);
  if (!wallet) {
    const free = planOf("free");
    const id = await ctx.db.insert("wallets", {
      user_id: userId,
      plan: free.id,
      period_start: now,
      period_end: addMonths(now, 1),
      period_cap_usd: free.included_usd,
      period_cost_usd: 0,
      period_reserved_usd: 0,
      topup_usd: 0,
    });
    const made = (await ctx.db.get(id))!;
    const first = periodAt(made._creationTime, made._creationTime);
    await ctx.db.patch(id, { period_start: first.start, period_end: first.end });
    return { ...made, period_start: first.start, period_end: first.end };
  }
  const patch = rolledOver(wallet, now);
  return patch ? openPeriod(ctx, wallet, patch, now) : wallet;
}

/** Writes a fresh period onto the wallet, with the `period_reset` row that
 *  records the usage it forgave and a `repay` row for any debt the new
 *  allowance paid, so the ledger explains the meter's drop. */
async function openPeriod(ctx: MutationCtx, wallet: Doc<"wallets">, patch: Partial<Doc<"wallets">> & PeriodFigures, now: number): Promise<Doc<"wallets">> {
  await ctx.db.patch(wallet._id, patch);
  await ledger(ctx, { user_id: wallet.user_id, kind: "period_reset", amount_usd: wallet.period_cost_usd, at: now });
  const repaid = money(patch.topup_usd - wallet.topup_usd);
  if (repaid > 0) await ledger(ctx, { user_id: wallet.user_id, kind: "repay", amount_usd: repaid, at: now });
  return { ...wallet, ...patch };
}

async function turnOf(ctx: MutationCtx, turnId: Id<"assistant_turns">): Promise<Doc<"assistant_turns">> {
  const turn = await ctx.db.get(turnId);
  if (!turn) throw new Error(`wallet: no turn ${turnId}`);
  return turn;
}

/** What a turn still holds (its reservations less its releases) and its
 *  first reserve row, which names the owner even if the turn row is gone. */
async function holdOf(ctx: QueryCtx, turnId: Id<"assistant_turns">): Promise<{ held: number; reserved: Doc<"wallet_ledger"> | null }> {
  const rows = await ctx.db.query("wallet_ledger").withIndex("by_turn", (q) => q.eq("turn_id", turnId)).collect();
  let held = 0;
  let reserved: Doc<"wallet_ledger"> | null = null;
  for (const row of rows) {
    if (row.kind === "reserve") {
      held += row.amount_usd;
      reserved ??= row;
    } else if (row.kind === "release") held -= row.amount_usd;
  }
  return { held: money(Math.max(0, held)), reserved };
}

/** Gives back whatever a turn still holds and returns how much. Idempotent:
 *  a turn that already released holds nothing, so a second call moves no
 *  money. Every way out of a reserved turn calls it. Reads the owner from
 *  the ledger, so a hold whose turn row was deleted is still returned. */
export async function releaseTurn(ctx: MutationCtx, turnId: Id<"assistant_turns">): Promise<number> {
  const { held, reserved } = await holdOf(ctx, turnId);
  if (held <= EPSILON || !reserved) return 0;
  const wallet = await ensureWallet(ctx, reserved.user_id);
  await ctx.db.patch(wallet._id, { period_reserved_usd: money(Math.max(0, wallet.period_reserved_usd - held)) });
  if (await ctx.db.get(turnId)) await ctx.db.patch(turnId, { holding: undefined });
  await ledger(ctx, { user_id: reserved.user_id, kind: "release", amount_usd: held, turn_id: turnId, conversation_id: reserved.conversation_id, model: reserved.model });
  return held;
}

/** Turns whose run may still spend. A `waiting` turn is not one: it ended for
 *  an approval and the answer wakes a new turn, so what it still holds is a
 *  hold its finish failed to give back. */
const LIVE_TURN = new Set<Doc<"assistant_turns">["status"]>(["queued", "running"]);
/** The newest ledger rows reconcileWallet also reads, for holds whose turn
 *  row was deleted (and so carries no `holding` flag to find it by). */
const LEAK_SCAN_ROWS = 1000;
/** Turns flagged `holding` the scan reads: the live ones plus any leaked. */
const LEAK_SCAN_TURNS = 500;
/** How long an ended turn's hold is left for its settle before it counts as
 *  leaked. The finish settles in the mutation that ends the turn, so a hold
 *  this young belongs to a settle still on its way, and freeing it would let
 *  another turn reserve room the coming charge is about to spend. */
export const LEAK_GRACE_MS = 10 * 60_000;

/** True when a turn's hold can be taken back: the turn ended (not queued or
 *  running) more than LEAK_GRACE_MS ago. */
function holdLeaked(turn: Doc<"assistant_turns">, now: number): boolean {
  if (LIVE_TURN.has(turn.status)) return false;
  return now - (turn.ended_at ?? turn.started_at ?? turn._creationTime) >= LEAK_GRACE_MS;
}

/** The turns flagged `holding` whose hold has leaked. Reads only
 *  by_user_holding, so it is cheap enough for the lease mutation. */
async function leakedHolding(ctx: MutationCtx, userId: Id<"users">, now: number): Promise<Id<"assistant_turns">[]> {
  const holding = await ctx.db.query("assistant_turns").withIndex("by_user_holding", (q) => q.eq("user_id", userId).eq("holding", true)).take(LEAK_SCAN_TURNS);
  return holding.filter((turn) => holdLeaked(turn, now)).map((turn) => turn._id);
}

async function releaseAll(ctx: MutationCtx, turns: Iterable<Id<"assistant_turns">>): Promise<number> {
  let released = 0;
  for (const turnId of turns) released += await releaseTurn(ctx, turnId);
  return money(released);
}

/** Releases what this person's ended turns still hold, for a reservation
 *  that does not fit: a turn whose finish ended it without settling. A turn
 *  still `queued` or `running` is never touched, so a turn whose run action
 *  died keeps its hold until the turn engine's lease expiry ends it, and that
 *  sweep settles or releases it in the same mutation. It releases every leak
 *  it finds even when they cannot cover this request, so the caller's next,
 *  smaller ask (the lease's fall back to whatever room is left) sees them.
 *  It reads only holding turns, and each leak is released once and then
 *  carries no flag, so a lease near the end of an allowance stays a few
 *  reads. Holds whose turn row was deleted carry no flag to find them by;
 *  reconcileWallet catches those on its hourly pass. */
async function releaseLeaks(ctx: MutationCtx, userId: Id<"users">, now = Date.now()): Promise<number> {
  return releaseAll(ctx, await leakedHolding(ctx, userId, now));
}

/** Averil's reconcile: gives back every leaked hold of one person, including
 *  a hold whose turn row was deleted (found among the reserve rows in the
 *  newest LEAK_SCAN_ROWS ledger rows; a turn row that still exists is found
 *  by its `holding` flag, so the ledger pass adds only missing ones).
 *  Heavier than the lease's pass, so it runs from the scheduled sweep
 *  (wallet.reconcile), never on a turn start.
 *  Idempotent: a released turn holds nothing. Returns what it gave back. */
export async function reconcileWallet(ctx: MutationCtx, userId: Id<"users">, now = Date.now()): Promise<number> {
  const candidates = new Set(await leakedHolding(ctx, userId, now));
  const rows = await ctx.db.query("wallet_ledger").withIndex("by_user_at", (q) => q.eq("user_id", userId)).order("desc").take(LEAK_SCAN_ROWS);
  for (const row of rows) {
    if (row.kind !== "reserve" || !row.turn_id || candidates.has(row.turn_id)) continue;
    if (!(await ctx.db.get(row.turn_id))) candidates.add(row.turn_id);
  }
  return releaseAll(ctx, candidates);
}

/** A turn's charge row, the mark that it was settled. */
function chargeOf(ctx: QueryCtx, turnId: Id<"assistant_turns">): Promise<Doc<"wallet_ledger"> | null> {
  return ctx.db.query("wallet_ledger").withIndex("by_turn", (q) => q.eq("turn_id", turnId)).filter((q) => q.eq(q.field("kind"), "charge")).first();
}

/** Reserves `amountUsd` for a turn if the wallet has room for all of it, in
 *  this mutation, and returns false when it does not (the turn then ends
 *  with reason `budget`). The turn's `cost_reserved_usd` grows by the amount,
 *  so a turn may reserve more than once (a ceiling raised mid-run). A turn
 *  that can no longer spend (ended, or already settled) is refused, so a
 *  ceiling raise landing after the finish leaves no hold behind. */
export async function reserve(ctx: MutationCtx, userId: Id<"users">, turnId: Id<"assistant_turns">, amountUsd: number): Promise<boolean> {
  const amount = money(amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`wallet: cannot reserve ${amountUsd}`);
  const turn = await turnOf(ctx, turnId);
  if (turn.user_id !== userId) throw new Error(`wallet: turn ${turnId} is not this person's`);
  if (!LIVE_TURN.has(turn.status) || (await chargeOf(ctx, turnId))) return false;
  let wallet = await ensureWallet(ctx, userId);
  if (walletRoom(wallet) + EPSILON < amount) {
    if ((await releaseLeaks(ctx, userId)) <= 0) return false;
    wallet = (await ctx.db.get(wallet._id))!;
    if (walletRoom(wallet) + EPSILON < amount) return false;
  }
  await ctx.db.patch(wallet._id, { period_reserved_usd: money(wallet.period_reserved_usd + amount) });
  await ctx.db.patch(turnId, { cost_reserved_usd: money(turn.cost_reserved_usd + amount), holding: true });
  await ledger(ctx, { user_id: userId, kind: "reserve", amount_usd: amount, turn_id: turnId, conversation_id: turn.conversation_id, model: turn.model });
  return true;
}

export interface TurnSettlement {
  /** What the turn was charged (its true cost, or the earlier charge on a repeat). */
  chargedUsd: number;
  /** What this call gave back of the reservation. */
  releasedUsd: number;
  /** The part of the charge the top-up balance paid. */
  topupUsd: number;
  /** True when the turn had already been settled and nothing moved. */
  repeat: boolean;
}

/** The true-up at a turn's end: release what it holds, charge what it cost
 *  (the period allowance first, then the top-up balance), and record the cost
 *  on the turn. Call it in the same mutation that moves the turn out of
 *  `running`, so no other reservation sees the turn ended but unsettled.
 *  Idempotent per turn: a second call finds the turn's charge row and charges
 *  nothing, though it still gives back any hold the turn holds. A cost that
 *  is not a finite number (pricing that could not read the usage) charges
 *  what the turn held, so a pricing gap never makes a turn free. */
export async function settleTurn(
  ctx: MutationCtx,
  turnId: Id<"assistant_turns">,
  costUsd: number,
  model?: string,
): Promise<TurnSettlement> {
  const charged = await chargeOf(ctx, turnId);
  if (charged) return { chargedUsd: charged.amount_usd, releasedUsd: await releaseTurn(ctx, turnId), topupUsd: 0, repeat: true };

  const releasedUsd = await releaseTurn(ctx, turnId);
  const turn = await turnOf(ctx, turnId);
  const cost = money(Number.isFinite(costUsd) ? Math.max(0, costUsd) : releasedUsd);
  const wallet = await ensureWallet(ctx, turn.user_id);
  const split = splitCharge(wallet, cost);
  await ctx.db.patch(wallet._id, {
    period_cost_usd: money(wallet.period_cost_usd + split.periodUsd),
    topup_usd: money(wallet.topup_usd - split.topupUsd),
  });
  await ctx.db.patch(turnId, { cost_usd: cost });
  // Written even at zero cost: the row is what makes the settle idempotent.
  await ledger(ctx, { user_id: turn.user_id, kind: "charge", amount_usd: cost, turn_id: turnId, conversation_id: turn.conversation_id, model: model ?? turn.model });
  return { chargedUsd: cost, releasedUsd, topupUsd: split.topupUsd, repeat: false };
}

/** Adds to the top-up balance: a purchase (`topup`) or credit given by hand
 *  or by a promotion (`grant`). Spent after the period allowance and never
 *  reset by a rollover. With `externalId` (a Stripe event or payment id) a
 *  credit delivered twice lands once; returns false for the repeat. A
 *  purchase always comes from a Stripe event, so `topup` requires one. */
export async function credit(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: "grant" | "topup",
  amountUsd: number,
  externalId?: string,
): Promise<boolean> {
  const amount = money(amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`wallet: cannot credit ${amountUsd}`);
  if (kind === "topup" && !externalId) throw new Error("wallet: a topup needs the Stripe id it came from");
  if (externalId) {
    const seen = await ctx.db.query("wallet_ledger").withIndex("by_external_id", (q) => q.eq("external_id", externalId)).first();
    if (seen) return false;
  }
  const wallet = await ensureWallet(ctx, userId);
  await ctx.db.patch(wallet._id, { topup_usd: money(wallet.topup_usd + amount) });
  await ledger(ctx, { user_id: userId, kind, amount_usd: amount, external_id: externalId });
  return true;
}

/** The Stripe facts billing keeps on a wallet. Absent fields stay as they are. */
export interface WalletSubscription {
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  subscription_status?: string;
  /** When billing read the subscription from Stripe. */
  subscription_read_at?: number;
  /** Whether a live subscription bills the wallet. `false` lifts the payment
   *  gate (`paid_through`); `true` with the period paid in full
   *  (`moveSubscription` without `prorate`) confirms the wallet's current
   *  period paid. Absent leaves the gate as it is. */
  billed?: boolean;
}

/** The wallet fields `subscription` changes. `paidInFull` says the
 *  subscription has paid for the wallet's current period. */
function subscriptionPatch(wallet: Doc<"wallets">, subscription: WalletSubscription, paidInFull: boolean): Partial<Doc<"wallets">> {
  const patch: Partial<Doc<"wallets">> = {};
  for (const key of ["stripe_customer_id", "stripe_subscription_id", "subscription_status", "subscription_read_at"] as const) {
    if (subscription[key] !== undefined) (patch as Record<string, unknown>)[key] = subscription[key];
  }
  if (subscription.billed === false) patch.paid_through = undefined;
  else if (subscription.billed && paidInFull) patch.paid_through = Math.max(wallet.paid_through ?? 0, wallet.period_end);
  return patch;
}

/** Moves a person to `plan` by hand (or a grant): the cap becomes the whole
 *  allowance that plan grants under the subscription's status
 *  (`allowancePlan`) at once, usage and the period stay. Billing moves plans
 *  through `moveSubscription`, which charges for the change by time, except
 *  for a plan whose payment was refunded or disputed: that one keeps nothing
 *  of its allowance, whichever Stripe event landed first, so billing ends it
 *  here. */
export async function setPlan(ctx: MutationCtx, userId: Id<"users">, plan: PlanId, subscription: WalletSubscription = {}): Promise<Doc<"wallets">> {
  const wallet = await ensureWallet(ctx, userId);
  const facts: Partial<Doc<"wallets">> = { plan, ...subscriptionPatch(wallet, subscription, false) };
  const patch: Partial<Doc<"wallets">> = { ...facts, period_cap_usd: allowanceUsd({ ...wallet, ...facts }, wallet.period_end) };
  await ctx.db.patch(wallet._id, patch);
  return { ...wallet, ...patch };
}

/** The cap after the allowance moves from `fromUsd` to `toUsd` with part of
 *  the period gone: the difference counts only for the share of the period
 *  still to run, the way Stripe prorates the price. The cap may fall below
 *  what the period already used (no room is left then), and is floored at
 *  zero only. Flooring it at the usage would let a downgrade take back less
 *  than the matching upgrade gave, so each round trip between plans, which
 *  Stripe nets to about nothing, would mint usage. */
export function proratedCap(
  wallet: Pick<Doc<"wallets">, "period_start" | "period_end" | "period_cap_usd" | "period_cost_usd">,
  fromUsd: number,
  toUsd: number,
  now: number,
): number {
  const span = wallet.period_end - wallet.period_start;
  const left = span > 0 ? Math.min(1, Math.max(0, (wallet.period_end - now) / span)) : 0;
  return money(Math.max(0, wallet.period_cap_usd + (toUsd - fromUsd) * left));
}

/** Billing's plan move, from the subscription as Stripe has it now. The cap
 *  changes only when the allowance does (`allowancePlan`), so the same facts
 *  delivered twice move nothing. With `prorate` (a change to a subscription
 *  that was already paid up: an upgrade, a downgrade, a cancel or a renewal
 *  that started failing) the change counts for the rest of the period only;
 *  without it (a new subscription, or a failing renewal finally paid) the
 *  period was paid in full, so a billed subscription confirms it paid
 *  (`paid_through`) and the whole allowance applies. */
export async function moveSubscription(
  ctx: MutationCtx,
  userId: Id<"users">,
  plan: PlanId,
  subscription: WalletSubscription,
  options: { prorate: boolean; now?: number },
): Promise<Doc<"wallets">> {
  const now = options.now ?? Date.now();
  const wallet = await ensureWallet(ctx, userId, now);
  const patch: Partial<Doc<"wallets">> = { plan, ...subscriptionPatch(wallet, subscription, !options.prorate) };
  const from = allowanceUsd(wallet, wallet.period_end);
  const to = allowanceUsd({ ...wallet, ...patch }, wallet.period_end);
  if (from !== to) patch.period_cap_usd = options.prorate ? proratedCap(wallet, from, to, now) : to;
  await ctx.db.patch(wallet._id, patch);
  return { ...wallet, ...patch };
}

/** Takes a top-up's credit back after Stripe returned or lost its payment.
 *  `source` is the id the top-up was credited under (its payment intent);
 *  `share` (0 to 1) is how much of that credit should be gone once this
 *  event is applied, counting every earlier refund of it, so a second partial
 *  refund takes only the difference. Each refund row's external id starts
 *  with `<source>:`, so the earlier ones are found by prefix and an event
 *  delivered twice (`externalId`) moves nothing. Credit already spent is
 *  still taken back: the balance goes below zero, and that debt is paid from
 *  the allowance still left now and then from each new period's allowance
 *  (`repayDebt`), or by the next top-up, so a chargeback on spent credit does
 *  not keep the usage and is paid once. Returns the amount taken back, or
 *  null when no top-up has that source. */
export async function refundTopup(ctx: MutationCtx, source: string, share: number, externalId: string): Promise<number | null> {
  if (!externalId.startsWith(`${source}:`)) throw new Error(`wallet: refund id ${externalId} does not name its top-up ${source}`);
  const topup = await ctx.db.query("wallet_ledger").withIndex("by_external_id", (q) => q.eq("external_id", source)).first();
  if (!topup || topup.kind !== "topup") return null;
  const earlier = await ctx.db.query("wallet_ledger")
    .withIndex("by_external_id", (q) => q.gt("external_id", `${source}:`).lt("external_id", `${source};`))
    .collect();
  if (earlier.some((row) => row.external_id === externalId)) return 0;
  const already = earlier.reduce((sum, row) => sum + (row.kind === "refund" ? row.amount_usd : 0), 0);
  const target = topup.amount_usd * Math.min(1, Math.max(0, share));
  const amount = money(Math.max(0, target - already));
  const wallet = await ensureWallet(ctx, topup.user_id);
  // Written even at zero: the row is what makes the event land once.
  await ledger(ctx, { user_id: topup.user_id, kind: "refund", amount_usd: amount, external_id: externalId });
  if (amount > 0) {
    const { repaid, ...figures } = repayDebt({ ...wallet, topup_usd: money(wallet.topup_usd - amount) });
    await ctx.db.patch(wallet._id, figures);
    if (repaid > 0) await ledger(ctx, { user_id: topup.user_id, kind: "repay", amount_usd: repaid });
  }
  return amount;
}

/** Puts the wallet on a paid billing period, `period` in milliseconds as
 *  Stripe's invoice for it names it: anchors later periods there so the
 *  wallet's own rollover lands on Stripe's renewals, and confirms the period
 *  paid (`paid_through`). A period starting after the wallet's current one is
 *  a fresh paid period, opened by the same rule a rollover uses
 *  (`freshPeriod`, `openPeriod`). The period the wallet is already in, opened
 *  at its boundary on the free allowance because its renewal was not yet
 *  paid, gets the plan's whole allowance now that it is. A period the wallet
 *  already holds as paid changes nothing, so a redelivered invoice moves no
 *  money; a period already over is ignored. Returns whether the wallet moved. */
export async function alignPeriod(ctx: MutationCtx, userId: Id<"users">, period: { start: number; end: number }, now = Date.now()): Promise<boolean> {
  if (!(period.end > period.start) || period.end <= now) return false;
  const wallet = await ensureWallet(ctx, userId, now);
  const paid = { period_start: period.start, period_end: period.end, period_anchor: period.start, paid_through: Math.max(wallet.paid_through ?? 0, period.end) };
  if (wallet.period_start === period.start && wallet.period_end === period.end && wallet.period_anchor === period.start && wallet.paid_through === paid.paid_through) return false;
  const next = { ...wallet, ...paid };
  if (period.start > wallet.period_start) {
    await openPeriod(ctx, wallet, { ...freshPeriod(next, period.start, period.end, wallet.topup_usd), ...paid }, now);
  } else {
    const from = allowanceUsd(wallet, wallet.period_end);
    const to = allowanceUsd(next, period.end);
    await ctx.db.patch(wallet._id, from !== to ? { ...paid, period_cap_usd: to } : paid);
  }
  return true;
}

/** One line of the plan screen's usage: what one conversation cost recently.
 *  The screen names it from the store's conversation row by id; the title
 *  is not copied here. */
export interface WalletConversationLine {
  conversation_id: Id<"conversations">;
  cost_usd: number;
  turns: number;
  last_at: number;
}

/** A credit, a reset, a refund or a debt payment on the plan screen. */
export interface WalletAccountLine {
  kind: "grant" | "topup" | "period_reset" | "refund" | "repay";
  amount_usd: number;
  at: number;
}

/** What the simple lane's plan screen renders (`wallet.mine`, store key
 *  `wallet`). Numbers are this period's, rollover applied. */
export interface WalletSummary {
  plan: PlanId;
  cap_usd: number;
  used_usd: number;
  reserved_usd: number;
  /** What a new turn may still reserve: allowance left plus top-up, less holds. */
  remaining_usd: number;
  /** The top-up balance. Below zero after a refund or dispute of credit
   *  already spent, when the allowance left could not cover it: a debt each
   *  new period's allowance pays first (`repayDebt`). */
  topup_usd: number;
  /** The moment every period boundary counts from (`periodAnchor`): the
   *  wallet's creation, or the start of the paid billing cycle once billing
   *  aligned it. Not a sign-up date. Null until the first turn makes the
   *  wallet, like the period fields. */
  period_anchor: number | null;
  period_start: number | null;
  period_end: number | null;
  subscription_status: string | null;
  /** The end of the last period Stripe confirmed paid while a subscription
   *  bills the wallet, else null (`allowancePlan`). */
  paid_through: number | null;
  /** Whether Stripe holds a customer for this person (any plan or top-up was
   *  bought), so the billing portal has something to show. */
  billing_account: boolean;
  conversations: WalletConversationLine[];
  account: WalletAccountLine[];
}

const SUMMARY_LEDGER_ROWS = 300;
const SUMMARY_CONVERSATIONS = 20;
const SUMMARY_ACCOUNT_LINES = 10;

/** A summary as it reads at `now`: once its period has ended it shows the
 *  next one (usage reset, cap from the plan, any debt paid from it, holds and
 *  top-up carried), the
 *  same rule a write applies through `ensureWallet`. A live query re-runs only
 *  when the data it read changes, never because time passed, so the server
 *  applies this when it reads and the client applies it again on its clock
 *  (useWallet). Returns the same object while the period runs. */
export function summaryAt(summary: WalletSummary, now: number): WalletSummary {
  if (summary.period_anchor == null || summary.period_end == null) return summary;
  const next = nextPeriod(summary.period_anchor, summary, summary.period_end, summary.topup_usd, now);
  if (!next) return summary;
  return {
    ...summary,
    cap_usd: next.period_cap_usd,
    used_usd: next.period_cost_usd,
    topup_usd: next.topup_usd,
    remaining_usd: walletRoom({ ...next, period_reserved_usd: summary.reserved_usd }),
    period_start: next.period_start,
    period_end: next.period_end,
  };
}

/** The plan screen's numbers for one person. */
export async function walletSummary(ctx: QueryCtx, userId: Id<"users">, now = Date.now()): Promise<WalletSummary> {
  const wallet = await walletRow(ctx, userId);
  const plan = planOf(wallet?.plan);
  const figures = wallet ?? { period_cap_usd: plan.included_usd, period_cost_usd: 0, period_reserved_usd: 0, topup_usd: 0 };

  const rows = await ctx.db.query("wallet_ledger").withIndex("by_user_at", (q) => q.eq("user_id", userId)).order("desc").take(SUMMARY_LEDGER_ROWS);
  const byConversation = new Map<string, WalletConversationLine>();
  const account: WalletAccountLine[] = [];
  for (const row of rows) {
    if (row.kind === "charge" && row.conversation_id) {
      const line = byConversation.get(row.conversation_id);
      if (line) {
        line.cost_usd = money(line.cost_usd + row.amount_usd);
        line.turns += 1;
      } else if (byConversation.size < SUMMARY_CONVERSATIONS) {
        byConversation.set(row.conversation_id, { conversation_id: row.conversation_id, cost_usd: row.amount_usd, turns: 1, last_at: row.at });
      }
    } else if ((row.kind === "grant" || row.kind === "topup" || row.kind === "period_reset" || row.kind === "refund" || row.kind === "repay") && account.length < SUMMARY_ACCOUNT_LINES) {
      account.push({ kind: row.kind, amount_usd: row.amount_usd, at: row.at });
    }
  }

  return summaryAt({
    plan: plan.id,
    cap_usd: figures.period_cap_usd,
    used_usd: money(figures.period_cost_usd),
    reserved_usd: money(figures.period_reserved_usd),
    remaining_usd: walletRoom(figures),
    topup_usd: money(figures.topup_usd),
    period_anchor: wallet ? periodAnchor(wallet) : null,
    period_start: wallet?.period_start ?? null,
    period_end: wallet?.period_end ?? null,
    subscription_status: wallet?.subscription_status ?? null,
    paid_through: wallet?.paid_through ?? null,
    billing_account: !!wallet?.stripe_customer_id,
    conversations: [...byConversation.values()],
    account,
  }, now);
}
