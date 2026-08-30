import { mutation, query, internalMutation, type MutationCtx } from "./functions";
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { maybeScheduleTitleGeneration } from "./titleGeneration";
import { canTeamMemberAccess, checkConversationAccess, teamVisibleConvTeam } from "./privacy";
import { computeWorkspaceKey } from "./lib/access";
import { redactSecrets } from "./redact";
import { canSendProductMessage, markPendingDelivered } from "./pendingMessages";
import { maybeRecordUserSend } from "./lib/userSend";
import { validateCommandId } from "./localFirstCommands";
import {
  MESSAGES_VIEW_CONTRACT_ID,
  messagesGrantKey,
  messagesViewKey,
} from "./messageViewContracts";
import {
  forbiddenView,
  missingView,
  unauthenticatedView,
} from "./smallViewContracts";
import { onFreshApiErrorPark } from "./accountSwitch";
import { batchHasLoopEvent, deriveLoopState } from "./loopState";
import { nextAgentStatusOnAddMessages, classifyApiErrorBanner, apiErrorBatchAction, nextPendingApiError, newestSignificantMessage, isBannerTurn, isRealTurn, NEEDS_INPUT_AUQ_CHECK_DELAY_MS } from "./inboxFilters";
import {
  classifyDocContent,
  extractTitleFromContent,
  inlineDocSnapshotRelation,
  inlineDocSourceKey,
  shouldUseInlineDocSnapshotFallback,
} from "./docExtraction";
import { extractFileChanges, extractCommitHashFromContent, hasFileChangeToolCall, type FileChange } from "./fileChanges/extractor";
import { extractSessionImages, type SessionImageEntry } from "./sessionImages";

type DocExtractionMessage = {
  message_uuid?: string;
  role?: string;
  content?: string;
  tool_calls?: Array<{ id: string; name: string; input: string }>;
  timestamp?: number;
};

type InlineExtractedDoc = {
  _id: Id<"docs">;
  source?: string;
  source_file?: string;
  title: string;
  content: string;
  updated_at: number;
};

type DocExtractionConversation = {
  user_id: Id<"users">;
  team_id?: string;
  project_path?: string;
  is_private?: boolean;
  team_visibility?: string;
};

/** Bound demand-scoped coverage checks independently of transcript size. */
export const MESSAGE_COVERAGE_COMMAND_ID_LIMIT = 64;

export function normalizeMessageCoverageCommandIds(
  commandIds: readonly string[],
): string[] {
  if (commandIds.length > MESSAGE_COVERAGE_COMMAND_ID_LIMIT) {
    throw new ConvexError({
      code: "TOO_MANY_COMMAND_IDS",
      message: `At most ${MESSAGE_COVERAGE_COMMAND_ID_LIMIT} command ids may be checked at once`,
      limit: MESSAGE_COVERAGE_COMMAND_ID_LIMIT,
    });
  }
  return [...new Set(commandIds.map(validateCommandId))].sort();
}

export function buildExistingMessagePatch(
  existing: {
    role: string;
    content?: string;
    thinking?: string;
    tool_calls?: unknown;
    tool_results?: unknown;
    images?: unknown;
    subtype?: string;
    model?: string;
  },
  incoming: {
    role: string;
    content?: string;
    thinking?: string;
    tool_calls?: unknown;
    tool_results?: unknown;
    images?: unknown;
    subtype?: string;
    model?: string;
  },
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};

  if (incoming.role === "assistant") {
    if (incoming.content !== undefined && incoming.content !== existing.content) {
      patch.content = incoming.content;
    }
    if (incoming.thinking !== undefined && incoming.thinking !== existing.thinking) {
      patch.thinking = incoming.thinking;
    }
    if (incoming.subtype !== undefined && incoming.subtype !== existing.subtype) {
      patch.subtype = incoming.subtype;
    }
    // Backfills older rows when a transcript re-syncs (resume, fork, new device).
    if (incoming.model !== undefined && incoming.model !== existing.model) {
      patch.model = incoming.model;
    }
    if (incoming.tool_calls !== undefined && JSON.stringify(incoming.tool_calls) !== JSON.stringify(existing.tool_calls ?? null)) {
      patch.tool_calls = incoming.tool_calls;
    }
    if (incoming.tool_results !== undefined && JSON.stringify(incoming.tool_results) !== JSON.stringify(existing.tool_results ?? null)) {
      patch.tool_results = incoming.tool_results;
    }
  }

  if (incoming.images && JSON.stringify(incoming.images) !== JSON.stringify(existing.images ?? null)) {
    patch.images = incoming.images;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

// A /model switch emits a user line `<local-command-stdout>Set model to <Name>`
// and NO assistant line until the next turn, so it must count as a model signal
// or the rollup (and forks, which stamp conversations.model on every line) lag
// one turn behind the switch. Maps the display name ("Fable 5") to the id shape
// stored everywhere else ("claude-fable-5"). "Set model to Default" doesn't name
// a concrete model — not a signal; the next assistant turn records the real one.
const MODEL_SWITCH_RE =
  /<local-command-stdout>Set model to (?:\u001b\[\d+m)*(opus|sonnet|haiku|fable)\s*([\d.]*)/i;
export function modelFromSwitchLine(content: string | undefined): string | null {
  const m = content?.match(MODEL_SWITCH_RE);
  if (!m) return null;
  const version = m[2] ? `-${m[2].replace(/\.$/, "").replace(/\./g, "-")}` : "";
  return `claude-${m[1].toLowerCase()}${version}`;
}

// Newest model signal in a batch — rolled up to conversations.model so list
// surfaces (inbox badge, session pickers) can read it without scanning messages.
// Signals: assistant lines record the model a turn ran on; user /model switch
// lines record where the session is headed. "<synthetic>" marks system-generated
// assistant entries (error banners), never a real model.
export function lastKnownModelFromBatch(
  messages: Array<{ role: string; model?: string; content?: string; timestamp?: number }>,
): string | null {
  let best: { ts: number; model: string } | null = null;
  for (const m of messages) {
    const model =
      m.role === "assistant" && m.model && m.model !== "<synthetic>"
        ? m.model
        : m.role === "user"
          ? modelFromSwitchLine(m.content)
          : null;
    if (!model) continue;
    const ts = m.timestamp || 0;
    if (!best || ts >= best.ts) best = { ts, model };
  }
  return best?.model ?? null;
}

// Effort switch echoes come in two shapes: the /effort command prints
// "Set effort level to high (…)", and the /model picker's session-only commit
// appends "… with max effort" to its "Set model to …" line. Unlike model,
// effort has NO per-message field in the transcript — these echoes are the
// only signal, so the rollup is the sole source for conversations.effort.
const EFFORT_SWITCH_RE =
  /<local-command-stdout>[^<]*?(?:Set effort level to (?:\u001b\[\d+m)*(low|medium|high|xhigh|max|auto)\b|with (?:\u001b\[\d+m)*(low|medium|high|xhigh|max)(?:\u001b\[\d+m)* effort)/i;
export function effortFromSwitchLine(content: string | undefined): string | null {
  const m = content?.match(EFFORT_SWITCH_RE);
  if (!m) return null;
  const level = (m[1] ?? m[2]).toLowerCase();
  // "auto" means "no explicit level" — clearer to keep the previous value.
  return level === "auto" ? null : level;
}

// Newest effort signal in a batch — conversations.effort twin of
// lastKnownModelFromBatch (user switch lines are the only carriers).
export function lastKnownEffortFromBatch(
  messages: Array<{ role: string; content?: string; timestamp?: number }>,
): string | null {
  let best: { ts: number; effort: string } | null = null;
  for (const m of messages) {
    const effort = m.role === "user" ? effortFromSwitchLine(m.content) : null;
    if (!effort) continue;
    const ts = m.timestamp || 0;
    if (!best || ts >= best.ts) best = { ts, effort };
  }
  return best?.effort ?? null;
}

// Insert or update a file-synced doc for a markdown file an agent wrote. Shared
// by the Write-tool path and the Bash-heredoc path so both classify the type,
// derive the title, and dedup identically. Skips short files and no-op patches.
async function upsertFileSyncDoc(
  ctx: any,
  conversation: DocExtractionConversation,
  conversation_id: Id<"conversations">,
  filePath: string,
  content: string,
  timestamp: number,
) {
  if (!filePath.endsWith(".md") || content.length < 200) return;
  const fileName = filePath.split("/").pop() || filePath;
  const docType = fileName.toLowerCase().includes("plan") ? "plan" as const
    : fileName.toLowerCase().includes("design") ? "design" as const
    : fileName.toLowerCase().includes("spec") ? "spec" as const
    : classifyDocContent(content);
  const existing = await ctx.db
    .query("docs")
    .withIndex("by_source_file", (q: any) => q.eq("source_file", filePath))
    .first();
  if (existing) {
    if (existing.content === content) return; // idempotent: nothing changed
    await ctx.db.patch(existing._id, {
      title: extractTitleFromContent(content),
      content,
      doc_type: docType,
      updated_at: timestamp,
    });
  } else {
    await ctx.db.insert("docs", {
      user_id: conversation.user_id,
      // Docs mirrored out of a private session stay personal — team_id alone
      // grants teammates access (canAccessDoc has no privacy gate).
      team_id: teamVisibleConvTeam(conversation),
      // ACCESS key alongside the routing tag (lib/access computeWorkspaceKey).
      workspace: computeWorkspaceKey({ user_id: conversation.user_id } as any, conversation as any),
      title: extractTitleFromContent(content),
      content,
      doc_type: docType,
      source: "file_sync",
      source_file: filePath,
      conversation_id,
      project_path: conversation.project_path,
      is_private: conversation.is_private,
      team_visibility: conversation.team_visibility,
      created_at: timestamp,
      updated_at: timestamp,
    });
  }
}

// Markdown files written via a Bash heredoc, e.g.
//   cat > notes.md <<'EOF'\n...\nEOF      or      tee notes.md <<EOF ... EOF
// (the redirect may sit before or after the `<<`). The content lives inline in
// the command, so we capture it just like a Write. Files assembled by a script
// (content never in the command) stay invisible — there's nothing to capture.
export function extractHeredocMarkdownWrites(command: string): Array<{ file_path: string; content: string }> {
  const out: Array<{ file_path: string; content: string }> = [];
  const lines = command.split("\n");
  const openRe = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;
  // The target is either a `>`/`>>` redirect or a `tee [flags]` argument.
  const mdQuoted = `(?:'([^']+\\.md)'|"([^"]+\\.md)"|([^\\s'";|&<>]+\\.md))`;
  const redirectRe = new RegExp(`>>?\\s*${mdQuoted}`);
  const teeRe = new RegExp(`\\btee\\b(?:\\s+-\\S+)*\\s+${mdQuoted}`);
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(openRe);
    if (!open) continue;
    const pathM = lines[i].match(redirectRe) || lines[i].match(teeRe);
    if (!pathM) continue;
    const filePath = pathM[1] || pathM[2] || pathM[3];
    const delim = open[2];
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && lines[j].trim() !== delim; j++) body.push(lines[j]);
    if (j < lines.length) {
      out.push({ file_path: filePath, content: body.join("\n") });
      i = j; // skip past the heredoc body
    }
  }
  return out;
}

async function extractDocsFromMessages(
  ctx: any,
  messages: DocExtractionMessage[],
  conversation: DocExtractionConversation,
  conversation_id: Id<"conversations">,
) {
  // Existing docs for this conversation, fetched lazily on the first inline
  // candidate. Dedup must be by stable key AND content: legacy inline docs were
  // keyed by wall-clock (`inline://<conv>/<Date.now()>`), so a re-synced message
  // never matches its old key — content equality is what stops re-inserts.
  let convDocs: InlineExtractedDoc[] | null = null;
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.content && msg.content.length > 5000) {
      const content = msg.content;
      const headingCount = (content.match(/^#{1,3}\s/gm) || []).length;
      if (headingCount >= 3) {
        const syntheticPath = inlineDocSourceKey(
          conversation.user_id,
          msg.timestamp,
          msg.message_uuid,
        );
        const incomingTitle = extractTitleFromContent(content);
        if (convDocs === null) {
          convDocs = (await ctx.db
            .query("docs")
            .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversation_id))
            .collect()) as InlineExtractedDoc[];
        }
        const sameConversationExact = convDocs.find(
          (d) => d.source_file === syntheticPath || d.content === content,
        );
        const sameConversationSnapshot = shouldUseInlineDocSnapshotFallback(msg.message_uuid)
          ? convDocs.find((d) => {
              if (d.source !== "inline_extract" || d.title !== incomingTitle) return false;
              return inlineDocSnapshotRelation(d.content, content) !== "different";
            })
          : undefined;
        const globallyKeyed = sameConversationExact
          ? null
          : await ctx.db
            .query("docs")
            .withIndex("by_source_file", (q: any) => q.eq("source_file", syntheticPath))
            .first();
        const existing = sameConversationExact || sameConversationSnapshot || globallyKeyed;
        if (existing) {
          const relation = inlineDocSnapshotRelation(existing.content, content);
          const shouldReplace = relation === "incoming_longer" ||
            (relation === "different" && (msg.timestamp ?? 0) >= existing.updated_at);
          if (shouldReplace) {
            await ctx.db.patch(existing._id, {
              title: incomingTitle,
              content,
              doc_type: classifyDocContent(content),
              updated_at: msg.timestamp || Date.now(),
            });
            existing.title = incomingTitle;
            existing.content = content;
            existing.updated_at = msg.timestamp || Date.now();
          }
        } else {
          const insertedId = await ctx.db.insert("docs", {
            user_id: conversation.user_id,
            title: incomingTitle,
            content,
            doc_type: classifyDocContent(content),
            source: "inline_extract",
            source_file: syntheticPath,
            conversation_id,
            project_path: conversation.project_path,
            is_private: conversation.is_private,
            team_visibility: conversation.team_visibility,
            created_at: msg.timestamp || Date.now(),
            updated_at: msg.timestamp || Date.now(),
          });
          convDocs.push({
            _id: insertedId,
            source: "inline_extract",
            source_file: syntheticPath,
            title: incomingTitle,
            content,
            updated_at: msg.timestamp || Date.now(),
          });
        }
      }
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        const ts = msg.timestamp || Date.now();

        // Bash heredocs: capture markdown written via `cat > x.md <<EOF ... EOF`.
        if (tc.name === "Bash") {
          let input: any;
          try { input = JSON.parse(tc.input); } catch { continue; }
          const command: string = input.command || "";
          if (!command.includes(".md") || !command.includes("<<")) continue;
          for (const w of extractHeredocMarkdownWrites(command)) {
            await upsertFileSyncDoc(ctx, conversation, conversation_id, w.file_path, w.content, ts);
          }
          continue;
        }

        if (tc.name !== "Write" && tc.name !== "Edit") continue;
        let input: any;
        try { input = JSON.parse(tc.input); } catch { continue; }
        const filePath: string = input.file_path || "";
        if (!filePath.endsWith(".md")) continue;

        if (tc.name === "Write") {
          await upsertFileSyncDoc(ctx, conversation, conversation_id, filePath, input.content || "", ts);
          continue;
        }

        // Edit: patch the existing doc by applying the same find/replace.
        const existing = await ctx.db
          .query("docs")
          .withIndex("by_source_file", (q: any) => q.eq("source_file", filePath))
          .first();
        if (tc.name === "Edit" && existing) {
          const oldStr: string = input.old_string || "";
          const newStr: string = input.new_string || "";
          if (!oldStr || !existing.content?.includes(oldStr)) continue;
          const updatedContent = input.replace_all
            ? existing.content.split(oldStr).join(newStr)
            : existing.content.replace(oldStr, newStr);
          await ctx.db.patch(existing._id, {
            title: extractTitleFromContent(updatedContent),
            content: updatedContent,
            updated_at: ts,
          });
        }
      }
    }
  }
}

// Cheap in-memory pre-filter so we only schedule the (DB-touching) extractDocs
// mutation for batches that could actually yield a doc. Mirrors the conditions in
// extractDocsFromMessages but avoids JSON.parse — a `.md` substring is enough to
// decide whether the precise parse downstream is worth a scheduled mutation.
function hasDocExtractionCandidate(messages: DocExtractionMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.content && msg.content.length > 5000) {
      const headingCount = (msg.content.match(/^#{1,3}\s/gm) || []).length;
      if (headingCount >= 3) return true;
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if ((tc.name === "Write" || tc.name === "Edit") && typeof tc.input === "string" && tc.input.includes(".md")) {
          return true;
        }
        // Bash heredoc writing a .md file (`cat > x.md <<EOF`).
        if (tc.name === "Bash" && typeof tc.input === "string" && tc.input.includes(".md") && tc.input.includes("<<")) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Demand-scoped reconciliation proof for durable message sends.
 *
 * This is deliberately not a transcript endpoint: it returns no message rows
 * or payload fields. A command id is covered only after the authoritative
 * transcript has ingested a message with that id for this exact conversation.
 * The returned grant represents current send authority, not broader link-read
 * access, so the same opaque grant may safely retain/dispatch queued intent.
 */
export const getMessageCoverageV2 = query({
  args: {
    conversation_id: v.id("conversations"),
    command_ids: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = {
      contractId: MESSAGES_VIEW_CONTRACT_ID,
      viewKey: messagesViewKey(args.conversation_id),
    };
    const grantKey = messagesGrantKey(args.conversation_id);
    const userId = await getAuthUserId(ctx);
    if (!userId) return unauthenticatedView(identity);

    const commandIds = normalizeMessageCoverageCommandIds(args.command_ids);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return missingView(identity, [grantKey]);
    if (!(await canSendProductMessage(ctx, userId, conversation))) {
      return forbiddenView(identity, [grantKey]);
    }

    const matches = await Promise.all(commandIds.map(async (commandId) =>
      await ctx.db
        .query("messages")
        .withIndex("by_conversation_client_id", (q) =>
          q.eq("conversation_id", args.conversation_id).eq("client_id", commandId))
        .first()));
    const coveredCommandIds = commandIds.filter((_commandId, index) => !!matches[index]);
    // Command-id coverage, not a revision-covered row set — outside grantedView.
    return {
      ...identity,
      access: "granted" as const,
      grantKeys: [grantKey],
      coverage: {
        kind: "command-ids" as const,
        commandIds: coveredCommandIds,
      },
    };
  },
});

export const getMessageTimestamp = query({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    if ((await checkConversationAccess(ctx, authUserId, conversation, args.share_token)) === "denied") {
      return null;
    }

    const message = await ctx.db.get(args.message_id);
    if (!message || message.conversation_id.toString() !== args.conversation_id.toString()) {
      return null;
    }

    return { timestamp: message.timestamp };
  },
});

async function getAuthenticatedUserId(
  ctx: { db: any },
  apiToken?: string
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) {
    return sessionUserId;
  }

  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) {
      return result.userId;
    }
  }

  return null;
}

/**
 * Fold this message's edited paths into the conversation's recent_files list
 * (newest first, deduped, capped). Returns null when the list is unchanged so
 * callers skip the patch. Commit pseudo-changes carry no meaningful path and
 * are excluded — this list answers "where does this session work", not "what
 * did it commit".
 */
export function mergeRecentFiles(
  existing: string[] | undefined,
  changes: Array<{ filePath: string; changeType: string }>,
): string[] | null {
  const RECENT_FILES_CAP = 8;
  const incoming: string[] = [];
  // Reverse so the message's last edit ranks newest, then dedupe first-wins.
  for (let i = changes.length - 1; i >= 0; i--) {
    const fc = changes[i];
    if (fc.changeType === "commit" || !fc.filePath?.trim()) continue;
    if (!incoming.includes(fc.filePath)) incoming.push(fc.filePath);
  }
  if (incoming.length === 0) return null;
  const merged = [...incoming];
  for (const p of existing ?? []) {
    if (merged.length >= RECENT_FILES_CAP) break;
    if (!merged.includes(p)) merged.push(p);
  }
  const capped = merged.slice(0, RECENT_FILES_CAP);
  const prev = existing ?? [];
  if (capped.length === prev.length && capped.every((p, i) => p === prev[i])) return null;
  return capped;
}

/**
 * One-time backfill: seed conversations.recent_files from the already
 * materialized file_changes table, so feed cards show WHERE existing sessions
 * work without waiting for their next edit. Walks conversations newest-created
 * first in small self-scheduled batches; only rows active since the cutoff and
 * still unseeded pay the (content-heavy) file_changes reads. Writes [] to
 * processed rows with no edits so a re-run skips them.
 */
export const backfillRecentFiles = internalMutation({
  args: { cursor_ts: v.optional(v.number()), cutoff_ts: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = args.cutoff_ts ?? Date.now() - 14 * 24 * 60 * 60 * 1000;
    // Bound the walk: a conversation CREATED well before the activity cutoff
    // and still active is rare enough to leave to organic maintenance.
    const walkFloor = cutoff - 45 * 24 * 60 * 60 * 1000;
    const batch = await ctx.db
      .query("conversations")
      .withIndex("by_creation_time", (q) =>
        args.cursor_ts !== undefined ? q.lt("_creationTime", args.cursor_ts) : q,
      )
      .order("desc")
      .take(40);
    let seeded = 0;
    for (const conv of batch) {
      if (conv.updated_at < cutoff || conv.recent_files !== undefined) continue;
      const rows = await ctx.db
        .query("file_changes")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .order("desc")
        .take(12);
      // Rows arrive newest-first; mergeRecentFiles treats the LAST change as
      // newest, so feed it ascending.
      const merged = mergeRecentFiles(
        undefined,
        rows.reverse().map((r) => ({ filePath: r.file_path, changeType: r.change_type })),
      );
      await ctx.db.patch(conv._id, { recent_files: merged ?? [] });
      seeded++;
    }
    const oldest = batch[batch.length - 1];
    if (oldest && oldest._creationTime > walkFloor) {
      await ctx.scheduler.runAfter(0, internal.messages.backfillRecentFiles, {
        cursor_ts: oldest._creationTime,
        cutoff_ts: cutoff,
      });
    }
    return { scanned: batch.length, seeded, done: !oldest || oldest._creationTime <= walkFloor };
  },
});

/**
 * Materialize per-edit file changes for a freshly-inserted message into the
 * file_changes table. Called only on genuine inserts (never the uuid/content
 * dedup branches) so re-synced messages don't duplicate rows. Runs the shared
 * extractor on the already-redacted tool calls, and is pre-filtered so an
 * ordinary message (no edit tool calls) costs nothing.
 */
async function materializeFileChanges(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  messageId: Id<"messages">,
  timestamp: number,
  toolCalls: Array<{ id: string; name: string; input: string }> | undefined,
  toolResults: Array<{ tool_use_id: string; content: string; is_error?: boolean }> | undefined,
): Promise<void> {
  // Late-arriving commit hashes: a `git commit` Bash RESULT lands on the next
  // (user) message, after the commit row materialized hash-less. The string
  // test gates the lookup, so only genuine commit outputs cost a point-read
  // (change_key = the Bash call's toolCallId).
  if (toolResults) {
    for (const tr of toolResults) {
      if (tr.is_error || !tr.tool_use_id) continue;
      const hash = extractCommitHashFromContent(tr.content ?? "");
      if (!hash) continue;
      const row = await ctx.db
        .query("file_changes")
        .withIndex("by_conversation_change_key", (q) =>
          q.eq("conversation_id", conversationId).eq("change_key", tr.tool_use_id),
        )
        .first();
      if (row && row.change_type === "commit" && !row.commit_hash) {
        await ctx.db.patch(row._id, { commit_hash: hash });
      }
    }
  }

  const msg = { _id: messageId, timestamp, tool_calls: toolCalls, tool_results: toolResults };
  if (!hasFileChangeToolCall(msg)) return;
  const extracted = extractFileChanges([msg]);
  // Keep the conversation's "where does it work" list current in the same
  // transaction — feed/search cards render it (see schema.recent_files).
  if (extracted.length > 0) {
    const conv = await ctx.db.get(conversationId);
    const nextRecent = mergeRecentFiles(conv?.recent_files, extracted);
    if (nextRecent) await ctx.db.patch(conversationId, { recent_files: nextRecent });
  }
  for (const fc of extracted) {
    await ctx.db.insert("file_changes", {
      conversation_id: conversationId,
      change_key: fc.id,
      message_id: messageId,
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
  }
}

/**
 * Complete, pagination-independent list of file changes for a conversation,
 * materialized at message ingest. The diff viewer merges this with its
 * client-side window extraction, which backfills conversations whose edits
 * predate materialization (no backfill was run).
 */
export const getConversationFileChanges = query({
  args: { conversation_id: v.id("conversations"), share_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<FileChange[]> => {
    // Access gate: this returns the full before/after source of every file the
    // session edited — including private (owner-only) conversations. Match the
    // other message readers: owner, team member, or share-token holder only.
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return [];
    const viewerId = await getAuthUserId(ctx);
    if ((await checkConversationAccess(ctx, viewerId, conversation, args.share_token)) === "denied") {
      return [];
    }
    const rows = await ctx.db
      .query("file_changes")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .collect();
    // Re-synced messages can leave duplicate rows; dedupe by the stable change_key,
    // then order by (timestamp, in-message seq) to match the client extractor.
    const byKey = new Map<string, (typeof rows)[number]>();
    for (const r of rows) byKey.set(r.change_key, r);
    return Array.from(byKey.values())
      .sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq)
      .map((r, i) => ({
        id: r.change_key,
        toolCallId: r.tool_call_id,
        // Globally-ordered position so the result is correct on its own; the
        // client merge re-derives this anyway when folding in window changes.
        sequenceIndex: i,
        messageId: r.message_id,
        filePath: r.file_path,
        changeType: r.change_type,
        oldContent: r.old_content,
        newContent: r.new_content,
        commitMessage: r.commit_message,
        commitHash: r.commit_hash,
        timestamp: r.timestamp,
      }));
  },
});

// Newest displayable image in a message batch → the conversation's inbox
// thumbnail (conversations.image_preview_url). Storage-backed images (pasted
// attachments, tool screenshots) resolve via ctx.storage.getUrl; markdown
// images embedded in prose (`cast image` output) count only when they point at
// our own storage origin — mirroring the web's trusted-origin gate, so a
// third-party URL an agent emits can never become a team-visible thumbnail.
// Scans newest-first and returns the first hit; undefined when the batch
// carries no image.
const MD_IMAGE_URL_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+?)(?:\s+"[^"]*")?\)/g;
function trustedImageOrigin(): string | null {
  const base = process.env.CONVEX_CLOUD_ORIGIN || process.env.CONVEX_CLOUD_URL || process.env.VITE_CONVEX_URL || "";
  try { return base ? new URL(base).origin : null; } catch { return null; }
}
export async function latestImagePreviewUrl(
  ctx: { storage: { getUrl: (id: any) => Promise<string | null> } },
  msgs: Array<{ content?: string; images?: Array<{ storage_id?: string }> }>,
): Promise<string | undefined> {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.images) {
      for (let j = m.images.length - 1; j >= 0; j--) {
        const sid = m.images[j].storage_id;
        if (!sid) continue;
        const url = await ctx.storage.getUrl(sid as any);
        if (url) return url;
      }
    }
    if (m.content && m.content.includes("![")) {
      const origin = trustedImageOrigin();
      if (origin) {
        let last: string | undefined;
        for (const match of m.content.matchAll(MD_IMAGE_URL_RE)) {
          try {
            if (new URL(match[1]).origin === origin) last = match[1];
          } catch {}
        }
        if (last) return last;
      }
    }
  }
  return undefined;
}

// --- Session image gallery -------------------------------------------------
//
// The header gallery lists every image in the thread, but the client holds only
// the loaded message window (200 messages a page), so scanning there counts the
// tail alone — open a long session and most of its images are missing. Same
// problem the diff viewer had with file changes, same answer: write one small
// row per image at ingest, then read the list back independent of pagination.

/** Server-side trust gate for markdown images in prose: our own storage origin
 *  only, matching latestImagePreviewUrl. The web also trusts its own web origin
 *  — a superset — so an image dropped here is one the client's own window
 *  extraction can still add back through the merge. */
function isTrustedMarkdownImageSrc(src: string): boolean {
  const origin = trustedImageOrigin();
  if (!origin) return false;
  try {
    return new URL(src).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Materialize a freshly-inserted message's images into conversation_images.
 * Called only on genuine inserts (never the uuid/content dedup branches), and
 * pre-filtered so an ordinary text message costs nothing. Idempotent by
 * (conversation_id, image_key), so a re-synced message can't duplicate a row.
 */
async function materializeConversationImages(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  messageId: Id<"messages">,
  timestamp: number,
  content: string | undefined,
  images: Array<{ media_type: string; data?: string; storage_id?: Id<"_storage"> }> | undefined,
): Promise<void> {
  if (!images?.some((i) => i.storage_id) && !content?.includes("![")) return;
  for (const entry of extractSessionImages([{ content, timestamp, images }], isTrustedMarkdownImageSrc)) {
    // Inline base64 images key on their own payload — the client window
    // extraction surfaces those; an index table is no place for the bytes.
    if (!entry.storage_id && (!entry.src || entry.src.startsWith("data:"))) continue;
    const existing = await ctx.db
      .query("conversation_images")
      .withIndex("by_conversation_image_key", (q) =>
        q.eq("conversation_id", conversationId).eq("image_key", entry.key),
      )
      .first();
    if (existing) continue;
    await ctx.db.insert("conversation_images", {
      conversation_id: conversationId,
      image_key: entry.key,
      storage_id: entry.storage_id as Id<"_storage"> | undefined,
      src: entry.src,
      message_id: messageId,
      seq: entry.seq ?? 0,
      timestamp,
    });
  }
}

// Safety valve, far above any real session: the gallery reads the whole list in
// one query, and an unbounded collect() is how a query starts failing years
// later on a conversation nobody predicted.
const SESSION_GALLERY_ROW_LIMIT = 2000;

/**
 * Complete, pagination-independent list of a conversation's images —
 * the header gallery's source. Entries carry a storage id or a trusted src,
 * never a resolved URL: the clients already batch storage-url resolution
 * (useStorageImageUrls on web, getImageUrl on mobile), and resolving here would
 * cost one storage call per image on every re-run of a reactive query.
 */
export const getConversationImages = query({
  args: { conversation_id: v.id("conversations"), share_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<SessionImageEntry[]> => {
    // Same access gate as the other message readers: owner, team member, or
    // share-token holder. The list names images in a possibly-private thread.
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return [];
    const viewerId = await getAuthUserId(ctx);
    if ((await checkConversationAccess(ctx, viewerId, conversation, args.share_token)) === "denied") {
      return [];
    }
    // Newest-first, so a session past the cap keeps its RECENT images (the
    // gallery opens on the last one) instead of its oldest. Both writers append
    // in transcript order — live ingest as messages arrive, the sweep walking
    // by_conversation_timestamp ascending — so creation order tracks it.
    const rows = await ctx.db
      .query("conversation_images")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .order("desc")
      .take(SESSION_GALLERY_ROW_LIMIT);
    // Rows land in insertion order, which is transcript order for live ingest
    // but not for a backfilled history (old images inserted after new ones).
    // Sort by transcript position, and dedupe defensively — a concurrent
    // backfill and live insert can race the key check.
    const byKey = new Map<string, (typeof rows)[number]>();
    for (const r of rows) byKey.set(r.image_key, r);
    return Array.from(byKey.values())
      .sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq)
      .map((r) => ({
        key: r.image_key,
        storage_id: r.storage_id ?? undefined,
        src: r.src,
        timestamp: r.timestamp,
        seq: r.seq,
      }));
  },
});

const IMAGE_BACKFILL_PAGE_SIZE = 300;

/**
 * Sweep a conversation's whole history into conversation_images. Live ingest
 * materializes every new image, so this only catches up the history that
 * predates the feature — once per conversation, on first open, owner-only.
 *
 * No in-flight claim: the completion stamp is the only guard, so a sweep that
 * dies midway simply restarts on the next open. Two concurrent sweeps are
 * harmless — the key check makes every insert idempotent.
 */
export const backfillConversationImages = mutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) throw new Error("Unauthorized");
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) throw new Error("Conversation not found");
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Can only backfill your own conversations");
    }
    if (conversation.images_backfilled_at !== undefined) return;
    await ctx.scheduler.runAfter(0, internal.messages.backfillConversationImagesPage, {
      conversation_id: args.conversation_id,
    });
  },
});

export const backfillConversationImagesPage = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", args.conversation_id))
      .paginate({ cursor: args.cursor ?? null, numItems: IMAGE_BACKFILL_PAGE_SIZE });

    for (const msg of page.page) {
      await materializeConversationImages(
        ctx,
        args.conversation_id,
        msg._id,
        msg.timestamp,
        msg.content,
        msg.images,
      );
    }

    if (page.isDone) {
      await ctx.db.patch(args.conversation_id, { images_backfilled_at: Date.now() });
    } else {
      await ctx.scheduler.runAfter(0, internal.messages.backfillConversationImagesPage, {
        conversation_id: args.conversation_id,
        cursor: page.continueCursor,
      });
    }
    return { scanned: page.page.length, done: page.isDone };
  },
});

// Storage ids embedded in an injected-image echo. The daemon delivers an image
// as `[Image /tmp/codecast/images/<storageId>.png]` (downloadImage names the
// file by its Convex storage id), so the agent's echoed user turn carries the
// pending row's storage id verbatim.
export function injectedImageStorageIds(content: string): string[] {
  return injectedImageRefs(content).map((r) => r.storage_id);
}

const IMAGE_EXT_MEDIA_TYPE: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
};

// Same paths as injectedImageStorageIds, as message `images` entries. The
// extension is how downloadImage recorded the object's content type, so it is
// the media type — hardcoding image/png mislabelled every webp and jpeg.
export function injectedImageRefs(
  content: string,
): Array<{ media_type: string; storage_id: string }> {
  const refs: Array<{ media_type: string; storage_id: string }> = [];
  const seen = new Set<string>();
  // Every extension downloadImage can write (named by the object's content type).
  const re = /\/codecast\/images\/([^/\s.\]]+)\.(png|webp|jpe?g|gif)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    refs.push({ media_type: IMAGE_EXT_MEDIA_TYPE[m[2].toLowerCase()] || "image/png", storage_id: m[1] });
  }
  return refs;
}

export function pendingImageStorageIds(
  pm: { image_storage_ids?: string[]; image_storage_id?: string },
): string[] {
  return pm.image_storage_ids ?? (pm.image_storage_id ? [pm.image_storage_id] : []);
}

// Images to store on an echoed user turn. Anything the sync already carried
// wins; otherwise the paired pending row's storage ids, whose media type comes
// from the extension the daemon wrote (hardcoding image/png mislabelled every
// webp and jpeg). Returns null when only the echo text is left to go on — the
// caller then has to verify those ids against storage before trusting them.
export function resolveEchoImages(
  existing: Array<{ media_type: string; storage_id?: string }> | undefined,
  pm: { image_storage_ids?: string[]; image_storage_id?: string } | undefined,
  echoContent: string,
): Array<{ media_type: string; storage_id?: string }> | undefined | null {
  if (existing && existing.length > 0) return existing;
  const pendingIds = pm ? pendingImageStorageIds(pm) : [];
  if (pendingIds.length === 0) return injectedImageRefs(echoContent).length > 0 ? null : existing;
  const refs = injectedImageRefs(echoContent);
  return pendingIds.map((id) => ({
    media_type: refs.find((r) => r.storage_id === id)?.media_type || "image/png",
    storage_id: id,
  }));
}

// Last resort when no pending row could be paired: the storage ids the echo
// itself names. A delivered image then still renders — the file is in storage,
// so the bubble should never come out blank just because the terminal mangled
// the prose the matcher compares.
//
// These ids are untrusted: the path is ordinary message text, so anyone can
// type one. An id that names no storage object fails schema validation on
// insert and takes the WHOLE message down with it, which is far worse than a
// missing thumbnail — so each candidate is resolved against storage first and
// silently dropped if it doesn't exist.
async function verifiedEchoImages(
  ctx: { storage: { getUrl: (id: Id<"_storage">) => Promise<string | null> } },
  echoContent: string,
): Promise<Array<{ media_type: string; storage_id: Id<"_storage"> }>> {
  const kept: Array<{ media_type: string; storage_id: Id<"_storage"> }> = [];
  for (const ref of injectedImageRefs(echoContent)) {
    const id = ref.storage_id as Id<"_storage">;
    try {
      if (await ctx.storage.getUrl(id)) kept.push({ media_type: ref.media_type, storage_id: id });
    } catch {
      // Malformed id — not ours, ignore.
    }
  }
  return kept;
}

// Does this echoed user turn ack the given pending image row? Both contents are
// empty once `[Image …]` is stripped (an image-only send), so text can't match.
// Prefer the storage id carried in the echo path — a deterministic signal that
// holds no matter how long the session was busy before the inject. Fall back to
// the ±120s window only for echoes with no parseable path (older/non-daemon).
export function imageEchoMatchesPending(
  pm: { image_storage_ids?: string[]; image_storage_id?: string; created_at?: number },
  echoContent: string,
  msgTimestamp: number,
): boolean {
  const echoed = injectedImageStorageIds(echoContent);
  if (echoed.length > 0) {
    return pendingImageStorageIds(pm).some((id) => echoed.includes(id));
  }
  return Math.abs(msgTimestamp - (pm.created_at || 0)) < 120_000;
}

// Match an agent-echoed user message to the pending row it delivered. Echoes
// arrive in injection order, so candidates are tried in delivery order (oldest
// first) and only among rows still awaiting proof. Newest-first over all
// statuses cross-stamped identical-content sends: the echo of the OLDER
// delivery matched the NEWER command, stamping its client_id on the wrong
// transcript row and leaving the delivered command's overlay unreconcilable.
// "failed" rows are a second tier: a late echo proves a watchdog-failed row
// actually landed. delivered/cancelled/undeliverable never re-match.
// How far apart a status-ack "delivered" promotion and the transcript echo may
// land while still pairing up. updateAgentStatus terminalizes injected rows the
// moment the agent reports an active status — usually seconds before the echo
// syncs — which made the echo unmatchable and silently dropped everything the
// echo adopts from the pending row: sender attribution (from_user_id) on team
// sends, client_id (web pending-copy reconcile), and images. Delivered rows are
// a LAST-RESORT match tier: only rows not yet tied to an echo (echo_message_id
// unset) and delivered within this window qualify, so an identical later send
// can never be cross-stamped by an old delivered twin.
export const DELIVERED_ECHO_ADOPTION_WINDOW_MS = 30 * 60 * 1000;

// Control bytes the terminal leaks into an echoed turn. The daemon clears the
// client's composer with Ctrl+A / Ctrl+K before typing; when the input is not
// ready to consume them they land as literal SOH (\x01) and VT (\x0b) inside
// the text the agent echoes. They render as nothing, so the message looks fine
// while exact-text echo matching fails on it.
const ECHO_CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function findEchoedPendingMessage<
  T extends {
    _id: unknown;
    content: string;
    created_at?: number;
    status: string;
    delivered_at?: number;
    echo_message_id?: unknown;
    image_storage_ids?: string[];
    image_storage_id?: string;
  },
>(
  pendingMsgs: readonly T[],
  safeContent: string | undefined,
  msgTimestamp: number,
  consumed?: ReadonlySet<unknown>,
): T | undefined {
  const c = (safeContent || "")
    .replace(/\[Image[:\s][^\]]*\]/gi, "")
    .replace(ECHO_CONTROL_CHARS_RE, "")
    .trim();
  const cFlat = c.replace(/\s+/g, " ").trim();
  const contentMatches = (pm: T) => {
    // Strip image tokens from BOTH sides: the composer stamps "[Image N]" into
    // the draft text for each attachment, so the pending content carries the
    // token exactly like the echo does. Stripping only the echo side left a
    // text+image send permanently unmatched (no thumbnail, no client_id).
    const pc = redactSecrets(pm.content)
      .replace(/\[Image[:\s][^\]]*\]/gi, "")
      .replace(/\[image\]/gi, "")
      .replace(ECHO_CONTROL_CHARS_RE, "")
      .trim();
    const pcFlat = pc.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
    const contentMatch = cFlat === pcFlat || c === pc;
    if (!contentMatch) return false;
    if (!cFlat && !pcFlat) {
      return imageEchoMatchesPending(pm, safeContent || "", msgTimestamp);
    }
    return true;
  };
  const inDeliveryOrder = [...pendingMsgs].sort(
    (a, b) => (a.created_at || 0) - (b.created_at || 0),
  );
  // Strongest tier, tried first: the echo names the storage id of the file the
  // daemon wrote, and the daemon only knows that path because it read this
  // pending row. That join survives whatever the terminal did to the prose —
  // text equality does not (a stray keystroke or a leaked Ctrl+K byte is enough
  // to break it, and the row then loses its images, sender and clean content).
  // Still ordered oldest-first and gated on never-adopted, so re-sending a draft
  // that reuses one storage id pairs each echo with a different row.
  const echoedImageIds = injectedImageStorageIds(safeContent || "");
  const imageIdMatch = () =>
    echoedImageIds.length === 0
      ? undefined
      : inDeliveryOrder.find(
          (pm) =>
            !pm.echo_message_id &&
            !consumed?.has(pm._id) &&
            // A row killed before injection never had its file written, so it
            // can't be the source of this path — only a resend reusing the same
            // draft storage id could put it here, and that belongs to the row
            // that actually shipped.
            pm.status !== "cancelled" &&
            pm.status !== "undeliverable" &&
            pendingImageStorageIds(pm).some((id) => echoedImageIds.includes(id)),
        );
  const firstMatch = (statuses: readonly string[]) => inDeliveryOrder.find(
    (pm) => statuses.includes(pm.status) && !consumed?.has(pm._id) && contentMatches(pm),
  );
  // Last resort: a row the status ack already terminalized before its echo
  // synced. Adoption-only — markPendingDelivered on it is a no-op — and gated
  // on never-adopted + recency so old delivered twins can't absorb a new echo.
  const recentlyDeliveredMatch = () => inDeliveryOrder.find(
    (pm) =>
      pm.status === "delivered" &&
      !pm.echo_message_id &&
      typeof pm.delivered_at === "number" &&
      Math.abs(msgTimestamp - pm.delivered_at) <= DELIVERED_ECHO_ADOPTION_WINDOW_MS &&
      !consumed?.has(pm._id) &&
      contentMatches(pm),
  );
  return imageIdMatch()
    ?? firstMatch(["pending", "injected"])
    ?? firstMatch(["failed"])
    ?? recentlyDeliveredMatch();
}

export const addMessage = mutation({
  args: {
    conversation_id: v.id("conversations"),
    message_uuid: v.optional(v.string()),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool")
    ),
    content: v.optional(v.string()),
    thinking: v.optional(v.string()),
    tool_calls: v.optional(v.array(v.object({
      id: v.string(),
      name: v.string(),
      input: v.string(),
    }))),
    tool_results: v.optional(v.array(v.object({
      tool_use_id: v.string(),
      content: v.string(),
      is_error: v.optional(v.boolean()),
    }))),
    images: v.optional(v.array(v.object({
      media_type: v.string(),
      data: v.optional(v.string()),
      storage_id: v.optional(v.id("_storage")),
      tool_use_id: v.optional(v.string()),
    }))),
    subtype: v.optional(v.string()),
    model: v.optional(v.string()),
    timestamp: v.optional(v.number()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    if (conversation.user_id.toString() !== authUserId.toString()) {
      console.warn(
        `[addMessage] cross-user write blocked: auth=${authUserId} conv=${args.conversation_id} owner=${conversation.user_id} session=${conversation.session_id ?? "?"}`,
      );
      throw new Error("Unauthorized: can only add messages to your own conversations");
    }

    const msgTimestamp = args.timestamp || Date.now();

    const safeContent = args.content ? redactSecrets(args.content) : args.content;
    const safeThinking = args.thinking ? redactSecrets(args.thinking) : args.thinking;
    const safeToolCalls = args.tool_calls?.map(tc => ({
      ...tc,
      input: redactSecrets(tc.input),
    }));
    const safeToolResults = args.tool_results?.map(tr => ({
      ...tr,
      content: redactSecrets(tr.content),
    }));

    if (args.message_uuid) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_conversation_uuid", (q) =>
          q.eq("conversation_id", args.conversation_id).eq("message_uuid", args.message_uuid)
        )
        .first();

      if (existing) {
        const patch = buildExistingMessagePatch(existing, {
          role: args.role,
          content: safeContent,
          thinking: safeThinking,
          tool_calls: safeToolCalls,
          tool_results: safeToolResults,
          images: args.images,
          subtype: args.subtype,
          model: args.model,
        });
        if (patch) {
          await ctx.db.patch(existing._id, patch);
          // Same backfill watermark rule as addMessages: an edit far behind
          // the head is invisible to the live tail — bump the revision.
          if (existing.timestamp < conversation.updated_at - OLD_ROW_EDIT_MARGIN_MS) {
            await ctx.db.patch(args.conversation_id, {
              transcript_revision: (conversation.transcript_revision ?? 0) + 1,
            });
          }
        }
        return existing._id;
      }
    }

    if (args.role === "user") {
      const hasContent = !!safeContent?.trim();
      const hasImages = args.images && args.images.length > 0;
      const hasToolResults = !!args.tool_results && args.tool_results.length > 0;
      if ((hasContent || hasImages) && !hasToolResults) {
        const recentMessages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (q) =>
            q.eq("conversation_id", args.conversation_id)
          )
          .order("desc")
          .take(5);
        const dup = findDuplicateUserRow(
          recentMessages,
          { content: safeContent, timestamp: msgTimestamp, tool_results: args.tool_results, images: args.images },
          redactSecrets,
        );
        if (dup) {
          return dup._id;
        }
      }
    }

    let images = args.images;
    let contentToStore = safeContent;
    let clientIdToStore: string | undefined;
    let fromUserIdToStore: Id<"users"> | undefined;
    let matchingPending: Doc<"pending_messages"> | undefined;
    if (args.role === "user") {
      const pendingMsgs = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
        .collect();
      matchingPending = findEchoedPendingMessage(pendingMsgs, safeContent, msgTimestamp);
      if (matchingPending) {
        contentToStore = redactSecrets(matchingPending.content);
        clientIdToStore = matchingPending.client_id;
        // Attribute the stored message to whoever enqueued the send — the
        // transcript echo itself carries no sender identity, so this is the
        // only point where "who typed it" is known.
        fromUserIdToStore = matchingPending.from_user_id;
        // Agent echoed the message → durable proof of delivery; promote to terminal "delivered".
        await markPendingDelivered(ctx, matchingPending);
      }
      const resolved = resolveEchoImages(images, matchingPending, safeContent || "");
      images = (resolved === null
        ? await verifiedEchoImages(ctx, safeContent || "")
        : resolved) as typeof images;
      if (images && images.length === 0) images = undefined;
    }

    const messageId = await ctx.db.insert("messages", {
      conversation_id: args.conversation_id,
      from_user_id: fromUserIdToStore,
      message_uuid: args.message_uuid,
      role: args.role,
      content: contentToStore,
      thinking: safeThinking,
      tool_calls: safeToolCalls,
      tool_results: safeToolResults,
      images,
      subtype: args.subtype,
      model: args.model,
      client_id: clientIdToStore,
      timestamp: msgTimestamp,
    });
    if (matchingPending) {
      // Tie the row to its echo so a later identical send can never re-adopt it
      // (the delivered-tier match in findEchoedPendingMessage keys off this).
      await ctx.db.patch(matchingPending._id, { echo_message_id: messageId });
    }
    await maybeRecordUserSend(ctx, conversation, { role: args.role, content: contentToStore, tool_results: safeToolResults, from_user_id: fromUserIdToStore }, msgTimestamp);
    await materializeFileChanges(ctx, args.conversation_id, messageId, msgTimestamp, safeToolCalls, safeToolResults);
    await materializeConversationImages(ctx, args.conversation_id, messageId, msgTimestamp, contentToStore, images);
    const newMessageCount = conversation.message_count + 1;
    const now = Date.now();

    // Mirror addMessages' API-error banner supersession on the single-message
    // retry path so a banner inserted here is cleared once a real turn lands.
    const msgBannerKind = args.role === "assistant" ? classifyApiErrorBanner(contentToStore) : null;
    const msgIsBanner = msgBannerKind !== null;
    const msgIsRealTurn = isRealTurn({
      role: args.role,
      content: contentToStore,
      tool_calls: safeToolCalls,
      tool_results: safeToolResults,
      images,
    });
    const wasPendingApiError = conversation.pending_api_error === true;
    let supersededBanners = 0;
    if (
      apiErrorBatchAction({
        batchHasRealTurn: msgIsRealTurn,
        batchHasBanner: msgIsBanner,
        conversationPending: wasPendingApiError,
      }) === "supersede"
    ) {
      supersededBanners = await supersedeApiErrorBanners(ctx, args.conversation_id, msgTimestamp);
    }

    const convPatch: Record<string, unknown> = {
      message_count: newMessageCount - supersededBanners,
      updated_at: now,
      last_message_role: args.role,
    };
    const msgModel = lastKnownModelFromBatch([{ role: args.role, model: args.model, content: contentToStore, timestamp: msgTimestamp }]);
    if (msgModel && msgModel !== conversation.model) {
      convPatch.model = msgModel;
    }
    const msgEffort = lastKnownEffortFromBatch([{ role: args.role, content: contentToStore, timestamp: msgTimestamp }]);
    if (msgEffort && msgEffort !== conversation.effort) {
      convPatch.effort = msgEffort;
    }
    const nextPending = nextPendingApiError({
      newestIsBanner: msgIsBanner,
      batchHasRealTurn: msgIsRealTurn,
      conversationPending: wasPendingApiError,
    });
    if (nextPending !== wasPendingApiError) {
      convPatch.pending_api_error = nextPending;
    }
    // A kept flag keeps its kind and stamp; only a fresh banner rewrites them.
    const nextBannerKind = msgIsBanner ? msgBannerKind : nextPending ? conversation.pending_api_error_kind ?? undefined : undefined;
    if ((conversation.pending_api_error_kind ?? undefined) !== nextBannerKind) {
      convPatch.pending_api_error_kind = nextBannerKind;
    }
    const nextBannerAt = msgIsBanner ? msgTimestamp : nextPending ? conversation.pending_api_error_at ?? undefined : undefined;
    if ((conversation.pending_api_error_at ?? undefined) !== nextBannerAt) {
      convPatch.pending_api_error_at = nextBannerAt;
    }
    // A fresh park on a blocked-kind banner triggers the debounced reactions:
    // the auto-switch check (limit only) and the aggregated incident
    // notification (any blocked kind). Statusful "error" banners self-retry
    // and never notify.
    if (
      msgIsBanner &&
      msgBannerKind !== "error" &&
      (!wasPendingApiError || conversation.pending_api_error_kind !== msgBannerKind)
    ) {
      await onFreshApiErrorPark(ctx, conversation.user_id, msgBannerKind);
    }
    if (args.role === "user" && contentToStore?.trim()) {
      convPatch.last_message_preview = redactSecrets(contentToStore).replace(/\u001b\[\d+m/g, "").replace(/\[Image[:\s][^\]]*\]/gi, "").trim().slice(0, 200);
      convPatch.last_user_message_at = msgTimestamp;
    } else if (args.role === "user") {
      convPatch.last_user_message_at = msgTimestamp;
    }
    const imagePreview = await latestImagePreviewUrl(ctx, [{ content: contentToStore, images }]);
    if (imagePreview && imagePreview !== conversation.image_preview_url) {
      convPatch.image_preview_url = imagePreview;
    }
    // Fold harness-loop events (ScheduleWakeup / scheduled_task_fire) into the
    // conversation's loop_state so the inbox trigger set sees the armed loop.
    const singleMsg = [{ role: args.role, subtype: args.subtype, timestamp: msgTimestamp, tool_calls: args.tool_calls }];
    if (batchHasLoopEvent(singleMsg)) {
      const nextLoop = deriveLoopState(conversation.loop_state, singleMsg, now);
      if (nextLoop) convPatch.loop_state = nextLoop;
    }
    await ctx.db.patch(args.conversation_id, convPatch);

    const hasToolResultReply = args.role === "user" && !!args.tool_results && args.tool_results.length > 0;
    if (args.role === "assistant" || hasToolResultReply) {
      const session = await ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id))
        .first();
      const nextStatus = session
        ? nextAgentStatusOnAddMessages(session.agent_status, args.role === "assistant", hasToolResultReply)
        : null;
      if (session && nextStatus) {
        await ctx.db.patch(session._id, {
          agent_status: nextStatus,
          agent_status_updated_at: Date.now(),
        });
      }
    }

    // Same open-poll trigger as addMessages (the retry-queue drain delivers
    // through this singular path).
    if (args.role === "assistant" && args.tool_calls?.some((tc) => tc.name === "AskUserQuestion")) {
      await ctx.scheduler.runAfter(NEEDS_INPUT_AUQ_CHECK_DELAY_MS, internal.notifications.checkNeedsInput, {
        conversation_id: args.conversation_id,
      });
    }

    await maybeScheduleTitleGeneration(ctx, conversation, newMessageCount - 1, newMessageCount);

    try {
      await extractDocsFromMessages(ctx, [args], conversation, args.conversation_id);
    } catch {}

    if (args.role === "user" && safeContent) {
      const planMentions = safeContent.match(/\bpl-[a-z0-9]{3,8}\b/gi);
      if (planMentions) {
        const uniquePlanMentions = [...new Set(planMentions.map(m => m.toLowerCase()))];
        for (const mention of uniquePlanMentions) {
          const plan = await ctx.db
            .query("plans")
            .withIndex("by_short_id", (q) => q.eq("short_id", mention))
            .first();
          if (plan) {
            const convPlanIds = (conversation as any).plan_ids || [];
            if (!convPlanIds.some((pid: any) => pid.toString() === plan._id.toString())) {
              convPlanIds.push(plan._id);
              await ctx.db.patch(args.conversation_id, { plan_ids: convPlanIds });
            }
            const planSessionIds = plan.session_ids || [];
            if (!planSessionIds.some((sid: any) => sid.toString() === args.conversation_id.toString())) {
              planSessionIds.push(args.conversation_id);
              await ctx.db.patch(plan._id, { session_ids: planSessionIds, updated_at: Date.now() });
            }
          }
        }
      }

      const taskMentions = safeContent.match(/\bct-[a-z0-9]{3,8}\b/gi);
      if (taskMentions) {
        const uniqueTaskMentions = [...new Set(taskMentions.map(m => m.toLowerCase()))];
        for (const mention of uniqueTaskMentions) {
          const task = await ctx.db
            .query("tasks")
            .withIndex("by_short_id", (q) => q.eq("short_id", mention))
            .first();
          if (task) {
            const taskConvIds = task.conversation_ids || [];
            if (!taskConvIds.some((cid: any) => cid.toString() === args.conversation_id.toString())) {
              taskConvIds.push(args.conversation_id);
              await ctx.db.patch(task._id, { conversation_ids: taskConvIds });
            }
          }
        }
      }
    }

    return messageId;
  },
});

const MAX_BATCH_SIZE = 25;

// An in-place patch to a row this far behind the conversation head counts as a
// backfill edit (resync after resume/fork, late attribution), which the live
// tail subscription cannot see — it bumps conversations.transcript_revision so
// the client's watermark triggers a snapshot refetch. Streaming patches target
// the newest row and stay inside the margin, so they bump nothing.
const OLD_ROW_EDIT_MARGIN_MS = 120_000;

// Deletes Claude Code API/auth-error banner messages (see isApiErrorBanner) that
// precede `beforeTs` in a conversation — used to retract a stale banner once a
// genuine turn supersedes it. Bounded to the recent tail (banners only ever sit
// at the end of a conversation) so it stays cheap. Returns how many were removed.
export async function supersedeApiErrorBanners(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  beforeTs: number,
): Promise<number> {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conversationId))
    .order("desc")
    .take(12);
  let deleted = 0;
  for (const r of recent) {
    if (r.timestamp < beforeTs && isBannerTurn(r)) {
      await ctx.db.delete(r._id);
      deleted++;
    }
  }
  return deleted;
}

const messageValidator = v.object({
  message_uuid: v.optional(v.string()),
  // Accepted for wire compatibility with daemons that still stamp source
  // ordering; the handler does not use them.
  source_device_id: v.optional(v.string()),
  source_revision: v.optional(v.number()),
  role: v.union(
    v.literal("user"),
    v.literal("assistant"),
    v.literal("system"),
    v.literal("tool")
  ),
  content: v.optional(v.string()),
  thinking: v.optional(v.string()),
  tool_calls: v.optional(v.array(v.object({
    id: v.string(),
    name: v.string(),
    input: v.string(),
  }))),
  tool_results: v.optional(v.array(v.object({
    tool_use_id: v.string(),
    content: v.string(),
    is_error: v.optional(v.boolean()),
  }))),
  images: v.optional(v.array(v.object({
    media_type: v.string(),
    data: v.optional(v.string()),
    storage_id: v.optional(v.id("_storage")),
    tool_use_id: v.optional(v.string()),
  }))),
  subtype: v.optional(v.string()),
  model: v.optional(v.string()),
  timestamp: v.optional(v.number()),
});

export type AddMessagesAgentStatusProjection = {
  has_assistant_message: boolean;
  has_tool_result_reply: boolean;
};

export function getAddMessagesAgentStatusProjection(
  messages: Array<{ role: string; tool_results?: unknown[] }>,
): AddMessagesAgentStatusProjection | null {
  const hasAssistantMsg = messages.some((m) => m.role === "assistant");
  const hasToolResultReply = messages.some(
    (m) => m.role === "user" && !!m.tool_results && m.tool_results.length > 0,
  );
  if (!hasAssistantMsg && !hasToolResultReply) return null;
  return {
    has_assistant_message: hasAssistantMsg,
    has_tool_result_reply: hasToolResultReply,
  };
}

export function shouldApplyAddMessagesAgentStatusProjection(
  agentStatusUpdatedAt: number | undefined,
  scheduledAt: number,
): boolean {
  return agentStatusUpdatedAt === undefined || agentStatusUpdatedAt <= scheduledAt;
}

// Content-matched duplicate suppression for USER rows: the same typed message
// (or the same pasted image with no text) can reach the server twice with
// different uuids — a fast text-only sync path and a later image-aware one — so
// a fresh user row within the window is folded into the existing one.
//
// A tool result is not a typed message. Its `content` is empty, so under the
// image branch every screenshot-carrying result matched the previous tool
// result row and was silently dropped (12 of 20 browser_batch results in one
// session). Rows carrying tool_results are excluded on BOTH sides: an incoming
// result is never folded, and an existing result row is never a fold target.
export type UserDedupeRow = {
  role: string;
  content?: string;
  timestamp: number;
  tool_results?: unknown[];
  images?: unknown[];
};

export function findDuplicateUserRow<T extends UserDedupeRow>(
  recent: T[],
  incoming: { content?: string; timestamp: number; tool_results?: unknown[]; images?: unknown[] },
  normalize: (content: string) => string = (c) => c,
): T | undefined {
  if (incoming.tool_results && incoming.tool_results.length > 0) return undefined;
  const content = (incoming.content || "").trim();
  const hasImages = !!incoming.images && incoming.images.length > 0;
  if (!content && !hasImages) return undefined;
  const window = content ? 5 * 60 * 1000 : 30_000;
  return recent.find(
    (r) =>
      r.role === "user" &&
      !(r.tool_results && r.tool_results.length > 0) &&
      normalize(r.content || "").trim() === content &&
      Math.abs(incoming.timestamp - r.timestamp) < window,
  );
}

export const addMessages = mutation({
  args: {
    conversation_id: v.id("conversations"),
    messages: v.array(messageValidator),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.messages.length === 0) {
      return { inserted: 0, ids: [] };
    }
    if (args.messages.length > MAX_BATCH_SIZE) {
      throw new Error(`Batch size ${args.messages.length} exceeds maximum of ${MAX_BATCH_SIZE}`);
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    if (conversation.user_id.toString() !== authUserId.toString()) {
      console.warn(
        `[addMessages] cross-user write blocked: auth=${authUserId} conv=${args.conversation_id} owner=${conversation.user_id} session=${conversation.session_id ?? "?"} batch=${args.messages.length}`,
      );
      throw new Error("Unauthorized: can only add messages to your own conversations");
    }

    const messages = args.messages.filter((msg) =>
      !(
        conversation.owner_device_id &&
        typeof msg.source_device_id === "string" &&
        typeof msg.source_revision === "number" &&
        msg.source_device_id !== conversation.owner_device_id
      )
    );
    if (messages.length === 0) {
      // The session moved to another device. Acknowledge the old daemon's
      // durable retry without letting any transcript-derived side effects
      // (status, loop state, title/doc extraction) leak through.
      return {
        inserted: 0,
        ids: [],
        transcript_revision: conversation.transcript_revision ?? 0,
      };
    }

    const ids: Id<"messages">[] = [];
    let insertedCount = 0;
    let oldRowEdits = 0;
    let lastUserContentStored: string | undefined;

    // Collect pending_messages ONCE per batch instead of once per user message.
    // This was the dominant per-message read amplifier on the write hot-path —
    // a 25-message batch with several user turns re-scanned the whole pending set
    // each time. Most batches have no pending rows, so we skip the read entirely
    // unless the batch actually carries a user message. consumedPendingIds keeps a
    // pending row from matching two different user messages in the same batch.
    const batchHasUserMsg = args.messages.some((m) => m.role === "user");
    const pendingMsgs = batchHasUserMsg
      ? await ctx.db
          .query("pending_messages")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
          .collect()
      : [];
    const consumedPendingIds = new Set<Id<"pending_messages">>();

    for (const msg of args.messages) {
      const msgTimestamp = msg.timestamp || Date.now();

      const safeContent = msg.content ? redactSecrets(msg.content) : msg.content;
      const safeThinking = msg.thinking ? redactSecrets(msg.thinking) : msg.thinking;
      const safeToolCalls = msg.tool_calls?.map(tc => ({
        ...tc,
        input: redactSecrets(tc.input),
      }));
      const safeToolResults = msg.tool_results?.map(tr => ({
        ...tr,
        content: redactSecrets(tr.content),
      }));
      // Resolve the exact pending intent before duplicate suppression. Two
      // identical user sends with different client ids are distinct durable
      // commands and need distinct transcript relations for v2 coverage.
      const matchingPending = msg.role === "user" && pendingMsgs.length > 0
        ? findEchoedPendingMessage(
            pendingMsgs,
            safeContent,
            msgTimestamp,
            consumedPendingIds,
          )
        : undefined;

      if (msg.message_uuid) {
        const existing = await ctx.db
          .query("messages")
          .withIndex("by_conversation_uuid", (q) =>
            q.eq("conversation_id", args.conversation_id).eq("message_uuid", msg.message_uuid)
          )
          .first();

        if (existing) {
          const patch = buildExistingMessagePatch(existing, {
            role: msg.role,
            content: safeContent,
            thinking: safeThinking,
            tool_calls: safeToolCalls,
            tool_results: safeToolResults,
            images: msg.images,
            subtype: msg.subtype,
            model: msg.model,
          });
          if (patch) {
            await ctx.db.patch(existing._id, patch);
            // An edit far behind the conversation head is a backfill (resync
            // after resume/fork), invisible to the client's live tail
            // subscription — count it so the watermark bumps below. The margin
            // keeps ordinary streaming patches (which target the newest row)
            // from bumping the conversation doc on every flush.
            if (existing.timestamp < conversation.updated_at - OLD_ROW_EDIT_MARGIN_MS) {
              oldRowEdits++;
            }
          }
          ids.push(existing._id);
          continue;
        }
      }

      if (msg.role === "user") {
        const hasContent = !!safeContent?.trim();
        const hasImages = msg.images && msg.images.length > 0;
        const hasToolResults = !!msg.tool_results && msg.tool_results.length > 0;
        if ((hasContent || hasImages) && !hasToolResults) {
          const recentMessages = await ctx.db
            .query("messages")
            .withIndex("by_conversation_timestamp", (q) =>
              q.eq("conversation_id", args.conversation_id)
            )
            .order("desc")
            .take(5);
          const dup = findDuplicateUserRow(
            recentMessages,
            { content: safeContent, timestamp: msgTimestamp, tool_results: msg.tool_results, images: msg.images },
            redactSecrets,
          );
          if (dup && (!matchingPending?.client_id ||
            dup.client_id === matchingPending.client_id)) {
            // If incoming message has images/tool_results that the existing doesn't, patch them in.
            // This handles the race where a fast sync path stores the message without images,
            // and the image-aware sync arrives later matching by content dedup.
            const patch: Record<string, unknown> = {};
            if (msg.images && msg.images.length > 0 && (!dup.images || dup.images.length === 0)) {
              patch.images = msg.images;
            }
            if (msg.tool_results && msg.tool_results.length > 0 && (!dup.tool_results || dup.tool_results.length === 0)) {
              patch.tool_results = safeToolResults;
            }
            if (Object.keys(patch).length > 0) {
              await ctx.db.patch(dup._id, patch);
            }
            if (matchingPending) {
              consumedPendingIds.add(matchingPending._id);
              const dupPatch: Record<string, unknown> = {};
              if (!dup.client_id && matchingPending.client_id) {
                dupPatch.client_id = matchingPending.client_id;
              }
              if (!dup.from_user_id && matchingPending.from_user_id) {
                dupPatch.from_user_id = matchingPending.from_user_id;
              }
              if (Object.keys(dupPatch).length > 0) {
                await ctx.db.patch(dup._id, dupPatch);
              }
              await markPendingDelivered(ctx, matchingPending);
              if (!matchingPending.echo_message_id) {
                await ctx.db.patch(matchingPending._id, { echo_message_id: dup._id });
              }
            }
            ids.push(dup._id);
            continue;
          }
        }
      }

      let images = msg.images;
      let contentToStore = safeContent;
      let clientIdToStore: string | undefined;
      if (matchingPending) {
          consumedPendingIds.add(matchingPending._id);
          contentToStore = redactSecrets(matchingPending.content);
          clientIdToStore = matchingPending.client_id;
          // The agent echoed this user message to its JSONL — durable proof it was received.
          // Promote the pending row to "delivered" here (atomic with the insert, content-matched)
          // so the ack can't be missed by a fire-and-forget side-channel or a non-acking sync
          // path. delivered is terminal, so the 120s stuck-message reset stops re-injecting it.
          await markPendingDelivered(ctx, matchingPending);
      }
      if (msg.role === "user") {
        const resolved = resolveEchoImages(images, matchingPending, safeContent || "");
        images = (resolved === null
          ? await verifiedEchoImages(ctx, safeContent || "")
          : resolved) as typeof images;
        if (images && images.length === 0) images = undefined;
      }

      const messageId = await ctx.db.insert("messages", {
        conversation_id: args.conversation_id,
        // Sender identity comes from the echoed pending row (team sends, cast
        // send); owner-typed terminal messages have no pending row and stay
        // unattributed, which the UI reads as "the owner".
        from_user_id: matchingPending?.from_user_id,
        message_uuid: msg.message_uuid,
        role: msg.role,
        content: contentToStore,
        thinking: safeThinking,
        tool_calls: safeToolCalls,
        tool_results: safeToolResults,
        images,
        subtype: msg.subtype,
        model: msg.model,
        client_id: clientIdToStore,
        timestamp: msgTimestamp,
      });
      if (matchingPending) {
        // Tie the row to its echo so a later identical send can never re-adopt
        // it (the delivered-tier match in findEchoedPendingMessage keys off this).
        await ctx.db.patch(matchingPending._id, { echo_message_id: messageId });
      }
      ids.push(messageId);
      insertedCount++;
      await maybeRecordUserSend(ctx, conversation, { role: msg.role, content: contentToStore, tool_results: safeToolResults, from_user_id: matchingPending?.from_user_id }, msgTimestamp);
      await materializeFileChanges(ctx, args.conversation_id, messageId, msgTimestamp, safeToolCalls, safeToolResults);
      await materializeConversationImages(ctx, args.conversation_id, messageId, msgTimestamp, contentToStore, images);
      if (msg.role === "user") lastUserContentStored = contentToStore;
    }

    if (insertedCount > 0) {
      const newMessageCount = conversation.message_count + insertedCount;
      const lastMsg = args.messages[args.messages.length - 1];
      // Use the actual max message timestamp instead of Date.now(): for live
      // sync these match, but for historical backfill (sync_mode=all dredging
      // up months-old JSONLs) Date.now() would falsely mark every old session
      // as just-active and pollute the inbox's "needs input" / "working"
      // buckets. Math.max guards against clock skew or out-of-order batches.
      const maxMsgTs = args.messages.reduce((max, m) => Math.max(max, m.timestamp || 0), 0);

      // --- Supersede transient Claude Code API/auth-error banners ---
      // The CLI rewinds these out of its transcript on a successful retry, but
      // the daemon's append-only sync has already persisted the banner. Once a
      // genuine turn lands, delete the stale banner(s) that precede it; a
      // banner-only batch just flips the gate flag so a later turn can clear it.
      // The deletion scan only runs on the rare recovery batch — ordinary
      // traffic skips it entirely.
      const batchHasBanner = args.messages.some(isBannerTurn);
      const batchHasRealTurn = args.messages.some(isRealTurn);
      const maxRealTurnTs = args.messages.reduce(
        (max, m) => (isRealTurn(m) ? Math.max(max, m.timestamp || 0) : max),
        0,
      );
      const newestSignificant = newestSignificantMessage(args.messages);
      const wasPendingApiError = conversation.pending_api_error === true;

      let supersededBanners = 0;
      if (
        apiErrorBatchAction({
          batchHasRealTurn,
          batchHasBanner,
          conversationPending: wasPendingApiError,
        }) === "supersede"
      ) {
        supersededBanners = await supersedeApiErrorBanners(ctx, args.conversation_id, maxRealTurnTs);
      }

      const convPatch: Record<string, unknown> = {
        message_count: newMessageCount - supersededBanners,
        updated_at: Math.max(conversation.updated_at, maxMsgTs || Date.now()),
        last_message_role: lastMsg.role,
      };
      if (oldRowEdits > 0) {
        convPatch.transcript_revision = (conversation.transcript_revision ?? 0) + 1;
      }
      const batchModel = lastKnownModelFromBatch(args.messages);
      if (batchModel && batchModel !== conversation.model) {
        convPatch.model = batchModel;
      }
      const batchEffort = lastKnownEffortFromBatch(args.messages);
      if (batchEffort && batchEffort !== conversation.effort) {
        convPatch.effort = batchEffort;
      }
      // Keep the gate flag in lockstep with "newest banner-or-turn is a banner".
      const newestIsBanner = newestSignificant != null && isBannerTurn(newestSignificant);
      const nextPending = nextPendingApiError({
        newestIsBanner,
        batchHasRealTurn,
        conversationPending: wasPendingApiError,
      });
      if (nextPending !== wasPendingApiError) {
        convPatch.pending_api_error = nextPending;
      }
      // A kept flag keeps its kind and stamp; only a fresh banner rewrites them.
      const nextBannerKind = newestIsBanner
        ? classifyApiErrorBanner(newestSignificant!.content) ?? undefined
        : nextPending ? conversation.pending_api_error_kind ?? undefined : undefined;
      if ((conversation.pending_api_error_kind ?? undefined) !== nextBannerKind) {
        convPatch.pending_api_error_kind = nextBannerKind;
      }
      const nextBannerAt = newestIsBanner
        ? newestSignificant!.timestamp || Date.now()
        : nextPending ? conversation.pending_api_error_at ?? undefined : undefined;
      if ((conversation.pending_api_error_at ?? undefined) !== nextBannerAt) {
        convPatch.pending_api_error_at = nextBannerAt;
      }
      // A fresh blocked-kind park triggers the debounced reactions (see
      // addMessage): auto-switch check + aggregated incident notification.
      if (
        newestIsBanner &&
        nextBannerKind &&
        nextBannerKind !== "error" &&
        (!wasPendingApiError || conversation.pending_api_error_kind !== nextBannerKind)
      ) {
        await onFreshApiErrorPark(ctx, conversation.user_id, nextBannerKind);
      }
      const userMsgs = args.messages.filter((m) => m.role === "user");
      if (userMsgs.length > 0) {
        const lastUserMsg = userMsgs[userMsgs.length - 1];
        const lastUserTs = userMsgs.reduce((max, m) => Math.max(max, m.timestamp || 0), 0);
        if (lastUserTs > 0) {
          convPatch.last_user_message_at = lastUserTs;
        }
        const previewSrc = lastUserContentStored || lastUserMsg.content;
        const preview = redactSecrets(previewSrc || "").replace(/\u001b\[\d+m/g, "").replace(/\[Image[:\s][^\]]*\]/gi, "").trim().slice(0, 200);
        if (preview) {
          convPatch.last_message_preview = preview;
        }
      }
      const imagePreview = await latestImagePreviewUrl(ctx, args.messages);
      if (imagePreview && imagePreview !== conversation.image_preview_url) {
        convPatch.image_preview_url = imagePreview;
      }
      await ctx.db.patch(args.conversation_id, convPatch);

      const agentStatusProjection = getAddMessagesAgentStatusProjection(args.messages);
      if (agentStatusProjection) {
        await ctx.scheduler.runAfter(0, internal.messages.projectAgentStatusOnAddMessages, {
          conversation_id: args.conversation_id,
          scheduled_at: Date.now(),
          ...agentStatusProjection,
        });
      }

      // Comment-thread agent reply: when this conversation is the hidden fork
      // spawned to answer in a teammate comment thread, mirror its fresh reply
      // back into the placeholder comment. Single cheap field check skips this for
      // all ordinary traffic; the mirror runs off this transaction.
      if (
        (conversation as { comment_fork_comment_id?: unknown }).comment_fork_comment_id &&
        args.messages.some((m) => m.role === "assistant" && !!m.content?.trim())
      ) {
        await ctx.scheduler.runAfter(0, internal.comments.mirrorAgentReply, {
          fork_conversation_id: args.conversation_id,
        });
      }

      await maybeScheduleTitleGeneration(ctx, conversation, conversation.message_count, newMessageCount);

    } else if (oldRowEdits > 0) {
      // Backfill-only batch (no inserts): still bump the watermark so tail
      // subscribers learn that rows behind their anchor changed.
      await ctx.db.patch(args.conversation_id, {
        transcript_revision: (conversation.transcript_revision ?? 0) + 1,
      });
    }

    // Fold harness-loop events (ScheduleWakeup / scheduled_task_fire) into
    // conversation.loop_state. Like the AskUserQuestion check below, this must
    // run even when insertedCount is 0: tool_calls usually land as a PATCH to
    // the already-synced streaming message. The batchHasLoopEvent gate keeps
    // ordinary traffic free of the derivation.
    if (batchHasLoopEvent(args.messages)) {
      const nextLoop = deriveLoopState(conversation.loop_state, args.messages, Date.now());
      if (nextLoop) await ctx.db.patch(args.conversation_id, { loop_state: nextLoop });
    }

    // An AskUserQuestion tool_use arriving as the batch's newest message means
    // the agent just blocked on the user — the needs-input verdict flips NOW,
    // on this message write, not on any status write (the daemon races back to
    // "working" while the poll is open, and buffered polls send no status at
    // all). Deliberately OUTSIDE the insertedCount block: the poll's tool_calls
    // usually land as a PATCH to the already-synced streaming message
    // (insertedCount 0), which is exactly the batch that must schedule the
    // check. The check re-reads the messages table at fire time, so a poll
    // answered in the meantime is a no-op. (see notifications.checkNeedsInput)
    const newestBatchMsg = args.messages.reduce((a, b) => ((b.timestamp || 0) >= (a.timestamp || 0) ? b : a));
    if (
      newestBatchMsg.role === "assistant" &&
      newestBatchMsg.tool_calls?.some((tc) => tc.name === "AskUserQuestion")
    ) {
      await ctx.scheduler.runAfter(NEEDS_INPUT_AUQ_CHECK_DELAY_MS, internal.notifications.checkNeedsInput, {
        conversation_id: args.conversation_id,
      });
    }

    // Doc extraction touches the docs table (index reads + inserts/patches) and is
    // not latency-critical, so keep it off the addMessages transaction. Schedule it
    // only when a batch plausibly contains a doc — re-passing args.messages is size-safe
    // since that exact payload already fit this mutation's arg limit.
    if (hasDocExtractionCandidate(args.messages)) {
      await ctx.scheduler.runAfter(0, internal.messages.extractDocs, {
        conversation_id: args.conversation_id,
        messages: args.messages,
      });
    }

    return { inserted: insertedCount, ids };
  },
});

export const projectAgentStatusOnAddMessages = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    scheduled_at: v.number(),
    has_assistant_message: v.boolean(),
    has_tool_result_reply: v.boolean(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", args.conversation_id))
      .first();
    if (!session) return;
    if (!shouldApplyAddMessagesAgentStatusProjection(session.agent_status_updated_at, args.scheduled_at)) {
      return;
    }

    const nextStatus = nextAgentStatusOnAddMessages(
      session.agent_status,
      args.has_assistant_message,
      args.has_tool_result_reply,
    );
    if (!nextStatus) return;

    await ctx.db.patch(session._id, {
      agent_status: nextStatus,
      agent_status_updated_at: Date.now(),
    });
  },
});

// Off-hot-path doc extraction (scheduled by addMessages). Re-fetches the conversation
// so it works on the latest team/privacy fields rather than a stale snapshot.
export const extractDocs = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    messages: v.array(messageValidator),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return;
    try {
      await extractDocsFromMessages(ctx, args.messages, conversation, args.conversation_id);
    } catch {}
  },
});

export const existingMessageUuids = query({
  args: {
    conversation_id: v.string(),
    message_uuids: v.array(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const conversationId = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!conversationId) {
      return [];
    }

    const conversation = await ctx.db.get(conversationId);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only read your own conversations");
    }

    const unique = Array.from(new Set(args.message_uuids)).slice(0, MAX_BATCH_SIZE);
    const existing: string[] = [];
    for (const uuid of unique) {
      const found = await ctx.db
        .query("messages")
        .withIndex("by_conversation_uuid", (q) =>
          q.eq("conversation_id", conversationId).eq("message_uuid", uuid)
        )
        .first();
      if (found?.message_uuid) existing.push(found.message_uuid);
    }
    return existing;
  },
});

// Delete specific messages by uuid within a conversation. The daemon's pi
// branch-switch cleanup calls this to drop the abandoned branch's already-synced
// turns so the synced conversation equals the active branch exactly (never a splice).
// Owner-scoped (mirrors addMessages/existingMessageUuids auth) and message_count is
// reconciled on delete, the same discipline supersedeApiErrorBanners uses when it
// retracts banner rows. The daemon chunks larger orphan sets to MAX_BATCH_SIZE.
export const deleteMessagesByUuid = mutation({
  args: {
    conversation_id: v.id("conversations"),
    message_uuids: v.array(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.message_uuids.length === 0) return { deleted: 0 };
    if (args.message_uuids.length > MAX_BATCH_SIZE) {
      throw new Error(`Batch size ${args.message_uuids.length} exceeds maximum of ${MAX_BATCH_SIZE}`);
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only delete messages from your own conversations");
    }

    let deleted = 0;
    for (const uuid of new Set(args.message_uuids)) {
      const existing = await ctx.db
        .query("messages")
        .withIndex("by_conversation_uuid", (q) =>
          q.eq("conversation_id", args.conversation_id).eq("message_uuid", uuid)
        )
        .first();
      if (existing) {
        await ctx.db.delete(existing._id);
        deleted++;
      }
    }

    if (deleted > 0) {
      await ctx.db.patch(args.conversation_id, {
        message_count: Math.max(0, conversation.message_count - deleted),
      });
    }

    return { deleted };
  },
});

function generateShareToken(): string {
  return crypto.randomUUID();
}

export const generateMessageShareLink = mutation({
  args: {
    message_id: v.id("messages"),
    context_before: v.optional(v.number()),
    context_after: v.optional(v.number()),
    message_ids: v.optional(v.array(v.id("messages"))),
    note: v.optional(v.string()),
    include_conversation_link: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }

    const message = await ctx.db.get(args.message_id);
    if (!message) {
      throw new Error("Message not found");
    }

    const conversation = await ctx.db.get(message.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      if (!(await canTeamMemberAccess(ctx, authUserId, conversation))) {
        throw new Error("Unauthorized: can only share messages from your own conversations");
      }
    }

    // Linking the full conversation requires a public share_token on it. Only
    // the owner may mint one (making a conversation public is the owner's
    // consent); a team member can link it only if it is already public.
    let includeConversationLink = false;
    if (args.include_conversation_link) {
      if (conversation.share_token) {
        includeConversationLink = true;
      } else if (isOwner) {
        await ctx.db.patch(conversation._id, { share_token: generateShareToken() });
        includeConversationLink = true;
      } else {
        throw new Error("Only the conversation owner can make the full conversation public");
      }
    }

    const shareToken = generateShareToken();
    await ctx.db.insert("message_shares", {
      share_token: shareToken,
      message_id: args.message_id,
      user_id: authUserId,
      context_before: args.context_before,
      context_after: args.context_after,
      message_ids: args.message_ids,
      note: args.note,
      include_conversation_link: includeConversationLink || undefined,
      created_at: Date.now(),
    });

    return shareToken;
  },
});

export const findMessageByContent = query({
  args: {
    conversation_id: v.id("conversations"),
    search_term: v.string(),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    if ((await checkConversationAccess(ctx, authUserId, conversation, args.share_token)) === "denied") {
      return null;
    }

    const searchLower = args.search_term.toLowerCase();
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .collect();

    for (const msg of messages) {
      if (msg.content && msg.content.toLowerCase().includes(searchLower)) {
        return { message_id: msg._id, timestamp: msg.timestamp };
      }
    }

    return null;
  },
});

function parseSearchTermsServer(query: string): string[] {
  const terms: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    const term = match[1] || match[2];
    if (term) terms.push(term.toLowerCase());
  }
  return terms;
}

function countMatches(content: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = content.toLowerCase();
  let count = 0;
  for (const term of terms) {
    if (!term) continue;
    let pos = 0;
    while ((pos = lower.indexOf(term, pos)) !== -1) {
      count++;
      pos += term.length;
    }
  }
  return count;
}

export const findAllMessagesByContent = query({
  args: {
    conversation_id: v.id("conversations"),
    search_term: v.string(),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return [];
    if ((await checkConversationAccess(ctx, authUserId, conversation, args.share_token)) === "denied") return [];

    const terms = parseSearchTermsServer(args.search_term);
    if (terms.length === 0) return [];

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .collect();

    const matches: { message_id: string; timestamp: number; match_count: number }[] = [];
    for (const msg of messages) {
      if (!msg.content) continue;
      const count = countMatches(msg.content, terms);
      if (count > 0) {
        matches.push({ message_id: msg._id, timestamp: msg.timestamp, match_count: count });
      }
    }
    return matches;
  },
});

export const findMessageByContentPublic = query({
  args: {
    conversation_id: v.id("conversations"),
    search_term: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    if (!conversation.share_token) {
      return null;
    }

    const searchLower = args.search_term.toLowerCase();
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .collect();

    for (const msg of messages) {
      if (msg.content && msg.content.toLowerCase().includes(searchLower)) {
        return { message_id: msg._id, timestamp: msg.timestamp };
      }
    }

    return null;
  },
});

export const getSharedMessage = query({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const share = await ctx.db
      .query("message_shares")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .first();

    if (!share) {
      return null;
    }

    const message = await ctx.db.get(share.message_id);
    if (!message) {
      return null;
    }

    const conversation = await ctx.db.get(message.conversation_id);
    if (!conversation) {
      return null;
    }

    const user = await ctx.db.get(conversation.user_id);

    let sharedMessages: typeof message[] = [];

    if (share.message_ids && share.message_ids.length > 0) {
      const msgs = await Promise.all(share.message_ids.map(id => ctx.db.get(id)));
      sharedMessages = msgs.filter((m): m is NonNullable<typeof m> => m !== null);
      sharedMessages.sort((a, b) => a.timestamp - b.timestamp);
    } else if (share.context_before || share.context_after) {
      const allMessages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", message.conversation_id)
        )
        .collect();

      const sorted = allMessages.sort((a, b) => a.timestamp - b.timestamp);
      const targetIndex = sorted.findIndex((m) => m._id === message._id);

      if (targetIndex !== -1) {
        const startIdx = Math.max(0, targetIndex - (share.context_before || 0));
        const endIdx = Math.min(sorted.length, targetIndex + (share.context_after || 0) + 1);
        sharedMessages = sorted.slice(startIdx, endIdx);
      }
    }

    return {
      message,
      contextMessages: sharedMessages.length > 0 ? sharedMessages : [message],
      conversation: {
        _id: conversation._id,
        title: conversation.title,
        project_path: conversation.project_path,
        agent_type: conversation.agent_type,
      },
      // Read live from the conversation (not copied onto the share row) so the
      // link keeps working if the token is minted later, and only when the
      // sharer opted in.
      conversationShareToken: share.include_conversation_link ? (conversation.share_token ?? null) : null,
      user: user ? { name: user.name, image: user.image } : null,
      note: share.note,
      sharedAt: share.created_at,
    };
  },
});

export const getSharedMessageMeta = query({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const share = await ctx.db
      .query("message_shares")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .first();

    if (!share) return null;

    const message = await ctx.db.get(share.message_id);
    if (!message) return null;

    const conversation = await ctx.db.get(message.conversation_id);
    if (!conversation) return null;

    const user = await ctx.db.get(conversation.user_id);

    const raw = message.content?.trim() || "";
    const plain = raw.replace(/[*_`#~\[\]()>]/g, "").replace(/\n{2,}/g, " ").replace(/\n/g, " ").trim();
    const messagePreview = plain.length > 200 ? plain.slice(0, 200) + "..." : plain;

    const title = conversation.title
      || conversation.subtitle
      || "Coding Session";

    const description = share.note
      || messagePreview
      || conversation.subtitle
      || conversation.idle_summary
      || `Shared ${message.role === "user" ? "prompt" : "response"}${user?.name ? ` from ${user.name}` : ""}`;

    return {
      title,
      description,
      role: message.role,
      author: user?.name || null,
      note: share.note || null,
    };
  },
});


/**
 * Compatibility stub for cached web clients that still poll the transcript
 * watermark recovery path. The watermark no longer advances, so this always
 * reports the caller as current.
 */
export const getTranscriptChanges = query({
  args: {
    conversation_id: v.id("conversations"),
    after_revision: v.number(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;
    if ((await checkConversationAccess(ctx, authUserId, conversation)) === "denied") {
      return null;
    }
    const latestRevision = conversation.transcript_revision ?? 0;
    return {
      messages: [],
      last_revision: latestRevision,
      latest_revision: latestRevision,
      has_more: false,
    };
  },
});
