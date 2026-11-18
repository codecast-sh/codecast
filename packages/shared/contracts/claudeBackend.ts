// Which backend a session runs in: a tmux pane the daemon types into, or a
// direct host process (docs/architecture/claude-sdk-backend.md): Claude through
// the Agent SDK, Grok over ACP. Pure data, shared by the daemon, Convex and the apps.

export type ClaudeBackend = "tmux" | "sdk";

/** What a new Claude session runs in when neither the person nor the start chose. */
export const DEFAULT_CLAUDE_BACKEND: ClaudeBackend = "tmux";

export const CLAUDE_BACKEND_LABELS: Record<ClaudeBackend, string> = {
  sdk: "No terminal",
  tmux: "Terminal",
};

/** Grok's direct host (grok agent stdio) is offered once its live end-to-end run passes (scripts/grok-direct-e2e.ts). */
export const GROK_DIRECT_BACKEND = true;

/** The conversation agent types (Convex spelling) that can run in a direct host as well as a pane. */
export function hasDirectBackend(agentType: string | null | undefined): boolean {
  return (agentType || "claude_code") === "claude_code" || (GROK_DIRECT_BACKEND && agentType === "grok");
}

export function asClaudeBackend(v: unknown): ClaudeBackend | undefined {
  return v === "sdk" || v === "tmux" ? v : undefined;
}
