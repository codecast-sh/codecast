// Cross-entity change feed — read side.
//
// getChangesSince(since) returns the SET of entity ids that changed in any scope
// the user can see (their own everything, plus tasks/docs/plans shared to their
// teams) since the `seq` cursor. The client then batch-fetches the current state
// of those ids (conversations.getInboxSessionsByIds, tasks/docs/plans.webGetByIds)
// and applies upserts / prunes deletes. Conversations are owner-only — the inbox
// is "mine" — so team-scoped conversation events are NOT surfaced here (a teammate
// seeing my session in the team FEED is a separate axis with its own cursor).
//
// The cursor is `seq` (Date.now() at write time), not a Convex pagination cursor:
// each call is a fresh gt(since) range with a stable bound, so there is no
// InvalidCursor hazard, and the client advances `since` itself. Apply is
// idempotent (upsert / prune by id), so the client re-queries with a small
// overlap and a rare commit-reorder straggler or same-ms page-boundary tie is
// harmless.
import { v } from "convex/values";
import { query } from "./functions";
import { getAuthUserId } from "@convex-dev/auth/server";

export type FeedChange = {
  entity_type: "conversations" | "tasks" | "docs" | "plans";
  entity_id: string;
  op: "upsert" | "delete";
};

type ChangeRow = FeedChange & { seq: number };

// Pure merge of the per-scope result pages into one gap-free page. Each source
// was fetched ascending by seq with take(limit+1); `capped` means it returned the
// full limit+1 (more may exist beyond what we read).
//
// Gap-free rule: when any source is capped we can only safely advance to the
// LOWEST capped source's highest fetched seq — beyond that point some capped
// source has unread rows. We emit only rows at/below that watermark; the next
// call resumes from it. With no capped source, everything fetched is emitted and
// the crawl is done. Unit-tested in changeFeed.test.ts.
export function mergeChangeFeed(
  sources: Array<{ rows: ChangeRow[]; capped: boolean }>,
  since: number,
): { changes: FeedChange[]; nextSince: number; hasMore: boolean } {
  const cappedMaxSeqs = sources
    .filter((s) => s.capped && s.rows.length > 0)
    .map((s) => s.rows[s.rows.length - 1].seq);
  const all = sources.flatMap((s) => s.rows);

  let within = all;
  let hasMore = false;
  let watermark: number | null = null;
  if (cappedMaxSeqs.length > 0) {
    watermark = Math.min(...cappedMaxSeqs);
    within = all.filter((r) => r.seq <= watermark!);
    hasMore = true;
  }

  // Dedup by entity id (an entity owned by the user AND shared to their team
  // appears in two scopes; one row per entity is enough — current state is
  // fetched either way). Keep the highest seq seen for that entity.
  const byEntity = new Map<string, ChangeRow>();
  for (const r of within) {
    const prev = byEntity.get(r.entity_id);
    if (!prev || r.seq > prev.seq) byEntity.set(r.entity_id, r);
  }
  const deduped = [...byEntity.values()].sort((a, b) => a.seq - b.seq);

  const nextSince = hasMore
    ? watermark!
    : deduped.length > 0
      ? deduped[deduped.length - 1].seq
      : since;

  return {
    changes: deduped.map((r) => ({ entity_type: r.entity_type, entity_id: r.entity_id, op: r.op })),
    nextSince,
    hasMore,
  };
}

// A user's team ids (the team-scope keys for the feed). Mirrors data.ts's
// membership resolution.
async function userTeamIds(ctx: any, userId: any): Promise<any[]> {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  return memberships.map((m: any) => m.team_id);
}

const DEFAULT_FEED_LIMIT = 1000;

export const getChangesSince = query({
  args: {
    since: v.number(),
    limit: v.optional(v.number()),
    // Ignored cache-buster so the client's recovery probe can force a real
    // round-trip past a stalled subscription (same pattern as listInboxSessions).
    _probe: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { changes: [], nextSince: args.since, hasMore: false };

    const limit = Math.min(args.limit ?? DEFAULT_FEED_LIMIT, 2000);
    const cap = limit + 1;

    // Owner scope: everything the user owns, all four entity types.
    const ownerRows = (await ctx.db
      .query("change_log")
      .withIndex("by_owner_seq", (q: any) => q.eq("owner_user_id", userId).gt("seq", args.since))
      .order("asc")
      .take(cap)) as ChangeRow[];

    // Team scopes: collaborative entities shared to a team the user belongs to.
    // Conversations are excluded — the inbox is owner-only, so a team-scoped
    // conversation event must not pull a foreign session into this user's inbox.
    const teamIds = await userTeamIds(ctx, userId);
    const sources: Array<{ rows: ChangeRow[]; capped: boolean }> = [
      { rows: ownerRows, capped: ownerRows.length >= cap },
    ];
    for (const teamId of teamIds) {
      const rows = (await ctx.db
        .query("change_log")
        .withIndex("by_team_seq", (q: any) => q.eq("team_id", teamId).gt("seq", args.since))
        .order("asc")
        .take(cap)) as ChangeRow[];
      const collab = rows.filter((r) => r.entity_type !== "conversations");
      // `capped` is judged on the raw fetch (before the conversation filter): a
      // full page means more rows exist past the window regardless of how many
      // survived the filter.
      sources.push({ rows: collab, capped: rows.length >= cap });
    }

    return mergeChangeFeed(sources, args.since);
  },
});
