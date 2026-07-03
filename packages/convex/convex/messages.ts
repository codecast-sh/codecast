import { mutation, query, internalMutation, type MutationCtx } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { shouldGenerateTitle } from "./titleGeneration";
import { canTeamMemberAccess } from "./privacy";
import { redactSecrets } from "./redact";
import { markPendingDelivered } from "./pendingMessages";
import { nextAgentStatusOnAddMessages, isApiErrorBanner, classifyApiErrorBanner, apiErrorBatchAction } from "./inboxFilters";
import { classifyDocContent, extractTitleFromContent, inlineDocSourceKey } from "./docExtraction";
import { extractFileChanges, extractCommitHashFromContent, hasFileChangeToolCall, type FileChange } from "./fileChanges/extractor";

type DocExtractionMessage = {
  role?: string;
  content?: string;
  tool_calls?: Array<{ id: string; name: string; input: string }>;
  timestamp?: number;
};

type DocExtractionConversation = {
  user_id: Id<"users">;
  team_id?: string;
  project_path?: string;
  is_private?: boolean;
  team_visibility?: string;
};

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
      team_id: conversation.team_id,
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
  let convDocs: Array<{ source_file?: string; content: string }> | null = null;
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.content && msg.content.length > 5000) {
      const headingCount = (msg.content.match(/^#{1,3}\s/gm) || []).length;
      if (headingCount >= 3) {
        const syntheticPath = inlineDocSourceKey(conversation.user_id, msg.timestamp);
        if (convDocs === null) {
          convDocs = (await ctx.db
            .query("docs")
            .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversation_id))
            .collect()) as Array<{ source_file?: string; content: string }>;
        }
        // Same-conversation guard first (covers legacy wall-clock-keyed docs by
        // content); then the user+message key via the global index, which is what
        // dedups across forks/resumes of the same transcript.
        const existing =
          convDocs.some((d) => d.source_file === syntheticPath || d.content === msg.content) ||
          !!(await ctx.db
            .query("docs")
            .withIndex("by_source_file", (q: any) => q.eq("source_file", syntheticPath))
            .first());
        if (!existing) {
          convDocs.push({ source_file: syntheticPath, content: msg.content });
          await ctx.db.insert("docs", {
            user_id: conversation.user_id,
            team_id: conversation.team_id,
            title: extractTitleFromContent(msg.content),
            content: msg.content,
            doc_type: classifyDocContent(msg.content),
            source: "inline_extract",
            source_file: syntheticPath,
            conversation_id,
            project_path: conversation.project_path,
            is_private: conversation.is_private,
            team_visibility: conversation.team_visibility,
            created_at: msg.timestamp || Date.now(),
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

export const getMessageTimestamp = query({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    const isOwner = authUserId && conversation.user_id.toString() === authUserId.toString();
    const isShared = !!conversation.share_token;
    let hasTeamAccess = false;
    if (authUserId && !isOwner) {
      hasTeamAccess = await canTeamMemberAccess(ctx, authUserId, conversation);
    }
    if (!isOwner && !hasTeamAccess && !isShared) {
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
  for (const fc of extractFileChanges([msg])) {
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
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<FileChange[]> => {
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

// Storage ids embedded in an injected-image echo. The daemon delivers an image
// as `[Image /tmp/codecast/images/<storageId>.png]` (downloadImage names the
// file by its Convex storage id), so the agent's echoed user turn carries the
// pending row's storage id verbatim.
export function injectedImageStorageIds(content: string): string[] {
  const ids: string[] = [];
  const re = /\/codecast\/images\/([^/\s.\]]+)\.png/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) ids.push(m[1]);
  return ids;
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
    const pendingIds = pm.image_storage_ids ?? (pm.image_storage_id ? [pm.image_storage_id] : []);
    return pendingIds.some((id) => echoed.includes(id));
  }
  return Math.abs(msgTimestamp - (pm.created_at || 0)) < 120_000;
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
        }
        return existing._id;
      }
    }

    if (args.role === "user") {
      const hasContent = !!safeContent?.trim();
      const hasImages = args.images && args.images.length > 0;
      if (hasContent || hasImages) {
        const recentMessages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (q) =>
            q.eq("conversation_id", args.conversation_id)
          )
          .order("desc")
          .take(5);
        const dup = recentMessages.find(
          (r) =>
            r.role === "user" &&
            redactSecrets(r.content || "").trim() === (safeContent || "").trim() &&
            Math.abs(msgTimestamp - r.timestamp) < (hasContent ? 5 * 60 * 1000 : 30_000)
        );
        if (dup) {
          return dup._id;
        }
      }
    }

    let images = args.images;
    let contentToStore = safeContent;
    let clientIdToStore: string | undefined;
    if (args.role === "user") {
      const pendingMsgs = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
        .collect();
      const c = (safeContent || "").replace(/\[Image[:\s][^\]]*\]/gi, "").trim();
      const cFlat = c.replace(/\s+/g, " ").trim();
      const sorted = [...pendingMsgs].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      const matchingPending = sorted.find(pm => {
        const pc = redactSecrets(pm.content).replace(/\[image\]/gi, "").trim();
        const pcFlat = pc.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
        const contentMatch = cFlat === pcFlat || c === pc;
        if (!contentMatch) return false;
        if (!cFlat && !pcFlat) {
          return imageEchoMatchesPending(pm, safeContent || "", msgTimestamp);
        }
        return true;
      });
      if (matchingPending) {
        contentToStore = redactSecrets(matchingPending.content);
        clientIdToStore = matchingPending.client_id;
        if (!images || images.length === 0) {
          const ids = matchingPending.image_storage_ids ?? (matchingPending.image_storage_id ? [matchingPending.image_storage_id] : []);
          if (ids.length > 0) {
            images = ids.map(id => ({ media_type: "image/png", storage_id: id }));
          }
        }
        // Agent echoed the message → durable proof of delivery; promote to terminal "delivered".
        await markPendingDelivered(ctx, matchingPending);
      }
    }

    const messageId = await ctx.db.insert("messages", {
      conversation_id: args.conversation_id,
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
    await materializeFileChanges(ctx, args.conversation_id, messageId, msgTimestamp, safeToolCalls, safeToolResults);
    const newMessageCount = conversation.message_count + 1;
    const now = Date.now();

    // Mirror addMessages' API-error banner supersession on the single-message
    // retry path so a banner inserted here is cleared once a real turn lands.
    const msgBannerKind = args.role === "assistant" ? classifyApiErrorBanner(contentToStore) : null;
    const msgIsBanner = msgBannerKind !== null;
    const msgIsRealTurn =
      !msgIsBanner &&
      ((args.role === "assistant" && (!!contentToStore?.trim() || (safeToolCalls?.length ?? 0) > 0)) ||
        (args.role === "user" &&
          (!!contentToStore?.trim() || (safeToolResults?.length ?? 0) > 0 || (images?.length ?? 0) > 0)));
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
    if (msgIsBanner !== wasPendingApiError) {
      convPatch.pending_api_error = msgIsBanner;
    }
    const nextBannerKind = msgIsBanner ? msgBannerKind : undefined;
    if ((conversation.pending_api_error_kind ?? undefined) !== nextBannerKind) {
      convPatch.pending_api_error_kind = nextBannerKind;
    }
    if (args.role === "user" && contentToStore?.trim()) {
      convPatch.last_message_preview = redactSecrets(contentToStore).replace(/\u001b\[\d+m/g, "").replace(/\[Image[:\s][^\]]*\]/gi, "").trim().slice(0, 200);
      convPatch.last_user_message_at = msgTimestamp;
    } else if (args.role === "user") {
      convPatch.last_user_message_at = msgTimestamp;
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

    if (!conversation.skip_title_generation && shouldGenerateTitle(newMessageCount)) {
      await ctx.scheduler.runAfter(0, internal.titleGeneration.generateTitle, {
        conversation_id: args.conversation_id,
      });
    }

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
    if (r.timestamp < beforeTs && r.role === "assistant" && isApiErrorBanner(r.content)) {
      await ctx.db.delete(r._id);
      deleted++;
    }
  }
  return deleted;
}

const messageValidator = v.object({
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

    const ids: Id<"messages">[] = [];
    let insertedCount = 0;
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
    const pendingSorted = [...pendingMsgs].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
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
          }
          ids.push(existing._id);
          continue;
        }
      }

      if (msg.role === "user") {
        const hasContent = !!safeContent?.trim();
        const hasImages = msg.images && msg.images.length > 0;
        if (hasContent || hasImages) {
          const recentMessages = await ctx.db
            .query("messages")
            .withIndex("by_conversation_timestamp", (q) =>
              q.eq("conversation_id", args.conversation_id)
            )
            .order("desc")
            .take(5);
          const dup = recentMessages.find(
            (r) =>
              r.role === "user" &&
              redactSecrets(r.content || "").trim() === (safeContent || "").trim() &&
              Math.abs(msgTimestamp - r.timestamp) < (hasContent ? 5 * 60 * 1000 : 30_000)
          );
          if (dup) {
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
            ids.push(dup._id);
            continue;
          }
        }
      }

      let images = msg.images;
      let contentToStore = safeContent;
      let clientIdToStore: string | undefined;
      if (msg.role === "user" && pendingSorted.length > 0) {
        const c = (safeContent || "").replace(/\[Image[:\s][^\]]*\]/gi, "").trim();
        const cFlat = c.replace(/\s+/g, " ").trim();
        const matchingPending = pendingSorted.find(pm => {
          if (consumedPendingIds.has(pm._id)) return false;
          const pc = redactSecrets(pm.content).replace(/\[image\]/gi, "").trim();
          const pcFlat = pc.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
          const contentMatch = cFlat === pcFlat || c === pc;
          if (!contentMatch) return false;
          if (!cFlat && !pcFlat) {
            return imageEchoMatchesPending(pm, safeContent || "", msgTimestamp);
          }
          return true;
        });
        if (matchingPending) {
          consumedPendingIds.add(matchingPending._id);
          contentToStore = redactSecrets(matchingPending.content);
          clientIdToStore = matchingPending.client_id;
          if (!images || images.length === 0) {
            const ids = matchingPending.image_storage_ids ?? (matchingPending.image_storage_id ? [matchingPending.image_storage_id] : []);
            if (ids.length > 0) {
              images = ids.map(id => ({ media_type: "image/png", storage_id: id }));
            }
          }
          // The agent echoed this user message to its JSONL — durable proof it was received.
          // Promote the pending row to "delivered" here (atomic with the insert, content-matched)
          // so the ack can't be missed by a fire-and-forget side-channel or a non-acking sync
          // path. delivered is terminal, so the 120s stuck-message reset stops re-injecting it.
          await markPendingDelivered(ctx, matchingPending);
        }
      }

      const messageId = await ctx.db.insert("messages", {
        conversation_id: args.conversation_id,
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
      ids.push(messageId);
      insertedCount++;
      await materializeFileChanges(ctx, args.conversation_id, messageId, msgTimestamp, safeToolCalls, safeToolResults);
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
      type IncomingMsg = (typeof args.messages)[number];
      const isBannerMsg = (m: IncomingMsg) => m.role === "assistant" && isApiErrorBanner(m.content);
      const isRealTurn = (m: IncomingMsg) =>
        !isBannerMsg(m) &&
        ((m.role === "assistant" && (!!m.content?.trim() || (m.tool_calls?.length ?? 0) > 0)) ||
          (m.role === "user" &&
            (!!m.content?.trim() || (m.tool_results?.length ?? 0) > 0 || (m.images?.length ?? 0) > 0)));
      const batchHasBanner = args.messages.some(isBannerMsg);
      const batchHasRealTurn = args.messages.some(isRealTurn);
      const maxRealTurnTs = args.messages.reduce(
        (max, m) => (isRealTurn(m) ? Math.max(max, m.timestamp || 0) : max),
        0,
      );
      const newestMsg = args.messages.reduce((a, b) => ((b.timestamp || 0) >= (a.timestamp || 0) ? b : a));
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
      const batchModel = lastKnownModelFromBatch(args.messages);
      if (batchModel && batchModel !== conversation.model) {
        convPatch.model = batchModel;
      }
      const batchEffort = lastKnownEffortFromBatch(args.messages);
      if (batchEffort && batchEffort !== conversation.effort) {
        convPatch.effort = batchEffort;
      }
      // Keep the gate flag in lockstep with "newest message is a banner".
      const nextPendingApiError = isBannerMsg(newestMsg);
      if (nextPendingApiError !== wasPendingApiError) {
        convPatch.pending_api_error = nextPendingApiError;
      }
      const nextBannerKind = nextPendingApiError
        ? classifyApiErrorBanner(newestMsg.content) ?? undefined
        : undefined;
      if ((conversation.pending_api_error_kind ?? undefined) !== nextBannerKind) {
        convPatch.pending_api_error_kind = nextBannerKind;
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

      if (!conversation.skip_title_generation) {
        let shouldGen = false;
        for (let c = conversation.message_count + 1; c <= newMessageCount; c++) {
          if (shouldGenerateTitle(c)) { shouldGen = true; break; }
        }
        if (!shouldGen && conversation.subtitle === undefined && newMessageCount > 2) {
          shouldGen = true;
        }
        if (shouldGen) {
          await ctx.scheduler.runAfter(0, internal.titleGeneration.generateTitle, {
            conversation_id: args.conversation_id,
          });
        }
      }

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

    const shareToken = generateShareToken();
    await ctx.db.insert("message_shares", {
      share_token: shareToken,
      message_id: args.message_id,
      user_id: authUserId,
      context_before: args.context_before,
      context_after: args.context_after,
      message_ids: args.message_ids,
      note: args.note,
      created_at: Date.now(),
    });

    return shareToken;
  },
});

export const findMessageByContent = query({
  args: {
    conversation_id: v.id("conversations"),
    search_term: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    const isOwner = authUserId && conversation.user_id.toString() === authUserId.toString();
    const isShared = !!conversation.share_token;
    let hasTeamAccess = false;
    if (authUserId && !isOwner) {
      hasTeamAccess = await canTeamMemberAccess(ctx, authUserId, conversation);
    }
    if (!isOwner && !hasTeamAccess && !isShared) {
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
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return [];
    const isOwner = authUserId && conversation.user_id.toString() === authUserId.toString();
    const isShared = !!conversation.share_token;
    let hasTeamAccess = false;
    if (authUserId && !isOwner) {
      hasTeamAccess = await canTeamMemberAccess(ctx, authUserId, conversation);
    }
    if (!isOwner && !hasTeamAccess && !isShared) return [];

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
