// Slack link unfurls for codecast objects (Slack's link_shared → chat.unfurl).
//
// A session, task, plan or doc URL is private: Slack's anonymous crawler gets
// the generic card from the web server (server/bot-meta.ts). This module is the
// authenticated path. When a person pastes such a link into a workspace that
// installed the codecast app, the card is drawn as THAT person: their Slack
// identity maps to a codecast user (slackSync people mapping), and the card is
// built only when that user can read the object. The poster could paste the
// summary by hand; the card shows the channel what they already can see.
//
// Never in a Slack Connect channel: the people on the far side belong to
// another company, and the poster's access says nothing about them.

import { v } from "convex/values";
import { internalAction, internalQuery } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { parseEntityUrl } from "@codecast/shared/entities";
import { slackApi } from "./lib/slackApi";
import { canOwnerOrTeamAccess, canTeamMemberAccess } from "./privacy";
import { canAccessDoc, canAccessPlan, canAccessTask } from "./lib/access";
import { resolveConversationRefRanked } from "./conversationSessionLookup";
import { displayName } from "./lib/displayNames";
import { oneLine, plainPreview } from "./chatText";
import { resolveSlackPerson } from "./slackSync";

/** What a card says, independent of Slack's block format (tested on its own). */
export type UnfurlCard = {
  title: string;
  url: string;
  summary: string | null;
  /** Short facts joined into the context line: status, counts, project. */
  facts: string[];
  author: { name: string; avatar_url: string | null } | null;
  updated_at: number | null;
};

const UNFURLABLE = new Set(["session", "task", "plan", "doc"]);

const SESSION_STATUS: Record<string, string> = {
  working: "Working",
  blocked: "Needs input",
  dormant: "Waiting",
  done: "Done",
};

function authorOf(user: Doc<"users"> | null): UnfurlCard["author"] {
  if (!user) return null;
  return { name: displayName(user), avatar_url: user.image || user.github_avatar_url || null };
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** The first line of a multi-line field, without a bullet marker. */
function firstLine(text: string | undefined): string | null {
  const line = text?.split("\n").map((l) => l.trim()).find(Boolean);
  return line ? line.replace(/^[-*]\s+/, "") : null;
}

async function normalizedGet<T extends "tasks" | "plans" | "docs">(
  ctx: QueryCtx,
  table: T,
  id: string,
): Promise<Doc<T> | null> {
  const normalized = ctx.db.normalizeId(table, id);
  return normalized ? ((await ctx.db.get(normalized)) as Doc<T> | null) : null;
}

async function sessionCard(ctx: QueryCtx, viewer: Id<"users">, ref: string, url: string): Promise<UnfurlCard | null> {
  // A full id or the 7-char short id; short ids collide, so rank own > team.
  const conversation = (await resolveConversationRefRanked(ctx, ref, viewer, (c) =>
    canTeamMemberAccess(ctx, viewer, c as Doc<"conversations">),
  )) as Doc<"conversations"> | null;
  if (!conversation || !(await canOwnerOrTeamAccess(ctx, viewer, conversation))) return null;
  const facts: string[] = [];
  const status = conversation.thread_state_status
    ? SESSION_STATUS[conversation.thread_state_status]
    : conversation.status === "completed" ? "Ended" : null;
  if (status) facts.push(status);
  facts.push(plural(conversation.message_count || 0, "message"));
  const project = conversation.project_path?.split("/").filter(Boolean).pop();
  if (project) facts.push(project);
  return {
    title: conversation.title || "Coding session",
    url,
    // What the session is doing now, else its one-line summary.
    summary: firstLine(conversation.thread_state) || conversation.idle_summary?.trim() || firstLine(conversation.subtitle),
    facts,
    author: authorOf(await ctx.db.get(conversation.user_id)),
    updated_at: conversation.updated_at,
  };
}

async function taskCard(ctx: QueryCtx, viewer: Id<"users">, ref: string, url: string): Promise<UnfurlCard | null> {
  const task =
    (await normalizedGet(ctx, "tasks", ref)) ??
    (await ctx.db.query("tasks").withIndex("by_short_id", (q) => q.eq("short_id", ref)).first());
  if (!task || !(await canAccessTask(ctx, viewer, task))) return null;
  const facts = [String(task.status).replace(/_/g, " "), `${task.priority} priority`];
  return {
    title: `${task.short_id} · ${task.title}`,
    url,
    summary: task.description ? plainPreview(task.description, 280) : null,
    facts,
    author: authorOf(await ctx.db.get(task.user_id)),
    updated_at: (task as any).updated_at ?? task._creationTime,
  };
}

async function planCard(ctx: QueryCtx, viewer: Id<"users">, ref: string, url: string): Promise<UnfurlCard | null> {
  const plan =
    (await normalizedGet(ctx, "plans", ref)) ??
    (await ctx.db.query("plans").withIndex("by_short_id", (q) => q.eq("short_id", ref)).first());
  if (!plan || !(await canAccessPlan(ctx, viewer, plan))) return null;
  const tasks = await ctx.db.query("tasks").withIndex("by_plan_id", (q) => q.eq("plan_id", plan._id)).take(500);
  const done = tasks.filter((t) => t.status === "done").length;
  const facts = [String(plan.status).replace(/_/g, " ")];
  if (tasks.length) facts.push(`${done}/${tasks.length} tasks done`);
  return {
    title: `${plan.short_id} · ${plan.title}`,
    url,
    summary: plan.goal ? plainPreview(plan.goal, 280) : null,
    facts,
    author: authorOf(await ctx.db.get(plan.user_id)),
    updated_at: (plan as any).updated_at ?? plan._creationTime,
  };
}

async function docCard(ctx: QueryCtx, viewer: Id<"users">, ref: string, url: string): Promise<UnfurlCard | null> {
  const doc = await normalizedGet(ctx, "docs", ref);
  if (!doc || !(await canAccessDoc(ctx, viewer, doc))) return null;
  return {
    title: doc.title || "Untitled doc",
    url,
    summary: doc.content ? plainPreview(doc.content, 280) : null,
    facts: [String(doc.doc_type).replace(/_/g, " ")],
    author: authorOf(await ctx.db.get(doc.user_id)),
    updated_at: doc.updated_at,
  };
}

/** The card for one URL as `viewer` sees it, or null when there is nothing to
 *  show them (not ours, not a kind we unfurl, missing, or no access). */
export const cardFor = internalQuery({
  args: { viewer: v.id("users"), url: v.string() },
  handler: async (ctx, args): Promise<UnfurlCard | null> => {
    const ref = parseEntityUrl(args.url);
    if (!ref || !UNFURLABLE.has(ref.type)) return null;
    switch (ref.type) {
      case "session": return sessionCard(ctx, args.viewer, ref.id, args.url);
      case "task": return taskCard(ctx, args.viewer, ref.id, args.url);
      case "plan": return planCard(ctx, args.viewer, ref.id, args.url);
      case "doc": return docCard(ctx, args.viewer, ref.id, args.url);
    }
    return null;
  },
});

/** Escape the three characters Slack's mrkdwn treats as control characters. */
function mrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One card as Slack blocks: the linked title with the summary under it, then
 *  a context line with the author's face, the facts and a live relative time. */
export function unfurlBlocks(card: UnfurlCard): unknown[] {
  const title = `*<${card.url}|${mrkdwn(oneLine(card.title, 150))}>*`;
  const text = card.summary ? `${title}\n${mrkdwn(oneLine(card.summary, 300))}` : title;
  const context: unknown[] = [];
  if (card.author?.avatar_url) {
    context.push({ type: "image", image_url: card.author.avatar_url, alt_text: card.author.name });
  }
  const parts = [card.author?.name, ...card.facts].filter(Boolean).map((p) => mrkdwn(String(p)));
  if (card.updated_at) {
    const secs = Math.floor(card.updated_at / 1000);
    parts.push(`<!date^${secs}^updated {ago}|updated ${new Date(card.updated_at).toISOString().slice(0, 10)}>`);
  }
  if (parts.length) context.push({ type: "mrkdwn", text: parts.join("  ·  ") });
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text } }];
  if (context.length) blocks.push({ type: "context", elements: context });
  return blocks;
}

export const handleLinkShared = internalAction({
  args: {
    workspace: v.string(),
    event: v.any(),
    is_ext_shared_channel: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.is_ext_shared_channel) return { unfurled: 0, reason: "external_channel" };
    const event = args.event ?? {};
    const links: Array<{ url?: string }> = Array.isArray(event.links) ? event.links : [];
    if (!event.user || links.length === 0) return { unfurled: 0, reason: "no_links" };

    const install = await ctx.runQuery(internal.slackUnfurl.installationFor, { workspace_id: args.workspace });
    if (!install) return { unfurled: 0, reason: "no_install" };
    const person = await resolveSlackPerson(ctx, install, String(event.user));
    if (!person.codecast_user_id || person.is_bot) return { unfurled: 0, reason: "unmapped_poster" };

    const unfurls: Record<string, { blocks: unknown[] }> = {};
    for (const link of links.slice(0, 5)) {
      if (!link.url) continue;
      const card = await ctx.runQuery(internal.slackUnfurl.cardFor, { viewer: person.codecast_user_id, url: link.url });
      if (card) unfurls[link.url] = { blocks: unfurlBlocks(card) };
    }
    const count = Object.keys(unfurls).length;
    if (count === 0) return { unfurled: 0, reason: "nothing_visible" };

    // A link typed in the composer is unfurled before the message exists, and
    // is addressed by unfurl_id; a posted one by channel + message ts.
    const target = event.unfurl_id && event.source
      ? { unfurl_id: event.unfurl_id, source: event.source }
      : { channel: event.channel, ts: event.message_ts };
    const resp = await slackApi(install.bot_token, "chat.unfurl", { ...target, unfurls });
    if (!resp.ok) console.error("[slackUnfurl] chat.unfurl failed", resp.error);
    return { unfurled: resp.ok ? count : 0, reason: resp.ok ? "ok" : resp.error };
  },
});

export const installationFor = internalQuery({
  args: { workspace_id: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("slack_installations")
      .withIndex("by_workspace", (q) => q.eq("workspace_id", args.workspace_id))
      .first(),
});
