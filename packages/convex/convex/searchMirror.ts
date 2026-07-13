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
// mirror rows that have aged out of the window. Content copied only after
// SWEEP_LAG_MS so post-insert dedup patches (messages.ts) have settled.
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
export const MIRROR_LIVE_SLACK_MS = 30 * 60_000;
// Search relevance only needs the text, and giant tool dumps drown BM25
// anyway — cap what we mirror per message.
const MAX_CONTENT_CHARS = 32_000;
// Stay well under the per-mutation write budget even if every row is at cap.
const MAX_BATCH_CONTENT_CHARS = 4_000_000;
// Each mirrored row costs ~2 system ops (dedup .first() + insert/patch) on top
// of the scan reads, against a ~4096 ops/transaction ceiling. Unbounded, a
// dense-content backlog aborts the mutation atomically — the cursor never
// advances and the cron hot-loops the same batch every 15s (found during the
// 2026-07-13 outage postmortem). Worst case with these caps: 1200 scan reads
// + 800×2 upsert ops + ~400 GC ≈ 3200, comfortable margin.
const MAX_UPSERTS_PER_RUN = 800;
const MAX_BATCH_ROWS = 1200;
const GC_BATCH = 200;

// Handler body as a plain exported function so bun tests can drive it with a
// fake ctx (same pattern as performNeedsInputCheck / teamSend tests). `now` is
// injectable for tests; the mutation always passes the real clock.
export async function performMirrorAdvance(
  // Structural subset of MutationCtx the walker touches — lets tests pass a
  // hand-rolled fake without recreating the whole convex ctx surface.
  ctx: {
    db: Pick<import("./_generated/server").MutationCtx["db"], "query" | "insert" | "patch" | "delete" | "get">;
  },
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
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_creation_time", (q) =>
        q.gt("_creationTime", state.cursor).lt("_creationTime", ceiling),
      )
      .order("asc")
      .take(limit);

    let copied = 0;
    let contentBudget = MAX_BATCH_CONTENT_CHARS;
    let newCursor = state.cursor;
    let budgetBroke = false;
    for (const msg of rows) {
      newCursor = msg._creationTime;
      const content = msg.content?.trim() ? msg.content.slice(0, MAX_CONTENT_CHARS) : null;
      if (!content) continue;
      if (contentBudget - content.length < 0 || copied >= MAX_UPSERTS_PER_RUN) {
        // Budget hit mid-batch (bytes or ops): stop BEFORE this row so the
        // next run re-reads it.
        newCursor = msg._creationTime - 0.0001;
        budgetBroke = true;
        break;
      }
      contentBudget -= content.length;
      const existing = await ctx.db
        .query("message_search_recent")
        .withIndex("by_message_id", (q) => q.eq("message_id", msg._id))
        .first();
      const doc = {
        message_id: msg._id,
        conversation_id: msg.conversation_id,
        role: msg.role,
        content,
        timestamp: msg.timestamp,
        tool_calls_count: msg.tool_calls?.length,
        tool_results_count: msg.tool_results?.length,
        source_created_at: msg._creationTime,
      };
      if (existing) {
        await ctx.db.patch(existing._id, doc);
      } else {
        await ctx.db.insert("message_search_recent", doc);
      }
      copied++;
    }

    // Drained below the batch limit = nothing else exists before the ceiling,
    // so the ceiling IS the watermark. Without this, a quiet fleet leaves the
    // cursor pinned to the last message and "lag" grows while fully caught up.
    // (-1ms so a row landing exactly at the ceiling gets re-scanned, not skipped.)
    // NEVER on a budget break — the cursor was rewound to re-read skipped rows,
    // and bumping to the ceiling here would silently skip them forever.
    if (rows.length < limit && !budgetBroke) {
      newCursor = Math.max(newCursor, ceiling - 1);
    }

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

    await ctx.db.patch(state._id, { cursor: newCursor, updated_at: now });

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
      scanned: rows.length,
      copied,
      expired: expired.length,
      cursor: newCursor,
      lag_ms: lagMs,
      live: shouldLive,
      // A budget break leaves unprocessed rows behind the cursor — never
      // report that as caught up, or supervisors stop driving the catch-up.
      caught_up: rows.length < limit && !budgetBroke,
    };
  }
}

export const advance = internalMutation({
  args: { batch: v.optional(v.number()) },
  handler: async (ctx, args) => performMirrorAdvance(ctx, args),
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
      live: liveRow?.live ?? false,
      updated_at_iso: new Date(state.updated_at).toISOString(),
    };
  },
});
