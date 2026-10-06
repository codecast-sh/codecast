// A hosted assistant's wallet arithmetic: money, monthly periods, the room a
// turn may still reserve, how a charge splits, proration, the allowance a
// period grants, and the debt a refund of spent credit leaves. No storage:
// the app reads and writes its wallet rows and calls these for every number,
// so a reservation, a settle, a rollover and the plan screen all count the
// same way. Pure, and it imports only the plan shape, so a web or phone
// bundle can run the same rollover on its own clock.
//
// Money is US dollars at cost, rounded to a millionth so sums of tenths
// compare the way a person reads them.
import { planIn, type PlanCatalog } from "./plans";

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

/** The numbers a wallet keeps for its current period. */
export interface WalletFigures {
  period_start: number;
  period_end: number;
  /** The allowance this period grants. */
  period_cap_usd: number;
  /** What this period has spent of it (and beyond it, on an overrun). */
  period_cost_usd: number;
  /** What turns in flight hold. */
  period_reserved_usd: number;
  /** The top-up balance: spent after the allowance, never reset. Below zero
   *  is a debt (`repayDebt`). */
  topup_usd: number;
}

/** The figures a period opens with. */
export type PeriodFigures = Pick<WalletFigures, "period_start" | "period_end" | "period_cost_usd" | "period_cap_usd" | "topup_usd">;

/** What decides a period's allowance: the plan, the payment provider's
 *  subscription status, and the end of the last period it confirmed paid
 *  (absent when no live subscription bills the wallet). */
export type AllowanceFacts<Id extends string = string> = {
  plan?: Id;
  subscription_status?: string | null;
  paid_through?: number | null;
};

/** What is left of the period allowance, ignoring reservations. */
export function allowanceLeft(wallet: Pick<WalletFigures, "period_cap_usd" | "period_cost_usd">): number {
  return Math.max(0, wallet.period_cap_usd - wallet.period_cost_usd);
}

/** A debt (a top-up balance below zero, left by a refund or dispute of
 *  credit already spent) paid from the allowance still left: the payment
 *  counts as usage and raises the balance by the same amount, so a debt is
 *  paid once and then gone. `repaid` is the amount moved. */
export function repayDebt(
  figures: Pick<WalletFigures, "period_cap_usd" | "period_cost_usd" | "topup_usd">,
): { period_cost_usd: number; topup_usd: number; repaid: number } {
  const repaid = money(Math.min(Math.max(0, -figures.topup_usd), allowanceLeft(figures)));
  return { period_cost_usd: money(figures.period_cost_usd + repaid), topup_usd: money(figures.topup_usd + repaid), repaid };
}

/** What a new reservation may still take: the allowance left, then the
 *  top-up balance, less what turns in flight already hold. */
export function walletRoom(wallet: Pick<WalletFigures, "period_cap_usd" | "period_cost_usd" | "period_reserved_usd" | "topup_usd">): number {
  return money(Math.max(0, allowanceLeft(wallet) + wallet.topup_usd - wallet.period_reserved_usd));
}

/** How a charge splits: the period allowance first, then the top-up balance.
 *  Whatever neither covers (a turn that ran past its ceiling) still lands on
 *  the period's usage, so the meter shows the overrun honestly. */
export function splitCharge(
  wallet: Pick<WalletFigures, "period_cap_usd" | "period_cost_usd" | "topup_usd">,
  amount: number,
): { periodUsd: number; topupUsd: number } {
  const fromAllowance = Math.min(amount, allowanceLeft(wallet));
  const topupUsd = Math.min(amount - fromAllowance, Math.max(0, wallet.topup_usd));
  return { periodUsd: money(amount - topupUsd), topupUsd: money(topupUsd) };
}

/** The cap after the allowance moves from `fromUsd` to `toUsd` with part of
 *  the period gone: the difference counts only for the share of the period
 *  still to run, the way Stripe prorates the price. The cap may fall below
 *  what the period already used (no room is left then), and is floored at
 *  zero only. Flooring it at the usage would let a downgrade take back less
 *  than the matching upgrade gave, so each round trip between plans, which
 *  Stripe nets to about nothing, would mint usage. */
export function proratedCap(
  wallet: Pick<WalletFigures, "period_start" | "period_end" | "period_cap_usd" | "period_cost_usd">,
  fromUsd: number,
  toUsd: number,
  now: number,
): number {
  const span = wallet.period_end - wallet.period_start;
  const left = span > 0 ? Math.min(1, Math.max(0, (wallet.period_end - now) / span)) : 0;
  return money(Math.max(0, wallet.period_cap_usd + (toUsd - fromUsd) * left));
}

/** The figures of a plan screen, as `summaryAt` reads and moves them. An app's
 *  own summary adds its lines (usage per conversation, credits) to these. */
export interface WalletSummaryFigures<Id extends string = string> {
  plan: Id;
  cap_usd: number;
  used_usd: number;
  reserved_usd: number;
  /** What a new turn may still reserve: allowance left plus top-up, less holds. */
  remaining_usd: number;
  /** The top-up balance. Below zero after a refund or dispute of credit
   *  already spent, when the allowance left could not cover it: a debt each
   *  new period's allowance pays first (`repayDebt`). */
  topup_usd: number;
  /** The moment every period boundary counts from. Null until the wallet is
   *  made, like the period fields. */
  period_anchor: number | null;
  period_start: number | null;
  period_end: number | null;
  subscription_status: string | null;
  /** The end of the last period the provider confirmed paid while a
   *  subscription bills the wallet, else null (`allowancePlan`). */
  paid_through: number | null;
}

/** The rules that read a plan catalog, bound to one. */
export interface WalletRules<Id extends string> {
  /** The plan whose allowance a period ending at `periodEnd` grants. A paid
   *  plan keeps its name but grants the free allowance while its renewal is
   *  failing (Stripe's `past_due`), and for a period ending after
   *  `paid_through`: a period opens at its boundary before the provider has
   *  charged for it, so it starts on the free allowance, and a renewal that
   *  is never paid (a lapsed card, events that stopped arriving) never grants
   *  the paid one. The paid allowance comes when the payment lands. */
  allowancePlan(facts: AllowanceFacts<Id>, periodEnd: number): Id | undefined;
  /** The allowance in dollars that `allowancePlan` grants. */
  allowanceUsd(facts: AllowanceFacts<Id>, periodEnd: number): number;
  /** The figures of a fresh period from `start` to `end`: usage resets, the
   *  cap follows the plan (`allowancePlan`), and the new allowance pays any
   *  debt first (`repayDebt`). Reservations of turns still in flight and the
   *  top-up balance carry over. The one rule for opening a period, whether
   *  the wallet rolled over or billing put it on the provider's. */
  freshPeriod(facts: AllowanceFacts<Id>, start: number, end: number, topupUsd: number): PeriodFigures;
  /** The figures of the period holding `now` once the period ending at
   *  `periodEnd` is over, or null while it runs. The one rollover rule, for
   *  the stored wallet and for a summary a client already holds. */
  nextPeriod(anchor: number, facts: AllowanceFacts<Id>, periodEnd: number, topupUsd: number, now: number): PeriodFigures | null;
  /** A summary as it reads at `now`: once its period has ended it shows the
   *  next one (usage reset, cap from the plan, any debt paid from it, holds
   *  and top-up carried), the same rule a write applies. A live query re-runs
   *  only when the data it read changes, never because time passed, so the
   *  server applies this when it reads and the client applies it again on
   *  its clock. Returns the same object while the period runs. */
  summaryAt<S extends WalletSummaryFigures<Id>>(summary: S, now: number): S;
}

/** The wallet rules for one plan catalog. */
export function walletRules<Id extends string>(catalog: PlanCatalog<Id>): WalletRules<Id> {
  const rules: WalletRules<Id> = {
    allowancePlan(facts, periodEnd) {
      if (facts.subscription_status === "past_due") return catalog.free;
      if (facts.paid_through != null && periodEnd > facts.paid_through) return catalog.free;
      return facts.plan;
    },
    allowanceUsd: (facts, periodEnd) => planIn(catalog, rules.allowancePlan(facts, periodEnd)).included_usd,
    freshPeriod(facts, start, end, topupUsd) {
      const fresh = { period_cap_usd: rules.allowanceUsd(facts, end), period_cost_usd: 0, topup_usd: topupUsd };
      const { period_cost_usd, topup_usd } = repayDebt(fresh);
      return { period_start: start, period_end: end, period_cap_usd: fresh.period_cap_usd, period_cost_usd, topup_usd };
    },
    nextPeriod(anchor, facts, periodEnd, topupUsd, now) {
      if (now < periodEnd) return null;
      const { start, end } = periodAt(anchor, now);
      return rules.freshPeriod(facts, start, end, topupUsd);
    },
    summaryAt(summary, now) {
      if (summary.period_anchor == null || summary.period_end == null) return summary;
      const next = rules.nextPeriod(summary.period_anchor, summary, summary.period_end, summary.topup_usd, now);
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
    },
  };
  return rules;
}
