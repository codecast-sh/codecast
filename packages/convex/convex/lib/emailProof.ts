// Proving a signed-in person holds their account email: a six digit code
// mailed to the address, entered back here, sets `users.emailVerificationTime`
// (which lib/workDomain's emailProven reads). Password sign-up does not
// verify the address, so this is how such an account proves it later. Two
// callers: finding your team by work email (teamDiscovery.ts) and the Free
// allowance of the hosted assistant (assistant/freeGate.ts).
//
// One code per person at a time (work_email_codes), stored hashed, good for
// CODE_TTL_MS and MAX_CODE_ATTEMPTS tries, and at most CODES_PER_HOUR mailed.
// A refusal is a ConvexError carrying the sentence the person reads, which a
// production deployment passes through (a plain Error's message it hides).
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import { bumpWindow } from "../ipRateLimit";

export const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;

/** Hex SHA-256 of a code, as stored. */
async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

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

/** Mails a fresh code to the person's account email, replacing any earlier
 *  one. Throws when they have no address or asked too often this hour. */
export async function sendEmailCode(ctx: MutationCtx, user: Doc<"users">): Promise<{ sent_to: string }> {
  const email = user.email;
  if (!email) refuse("This account has no email address to confirm");
  const limit = await bumpWindow(ctx.db, `work-email-code:${user._id}`, CODES_PER_HOUR, 60 * 60 * 1000);
  if (!limit.ok) refuse("Too many codes this hour, try again later");
  const code = sixDigits();
  const row = { user_id: user._id, email, code_hash: await sha256(code), expires_at: Date.now() + CODE_TTL_MS, attempts: 0 };
  const existing = await codeRow(ctx, user);
  if (existing) await ctx.db.patch(existing._id, row);
  else await ctx.db.insert("work_email_codes", row);
  await ctx.scheduler.runAfter(0, internal.teamDiscovery.deliverWorkEmailCode, { email, code });
  return { sent_to: email };
}

/** Proves the account email with the code it was sent, or throws a sentence
 *  the person can act on. */
export async function confirmEmailCode(ctx: MutationCtx, user: Doc<"users">, code: string): Promise<void> {
  const row = await codeRow(ctx, user);
  if (!row || row.email !== user.email || Date.now() > row.expires_at) refuse("That code expired, send a new one");
  if (row.attempts >= MAX_CODE_ATTEMPTS) refuse("Too many tries, send a new code");
  if (row.code_hash !== (await sha256(code.trim()))) {
    await ctx.db.patch(row._id, { attempts: row.attempts + 1 });
    refuse("That code is not right");
  }
  await ctx.db.delete(row._id);
  await ctx.db.patch(user._id, { emailVerificationTime: Date.now() });
}
