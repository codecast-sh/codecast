export type FilterableSession = {
  title?: string | null;
  message_count?: number;
  first_assistant_message?: string | null;
  message_alternates?: Array<{ role: string; content: string }>;
  ai_message_count?: number;
  agent_type?: string | null;
  subagent_types?: string[];
  parent_conversation_id?: string | null;
};

export function isSubagent(c: FilterableSession): boolean {
  return !!c.parent_conversation_id;
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

export function isDefaultTitleSession(c: FilterableSession): boolean {
  const title = c.title?.trim() || "";
  if (!title || title === "Untitled") return true;
  if (/^Session\s+[a-f0-9-]{8,}/i.test(title)) return true;
  if (/^Session\s+agent-/i.test(title)) return true;
  return false;
}

export const SYSTEM_MESSAGE_PREFIXES = [
  "[Using:",
  "[Request",
  "[SUGGESTION MODE:",
];

export function isSystemMessageSession(c: FilterableSession): boolean {
  const title = c.title?.trim() || "";
  return SYSTEM_MESSAGE_PREFIXES.some(prefix => title.startsWith(prefix));
}

export function isWarmupSession(c: FilterableSession): boolean {
  if (c.title?.toLowerCase() === "warmup") return true;
  if ((c.message_count ?? 0) > 3) return false;

  const firstUserMsg = c.message_alternates?.find((m) => m.role === "user")?.content?.toLowerCase().trim() || "";
  const firstAssistantMsg =
    c.first_assistant_message?.toLowerCase() ||
    c.message_alternates?.find((m) => m.role === "assistant")?.content?.toLowerCase() ||
    "";

  // Filter out conversations with only warmup user message and one AI response
  if ((c.message_count ?? 0) <= 2 && firstUserMsg === "warmup") {
    return true;
  }

  const warmupPatterns = [
    "i'm ready to help",
    "i'll wait for your task",
    "what would you like me to help",
    "i understand. i'm ready",
    "running in read-only exploration mode",
  ];
  return warmupPatterns.some((p) => firstAssistantMsg.includes(p));
}

export function shouldShowSession(c: FilterableSession, options?: { excludeDefaultTitles?: boolean }): boolean {
  if (isTrivialSubagent(c) || isWarmupSession(c) || isSystemMessageSession(c)) return false;
  if (options?.excludeDefaultTitles && isDefaultTitleSession(c)) return false;
  return true;
}
