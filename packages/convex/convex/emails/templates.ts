// Every transactional email Codecast sends, defined as data and rendered by
// emails/render.ts. Each factory returns {subject, html, text}.
//
// Copy rules: subjects say what happened and name the product; one-time codes
// lead the subject so inbox previews and OTP autofill can pick them up; every
// email states in the footer why it was received; anything the user did NOT
// initiate says clearly what to do if it wasn't them.

import { BRAND, renderEmail, type RenderedEmail } from "./render";

const OTP_EXPIRY_MINUTES = 15;

function formatWhen(timestampMs: number): string {
  // A fixed, unambiguous format — security notices must read the same in
  // every locale the email lands in.
  const d = new Date(timestampMs);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function verifyEmail(args: { code: string; email: string }): RenderedEmail {
  return renderEmail({
    subject: `${args.code} is your Codecast verification code`,
    preheader: `Enter this code to confirm ${args.email}. It expires in ${OTP_EXPIRY_MINUTES} minutes.`,
    eyebrow: "verify your email",
    heading: "Confirm your email address",
    blocks: [
      {
        kind: "text",
        value: `Enter this code to finish creating your Codecast account for **${args.email}**.`,
      },
      {
        kind: "code",
        code: args.code,
        hint: `expires in ${OTP_EXPIRY_MINUTES} minutes`,
      },
      {
        kind: "note",
        value:
          "Didn't create a Codecast account? You can safely ignore this email — nothing happens without the code.",
      },
    ],
    reason: `You received this email because ${args.email} was used to sign up at codecast.sh.`,
  });
}

export function passwordReset(args: { code: string; email: string }): RenderedEmail {
  return renderEmail({
    subject: "Reset your Codecast password",
    preheader: `Your reset code is ${args.code}. It expires in ${OTP_EXPIRY_MINUTES} minutes.`,
    eyebrow: "password reset",
    heading: "Reset your password",
    blocks: [
      {
        kind: "text",
        value: `We received a request to reset the password for **${args.email}**. Enter this code to choose a new one.`,
      },
      {
        kind: "code",
        code: args.code,
        hint: `expires in ${OTP_EXPIRY_MINUTES} minutes`,
      },
      {
        kind: "note",
        value:
          "Didn't request this? Ignore this email — your password stays unchanged unless the code is used.",
      },
    ],
    reason: `You received this email because a password reset was requested for ${args.email} at codecast.sh.`,
  });
}

export function passwordChanged(args: { email: string; changedAt: number }): RenderedEmail {
  return renderEmail({
    subject: "Your Codecast password was changed",
    preheader: "If this was you, no action is needed.",
    eyebrow: "security",
    heading: "Your password was changed",
    blocks: [
      {
        kind: "text",
        value: "The password for your Codecast account was just changed.",
      },
      {
        kind: "meta",
        rows: [
          { label: "account", value: args.email },
          { label: "when", value: formatWhen(args.changedAt) },
        ],
      },
      {
        kind: "text",
        value: "If this was you, no action is needed.",
      },
      {
        kind: "text",
        value: `If this **wasn't** you, someone else may have access to your account. Reset your password now and email us at [${BRAND.supportEmail}](https://codecast.sh/support).`,
      },
      { kind: "button", label: "Secure my account", url: `${BRAND.url}/forgot-password` },
    ],
    reason: `You received this security notice because the password for ${args.email} was changed at codecast.sh.`,
  });
}

export function welcome(args: { email: string; name?: string }): RenderedEmail {
  const greeting = args.name?.trim() ? `Welcome, ${args.name.trim()}.` : "Welcome.";
  return renderEmail({
    subject: "Welcome to Codecast — your agents, on air",
    preheader: "Connect your machine and every coding agent session lands in one inbox.",
    eyebrow: "welcome",
    heading: "You're on the air",
    blocks: [
      {
        kind: "text",
        value: `${greeting} Codecast is mission control for your coding agents: every Claude Code and Codex session on your machines streams into one live inbox, where you can read, steer, and hand off work from anywhere.`,
      },
      {
        kind: "text",
        value: "Connect your first machine — one command, about a minute:",
      },
      {
        kind: "terminal",
        lines: [
          { text: "curl -fsSL codecast.sh/install | sh", prompt: true },
          { text: "cast", prompt: true },
          { text: "# your sessions appear at codecast.sh/inbox", muted: true },
        ],
      },
      {
        kind: "text",
        value:
          "From there: search every past session like a shared memory, message any running agent, publish pages and dashboards straight from a conversation, and invite your team to see it all live.",
      },
      { kind: "button", label: "Open your inbox", url: `${BRAND.url}/inbox` },
      {
        kind: "note",
        value: `Questions? Just reply — or write [${BRAND.supportEmail}](https://codecast.sh/support). A human reads every message.`,
      },
    ],
    reason: `You received this one-time email because ${args.email} created a Codecast account.`,
  });
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export function teamInvite(args: {
  inviterName: string;
  inviterEmail?: string;
  teamName: string;
  inviteUrl: string;
  expiresAt?: number;
}): RenderedEmail {
  const inviter = args.inviterEmail
    ? `**${args.inviterName}** (${args.inviterEmail})`
    : `**${args.inviterName}**`;
  const expiryDays = args.expiresAt
    ? Math.max(1, Math.round((args.expiresAt - Date.now()) / (24 * 60 * 60 * 1000)))
    : undefined;
  return renderEmail({
    subject: `${args.inviterName} invited you to ${args.teamName} on Codecast`,
    preheader: `Join ${args.teamName} to see your team's coding agents work live.`,
    eyebrow: "team invite",
    heading: `Join ${args.teamName} on Codecast`,
    blocks: [
      {
        kind: "text",
        value: `${inviter} invited you to join **${args.teamName}** on Codecast — mission control for your team's coding agents. See teammates' live sessions, search a shared memory of past work, and steer agents together.`,
      },
      { kind: "button", label: "Accept invite", url: args.inviteUrl },
      { kind: "linkFallback", url: args.inviteUrl },
      {
        kind: "note",
        value: expiryDays
          ? `This invite link expires in ${expiryDays} day${expiryDays === 1 ? "" : "s"}. New to Codecast? The same link lets you create an account first.`
          : "New to Codecast? The same link lets you create an account first.",
      },
    ],
    reason: `You received this email because ${args.inviterName} invited you to a team at codecast.sh. Not expecting it? You can safely ignore it.`,
  });
}

// ---------------------------------------------------------------------------
// Published pages
// ---------------------------------------------------------------------------

export function artifactComment(args: {
  pageTitle: string;
  pageUrl: string;
  commenterName: string;
  commentText: string;
  ownerEmail: string;
}): RenderedEmail {
  // Long comments get trimmed — the email is a notification, not the thread.
  const excerpt =
    args.commentText.length > 400 ? `${args.commentText.slice(0, 400)}…` : args.commentText;
  return renderEmail({
    subject: `New comment on "${args.pageTitle}"`,
    preheader: `${args.commenterName}: ${excerpt.slice(0, 90)}`,
    eyebrow: "published page",
    heading: `New comment on ${args.pageTitle}`,
    blocks: [
      { kind: "quote", value: excerpt, by: args.commenterName },
      { kind: "button", label: "View & reply", url: args.pageUrl },
      { kind: "linkFallback", url: args.pageUrl },
    ],
    reason: `You received this email because you own this published page on codecast.sh.`,
  });
}
