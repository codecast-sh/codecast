export type FilterableSession = {
  title?: string | null;
  message_count?: number;
  first_assistant_message?: string | null;
  message_alternates?: Array<{ role: string; content: string }>;
  ai_message_count?: number;
  agent_type?: string | null;
  subagent_types?: string[];
};

export function isSubagent(c: FilterableSession): boolean {
  return c.agent_type === "subagent";
}

export function isTrivialSubagent(c: FilterableSession): boolean {
  if (!isSubagent(c)) return false;
  const userMsgCount = c.message_alternates?.filter((m) => m.role === "user").length ?? 0;
  const aiMsgCount = c.message_alternates?.filter((m) => m.role === "assistant").length ?? 0;
  if (c.ai_message_count !== undefined) {
    return c.ai_message_count <= 1 && userMsgCount === 0;
  }
  return aiMsgCount <= 1 && userMsgCount === 0;
}

export function isWarmupSession(c: FilterableSession): boolean {
  if (c.title?.toLowerCase() === "warmup") return true;
  if ((c.message_count ?? 0) > 3) return false;
  const firstAssistantMsg =
    c.first_assistant_message?.toLowerCase() ||
    c.message_alternates?.find((m) => m.role === "assistant")?.content?.toLowerCase() ||
    "";
  const warmupPatterns = [
    "i'm ready to help",
    "i'll wait for your task",
    "what would you like me to help",
    "i understand. i'm ready",
    "running in read-only exploration mode",
  ];
  return warmupPatterns.some((p) => firstAssistantMsg.includes(p));
}

export function shouldShowSession(c: FilterableSession): boolean {
  return !isTrivialSubagent(c) && !isWarmupSession(c);
}
