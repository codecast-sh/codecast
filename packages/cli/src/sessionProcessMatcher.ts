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

// Legacy alias: installs whose ps comm still reports gemini's old binary name.
const AGENT_BINARY_ALIASES = new Set(["gemini-cli"]);

/**
 * The agent client an ancestor process IS, from one `ps -o ppid=,comm=,args=`
 * row — or null for any other process (a shell, tmux, the daemon, a bare node).
 *
 * `args` is the primary witness, `comm` only the fallback. When comm shares the
 * row with other columns, macOS ps clips it to 16 characters, so a long install
 * path ("/Users/x/.codecast/bin/claude") arrives as "/Users/x/.co" and its
 * basename ".co" matches nothing. That silently unlinked every trigger created
 * from the fixed-path claude copy (304 of 796 rows had no parent on 2026-08-27).
 * argv[0] is never clipped. Script clients run under an interpreter
 * (args "node /x/bin/codex"), so argv[1] is checked when argv[0] is one.
 * Exact basename matches only: this names the process, it must not treat a
 * plain interpreter as an agent the way isRecognizedAgentComm does.
 */
export function agentBinaryFromPsRow(comm: string, args: string): string | null {
  const argv = args.trim().split(/\s+/);
  const candidates = [argv[0] ?? ""];
  if (AGENT_INTERPRETERS.includes(basename(argv[0] ?? "").toLowerCase()) && argv[1]) {
    candidates.push(argv[1]);
  }
  candidates.push(comm);
  for (const c of candidates) {
    const bin = basename(c.trim()).toLowerCase();
    if (!bin) continue;
    if (AGENT_BINARY_BASENAMES.has(bin) || AGENT_BINARY_ALIASES.has(bin)) return bin;
  }
  return null;
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

// ── Borrowed pids: a session that does not own the process we resolve for it ──
// hasCodexSessionFileOpen above asks only "does this process hold session X's
// rollout open?" — never "does it hold ONLY X?". For a Codex subagent THREAD the
// honest answer is that no process is exclusively its own: it runs INSIDE its
// parent TUI's process, and the parent is what holds its rollout open. So the
// lookup returns the PARENT's pid.
//
// That pid is the right answer for REACHING the agent — parent and subagent share
// a terminal, and the subagent's permission prompt renders in the parent's pane —
// and the wrong answer for OWNING it. Callers that attribute resources or destroy
// processes must ask this first; callers that only inject keystrokes must not.
//
// CRITICAL: `parent_thread_id` alone is the WRONG discriminator. A census of 214
// local rollouts found two different parent-carrying shapes, and they have
// opposite process semantics:
//
//   28  originator=codex_exec  source={"subagent":"review"}          ← own process
//   31  originator=codex-tui   source={"subagent":{"thread_spawn"…}} ← shared
//
// `codex exec` review children are spawned by another session's Bash tool as a
// separate OS process (see the daemon's own note where it nests them under their
// spawner). They own their pid, so treating them as borrowers would silently
// leave a review running after the user killed its card — an over-fire on nearly
// half of all parent-carrying sessions. Key POSITIVELY on the in-process shape:
// a nested `thread_spawn` object, never the mere presence of a parent.
// `originator` is deliberately NOT the discriminator even though it correlates:
// the census found thread_spawn under BOTH "codex-tui" (27) and "codecast" (4),
// so a new front-end shipping a third originator would silently be misclassified.
// The structural shape is the invariant; the originator is branding.
//
// Returns "unknown", not "owned", for a session that clearly has a parent but
// whose shape we do not recognize. That direction matters: every unrecognized
// shape that resolves to "owned" re-opens the SIGKILL hole, while "unknown" costs
// only a card that retires without reaping (planSessionTeardown treats the two
// identically). A renamed `thread_spawn` key, or a future nesting we've never
// seen, must not be read as permission to destroy a process.
export function classifyProcessOwnership(
  meta: { parentThreadId?: string; originator?: string; source?: unknown } | undefined,
): ProcessOwnership {
  const source = meta?.source;
  const subagent =
    source && typeof source === "object" ? (source as { subagent?: unknown }).subagent : undefined;

  if (subagent !== undefined && subagent !== null) {
    // An OBJECT carrying thread_spawn is the in-process thread — the borrower.
    // Checked without requiring the top-level parent_thread_id, which is
    // redundant (thread_spawn.parent_thread_id carries the same value in all 31
    // real rollouts) and whose absence must not downgrade this to "owned".
    if (typeof subagent === "object") {
      return (subagent as { thread_spawn?: unknown }).thread_spawn !== undefined
        ? "borrowed"
        : "unknown"; // an object shape we don't recognize — fail closed
    }
    // A bare string ("review") is the `codex exec` child: a separate OS process
    // spawned via another session's Bash tool, so it owns its pid.
    if (typeof subagent === "string") return "owned";
    return "unknown";
  }

  // No subagent marker at all. A parent id with nothing to explain it is a shape
  // we can't classify; anything else is a plain root session.
  return meta?.parentThreadId ? "unknown" : "owned";
}

// ── What a teardown may touch for a given session ───────────────────────────
// Both destructive call sites (killConversationBackends, stopLocalSessionBackends)
// do TWO process-destroying things: reap the resolved pid tree, and kill the tmux
// cached in resumeSessionCache. Both are unsafe for a borrower, and for the same
// reason — resumeSessionCache is keyed by session id but its VALUE can be the
// PARENT's tmux name, because resolveLiveTmuxTarget resolves a subagent through
// the borrowed pid to the parent's pane and caches that. Guarding only the reap
// leaves the tmux kill as a live bypass that SIGKILLs the parent anyway.
//
// Expressed as one pure decision so both sites branch identically and a test can
// assert the policy without dependency-injecting a kill path.
export type ProcessOwnership = "owned" | "borrowed" | "unknown";

export interface SessionTeardownPlan {
  /** May we SIGKILL the resolved pid and its descendants? */
  reapPidTree: boolean;
  /** May we kill the tmux recorded in resumeSessionCache for this session? */
  killCachedResumeTmux: boolean;
}

/** Destructive teardown fails CLOSED: only a session we positively know owns its
 *  process may have it destroyed. "unknown" (an unreadable or half-written
 *  rollout) must not authorize a SIGKILL — the cost of skipping is a card that
 *  retires without reaping, the cost of guessing wrong is a dead parent TUI. */
export function planSessionTeardown(ownership: ProcessOwnership): SessionTeardownPlan {
  const owned = ownership === "owned";
  return { reapPidTree: owned, killCachedResumeTmux: owned };
}

// ── Session ids in logs ──────────────────────────────────────────────────────
// Codex mints session ids as UUIDv7, whose leading 48 bits are a millisecond
// timestamp. A parent TUI and the subagents it spawns are minted inside the same
// timestamp window BY CONSTRUCTION, so they collide on an 8-char prefix
// systematically — observed live: 019fb73a-a740-… and 019fb73a-a85c-…, 150ms
// apart, are both "019fb73a". Truncating logs there collapsed a parent and its
// subagents into one indistinguishable id in exactly the lines you need to
// untangle a misattribution. Print through the second group so the
// sub-millisecond bits survive.
const LOG_SESSION_ID_LEN = 13;

/** A session id truncated for log lines, short enough to skim and long enough
 *  to tell a Codex parent apart from its subagents. */
export function shortId(sessionId: string): string {
  return sessionId.slice(0, LOG_SESSION_ID_LEN);
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
//
// Only Claude Code writes that pid registry, so a codex/gemini/pi/opencode
// spawner leaves every ancestor unregistered — the child used to stay a loose
// first-class card no matter how deep the chain. The second identification
// route covers those: an ancestor is named by the TRANSCRIPT IT HOLDS OPEN,
// read from one `lsof -F pn` over the whole chain
// (see agentSessionFromTranscriptPath).

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

/** Parse `lsof -F pn` into pid → the paths that process has open. The -F stream
 *  is flat: a `p<pid>` line opens a process block and every `n<path>` line after
 *  it belongs to that process until the next `p` line. */
export function parseLsofPidPaths(output: string): Map<number, string[]> {
  const byPid = new Map<number, string[]>();
  let current: string[] | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        current = null;
        continue;
      }
      current = byPid.get(pid) || [];
      byPid.set(pid, current);
    } else if (line.startsWith("n") && current) {
      current.push(line.slice(1));
    }
  }
  return byPid;
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

// ── Which session does a process actually run? ──────────────────────────────
// Every lookup that maps a session id to a pid (a registry file, a tmux session
// named after the session, a cached pid) answers "where did this session run"
// at some point in the past. None of them answers "what does that pid run NOW".
// Observed live (2026-08-15): the tmux session cc-resume-c291b8e9 hosted a
// `claude --resume 3d2a9117…` process, so the Screenplay conversation injected
// its messages into the cold-pitch agent and its terminal showed the wrong
// session. Two facts about a process settle its identity:
//
//   1. Its hook claims. The SessionStart hook writes session-registry/<id>.json
//      {pid, tty, ts, term} for the session the process runs, on startup, resume,
//      /clear and compact — so an in-process session switch produces a NEWER
//      claim for the same pid. Only claims written after the process started
//      count (a pid is reused; a claim older than the process is about a dead
//      one). The newest live claim is the process's own word.
//   2. Its argv. `claude --resume <id>` / `--session-id <id>` (codex `resume <id>`)
//      states the session it was LAUNCHED for. Truthful at launch, stale after an
//      in-process switch — which is why hook claims win when present.
//
// No signal at all (a bare `claude` with no hook claim) is "unknown": we cannot
// refute the lookup, so callers keep today's behavior.
export type ProcessIdentityVerdict = "owned" | "foreign" | "unknown";

export interface ProcessSessionClaim {
  sessionId: string;
  /** Epoch seconds the claim was written (registry `ts`). */
  ts: number;
}

const ARGV_ID = "([A-Za-z0-9][A-Za-z0-9._-]{7,})(?=\\s|$)";
// claude: `--resume <id>` / `-r <id>` / `--session-id <id>`; codex: `codex resume <id>`
// (bare `resume` is only trusted right after the codex binary — it is an ordinary
// word inside a prompt argument otherwise).
const ARGV_SESSION_FLAG_RES = [
  new RegExp(`(?:^|\\s)(?:--resume|--session-id|-r)[\\s=]+${ARGV_ID}`),
  new RegExp(`(?:^|\\s|/)codex\\s+resume\\s+${ARGV_ID}`),
];

/** The session id an agent process names on its own command line, or null. */
export function argvSessionId(commandLine: string): string | null {
  for (const re of ARGV_SESSION_FLAG_RES) {
    const m = re.exec(commandLine);
    if (m) return m[1];
  }
  return null;
}

/** Parse `ps -o etime=` ("[[dd-]hh:]mm:ss") into seconds, or null. */
export function parsePsEtimeSeconds(etime: string): number | null {
  const s = etime.trim();
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s);
  if (!m) return null;
  const days = m[1] ? parseInt(m[1], 10) : 0;
  const hours = m[2] ? parseInt(m[2], 10) : 0;
  return ((days * 24 + hours) * 60 + parseInt(m[3], 10)) * 60 + parseInt(m[4], 10);
}

/** Slack for the hook writing its claim a moment before `ps` measures the
 *  process start (both read the same wall clock, so this only absorbs rounding). */
const CLAIM_START_SLACK_SEC = 5;

/**
 * The session a process runs, from its hook claims (newest one written after the
 * process started) or, absent any, its argv. Null when neither says anything.
 */
export function processDeclaredSessionId(args: {
  argvId: string | null;
  claims: readonly ProcessSessionClaim[];
  /** Epoch seconds the process started; null when unknown (claims are then ignored —
   *  without a start time a claim cannot be told apart from a reused pid's). */
  processStartSec: number | null;
}): string | null {
  if (args.processStartSec !== null) {
    let newest: ProcessSessionClaim | null = null;
    for (const c of args.claims) {
      if (c.ts < args.processStartSec - CLAIM_START_SLACK_SEC) continue;
      if (!newest || c.ts > newest.ts) newest = c;
    }
    if (newest) return newest.sessionId;
  }
  return args.argvId;
}

export function judgeProcessIdentity(args: {
  sessionId: string;
  argvId: string | null;
  claims: readonly ProcessSessionClaim[];
  processStartSec: number | null;
}): { verdict: ProcessIdentityVerdict; declared: string | null } {
  const declared = processDeclaredSessionId(args);
  if (!declared) return { verdict: "unknown", declared };
  return { verdict: declared === args.sessionId ? "owned" : "foreign", declared };
}
