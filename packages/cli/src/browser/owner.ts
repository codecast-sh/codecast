/**
 * Who is calling `cast browser`.
 *
 * One Chrome serves every agent on the machine, so each command has to say
 * which agent it belongs to or they drive each other's tabs. The key does not
 * need to be the codecast session id — it only needs to be STABLE across the
 * many short-lived CLI processes one agent runs, and DISTINCT between agents.
 *
 * That distinction matters because the obvious answer is not good enough:
 * `detectCurrentSessionId()` gives up and returns null whenever several
 * sessions are active at once ("ambiguous, don't guess"), which is precisely
 * the situation tab ownership exists to handle. Relying on it alone would make
 * the feature go quiet exactly when it is needed.
 *
 * Harness env vars come first for that reason: they are set for the life of
 * the agent's process tree and do not go null when the machine is busy.
 * Grok exports GROK_SESSION_ID and CODECAST_CONVERSATION_ID, not the Claude
 * or Codex names; missing those keyed Grok by its tmux pane, so a resume in
 * a new pane minted a second Cast tab and left the old one in the group.
 */

/** Env vars that identify an agent process. Order is the fallback order. */
export const OWNER_HARNESS_ENV = [
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_SESSION_ID",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CAST_SESSION_ID",
  "CODECAST_SESSION_ID",
  "GROK_SESSION_ID",
  "CODECAST_CONVERSATION_ID",
  "CODECAST_MANAGED_SESSION",
  "CODEX_THREAD_ID",
] as const;

export function harnessOwnerId(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of OWNER_HARNESS_ENV) {
    const v = env[name];
    if (v) return v;
  }
  return null;
}

/** Identify the calling agent. Null only when nothing distinguishing exists. */
export function ownerKey(detectSessionId?: () => string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  // 1. Harness ids. Always present for an agent, never go quiet when other
  //    sessions are live (detectCurrentSessionId does).
  const harness = harnessOwnerId(env);
  if (harness) return `env:${harness}`;

  // 2. The resolved session id, when the CLI can name one unambiguously and
  //    no harness exported an id of its own.
  try {
    const sid = detectSessionId?.();
    if (sid) return `session:${sid}`;
  } catch {
    /* fall through */
  }

  // 3. The tmux pane the agent runs in. Last because a resume in a new pane
  //    would otherwise look like a new browser session and open a new tab.
  const pane = env.TMUX_PANE;
  if (pane) return `pane:${pane}`;

  // Nothing to go on — a human in a bare shell. Falls back to the shared
  // "last tab touched" behaviour, which is right for a single interactive user.
  return null;
}
