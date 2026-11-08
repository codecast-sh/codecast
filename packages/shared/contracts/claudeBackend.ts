// Which backend a Claude session runs in: a tmux pane the daemon types into,
// or an Agent SDK host process (docs/architecture/claude-sdk-backend.md).
// Pure data, shared by the daemon, Convex and the apps.

export type ClaudeBackend = "tmux" | "sdk";

/** What a new Claude session runs in when neither the person nor the start chose. */
export const DEFAULT_CLAUDE_BACKEND: ClaudeBackend = "tmux";

export const CLAUDE_BACKEND_LABELS: Record<ClaudeBackend, string> = {
  sdk: "Agent SDK",
  tmux: "Terminal (tmux)",
};

export function asClaudeBackend(v: unknown): ClaudeBackend | undefined {
  return v === "sdk" || v === "tmux" ? v : undefined;
}
