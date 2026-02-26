export type SessionAgentType = "claude" | "codex" | "gemini";
export interface CodexProcessCandidate {
  pid: number;
  tty: string;
  tmuxTarget: string | null;
}

export interface StartedSessionEntry {
  tmuxSession: string;
  projectPath: string;
  startedAt: number;
}

export function isResumeInvocation(agentType: SessionAgentType, commandLine: string): boolean {
  if (agentType === "codex" || agentType === "gemini") {
    return /\s--resume(\s|$)/.test(commandLine) || /\sresume(\s|$)/.test(commandLine);
  }
  return /\s--resume(\s|$)/.test(commandLine);
}

export function hasCodexSessionFileOpen(lsofOutput: string, sessionId: string): boolean {
  if (!lsofOutput || !sessionId) return false;
  return lsofOutput
    .split("\n")
    .some((line) =>
      line.includes(".codex/sessions/") &&
      line.includes(sessionId) &&
      line.includes(".jsonl")
    );
}

export function choosePreferredCodexCandidate(
  candidates: CodexProcessCandidate[]
): CodexProcessCandidate | null {
  if (candidates.length === 0) return null;
  return candidates.find((c) => !c.tmuxTarget) || candidates[0];
}

export function matchStartedConversation(
  entries: Iterable<[string, StartedSessionEntry]>,
  {
    tmuxSessionName,
    projectPath,
    now = Date.now(),
    ttlMs = 300_000,
  }: {
    tmuxSessionName?: string | null;
    projectPath?: string | null;
    now?: number;
    ttlMs?: number;
  }
): string | null {
  const startedEntries = Array.isArray(entries) ? entries : [...entries];

  if (tmuxSessionName) {
    for (const [conversationId, entry] of startedEntries) {
      if (entry.tmuxSession === tmuxSessionName) {
        return conversationId;
      }
    }
  }

  if (!projectPath) return null;
  for (const [conversationId, entry] of startedEntries) {
    if (entry.projectPath === projectPath && now - entry.startedAt < ttlMs) {
      return conversationId;
    }
  }
  return null;
}

export function matchSingleFreshStartedConversation<T extends { startedAt: number }>(
  entries: Iterable<[string, T]>,
  {
    now = Date.now(),
    freshnessMs = 120_000,
  }: {
    now?: number;
    freshnessMs?: number;
  } = {}
): string | null {
  const startedEntries = Array.isArray(entries) ? entries : [...entries];
  const fresh = startedEntries.filter(([, entry]) => now - entry.startedAt < freshnessMs);
  if (fresh.length !== 1) return null;
  return fresh[0][0];
}
