// Outbound email delivery. One send helper (Resend) + the internal actions
// that flows schedule. Templates live in emails/templates.ts; nothing here
// builds HTML.
//
// All sending is fire-and-forget from the caller's point of view: mutations
// schedule these actions with ctx.scheduler.runAfter(0, ...) so a Resend
// outage can never fail or slow a user-facing write.

import { v } from "convex/values";
import { resendTransportForBrand, senderAddress } from "@platform/email";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import { internalAction, mutation } from "../functions";
import { BRAND, type RenderedEmail } from "./render";
import {
  artifactComment,
  passwordChanged,
  teamInvite,
  welcome,
} from "./templates";

export const EMAIL_FROM = senderAddress(BRAND);

/**
 * Deliver a rendered email via Resend. `tag` labels the template in the
 * Resend dashboard so per-template deliverability is visible. `opts.headers`
 * carries per-message headers (List-Unsubscribe for the digest).
 *
 * The transport is @platform/email's: same HTTP call the resend SDK made, with
 * the key injected. It warns and skips when the key is absent, so auth and team
 * flows stay usable on dev deployments. The key is read per send, not at import,
 * because Convex actions get their env at run time.
 */
export async function deliver(
  to: string,
  email: RenderedEmail,
  tag: string,
  opts?: { headers?: Record<string, string> },
): Promise<void> {
  const transport = resendTransportForBrand(BRAND, process.env.RESEND_API_KEY);
  await transport.send({ to, ...email }, { tag, headers: opts?.headers });
}

// ---------------------------------------------------------------------------
// Internal actions (scheduled by mutations / auth callbacks)
// ---------------------------------------------------------------------------

export const sendWelcome = internalAction({
  args: { email: v.string(), name: v.optional(v.string()) },
  handler: async (_ctx, args) => {
    await deliver(args.email, welcome({ email: args.email, name: args.name }), "welcome");
  },
});

export const sendTeamInvite = internalAction({
  args: {
    to: v.string(),
    inviter_name: v.string(),
    inviter_email: v.optional(v.string()),
    team_name: v.string(),
    invite_url: v.string(),
    expires_at: v.optional(v.number()),
  },
  handler: async (_ctx, args) => {
    await deliver(
      args.to,
      teamInvite({
        inviterName: args.inviter_name,
        inviterEmail: args.inviter_email,
        teamName: args.team_name,
        inviteUrl: args.invite_url,
        expiresAt: args.expires_at,
      }),
      "team-invite",
    );
  },
});

export const sendPasswordChanged = internalAction({
  args: { email: v.string(), changed_at: v.number() },
  handler: async (_ctx, args) => {
    await deliver(
      args.email,
      passwordChanged({ email: args.email, changedAt: args.changed_at }),
      "password-changed",
    );
  },
});

/**
 * Available for the published-pages pipeline. Deliberately not auto-wired to
 * comment submission: comments already stream into the owner's live session,
 * and per-comment email without a notification preference would be spam.
 */
export const sendArtifactComment = internalAction({
  args: {
    to: v.string(),
    page_title: v.string(),
    page_url: v.string(),
    commenter_name: v.string(),
    comment_text: v.string(),
  },
  handler: async (_ctx, args) => {
    await deliver(
      args.to,
      artifactComment({
        pageTitle: args.page_title,
        pageUrl: args.page_url,
        commenterName: args.commenter_name,
        commentText: args.comment_text,
        ownerEmail: args.to,
      }),
      "artifact-comment",
    );
  },
});

// ---------------------------------------------------------------------------
// Client entry points
// ---------------------------------------------------------------------------

/**
 * Called by the reset-password page after a successful reset-verification.
 * Convex Auth's Password provider has no post-reset hook, so the client
 * reports completion; the mutation only ever emails the AUTHENTICATED user's
 * own address, so the worst a malicious caller can do is notify themselves.
 */
export const notifyPasswordChanged = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const user = await ctx.db.get(userId);
    if (!user?.email) return;
    await ctx.scheduler.runAfter(0, internal.emails.send.sendPasswordChanged, {
      email: user.email,
      changed_at: Date.now(),
    });
  },
});
