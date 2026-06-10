import { query, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { checkConversationAccess } from "./privacy";
import { extractCommitHashFromContent } from "./fileChanges/extractor";
import {
  CommitRowLite,
  EditRowLite,
  MatchLine,
  MIN_SHA_PREFIX,
  SUMMARY_MATCH_WINDOW_MS,
  isValidBlameSha,
  matchLinesToEdits,
  pickRowForSha,
  rankRowsBySummary,
} from "./blameCore";

const MAX_SHAS = 500;
const MAX_UNCOMMITTED_LINES = 400;
// Row budget for the uncommitted-line content match. new_content can be a
// whole file (Write rows), so reading too many recent edits risks the query
// byte limit; uncommitted code is recent by definition, so a small window of
// the newest edits to the file is enough.
const MAX_FILE_EDIT_ROWS = 80;

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
    // Bare SHAs resolve via stored commit hashes only; entries in `commits`
    // additionally carry the blame porcelain's summary + author-time (ms) for
    // the subject/timestamp fallback.
    shas: v.optional(v.array(v.string())),
    commits: v.optional(
      v.array(
        v.object({
          sha: v.string(),
          summary: v.optional(v.string()),
          author_time: v.optional(v.number()),
        }),
      ),
    ),
    file_path: v.optional(v.string()),
    uncommitted_lines: v.optional(v.array(v.string())),
    // Line texts to attribute by content match against the file's edit rows.
    // `d` (ms) caps how new a claiming edit may be — committed lines pass
    // commit-time + slack so the authoring edit matches but later rewrites
    // can't steal the line. Uncommitted lines omit it.
    content_lines: v.optional(
      v.array(v.object({ t: v.string(), d: v.optional(v.number()) })),
    ),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) {
      return { error: "Unauthorized" };
    }
    const userId = auth.userId;

    const descriptors = new Map<string, { summary?: string; author_time?: number }>();
    for (const sha of args.shas ?? []) descriptors.set(sha.toLowerCase(), {});
    for (const c of args.commits ?? []) {
      descriptors.set(c.sha.toLowerCase(), { summary: c.summary, author_time: c.author_time });
    }
    const shas = [...descriptors.keys()].filter(isValidBlameSha).slice(0, MAX_SHAS);

    const convCache = new Map<string, Doc<"conversations"> | null>();
    const userNames = new Map<string, string | undefined>();

    const resolved: Record<string, SessionRef & { message_id: Id<"messages"> }> = {};
    for (const sha of shas) {
      // Precise path: stored hashes are short prefixes of the full SHA, so
      // every stored prefix of `sha` sorts within [sha7, sha]. Same-prefix
      // non-matches can land in the range too; pickRowForSha verifies with
      // startsWith.
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
      let best: CommitRowLite | null = pickRowForSha(sha, accessible);

      // Fallback: sessions often commit via compound commands whose output
      // carries no `[branch hash]` line, so the row stores only the parsed
      // commit message. Match by subject + timestamp proximity (also survives
      // rebase/amend, which rewrite the sha but keep the subject). Subject
      // match is cheap, so filter before paying for access checks.
      const desc = descriptors.get(sha);
      if (!best && desc?.summary && desc.author_time) {
        const windowRows = await ctx.db
          .query("file_changes")
          .withIndex("by_type_timestamp", (q: any) =>
            q
              .eq("change_type", "commit")
              .gte("timestamp", desc.author_time! - SUMMARY_MATCH_WINDOW_MS)
              .lte("timestamp", desc.author_time! + SUMMARY_MATCH_WINDOW_MS),
          )
          .take(400);
        for (const row of rankRowsBySummary(desc.summary, desc.author_time, windowRows)) {
          const conv = await accessibleConversation(
            ctx,
            userId,
            convCache,
            row.conversation_id as Id<"conversations">,
          );
          if (conv) {
            best = row;
            break;
          }
        }
      }

      if (best) {
        const conv = convCache.get(best.conversation_id.toString())!;
        resolved[sha] = {
          ...(await sessionRefFor(ctx, conv, userNames)),
          message_id: best.message_id as Id<"messages">,
        };
      }
    }

    // Array of {line, ...} pairs, NOT a Record keyed by line text — Convex
    // field names must be ASCII, and source lines contain anything.
    const lineMatches: Array<SessionRef & { line: string; message_id: Id<"messages"> }> = [];
    const lines: MatchLine[] = [
      ...(args.uncommitted_lines ?? []).map((text) => ({ text })),
      ...(args.content_lines ?? []).map((l) => ({ text: l.t, deadline: l.d })),
    ].slice(0, MAX_UNCOMMITTED_LINES);
    if (args.file_path && lines.length > 0) {
      const recentEdits = await ctx.db
        .query("file_changes")
        .withIndex("by_file_path", (q: any) => q.eq("file_path", args.file_path))
        .order("desc")
        .take(MAX_FILE_EDIT_ROWS);

      const editRows: (EditRowLite & { message_id: Id<"messages"> })[] = [];
      for (const row of recentEdits) {
        if (row.change_type !== "edit" && row.change_type !== "write") continue;
        const conv = await accessibleConversation(ctx, userId, convCache, row.conversation_id);
        if (conv) editRows.push(row);
      }

      const matches = matchLinesToEdits(lines, editRows);
      for (const [line, row] of matches) {
        const conv = convCache.get(row.conversation_id.toString())!;
        lineMatches.push({
          line,
          ...(await sessionRefFor(ctx, conv, userNames)),
          message_id: (row as EditRowLite & { message_id: Id<"messages"> }).message_id,
        });
      }
    }

    return { resolved, line_matches: lineMatches };
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

// One-case debug: for a recent hash-less commit row, show the forward message
// window the backfill scans — who has tool_results, and what they contain.
// Run: npx convex run blame:debugCommitRow '{"contains":"wire the git-blame"}'
export const debugCommitRow = internalQuery({
  args: { contains: v.string() },
  handler: async (ctx, args) => {
    const recent = await ctx.db.query("file_changes").order("desc").take(3000);
    const row = recent.find(
      (r) => r.change_type === "commit" && r.commit_message?.includes(args.contains),
    );
    if (!row) return { found: false };
    const windowMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q: any) =>
        q.eq("conversation_id", row.conversation_id).gte("timestamp", row.timestamp),
      )
      .take(12);
    return {
      found: true,
      row: {
        change_key: row.change_key,
        tool_call_id: row.tool_call_id,
        commit_hash: row.commit_hash ?? null,
        timestamp: row.timestamp,
        message_id: row.message_id,
      },
      window: windowMessages.map((m: any) => ({
        id: m._id,
        role: m.role,
        timestamp: m.timestamp,
        tool_result_ids: (m.tool_results ?? []).map((tr: any) => tr.tool_use_id),
        tool_result_snippets: (m.tool_results ?? []).map((tr: any) =>
          (tr.content ?? "").slice(0, 120),
        ),
      })),
    };
  },
});

// Debug: what edit rows exist for a file path (the uncommitted-match input).
// Run: npx convex run blame:debugFileEdits '{"file_path":"/abs/path"}'
export const debugFileEdits = internalQuery({
  args: { file_path: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("file_changes")
      .withIndex("by_file_path", (q: any) => q.eq("file_path", args.file_path))
      .order("desc")
      .take(5);
    return rows.map((r) => ({
      change_type: r.change_type,
      conversation_id: r.conversation_id,
      timestamp: r.timestamp,
      content_len: r.new_content?.length ?? 0,
      head: (r.new_content ?? "").slice(0, 60),
    }));
  },
});

/**
 * Backfill commit_hash on existing file_changes commit rows. Two reasons they
 * are hash-less historically: the original extractor regex required the whole
 * `[...]` to be hex (git prints `[branch abc1234]`), and the Bash RESULT
 * carrying the hash lands on the message AFTER the one that materialized the
 * row. For each hash-less commit row, scan the conversation's messages from
 * the row's timestamp forward for the matching tool_result and patch the hash.
 * Self-schedules until the table is exhausted; kick off with:
 *   npx convex run blame:backfillCommitHashes
 */
export const backfillCommitHashesPage = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("file_changes")
      .paginate({ numItems: 200, cursor: args.cursor ?? null });

    let patched = 0;
    for (const row of page.page) {
      try {
        if (row.change_type !== "commit" || row.commit_hash) continue;
        const toolCallId = row.tool_call_id ?? row.change_key;
        // The result usually arrives on the next user message — a handful of
        // messages from the row's own timestamp forward covers it.
        const windowMessages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (q: any) =>
            q.eq("conversation_id", row.conversation_id).gte("timestamp", row.timestamp),
          )
          .take(12);
        for (const message of windowMessages) {
          const result = message.tool_results?.find(
            (tr: any) => tr.tool_use_id === toolCallId && !tr.is_error,
          );
          if (!result) continue;
          const hash = extractCommitHashFromContent(result.content ?? "");
          if (hash) {
            await ctx.db.patch(row._id, { commit_hash: hash });
            patched++;
          }
          break;
        }
      } catch {
        // One unreadable row must not sink the crawl.
      }
    }

    return { patched, scanned: page.page.length, cursor: page.continueCursor, done: page.isDone };
  },
});

// Drives the page mutation across the whole table in one observable run:
//   npx convex run blame:backfillCommitHashes
// (An earlier runAfter(0)-chained version died silently mid-table — one
// failed run breaks a self-scheduling chain with nothing left to watch.)
export const backfillCommitHashes = internalAction({
  args: {},
  handler: async (ctx) => {
    let cursor: string | null = null;
    let scanned = 0;
    let patched = 0;
    let pages = 0;
    for (;;) {
      const result: { patched: number; scanned: number; cursor: string | null; done: boolean } =
        await ctx.runMutation(internal.blame.backfillCommitHashesPage, { cursor });
      scanned += result.scanned;
      patched += result.patched;
      cursor = result.cursor;
      pages++;
      if (pages % 25 === 0) {
        console.log(`backfillCommitHashes: ${scanned} scanned, ${patched} patched`);
      }
      if (result.done) break;
    }
    console.log(`backfillCommitHashes done: scanned ${scanned}, patched ${patched}`);
    return { scanned, patched };
  },
});
