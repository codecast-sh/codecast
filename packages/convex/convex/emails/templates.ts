// Every transactional email Codecast sends. The four that every product needs
// — verify, password reset, password changed, welcome — come from
// @platform/email bound to codecast's BRAND. The three below them are
// codecast's own: they name codecast products and routes, so they stay here and
// use the same block DSL through the bound renderer.
//
// Copy rules: subjects say what happened and name the product; one-time codes
// lead the subject so inbox previews and OTP autofill can pick them up; every
// email states in the footer why it was received; anything the user did NOT
// initiate says clearly what to do if it wasn't them.

import { createTemplates, type RenderedEmail } from "@platform/email";
import { BRAND, renderEmail, type EmailBlock } from "./render";

// ---------------------------------------------------------------------------
// Auth — the generic set, with codecast's brand and its own welcome copy
// ---------------------------------------------------------------------------

const templates = createTemplates(BRAND);

export const verifyEmail = templates.verifyEmail;
export const passwordReset = templates.passwordReset;
export const passwordChanged = templates.passwordChanged;

export function welcome(args: { email: string; name?: string }): RenderedEmail {
  return templates.welcome({
    email: args.email,
    name: args.name,
    subject: "Welcome to Codecast — your agents, on air",
    preheader: "Connect your machine and every coding agent session lands in one inbox.",
    heading: "You're on the air",
    intro:
      "Codecast is mission control for your coding agents: every Claude Code and Codex session on your machines streams into one live inbox, where you can read, steer, and hand off work from anywhere.",
    blocks: [
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
    ],
    cta: { label: "Open your inbox", url: `${BRAND.url}/inbox` },
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
// Notification digest ("while you were away")
// ---------------------------------------------------------------------------

/** One entry in the digest, fully materialized by emails/digest.ts. */
export interface DigestEntry {
  /** Bold-marked title line, e.g. "**Grace** mentioned you". */
  title: string;
  /** Muted excerpt under the title (comment text, question, preview). */
  excerpt?: string;
  /** Absolute URL into the app. */
  url: string;
  linkLabel?: string;
}

export interface DigestSection {
  /** Section heading, e.g. "Decisions waiting on you". */
  heading: string;
  entries: DigestEntry[];
}

export function notificationDigest(args: {
  subject: string;
  preheader: string;
  sections: DigestSection[];
  /** Items beyond the render cap: "…and N more in the app". */
  moreCount: number;
  settingsUrl: string;
  unsubscribeUrl: string;
}): RenderedEmail {
  const blocks: EmailBlock[] = [];
  for (let i = 0; i < args.sections.length; i++) {
    const section = args.sections[i];
    if (i > 0) blocks.push({ kind: "divider" });
    blocks.push({ kind: "subheading", value: section.heading });
    for (const e of section.entries) {
      blocks.push({
        kind: "item",
        title: e.title,
        excerpt: e.excerpt,
        url: e.url,
        linkLabel: e.linkLabel,
      });
    }
  }
  if (args.moreCount > 0) {
    blocks.push({
      kind: "note",
      value: `…and ${args.moreCount} more waiting in [your inbox](${BRAND.url}/notifications).`,
    });
  }
  blocks.push({ kind: "button", label: "Open Codecast", url: `${BRAND.url}/inbox` });
  return renderEmail({
    subject: args.subject,
    preheader: args.preheader,
    eyebrow: "while you were away",
    heading: "Since you've been gone",
    blocks,
    reason: `You received this because these were waiting unseen in your Codecast inbox. [Email settings](${args.settingsUrl}) · [Unsubscribe](${args.unsubscribeUrl})`,
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
