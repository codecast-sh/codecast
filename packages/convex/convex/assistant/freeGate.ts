// Who the Free plan serves (plan pl-840, docs/architecture/hosted-assistant.md
// "Plans"). Every new wallet starts on Free with a month of our own tokens,
// so without a gate each throwaway address is a fresh $2 of inference. Three
// rules bound it, all read in the lease (turns.ts leaseTurn) before a Free
// turn reserves anything:
//
// - A proven address. The person must hold the email their account names:
//   an Apple, Google or GitHub sign-in proves it, and a password account
//   proves it with a mailed code (lib/emailProof). Until then the turn stops
//   on a `verify` notice and picks up by itself once the code is entered.
// - One Free month per mailbox. Big mail providers hand out aliases for
//   nothing (Gmail ignores dots, and most ignore a +tag), so new accounts on
//   aliases of one address share the Free month of the first one that used it.
// - A daily ceiling on what all Free turns together spend. Past it new Free
//   turns pause until the next UTC day, and the operator is told once.
//
// The per-IP cap the abuse review asked for is left out on purpose: the
// address a self-hosted Convex function sees is a rotating internal proxy
// address, so an IP key bounds nothing. The mailbox is the unit of abuse.
//
// A turn a paid plan or bought credit pays for is never gated: a card is
// already behind it.
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { FREE_DAILY_CEILING_USD, planOf } from "@codecast/shared/contracts/assistant";
import { emailProven, workDomain } from "../lib/workDomain";
import { hasLiveCode, sendEmailCode } from "../lib/emailProof";
import { ensureWallet, money, walletRow } from "../lib/wallet";

/** Why a Free turn may not run now. */
export type FreeRefusal =
  | { kind: "verify"; email: string }
  | { kind: "mailbox" }
  | { kind: "paused"; resumesAt: number };

/** True when a wallet's turns spend our Free allowance: a Free plan with no
 *  bought credit. */
export function servesFromFree(wallet: Pick<Doc<"wallets">, "plan" | "topup_usd">): boolean {
  return planOf(wallet.plan).price_usd === 0 && wallet.topup_usd <= 0;
}

/** The mailbox an address delivers to, as the Free plan counts it: lower
 *  case, and on a consumer mail provider without the +tag (and, on Gmail,
 *  without dots), since anyone can mint those aliases. A company domain keeps
 *  its address whole: its owner can mint any address there anyway. Null for
 *  a malformed address. */
export function freeMailbox(email: string | undefined | null): string | null {
  const m = String(email ?? "").trim().toLowerCase().match(/^([^\s@]+)@([a-z0-9.-]+\.[a-z]{2,})$/);
  if (!m) return null;
  let [, local, domain] = m;
  if (workDomain(`x@${domain}`) !== null) return `${local}@${domain}`;
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local ? `${local}@${domain}` : null;
}

/** The UTC day a moment falls in, as the daily ceiling counts it. */
export function freeDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The start of the UTC day after `at`: when paused Free turns resume. */
export function nextFreeDay(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** The day's ceiling: HOSTED_FREE_DAILY_USD when the deployment sets a
 *  number, else FREE_DAILY_CEILING_USD. */
export function freeDailyCeilingUsd(): number {
  const raw = process.env.HOSTED_FREE_DAILY_USD;
  const set = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(set) && set >= 0 ? set : FREE_DAILY_CEILING_USD;
}

function dayRow(ctx: Pick<MutationCtx, "db">, day: string) {
  return ctx.db.query("assistant_free_days").withIndex("by_day", (q) => q.eq("day", day)).first();
}

/**
 * Whether a turn of this person may run on the Free allowance now, or why
 * not. Null when it may, and for every turn a paid plan or bought credit
 * pays for. A proven person's first Free turn claims their mailbox.
 */
export async function freeTurnRefusal(ctx: MutationCtx, userId: Id<"users">, now = Date.now()): Promise<FreeRefusal | null> {
  if (!servesFromFree(await ensureWallet(ctx, userId, now))) return null;
  const user = await ctx.db.get(userId);
  if (!user) return null;
  if (!(await emailProven(ctx, user))) return { kind: "verify", email: user.email ?? "" };
  const mailbox = freeMailbox(user.email);
  if (mailbox) {
    const claim = await ctx.db.query("assistant_free_mailboxes").withIndex("by_mailbox", (q) => q.eq("mailbox", mailbox)).first();
    if (claim && claim.user_id !== userId) return { kind: "mailbox" };
    if (!claim) await ctx.db.insert("assistant_free_mailboxes", { mailbox, user_id: userId, at: now });
  }
  const today = await dayRow(ctx, freeDay(now));
  if (today && today.spent_usd >= freeDailyCeilingUsd()) return { kind: "paused", resumesAt: nextFreeDay(now) };
  return null;
}

/** Mails the person a code for the `verify` stop, unless one they can still
 *  enter is out. Never throws: a refused send (too many this hour) leaves
 *  the notice's own "send a new code" to say why. */
export async function offerEmailCode(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user?.email || (await hasLiveCode(ctx, user))) return;
  try {
    await sendEmailCode(ctx, user);
  } catch {
    // Rate limited: the code sent earlier this hour still stands, or the
    // person asks for a new one once the hour passes.
  }
}

/**
 * Counts what a settled turn spent of our Free allowance toward the day's
 * ceiling. `allowanceUsd` is the part of its charge the period allowance
 * paid (not bought credit). The first turn past the ceiling tells the
 * operator; the day's row remembers it so they hear once a day.
 */
export async function noteFreeSpend(ctx: MutationCtx, userId: Id<"users">, allowanceUsd: number, now = Date.now()): Promise<void> {
  if (!(allowanceUsd > 0)) return;
  const wallet = await walletRow(ctx, userId);
  if (!wallet || planOf(wallet.plan).price_usd !== 0) return;
  const day = freeDay(now);
  const row = await dayRow(ctx, day);
  const spent = money((row?.spent_usd ?? 0) + allowanceUsd);
  const ceiling = freeDailyCeilingUsd();
  const alert = spent >= ceiling && !row?.alerted_at;
  if (row) await ctx.db.patch(row._id, { spent_usd: spent, turns: row.turns + 1, ...(alert ? { alerted_at: now } : {}) });
  else await ctx.db.insert("assistant_free_days", { day, spent_usd: spent, turns: 1, ...(alert ? { alerted_at: now } : {}) });
  if (alert) {
    await ctx.scheduler.runAfter(0, internal.assistant.incidents.alertFreeCeiling, { day, spent_usd: spent, ceiling_usd: ceiling, turns: (row?.turns ?? 0) + 1 });
  }
}
