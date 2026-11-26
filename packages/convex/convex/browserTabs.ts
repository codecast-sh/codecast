// The browser tabs each session has open right now (schema
// session_browser_tabs). The daemon on each machine reports its whole set,
// written only when it changes or its keepalive comes due; the web inbox's
// Browser view reads the viewer's rows through webList.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { query, mutation } from "./functions";
import { requireUserOrToken } from "./lib/auth";
import { BROWSER_TAB_WHERE, BROWSER_TABS_KEEPALIVE_MS } from "@codecast/shared/contracts";

const tabValidator = v.object({
  id: v.string(),
  title: v.string(),
  url: v.string(),
  where: v.union(...BROWSER_TAB_WHERE.map((w) => v.literal(w))),
});

const MAX_SESSIONS = 200;
const MAX_TABS = 20;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function sameTabs(a: Array<{ id: string; title: string; url: string; where: string }>, b: typeof a): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i].id && t.title === b[i].title && t.url === b[i].url && t.where === b[i].where);
}

async function ownConversation(ctx: any, userId: any, sessionId: string) {
  const conv = await ctx.db.query("conversations").withIndex("by_session_id", (q: any) => q.eq("session_id", sessionId)).first();
  return conv && String(conv.user_id) === String(userId) ? conv._id : undefined;
}

/** A device's whole report: sessions it names get their tabs, every other row of this device goes. */
export const report = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    sessions: v.array(v.object({
      session_id: v.string(),
      tabs: v.array(tabValidator),
      last_used_at: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const now = Date.now();
    const existing = await ctx.db
      .query("session_browser_tabs")
      .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", args.device_id))
      .collect();
    const bySession = new Map(existing.map((r: any) => [r.session_id, r]));
    const named = new Set<string>();
    for (const s of args.sessions.slice(0, MAX_SESSIONS)) {
      if (named.has(s.session_id) || s.tabs.length === 0) continue;
      named.add(s.session_id);
      const tabs = s.tabs.slice(0, MAX_TABS).map((t) => ({ id: cut(t.id, 200), title: cut(t.title, 300), url: cut(t.url, 2000), where: t.where }));
      const row = bySession.get(s.session_id);
      const conversationId = row?.conversation_id ?? (await ownConversation(ctx, userId, s.session_id));
      if (row) {
        const unchanged = sameTabs(row.tabs, tabs) && row.last_used_at === s.last_used_at && row.conversation_id === conversationId;
        // An unchanged report only refreshes the row once its keepalive is half spent.
        if (unchanged && now - row.reported_at < BROWSER_TABS_KEEPALIVE_MS / 2) continue;
        await ctx.db.patch(row._id, { tabs, last_used_at: s.last_used_at, reported_at: now, ...(conversationId ? { conversation_id: conversationId } : {}) });
        continue;
      }
      await ctx.db.insert("session_browser_tabs", {
        user_id: userId,
        device_id: args.device_id,
        session_id: s.session_id,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        tabs,
        last_used_at: s.last_used_at,
        reported_at: now,
      });
    }
    for (const row of existing) {
      if (!named.has(row.session_id)) await ctx.db.delete(row._id);
    }
    return { sessions: named.size };
  },
});

/** The viewer's rows, every machine: the complete set (a snapshot feed). */
export const webList = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db.query("session_browser_tabs").withIndex("by_user", (q: any) => q.eq("user_id", userId)).collect();
    return rows
      .filter((r: any) => r.conversation_id)
      .map((r: any) => ({
        _id: r._id,
        conversation_id: r.conversation_id,
        session_id: r.session_id,
        device_id: r.device_id,
        tabs: r.tabs,
        last_used_at: r.last_used_at,
        reported_at: r.reported_at,
      }));
  },
});
