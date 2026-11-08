// Turn snapshots: the index that joins a working tree snapshot (a git commit
// the daemon took, cli/src/treeSnapshot.ts) to the conversation and turn it
// describes. The objects stay in the session's repository; this table only
// says which sha stands for the tree at the end of which turn.

import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthenticatedUserId } from "./pendingMessages";
import { requireUserOrToken } from "./lib/auth";
import { canAccessConversation } from "./lib/access";
import { REWIND_ROWS_CAP } from "@codecast/shared/contracts";
import type { Doc, Id } from "./_generated/dataModel";

const CHANGED_PATHS_CAP = 200;
const LIST_CAP = REWIND_ROWS_CAP;

const snapshotRow = v.object({
  conversation_id: v.id("conversations"),
  sha: v.string(),
  tree_sha: v.string(),
  base_sha: v.string(),
  prev_sha: v.optional(v.string()),
  branch: v.optional(v.string()),
  depth: v.number(),
  changed_paths: v.array(v.string()),
  changed_count: v.number(),
  dirty: v.boolean(),
  checkout_key: v.string(),
  // "prompt": the tree when a prompt was submitted, the start of its turn (a rewind's boundary).
  source: v.union(v.literal("turn"), v.literal("sweep"), v.literal("prompt")),
  taken_at: v.number(),
  turn_completed_at: v.optional(v.number()),
  took_ms: v.optional(v.number()),
  shared_sessions: v.optional(v.number()),
});

/**
 * The daemon records one or more rows after a snapshot: one per session that
 * shares the checkout. Idempotent on (conversation, sha, turn_completed_at):
 * a re-sent batch, or a sweep that found the tree unchanged since the turn,
 * writes nothing new. Only the sessions' runner may write (the daemon runs as
 * the owner of the sessions it watches).
 */
export const record = mutation({
  args: {
    api_token: v.string(),
    device_id: v.optional(v.string()),
    rows: v.array(snapshotRow),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed");
    let written = 0;
    for (const row of args.rows.slice(0, 50)) {
      const conversation = await ctx.db.get(row.conversation_id);
      if (!conversation || conversation.user_id.toString() !== userId.toString()) continue;
      const existing = await ctx.db
        .query("tree_snapshots")
        .withIndex("by_conversation_sha", (q) => q.eq("conversation_id", row.conversation_id).eq("sha", row.sha))
        .collect();
      // A prompt snapshot of an unchanged tree repeats the sha of the turn
      // before it; each prompt still needs its own row, as a rewind's boundary.
      const same = (e: { source: string; taken_at: number; turn_completed_at?: number }) =>
        row.source === "prompt" ? e.source === "prompt" && e.taken_at === row.taken_at : e.source !== "prompt" && (e.turn_completed_at ?? null) === (row.turn_completed_at ?? null);
      if (existing.some(same)) continue;
      await ctx.db.insert("tree_snapshots", {
        ...row,
        changed_paths: row.changed_paths.slice(0, CHANGED_PATHS_CAP),
        device_id: args.device_id,
      });
      written++;
    }
    return { written };
  },
});

/** Every snapshot of one conversation, oldest first: what `cast diff --turns` and the diff pane read. */
export const listForConversation = query({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) return [];
    // Prompt rows (a rewind's boundaries) have a cap of their own, so they do
    // not halve how far back the turns reach.
    const turns: Doc<"tree_snapshots">[] = [];
    const prompts: Doc<"tree_snapshots">[] = [];
    let scanned = 0;
    for await (const row of ctx.db
      .query("tree_snapshots")
      .withIndex("by_conversation_taken", (q) => q.eq("conversation_id", args.conversation_id))
      .order("desc")) {
      if (++scanned > LIST_CAP * 3) break;
      const into = row.source === "prompt" ? prompts : turns;
      if (into.length < LIST_CAP) into.push(row);
      if (turns.length >= LIST_CAP && prompts.length >= LIST_CAP) break;
    }
    // Prompt rows older than the oldest turn row returned would point at a stretch with no turns.
    const oldest = turns.length >= LIST_CAP ? turns[turns.length - 1].taken_at : -Infinity;
    return [...turns, ...prompts.filter((r) => r.taken_at >= oldest)].sort((a, b) => a.taken_at - b.taken_at);
  },
});

const EDITED_PATHS_CAP = 5_000;
const EDITED_TIMES_CAP = 1_000;

const OTHER_SESSIONS_CAP = 30;
const SIBLING_SCAN_CAP = 1_000;

/** One conversation's file changes after `after`, each path with its edit times oldest first. */
/** Rows one editedPaths call may read across all its scans, well inside Convex's per-function read limits. */
const READ_BUDGET = 16_000;

async function editsAfter(ctx: any, conversationId: Id<"conversations">, after: number, budget: { left: number }): Promise<{ edits: Array<{ path: string; at: number[] }>; complete: boolean }> {
  const out = new Map<string, number[]>();
  let complete = true;
  for await (const row of ctx.db
    .query("file_changes")
    .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conversationId).gt("timestamp", after))) {
    if (--budget.left < 0 || out.size > EDITED_PATHS_CAP) {
      complete = false;
      break;
    }
    if (row.change_type === "commit") continue;
    const times = out.get(row.file_path) ?? [];
    // A file edited many times: its first and last edits are what a rewind reads.
    if (times.length < EDITED_TIMES_CAP) times.push(row.timestamp);
    else times[times.length - 1] = row.timestamp;
    out.set(row.file_path, times);
  }
  return { edits: [...out].map(([path, at]) => ({ path, at })), complete };
}

/**
 * The files a conversation's own tool calls wrote, edited or deleted after
 * `after` (file_changes), each with its edit times: what a rewind counts as
 * this session's, and when (cli/src/rewindTree.ts). `complete` is false when
 * a cap cut the list: a rewind then refuses rather than leave files behind.
 *
 * The session's subagents count as the session. `others`: the same, for the
 * person's other sessions in the same checkout (git_root) over the stretch. A file one of them edited too is a
 * conflict, whatever the snapshots say. `synced_at`: when the conversation
 * last took a message, so a rewind can wait for the last turn's edits.
 */
export const editedPaths = query({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
    after: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const conversation = await ctx.db.get(args.conversation_id);
    // The runner only: `others` reads every session of theirs in the checkout, private ones included.
    if (!conversation || String(conversation.user_id) !== String(userId)) return { edits: [], complete: false, others: [], others_complete: false, synced_at: 0 };
    // The session's own edits include its subagents' (workers it ran in its
    // turns), newest first and only those active since the message. Forks and
    // agent-switch continuations share the parent pointer but are sessions of
    // their own, so they stay "others".
    const childRows = await ctx.db
      .query("conversations")
      .withIndex("by_parent_conversation_id", (q) => q.eq("parent_conversation_id", args.conversation_id))
      .order("desc")
      .take(SIBLING_SCAN_CAP);
    const subagents = childRows.filter((c) => c.is_subagent && (c.updated_at ?? 0) > args.after && (!conversation.git_root || c.git_root === conversation.git_root));
    // An isolated worker edits its own worktree; its files reach this checkout
    // when the daemon merges them back (subagentFleet merge_back), at that moment.
    const mergedBack = childRows.flatMap((c) =>
      c.is_subagent && c.merge_back?.state === "merged" && c.merge_back.at > args.after && conversation.git_root
        ? (c.merge_back.files ?? []).map((f) => ({ path: `${conversation.git_root}/${f}`, at: [c.merge_back!.at] }))
        : [],
    );
    const children = subagents.slice(0, OTHER_SESSIONS_CAP);
    const childrenComplete = subagents.length <= OTHER_SESSIONS_CAP && childRows.length < SIBLING_SCAN_CAP;
    const mine = new Set<string>([String(args.conversation_id), ...children.map((c) => String(c._id))]);
    const budget = { left: READ_BUDGET };
    const parts: Array<{ edits: Array<{ path: string; at: number[] }>; complete: boolean }> = [];
    for (const id of [args.conversation_id, ...children.map((c) => c._id)]) parts.push(await editsAfter(ctx, id, args.after, budget));
    const own = new Map<string, number[]>();
    for (const e of [...parts.flatMap((p) => p.edits), ...mergedBack]) own.set(e.path, [...(own.get(e.path) ?? []), ...e.at].sort((x, y) => x - y));
    const others: Array<{ path: string; at: number[] }> = [];
    let othersComplete = true;
    if (conversation.git_root) {
      // Every session of the person's that moved since the message, whenever it started.
      const moved = await ctx.db
        .query("conversations")
        .withIndex("by_user_updated", (q) => q.eq("user_id", conversation.user_id).gt("updated_at", args.after))
        .take(SIBLING_SCAN_CAP);
      if (moved.length >= SIBLING_SCAN_CAP) othersComplete = false;
      const siblings = moved.filter((c) => c.git_root === conversation.git_root && !mine.has(String(c._id)));
      if (siblings.length > OTHER_SESSIONS_CAP) othersComplete = false;
      for (const c of siblings.slice(0, OTHER_SESSIONS_CAP)) {
        const part = await editsAfter(ctx, c._id, args.after, budget);
        if (!part.complete) othersComplete = false;
        others.push(...part.edits);
      }
    }
    return {
      edits: [...own].map(([path, at]) => ({ path, at })),
      complete: childrenComplete && parts.every((p) => p.complete),
      others,
      others_complete: othersComplete,
      // The newest message that reached the server: the last turn's edits ride on it.
      synced_at: (await ctx.db.query("messages").withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", args.conversation_id)).order("desc").first())?.timestamp ?? 0,
    };
  },
});


/**
 * The daemon that holds a session's checkout says what rewind is staged there
 * ("Rewind to here", cli/src/rewindTree.ts), or that none is. The row is the
 * one home of that fact for every window's Put back chip. Only the session's
 * runner may write it.
 */
export const reportRewindStaged = mutation({
  args: {
    api_token: v.string(),
    conversation_id: v.id("conversations"),
    staged: v.union(v.null(), v.object({ id: v.string(), files: v.number(), staged_at: v.number(), at: v.number() })),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed");
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || conversation.user_id.toString() !== userId.toString()) return { written: false };
    const prev = conversation.rewind_staged ?? null;
    if (JSON.stringify(prev) === JSON.stringify(args.staged)) return { written: false };
    await ctx.db.patch(args.conversation_id, { rewind_staged: args.staged });
    return { written: true };
  },
});
