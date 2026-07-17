// Pure classification + one-line-summary logic for a tool call, shared across
// client renderers. PURE — no React, no DOM, no Node — Hermes/vite safe.

import { truncateStr, shortenUrl, getRelativePath } from "./format";

// Minimal structural shape of a tool call as both clients store it
// ({ id, name, input } where `input` is the raw JSON-string args). Declared
// structurally so the web and mobile `ToolCall` types both satisfy it without
// this module depending on either.
export interface ToolCallLike {
  name: string;
  input: string;
}

// A `Write` whose target lives under `.claude/plans/` is a plan write — both
// clients render it as a dedicated PlanBlock instead of a generic tool row, so
// the classification must stay identical across them.
export function isPlanWriteToolCall(tc: ToolCallLike): boolean {
  if (tc.name !== "Write") return false;
  try {
    const parsed = JSON.parse(tc.input);
    return String(parsed.file_path || "").includes(".claude/plans/");
  } catch {
    return false;
  }
}

// StructuredOutput (a workflow subagent's typed return): the INPUT is the whole
// payload — arbitrary JSON matching the workflow's schema — and the result is
// boilerplate. Summarize the payload's top-level shape: short scalar values
// inline, array lengths in brackets, bare key names for anything bigger
// (e.g. `verdict: SAFE, findings[4], reasoning`).
export function structuredPayloadSummary(parsed: Record<string, unknown>): string {
  const parts = Object.entries(parsed).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}[${value.length}]`;
    if (value !== null && typeof value === "object") return key;
    const s = String(value);
    return s.length <= 24 ? `${key}: ${s}` : key;
  });
  return truncateStr(parts.join(", "), 80);
}

// Fallback for a TRUNCATED payload (server reads cap tool input at a few
// hundred chars, chopping the JSON mid-string so JSON.parse fails): scan the
// raw prefix for top-level key names with a depth counter.
export function structuredPayloadKeysFromRaw(raw: string): string {
  const keys: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let strStart = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        if (strStart >= 0) {
          let j = i + 1;
          while (j < raw.length && /\s/.test(raw[j])) j++;
          if (raw[j] === ":") keys.push(raw.slice(strStart, i));
        }
        strStart = -1;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      strStart = depth === 1 ? i + 1 : -1;
    } else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return truncateStr(keys.join(", "), 80);
}

// One-line summary of a tool call from its raw JSON args alone — the compact
// trailing text on a collapsed tool row (e.g. the file path for a Read, the
// command for a Bash, the query for a search). Genuinely pure: depends only on
// `tc.input`, never on a tool RESULT or any renderer state. Returns "" when the
// args don't parse or the tool has no meaningful summary.
export function toolSummary(tc: ToolCallLike): string {
  let parsedInput: Record<string, any> = {};
  try {
    parsedInput = JSON.parse(tc.input);
  } catch {
    return "";
  }

  // File-based tools
  if (tc.name === "Read" || tc.name === "Edit" || tc.name === "Write") {
    return getRelativePath(String(parsedInput.file_path || ""));
  }
  if (tc.name === "file_read" || tc.name === "file_write" || tc.name === "file_edit") {
    return getRelativePath(String(parsedInput.file_path || parsedInput.path || ""));
  }

  // Shell/Terminal tools
  if (tc.name === "Bash" || tc.name === "shell_command" || tc.name === "shell" || tc.name === "exec_command" || tc.name === "container.exec") {
    const cmd = String(parsedInput.command || parsedInput.cmd || "");
    return cmd ? truncateStr(cmd, 100) : "";
  }

  // Search tools
  if (tc.name === "Glob" && parsedInput.pattern) return String(parsedInput.pattern);
  if (tc.name === "Grep" && parsedInput.pattern) return String(parsedInput.pattern);
  if (tc.name === "WebSearch" || tc.name === "web_search" || tc.name === "code_search") return parsedInput.query ? truncateStr(String(parsedInput.query), 40) : "";
  if (tc.name === "WebFetch" || tc.name === "web_fetch") return parsedInput.url ? shortenUrl(String(parsedInput.url)) : "";

  // Patch tool
  if (tc.name === "apply_patch") {
    const input = String(parsedInput.input || parsedInput.patch || "");
    const fileMatch = input.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/);
    if (fileMatch) return getRelativePath(fileMatch[1].trim());
    return "Apply patch";
  }

  // MCP Browser tools
  if (tc.name === "mcp__claude-in-chrome__computer") {
    const action = String(parsedInput.action || "");
    if (action === "screenshot") return "Screenshot";
    if (action === "left_click") {
      const coord = parsedInput.coordinate as number[] | undefined;
      return coord ? `Click (${coord[0]}, ${coord[1]})` : "Click";
    }
    if (action === "type") return `Type "${truncateStr(String(parsedInput.text || ""), 20)}"`;
    if (action === "key") return `Key: ${String(parsedInput.text || "")}`;
    if (action === "scroll") return `Scroll ${String(parsedInput.scroll_direction || "")}`;
    if (action === "wait") return `Wait ${String(parsedInput.duration || "")}s`;
    return action || "";
  }
  if (tc.name === "mcp__claude-in-chrome__navigate") {
    const url = String(parsedInput.url || "");
    if (url === "back") return "Back";
    if (url === "forward") return "Forward";
    return url ? shortenUrl(url) : "";
  }
  if (tc.name === "mcp__claude-in-chrome__read_page") {
    if (parsedInput.ref_id) return `Element ${String(parsedInput.ref_id)}`;
    if (parsedInput.filter === "interactive") return "Interactive elements";
    return "Page content";
  }
  if (tc.name === "mcp__claude-in-chrome__find") {
    return parsedInput.query ? `"${truncateStr(String(parsedInput.query), 30)}"` : "";
  }
  if (tc.name === "mcp__claude-in-chrome__form_input") {
    const ref = parsedInput.ref ? String(parsedInput.ref) : "";
    const val = parsedInput.value;
    if (ref && val !== undefined) return `${ref} = "${truncateStr(String(val), 20)}"`;
    return "";
  }
  if (tc.name === "mcp__claude-in-chrome__javascript_tool") {
    return parsedInput.text ? truncateStr(String(parsedInput.text), 40) : "";
  }
  if (tc.name === "mcp__claude-in-chrome__tabs_context_mcp") return "Get tabs";
  if (tc.name === "mcp__claude-in-chrome__tabs_create_mcp") return "Create tab";
  if (tc.name === "mcp__claude-in-chrome__update_plan") {
    const domains = parsedInput.domains as string[] | undefined;
    if (Array.isArray(domains) && domains.length) {
      return domains.slice(0, 2).join(", ") + (domains.length > 2 ? "..." : "");
    }
    return "";
  }
  if (tc.name === "mcp__claude-in-chrome__gif_creator") return String(parsedInput.action || "");
  if (tc.name === "mcp__claude-in-chrome__read_console_messages") {
    return parsedInput.pattern ? `Filter: ${String(parsedInput.pattern)}` : "";
  }
  if (tc.name === "mcp__claude-in-chrome__read_network_requests") {
    return parsedInput.urlPattern ? `Filter: ${String(parsedInput.urlPattern)}` : "";
  }
  if (tc.name === "mcp__claude-in-chrome__get_page_text") return "Extract text";
  if (tc.name === "mcp__claude-in-chrome__upload_image") return parsedInput.filename ? String(parsedInput.filename) : "Upload";
  if (tc.name === "mcp__claude-in-chrome__resize_window") return parsedInput.width && parsedInput.height ? `${parsedInput.width}x${parsedInput.height}` : "Resize";
  if (tc.name === "mcp__claude-in-chrome__shortcuts_list") return "List shortcuts";
  if (tc.name === "mcp__claude-in-chrome__shortcuts_execute") return parsedInput.command ? `/${String(parsedInput.command)}` : "Shortcut";

  if (tc.name === "StructuredOutput") return structuredPayloadSummary(parsedInput);

  // Task tools
  if (tc.name === "Task") return parsedInput.description ? truncateStr(String(parsedInput.description), 40) : "";
  if (tc.name === "AskUserQuestion") {
    const questions = parsedInput.questions as any[];
    return questions?.[0]?.question ? truncateStr(String(questions[0].question), 50) : "";
  }
  if (tc.name === "TodoWrite") {
    const todos = parsedInput.todos as any[];
    return `${todos?.length || 0} tasks`;
  }
  if (tc.name === "TaskGet") return parsedInput.taskId ? `#${parsedInput.taskId}` : "";
  if (tc.name === "TaskOutput") return parsedInput.task_id ? `task ${String(parsedInput.task_id).slice(0, 8)}` : "";
  if (tc.name === "TaskStop") return parsedInput.task_id ? `stop ${String(parsedInput.task_id).slice(0, 8)}` : "";
  if (tc.name === "TaskList") return "";
  if (tc.name === "TaskCreate") return parsedInput.subject ? truncateStr(String(parsedInput.subject), 40) : "";
  if (tc.name === "TaskUpdate") {
    const id = parsedInput.taskId ? `#${parsedInput.taskId}` : "";
    const status = parsedInput.status ? String(parsedInput.status) : "";
    if (id && status) return `${id} → ${status}`;
    return id || "";
  }
  if (tc.name === "SendMessage") {
    if (parsedInput.summary) return truncateStr(String(parsedInput.summary), 40);
    if (parsedInput.recipient) return `to ${String(parsedInput.recipient)}`;
    if (parsedInput.type === "broadcast") return "broadcast";
    return "";
  }
  if (tc.name === "TeamCreate") return parsedInput.team_name ? String(parsedInput.team_name) : "";
  if (tc.name === "TeamDelete") return "Cleanup";
  if (tc.name === "Skill") return `/${parsedInput.skill || ""}`;
  if (tc.name === "NotebookEdit") {
    const path = parsedInput.notebook_path ? getRelativePath(String(parsedInput.notebook_path)) : "";
    return path;
  }

  if (tc.name.startsWith("mcp__")) {
    const parts = tc.name.split("__");
    const method = parts[2] || "";
    const displayMethod = method.replace(/_/g, " ");
    if (parsedInput.url) return shortenUrl(String(parsedInput.url));
    if (parsedInput.query) return truncateStr(String(parsedInput.query), 30);
    return displayMethod || parts[1] || "";
  }

  return "";
}
