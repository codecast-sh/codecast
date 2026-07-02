/**
 * JSONL Cross-Generation
 *
 * Converts between Claude Code and Codex session formats using DB data.
 * Used by `codecast resume --as <agent>` for cross-agent resume.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { CODECAST_IMPORT_NOTICE_PREFIX } from "./parser";
import { claudeProjectDirName } from "./projectPathResolver.js";

const uuidv4 = () => crypto.randomUUID();

export interface ExportedMessage {
  role: string;
  content: string;
  thinking?: string;
  timestamp: string;
  message_uuid?: string;
  tool_calls?: Array<{ id: string; name: string; input: string }>;
  tool_results?: Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
  /** Synthetic context-only message (e.g. import truncation notice): emitted with
   * isMeta so Claude Code keeps it in context but no transcript/UI displays it. */
  isMeta?: boolean;
}

export interface ExportedConversation {
  id: string;
  title: string;
  session_id: string;
  agent_type: string;
  project_path: string | null;
  git_root?: string | null;
  git_remote_url?: string | null;
  model: string | null;
  message_count: number;
  started_at: string;
  updated_at: string;
}

export interface ExportResult {
  conversation: ExportedConversation;
  messages: ExportedMessage[];
}

function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  // Rough heuristic: ~4 chars/token for English-ish text and code.
  return Math.ceil(text.length / 4);
}

function estimateTokensForMessage(msg: ExportedMessage): number {
  let tokens = 0;

  if (msg.content) tokens += estimateTokensFromText(msg.content);
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      if (tc.name) tokens += estimateTokensFromText(tc.name);
      if (tc.input) tokens += estimateTokensFromText(tc.input);
    }
  }
  if (msg.tool_results) {
    for (const tr of msg.tool_results) {
      // Claude session JSONL truncates tool results; mirror that to avoid over-trimming.
      const text = truncate(tr.content || "", 2000);
      tokens += estimateTokensFromText(text);
    }
  }

  return tokens;
}

export function estimateClaudeImportTokens(data: ExportResult): number {
  let total = 0;
  for (const msg of data.messages) total += estimateTokensForMessage(msg);
  // Add rough overhead for JSONL structure / tool wrappers.
  return Math.ceil(total * 1.1);
}

/**
 * A genuine human turn — text the person actually typed, not a tool-result
 * carrier and not a synthetic import notice. These are the highest-signal,
 * cheapest messages to keep when trimming a long import: they carry the human's
 * intent across the whole conversation, so we surface every earlier one even
 * when the bulk of the middle gets dropped. Mirrors the server's own first-user
 * detection (conversations.ts: role==="user" && no tool_results && non-empty).
 */
export function isHumanInstruction(m: ExportedMessage): boolean {
  if (m.role !== "user" || m.isMeta) return false;
  if (m.tool_results && m.tool_results.length > 0) return false;
  const text = m.content?.trim() ?? "";
  return text.length > 0 && !text.startsWith(CODECAST_IMPORT_NOTICE_PREFIX);
}

export function chooseClaudeTailMessagesForTokenBudget(data: ExportResult, budgetTokens: number): number {
  if (budgetTokens <= 0) return 0;
  const messages = data.messages;
  if (messages.length === 0) return 0;

  // Reserve room for the import notice plus every earlier human instruction we
  // prepend — those are surfaced no matter where the tail starts, so they come
  // out of the budget first. Counting all of them (not just the ones before the
  // eventual cutoff) is a safe over-estimate: it only shortens the tail slightly,
  // it never overflows the window.
  let reserved = estimateTokensFromText(CODECAST_IMPORT_NOTICE_PREFIX) + 512;
  for (const m of messages) {
    if (isHumanInstruction(m)) reserved += estimateTokensForMessage(m);
  }
  const budget = Math.max(0, budgetTokens - reserved);

  let used = 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    // Human instructions are already paid for in `reserved`; don't double-count
    // the ones that fall inside the tail.
    const t = isHumanInstruction(messages[i]) ? 0 : estimateTokensForMessage(messages[i]);
    if (count > 0 && used + t > budget) break;
    used += t;
    count += 1;
  }

  return Math.max(1, count);
}

interface ExportPageResult extends ExportResult {
  next_cursor?: string | null;
  done?: boolean;
  error?: string;
  details?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

interface ReadResult {
  error?: string;
  details?: string;
  conversation?: {
    id: string;
    title: string;
    agent_type?: string;
    project_path: string | null;
    message_count: number;
    updated_at: string;
  };
  messages?: Array<{
    role: string;
    content: string;
    timestamp: string;
    message_uuid?: string;
    tool_calls?: Array<{ id?: string; name?: string; input?: string }>;
    tool_results?: Array<{ tool_use_id?: string; content?: string; is_error?: boolean }>;
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry<T>(
  url: string,
  body: Record<string, unknown>,
  context: string
): Promise<{ response: Response; data: T }> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const rawText = await response.text();
      let data: T;
      try {
        data = JSON.parse(rawText) as T;
      } catch {
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          await sleep(250 * attempt);
          continue;
        }
        throw new Error(`${context}: HTTP ${response.status} with invalid JSON`);
      }

      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(250 * attempt);
        continue;
      }

      return { response, data };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await sleep(250 * attempt);
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`${context}: ${msg}`);
}

export async function fetchExport(siteUrl: string, apiToken: string, conversationId: string): Promise<ExportResult> {
  const allMessages: ExportedMessage[] = [];
  let conversation: ExportedConversation | null = null;
  let cursor: string | undefined;
  let page = 0;

  while (true) {
    page += 1;
    if (page > 1000) {
      throw new Error("Export failed: too many pages");
    }

    const { response: resp, data } = await fetchJsonWithRetry<ExportPageResult>(
      `${siteUrl}/cli/export`,
      {
        api_token: apiToken,
        conversation_id: conversationId,
        cursor,
        limit: 500,
      },
      "Export failed"
    );

    if (data.error) {
      const details = data.details ? ` (${data.details.trim()})` : "";
      const shouldFallbackToRead =
        !cursor &&
        data.error === "Internal error" &&
        typeof data.details === "string" &&
        data.details.includes("Array length is too long");
      if (shouldFallbackToRead) {
        return await fetchExportViaReadApi(siteUrl, apiToken, conversationId);
      }
      throw new Error(`Export failed: ${data.error}${details}`);
    }
    if (!resp.ok) {
      throw new Error(`Export failed: HTTP ${resp.status}`);
    }
    if (!data.conversation || !Array.isArray(data.messages)) {
      throw new Error("Export failed: malformed export response");
    }

    if (!conversation) {
      conversation = data.conversation;
    }
    allMessages.push(...data.messages);

    const nextCursor = typeof data.next_cursor === "string" ? data.next_cursor : undefined;
    if (data.done || !nextCursor) {
      break;
    }
    if (nextCursor === cursor) {
      throw new Error("Export failed: pagination cursor did not advance");
    }
    cursor = nextCursor;
  }

  if (!conversation) {
    throw new Error("Export failed: missing conversation metadata");
  }

  return {
    conversation,
    messages: allMessages,
  };
}

async function fetchExportViaReadApi(siteUrl: string, apiToken: string, conversationId: string): Promise<ExportResult> {
  let startLine = 1;
  let totalCount = 0;
  let convMeta: ReadResult["conversation"];
  const allMessages: ExportedMessage[] = [];

  while (true) {
    const endLine = startLine + 49;
    const { response: resp, data } = await fetchJsonWithRetry<ReadResult>(
      `${siteUrl}/cli/read`,
      {
        api_token: apiToken,
        conversation_id: conversationId,
        start_line: startLine,
        end_line: endLine,
      },
      "Export failed"
    );

    if (data.error) {
      const details = data.details ? ` (${data.details.trim()})` : "";
      throw new Error(`Export failed: ${data.error}${details}`);
    }
    if (!resp.ok) {
      throw new Error(`Export failed: fallback read HTTP ${resp.status}`);
    }
    if (!data.conversation || !Array.isArray(data.messages)) {
      throw new Error("Export failed: malformed fallback read response");
    }

    if (!convMeta) {
      convMeta = data.conversation;
      totalCount = data.conversation.message_count || 0;
    }

    for (const msg of data.messages) {
      allMessages.push({
        role: msg.role,
        content: msg.content || "",
        timestamp: msg.timestamp,
        message_uuid: msg.message_uuid,
        tool_calls: msg.tool_calls?.map((tc, idx) => ({
          id: tc.id || `tool_${startLine}_${idx}`,
          name: tc.name || "unknown_tool",
          input: tc.input || "{}",
        })),
        tool_results: msg.tool_results?.map((tr) => ({
          tool_use_id: tr.tool_use_id || `tool_${startLine}`,
          content: tr.content || "",
          is_error: tr.is_error,
        })),
      });
    }

    if (allMessages.length >= totalCount || data.messages.length === 0) {
      break;
    }
    startLine += 50;
  }

  if (!convMeta) {
    throw new Error("Export failed: fallback read missing conversation metadata");
  }

  const startedAt = allMessages[0]?.timestamp || convMeta.updated_at || new Date().toISOString();

  return {
    conversation: {
      id: convMeta.id,
      title: convMeta.title,
      session_id: convMeta.id,
      agent_type: convMeta.agent_type || "claude_code",
      project_path: convMeta.project_path || null,
      model: null,
      message_count: totalCount,
      started_at: startedAt,
      updated_at: convMeta.updated_at,
    },
    messages: allMessages,
  };
}

function truncate(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n... (truncated)";
}

// ── Claude Code JSONL ──────────────────────────────────────

// Claude Code resolves the bare aliases opus/sonnet/haiku to the current model
// of that line, so they never go stale. A pinned snapshot recorded in a
// transcript dies once that snapshot is retired: `claude --resume` adopts it
// and crashes with "the selected model ... may not exist". When reconstructing
// a transcript for a conversation with no usable Claude model (never recorded,
// or a non-Claude model from a codex conversation being converted), stamp the
// alias so the transcript resolves to a live model forever.
export function claudeTranscriptModel(conversationModel: string | null | undefined): string {
  if (conversationModel && /^claude-/.test(conversationModel)) return conversationModel;
  return "opus";
}

// A session's JSONL records the model it ran on — often a pinned snapshot like
// claude-opus-4-6-20260205, which gets retired when a newer model ships. Return
// the live short alias matching the recorded model so a resume lands on a live
// model instead of a dead snapshot (if the recorded model is still current the
// alias resolves to it anyway). Also matches a bare recorded alias.
//
// Two signals mark the model a session is on, and the LAST one of either kind
// wins:
//  - assistant lines record the model each turn actually ran on;
//  - a /model switch emits a `<local-command-stdout>Set model to <Name>` user
//    line with NO assistant line until the next turn, so it's the only trace of
//    a switch-then-resume/fork-before-any-turn. Fork reconstructions stamp the
//    conversation-level model uniformly on assistant lines but preserve this
//    stdout line, so it's also what keeps forks on the switched model.
// First-match scanning is what caused the original bug: it returned the model
// the session STARTED on and reverted mid-session /model switches on every
// resume. The ANSI escapes around the name arrive JSON-escaped (literal
// `\u001b[1m` text) in raw transcript bytes; match the raw ESC byte too for
// pre-parsed content. "Default" means the user's saved default — no override.
const MODEL_ALIAS_RE =
  /"model"\s*:\s*"(?:claude-)?(opus|sonnet|haiku|fable)\b|<local-command-stdout>Set model to (?:(?:\\u001b|\x1b)\[\d+m)*(opus|sonnet|haiku|fable|default)/gi;
export function claudeModelAlias(jsonlContent: string): string | null {
  let last: string | null = null;
  MODEL_ALIAS_RE.lastIndex = 0;
  for (let m = MODEL_ALIAS_RE.exec(jsonlContent); m; m = MODEL_ALIAS_RE.exec(jsonlContent)) {
    const name = (m[1] ?? m[2]).toLowerCase();
    last = name === "default" ? null : name;
  }
  return last;
}

// Pick the `--model` flag for a resume. We override the model on EVERY resume,
// not just forks: the JSONL records whatever model the session last ran on,
// which may be a now-retired pinned snapshot. An explicit --model in extraFlags
// always wins.
export function resumeModelFlag(jsonlContent: string, extraFlags: string): string {
  if (/(^|\s)--model(\s|=)/.test(extraFlags)) return "";
  const alias = claudeModelAlias(jsonlContent);
  return alias ? ` --model ${alias}` : "";
}

// File variant of resumeModelFlag. We want the LAST recorded model, so scan a
// bounded window from the END of the file (small transcripts fit entirely, so
// the head-of-file case is covered too). If a huge transcript's tail window
// somehow contains no model field (e.g. a giant trailing user message), fall
// back to a head window rather than dropping the override — resuming with no
// flag can land on a retired pinned snapshot and crash.
const MODEL_SCAN_WINDOW_BYTES = 8 * 1024 * 1024;
function readWindow(fd: number, position: number, length: number): string {
  const buf = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buf, 0, length, position);
  return buf.toString("utf-8", 0, bytesRead);
}
export function resumeModelFlagFromFile(jsonlPath: string, extraFlags: string): string {
  if (/(^|\s)--model(\s|=)/.test(extraFlags)) return "";
  return lastFlagFromFileWindows(jsonlPath, (tail) => resumeModelFlag(tail, extraFlags));
}

// Shared tail-then-head window scan for resume flag extraction (see
// resumeModelFlagFromFile's rationale above).
function lastFlagFromFileWindows(jsonlPath: string, scan: (content: string) => string): string {
  try {
    const fd = fs.openSync(jsonlPath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const windowSize = Math.min(size, MODEL_SCAN_WINDOW_BYTES);
      const tail = readWindow(fd, size - windowSize, windowSize);
      const flag = scan(tail);
      if (flag || size <= windowSize) return flag;
      return scan(readWindow(fd, 0, windowSize));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

// Effort twin of claudeModelAlias/resumeModelFlag. Effort has NO per-message
// field in the transcript — the only signals are the switch echoes: the
// /effort command's "Set effort level to <x>" and the /model picker's
// session-only commit suffix "… with <x> effort". Both arrive with the same
// JSON-escaped-or-raw ANSI wrapping as model switch lines. "auto" clears the
// override (resume with no flag = the user's saved default).
const EFFORT_LEVEL_RE =
  /<local-command-stdout>[^<]*?(?:Set effort level to (?:(?:\\u001b|\x1b)\[\d+m)*(low|medium|high|xhigh|max|auto)\b|with (?:(?:\\u001b|\x1b)\[\d+m)*(low|medium|high|xhigh|max)(?:(?:\\u001b|\x1b)\[\d+m)* effort)/gi;
export function claudeEffortLevel(jsonlContent: string): string | null {
  let last: string | null = null;
  EFFORT_LEVEL_RE.lastIndex = 0;
  for (let m = EFFORT_LEVEL_RE.exec(jsonlContent); m; m = EFFORT_LEVEL_RE.exec(jsonlContent)) {
    const level = (m[1] ?? m[2]).toLowerCase();
    last = level === "auto" ? null : level;
  }
  return last;
}

export function resumeEffortFlag(jsonlContent: string, extraFlags: string): string {
  if (/(^|\s)--effort(\s|=)/.test(extraFlags)) return "";
  const level = claudeEffortLevel(jsonlContent);
  return level ? ` --effort ${level}` : "";
}

export function resumeEffortFlagFromFile(jsonlPath: string, extraFlags: string): string {
  if (/(^|\s)--effort(\s|=)/.test(extraFlags)) return "";
  return lastFlagFromFileWindows(jsonlPath, (tail) => resumeEffortFlag(tail, extraFlags));
}

export interface GenerateClaudeCodeJsonlOptions {
  tailMessages?: number;
  sessionId?: string;
}

type ExportedToolResult = NonNullable<ExportedMessage["tool_results"]>[number];

function partitionToolResultsByExpected(
  results: ExportedMessage["tool_results"] | undefined,
  expectedToolUseIds: Set<string>
): { matched: ExportedToolResult[]; orphaned: ExportedToolResult[] } {
  const matched: ExportedToolResult[] = [];
  const orphaned: ExportedToolResult[] = [];
  for (const tr of results || []) {
    if (expectedToolUseIds.has(tr.tool_use_id)) {
      matched.push(tr);
    } else {
      orphaned.push(tr);
    }
  }
  return { matched, orphaned };
}

export function generateClaudeCodeJsonl(
  data: ExportResult,
  options: GenerateClaudeCodeJsonlOptions = {}
): { jsonl: string; sessionId: string } {
  const lines: string[] = [];
  const sessionId = options.sessionId || uuidv4();
  const cwd = data.conversation.project_path || process.cwd();
  let parentUuid: string | null = null;
  let expectedToolUseIds = new Set<string>();

  const firstUuid = uuidv4();
  lines.push(JSON.stringify({
    type: "file-history-snapshot",
    messageId: firstUuid,
    snapshot: { messageId: firstUuid, trackedFileBackups: {}, timestamp: data.conversation.started_at },
    isSnapshotUpdate: false,
  }));

  let messages = data.messages;
  const tailMessages = typeof options.tailMessages === "number" ? options.tailMessages : undefined;
  if (tailMessages && tailMessages > 0 && messages.length > tailMessages) {
    const originalCount = messages.length;
    // The index in data.messages maps 1:1 to `cast read` line numbers (both walk
    // the same isNonEmptyMessage-filtered, ascending message list), so the numbers
    // below are directly usable in the notice's `cast read` hint.
    const cutoffIndex = originalCount - tailMessages; // tail begins here (0-based)
    const tailStartLine = cutoffIndex + 1;            // 1-based, `cast read` numbering
    const tail = messages.slice(cutoffIndex);
    // Keep every earlier human instruction, not just the first — they carry the
    // human's intent through the whole conversation and cost little.
    const earlierInstructions = messages.slice(0, cutoffIndex).filter(isHumanInstruction);

    const convRef = data.conversation.id;
    const kept = earlierInstructions.length;
    const notice: ExportedMessage = {
      role: "user",
      timestamp: data.conversation.started_at,
      isMeta: true,
      content:
        `${CODECAST_IMPORT_NOTICE_PREFIX} This session was trimmed to fit Claude's context window ` +
        `(an over-long session breaks Claude Code /compact). The full conversation is ${originalCount} messages.\n` +
        `Kept here: ${kept > 0 ? `your ${kept} earlier instruction${kept === 1 ? "" : "s"} (below), then ` : ""}` +
        `the last ${tailMessages} messages (starting at message ${tailStartLine}).\n` +
        `Need anything from the omitted middle? Read it with: cast read ${convRef} <from>:<to> ` +
        `— e.g. \`cast read ${convRef} 1:${Math.max(1, tailStartLine - 1)}\` for everything before the tail.`,
    };

    messages = [notice, ...earlierInstructions, ...tail];
  }

  for (const msg of messages) {
    const uuid = msg.message_uuid || uuidv4();

    if (msg.role === "user") {
      // Match tool_results against expected IDs from preceding assistant tool_use blocks.
      // Only remove matched IDs — carry unmatched forward for subsequent user messages,
      // since tool results can be spread across multiple user messages (one per tool_use).
      const { matched, orphaned } = partitionToolResultsByExpected(msg.tool_results, expectedToolUseIds);
      for (const tr of matched) expectedToolUseIds.delete(tr.tool_use_id);

      const allResults = [...matched, ...orphaned];

      if (allResults.length > 0) {
        const content: Array<Record<string, unknown>> = [];
        if (msg.content && msg.content.trim().length > 0) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tr of allResults) {
          content.push({
            type: "tool_result",
            tool_use_id: tr.tool_use_id,
            content: [{ type: "text", text: tr.content || "" }],
            ...(tr.is_error ? { is_error: true } : {}),
          });
        }
        lines.push(JSON.stringify({
          parentUuid, isSidechain: false, userType: "external", cwd, sessionId,
          version: "2.1.29", gitBranch: "main", type: "user",
          message: { role: "user", content },
          uuid, timestamp: msg.timestamp,
          toolUseResult: allResults.map((tr) => ({ type: "text", text: tr.content || "" })),
        }));
        parentUuid = uuid;
      } else if (msg.content && msg.content.length > 0) {
        lines.push(JSON.stringify({
          parentUuid, isSidechain: false, userType: "external", cwd, sessionId,
          version: "2.1.29", gitBranch: "main", type: "user",
          message: { role: "user", content: msg.content },
          uuid, timestamp: msg.timestamp,
          ...(msg.isMeta ? { isMeta: true } : {}),
          thinkingMetadata: { maxThinkingTokens: 31999 }, todos: [], permissionMode: "bypassPermissions",
        }));
        parentUuid = uuid;
      }
    } else if (msg.role === "assistant") {
      const contentBlocks: any[] = [];
      const assistantToolUseIds = new Set<string>();
      if (msg.thinking) contentBlocks.push({ type: "thinking", thinking: msg.thinking });
      if (msg.content) contentBlocks.push({ type: "text", text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: any = {};
          try { input = JSON.parse(tc.input); } catch {}
          contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
          assistantToolUseIds.add(tc.id);
        }
      }
      if (contentBlocks.length === 0) contentBlocks.push({ type: "text", text: "" });

      const msgId = `msg_${uuidv4().replace(/-/g, "").slice(0, 24)}`;
      lines.push(JSON.stringify({
        parentUuid, isSidechain: false, userType: "external", cwd, sessionId,
        version: "2.1.29", gitBranch: "main",
        message: {
          model: claudeTranscriptModel(data.conversation.model),
          id: msgId, type: "message", role: "assistant", content: contentBlocks,
          stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500, service_tier: "standard" },
        },
        requestId: `req_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
        type: "assistant", uuid, timestamp: msg.timestamp,
      }));
      parentUuid = uuid;
      for (const id of assistantToolUseIds) expectedToolUseIds.add(id);

      // Handle tool_results that are stored inline on the assistant message
      // (from incremental sync where results arrive with the assistant turn).
      const { matched: inlineMatched } = partitionToolResultsByExpected(msg.tool_results, expectedToolUseIds);
      if (inlineMatched.length > 0) {
        for (const tr of inlineMatched) expectedToolUseIds.delete(tr.tool_use_id);
        const trUuid = uuidv4();
        const trContent = inlineMatched.map((tr) => ({
          type: "tool_result" as const,
          tool_use_id: tr.tool_use_id,
          content: [{ type: "text" as const, text: tr.content || "" }],
          ...(tr.is_error ? { is_error: true } : {}),
        }));
        lines.push(JSON.stringify({
          parentUuid, isSidechain: false, userType: "external", cwd, sessionId,
          version: "2.1.29", gitBranch: "main", type: "user",
          message: { role: "user", content: trContent },
          uuid: trUuid, timestamp: msg.timestamp,
          toolUseResult: inlineMatched.map((tr) => ({ type: "text", text: tr.content || "" })),
        }));
        parentUuid = trUuid;
      }
    }
  }

  // Note: trailing unresolved tool_use IDs are intentionally left as-is.
  // The original JSONL files end mid-turn when sessions are interrupted,
  // and Claude Code handles resuming from that state correctly.

  return { jsonl: lines.join("\n") + "\n", sessionId };
}

export function writeClaudeCodeSession(jsonl: string, sessionId: string, projectPath?: string): { sessionId: string; filePath: string } {
  const projectSlug = claudeProjectDirName(projectPath || process.cwd());
  const projectDir = path.join(process.env.HOME!, ".claude", "projects", projectSlug);
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, jsonl);
  return { sessionId, filePath };
}

// ── Codex JSONL ────────────────────────────────────────────

function mapToolName(name: string): string {
  return "shell_command";
}

export interface GenerateCodexJsonlOptions {
  sessionId?: string;
}

export function generateCodexJsonl(
  data: ExportResult,
  options: GenerateCodexJsonlOptions = {}
): { jsonl: string; sessionId: string } {
  const lines: string[] = [];
  const sessionId = options.sessionId || uuidv4();
  const cwd = data.conversation.project_path || process.cwd();
  const startTime = data.conversation.started_at;

  lines.push(JSON.stringify({
    timestamp: startTime, type: "session_meta",
    payload: {
      id: sessionId, timestamp: startTime, cwd,
      originator: "codex_cli_rs", cli_version: "0.94.0", source: "cli",
      model_provider: "openai",
      base_instructions: { text: "You are Codex, a coding agent.", source: "built-in" },
    },
  }));

  lines.push(JSON.stringify({
    timestamp: startTime, type: "response_item",
    payload: {
      type: "message", role: "developer",
      content: [{ type: "input_text", text: `<permissions instructions>\nFilesystem sandboxing: sandbox_mode is danger-full-access. approval_policy is never.\n</permissions instructions>` }],
    },
  }));

  lines.push(JSON.stringify({
    timestamp: startTime, type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: `# Project context\nWorking directory: ${cwd}` }] },
  }));

  lines.push(JSON.stringify({
    timestamp: startTime, type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>bash</shell>\n</environment_context>` }] },
  }));

  for (const msg of data.messages) {
    const ts = msg.timestamp;

    if (msg.role === "user") {
      if (msg.tool_results && msg.tool_results.length > 0) {
        for (const tr of msg.tool_results) {
          lines.push(JSON.stringify({
            timestamp: ts, type: "response_item",
            payload: { type: "function_call_output", call_id: tr.tool_use_id, output: tr.is_error ? `Error:\n${tr.content}` : `Exit code: 0\nOutput:\n${tr.content}` },
          }));
        }
      } else {
        if (msg.content) {
          lines.push(JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: msg.content }] } }));
          lines.push(JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "user_message", message: msg.content, images: [], local_images: [], text_elements: [] } }));
          lines.push(JSON.stringify({
            timestamp: ts, type: "turn_context",
            payload: {
              cwd, approval_policy: "never", sandbox_policy: { type: "danger-full-access" },
              model: "gpt-5.2-codex", personality: "friendly",
              collaboration_mode: { mode: "code", settings: { model: "gpt-5.2-codex", reasoning_effort: "high", developer_instructions: "you are now in code mode.\n" } },
              effort: "high", summary: "auto",
            },
          }));
        }
      }
    } else if (msg.role === "assistant") {
      if (msg.thinking) {
        lines.push(JSON.stringify({
          timestamp: ts, type: "response_item",
          payload: { type: "reasoning", summary: [{ type: "summary_text", text: msg.thinking.slice(0, 500) }], content: null, encrypted_content: null },
        }));
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          lines.push(JSON.stringify({
            timestamp: ts, type: "response_item",
            payload: { type: "function_call", name: mapToolName(tc.name), arguments: tc.input, call_id: tc.id },
          }));
        }
      }
      if (msg.content) {
        lines.push(JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: msg.content }] } }));
        lines.push(JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "agent_message", message: msg.content } }));
      }
      // Inline tool_results from incremental sync
      if (msg.tool_results && msg.tool_results.length > 0) {
        for (const tr of msg.tool_results) {
          lines.push(JSON.stringify({
            timestamp: ts, type: "response_item",
            payload: { type: "function_call_output", call_id: tr.tool_use_id, output: tr.is_error ? `Error:\n${tr.content}` : `Exit code: 0\nOutput:\n${tr.content}` },
          }));
        }
      }
      lines.push(JSON.stringify({
        timestamp: ts, type: "event_msg",
        payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 0.0, window_minutes: 300, resets_at: 0 }, secondary: { used_percent: 0.0, window_minutes: 10080, resets_at: 0 }, credits: { has_credits: false, unlimited: false, balance: null }, plan_type: null } },
      }));
    }
  }

  return { jsonl: lines.join("\n") + "\n", sessionId };
}

export function writeCodexSession(jsonl: string, sessionId: string, name?: string): string {
  const now = new Date();
  const dateDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `${name || "remote"}-${ts}-${sessionId}.jsonl`;
  const sessionsDir = path.join(process.env.HOME!, ".codex", "sessions", dateDir);
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, fileName);
  fs.writeFileSync(filePath, jsonl);
  return sessionId;
}
