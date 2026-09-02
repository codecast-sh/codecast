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
import {
  DEFAULT_DIGEST_POLICY,
  createEntryCapper,
  listUnsubscribeHeaders,
  runDigestSweep,
  unsubscribeByToken as unsubscribeWithHooks,
  type DigestRecipient,
} from "@platform/email";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation } from "../functions";
import { MAX_CHANNELS_PER_TEAM, UNREAD_CAP, plainPreview } from "../chatText";
import { deliver } from "./send";
import { notificationDigest, type DigestEntry, type DigestSection } from "./templates";
import { BRAND } from "./render";

// The scheduling policy — grace, window, cooldown, presence, lookback, the
// per-sweep and per-section caps, the sweep loop, the unsubscribe token and its
// one-click headers — lives in @platform/email, which this file was extracted
// from. The constants and the eligibility rule are re-exported so callers and
// tests keep importing them from here. Everything below is codecast's: which
// notification types are worth an email, how a row becomes a digest entry, and
// where each entry links.
export {
  ACTIVE_MS,
  COOLDOWN_MS,
  GRACE_MS,
  MAX_LOOKBACK_MS,
  WINDOW_MS,
  digestEligible,
} from "@platform/email";

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
  "chat_dm",
  "chat_added",
  "task_assigned",
  "session_assigned",
  "team_invite",
]);

// ---------------------------------------------------------------------------
// Pure helpers (unit tested in digest.test.ts)
// ---------------------------------------------------------------------------

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
  chat_dm: "sent you a direct message",
  chat_added: "added you to a channel",
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

/** The digest body the sweep builds and the delivery action renders. */
type Digest = {
  subject: string;
  preheader: string;
  sections: DigestSection[];
  moreCount: number;
};

export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    // The loop, the eligibility rule and the caps are @platform/email's; every
    // read and write below is codecast's.
    return await runDigestSweep<Digest>(
      {
        // Candidates: anyone with an email-worthy unread notification, or a
        // pending decision, created inside the sweep window.
        async candidates({ from, to }) {
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

          const ids: string[] = [];
          for (const n of recentNotifs) {
            if (!n.read && EMAIL_WORTHY.has(n.type)) ids.push(n.recipient_user_id.toString());
          }
          for (const d of recentDecisions) ids.push(d.user_id.toString());
          return ids;
        },

        async recipient(id) {
          const userId = id as Id<"users">;
          const user = await ctx.db.get(userId);
          if (!user?.email) return null;

          // Presence: freshest human input across surfaces.
          const presenceRows = await ctx.db
            .query("user_presence")
            .withIndex("by_user", (q) => q.eq("user_id", userId))
            .collect();
          return {
            id,
            email: user.email,
            emailPref: user.notification_preferences?.email_notifications,
            lastSentAt: user.email_digest_last_sent_at,
            lastInputAt: presenceRows.length
              ? Math.max(...presenceRows.map((p) => p.last_input_at))
              : undefined,
            unsubToken: user.email_unsub_token,
          };
        },

        build: (recipient, range) => buildDigestForUser(ctx, recipient.id as Id<"users">, range),

        async saveToken(id, token) {
          await ctx.db.patch(id as Id<"users">, { email_unsub_token: token });
        },

        async markSent(id, now) {
          await ctx.db.patch(id as Id<"users">, { email_digest_last_sent_at: now });
        },

        async send(recipient: DigestRecipient, digest: Digest, unsubToken: string) {
          await ctx.scheduler.runAfter(0, internal.emails.digest.sendDigest, {
            to: recipient.email!,
            subject: digest.subject,
            preheader: digest.preheader,
            sections: digest.sections,
            more_count: digest.moreCount,
            unsub_token: unsubToken,
          });
        },
      },
      Date.now(),
    );
  },
});

async function buildDigestForUser(
  ctx: { db: any },
  userId: Id<"users">,
  { since, cutoff }: { since: number; cutoff: number },
): Promise<Digest | null> {
  const base = siteUrl();

  // --- Unread email-worthy notifications since the last digest ---
  const notifRows: Doc<"notifications">[] = await ctx.db
    .query("notifications")
    .withIndex("by_recipient_created", (q: any) =>
      q.eq("recipient_user_id", userId).gt("created_at", since),
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
    "chat_dm",
    "chat_added",
  ]);
  const personal = worthy.filter((n) => personalTypes.has(n.type));
  const handed = worthy.filter((n) => !personalTypes.has(n.type));

  // --- Pending decisions (cast decide) ---
  const pendingDecisions: Doc<"session_decisions">[] = await ctx.db
    .query("session_decisions")
    .withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", "pending"))
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
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
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
          q.eq("user_id", userId).eq("channel_id", channel._id),
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
        (r) => countableChatMessage(r, userId.toString()) && r.created_at <= cutoff,
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
  const cap = createEntryCapper(DEFAULT_DIGEST_POLICY.maxEntriesPerSection);

  if (newDecisions.length > 0 || olderPending > 0) {
    const entries = cap.take(newDecisions).map(
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
    sections.push({ heading: "Mentions & comments", entries: cap.take(personal).map(toEntry) });
  }
  if (handed.length > 0) {
    sections.push({ heading: "Handed to you", entries: cap.take(handed).map(toEntry) });
  }
  if (chatLines.length > 0) {
    sections.push({ heading: "Unread chat", entries: cap.take(chatLines) });
  }

  const { subject, preheader } = digestSubject({
    blockingDecisions: newDecisions.filter((d) => d.blocking).length,
    advisoryDecisions: newDecisions.filter((d) => !d.blocking).length,
    firstPersonalTitle: personal[0] ? toEntry(personal[0]).title : undefined,
    personalCount: personal.length + handed.length,
    chatChannels,
    chatCount,
  });
  return { subject, preheader, sections, moreCount: cap.moreCount() };
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
    await deliver(args.to, email, "digest", { headers: listUnsubscribeHeaders(unsubUrl) });
  },
});

export const unsubscribeByToken = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    // Token validation and the idempotent shape are @platform/email's; the
    // lookup index and the preference write are codecast's.
    return await unsubscribeWithHooks(args.token, {
      async lookup(token) {
        const user = await ctx.db
          .query("users")
          .withIndex("by_email_unsub_token", (q) => q.eq("email_unsub_token", token))
          .first();
        return user ? { id: user._id } : null;
      },
      async apply(id) {
        const userId = id as Id<"users">;
        const user = await ctx.db.get(userId);
        if (!user) return;
        await ctx.db.patch(userId, {
          notification_preferences: {
            ...(user.notification_preferences ?? {
              team_session_start: true,
              mention: true,
              permission_request: true,
            }),
            email_notifications: false,
          },
        });
      },
    });
  },
});
