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

type PeriodFigures = Pick<Doc<"wallets">, "period_start" | "period_end" | "period_cost_usd" | "period_cap_usd">;

/** The figures of the period holding `now` once the period ending at
 *  `periodEnd` is over, or null while it runs. Usage resets; reservations of
 *  turns still in flight and the top-up balance carry over, and the cap
 *  follows the plan. The one rollover rule, for the stored wallet
 *  (`rolledOver`) and for a summary a client already holds (`summaryAt`). */
function nextPeriod(anchor: number, plan: PlanId | undefined, periodEnd: number, now: number): PeriodFigures | null {
  if (now < periodEnd) return null;
  const { start, end } = periodAt(anchor, now);
  return { period_start: start, period_end: end, period_cost_usd: 0, period_cap_usd: planOf(plan).included_usd };
}

/** The patch that moves a wallet into the period holding `now`, or null when
 *  it is already there. */
export function rolledOver(wallet: Doc<"wallets">, now: number): PeriodFigures | null {
  return nextPeriod(periodAnchor(wallet), wallet.plan, wallet.period_end, now);
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

/** The plan a person is on; no wallet is the free plan. Readable from a query. */
export async function walletPlan(ctx: Pick<QueryCtx, "db">, userId: Id<"users">): Promise<PlanSpec> {
  return planOf((await walletRow(ctx, userId))?.plan);
}

async function ledger(ctx: MutationCtx, row: Omit<Doc<"wallet_ledger">, "_id" | "_creationTime" | "at"> & { at?: number }): Promise<void> {
  await ctx.db.insert("wallet_ledger", { ...row, amount_usd: money(row.amount_usd), at: row.at ?? Date.now() });
}

/** The person's wallet, made on first use (free plan, a monthly period from
 *  now) and rolled into the current period if the last one ended. Every
 *  wallet movement starts here, so usage never carries across a period. */
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
    return (await ctx.db.get(id))!;
  }
  const patch = rolledOver(wallet, now);
  if (!patch) return wallet;
  await ctx.db.patch(wallet._id, patch);
  // The usage the new period forgave, so the ledger explains the meter's drop.
  await ledger(ctx, { user_id: userId, kind: "period_reset", amount_usd: wallet.period_cost_usd, at: now });
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
/** The newest ledger rows the leak scan also reads, for holds whose turn row
 *  was deleted (and so carries no `holding` flag to find it by). */
const LEAK_SCAN_ROWS = 1000;
/** Turns flagged `holding` the scan reads: the live ones plus any leaked. */
const LEAK_SCAN_TURNS = 500;
/** How long an ended turn's hold is left for its settle before it counts as
 *  leaked. The finish settles in the mutation that ends the turn, so a hold
 *  this young belongs to a settle still on its way, and freeing it would let
 *  another turn reserve room the coming charge is about to spend. */
export const LEAK_GRACE_MS = 10 * 60_000;

/** True when a turn's hold can be taken back: the turn row is gone, or the
 *  turn ended (not queued or running) more than LEAK_GRACE_MS ago. */
function holdLeaked(turn: Doc<"assistant_turns"> | null, now: number): boolean {
  if (!turn) return true;
  if (LIVE_TURN.has(turn.status)) return false;
  return now - (turn.ended_at ?? turn.started_at ?? turn._creationTime) >= LEAK_GRACE_MS;
}

/** Releases what ended turns of this person still hold: a turn whose action
 *  died before its finish never gave its reservation back (Averil's hourly
 *  reconcile). Run only when a reservation is refused, the one moment a leak
 *  costs the person anything. Candidates are every turn flagged `holding`,
 *  however far back its reserve row sits, plus the reserve rows among the
 *  newest ledger rows, which catch a hold whose turn row was deleted. */
async function releaseLeaks(ctx: MutationCtx, userId: Id<"users">, now = Date.now()): Promise<number> {
  const turns = new Set<Id<"assistant_turns">>();
  const holding = await ctx.db.query("assistant_turns").withIndex("by_user_holding", (q) => q.eq("user_id", userId).eq("holding", true)).take(LEAK_SCAN_TURNS);
  for (const turn of holding) turns.add(turn._id);
  const rows = await ctx.db.query("wallet_ledger").withIndex("by_user_at", (q) => q.eq("user_id", userId)).order("desc").take(LEAK_SCAN_ROWS);
  for (const row of rows) if (row.kind === "reserve" && row.turn_id) turns.add(row.turn_id);
  let released = 0;
  for (const turnId of turns) {
    if (!holdLeaked(await ctx.db.get(turnId), now)) continue;
    released += await releaseTurn(ctx, turnId);
  }
  return money(released);
}

/** Reserves `amountUsd` for a turn if the wallet has room for all of it, in
 *  this mutation, and returns false when it does not (the turn then ends
 *  with reason `budget`). The turn's `cost_reserved_usd` grows by the amount,
 *  so a turn may reserve more than once (a ceiling raised mid-run). */
export async function reserve(ctx: MutationCtx, userId: Id<"users">, turnId: Id<"assistant_turns">, amountUsd: number): Promise<boolean> {
  const amount = money(amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`wallet: cannot reserve ${amountUsd}`);
  const turn = await turnOf(ctx, turnId);
  if (turn.user_id !== userId) throw new Error(`wallet: turn ${turnId} is not this person's`);
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
 *  Idempotent per turn: a second call finds the turn's charge row and moves
 *  nothing. */
export async function settleTurn(
  ctx: MutationCtx,
  turnId: Id<"assistant_turns">,
  costUsd: number,
  model?: string,
): Promise<TurnSettlement> {
  const earlier = await ctx.db.query("wallet_ledger").withIndex("by_turn", (q) => q.eq("turn_id", turnId)).collect();
  const charged = earlier.find((row) => row.kind === "charge");
  if (charged) return { chargedUsd: charged.amount_usd, releasedUsd: 0, topupUsd: 0, repeat: true };

  const releasedUsd = await releaseTurn(ctx, turnId);
  const turn = await turnOf(ctx, turnId);
  const cost = money(Number.isFinite(costUsd) ? Math.max(0, costUsd) : 0);
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
}

/** Moves a person to `plan`: the cap becomes that plan's allowance at once,
 *  usage and the period stay, so an upgrade mid-period widens room now and a
 *  downgrade leaves what was already spent. Billing calls it with the Stripe
 *  facts; by hand it takes the plan alone. */
export async function setPlan(ctx: MutationCtx, userId: Id<"users">, plan: PlanId, subscription: WalletSubscription = {}): Promise<Doc<"wallets">> {
  const wallet = await ensureWallet(ctx, userId);
  const patch: Partial<Doc<"wallets">> = { plan, period_cap_usd: planOf(plan).included_usd };
  for (const key of ["stripe_customer_id", "stripe_subscription_id", "subscription_status"] as const) {
    if (subscription[key] !== undefined) patch[key] = subscription[key];
  }
  await ctx.db.patch(wallet._id, patch);
  return { ...wallet, ...patch };
}

/** Puts the wallet on a paid billing period, `period` in milliseconds as
 *  Stripe's invoice for it names it, and anchors later periods there so the
 *  wallet's own rollover lands on Stripe's renewals. A period starting after
 *  the wallet's current one is a fresh paid period: usage resets (with a
 *  `period_reset` row, as a rollover writes) and the cap follows the plan. A
 *  period the wallet already holds changes nothing, so a redelivered invoice
 *  or one arriving after the rollover moves no money; a period already over
 *  is ignored. Returns whether the wallet moved. */
export async function alignPeriod(ctx: MutationCtx, userId: Id<"users">, period: { start: number; end: number }, now = Date.now()): Promise<boolean> {
  if (!(period.end > period.start) || period.end <= now) return false;
  const wallet = await ensureWallet(ctx, userId, now);
  if (wallet.period_start === period.start && wallet.period_end === period.end && wallet.period_anchor === period.start) return false;
  const fresh = period.start > wallet.period_start;
  const patch: Partial<Doc<"wallets">> = { period_start: period.start, period_end: period.end, period_anchor: period.start };
  if (fresh) {
    patch.period_cost_usd = 0;
    patch.period_cap_usd = planOf(wallet.plan).included_usd;
  }
  await ctx.db.patch(wallet._id, patch);
  if (fresh) await ledger(ctx, { user_id: userId, kind: "period_reset", amount_usd: wallet.period_cost_usd, at: now });
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

/** A credit or a reset on the plan screen. */
export interface WalletAccountLine {
  kind: "grant" | "topup" | "period_reset";
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
  topup_usd: number;
  /** The moment every period boundary counts from (`periodAnchor`): the
   *  wallet's creation, or the start of the paid billing cycle once billing
   *  aligned it. Null until the first turn makes the wallet, like the period
   *  fields. */
  created_at: number | null;
  period_start: number | null;
  period_end: number | null;
  subscription_status: string | null;
  conversations: WalletConversationLine[];
  account: WalletAccountLine[];
}

const SUMMARY_LEDGER_ROWS = 300;
const SUMMARY_CONVERSATIONS = 20;
const SUMMARY_ACCOUNT_LINES = 10;

/** A summary as it reads at `now`: once its period has ended it shows the
 *  next one (usage zero, cap from the plan, holds and top-up carried), the
 *  same rule a write applies through `ensureWallet`. A live query re-runs only
 *  when the data it read changes, never because time passed, so the server
 *  applies this when it reads and the client applies it again on its clock
 *  (useWallet). Returns the same object while the period runs. */
export function summaryAt(summary: WalletSummary, now: number): WalletSummary {
  if (summary.created_at == null || summary.period_end == null) return summary;
  const next = nextPeriod(summary.created_at, summary.plan, summary.period_end, now);
  if (!next) return summary;
  return {
    ...summary,
    cap_usd: next.period_cap_usd,
    used_usd: 0,
    remaining_usd: walletRoom({ ...next, period_reserved_usd: summary.reserved_usd, topup_usd: summary.topup_usd }),
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
    } else if ((row.kind === "grant" || row.kind === "topup" || row.kind === "period_reset") && account.length < SUMMARY_ACCOUNT_LINES) {
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
    created_at: wallet ? periodAnchor(wallet) : null,
    period_start: wallet?.period_start ?? null,
    period_end: wallet?.period_end ?? null,
    subscription_status: wallet?.subscription_status ?? null,
    conversations: [...byConversation.values()],
    account,
  }, now);
}
