// Pure classification + one-line-summary logic for a tool call, shared across
// client renderers. PURE — no React, no DOM, no Node — Hermes/vite safe.

import { truncateStr, shortenUrl, getRelativePath } from "./format";
import { formatToolName } from "./toolNames";

// Minimal structural shape of a tool call as both clients store it
// ({ id, name, input } where `input` is the raw JSON-string args). Declared
// structurally so the web and mobile `ToolCall` types both satisfy it without
// this module depending on either.
export interface ToolCallLike {
  name: string;
  input: string;
}

// Family classifiers — one set per kind so web, mobile, and the share view
// don't keep growing parallel `name === "Bash" || name === "bash" || …` lists.
// Grok's snake_case ids (`run_terminal_command`, `read_file`, `search_replace`)
// belong in the same families as Claude's capitalized names and Codex's
// `shell_command` / `file_read` synonyms.
const SHELL_TOOL_IDS = new Set([
  "Bash", "bash", "shell_command", "shell", "exec_command", "container.exec",
  "commandExecution", "run_terminal_command",
]);
const READ_TOOL_IDS = new Set(["Read", "read", "file_read", "read_file"]);
const WRITE_TOOL_IDS = new Set(["Write", "write", "file_write"]);
const EDIT_TOOL_IDS = new Set(["Edit", "edit", "file_edit", "search_replace"]);
const GREP_TOOL_IDS = new Set(["Grep", "grep"]);
const GLOB_TOOL_IDS = new Set(["Glob", "glob", "list_dir"]);
const TODO_TOOL_IDS = new Set(["TodoWrite", "todo_write", "todowrite"]);
const ASK_TOOL_IDS = new Set(["AskUserQuestion", "ask_user_question"]);
const PLAN_MODE_TOOL_IDS = new Set(["EnterPlanMode", "ExitPlanMode", "enter_plan_mode", "exit_plan_mode"]);
const AGENT_TOOL_IDS = new Set(["Task", "Agent", "spawn_subagent"]);

export const isShellTool = (name: string) => SHELL_TOOL_IDS.has(name);
export const isReadTool = (name: string) => READ_TOOL_IDS.has(name);
export const isWriteTool = (name: string) => WRITE_TOOL_IDS.has(name);
export const isEditTool = (name: string) => EDIT_TOOL_IDS.has(name);
export const isGrepTool = (name: string) => GREP_TOOL_IDS.has(name);
export const isGlobTool = (name: string) => GLOB_TOOL_IDS.has(name);
export const isTodoTool = (name: string) => TODO_TOOL_IDS.has(name);
export const isAskTool = (name: string) => ASK_TOOL_IDS.has(name);
export const isPlanModeTool = (name: string) => PLAN_MODE_TOOL_IDS.has(name);
export const isAgentTool = (name: string) => AGENT_TOOL_IDS.has(name);

/** Path argument across Claude (`file_path`), Codex (`path`), opencode (`filePath`), and Grok (`target_file` / `target_directory`). */
export function toolPathFromInput(parsed: Record<string, unknown>): string {
  return String(
    parsed.file_path || parsed.filePath || parsed.path || parsed.target_file || parsed.target_directory || "",
  );
}

// One real tool invocation recovered from a wrapper tool call. Three wrappers
// exist: Codex's `exec` program (`tools.<name>(...)` expressions), the Chrome
// extension's `browser_batch` (`{actions:[{name,input}]}`), and — parsed by the
// web's castCommand.ts into the same step shape — the CLI's `cast browser do`.
export interface NestedAction extends ToolCallLike {
  /** For Codex `exec`: the source expression passed to this inner tool. */
  source?: string;
}

/** @deprecated name kept for readers of old call sites; the type is NestedAction. */
export type CodexExecAction = NestedAction;

function skipQuoted(source: string, start: number): number {
  const quote = source[start];
  let escaped = false;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === quote) return i + 1;
  }
  return source.length;
}

function skipComment(source: string, start: number): number {
  if (source[start + 1] === "/") {
    const end = source.indexOf("\n", start + 2);
    return end < 0 ? source.length : end + 1;
  }
  if (source[start + 1] === "*") {
    const end = source.indexOf("*/", start + 2);
    return end < 0 ? source.length : end + 2;
  }
  return start + 1;
}

function findClosingParen(source: string, openAt: number): number {
  let depth = 1;
  for (let i = openAt + 1; i < source.length;) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(source, i);
      continue;
    }
    if (ch === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      i = skipComment(source, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
    i++;
  }
  return -1;
}

function decodeStaticString(source: string, start: number): string | undefined {
  const quote = source[start];
  if (quote !== "'" && quote !== '"' && quote !== "`") return undefined;
  const end = skipQuoted(source, start);
  if (end > source.length || source[end - 1] !== quote) return undefined;
  const raw = source.slice(start + 1, end - 1);
  // Interpolated template strings are runtime values, not static input.
  if (quote === "`" && /(^|[^\\])\$\{/.test(raw)) return undefined;
  if (quote === '"') {
    try {
      return JSON.parse(source.slice(start, end));
    } catch {
      // Fall through to the conservative decoder below for JS-only escapes.
    }
  }
  return raw
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\(["'`\\])/g, "$1");
}

function staticProperty(source: string, key: string): unknown {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[,{]\\s*)[\"']?${escapedKey}[\"']?\\s*:\\s*`).exec(source);
  if (!match) return undefined;
  let valueAt = match.index + match[0].length;
  while (/\s/.test(source[valueAt] || "")) valueAt++;
  const stringValue = decodeStaticString(source, valueAt);
  if (stringValue !== undefined) return stringValue;
  const scalar = /^(true|false|null|-?\d+(?:\.\d+)?)/.exec(source.slice(valueAt));
  if (!scalar) return undefined;
  if (scalar[1] === "true") return true;
  if (scalar[1] === "false") return false;
  if (scalar[1] === "null") return null;
  return Number(scalar[1]);
}

const EXEC_ACTION_SUMMARY_KEYS = [
  "cmd", "command", "path", "file_path", "filePath", "query", "url", "title",
  "prompt", "question", "pattern", "action", "text", "code", "cell_id", "q",
  "ref_id", "location", "session_id", "yield_time_ms", "timeout_ms", "detail",
] as const;

function staticActionInput(source: string): string {
  const trimmed = source.trim();
  const directString = decodeStaticString(trimmed, 0);
  if (directString !== undefined) return JSON.stringify({ input: directString });
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return JSON.stringify(parsed);
    }
  } catch {
    // Most Codex programs use ordinary JS object literals with unquoted keys.
  }

  const partial: Record<string, unknown> = {};
  for (const key of EXEC_ACTION_SUMMARY_KEYS) {
    const value = staticProperty(trimmed, key);
    if (value !== undefined) partial[key] = value;
  }
  return JSON.stringify(partial);
}

function codexExecSource(tc: ToolCallLike): string {
  if (tc.name !== "exec") return "";
  try {
    const parsed = JSON.parse(tc.input);
    return typeof parsed?.input === "string"
      ? parsed.input
      : typeof parsed?.code === "string"
        ? parsed.code
        : typeof parsed?.script === "string"
          ? parsed.script
          : "";
  } catch {
    return "";
  }
}

/**
 * Recover the real tool invocations inside Codex's custom `exec` envelope.
 *
 * Recent Codex transcripts persist an orchestration program such as
 * `await tools.exec_command({cmd: "rg foo"})` as one tool named `exec`. Claude
 * emits the inner call directly. This small lexer skips strings/comments and
 * extracts actual `tools.<name>(...)` expressions without evaluating agent
 * code, so historical Codex sessions can use the same renderer semantics.
 */
export function extractCodexExecActions(tc: ToolCallLike): NestedAction[] {
  const source = codexExecSource(tc);
  if (!source) return [];

  const actions: NestedAction[] = [];
  for (let i = 0; i < source.length;) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(source, i);
      continue;
    }
    if (ch === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      i = skipComment(source, i);
      continue;
    }
    if (source.startsWith("tools.", i)) {
      const nameStart = i + "tools.".length;
      const nameMatch = /^[A-Za-z_$][\w$]*/.exec(source.slice(nameStart));
      if (nameMatch) {
        let openAt = nameStart + nameMatch[0].length;
        while (/\s/.test(source[openAt] || "")) openAt++;
        if (source[openAt] === "(") {
          const closeAt = findClosingParen(source, openAt);
          if (closeAt >= 0) {
            const actionSource = source.slice(openAt + 1, closeAt);
            actions.push({
              name: nameMatch[0],
              input: staticActionInput(actionSource),
              source: actionSource.trim(),
            });
            i = closeAt + 1;
            continue;
          }
        }
      }
    }
    i++;
  }
  return actions;
}

export const BROWSER_BATCH_TOOL = "mcp__claude-in-chrome__browser_batch";
const BROWSER_MCP_PREFIX = "mcp__claude-in-chrome__";

/**
 * The inner tool calls of a `browser_batch`. Each item is `{name, input}` with
 * the bare extension tool name (`computer`, `navigate`, `find`…); re-prefixing
 * it makes every existing label / summary / visual rule for the standalone
 * tool apply to the batched step unchanged.
 */
export function extractBrowserBatchActions(tc: ToolCallLike): NestedAction[] {
  if (tc.name !== BROWSER_BATCH_TOOL) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(tc.input);
  } catch {
    return [];
  }
  const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
  return actions
    .filter((a: any) => a && typeof a.name === "string")
    .map((a: any) => ({
      name: a.name.startsWith("mcp__") ? a.name : `${BROWSER_MCP_PREFIX}${a.name}`,
      input: JSON.stringify(a.input && typeof a.input === "object" ? a.input : {}),
    }));
}

/**
 * Every real invocation wrapped by this tool call, or [] when it is not a
 * wrapper. This is the ONE entry point renderers use to decide "is this a
 * batch, and of what" — the collapsed-row name, the summary, the tool-group
 * counts and the expanded step list all key off it.
 */
export function extractNestedActions(tc: ToolCallLike): NestedAction[] {
  if (tc.name === "exec") return extractCodexExecActions(tc);
  if (tc.name === BROWSER_BATCH_TOOL) return extractBrowserBatchActions(tc);
  return [];
}

export function summarizeNestedActions(actions: readonly NestedAction[]): string {
  if (actions.length === 0) return "";
  if (actions.length === 1) {
    const action = actions[0];
    const summary = toolSummary(action);
    return summary ? `${formatToolName(action.name)} · ${summary}` : formatToolName(action.name);
  }
  const counts = new Map<string, number>();
  for (const action of actions) {
    const label = formatToolName(action.name);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  // A batch of one tool kind (five Browser steps), or of browser tools only
  // (Navigate · Wait · Screenshot), says nothing through its labels; the steps
  // themselves are the summary. Mixed kinds keep the counts.
  const browserOnly = actions.every(a => a.name.startsWith(BROWSER_MCP_PREFIX));
  if (counts.size === 1 || browserOnly) {
    const steps = actions.map(a => {
      const label = formatToolName(a.name);
      const summary = toolSummary(a);
      if (!summary) return label;
      return counts.size === 1 || label === "Browser" ? summary : `${label} ${summary}`;
    });
    return truncateStr(`${actions.length} steps · ${steps.join(" · ")}`, 100);
  }
  const groups = [...counts.entries()]
    .slice(0, 3)
    .map(([label, count]) => count === 1 ? label : `${label} ×${count}`);
  if (counts.size > 3) groups.push(`+${counts.size - 3} more`);
  return `${actions.length} actions · ${groups.join(" · ")}`;
}

/** @deprecated use summarizeNestedActions. */
export const summarizeCodexExecActions = summarizeNestedActions;

// The outcome of one step of a batch, aligned by index with its actions.
export interface NestedStepOutcome {
  /** What the step reported ("Clicked at (660, 178)"), without the step tag. */
  output: string;
  /** false = this step failed; undefined = it never ran (a step before it failed). */
  ok?: boolean;
}

// The extension reports a batch as one text block per step, each tagged
// "[tool]" or "[tool:action]" (older builds glued them into one line, so the
// tag — not a newline — is the boundary), then on failure a line
//   actions[i] (name) failed: <reason> (k completed, r remaining)
// after which nothing else ran. A screenshot step's image is not in the text;
// it rides on the message as an image keyed by the tool call id.
const BATCH_STEP_TAG = /\[[a-z][\w-]*(?::[a-z][\w-]*)?\]\s?/gi;
const BATCH_FAILURE = /^\s*actions\[(\d+)\]\s+\([^)]*\)\s+failed:\s*([\s\S]*?)(?:\s*\(\d+ completed, \d+ remaining\))?\s*$/i;

export function splitBrowserBatchResult(content: string, actionCount: number): NestedStepOutcome[] {
  const text = content.replace(/\n?\n?Tab Context:[\s\S]*$/, "").trim();
  const outcomes: NestedStepOutcome[] = Array.from({ length: actionCount }, () => ({ output: "" }));
  if (!text) return outcomes;

  // Peel a trailing failure line off first so its "actions[i]" index binds the
  // right step even when the tagged segments before it are glued together.
  let body = text;
  let failure: { index: number; reason: string } | null = null;
  const lastLineAt = text.lastIndexOf("\n");
  const lastLine = text.slice(lastLineAt + 1);
  const failMatch = BATCH_FAILURE.exec(lastLine) ?? (lastLineAt < 0 ? BATCH_FAILURE.exec(text) : null);
  if (failMatch) {
    failure = { index: Number(failMatch[1]), reason: failMatch[2].trim() };
    body = lastLineAt < 0 ? "" : text.slice(0, lastLineAt);
  }

  const tags = [...body.matchAll(BATCH_STEP_TAG)];
  let ran = 0;
  if (tags.length > 0) {
    tags.forEach((m, i) => {
      const start = (m.index ?? 0) + m[0].length;
      const end = i + 1 < tags.length ? (tags[i + 1].index ?? body.length) : body.length;
      if (i < actionCount) outcomes[i] = { output: body.slice(start, end).trim(), ok: true };
    });
    ran = Math.min(tags.length, actionCount);
  } else if (body.trim() && actionCount > 0) {
    // Untagged text: attribute it to the last step that ran.
    const last = failure ? Math.max(0, Math.min(failure.index, actionCount) - 1) : actionCount - 1;
    outcomes[last] = { output: body.trim(), ok: true };
    ran = last + 1;
  }
  if (failure) {
    if (failure.index < actionCount) outcomes[failure.index] = { output: failure.reason, ok: false };
    // Everything after the failure never ran; everything before it did.
    for (let i = 0; i < Math.min(failure.index, actionCount); i++) if (outcomes[i].ok === undefined) outcomes[i].ok = true;
  } else if (ran > 0 && ran === actionCount) {
    for (const o of outcomes) if (o.ok === undefined) o.ok = true;
  }
  return outcomes;
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

  if (tc.name === "exec" || tc.name === BROWSER_BATCH_TOOL) {
    return summarizeNestedActions(extractNestedActions(tc));
  }

  // File-based tools. opencode/pi lower-case their names (`read`/`edit`/`write`)
  // and key the path off `filePath` (camelCase); codex uses `path`; claude file_path;
  // grok read_file uses `target_file`, list_dir uses `target_directory`.
  if (isReadTool(tc.name) || isEditTool(tc.name) || isWriteTool(tc.name) || isGlobTool(tc.name)) {
    const path = toolPathFromInput(parsedInput);
    if (path) return getRelativePath(path);
  }

  // Shell/Terminal tools
  if (isShellTool(tc.name)) {
    const cmd = String(parsedInput.command || parsedInput.cmd || "");
    return cmd ? truncateStr(cmd, 100) : "";
  }

  // Search tools
  if (isGrepTool(tc.name) && parsedInput.pattern) return String(parsedInput.pattern);
  if (isGlobTool(tc.name) && parsedInput.pattern) return String(parsedInput.pattern);
  if (tc.name === "WebSearch" || tc.name === "web_search" || tc.name === "code_search" || tc.name === "Web search:") {
    return parsedInput.query ? truncateStr(String(parsedInput.query), 40) : "";
  }
  if (tc.name === "WebFetch" || tc.name === "web_fetch" || tc.name === "webfetch") return parsedInput.url ? shortenUrl(String(parsedInput.url)) : "";
  if (tc.name === "open_page" || tc.name === "open_page_with_find") {
    if (parsedInput.pattern) return truncateStr(String(parsedInput.pattern), 40);
    return parsedInput.url ? shortenUrl(String(parsedInput.url)) : "";
  }

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
  if (isAgentTool(tc.name)) return parsedInput.description ? truncateStr(String(parsedInput.description), 40) : "";
  if (isAskTool(tc.name)) {
    const questions = parsedInput.questions as any[];
    return questions?.[0]?.question ? truncateStr(String(questions[0].question), 50) : "";
  }
  if (isTodoTool(tc.name)) {
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

  if (tc.name === "view_image") {
    return parsedInput.path ? getRelativePath(String(parsedInput.path)) : "";
  }
  if (tc.name === "write_stdin") {
    if (parsedInput.chars) return truncateStr(String(parsedInput.chars), 40);
    return parsedInput.session_id != null ? `session ${String(parsedInput.session_id)}` : "";
  }
  if (tc.name === "wait") {
    return parsedInput.cell_id ? `cell ${String(parsedInput.cell_id)}` : "";
  }
  if (tc.name === "update_plan") {
    return Array.isArray(parsedInput.plan) ? `${parsedInput.plan.length} steps` : "";
  }
  if (tc.name === "request_user_input") {
    const questions = parsedInput.questions as any[];
    return questions?.[0]?.question ? truncateStr(String(questions[0].question), 50) : "";
  }
  if (tc.name === "tool_search") {
    return parsedInput.query ? truncateStr(String(parsedInput.query), 50) : "";
  }
  if (tc.name === "mcp__node_repl__js") {
    return parsedInput.title ? truncateStr(String(parsedInput.title), 60) : "";
  }
  if (tc.name === "image_gen__imagegen" || tc.name === "image_gen" || tc.name === "image_edit" || tc.name === "image_to_video" || tc.name === "reference_to_video") {
    return parsedInput.prompt ? truncateStr(String(parsedInput.prompt), 60) : "";
  }
  if (tc.name === "get_command_or_subagent_output") {
    const ids = parsedInput.task_ids;
    if (Array.isArray(ids) && ids[0]) return truncateStr(String(ids[0]), 24);
    return "";
  }
  if (tc.name === "kill_command_or_subagent") {
    return parsedInput.task_id ? truncateStr(String(parsedInput.task_id), 24) : "";
  }
  if (tc.name === "use_tool") {
    return parsedInput.tool_name ? String(parsedInput.tool_name) : "";
  }
  if (tc.name === "search_tool") {
    return parsedInput.query ? truncateStr(String(parsedInput.query), 50) : "";
  }
  if (tc.name === "x_user_search" || tc.name === "x_semantic_search" || tc.name === "x_keyword_search") {
    return parsedInput.query ? truncateStr(String(parsedInput.query), 50) : "";
  }
  if (tc.name === "x_thread_fetch") {
    return parsedInput.post_id ? String(parsedInput.post_id) : "";
  }
  if (tc.name === "scheduler_create") {
    return parsedInput.interval ? String(parsedInput.interval) : (parsedInput.prompt ? truncateStr(String(parsedInput.prompt), 40) : "");
  }
  if (tc.name === "web__run") {
    if (Array.isArray(parsedInput.search_query) && parsedInput.search_query[0]?.q) {
      return truncateStr(String(parsedInput.search_query[0].q), 50);
    }
    if (Array.isArray(parsedInput.open) && parsedInput.open[0]?.ref_id) {
      return shortenUrl(String(parsedInput.open[0].ref_id));
    }
    if (parsedInput.q) return truncateStr(String(parsedInput.q), 50);
    if (parsedInput.ref_id) return shortenUrl(String(parsedInput.ref_id));
    return "";
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

// The collapsed receipt chip stands in for a whole turn's tool activity, so it
// needs two phrases per family of tools: a count for a busy turn, and the real
// subject for a quiet one.
//
// `one`/`many` are the counting forms ("ran 2 commands"). `verb` is the past
// tense word a small group uses to name what it actually did ("ran npm test");
// families where verb + subject wouldn't read as a phrase omit it and always
// count. `path` marks the families whose subject is a file path, which clips
// from the other end (see clipSubject).
type ToolPhrase = { verb?: string; path?: boolean; one: string; many: (n: number) => string };

function toolPhrase(rawName: string): ToolPhrase {
  if (isReadTool(rawName)) return { verb: "read", path: true, one: "read 1 file", many: (n) => `read ${n} files` };
  if (isEditTool(rawName) || rawName === "apply_patch" || rawName === "fileChange" || rawName === "NotebookEdit") {
    return { verb: "edited", path: true, one: "1 edit", many: (n) => `${n} edits` };
  }
  if (isWriteTool(rawName)) return { verb: "wrote", path: true, one: "wrote 1 file", many: (n) => `wrote ${n} files` };
  if (isShellTool(rawName)) return { verb: "ran", one: "ran 1 command", many: (n) => `ran ${n} commands` };
  if (isGrepTool(rawName) || isGlobTool(rawName) || rawName === "code_search" || rawName === "code_analysis") {
    return { verb: "searched", one: "1 search", many: (n) => `${n} searches` };
  }
  if (rawName === "WebFetch" || rawName === "web_fetch" || rawName === "WebSearch" || rawName === "web_search" || rawName === "web__run" || rawName === "open_page" || rawName === "open_page_with_find" || rawName === "Web search:") {
    return { verb: "looked up", one: "1 web lookup", many: (n) => `${n} web lookups` };
  }
  if (isAgentTool(rawName)) return { one: "ran 1 agent", many: (n) => `ran ${n} agents` };
  if (isTodoTool(rawName)) return { one: "updated todos", many: () => "updated todos" };
  switch (rawName) {
    case "update_plan":
    case "enter_plan_mode":
    case "exit_plan_mode":
    case "EnterPlanMode":
    case "ExitPlanMode": return { one: "updated plan", many: () => "updated plan" };
    case "view_image": return { verb: "viewed", path: true, one: "viewed 1 image", many: (n) => `viewed ${n} images` };
    case "image_gen__imagegen":
    case "image_gen":
    case "image_edit": return { verb: "generated", one: "generated 1 image", many: (n) => `generated ${n} images` };
    default: {
      const label = formatToolName(rawName) || rawName;
      return { verb: label, one: label, many: (n) => `${label} ×${n}` };
    }
  }
}

// Aggregate tool counts into a human phrase: "read 3 files · ran 2 commands".
export function describeToolGroup(rawName: string, count: number): string {
  const phrase = toolPhrase(rawName);
  return count === 1 ? phrase.one : phrase.many(count);
}

// One or two tools fit in the same space a count would take, so say WHAT they
// did instead: "ran npm test", or "read lib/foo.ts · ran npm test". A pair of
// the same kind states the verb once ("ran git status · npm test"), and a lone
// tool spends the whole line on its subject. Returns "" when a subject is
// missing (unparsed args, a tool with nothing to show), which leaves the caller
// on the counting phrase.
export function describeSmallToolGroup(actions: readonly ToolCallLike[]): string {
  if (actions.length === 0) return "";
  const budget = actions.length === 1 ? 72 : 30;
  const parts: string[] = [];
  let previousVerb = "";
  for (const action of actions) {
    const { verb, path } = toolPhrase(action.name);
    // Multi-line commands (heredocs, chained shell) collapse to one line first,
    // so the clip spends its budget on words rather than indentation.
    const subject = clipSubject(toolSummary(action).replace(/\s+/g, " ").trim(), budget, path === true);
    if (!verb || !subject) return "";
    parts.push(verb === previousVerb ? subject : `${verb} ${subject}`);
    previousVerb = verb;
  }
  return parts.join(" · ");
}

// A command or a query leads with what identifies it, so it clips from the end.
// A path is the opposite — `codecast/packages/cli/src/stateCommand.ts` clipped
// that way keeps only the directories and drops the one word the reader wants —
// so a path sheds leading segments instead and keeps its filename.
function clipSubject(subject: string, budget: number, isPath: boolean): string {
  if (!isPath || subject.length <= budget) return truncateStr(subject, budget);
  const segments = subject.split("/");
  let kept = segments[segments.length - 1];
  for (let i = segments.length - 2; i >= 0 && `${segments[i]}/${kept}`.length <= budget; i--) {
    kept = `${segments[i]}/${kept}`;
  }
  return truncateStr(kept, budget);
}
