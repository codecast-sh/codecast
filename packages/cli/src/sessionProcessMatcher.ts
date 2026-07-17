import type { AgentClientId } from "@codecast/shared/contracts";
import { AGENT_CLIENTS } from "@codecast/shared/contracts";

// ── Recognizing a live agent process by its `ps` comm ───────────────────────
// The daemon's "is this pane's process still an agent" check (isAgentProcess,
// backing resolveLiveTmuxTarget) reads `ps -o comm=` for a pid and asks whether
// it looks like one of our clients. Two shapes appear in the wild, both observed
// live:
//   • the client's own binary name — compiled clients (opencode -> "opencode",
//     claude -> "claude") and script clients that rename their process via
//     process.title (pi's cli.js sets `process.title = "pi"`, so comm is "pi",
//     NOT "node").
//   • a generic script interpreter — script clients that DON'T rename run under
//     it (codex -> comm "node", args "node .../codex"); gemini likewise.
// The recognized binary names come straight from the registry, so adding client
// #7's descriptor teaches this check for free. Binary names match by basename
// (exact) so a short id like "pi" can't substring-hit "pip"/"pipenv"; the
// interpreters keep the historic path-tolerant substring match (comm is often a
// full path like "/opt/homebrew/bin/node").
const AGENT_BINARY_BASENAMES = new Set(
  Object.values(AGENT_CLIENTS).map((d) => basename(d.binary).toLowerCase())
);
const AGENT_INTERPRETERS = ["node", "bun", "deno"];

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/** Does a process's `ps -o comm=` value belong to one of our agent clients?
 *  Pure and testable — the daemon's isAgentProcess is just this plus the `ps`
 *  read. */
export function isRecognizedAgentComm(comm: string): boolean {
  const lower = comm.trim().toLowerCase();
  if (!lower) return false;
  if (AGENT_BINARY_BASENAMES.has(basename(lower))) return true;
  return AGENT_INTERPRETERS.some((i) => lower.includes(i));
}

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

export function isResumeInvocation(agentType: AgentClientId, commandLine: string): boolean {
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
    // The candidate's process lives in a tmux we did NOT start, so it belongs
    // to another conversation/owner. A shared cwd must never override that —
    // otherwise concurrent sessions in the same repo hijack each other.
    return null;
  }

  if (!projectPath) return null;
  const pathMatches = startedEntries.filter(
    ([, entry]) => entry.projectPath === projectPath && now - entry.startedAt < ttlMs
  );
  if (pathMatches.length === 1) return pathMatches[0][0];
  return null;
}

// ── Spawn-parent resolution (process ancestry) ──────────────────────────────
// A headless agent (`codex exec`, `claude -p`) launched from another session's
// Bash tool is a plain child process of that session's agent — its transcript
// is a brand-new top-level file with no path or tmux marker of who spawned it.
// But while the child runs, its ppid chain leads to the spawning agent's pid,
// and Claude Code registers every live process in ~/.claude/sessions/<pid>.json
// with its CURRENT session id. These are the pure pieces: parse one
// `ps -axo pid=,ppid=` snapshot, enumerate ancestors nearest-first, and map
// the first registered ancestor to a session id (skipping the child itself).

export function parsePidPpidMap(psOutput: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of psOutput.trim().split("\n")) {
    const [pidStr, ppidStr] = line.trim().split(/\s+/);
    const pid = parseInt(pidStr, 10);
    const ppid = parseInt(ppidStr, 10);
    if (!isNaN(pid) && !isNaN(ppid)) map.set(pid, ppid);
  }
  return map;
}

export function collectAncestorPids(
  pidToPpid: Map<number, number>,
  startPid: number,
  maxDepth = 15,
): number[] {
  const ancestors: number[] = [];
  const seen = new Set<number>([startPid]);
  let pid = pidToPpid.get(startPid);
  while (pid !== undefined && pid > 1 && !seen.has(pid) && ancestors.length < maxDepth) {
    ancestors.push(pid);
    seen.add(pid);
    pid = pidToPpid.get(pid);
  }
  return ancestors;
}

export function resolveSpawnerSessionId(
  ancestorPids: number[],
  readRegistrySessionId: (pid: number) => string | null,
  selfSessionId: string,
): string | null {
  for (const pid of ancestorPids) {
    const sid = readRegistrySessionId(pid);
    if (sid && sid !== selfSessionId) return sid;
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
