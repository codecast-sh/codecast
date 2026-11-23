// Moving an account to a new sign-in address (Settings → Accounts).
//
// `users.email` was written once, by the first sign-in, and nothing rewrote
// it: someone who joined on a former company's address stayed on it, and
// everything read off the primary stayed there with them, the domain their
// team opens to coworkers (teamDiscovery.ts) first of all.
//
// The move is two steps, ask and confirm, and these rules carry it:
// - The new address is proven before anything moves: a code mailed to it,
//   entered back here (lib/emailProof). The address is then as good as one a
//   sign-in provider vouched for, so the account is stamped verified, which is
//   what lets a later Google or GitHub sign-in at that address land on this
//   account rather than a second one (@platform/auth's createOrUpdateUser).
// - A browser session only. An api token cannot ask: a leaked CLI token that
//   could move the address could then reset the password to it.
// - One account per address. An address another account signs in with is
//   refused, when asked and again when the code is entered.
// - The address it left stays on the account as an other address
//   (users.alternate_emails), so whatever resolves a person by email (a Slack
//   line, a task assignee, old commits) keeps finding them.
// - A password sign-in under the old address follows to the new one, so the
//   address a person types and the one a reset code goes to are the address
//   the account shows.
// - The old address is told, since it is the one mailbox a person who did not
//   do this still reads.
//
// Nothing else moves. A team already open to the old address's domain stays
// open to it until an admin switches it (teamDiscovery.setDiscoverable): who
// can find a team is the team's setting, not a side effect of one admin's
// account.
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { redeemEmailCode, sendEmailCode } from "./lib/emailProof";
import { siteUrl } from "./lib/siteUrl";

function refuse(message: string): never {
  throw new ConvexError({ message });
}

function normalize(raw: string | undefined | null): string {
  return String(raw ?? "").trim().toLowerCase();
}

async function me(ctx: MutationCtx): Promise<Doc<"users">> {
  const userId = await getAuthUserId(ctx);
  const user = userId ? await ctx.db.get(userId) : null;
  if (!user) throw new Error("Not authenticated");
  return user;
}

/** Throws the sentence to show unless `email` can become this person's
 *  sign-in address. */
async function assertCanMoveTo(ctx: Pick<MutationCtx, "db">, user: Doc<"users">, email: string): Promise<void> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) refuse("That does not look like an email address");
  if (normalize(user.email) === email) refuse("That is already your sign-in address");
  const taken = "Another account already signs in with that address";
  const owners = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).collect();
  if (owners.some((owner) => owner._id !== user._id)) refuse(taken);
  const login = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", email))
    .first();
  if (login && login.userId !== user._id) refuse(taken);
}

/** Step one: mail a code to the address the account should move to. */
export const requestEmailChange = mutation({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<{ sent_to: string }> => {
    const user = await me(ctx);
    const email = normalize(args.email);
    await assertCanMoveTo(ctx, user, email);
    return await sendEmailCode(ctx, user, email);
  },
});

/** Step two: the code proves the address, and the account moves to it. A
 *  wrong code comes back as `changed: false` with the sentence to show, so
 *  the try it cost is kept (lib/emailProof). */
export const confirmEmailChange = mutation({
  args: { email: v.string(), code: v.string() },
  handler: async (ctx, args): Promise<{ changed: true; email: string } | { changed: false; error: string }> => {
    const user = await me(ctx);
    const email = normalize(args.email);
    const check = await redeemEmailCode(ctx, user, email, args.code);
    if (!check.ok) return { changed: false, error: check.message };
    // Asked again: another account may have taken the address since the code went out.
    await assertCanMoveTo(ctx, user, email);

    const previous = normalize(user.email);
    const others = (user.alternate_emails ?? []).map(normalize).filter((other) => other && other !== email);
    if (previous && !others.includes(previous)) others.push(previous);
    const now = Date.now();
    await ctx.db.patch(user._id, { email, emailVerificationTime: now, alternate_emails: others });

    if (previous) {
      const logins = await ctx.db
        .query("authAccounts")
        .withIndex("userIdAndProvider", (q) => q.eq("userId", user._id).eq("provider", "password"))
        .collect();
      for (const login of logins) {
        if (normalize(login.providerAccountId) !== previous) continue;
        await ctx.db.patch(login._id, { providerAccountId: email, emailVerified: email });
      }
      await ctx.scheduler.runAfter(0, internal.emails.send.sendEmailChanged, {
        old_email: previous,
        new_email: email,
        changed_at: now,
        settings_url: `${siteUrl()}/settings/accounts`,
      });
    }
    return { changed: true, email };
  },
});
