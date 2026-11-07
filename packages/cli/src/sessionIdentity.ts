// The variables that name the agent session a shell belongs to, in the order
// they are trusted: Claude Code, Codex, the `cast claude` wrapper, a managed session.
const SESSION_ID_KEYS = ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODECAST_SESSION_ID", "CODECAST_MANAGED_SESSION"] as const;

export function sessionIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of SESSION_ID_KEYS) if (env[key]) return env[key]!;
  return null;
}

/** `env` as a person's own shell would have it: nothing that ties a cast command to an agent session or its task and plan bindings. What a command a person approved runs with (daemon run_cast). */
export function personEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const drop = new Set<string>([...SESSION_ID_KEYS, "CODECAST_TASK_ID", "CODECAST_PLAN_ID", "CODECAST_CWD"]);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(env)) if (val !== undefined && !drop.has(k)) out[k] = val;
  return out;
}

export function chatSendOrigin(
  env: NodeJS.ProcessEnv = process.env,
): { origin?: "agent"; origin_session_id?: string } {
  const sessionId = sessionIdFromEnv(env);
  return sessionId ? { origin: "agent", origin_session_id: sessionId } : {};
}

/**
 * The origin stamp a `cast doc|plan|task create` sends, and the conversation
 * it binds to. Origin decides whether the row lands on the human shelf or
 * board (@codecast/shared/docs, @codecast/shared/tasks), so it must say
 * "human" only on positive evidence that a person is at the keyboard.
 *
 * A detected session is agent work: the row binds to that conversation. With
 * no session, a person typing at a terminal has stdout on a TTY; an agent's
 * shell tool captures stdout through a pipe. `--human` is the explicit
 * override for a script a person drives. Everything else is a machine that
 * the session detector missed, and it stays quiet rather than leaking onto
 * the shelf: a miss is not evidence of a human.
 */
export function workOriginStamp(opts: {
  sessionId: string | null;
  human?: boolean;
  stdoutIsTTY?: boolean;
}): { source: "human" | "agent"; conversation_id?: string } {
  if (opts.sessionId) return { source: "agent", conversation_id: opts.sessionId };
  return { source: opts.human || opts.stdoutIsTTY ? "human" : "agent" };
}
