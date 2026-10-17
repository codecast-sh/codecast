type TmuxQuery = (args: string[]) => Promise<{ stdout: string }>;

export async function matchesTmuxConversation(target: string, conversationId: string, query: TmuxQuery, kind: "session" | "conversation" = "conversation"): Promise<boolean> {
  const { stdout } = await query(["display-message", "-p", "-t", target, `#{@codecast_${kind}_id}`]);
  return !!conversationId && stdout.trim() === conversationId;
}

export async function findTmuxSessionsById(sessionId: string, query: TmuxQuery, kind: "session" | "conversation" = "session"): Promise<string[]> {
  if (!sessionId) return [];
  const { stdout } = await query(["list-sessions", "-F", `#{session_name}|#{@codecast_${kind}_id}`]);
  return stdout.split("\n").flatMap(line => {
    const separator = line.lastIndexOf("|");
    if (separator <= 0 || line.slice(separator + 1) !== sessionId) return [];
    return [line.slice(0, separator)];
  });
}
