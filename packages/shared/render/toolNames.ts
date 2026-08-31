// Single source of truth for the human-readable display name of a tool call.
// Defined ONCE here and consumed by every client renderer:
//   - the web ConversationView (packages/web/components/ConversationView.tsx),
//   - the public share view (packages/web/app/share/message/[token]),
//   - the mobile session screen (Wave 2 — packages/mobile/app/session/[id].tsx).
//
// These three previously hand-forked their own copies and drifted: the share
// view dropped the MCP/codex name tables entirely, so a `Bash` call showed
// "Bash" in the conversation but the raw tool id in a shared link. Centralising
// the tables + the formatter here ends that drift.
//
// PURE isomorphic string logic — NO React/JSX, NO document/window, NO Node/DOM
// APIs — so it imports cleanly into both a vite browser bundle and the
// Expo/Hermes (React Native) bundle. It must NEVER be imported by the Convex
// runtime (this is render logic, not contract data) — it lives outside
// @codecast/shared/contracts deliberately.

// Friendly labels for the in-app browser (claude-in-chrome) MCP tools.
export const mcpToolNames: Record<string, string> = {
  "mcp__node_repl__js": "Browser",
  "mcp__claude-in-chrome__computer": "Browser",
  // A batch renders as its steps; the wrapper's own name is just "Browser".
  "mcp__claude-in-chrome__browser_batch": "Browser",
  "mcp__claude-in-chrome__navigate": "Navigate",
  "mcp__claude-in-chrome__read_page": "Read Page",
  "mcp__claude-in-chrome__find": "Find",
  "mcp__claude-in-chrome__form_input": "Form",
  "mcp__claude-in-chrome__javascript_tool": "JS",
  "mcp__claude-in-chrome__tabs_context_mcp": "Tabs",
  "mcp__claude-in-chrome__tabs_create_mcp": "New Tab",
  "mcp__claude-in-chrome__update_plan": "Plan",
  "mcp__claude-in-chrome__gif_creator": "GIF",
  "mcp__claude-in-chrome__read_console_messages": "Console",
  "mcp__claude-in-chrome__read_network_requests": "Network",
  "mcp__claude-in-chrome__get_page_text": "Page Text",
  "mcp__claude-in-chrome__upload_image": "Upload",
  "mcp__claude-in-chrome__resize_window": "Resize",
  "mcp__claude-in-chrome__shortcuts_list": "Shortcuts",
  "mcp__claude-in-chrome__shortcuts_execute": "Shortcut",
};

// Friendly labels for Codex-runtime tool ids (the web table carries a few extra
// aliases — `commandExecution`, `fileChange` — which the mobile fork lacked; the
// superset is harmless to mobile since those ids simply never appear there).
export const codexToolNames: Record<string, string> = {
  // Newer Codex runtimes wrap one or more real tool invocations in a custom
  // `exec` program. Renderers inspect its input to recover the inner actions;
  // this is the honest fallback when that source cannot be decoded.
  exec: "Actions",
  shell_command: "Terminal",
  shell: "Terminal",
  exec_command: "Terminal",
  "container.exec": "Terminal",
  commandExecution: "Terminal",
  apply_patch: "Patch",
  file_read: "Read",
  file_write: "Write",
  file_edit: "Edit",
  fileChange: "Patch",
  web_search: "Search",
  web_fetch: "Fetch",
  code_search: "Search",
  code_analysis: "Analyze",
  view_image: "Image",
  write_stdin: "Terminal",
  wait: "Wait",
  update_plan: "Plan",
  request_user_input: "Question",
  tool_search: "Find Tool",
  web__run: "Web",
  image_gen__imagegen: "Generate Image",
};

// Grok Build (xAI grok-shell) tool ids. The transcript stores the snake_case
// function name as `title`, so the title-case fallback would otherwise paint
// `run_terminal_command` as "Run Terminal Command" and hide it from the
// Terminal/Read/Edit cards that key off the canonical family names.
export const grokToolNames: Record<string, string> = {
  run_terminal_command: "Terminal",
  read_file: "Read",
  search_replace: "Edit",
  list_dir: "List",
  todo_write: "Todos",
  ask_user_question: "Question",
  get_command_or_subagent_output: "Wait",
  kill_command_or_subagent: "Kill",
  spawn_subagent: "Agent",
  open_page: "Open",
  open_page_with_find: "Find",
  enter_plan_mode: "Plan",
  exit_plan_mode: "Plan",
  image_gen: "Image",
  image_edit: "Image",
  image_to_video: "Video",
  reference_to_video: "Video",
  scheduler_create: "Schedule",
  scheduler_delete: "Schedule",
  scheduler_list: "Schedule",
  search_tool: "Find Tool",
  use_tool: "Tool",
  x_user_search: "Search",
  x_semantic_search: "Search",
  x_keyword_search: "Search",
  x_thread_fetch: "Fetch",
  // Live grok sometimes titles the search tool this way instead of web_search.
  "Web search:": "Search",
};

// Turn a raw tool id into a short human-readable label. Looks up the curated
// MCP/Codex/Grok tables first, then falls back to title-casing an `mcp__server__method`
// id (or any snake_case id) into words.
export function formatToolName(name: string): string {
  if (mcpToolNames[name]) return mcpToolNames[name];
  if (codexToolNames[name]) return codexToolNames[name];
  if (grokToolNames[name]) return grokToolNames[name];
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const method = parts[2] || parts[1] || "MCP";
    return method.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }
  return name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
