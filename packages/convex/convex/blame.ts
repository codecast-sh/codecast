import { query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { checkConversationAccess } from "./privacy";
import { extractFileChanges } from "./fileChanges/extractor";
import {
  CommitRowLite,
  EditRowLite,
  MIN_SHA_PREFIX,
  isValidBlameSha,
  matchUncommittedLines,
  pickRowForSha,
} from "./blameCore";

const MAX_SHAS = 500;
const MAX_UNCOMMITTED_LINES = 400;
// Caps for the uncommitted-line content match: candidate conversations come
// from the caller's file_touches, and each contributes its most recent edit
// rows. new_content can be a whole file (Write), so keep the row budget tight.
const MAX_TOUCH_CONVERSATIONS = 8;
const MAX_ROWS_PER_CONVERSATION = 150;

type SessionRef = {
  conversation_id: Id<"conversations">;
  title: string;
  author_name?: string;
};

async function accessibleConversation(
  ctx: { db: any },
  userId: Id<"users">,
  cache: Map<string, Doc<"conversations"> | null>,
  conversationId: Id<"conversations">,
): Promise<Doc<"conversations"> | null> {
  const key = conversationId.toString();
  if (cache.has(key)) return cache.get(key) ?? null;
  const conv = await ctx.db.get(conversationId);
  let visible: Doc<"conversations"> | null = null;
  if (conv) {
    const access = await checkConversationAccess(ctx, userId, conv);
    if (access === "owner" || access === "team") visible = conv;
  }
  cache.set(key, visible);
  return visible;
}

async function sessionRefFor(
  ctx: { db: any },
  conv: Doc<"conversations">,
  userNames: Map<string, string | undefined>,
): Promise<SessionRef> {
  const userKey = conv.user_id.toString();
  if (!userNames.has(userKey)) {
    const user = await ctx.db.get(conv.user_id);
    userNames.set(userKey, user?.name ?? undefined);
  }
  return {
    conversation_id: conv._id,
    title: conv.title || "Untitled",
    author_name: userNames.get(userKey),
  };
}

/**
 * Resolve git blame output to codecast sessions. The CLI sends the unique
 * full SHAs from `git blame --porcelain` (plus, optionally, the texts of
 * uncommitted lines); this maps each to the conversation that produced it.
 *
 * SHAs resolve through file_changes commit rows (short hash parsed from the
 * `git commit` tool output at ingest), visible if the caller owns the
 * conversation or is on its team. Uncommitted lines resolve by content match
 * against the caller's own recent edits to the file — uncommitted code is
 * local to the caller's machine, so self-scope is correct, not a shortcut.
 */
export const resolveBlame = query({
  args: {
    api_token: v.string(),
    shas: v.array(v.string()),
    file_path: v.optional(v.string()),
    uncommitted_lines: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) {
      return { error: "Unauthorized" };
    }
    const userId = auth.userId;

    const shas = [...new Set(args.shas.map((s) => s.toLowerCase()))]
      .filter(isValidBlameSha)
      .slice(0, MAX_SHAS);

    const convCache = new Map<string, Doc<"conversations"> | null>();
    const userNames = new Map<string, string | undefined>();

    const resolved: Record<string, SessionRef & { message_id: Id<"messages"> }> = {};
    for (const sha of shas) {
      // Stored hashes are short prefixes of the full SHA, so every stored
      // prefix of `sha` sorts within [sha7, sha]. Same-prefix non-matches can
      // land in the range too; pickRowForSha verifies with startsWith.
      const prefix = sha.slice(0, MIN_SHA_PREFIX);
      const candidates = await ctx.db
        .query("file_changes")
        .withIndex("by_commit_hash", (q: any) =>
          q.gte("commit_hash", prefix).lte("commit_hash", sha),
        )
        .collect();
      const accessible: CommitRowLite[] = [];
      for (const row of candidates) {
        const conv = await accessibleConversation(ctx, userId, convCache, row.conversation_id);
        if (conv) accessible.push(row);
      }
      const best = pickRowForSha(sha, accessible);
      if (best) {
        const conv = convCache.get(best.conversation_id.toString())!;
        resolved[sha] = {
          ...(await sessionRefFor(ctx, conv, userNames)),
          message_id: best.message_id as Id<"messages">,
        };
      }
    }

    const uncommitted: Record<string, SessionRef & { message_id: Id<"messages"> }> = {};
    const lines = (args.uncommitted_lines ?? []).slice(0, MAX_UNCOMMITTED_LINES);
    if (args.file_path && lines.length > 0) {
      const touches = await ctx.db
        .query("file_touches")
        .withIndex("by_user_file", (q: any) =>
          q.eq("user_id", userId).eq("file_path", args.file_path),
        )
        .order("desc")
        .take(50);
      const convIds: Id<"conversations">[] = [];
      for (const t of touches) {
        if (t.operation !== "edit" && t.operation !== "write") continue;
        if (convIds.some((id) => id.toString() === t.conversation_id.toString())) continue;
        convIds.push(t.conversation_id);
        if (convIds.length >= MAX_TOUCH_CONVERSATIONS) break;
      }

      const editRows: (EditRowLite & { message_id: Id<"messages"> })[] = [];
      for (const convId of convIds) {
        const conv = await accessibleConversation(ctx, userId, convCache, convId);
        if (!conv) continue;
        const rows = await ctx.db
          .query("file_changes")
          .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", convId))
          .order("desc")
          .take(MAX_ROWS_PER_CONVERSATION);
        for (const row of rows) {
          if (row.file_path !== args.file_path) continue;
          if (row.change_type !== "edit" && row.change_type !== "write") continue;
          editRows.push(row);
        }
      }

      const matches = matchUncommittedLines(lines, editRows);
      for (const [line, row] of matches) {
        const conv = convCache.get(row.conversation_id.toString())!;
        uncommitted[line] = {
          ...(await sessionRefFor(ctx, conv, userNames)),
          message_id: (row as EditRowLite & { message_id: Id<"messages"> }).message_id,
        };
      }
    }

    return { resolved, uncommitted };
  },
});

// Operational visibility for the blame join: how many commit rows carry a
// resolvable hash. Run: npx convex run blame:commitRowStats
export const commitRowStats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const withHash = await ctx.db
      .query("file_changes")
      .withIndex("by_commit_hash", (q: any) => q.gt("commit_hash", ""))
      .order("desc")
      .take(1000);
    const sample = withHash.slice(0, 5).map((r) => ({
      hash: r.commit_hash,
      conversation_id: r.conversation_id,
      timestamp: r.timestamp,
    }));

    // Recent commit-type rows regardless of hash, plus what their source
    // message's tool result actually contains — shows why extraction hits or
    // misses.
    const recent = await ctx.db.query("file_changes").order("desc").take(3000);
    const commitRows = recent.filter((r) => r.change_type === "commit");
    const probes: Array<Record<string, unknown>> = [];
    for (const row of commitRows.slice(0, 3)) {
      const message = await ctx.db.get(row.message_id);
      const result = message?.tool_results?.find(
        (tr: any) => tr.tool_use_id === row.tool_call_id,
      );
      probes.push({
        hash: row.commit_hash ?? null,
        commit_message: row.commit_message?.slice(0, 60),
        tool_result_snippet: result?.content?.slice(0, 200) ?? null,
      });
    }
    return {
      rows_with_hash: withHash.length,
      capped: withHash.length === 1000,
      sample,
      commit_rows_in_recent_3000: commitRows.length,
      probes,
    };
  },
});

/**
 * Backfill commit_hash on existing file_changes commit rows. The original
 * extractor regex required the whole `[...]` to be hex, but git prints
 * `[branch abc1234]`, so historical rows materialized hash-less. Re-runs the
 * (fixed) extractor against each row's source message and patches the hash in.
 * Self-schedules until the table is exhausted; kick off with:
 *   npx convex run blame:backfillCommitHashes
 */
export const backfillCommitHashes = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    patched: v.optional(v.number()),
    scanned: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("file_changes")
      .paginate({ numItems: 200, cursor: args.cursor ?? null });

    let patched = args.patched ?? 0;
    for (const row of page.page) {
      if (row.change_type !== "commit" || row.commit_hash) continue;
      const message = await ctx.db.get(row.message_id);
      if (!message) continue;
      const extracted = extractFileChanges([
        {
          _id: message._id,
          timestamp: message.timestamp,
          tool_calls: message.tool_calls,
          tool_results: message.tool_results,
        },
      ]).find((fc) => fc.id === row.change_key);
      if (extracted?.commitHash) {
        await ctx.db.patch(row._id, { commit_hash: extracted.commitHash });
        patched++;
      }
    }

    const scanned = (args.scanned ?? 0) + page.page.length;
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.blame.backfillCommitHashes, {
        cursor: page.continueCursor,
        patched,
        scanned,
      });
    } else {
      console.log(`backfillCommitHashes done: scanned ${scanned}, patched ${patched}`);
    }
    return { scanned, patched, done: page.isDone };
  },
});
