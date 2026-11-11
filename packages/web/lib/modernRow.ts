// The words of a transcript row in the Modern style (components/conversation/
// blocks/ModernRow.tsx draws its icon; app/globals.css "MODERN · ROWS" its
// look). Pure: no React, no DOM.

import {
  BROWSER_BATCH_TOOL,
  formatToolName,
  isEditTool,
  isGlobTool,
  isGrepTool,
  isReadTool,
  isShellTool,
  isTodoTool,
  isWriteTool,
  shellLead,
  toolResultHint,
  toolSummary,
} from "@codecast/shared/render";
import { splitPath } from "./middleTruncate";

export type RowKind =
  | "read"
  | "edit"
  | "write"
  | "shell"
  | "search"
  | "fetch"
  | "web"
  | "browser"
  | "agent"
  | "skill"
  | "todo"
  | "mcp"
  | "tool";

/** A finished call says what it did; one with no result yet names the act,
 *  and never claims to be running (a session that died leaves calls with no
 *  result forever); a failed one says so. */
type Verbs = { done: string; plain: string; failed: string };
const VERBS: Partial<Record<RowKind, Verbs>> = {
  read: { done: "Read", plain: "Read", failed: "Read failed" },
  edit: { done: "Edited", plain: "Edit", failed: "Edit failed" },
  write: { done: "Wrote", plain: "Write", failed: "Write failed" },
  shell: { done: "Ran", plain: "Run", failed: "Command failed" },
  search: { done: "Searched", plain: "Search", failed: "Search failed" },
  fetch: { done: "Fetched", plain: "Fetch", failed: "Fetch failed" },
  web: { done: "Searched the web", plain: "Search the web", failed: "Web search failed" },
};

export function toolRowKind(name: string): RowKind {
  if (name === "apply_patch" || name === "fileChange" || name === "MultiEdit" || name === "NotebookEdit" || isEditTool(name)) return "edit";
  if (isWriteTool(name)) return "write";
  if (isReadTool(name)) return "read";
  if (isShellTool(name) || name === "exec") return "shell";
  if (isGrepTool(name) || isGlobTool(name) || name === "code_search" || name === "code_analysis") return "search";
  if (name === "WebFetch" || name === "web_fetch") return "fetch";
  if (name === "WebSearch" || name === "web_search") return "web";
  if (name === BROWSER_BATCH_TOOL || name.startsWith("mcp__claude-in-chrome__")) return "browser";
  if (name === "Task" || name === "Agent" || name === "spawn_subagent") return "agent";
  if (name === "Skill") return "skill";
  if (isTodoTool(name)) return "todo";
  if (name.startsWith("mcp__")) return "mcp";
  return "tool";
}

/** The first line of a failure, without the harness's wrapper tags: what failed. */
export function failureLine(content: string | undefined): string {
  const text = (content ?? "").replace(/<\/?[a-z_-]+>/gi, "");
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/**
 * A tool row's words in Modern: the verb, and the quiet result at its right
 * ("12 lines", "+3 −1", or what failed). `displayName` is the Classic label,
 * kept as the verb for a tool with no verb of its own (an MCP method, Skill).
 */
export function modernToolHead({
  name,
  displayName,
  result,
  resultSummary,
}: {
  name: string;
  displayName: string;
  result?: { content: string; is_error?: boolean };
  resultSummary: string | null;
}): { kind: RowKind; verb: string; meta: string | null; failed: boolean } {
  const kind = toolRowKind(name);
  const failed = !!result?.is_error;
  const verbs = VERBS[kind];
  const verb = verbs ? (failed ? verbs.failed : result ? verbs.done : verbs.plain) : displayName;
  const meta = failed
    ? failureLine(result?.content) || "failed"
    : resultSummary
      ? resultSummary.replace(/^\((.*)\)$/, "$1").replace(/^\+(\d+) -(\d+)$/, "+$1 −$2")
      : null;
  return { kind, verb, meta, failed };
}

type GroupCall = { name: string; input: string };
type GroupResult = { content: string; is_error?: boolean } | undefined;

/** One call's subject in a folded run: a command by its program, a path by its file name. */
function groupSubject(call: GroupCall, kind: RowKind): string {
  const summary = toolSummary(call).replace(/\s+/g, " ").trim();
  if (kind === "shell") return shellLead(summary) || summary;
  if (kind === "read" || kind === "edit" || kind === "write") return splitPath(summary).base;
  return summary;
}

/**
 * A folded run of tool calls (the condensed feed's receipt) as one Modern row.
 * One call reads as its own row would: the verb, the whole object (a command
 * or a path, `path` says which) and its result at the right. Several read as
 * the counts by kind ("ran 3 commands · read 2 files", from `counted`) with
 * their subjects in mono; the quiet count at the right is how many failed, or
 * how many calls a mixed run holds. `kind` is the shared glyph, "group" when
 * the run mixes kinds.
 */
export function modernGroupHead(
  calls: readonly GroupCall[],
  counted: string,
  resultOf: (call: GroupCall) => GroupResult,
): { kind: RowKind | "group"; verb: string; object: string; path: boolean; meta: string | null; failed: number } {
  if (calls.length === 1) {
    const call = calls[0];
    const result = resultOf(call);
    const head = modernToolHead({ name: call.name, displayName: formatToolName(call.name) || call.name, result, resultSummary: toolResultHint(call, result) });
    const object = toolSummary(call).replace(/\s+/g, " ").trim();
    const path = head.kind === "read" || head.kind === "edit" || head.kind === "write";
    return { kind: head.kind, verb: head.verb, object, path: path && !!object, meta: head.meta, failed: head.failed ? 1 : 0 };
  }
  const kinds = new Set<RowKind>();
  const subjects: string[] = [];
  let failed = 0;
  for (const call of calls) {
    const kind = toolRowKind(call.name);
    kinds.add(kind);
    if (resultOf(call)?.is_error) failed++;
    const subject = groupSubject(call, kind);
    if (subject && !subjects.includes(subject)) subjects.push(subject);
  }
  const kind = kinds.size === 1 ? [...kinds][0] : "group";
  const meta = failed > 0 ? `${failed} failed` : kind === "group" ? `${calls.length} calls` : null;
  return { kind, verb: counted, object: subjects.join(" · "), path: false, meta, failed };
}
