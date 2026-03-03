/**
 * JSONL Cross-Generation
 *
 * Converts between Claude Code and Codex session formats using DB data.
 * Used by `codecast resume --as <agent>` for cross-agent resume.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const uuidv4 = () => crypto.randomUUID();

export interface ExportedMessage {
  role: string;
  content: string;
  thinking?: string;
  timestamp: string;
  message_uuid?: string;
  tool_calls?: Array<{ id: string; name: string; input: string }>;
  tool_results?: Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
}

export interface ExportedConversation {
  id: string;
  title: string;
  session_id: string;
  agent_type: string;
  project_path: string | null;
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

export function chooseClaudeTailMessagesForTokenBudget(data: ExportResult, budgetTokens: number): number {
  if (budgetTokens <= 0) return 0;
  const messages = data.messages;
  if (messages.length === 0) return 0;

  // Reserve a little space for the truncation notice + first user message.
  const reserved = estimateTokensFromText("[Codecast import]") + 512;
  const budget = Math.max(0, budgetTokens - reserved);

  let used = 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const t = estimateTokensForMessage(messages[i]);
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
    project_path: string | null;
    message_count: number;
    updated_at: string;
  };
  messages?: Array<{
    role: string;
    content: string;
    timestamp: string;
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
      agent_type: "claude_code",
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

export interface GenerateClaudeCodeJsonlOptions {
  tailMessages?: number;
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
  const sessionId = uuidv4();
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
    const cutoffIndex = messages.length - tailMessages;
    const firstUserIndex = messages.findIndex((m) => m.role === "user");
    const firstUser = firstUserIndex >= 0 ? messages[firstUserIndex] : null;
    const tail = messages.slice(-tailMessages);

    const notice: ExportedMessage = {
      role: "user",
      timestamp: data.conversation.started_at,
      content:
        `[Codecast import] This Claude session was truncated to avoid overly-long context (which can break Claude Code /compact).\n` +
        `Original: ${messages.length} messages. Included: last ${tailMessages} messages` +
        (firstUser && firstUserIndex < cutoffIndex ? " + first user message." : "."),
    };

    messages = [notice];
    if (firstUser && firstUserIndex < cutoffIndex) {
      messages.push(firstUser);
    }
    messages.push(...tail);
  }

  for (const msg of messages) {
    const uuid = msg.message_uuid || uuidv4();

    if (msg.role === "user") {
      const { matched } = partitionToolResultsByExpected(msg.tool_results, expectedToolUseIds);
      if (matched.length > 0) {
        const content: Array<Record<string, unknown>> = [];
        if (msg.content && msg.content.trim().length > 0) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tr of matched) {
          content.push({
            type: "tool_result",
            tool_use_id: tr.tool_use_id,
            content: [{ type: "text", text: truncate(tr.content || "") }],
            ...(tr.is_error ? { is_error: true } : {}),
          });
        }
        lines.push(JSON.stringify({
          parentUuid, isSidechain: false, userType: "external", cwd, sessionId,
          version: "2.1.29", gitBranch: "main", type: "user",
          message: { role: "user", content },
          uuid, timestamp: msg.timestamp,
          toolUseResult: matched.map((tr) => ({ type: "text", text: tr.content || "" })),
        }));
        parentUuid = uuid;
      } else if (msg.content && msg.content.length > 0) {
        lines.push(JSON.stringify({
          parentUuid, isSidechain: false, userType: "external", cwd, sessionId,
          version: "2.1.29", gitBranch: "main", type: "user",
          message: { role: "user", content: msg.content },
          uuid, timestamp: msg.timestamp,
          thinkingMetadata: { maxThinkingTokens: 31999 }, todos: [], permissionMode: "bypassPermissions",
        }));
        parentUuid = uuid;
      }
      expectedToolUseIds = new Set();
    } else if (msg.role === "assistant") {
      const contentBlocks: any[] = [];
      const assistantToolUseIds = new Set<string>();
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
          model: data.conversation.model || "claude-opus-4-6-20260205",
          id: msgId, type: "message", role: "assistant", content: contentBlocks,
          stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500, service_tier: "standard" },
        },
        requestId: `req_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
        type: "assistant", uuid, timestamp: msg.timestamp,
      }));
      parentUuid = uuid;
      expectedToolUseIds = assistantToolUseIds;

      const { matched: inlineMatched } = partitionToolResultsByExpected(msg.tool_results, expectedToolUseIds);
      if (inlineMatched.length > 0) {
        const trUuid = uuidv4();
        const trContent = inlineMatched.map((tr) => ({
          type: "tool_result" as const,
          tool_use_id: tr.tool_use_id,
          content: [{ type: "text" as const, text: truncate(tr.content || "") }],
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
        expectedToolUseIds = new Set();
      }
    }
  }

  return { jsonl: lines.join("\n") + "\n", sessionId };
}

export function writeClaudeCodeSession(jsonl: string, sessionId: string, projectPath?: string): string {
  const projectSlug = (projectPath || process.cwd()).replace(/\//g, "-");
  const projectDir = path.join(process.env.HOME!, ".claude", "projects", projectSlug);
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, jsonl);
  return sessionId;
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
