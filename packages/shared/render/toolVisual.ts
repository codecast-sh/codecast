// Tool-kind → { icon, color } classification, expressed as PLAIN DATA so it can
// be shared across renderers that draw with totally different vocabularies:
//   - mobile draws a FontAwesome glyph tinted with a hex `Theme.*` colour,
//   - web draws an SVG/label tinted with a `text-sol-*` Tailwind class.
//
// We therefore return a semantic ICON NAME (FontAwesome-style; mobile's set is
// the richer source of truth) plus a semantic COLOR TOKEN (a stable enum), and
// each client maps the token to its own concrete value. NO JSX, NO icon
// component, NO colour string is baked in here — Hermes/vite safe.

import { ToolCallLike } from "./toolCall";

// The semantic palette slots a tool can be tinted with. Both clients already
// draw from the same Solarized palette, so a token maps 1:1 to a concrete value
// on each side (e.g. "green" → Theme.green / "text-sol-green/80"). The two
// non-Solarized accents — `emerald` (Task* tools) and `amber` (SendMessage) —
// are called out explicitly so callers map them to their own bright greens/ambers.
export type ToolColorToken =
  | "green"
  | "blue"
  | "violet"
  | "orange"
  | "cyan"
  | "magenta"
  | "red"
  | "textDim"
  | "emerald"
  | "amber";

// FontAwesome (v4 / @expo/vector-icons "FontAwesome") glyph names. Kept as a
// plain string union for documentation; mobile passes it straight to the icon
// component, web maps the handful it renders to its own SVGs.
export type ToolIconName =
  | "terminal"
  | "file-code-o"
  | "search"
  | "pencil"
  | "globe"
  | "code-fork"
  | "tasks"
  | "comment"
  | "check-square-o"
  | "bolt"
  | "map-o"
  | "question-circle-o"
  | "users"
  | "book"
  | "chrome"
  | "desktop"
  | "upload"
  | "arrows-alt"
  | "plug"
  | "cog";

export interface ToolVisual {
  icon: ToolIconName;
  color: ToolColorToken;
}

// Exact-id → visual for the curated tools. The `mcp__*` browser tools and the
// final fallback are handled by `toolVisual()` below (they need prefix/substring
// matching, not an exact key).
// opencode + pi (and gemini's `glob`) name their built-in tools in lowercase —
// the same canonical set, just lower-cased — so each lowercase id maps to the same
// visual as its capitalized twin. Kept here (not a normalizer) so the exact-id
// lookup stays a single flat table across every client.
export const TOOL_VISUALS: Record<string, ToolVisual> = {
  Bash: { icon: "terminal", color: "green" },
  bash: { icon: "terminal", color: "green" },
  shell_command: { icon: "terminal", color: "green" },
  shell: { icon: "terminal", color: "green" },
  exec_command: { icon: "terminal", color: "green" },
  "container.exec": { icon: "terminal", color: "green" },

  Read: { icon: "file-code-o", color: "blue" },
  file_read: { icon: "file-code-o", color: "blue" },
  read: { icon: "file-code-o", color: "blue" },
  list: { icon: "file-code-o", color: "blue" },

  Glob: { icon: "search", color: "violet" },
  Grep: { icon: "search", color: "violet" },
  glob: { icon: "search", color: "violet" },
  grep: { icon: "search", color: "violet" },

  Edit: { icon: "pencil", color: "orange" },
  Write: { icon: "pencil", color: "orange" },
  file_write: { icon: "pencil", color: "orange" },
  file_edit: { icon: "pencil", color: "orange" },
  edit: { icon: "pencil", color: "orange" },
  write: { icon: "pencil", color: "orange" },
  patch: { icon: "pencil", color: "orange" },
  apply_patch: { icon: "pencil", color: "orange" },

  WebSearch: { icon: "globe", color: "violet" },
  web_search: { icon: "globe", color: "violet" },
  code_search: { icon: "globe", color: "violet" },
  code_analysis: { icon: "globe", color: "violet" },

  WebFetch: { icon: "globe", color: "cyan" },
  web_fetch: { icon: "globe", color: "cyan" },
  webfetch: { icon: "globe", color: "cyan" },

  Task: { icon: "code-fork", color: "cyan" },
  task: { icon: "code-fork", color: "cyan" },
  todowrite: { icon: "check-square-o", color: "magenta" },

  TaskCreate: { icon: "tasks", color: "emerald" },
  TaskUpdate: { icon: "tasks", color: "emerald" },
  TaskList: { icon: "tasks", color: "emerald" },
  TaskGet: { icon: "tasks", color: "emerald" },
  TaskOutput: { icon: "tasks", color: "emerald" },
  TaskStop: { icon: "tasks", color: "emerald" },

  SendMessage: { icon: "comment", color: "amber" },
  StructuredOutput: { icon: "check-square-o", color: "cyan" },
  TodoWrite: { icon: "check-square-o", color: "magenta" },
  Skill: { icon: "bolt", color: "cyan" },
  EnterPlanMode: { icon: "map-o", color: "violet" },
  ExitPlanMode: { icon: "map-o", color: "violet" },
  AskUserQuestion: { icon: "question-circle-o", color: "blue" },
  TeamCreate: { icon: "users", color: "cyan" },
  TeamDelete: { icon: "users", color: "cyan" },
  NotebookEdit: { icon: "book", color: "orange" },
};

// Resolve the visual for an `mcp__claude-in-chrome__*` browser tool by the
// substring of its id (the same dispatch the mobile fork used).
function mcpBrowserVisual(name: string): ToolVisual {
  if (name.includes("tabs_context") || name.includes("tabs_create")) return { icon: "chrome", color: "textDim" };
  if (name.includes("computer") || name.includes("screenshot")) return { icon: "desktop", color: "orange" };
  if (name.includes("navigate")) return { icon: "chrome", color: "blue" };
  if (name.includes("read_page") || name.includes("get_page_text")) return { icon: "chrome", color: "blue" };
  if (name.includes("find")) return { icon: "search", color: "violet" };
  if (name.includes("form_input") || name.includes("javascript_tool")) return { icon: "chrome", color: "orange" };
  if (name.includes("gif_creator")) return { icon: "chrome", color: "magenta" };
  if (name.includes("console") || name.includes("network")) return { icon: "chrome", color: "green" };
  if (name.includes("update_plan")) return { icon: "chrome", color: "cyan" };
  if (name.includes("upload_image")) return { icon: "upload", color: "blue" };
  if (name.includes("resize_window")) return { icon: "arrows-alt", color: "textDim" };
  if (name.includes("shortcuts")) return { icon: "bolt", color: "violet" };
  return { icon: "plug", color: "cyan" };
}

// Semantic { icon, color } for any tool id. Curated table first, then the
// browser-MCP substring dispatch, then a neutral cog fallback.
export function toolVisual(name: string): ToolVisual {
  const exact = TOOL_VISUALS[name];
  if (exact) return exact;
  if (name.startsWith("mcp__")) return mcpBrowserVisual(name);
  return { icon: "cog", color: "textDim" };
}

// Convenience alias matching the mobile fork's `toolIcon(name)` call shape so the
// Wave-2 mobile rewire is a one-line repoint.
export function toolIcon(tc: ToolCallLike | string): ToolVisual {
  return toolVisual(typeof tc === "string" ? tc : tc.name);
}
