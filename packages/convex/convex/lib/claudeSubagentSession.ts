// Claude Code names every subagent transcript `agent-<hex>` (Task tool,
// workflow agents, warmups); a top-level session is always a UUID. A row
// created under such an id is a subagent whatever the client sent, so an
// older or path-blind uploader can never put one in the inbox.
export function isClaudeSubagentSessionId(sessionId: string): boolean {
  return /^agent-[0-9a-f]{7,}$/.test(sessionId);
}
