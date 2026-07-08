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
  "mcp__claude-in-chrome__computer": "Browser",
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
};

// Turn a raw tool id into a short human-readable label. Looks up the curated
// MCP/Codex tables first, then falls back to title-casing an `mcp__server__method`
// id (or any snake_case id) into words.
export function formatToolName(name: string): string {
  if (mcpToolNames[name]) return mcpToolNames[name];
  if (codexToolNames[name]) return codexToolNames[name];
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const method = parts[2] || parts[1] || "MCP";
    return method.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  }
  return name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
