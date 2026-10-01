import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

// Recent-window mirror for message content search (ct-37627).
//
// Why this exists: search_content_v2 spans every message ever written (~3.6M
// rows and growing). A Convex search query scores the ENTIRE posting list for
// a term before take() applies, so any common token ("test", "green") blows
// the query budget no matter how few results we ask for. The titles tier never
// fails for one reason only: its corpus is small. This mirror gives message
// content the same property — a physically small table holding just the last
// MIRROR_WINDOW_MS of message text, with its own search index. Bounded corpus
// = bounded scan, by construction rather than by query-planner luck.
//
// One walker does everything: the cursor starts WINDOW ms in the past and
// walks messages forward by _creationTime forever. Until it reaches "now" it
// is the backfill; afterwards it is the tail sync. Each step also deletes
// mirror rows that have aged out of the window. A second, fresh walk copies
// new messages within seconds; the main walk trails by SWEEP_LAG_MS and
// re-copies whatever post-insert patches (messages.ts) changed since.
//
// Cutover is data-driven: fetchMessageSearchPool (conversations.ts) serves
// from the mirror only while the cursor is fresher than LIVE_SLACK; if this
// cron falls behind or dies, search falls back to the deep index (old
// behavior, still breaker-protected client-side) instead of going dark.

// Tuning note: lowering this takes effect within minutes (GC prunes, index
// shrinks); RAISING it needs a one-shot backfill (reset the cursor back).
// 30d balances "covers what people actually content-search" against posting-
// list size at current fleet write rates (~tens of thousands of msgs/day).
export const MIRROR_WINDOW_MS = 30 * 86_400_000;
const SWEEP_LAG_MS = 10 * 60_000;
// The fresh walk trails "now" by a few seconds so a transaction that took its
// _creationTime just before the walk but committed just after is not skipped
// (the settle walk would still catch it, ten minutes later).
const FRESH_LAG_MS = 5_000;
// The fresh walk spans at most SWEEP_LAG_MS of messages; this caps its share
// of a tick's read budget so the settle walk keeps room to backfill.
const MAX_FRESH_ROWS = 300;
export const MIRROR_LIVE_SLACK_MS = 30 * 60_000;
// Search relevance only needs the text, and giant tool dumps drown BM25
// anyway — cap what we mirror per message.
const MAX_CONTENT_CHARS = 32_000;
// Stay well under the per-mutation write budget even if every row is at cap.
const MAX_BATCH_CONTENT_CHARS = 4_000_000;
// Each mirrored row costs ~2 system ops (dedup .first() + insert/patch) plus
// at most one conversation get (cached per batch — messages cluster by
// conversation) on top of the scan reads, against a ~4096 ops/transaction
// ceiling. Unbounded, a dense-content backlog aborts the mutation atomically —
// the cursor never advances and the cron hot-loops the same batch every 15s
// (found during the 2026-07-13 outage postmortem). Worst case with these
// caps: 1200 + 300 scan reads + 600×3 upsert ops (shared by both walks) +
// ~400 GC ≈ 3700, still margin.
const MAX_UPSERTS_PER_RUN = 600;
const MAX_BATCH_ROWS = 1200;
const GC_BATCH = 200;

type MirrorDb = Pick<import("./_generated/server").MutationCtx["db"], "query" | "insert" | "patch" | "delete" | "get">;
type MirrorBudget = { copied: number; content: number; broke: boolean };

const sameMirrorRow = (existing: Record<string, unknown>, doc: Record<string, unknown>) =>
  Object.keys(doc).every((k) => existing[k] === doc[k]);

// Copy messages created in (from, ceiling) into the mirror, oldest first.
// Upserts by message_id and skips rows whose mirrored fields are unchanged, so
// a second walk over the same span writes only what changed since the first.
// Returns where the walk stopped: the ceiling once drained, or just before the
// first row a spent budget skipped (the next run re-reads it).
async function walkMessages(
  db: MirrorDb,
  from: number,
  ceiling: number,
  limit: number,
  budget: MirrorBudget,
  convScope: Map<string, { user_id?: any; team_id?: any }>,
): Promise<{ cursor: number; scanned: number }> {
  const rows = await db
    .query("messages")
    .withIndex("by_creation_time", (q) => q.gt("_creationTime", from).lt("_creationTime", ceiling))
    .order("asc")
    .take(limit);
  let cursor = from;
  for (const msg of rows) {
    cursor = msg._creationTime;
    const content = msg.content?.trim() ? msg.content.slice(0, MAX_CONTENT_CHARS) : null;
    if (!content) continue;
    if (budget.content - content.length < 0 || budget.copied >= MAX_UPSERTS_PER_RUN) {
      budget.broke = true;
      return { cursor: msg._creationTime - 0.0001, scanned: rows.length };
    }
    budget.content -= content.length;
    budget.copied++;
    const existing = await db
      .query("message_search_recent")
      .withIndex("by_message_id", (q) => q.eq("message_id", msg._id))
      .first();
    const convKey = msg.conversation_id.toString();
    let scope = convScope.get(convKey);
    if (!scope) {
      const conv = await db.get(msg.conversation_id);
      scope = { user_id: conv?.user_id, team_id: conv?.team_id };
      convScope.set(convKey, scope);
    }
    const doc = {
      message_id: msg._id,
      conversation_id: msg.conversation_id,
      role: msg.role,
      content,
      timestamp: msg.timestamp,
      tool_calls_count: msg.tool_calls?.length,
      tool_results_count: msg.tool_results?.length,
      source_created_at: msg._creationTime,
      user_id: scope.user_id,
      team_id: scope.team_id,
    };
    if (!existing) await db.insert("message_search_recent", doc);
    else if (!sameMirrorRow(existing, doc)) await db.patch(existing._id, doc);
  }
  // Drained below the limit = nothing else exists before the ceiling, so the
  // ceiling IS the watermark. Without this, a quiet fleet leaves the cursor
  // pinned to the last message and "lag" grows while fully caught up.
  // (-1ms so a row landing exactly at the ceiling gets re-scanned, not skipped.)
  if (rows.length < limit) cursor = Math.max(cursor, ceiling - 1);
  return { cursor, scanned: rows.length };
}

// Handler body as a plain exported function so bun tests can drive it with a
// fake ctx (same pattern as performNeedsInputCheck / teamSend tests). `now` is
// injectable for tests; the mutation always passes the real clock.
//
// Two walks per tick. The fresh walk copies messages seconds after they land,
// so the session you were just in is searchable right away. The settle walk
// trails by SWEEP_LAG_MS and re-copies the same rows once post-insert patches
// (streamed text, dedup) have landed; it writes only rows whose text changed,
// and it owns the backfill and the liveness cursor.
export async function performMirrorAdvance(
  ctx: { db: MirrorDb },
  args: { batch?: number; now?: number },
) {
  {
    const now = args.now ?? Date.now();
    let state = await ctx.db.query("search_mirror_state").first();
    if (!state) {
      const id = await ctx.db.insert("search_mirror_state", {
        cursor: now - MIRROR_WINDOW_MS,
        updated_at: now,
      });
      state = (await ctx.db.get(id))!;
    }

    // Read budget bounds the batch: message docs are read whole (tool_results
    // and all), so thousands of maximal docs approach the transaction read
    // ceiling well before the write-side content budget trips.
    const limit = Math.min(Math.max(args.batch ?? 400, 1), MAX_BATCH_ROWS);
    const ceiling = now - SWEEP_LAG_MS;
    const budget: MirrorBudget = { copied: 0, content: MAX_BATCH_CONTENT_CHARS, broke: false };
    // Conversation owner/team stamps, cached per tick — a batch's messages
    // cluster into few conversations, so this is ~1 get per conversation,
    // not per row.
    const convScope = new Map<string, { user_id?: any; team_id?: any }>();

    // The settle walk covers everything below its ceiling, so the fresh walk
    // never starts below it, even after an outage.
    const freshFrom = Math.max(state.fresh_cursor ?? 0, ceiling - 1);
    const fresh = await walkMessages(ctx.db, freshFrom, now - FRESH_LAG_MS, MAX_FRESH_ROWS, budget, convScope);
    const settle = budget.broke
      ? { cursor: state.cursor, scanned: 0 }
      : await walkMessages(ctx.db, state.cursor, ceiling, limit, budget, convScope);
    const newCursor = settle.cursor;
    const caughtUp = settle.scanned < limit && !budget.broke;

    // Age out rows that left the window. During backfill the mirror is young
    // and this finds nothing.
    const expired = await ctx.db
      .query("message_search_recent")
      .withIndex("by_source_created_at", (q) =>
        q.lt("source_created_at", now - MIRROR_WINDOW_MS),
      )
      .take(GC_BATCH);
    for (const row of expired) {
      await ctx.db.delete(row._id);
    }

    await ctx.db.patch(state._id, { cursor: newCursor, fresh_cursor: fresh.cursor, updated_at: now });

    // Liveness flag lives in its OWN row and is written only on transitions —
    // searches subscribe to it, and a per-tick patch here would re-run every
    // open search each cron cycle. Hysteresis: go live only when clearly
    // caught up (half the slack); go dead only when clearly beyond it.
    const lagMs = Math.max(0, now - newCursor);
    const liveRow = await ctx.db.query("search_mirror_live").first();
    const isLive = liveRow?.live ?? false;
    const shouldLive = isLive
      ? lagMs < MIRROR_LIVE_SLACK_MS
      : lagMs < MIRROR_LIVE_SLACK_MS / 2;
    if (!liveRow) {
      await ctx.db.insert("search_mirror_live", { live: shouldLive });
    } else if (liveRow.live !== shouldLive) {
      await ctx.db.patch(liveRow._id, { live: shouldLive });
    }

    return {
      scanned: settle.scanned,
      fresh_scanned: fresh.scanned,
      copied: budget.copied,
      expired: expired.length,
      cursor: newCursor,
      fresh_cursor: fresh.cursor,
      lag_ms: lagMs,
      live: shouldLive,
      // A budget break leaves unprocessed rows behind the cursor — never
      // report that as caught up, or supervisors stop driving the catch-up.
      caught_up: caughtUp,
    };
  }
}

// A deleted message leaves the mirror with it, or search keeps matching text
// that no longer exists (an API error banner removed after its retry).
export async function dropMirroredMessage(
  ctx: { db: Pick<MirrorDb, "query" | "delete"> },
  messageId: import("./_generated/dataModel").Id<"messages">,
) {
  const row = await ctx.db
    .query("message_search_recent")
    .withIndex("by_message_id", (q) => q.eq("message_id", messageId))
    .first();
  if (row) await ctx.db.delete(row._id);
}

export const advance = internalMutation({
  args: { batch: v.optional(v.number()) },
  handler: async (ctx, args) => performMirrorAdvance(ctx, args),
});

// One-shot migration: stamp user_id/team_id onto mirror rows written before
// those fields existed. Stateless forward cursor (source_created_at) passed in
// and returned by the caller, so a driving loop never re-visits rows whose
// conversation has been deleted (those stay unstamped). Safe to re-run; the
// tail walker stamps all new rows, so once this completes it is dead code.
export async function performBackfillScopes(
  ctx: {
    db: Pick<import("./_generated/server").MutationCtx["db"], "query" | "patch" | "get">;
  },
  args: { cursor?: number; batch?: number },
) {
  const batch = Math.min(Math.max(args.batch ?? 400, 1), 800);
  const rows = await ctx.db
    .query("message_search_recent")
    .withIndex("by_source_created_at", (q) => q.gt("source_created_at", args.cursor ?? 0))
    .order("asc")
    .take(batch);
  const convScope = new Map<string, { user_id?: any; team_id?: any }>();
  let patched = 0;
  let cursor = args.cursor ?? 0;
  for (const row of rows) {
    cursor = row.source_created_at;
    if (row.user_id !== undefined) continue;
    const convKey = row.conversation_id.toString();
    let scope = convScope.get(convKey);
    if (!scope) {
      const conv = await ctx.db.get(row.conversation_id);
      scope = { user_id: conv?.user_id, team_id: conv?.team_id };
      convScope.set(convKey, scope);
    }
    if (scope.user_id === undefined) continue;
    await ctx.db.patch(row._id, { user_id: scope.user_id, team_id: scope.team_id });
    patched++;
  }
  return { scanned: rows.length, patched, cursor, done: rows.length < batch };
}

export const backfillScopes = internalMutation({
  args: { cursor: v.optional(v.number()), batch: v.optional(v.number()) },
  handler: async (ctx, args) => performBackfillScopes(ctx, args),
});

// Monitoring probe: how far behind is the mirror, and how big is it (sampled)?
export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const state = await ctx.db.query("search_mirror_state").first();
    if (!state) return { initialized: false };
    const liveRow = await ctx.db.query("search_mirror_live").first();
    const now = Date.now();
    return {
      initialized: true,
      cursor: state.cursor,
      cursor_iso: new Date(state.cursor).toISOString(),
      behind_ms: Math.max(0, now - SWEEP_LAG_MS - state.cursor),
      fresh_behind_ms: state.fresh_cursor === undefined ? null : Math.max(0, now - FRESH_LAG_MS - state.fresh_cursor),
      live: liveRow?.live ?? false,
      updated_at_iso: new Date(state.updated_at).toISOString(),
    };
  },
});
