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
