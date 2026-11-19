// Proving a signed-in person holds an email address: a six digit code mailed
// to the address and entered back here. For the account's own address that
// sets `users.emailVerificationTime` (which lib/workDomain's emailProven
// reads): password sign-up does not verify the address, so this is how such
// an account proves it later. Three callers: finding your team by work email
// (teamDiscovery.ts), the Free allowance of the hosted assistant
// (assistant/freeGate.ts), and moving the account to a new address
// (accountEmail.ts), which mails the code to the address being moved to.
//
// One code per person at a time (work_email_codes), stored hashed, good for
// CODE_TTL_MS and MAX_CODE_ATTEMPTS tries, and at most CODES_PER_HOUR mailed.
// A code opens only the address it was mailed to: one sent to a new address
// never proves the current one, and the reverse.
//
// A refusal is a ConvexError carrying the sentence the person reads, which a
// production deployment passes through (a plain Error's message it hides).
// A WRONG CODE IS NOT A REFUSAL: it is returned. The try it cost is a write,
// and a mutation that throws rolls its writes back, so a thrown "not right"
// never counted and six digits could be guessed without limit. Every caller
// returns the failed check to its client and lets the mutation commit.
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import { bumpWindow } from "../ipRateLimit";
import { sha256Hex } from "./hash";

export const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;

/** Hex SHA-256 of a code, as stored. */
const sha256 = sha256Hex;

function sixDigits(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return String(100000 + (n % 900000));
}

function codeRow(ctx: Pick<MutationCtx, "db">, user: Doc<"users">) {
  return ctx.db.query("work_email_codes").withIndex("by_user", (q) => q.eq("user_id", user._id)).first();
}

function refuse(message: string): never {
  throw new ConvexError({ message });
}

/** True while the person holds a code for their current address that can
 *  still be entered. */
export async function hasLiveCode(ctx: Pick<MutationCtx, "db">, user: Doc<"users">, now = Date.now()): Promise<boolean> {
  const row = await codeRow(ctx, user);
  return !!row && row.email === user.email && row.expires_at > now && row.attempts < MAX_CODE_ATTEMPTS;
}

/** Mails a fresh code, replacing any earlier one: to the person's account
 *  email to prove it, or to `movingTo`, the address the account is moving to,
 *  worded as that. Throws when there is no address or they asked too often
 *  this hour. */
export async function sendEmailCode(ctx: MutationCtx, user: Doc<"users">, movingTo?: string): Promise<{ sent_to: string }> {
  const email = movingTo ?? user.email;
  if (!email) refuse("This account has no email address to confirm");
  const limit = await bumpWindow(ctx.db, `work-email-code:${user._id}`, CODES_PER_HOUR, 60 * 60 * 1000);
  if (!limit.ok) refuse("Too many codes this hour, try again later");
  const code = sixDigits();
  const row = { user_id: user._id, email, code_hash: await sha256(code), expires_at: Date.now() + CODE_TTL_MS, attempts: 0 };
  const existing = await codeRow(ctx, user);
  if (existing) await ctx.db.patch(existing._id, row);
  else await ctx.db.insert("work_email_codes", row);
  await ctx.scheduler.runAfter(0, internal.teamDiscovery.deliverWorkEmailCode, { email, code, ...(movingTo ? { moving: true } : {}) });
  return { sent_to: email };
}

/** What entering a code came to. A wrong code is returned, never thrown: see
 *  the header. */
export type CodeCheck = { ok: true } | { ok: false; message: string };

/** Spends the code this person was mailed at `email`. Throws when there is
 *  no usable code for that address (none, another address's, expired, out of
 *  tries); returns the failed check, with the try counted, when the digits
 *  are wrong. */
export async function redeemEmailCode(ctx: MutationCtx, user: Doc<"users">, email: string | undefined, code: string): Promise<CodeCheck> {
  const row = await codeRow(ctx, user);
  if (!row || !email || row.email !== email || Date.now() > row.expires_at) refuse("That code expired, send a new one");
  if (row.attempts >= MAX_CODE_ATTEMPTS) refuse("Too many tries, send a new code");
  if (row.code_hash !== (await sha256(code.trim()))) {
    await ctx.db.patch(row._id, { attempts: row.attempts + 1 });
    return { ok: false, message: "That code is not right" };
  }
  await ctx.db.delete(row._id);
  return { ok: true };
}

/** Proves the account email with the code it was sent. */
export async function confirmEmailCode(ctx: MutationCtx, user: Doc<"users">, code: string): Promise<CodeCheck> {
  const check = await redeemEmailCode(ctx, user, user.email, code);
  if (check.ok) await ctx.db.patch(user._id, { emailVerificationTime: Date.now() });
  return check;
}
