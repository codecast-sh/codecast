// A team's monthly model budget (docs/architecture/learning-loop.md LL10).
// Every model call codecast makes for a product's loop (a judge, grouping, a
// graph's call node) reserves its worst case before it is sent and settles
// what it really cost after, inside the cap a person set. A cap of 0 is off:
// nothing that needs the budget runs, and each refusal is counted so the
// budget can say what waited on it. A workspace with no row has a cap of 0.

import type { Doc, Id } from "../_generated/dataModel";
import { BUDGET_PURPOSES, budgetMonth, type BudgetPurpose, type BudgetSummary } from "@codecast/shared/contracts/modelCall";
import { modelCost } from "./anthropic";

/** Months of spend a budget row remembers. */
const HISTORY_MONTHS = 12;

const zero = (): Record<BudgetPurpose, number> => ({ judge: 0, grouping: 0, call: 0 });
const cents = (n: number) => Math.round(n * 1e6) / 1e6;
/** A reservation in whole millionths of a dollar, rounded up, so taking and releasing it leave nothing behind. */
const hold = (n: number) => Math.ceil(n * 1e6 - 1e-9) / 1e6;

async function rowOf(ctx: { db: any }, workspace: string): Promise<Doc<"team_budgets"> | null> {
  return await ctx.db.query("team_budgets").withIndex("by_workspace", (q: any) => q.eq("workspace", workspace)).first();
}

/** The row as of `now`: a new month starts from zero and files the old one in history. */
function rolled(row: Doc<"team_budgets">, now: number): Partial<Doc<"team_budgets">> | null {
  const month = budgetMonth(now);
  if (row.month === month) return null;
  return {
    month,
    spent_usd: 0,
    // Holds belong to calls still in flight; they settle into the new month.
    held_usd: row.held_usd,
    by_purpose: zero(),
    refused: 0,
    last_refused_at: undefined,
    history: [{ month: row.month, spent_usd: row.spent_usd }, ...row.history].slice(0, HISTORY_MONTHS),
  };
}

async function current(ctx: { db: any }, workspace: string, teamId: Id<"teams"> | undefined, now: number): Promise<Doc<"team_budgets">> {
  const row = await rowOf(ctx, workspace);
  if (!row) {
    const id = await ctx.db.insert("team_budgets", {
      workspace,
      ...(teamId ? { team_id: teamId } : {}),
      cap_usd: 0,
      month: budgetMonth(now),
      spent_usd: 0,
      held_usd: 0,
      by_purpose: zero(),
      refused: 0,
      history: [],
      updated_at: now,
    });
    return (await ctx.db.get(id))!;
  }
  const roll = rolled(row, now);
  if (!roll) return row;
  await ctx.db.patch(row._id, { ...roll, updated_at: now });
  return { ...row, ...roll } as Doc<"team_budgets">;
}

/** A call's worst case: its prompt at three characters a token (which overstates English) and every output token it may write. */
export function worstCaseCost(model: string, promptChars: number, maxTokens: number): number {
  return modelCost(model, { input_tokens: Math.ceil(promptChars / 3), output_tokens: maxTokens });
}

/**
 * Reserves `amount` for one call. False when the cap has no room for it, and
 * the refusal is counted. The caller settles what it reserved, called or not.
 */
export async function takeBudget(ctx: { db: any }, workspace: string, teamId: Id<"teams"> | undefined, amount: number, now: number): Promise<boolean> {
  const row = await current(ctx, workspace, teamId, now);
  amount = hold(amount);
  if (row.cap_usd <= 0 || row.spent_usd + row.held_usd + amount > row.cap_usd) {
    await ctx.db.patch(row._id, { refused: row.refused + 1, last_refused_at: now, updated_at: now });
    return false;
  }
  await ctx.db.patch(row._id, { held_usd: cents(row.held_usd + amount), updated_at: now });
  return true;
}

/** Releases a reservation and charges what the call really cost to its purpose. */
export async function settleBudget(ctx: { db: any }, workspace: string, purpose: BudgetPurpose, held: number, cost: number, now: number): Promise<void> {
  const row = await current(ctx, workspace, undefined, now);
  await ctx.db.patch(row._id, {
    held_usd: Math.max(0, cents(row.held_usd - hold(held))),
    spent_usd: cents(row.spent_usd + cost),
    by_purpose: { ...row.by_purpose, [purpose]: cents(row.by_purpose[purpose] + cost) },
    updated_at: now,
  });
}

/** Sets the monthly cap; the month's spend is kept. */
export async function setBudgetCap(ctx: { db: any }, workspace: string, teamId: Id<"teams"> | undefined, capUsd: number, userId: Id<"users">, now: number): Promise<void> {
  const row = await current(ctx, workspace, teamId, now);
  await ctx.db.patch(row._id, { cap_usd: capUsd, set_by: userId, set_at: now, updated_at: now });
}

/** What a person sees: the cap and this month's spend, rolled to `now` without writing. */
export async function readBudget(ctx: { db: any }, workspace: string, now: number): Promise<BudgetSummary> {
  const row = await rowOf(ctx, workspace);
  if (!row) return { cap_usd: 0, month: budgetMonth(now), spent_usd: 0, held_usd: 0, by_purpose: zero(), refused: 0, history: [] };
  const view = { ...row, ...(rolled(row, now) ?? {}) } as Doc<"team_budgets">;
  const by: Record<BudgetPurpose, number> = zero();
  for (const p of BUDGET_PURPOSES) by[p] = view.by_purpose[p] ?? 0;
  return {
    cap_usd: view.cap_usd,
    month: view.month,
    spent_usd: view.spent_usd,
    held_usd: view.held_usd,
    by_purpose: by,
    refused: view.refused,
    ...(view.last_refused_at ? { last_refused_at: view.last_refused_at } : {}),
    history: view.history,
  };
}
