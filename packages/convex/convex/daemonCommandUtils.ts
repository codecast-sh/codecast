export type PendingDaemonCommand = {
  command: string;
  args?: string | null;
  _creationTime?: number;
};

function extractConversationId(args: string | null | undefined): string | null {
  if (!args) return null;
  try {
    const parsed = JSON.parse(args);
    return typeof parsed?.conversation_id === "string" ? parsed.conversation_id : null;
  } catch {
    return null;
  }
}

export function hasRecentPendingDaemonCommand(
  commands: PendingDaemonCommand[],
  {
    conversationId,
    command,
    now = Date.now(),
    dedupeWindowMs = 30_000,
  }: {
    conversationId: string;
    command: string;
    now?: number;
    dedupeWindowMs?: number;
  }
): boolean {
  return commands.some((entry) => {
    if (entry.command !== command) return false;
    if (extractConversationId(entry.args) !== conversationId) return false;
    if (!entry._creationTime) return true;
    return now - entry._creationTime < dedupeWindowMs;
  });
}
