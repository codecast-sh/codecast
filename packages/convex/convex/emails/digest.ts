// "While you were away" email digest.
//
// A 10-minute cron sweep finds people with DIRECT, PERSONAL items sitting
// unseen — a mention, a comment, chat aimed at them, work handed to them, an
// agent blocked on a `cast decide` — and sends ONE email batching all of it.
// Session-state noise (idle / error / permission) is structurally excluded.
//
// Suppression, in order:
//  - only notification types in EMAIL_WORTHY (a row's existence already means
//    the in-app preference allowed it — muted types are never inserted)
//  - master switch notification_preferences.email_notifications (absent = on)
//  - presence: skip anyone with keyboard input in the last ACTIVE_MS — they
//    are at the desk, the bell and toasts cover it
//  - grace: an item must sit unread for GRACE_MS before it can trigger email,
//    giving the app and push their chance first
//  - cooldown: at most one digest per COOLDOWN_MS; items are never re-emailed
//    (only items created after email_digest_last_sent_at are included)

import { v } from "convex/values";
import { alphabet, generateRandomString } from "oslo/crypto";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation } from "../functions";
import { MAX_CHANNELS_PER_TEAM, UNREAD_CAP, plainPreview } from "../chatText";
import { deliver } from "./send";
import { notificationDigest, type DigestEntry, type DigestSection } from "./templates";
import { BRAND } from "./render";

export const GRACE_MS = 10 * 60 * 1000;
export const WINDOW_MS = 45 * 60 * 1000;
export const COOLDOWN_MS = 30 * 60 * 1000;
export const ACTIVE_MS = 15 * 60 * 1000;
/** Never reach further back than this, even for a first-ever digest. */
export const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Bound one sweep's work; the next sweep picks up the rest. */
const MAX_USERS_PER_SWEEP = 100;
const MAX_ENTRIES_PER_SECTION = 6;

/** Direct, personal notification types. Everything else never emails. */
export const EMAIL_WORTHY = new Set([
  "mention",
  "comment_reply",
  "conversation_comment",
  "task_commented",
  "doc_commented",
  "artifact_commented",
  "chat_mention",
  "chat_reply",
  "chat_here",
  "task_assigned",
  "session_assigned",
  "team_invite",
]);

// ---------------------------------------------------------------------------
// Pure helpers (unit tested in digest.test.ts)
// ---------------------------------------------------------------------------

export function digestEligible(args: {
  emailPref: boolean | undefined;
  lastSentAt: number | undefined;
  lastInputAt: number | undefined;
  now: number;
}): { send: boolean; reason: string } {
  if (args.emailPref === false) return { send: false, reason: "unsubscribed" };
  if (args.lastInputAt !== undefined && args.now - args.lastInputAt < ACTIVE_MS) {
    return { send: false, reason: "active" };
  }
  if (args.lastSentAt !== undefined && args.now - args.lastSentAt < COOLDOWN_MS) {
    return { send: false, reason: "cooldown" };
  }
  return { send: true, reason: "ok" };
}

const TITLE_BY_TYPE: Record<string, string> = {
  mention: "mentioned you",
  comment_reply: "replied to your comment",
  conversation_comment: "commented on a session",
  task_commented: "commented on a task",
  doc_commented: "commented on a doc",
  artifact_commented: "commented on your published page",
  chat_mention: "mentioned you in chat",
  chat_reply: "replied in a thread",
  chat_here: "pinged @here",
  task_assigned: "assigned you a task",
  session_assigned: "assigned you a session",
  team_invite: "invited you to a team",
};

/** Mirror of web lib/notificationTypes.ts notificationRoute, as absolute URLs. */
export function entityUrl(
  siteUrl: string,
  n: {
    link?: string;
    entity_type?: string;
    entity_id?: string;
    chat_message_id?: string;
    conversation_id?: string;
  },
): string {
  if (n.link) return n.link;
  const simple: Record<string, string> = { task: "/tasks/", doc: "/docs/", plan: "/plans/" };
  if (n.entity_type && n.entity_id) {
    if (simple[n.entity_type]) return `${siteUrl}${simple[n.entity_type]}${n.entity_id}`;
    if (n.entity_type === "chat_channel") {
      const m = n.chat_message_id ? `?m=${n.chat_message_id}` : "";
      return `${siteUrl}/chat/${n.entity_id}${m}`;
    }
  }
  if (n.conversation_id) return `${siteUrl}/conversation/${n.conversation_id}`;
  return `${siteUrl}/notifications`;
}

export function notificationEntry(
  siteUrl: string,
  n: {
    type: string;
    message: string;
    actor?: string;
    link?: string;
    entity_type?: string;
    entity_id?: string;
    chat_message_id?: string;
    conversation_id?: string;
  },
): DigestEntry {
  const action = TITLE_BY_TYPE[n.type] ?? "sent you an update";
  return {
    title: `**${n.actor ?? "Someone"}** ${action}`,
    excerpt: n.message.length > 240 ? `${n.message.slice(0, 240)}…` : n.message,
    url: entityUrl(siteUrl, n),
  };
}

export function digestSubject(args: {
  blockingDecisions: number;
  advisoryDecisions: number;
  firstPersonalTitle?: string;
  personalCount: number;
  chatChannels: string[];
  chatCount: number;
}): { subject: string; preheader: string } {
  const parts: string[] = [];
  const decisions = args.blockingDecisions + args.advisoryDecisions;
  if (decisions > 0) parts.push(`${decisions} decision${decisions === 1 ? "" : "s"}`);
  if (args.personalCount > 0)
    parts.push(`${args.personalCount} mention${args.personalCount === 1 ? "" : "s"} & comments`);
  if (args.chatCount > 0) parts.push(`${args.chatCount} chat messages`);
  const preheader = `Waiting for you: ${parts.join(" · ")}.`;

  if (args.blockingDecisions > 0) {
    return {
      subject:
        args.blockingDecisions === 1
          ? "An agent is blocked on your decision"
          : `${args.blockingDecisions} agents are blocked on your decisions`,
      preheader,
    };
  }
  if (args.advisoryDecisions > 0) {
    return { subject: "An agent asked for your input", preheader };
  }
  if (args.firstPersonalTitle) {
    const lead = args.firstPersonalTitle.replace(/\*\*/g, "");
    const rest = args.personalCount + args.chatCount - 1;
    return {
      subject: rest > 0 ? `${lead} — and ${rest} more` : `${lead} on Codecast`,
      preheader,
    };
  }
  const chan = args.chatChannels[0] ? `#${args.chatChannels[0]}` : "team chat";
  return {
    subject: `${args.chatCount} unread message${args.chatCount === 1 ? "" : "s"} in ${chan}`,
    preheader,
  };
}

/** chat.ts channel-unread rules: no tombstones, not mine, channel level only. */
export function countableChatMessage(
  row: { deleted_at?: number; user_id: { toString(): string }; thread_root_id?: unknown },
  userId: string,
): boolean {
  return !row.deleted_at && row.user_id.toString() !== userId && row.thread_root_id === undefined;
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

function siteUrl(): string {
  return (process.env.SITE_URL ?? BRAND.url).replace(/\/$/, "");
}

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const from = now - WINDOW_MS;
    const to = now - GRACE_MS;

    // Candidates: anyone with an email-worthy unread notification, or a
    // pending decision, created inside [from, to].
    const recentNotifs = await ctx.db
      .query("notifications")
      .withIndex("by_created", (q) => q.gte("created_at", from).lte("created_at", to))
      .collect();
    const recentDecisions = await ctx.db
      .query("session_decisions")
      .withIndex("by_status_created", (q) =>
        q.eq("status", "pending").gte("created_at", from).lte("created_at", to),
      )
      .collect();

    const candidates = new Set<string>();
    for (const n of recentNotifs) {
      if (!n.read && EMAIL_WORTHY.has(n.type)) candidates.add(n.recipient_user_id.toString());
    }
    for (const d of recentDecisions) candidates.add(d.user_id.toString());

    let sent = 0;
    for (const userIdStr of [...candidates].slice(0, MAX_USERS_PER_SWEEP)) {
      const userId = userIdStr as Id<"users">;
      const user = await ctx.db.get(userId);
      if (!user?.email) continue;

      // Presence: freshest human input across surfaces.
      const presenceRows = await ctx.db
        .query("user_presence")
        .withIndex("by_user", (q) => q.eq("user_id", userId))
        .collect();
      const lastInputAt = presenceRows.length
        ? Math.max(...presenceRows.map((p) => p.last_input_at))
        : undefined;

      const eligibility = digestEligible({
        emailPref: user.notification_preferences?.email_notifications,
        lastSentAt: user.email_digest_last_sent_at,
        lastInputAt,
        now,
      });
      if (!eligibility.send) continue;

      const digest = await buildDigestForUser(ctx, user, now);
      if (!digest) continue;

      let token = user.email_unsub_token;
      if (!token) {
        token = generateRandomString(32, alphabet("a-z", "0-9"));
        await ctx.db.patch(userId, { email_unsub_token: token });
      }
      await ctx.db.patch(userId, { email_digest_last_sent_at: now });

      await ctx.scheduler.runAfter(0, internal.emails.digest.sendDigest, {
        to: user.email,
        subject: digest.subject,
        preheader: digest.preheader,
        sections: digest.sections,
        more_count: digest.moreCount,
        unsub_token: token,
      });
      sent++;
    }
    return { candidates: candidates.size, sent };
  },
});

async function buildDigestForUser(
  ctx: { db: any },
  user: Doc<"users">,
  now: number,
): Promise<{
  subject: string;
  preheader: string;
  sections: DigestSection[];
  moreCount: number;
} | null> {
  const base = siteUrl();
  const since = Math.max(user.email_digest_last_sent_at ?? 0, now - MAX_LOOKBACK_MS);
  const cutoff = now - GRACE_MS;

  // --- Unread email-worthy notifications since the last digest ---
  const notifRows: Doc<"notifications">[] = await ctx.db
    .query("notifications")
    .withIndex("by_recipient_created", (q: any) =>
      q.eq("recipient_user_id", user._id).gt("created_at", since),
    )
    .collect();
  const worthy = notifRows.filter(
    (n) => !n.read && n.created_at <= cutoff && EMAIL_WORTHY.has(n.type),
  );

  // Resolve actor display names (actor_name is the snapshot fallback).
  const actorNames = new Map<string, string>();
  for (const n of worthy) {
    const key = n.actor_user_id?.toString();
    if (!key || actorNames.has(key)) continue;
    const actor = await ctx.db.get(n.actor_user_id);
    actorNames.set(key, actor?.name || actor?.github_username || "Someone");
  }
  const toEntry = (n: Doc<"notifications">): DigestEntry =>
    notificationEntry(base, {
      type: n.type,
      message: n.message,
      actor: n.actor_user_id
        ? actorNames.get(n.actor_user_id.toString())
        : (n.actor_name ?? undefined),
      link: n.link,
      entity_type: n.entity_type,
      entity_id: n.entity_id,
      chat_message_id: n.chat_message_id?.toString(),
      conversation_id: n.conversation_id?.toString(),
    });

  const personalTypes = new Set([
    "mention",
    "comment_reply",
    "conversation_comment",
    "task_commented",
    "doc_commented",
    "artifact_commented",
    "chat_mention",
    "chat_reply",
    "chat_here",
  ]);
  const personal = worthy.filter((n) => personalTypes.has(n.type));
  const handed = worthy.filter((n) => !personalTypes.has(n.type));

  // --- Pending decisions (cast decide) ---
  const pendingDecisions: Doc<"session_decisions">[] = await ctx.db
    .query("session_decisions")
    .withIndex("by_user_status", (q: any) => q.eq("user_id", user._id).eq("status", "pending"))
    .collect();
  const newDecisions = pendingDecisions.filter(
    (d) => d.created_at > since && d.created_at <= cutoff,
  );
  const olderPending = pendingDecisions.filter((d) => d.created_at <= since).length;

  // --- Plain unread chat, using chat.ts's own counting rules ---
  const chatLines: DigestEntry[] = [];
  const chatChannels: string[] = [];
  let chatCount = 0;
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", user._id))
    .collect();
  for (const membership of memberships.slice(0, 5)) {
    const channels = await ctx.db
      .query("chat_channels")
      .withIndex("by_team_name", (q: any) => q.eq("team_id", membership.team_id))
      .take(MAX_CHANNELS_PER_TEAM);
    for (const channel of channels) {
      // No read row = never opened the channel = mentions-only semantics
      // (mirrors listChannels). Mentions arrive as notification rows anyway.
      const read = await ctx.db
        .query("chat_reads")
        .withIndex("by_user_channel", (q: any) =>
          q.eq("user_id", user._id).eq("channel_id", channel._id),
        )
        .first();
      if (!read) continue;
      const floor = Math.max(read.last_read_at, since);
      const rows: Doc<"chat_messages">[] = await ctx.db
        .query("chat_messages")
        .withIndex("by_channel_created", (q: any) =>
          q.eq("channel_id", channel._id).gt("created_at", floor),
        )
        .take(UNREAD_CAP * 2 + 1);
      const counted = rows.filter(
        (r) => countableChatMessage(r, user._id.toString()) && r.created_at <= cutoff,
      );
      if (counted.length === 0) continue;
      const capped = counted.length > UNREAD_CAP;
      const shown = Math.min(counted.length, UNREAD_CAP);
      const newest = counted[counted.length - 1];
      chatCount += shown;
      chatChannels.push(channel.name);
      chatLines.push({
        title: `**#${channel.name}** — ${shown}${capped ? "+" : ""} unread message${shown === 1 ? "" : "s"}`,
        excerpt: plainPreview(newest.content, 120),
        url: `${base}/chat/${channel._id}`,
        linkLabel: "Open channel",
      });
    }
  }

  if (
    personal.length === 0 &&
    handed.length === 0 &&
    newDecisions.length === 0 &&
    chatLines.length === 0
  ) {
    return null;
  }

  const sections: DigestSection[] = [];
  let moreCount = 0;
  const capped = <T>(items: T[]): T[] => {
    moreCount += Math.max(0, items.length - MAX_ENTRIES_PER_SECTION);
    return items.slice(0, MAX_ENTRIES_PER_SECTION);
  };

  if (newDecisions.length > 0 || olderPending > 0) {
    const entries = capped(newDecisions).map(
      (d): DigestEntry => ({
        title: `**${d.question}**`,
        excerpt: d.context_md
          ? plainPreview(d.context_md, 200)
          : d.options.map((o) => o.label).join(" / "),
        url: `${base}/conversation/${d.conversation_id}`,
        linkLabel: d.blocking ? "Answer — the agent is parked on this" : "Review",
      }),
    );
    if (olderPending > 0) {
      entries.push({
        title: `…and **${olderPending}** older decision${olderPending === 1 ? "" : "s"} still waiting`,
        url: `${base}/inbox`,
        linkLabel: "Open queue",
      });
    }
    sections.push({ heading: "Decisions waiting on you", entries });
  }
  if (personal.length > 0) {
    sections.push({ heading: "Mentions & comments", entries: capped(personal).map(toEntry) });
  }
  if (handed.length > 0) {
    sections.push({ heading: "Handed to you", entries: capped(handed).map(toEntry) });
  }
  if (chatLines.length > 0) {
    sections.push({ heading: "Unread chat", entries: capped(chatLines) });
  }

  const { subject, preheader } = digestSubject({
    blockingDecisions: newDecisions.filter((d) => d.blocking).length,
    advisoryDecisions: newDecisions.filter((d) => !d.blocking).length,
    firstPersonalTitle: personal[0] ? toEntry(personal[0]).title : undefined,
    personalCount: personal.length + handed.length,
    chatChannels,
    chatCount,
  });
  return { subject, preheader, sections, moreCount };
}

// ---------------------------------------------------------------------------
// Delivery + unsubscribe
// ---------------------------------------------------------------------------

const ENTRY_VALIDATOR = v.object({
  title: v.string(),
  excerpt: v.optional(v.string()),
  url: v.string(),
  linkLabel: v.optional(v.string()),
});

export const sendDigest = internalAction({
  args: {
    to: v.string(),
    subject: v.string(),
    preheader: v.string(),
    sections: v.array(v.object({ heading: v.string(), entries: v.array(ENTRY_VALIDATOR) })),
    more_count: v.number(),
    unsub_token: v.string(),
  },
  handler: async (_ctx, args) => {
    const base = siteUrl();
    // The unsubscribe endpoint lives on the CONVEX deployment's HTTP router
    // (under /cli/ — the only prefix Caddy forwards to HTTP actions).
    const convexSite = (process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
    const unsubUrl = `${convexSite || base}/cli/email/unsubscribe?token=${args.unsub_token}`;
    const email = notificationDigest({
      subject: args.subject,
      preheader: args.preheader,
      sections: args.sections,
      moreCount: args.more_count,
      settingsUrl: `${base}/settings/notifications`,
      unsubscribeUrl: unsubUrl,
    });
    await deliver(args.to, email, "digest", {
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
  },
});

export const unsubscribeByToken = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    if (args.token.length < 16) return { ok: false };
    const user = await ctx.db
      .query("users")
      .withIndex("by_email_unsub_token", (q) => q.eq("email_unsub_token", args.token))
      .first();
    if (!user) return { ok: false };
    await ctx.db.patch(user._id, {
      notification_preferences: {
        ...(user.notification_preferences ?? {
          team_session_start: true,
          mention: true,
          permission_request: true,
        }),
        email_notifications: false,
      },
    });
    return { ok: true };
  },
});
