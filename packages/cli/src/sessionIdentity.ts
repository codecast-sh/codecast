export function sessionIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    env.CLAUDE_CODE_SESSION_ID ||
    env.CODEX_THREAD_ID ||
    env.CODEX_SESSION_ID ||
    env.CODECAST_SESSION_ID ||
    env.CODECAST_MANAGED_SESSION ||
    null
  );
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
