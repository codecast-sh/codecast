// Catch-up for mirrored Slack channels. Live lines arrive as Events API
// pushes, and Slack drops an event after three failed deliveries in about an
// hour, so any stretch the backend cannot answer (an outage, a long deploy)
// loses those lines for good unless something goes back for them. Every few
// minutes each link reads its Slack history from its `caught_up_ts` mark,
// mirrors the lines chat does not have, and moves the mark. Mirroring dedupes
// by Slack ts inside the write, so overlapping live delivery is harmless.
//
// conversations.history returns roots only, and a reply landing under an old
// root moves nothing in the window. The read therefore starts THREAD_LOOKBACK_S
// before the mark and fetches replies for any root whose latest reply is past
// it; older roots are only read, never re-mirrored.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { slackApi } from "./lib/slackApi";
import { linkReceivesInbound } from "./lib/slackMirror";
import { findMirroredRow, isMirrorableMessage, mirrorMessage } from "./slackSync";

// Lines a little older than the mark are read again, for a line Slack stamped
// just before the previous run read history but indexed just after.
export const CATCH_UP_OVERLAP_S = 120;
// How far back a root may sit and still get its new replies brought over.
export const THREAD_LOOKBACK_S = 3 * 86_400;
// A link that has never run catches up this far back (bounded by its own floor).
export const FIRST_RUN_WINDOW_S = 2 * 86_400;
const HISTORY_PAGE = 200;
const HISTORY_MAX_PAGES = 10;
const REPLY_MAX_PAGES = 5;
const RUN_BUDGET_MS = 40_000;
// Runs for different links start this far apart, so one tick never bursts
// every channel's history calls at Slack at once.
const STAGGER_MS = 3_000;

type SlackMsg = { ts: string; subtype?: string; thread_ts?: string; reply_count?: number; latest_reply?: string };

/** Where lines may be missing from: the mark less the overlap, or the first
 *  run window, never before the link's own floor. */
export function catchUpFloor(link: { caught_up_ts?: string; since_ts: string }, nowS: number): number {
  const from = link.caught_up_ts ? Number(link.caught_up_ts) - CATCH_UP_OVERLAP_S : nowS - FIRST_RUN_WINDOW_S;
  return Math.max(Number(link.since_ts) || 0, from);
}

/** From one history read: the roots that may be missing, and the roots whose
 *  threads have replies past the floor. */
export function planCatchUp(messages: SlackMsg[], floor: number, threads: boolean): { roots: SlackMsg[]; threadRoots: string[] } {
  const roots = messages.filter((m) => Number(m.ts) >= floor && isMirrorableMessage(m));
  const threadRoots = threads
    ? messages.filter((m) => (m.reply_count ?? 0) > 0 && Number(m.latest_reply ?? 0) >= floor).map((m) => m.ts)
    : [];
  return { roots, threadRoots };
}

export const catchUpAll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const ids: Id<"slack_channel_links">[] = await ctx.runQuery(internal.slackCatchUp.linkIds, {});
    for (const [i, link_id] of ids.entries()) {
      await ctx.scheduler.runAfter(i * STAGGER_MS, internal.slackCatchUp.catchUpLink, { link_id });
    }
    return { scheduled: ids.length };
  },
});

export const linkIds = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"slack_channel_links">[]> => {
    const links = await ctx.db.query("slack_channel_links").withIndex("by_team").collect();
    return links.map((l) => l._id);
  },
});

export const mirroredTs = internalQuery({
  args: { link_id: v.id("slack_channel_links"), ts: v.array(v.string()) },
  handler: async (ctx, args): Promise<string[]> => {
    const link = await ctx.db.get(args.link_id);
    if (!link) return [];
    const here: string[] = [];
    for (const ts of args.ts) if (await findMirroredRow(ctx, link, ts)) here.push(ts);
    return here;
  },
});

export const markCaughtUp = internalMutation({
  args: { link_id: v.id("slack_channel_links"), ts: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.link_id);
    if (!link) return;
    // Patched alone (no updated_at): a quiet channel must not look active.
    await ctx.db.patch(link._id, { caught_up_ts: args.ts });
  },
});

export const catchUpLink = internalAction({
  args: { link_id: v.id("slack_channel_links") },
  handler: async (ctx, args): Promise<{ status: string; mirrored?: number }> => {
    const c = await ctx.runQuery(internal.slackSync.linkContext, { link_id: args.link_id });
    if (!c?.link || !c.install) return { status: "no_link" };
    const { link, install } = c;
    const started = Date.now();
    const nowTs = (started / 1000).toFixed(6);
    // Nothing flows in, so nothing is owed: keep the mark current, so a
    // resumed link starts from the resume, not from the pause.
    if (!linkReceivesInbound(link) || !c.channel || c.channel.archived_at) {
      await ctx.runMutation(internal.slackCatchUp.markCaughtUp, { link_id: link._id, ts: nowTs });
      return { status: "not_receiving" };
    }
    // The history import covers its own window; the next tick takes over.
    if (link.backfill?.status === "running") return { status: "import_running" };

    const floor = catchUpFloor(link, started / 1000);
    const scanFrom = Math.max(0, floor - THREAD_LOOKBACK_S);
    const candidates: SlackMsg[] = [];
    let complete = true;

    // History, newest first between both bounds.
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= HISTORY_MAX_PAGES) { complete = false; break; }
      const resp = await slackApi(install.bot_token, "conversations.history", {
        channel: link.slack_channel_id, oldest: scanFrom.toFixed(6), latest: nowTs, inclusive: "true",
        limit: String(HISTORY_PAGE), cursor,
      });
      if (!resp.ok) {
        console.warn("[slackCatchUp] history failed", link.slack_channel_id, resp.error);
        return { status: `slack:${resp.error}` };
      }
      const plan = planCatchUp(resp.messages ?? [], floor, link.options.threads);
      candidates.push(...plan.roots);
      for (const root of plan.threadRoots) {
        let replyCursor: string | undefined;
        for (let rp = 0; ; rp++) {
          if (rp >= REPLY_MAX_PAGES) { complete = false; break; }
          const replies = await slackApi(install.bot_token, "conversations.replies", {
            channel: link.slack_channel_id, ts: root, oldest: floor.toFixed(6), inclusive: "true", limit: "200", cursor: replyCursor,
          });
          if (!replies.ok) { complete = false; break; }
          candidates.push(...(replies.messages ?? []).filter((m: SlackMsg) => m.ts !== root && Number(m.ts) >= floor && isMirrorableMessage(m)));
          replyCursor = replies.response_metadata?.next_cursor || undefined;
          if (!replyCursor) break;
        }
      }
      cursor = resp.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }

    // Only what chat lacks, oldest first so each reply finds its root.
    const byTs = new Map(candidates.map((m) => [m.ts, m]));
    const all = [...byTs.keys()];
    const here = new Set<string>();
    for (let i = 0; i < all.length; i += 200) {
      for (const ts of await ctx.runQuery(internal.slackCatchUp.mirroredTs, { link_id: link._id, ts: all.slice(i, i + 200) })) here.add(ts);
    }
    const missing = all.filter((ts) => !here.has(ts)).sort((a, b) => Number(a) - Number(b));

    let mirrored = 0;
    for (const ts of missing) {
      if (Date.now() - started > RUN_BUDGET_MS) { complete = false; break; }
      try {
        const r = await mirrorMessage(ctx, { install, link, anchor_handle: c.anchor_handle }, byTs.get(ts), { live: false });
        if (r.message_id) mirrored++;
      } catch (error) {
        console.error("[slackCatchUp] line skipped", link.slack_channel_id, ts, error);
      }
    }
    if (missing.length > 0) console.log("[slackCatchUp]", link.slack_channel_id, `missing=${missing.length} mirrored=${mirrored}`);
    // A run cut short leaves the mark alone; the next run reads the same span
    // and skips what this one brought over.
    if (complete) await ctx.runMutation(internal.slackCatchUp.markCaughtUp, { link_id: link._id, ts: nowTs });
    return { status: complete ? "done" : "partial", mirrored };
  },
});
