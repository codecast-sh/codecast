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
 * So we try progressively weaker but more available signals, and only give up
 * when none of them is present.
 */

/** Identify the calling agent. Null only when nothing distinguishing exists. */
export function ownerKey(detectSessionId?: () => string | null): string | null {
  // 1. The real session id, when the CLI can resolve one unambiguously. Best
  //    because it survives the agent being resumed in a different pane.
  try {
    const sid = detectSessionId?.();
    if (sid) return `session:${sid}`;
  } catch {
    /* fall through */
  }

  // 2. Harness-provided ids. Set for the life of one agent's process tree.
  for (const name of [
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CAST_SESSION_ID",
  ]) {
    const v = process.env[name];
    if (v) return `env:${v}`;
  }

  // 3. The tmux pane the agent runs in. Stable for the pane's lifetime, and
  //    codecast puts each agent in its own pane, so in practice this separates
  //    agents even when no id is exported.
  const pane = process.env.TMUX_PANE;
  if (pane) return `pane:${pane}`;

  // Nothing to go on — a human in a bare shell. Falls back to the shared
  // "last tab touched" behaviour, which is right for a single interactive user.
  return null;
}
