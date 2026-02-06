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

export async function fetchExport(siteUrl: string, apiToken: string, conversationId: string): Promise<ExportResult> {
  const resp = await fetch(`${siteUrl}/cli/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: apiToken, conversation_id: conversationId }),
  });
  const data = (await resp.json()) as any;
  if (data.error) throw new Error(`Export failed: ${data.error}`);
  return data as ExportResult;
}

function truncate(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n... (truncated)";
}

// ── Claude Code JSONL ──────────────────────────────────────

export function generateClaudeCodeJsonl(data: ExportResult): { jsonl: string; sessionId: string } {
  const lines: string[] = [];
  const sessionId = uuidv4();
  const cwd = data.conversation.project_path || process.cwd();
  let parentUuid: string | null = null;

  const firstUuid = uuidv4();
  lines.push(JSON.stringify({
    type: "file-history-snapshot",
    messageId: firstUuid,
    snapshot: { messageId: firstUuid, trackedFileBackups: {}, timestamp: data.conversation.started_at },
    isSnapshotUpdate: false,
  }));

  for (const msg of data.messages) {
    const uuid = msg.message_uuid || uuidv4();

    if (msg.role === "user") {
      if (msg.tool_results && msg.tool_results.length > 0) {
        const content = msg.tool_results.map((tr) => ({
          type: "tool_result" as const,
          tool_use_id: tr.tool_use_id,
          content: [{ type: "text" as const, text: truncate(tr.content || "") }],
        }));
        lines.push(JSON.stringify({
          parentUuid, isSidechain: false, userType: "external", cwd, sessionId,
          version: "2.1.29", gitBranch: "main", type: "user",
          message: { role: "user", content },
          uuid, timestamp: msg.timestamp,
          toolUseResult: msg.tool_results.map((tr) => ({ type: "text", text: tr.content || "" })),
        }));
      } else {
        lines.push(JSON.stringify({
          parentUuid, isSidechain: false, userType: "external", cwd, sessionId,
          version: "2.1.29", gitBranch: "main", type: "user",
          message: { role: "user", content: msg.content },
          uuid, timestamp: msg.timestamp,
          thinkingMetadata: { maxThinkingTokens: 31999 }, todos: [], permissionMode: "bypassPermissions",
        }));
      }
      parentUuid = uuid;
    } else if (msg.role === "assistant") {
      const contentBlocks: any[] = [];
      if (msg.thinking) contentBlocks.push({ type: "thinking", thinking: msg.thinking, signature: "placeholder" });
      if (msg.content) contentBlocks.push({ type: "text", text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: any = {};
          try { input = JSON.parse(tc.input); } catch {}
          contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }
      }
      if (contentBlocks.length === 0) contentBlocks.push({ type: "text", text: "" });

      const msgId = `msg_${uuidv4().replace(/-/g, "").slice(0, 24)}`;
      lines.push(JSON.stringify({
        parentUuid, isSidechain: false, userType: "external", cwd, sessionId,
        version: "2.1.29", gitBranch: "main",
        message: {
          model: data.conversation.model || "claude-opus-4-5-20251101",
          id: msgId, type: "message", role: "assistant", content: contentBlocks,
          stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500, service_tier: "standard" },
        },
        requestId: `req_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
        type: "assistant", uuid, timestamp: msg.timestamp,
      }));
      parentUuid = uuid;

      if (msg.tool_results && msg.tool_results.length > 0) {
        const trUuid = uuidv4();
        const trContent = msg.tool_results.map((tr) => ({
          type: "tool_result" as const,
          tool_use_id: tr.tool_use_id,
          content: [{ type: "text" as const, text: truncate(tr.content || "") }],
        }));
        lines.push(JSON.stringify({
          parentUuid, isSidechain: false, userType: "external", cwd, sessionId,
          version: "2.1.29", gitBranch: "main", type: "user",
          message: { role: "user", content: trContent },
          uuid: trUuid, timestamp: msg.timestamp,
          toolUseResult: msg.tool_results.map((tr) => ({ type: "text", text: tr.content || "" })),
        }));
        parentUuid = trUuid;
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

export function generateCodexJsonl(data: ExportResult): { jsonl: string; sessionId: string } {
  const lines: string[] = [];
  const sessionId = uuidv4();
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
      } else if (msg.content) {
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
