import {
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./functions";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { contentLinesToMatch, MAX_CONTENT_LINES } from "@codecast/shared/blame";
import { checkConversationAccess } from "./privacy";
import {
  extractCommitHashFromContent,
  extractFileChanges,
  hasFileChangeToolCall,
} from "./fileChanges/extractor";
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
const MAX_UNCOMMITTED_LINES = MAX_CONTENT_LINES;
// Row budget for the uncommitted-line content match. new_content can be a
// whole file (Write rows), so reading too many recent edits risks the query
// byte limit; uncommitted code is recent by definition, so a small window of
// the newest edits to the file is enough.
const MAX_FILE_EDIT_ROWS = 80;

export type SessionRef = {
  conversation_id: Id<"conversations">;
  short_id?: string;
  title: string;
  author_name?: string;
  author_image?: string;
};

// How a line reached its session. `commit`: the commits table names the
// session (daemon publish or webhook). `hash`: a file_changes commit row whose
// stored short hash prefixes the sha. `subject`: a commit row matched by
// subject line and time. `edit`: the line's text found in an edit the session
// made, which is the authoring session even when a different one committed.
export type BlameVia = "commit" | "hash" | "subject" | "edit";

export type ResolvedSession = SessionRef & { message_id?: Id<"messages">; via: BlameVia };

export type CommitDescriptor = { sha: string; summary?: string; author_time?: number };

type ResolveCaches = {
  conversations: Map<string, Doc<"conversations"> | null>;
  users: Map<string, { name?: string; image?: string }>;
};

export function newResolveCaches(): ResolveCaches {
  return { conversations: new Map(), users: new Map() };
}

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
  users: ResolveCaches["users"],
): Promise<SessionRef> {
  const userKey = conv.user_id.toString();
  if (!users.has(userKey)) {
    const user = await ctx.db.get(conv.user_id);
    users.set(userKey, { name: user?.name ?? undefined, image: user?.image ?? undefined });
  }
  const user = users.get(userKey)!;
  return {
    conversation_id: conv._id,
    short_id: conv.short_id ?? undefined,
    title: conv.title || "Untitled",
    author_name: user.name,
    author_image: user.image,
  };
}

/**
 * The session behind each commit sha, for a caller who may see it.
 *
 * Three sources, cheapest and surest first. The commits table names a session
 * outright when the daemon that made the commit published it. Sessions also
 * record every commit they run as a file_changes row whose stored hash is the
 * short prefix git printed, so a range scan over [sha7, sha] finds it. When
 * neither names the sha (compound commands print no hash; a rebase rewrites
 * it) a commit row with the same subject inside a short time window is taken.
 */
export async function resolveCommitSessions(
  ctx: { db: any },
  userId: Id<"users">,
  descriptors: CommitDescriptor[],
  caches: ResolveCaches = newResolveCaches(),
): Promise<Record<string, ResolvedSession>> {
  const byKey = new Map<string, CommitDescriptor>();
  for (const d of descriptors) byKey.set(d.sha.toLowerCase(), d);
  const shas = [...byKey.keys()].filter(isValidBlameSha).slice(0, MAX_SHAS);

  const resolved: Record<string, ResolvedSession> = {};
  for (const sha of shas) {
    const desc = byKey.get(sha)!;
    let conv: Doc<"conversations"> | null = null;
    let messageId: Id<"messages"> | undefined;
    let via: BlameVia = "commit";

    const named = await ctx.db
      .query("commits")
      .withIndex("by_sha", (q: any) => q.eq("sha", sha))
      .collect();
    for (const row of named) {
      if (!row.conversation_id) continue;
      conv = await accessibleConversation(ctx, userId, caches.conversations, row.conversation_id);
      if (conv) break;
    }

    if (!conv) {
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
        if (await accessibleConversation(ctx, userId, caches.conversations, row.conversation_id))
          accessible.push(row);
      }
      const best = pickRowForSha(sha, accessible);
      if (best) {
        conv = caches.conversations.get(best.conversation_id.toString()) ?? null;
        messageId = best.message_id as Id<"messages">;
        via = "hash";
      }
    }

    if (!conv && desc.summary && desc.author_time) {
      // Subject match is cheap, so filter before paying for access checks.
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
        const candidate = await accessibleConversation(
          ctx,
          userId,
          caches.conversations,
          row.conversation_id as Id<"conversations">,
        );
        if (candidate) {
          conv = candidate;
          messageId = row.message_id as Id<"messages">;
          via = "subject";
          break;
        }
      }
    }

    if (conv) {
      resolved[sha] = { ...(await sessionRefFor(ctx, conv, caches.users)), message_id: messageId, via };
    }
  }
  return resolved;
}

/**
 * The session whose edit wrote each line, found by text.
 *
 * A session's edits to the file are stored with their new content, so a line
 * that appears verbatim in one of them was written there. This is the
 * authoring session, which beats the committing one: in a workflow where one
 * session commits everyone's work, the reasoning behind a line lives in the
 * session that typed it. Rows are matched newest first under each line's
 * deadline, so a later rewrite cannot claim an older line.
 */
export async function matchFileLines(
  ctx: { db: any },
  userId: Id<"users">,
  filePaths: string[],
  lines: MatchLine[],
  caches: ResolveCaches = newResolveCaches(),
): Promise<Array<ResolvedSession & { line: string }>> {
  // Array of {line, ...} pairs, NOT a Record keyed by line text — Convex
  // field names must be ASCII, and source lines contain anything.
  const matches: Array<ResolvedSession & { line: string }> = [];
  const wanted = lines.slice(0, MAX_UNCOMMITTED_LINES);
  if (wanted.length === 0 || filePaths.length === 0) return matches;

  const editRows: (EditRowLite & { message_id: Id<"messages"> })[] = [];
  for (const filePath of filePaths) {
    const recentEdits = await ctx.db
      .query("file_changes")
      .withIndex("by_file_path", (q: any) => q.eq("file_path", filePath))
      .order("desc")
      .take(MAX_FILE_EDIT_ROWS);
    for (const row of recentEdits) {
      if (row.change_type !== "edit" && row.change_type !== "write") continue;
      if (await accessibleConversation(ctx, userId, caches.conversations, row.conversation_id))
        editRows.push(row);
    }
  }

  for (const [line, row] of matchLinesToEdits(wanted, editRows)) {
    const conv = caches.conversations.get(row.conversation_id.toString())!;
    matches.push({
      line,
      ...(await sessionRefFor(ctx, conv, caches.users)),
      message_id: (row as EditRowLite & { message_id: Id<"messages"> }).message_id,
      via: "edit",
    });
  }
  return matches;
}

/**
 * Resolve git blame output to codecast sessions. The CLI sends the unique
 * full SHAs from `git blame --porcelain` (plus, optionally, the texts of
 * uncommitted lines); this maps each to the conversation that produced it.
 *
 * SHAs resolve through the shared resolver (commits table, stored commit
 * hashes, subject + time), visible if the caller owns the conversation or is
 * on its team. Uncommitted lines resolve by content match against recent
 * edits to the file — uncommitted code is local to the caller's machine, so
 * the caller's own sessions are the ones that can have written it.
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
    const caches = newResolveCaches();

    const resolved = await resolveCommitSessions(
      ctx,
      userId,
      [...(args.shas ?? []).map((sha) => ({ sha })), ...(args.commits ?? [])],
      caches,
    );

    const lines: MatchLine[] = [
      ...(args.uncommitted_lines ?? []).map((text) => ({ text })),
      ...(args.content_lines ?? []).map((l) => ({ text: l.t, deadline: l.d })),
    ];
    const lineMatches = args.file_path
      ? await matchFileLines(ctx, userId, [args.file_path], lines, caches)
      : [];

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
      .take(5000);
    return {
      rows_with_hash: withHash.length,
      capped: withHash.length === 5000,
    };
  },
});

// Process one page of messages for the historical materialization backfill:
// for each message that carries edit/write/commit tool calls, insert the
// file_changes rows it should have produced at ingest (and repair commit rows
// whose subject the old heredoc-blind extractor mis-parsed). Idempotent —
// skips change_keys that already exist. Commit rows land hash-less here (the
// hash is in the NEXT message's result); backfillCommitHashes fills them after.
async function materializeMessagePage(
  ctx: MutationCtx,
  cursor: string | null,
  numItems: number,
): Promise<{ inserted: number; repaired: number; scanned: number; cursor: string | null; done: boolean }> {
  // Exactly one paginate() per invocation — Convex forbids more. Throughput is
  // tuned via numItems + the scheduler hop, not by looping pages here.
  const page = await ctx.db.query("messages").paginate({ numItems, cursor });

  let inserted = 0;
  let repaired = 0;
  for (const m of page.page) {
    try {
      const msg = {
        _id: m._id,
        timestamp: m.timestamp,
        tool_calls: m.tool_calls,
        tool_results: m.tool_results,
      };
      if (!hasFileChangeToolCall(msg)) continue;
      for (const fc of extractFileChanges([msg])) {
        const existing = await ctx.db
          .query("file_changes")
          .withIndex("by_conversation_change_key", (q) =>
            q.eq("conversation_id", m.conversation_id).eq("change_key", fc.id),
          )
          .first();
        if (existing) {
          if (
            existing.change_type === "commit" &&
            fc.commitMessage &&
            existing.commit_message !== fc.commitMessage
          ) {
            await ctx.db.patch(existing._id, { commit_message: fc.commitMessage });
            repaired++;
          }
          continue;
        }
        await ctx.db.insert("file_changes", {
          conversation_id: m.conversation_id,
          change_key: fc.id,
          message_id: m._id,
          tool_call_id: fc.toolCallId,
          seq: fc.sequenceIndex,
          file_path: fc.filePath,
          change_type: fc.changeType,
          old_content: fc.oldContent,
          new_content: fc.newContent,
          commit_message: fc.commitMessage,
          commit_hash: fc.commitHash,
          timestamp: fc.timestamp,
        });
        inserted++;
      }
    } catch {
      // One unparseable message must not sink the crawl.
    }
  }

  return {
    inserted,
    repaired,
    scanned: page.page.length,
    cursor: page.continueCursor,
    done: page.isDone,
  };
}

// Materialize one conversation by short id (verification before the global
// run). Returns what it inserted. Run:
//   npx convex run blame:materializeOneConversation '{"short_id":"jx74qbm"}'
export const materializeOneConversation = internalMutation({
  args: { short_id: v.string() },
  handler: async (ctx, args) => {
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_short_id", (q: any) => q.eq("short_id", args.short_id))
      .first();
    if (!conv) return { found: false };

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
      .collect();
    messages.sort((a, b) => a.timestamp - b.timestamp);

    // tool_use_id -> commit hash, from every result (the hash lands on the
    // message AFTER the git commit call).
    const hashByToolId = new Map<string, string>();
    for (const m of messages) {
      for (const tr of m.tool_results ?? []) {
        if (tr.is_error || !tr.tool_use_id) continue;
        const h = extractCommitHashFromContent(tr.content ?? "");
        if (h) hashByToolId.set(tr.tool_use_id, h);
      }
    }

    let inserted = 0;
    let repaired = 0;
    const samples: Array<{ type: string; path: string; hash: string | null }> = [];
    for (const m of messages) {
      const msg = {
        _id: m._id,
        timestamp: m.timestamp,
        tool_calls: m.tool_calls,
        tool_results: m.tool_results,
      };
      if (!hasFileChangeToolCall(msg)) continue;
      for (const fc of extractFileChanges([msg])) {
        const existing = await ctx.db
          .query("file_changes")
          .withIndex("by_conversation_change_key", (q) =>
            q.eq("conversation_id", conv._id).eq("change_key", fc.id),
          )
          .first();
        const hash = fc.commitHash ?? (fc.toolCallId ? hashByToolId.get(fc.toolCallId) : undefined);
        if (existing) {
          const patch: Record<string, unknown> = {};
          if (
            existing.change_type === "commit" &&
            fc.commitMessage &&
            existing.commit_message !== fc.commitMessage
          )
            patch.commit_message = fc.commitMessage;
          if (existing.change_type === "commit" && !existing.commit_hash && hash)
            patch.commit_hash = hash;
          if (Object.keys(patch).length) {
            await ctx.db.patch(existing._id, patch);
            repaired++;
          }
          continue;
        }
        await ctx.db.insert("file_changes", {
          conversation_id: conv._id,
          change_key: fc.id,
          message_id: m._id,
          tool_call_id: fc.toolCallId,
          seq: fc.sequenceIndex,
          file_path: fc.filePath,
          change_type: fc.changeType,
          old_content: fc.oldContent,
          new_content: fc.newContent,
          commit_message: fc.commitMessage,
          commit_hash: hash,
          timestamp: fc.timestamp,
        });
        inserted++;
        if (samples.length < 6)
          samples.push({ type: fc.changeType, path: fc.filePath.slice(-40), hash: hash ?? null });
      }
    }
    return { found: true, messages: messages.length, inserted, repaired, samples };
  },
});

/**
 * Historical materialization: create the file_changes rows for messages that
 * were synced before materializeFileChanges ran on ingest (or through a path
 * that skipped it). Without this, blame can't attribute lines from those
 * sessions — the union-mobile case.
 *
 * Self-scheduling so it survives a full-table sweep without hitting any single
 * function's time limit (a one-shot action driver times out / drops the
 * connection mid-run). Each invocation does one page then schedules the next;
 * when the messages table is exhausted it kicks off the commit-hash fill.
 * Idempotent — safe to re-run; it skips already-materialized change_keys. Run:
 *   npx convex run blame:backfillMaterialize
 */
export const backfillMaterialize = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    inserted: v.optional(v.number()),
    repaired: v.optional(v.number()),
    scanned: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // One paginate per invocation (Convex limit). 400 messages amortizes the
    // scheduler hop without risking the mutation read-size budget — most
    // messages have no edit/commit tool calls, so the per-row work is cheap.
    const r = await materializeMessagePage(ctx, args.cursor ?? null, 400);
    const inserted = (args.inserted ?? 0) + r.inserted;
    const repaired = (args.repaired ?? 0) + r.repaired;
    const scanned = (args.scanned ?? 0) + r.scanned;

    if (!r.done) {
      await ctx.scheduler.runAfter(0, internal.blame.backfillMaterialize, {
        cursor: r.cursor,
        inserted,
        repaired,
        scanned,
      });
    } else {
      console.log(
        `backfillMaterialize done: ${scanned} messages, ${inserted} inserted, ${repaired} repaired. Filling hashes…`,
      );
      await ctx.scheduler.runAfter(0, internal.blame.backfillCommitHashes, {});
    }
    return { scanned, inserted, repaired, done: r.done };
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
// One page of the commit-hash fill: for each hash-less commit row, scan a few
// messages forward from its timestamp for the `git commit` result and patch in
// the parsed `[branch hash]`. One paginate() per call (Convex limit).
async function commitHashPage(
  ctx: MutationCtx,
  cursor: string | null,
): Promise<{ patched: number; scanned: number; cursor: string | null; done: boolean }> {
  const page = await ctx.db.query("file_changes").paginate({ numItems: 300, cursor });

  let patched = 0;
  for (const row of page.page) {
    try {
      if (row.change_type !== "commit" || row.commit_hash) continue;
      const toolCallId = row.tool_call_id ?? row.change_key;
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
}

/**
 * Fill commit_hash on hash-less commit rows. Self-scheduling (one page per hop)
 * so it survives the full file_changes table without hitting a function time
 * limit — a one-shot action driver dies with "upstream error" partway. Chained
 * automatically at the end of backfillMaterialize; also runnable directly:
 *   npx convex run blame:backfillCommitHashes
 */
export const backfillCommitHashes = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    patched: v.optional(v.number()),
    scanned: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const r = await commitHashPage(ctx, args.cursor ?? null);
    const patched = (args.patched ?? 0) + r.patched;
    const scanned = (args.scanned ?? 0) + r.scanned;
    if (!r.done) {
      await ctx.scheduler.runAfter(0, internal.blame.backfillCommitHashes, {
        cursor: r.cursor,
        patched,
        scanned,
      });
    } else {
      console.log(`backfillCommitHashes done: scanned ${scanned}, patched ${patched}`);
    }
    return { scanned, patched, done: r.done };
  },
});
