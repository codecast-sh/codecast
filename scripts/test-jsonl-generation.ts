#!/usr/bin/env bun
/**
 * JSONL Cross-Generation Test
 *
 * Converts between Claude Code and Codex session formats:
 * 1. CC DB -> Codex JSONL (resume a Claude Code conversation in Codex)
 * 2. CC DB -> Claude Code JSONL (resume a Codex conversation in Claude Code)
 */

import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";

const SITE_URL = process.env.CONVEX_URL || "https://convex-proxy-production.up.railway.app";
const CONFIG = JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".codecast", "config.json"), "utf-8"));
const API_TOKEN = CONFIG.auth_token;

interface ExportedMessage {
  role: string;
  content: string;
  thinking?: string;
  timestamp: string;
  message_uuid?: string;
  tool_calls?: Array<{ id: string; name: string; input: string }>;
  tool_results?: Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
}

interface ExportedConversation {
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

interface ExportResult {
  conversation: ExportedConversation;
  messages: ExportedMessage[];
}

async function fetchConversation(conversationId: string): Promise<ExportResult> {
  const resp = await fetch(`${SITE_URL}/cli/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: API_TOKEN, conversation_id: conversationId }),
  });
  const data = await resp.json() as any;
  if (data.error) throw new Error(`Export failed: ${data.error}`);
  return data as ExportResult;
}

// ============================================================
// Direction 1: CC DB -> Claude Code JSONL
// (Resume any conversation as a Claude Code session)
// ============================================================

function generateClaudeCodeJsonl(data: ExportResult): string {
  const lines: string[] = [];
  const sessionId = uuidv4();
  const cwd = data.conversation.project_path || process.cwd();
  let parentUuid: string | null = null;

  // 1. File history snapshot
  const firstUuid = uuidv4();
  lines.push(JSON.stringify({
    type: "file-history-snapshot",
    messageId: firstUuid,
    snapshot: {
      messageId: firstUuid,
      trackedFileBackups: {},
      timestamp: data.conversation.started_at,
    },
    isSnapshotUpdate: false,
  }));

  for (const msg of data.messages) {
    const uuid = msg.message_uuid || uuidv4();
    const timestamp = msg.timestamp;

    if (msg.role === "user") {
      if (msg.tool_results && msg.tool_results.length > 0) {
        // Tool result message
        const content = msg.tool_results.map(tr => {
          let text = tr.content || "";
          if (text.length > 2000) text = text.slice(0, 2000) + "\n... (truncated)";
          return {
            type: "tool_result" as const,
            tool_use_id: tr.tool_use_id,
            content: [{ type: "text" as const, text }],
          };
        });
        lines.push(JSON.stringify({
          parentUuid,
          isSidechain: false,
          userType: "external",
          cwd,
          sessionId,
          version: "2.1.29",
          gitBranch: "main",
          type: "user",
          message: { role: "user", content },
          uuid,
          timestamp,
          toolUseResult: msg.tool_results.map(tr => ({ type: "text", text: tr.content || "" })),
        }));
      } else {
        // Text user message
        lines.push(JSON.stringify({
          parentUuid,
          isSidechain: false,
          userType: "external",
          cwd,
          sessionId,
          version: "2.1.29",
          gitBranch: "main",
          type: "user",
          message: { role: "user", content: msg.content },
          uuid,
          timestamp,
          thinkingMetadata: { maxThinkingTokens: 31999 },
          todos: [],
          permissionMode: "bypassPermissions",
        }));
      }
      parentUuid = uuid;
    } else if (msg.role === "assistant") {
      const contentBlocks: any[] = [];

      // Add text content
      if (msg.content) {
        contentBlocks.push({ type: "text", text: msg.content });
      }

      // Add tool_use blocks
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input: any = {};
          try { input = JSON.parse(tc.input); } catch {}
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input,
          });
        }
      }

      // If no content blocks at all, add empty text
      if (contentBlocks.length === 0) {
        contentBlocks.push({ type: "text", text: "" });
      }

      const msgId = `msg_${uuidv4().replace(/-/g, "").slice(0, 24)}`;
      lines.push(JSON.stringify({
        parentUuid,
        isSidechain: false,
        userType: "external",
        cwd,
        sessionId,
        version: "2.1.29",
        gitBranch: "main",
        message: {
          model: data.conversation.model || "claude-opus-4-5-20251101",
          id: msgId,
          type: "message",
          role: "assistant",
          content: contentBlocks,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 1000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 500,
            service_tier: "standard",
          },
        },
        requestId: `req_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
        type: "assistant",
        uuid,
        timestamp,
      }));
      parentUuid = uuid;

      // If this assistant message also has tool_results (from incremental sync),
      // emit a corresponding user tool_result entry
      if (msg.tool_results && msg.tool_results.length > 0) {
        const trUuid = uuidv4();
        const trContent = msg.tool_results.map(tr => {
          let text = tr.content || "";
          if (text.length > 2000) text = text.slice(0, 2000) + "\n... (truncated)";
          return {
            type: "tool_result" as const,
            tool_use_id: tr.tool_use_id,
            content: [{ type: "text" as const, text }],
          };
        });
        lines.push(JSON.stringify({
          parentUuid,
          isSidechain: false,
          userType: "external",
          cwd,
          sessionId,
          version: "2.1.29",
          gitBranch: "main",
          type: "user",
          message: { role: "user", content: trContent },
          uuid: trUuid,
          timestamp,
          toolUseResult: msg.tool_results.map(tr => ({ type: "text", text: tr.content || "" })),
        }));
        parentUuid = trUuid;
      }
    }
  }

  return lines.join("\n") + "\n";
}

function writeClaudeCodeSession(jsonl: string, sessionId?: string): string {
  const sid = sessionId || uuidv4();
  const projectDir = path.join(
    process.env.HOME!,
    ".claude",
    "projects",
    "-Users-ashot-src-codecast"
  );
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sid}.jsonl`);
  fs.writeFileSync(filePath, jsonl);
  return sid;
}

// ============================================================
// Direction 2: CC DB -> Codex JSONL
// (Resume any conversation as a Codex session)
// ============================================================

function generateCodexJsonl(data: ExportResult): string {
  const lines: string[] = [];
  const sessionId = uuidv4();
  const cwd = data.conversation.project_path || process.cwd();
  const startTime = data.conversation.started_at;

  // 1. session_meta
  lines.push(JSON.stringify({
    timestamp: startTime,
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp: startTime,
      cwd,
      originator: "codex_cli_rs",
      cli_version: "0.94.0",
      source: "cli",
      model_provider: "openai",
      base_instructions: {
        text: "You are Codex, a coding agent.",
        source: "built-in",
      },
    },
  }));

  // 2. Developer permissions message
  lines.push(JSON.stringify({
    timestamp: startTime,
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [{
        type: "input_text",
        text: `<permissions instructions>\nFilesystem sandboxing: sandbox_mode is danger-full-access. approval_policy is never.\n</permissions instructions>`,
      }],
    },
  }));

  // 3. User AGENTS.md / instructions context
  lines.push(JSON.stringify({
    timestamp: startTime,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `# Project context\nWorking directory: ${cwd}`,
      }],
    },
  }));

  // 4. Environment context
  lines.push(JSON.stringify({
    timestamp: startTime,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>bash</shell>\n</environment_context>`,
      }],
    },
  }));

  for (const msg of data.messages) {
    const ts = msg.timestamp;

    if (msg.role === "user") {
      if (msg.tool_results && msg.tool_results.length > 0) {
        // Tool results -> function_call_output
        for (const tr of msg.tool_results) {
          lines.push(JSON.stringify({
            timestamp: ts,
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: tr.tool_use_id,
              output: tr.is_error
                ? `Error:\n${tr.content}`
                : `Exit code: 0\nOutput:\n${tr.content}`,
            },
          }));
        }
      } else if (msg.content) {
        // Regular user message
        lines.push(JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: msg.content }],
          },
        }));
        lines.push(JSON.stringify({
          timestamp: ts,
          type: "event_msg",
          payload: {
            type: "user_message",
            message: msg.content,
            images: [],
            local_images: [],
            text_elements: [],
          },
        }));
        // turn_context for each user turn
        lines.push(JSON.stringify({
          timestamp: ts,
          type: "turn_context",
          payload: {
            cwd,
            approval_policy: "never",
            sandbox_policy: { type: "danger-full-access" },
            model: "gpt-5.2-codex",
            personality: "friendly",
            collaboration_mode: {
              mode: "code",
              settings: {
                model: "gpt-5.2-codex",
                reasoning_effort: "high",
                developer_instructions: "you are now in code mode.\n",
              },
            },
            effort: "high",
            summary: "auto",
          },
        }));
      }
    } else if (msg.role === "assistant") {
      // Reasoning summary (if thinking content exists)
      if (msg.thinking) {
        lines.push(JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: msg.thinking.slice(0, 500) }],
            content: null,
            encrypted_content: null,
          },
        }));
      }

      // Tool calls -> function_call entries
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const codexToolName = mapToolName(tc.name);
          lines.push(JSON.stringify({
            timestamp: ts,
            type: "response_item",
            payload: {
              type: "function_call",
              name: codexToolName,
              arguments: tc.input,
              call_id: tc.id,
            },
          }));
        }
      }

      // Assistant text -> message + agent_message event
      if (msg.content) {
        lines.push(JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: msg.content }],
          },
        }));
        lines.push(JSON.stringify({
          timestamp: ts,
          type: "event_msg",
          payload: {
            type: "agent_message",
            message: msg.content,
          },
        }));
      }

      // Token count event
      lines.push(JSON.stringify({
        timestamp: ts,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: null,
          rate_limits: {
            primary: { used_percent: 0.0, window_minutes: 300, resets_at: 0 },
            secondary: { used_percent: 0.0, window_minutes: 10080, resets_at: 0 },
            credits: { has_credits: false, unlimited: false, balance: null },
            plan_type: null,
          },
        },
      }));
    }
  }

  return lines.join("\n") + "\n";
}

function mapToolName(ccToolName: string): string {
  // Map Claude Code tool names to Codex equivalents
  if (ccToolName === "Bash" || ccToolName === "bash") return "shell_command";
  if (ccToolName === "Read" || ccToolName === "read_file") return "shell_command";
  if (ccToolName === "Write" || ccToolName === "write_file") return "shell_command";
  if (ccToolName === "Edit" || ccToolName === "edit_file") return "shell_command";
  if (ccToolName === "Glob" || ccToolName === "glob") return "shell_command";
  if (ccToolName === "Grep" || ccToolName === "grep") return "shell_command";
  // MCP tools stay as-is or become shell
  if (ccToolName.startsWith("mcp__")) return "shell_command";
  return "shell_command";
}

function writeCodexSession(jsonl: string, sessionId?: string, name?: string): string {
  const sid = sessionId || uuidv4();
  const now = new Date();
  const dateDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `${name || "remote"}-${ts}-${sid}.jsonl`;

  const sessionsDir = path.join(process.env.HOME!, ".codex", "sessions", dateDir);
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, fileName);
  fs.writeFileSync(filePath, jsonl);
  return filePath;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const mode = process.argv[2]; // "cc2codex" or "codex2cc"
  const convId = process.argv[3];

  if (!mode || !convId) {
    console.log("Usage:");
    console.log("  bun scripts/test-jsonl-generation.ts cc2codex <conversation-id>");
    console.log("  bun scripts/test-jsonl-generation.ts codex2cc <conversation-id>");
    console.log("");
    console.log("Examples:");
    console.log("  bun scripts/test-jsonl-generation.ts cc2codex jx71hrmg5zd2gcxr02cnmy5tg180k2f7");
    console.log("  bun scripts/test-jsonl-generation.ts codex2cc jx76k8n27z16b7n20zwnx9vh5s80ecx9");
    process.exit(1);
  }

  console.log(`Fetching conversation ${convId}...`);
  const data = await fetchConversation(convId);
  console.log(`  Title: ${data.conversation.title}`);
  console.log(`  Agent: ${data.conversation.agent_type}`);
  console.log(`  Messages: ${data.messages.length}`);

  if (mode === "cc2codex") {
    console.log("\nGenerating Codex JSONL from CC DB data...");
    const jsonl = generateCodexJsonl(data);
    const lineCount = jsonl.trim().split("\n").length;
    console.log(`  Generated ${lineCount} JSONL lines`);
    const filePath = writeCodexSession(jsonl, undefined, "cc-import");
    console.log(`  Written to: ${filePath}`);
    console.log(`\nTo resume in Codex:`);
    // Extract the session ID from the filename
    const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    if (match) {
      console.log(`  codex --resume ${match[1]}`);
    }
  } else if (mode === "codex2cc") {
    console.log("\nGenerating Claude Code JSONL from CC DB data...");
    const jsonl = generateClaudeCodeJsonl(data);
    const lineCount = jsonl.trim().split("\n").length;
    console.log(`  Generated ${lineCount} JSONL lines`);
    const sid = writeClaudeCodeSession(jsonl);
    console.log(`  Session ID: ${sid}`);
    console.log(`\nTo resume in Claude Code:`);
    console.log(`  claude --resume ${sid}`);
  } else {
    console.error(`Unknown mode: ${mode}. Use "cc2codex" or "codex2cc".`);
    process.exit(1);
  }
}

main().catch(console.error);
