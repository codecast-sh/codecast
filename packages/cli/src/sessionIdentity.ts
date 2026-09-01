export function sessionIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    env.CLAUDE_CODE_SESSION_ID ||
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
