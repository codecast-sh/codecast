import { backgroundStartedTaskId, type MonitorRow } from "../components/monitorRows";

type WatchMessage = {
  _id: string;
  timestamp: number;
  tool_calls?: readonly { id?: string }[];
  tool_results?: readonly { tool_use_id?: string; content?: unknown }[];
};

type MessageTarget = { messageId: string; timestamp: number };

function findWatchMessage(row: MonitorRow, messages: readonly WatchMessage[]): MessageTarget | null {
  const resultMessage = messages.find((message) => message.tool_results?.some((result) =>
    result.tool_use_id === row.toolUseId
      || (!!row.taskId && typeof result.content === "string" && backgroundStartedTaskId(result.content) === row.taskId),
  ));
  const toolUseId = resultMessage?.tool_results?.find((result) =>
    result.tool_use_id === row.toolUseId
      || (!!row.taskId && typeof result.content === "string" && backgroundStartedTaskId(result.content) === row.taskId),
  )?.tool_use_id ?? row.toolUseId;
  const message = messages.find((message) => message.tool_calls?.some((tool) => tool.id === toolUseId)) ?? resultMessage;
  return message ? { messageId: message._id, timestamp: message.timestamp } : null;
}

export async function resolveWatchMessage(
  row: MonitorRow,
  messages: readonly WatchMessage[] | undefined,
  loadAround: (timestamp: number) => Promise<{ messages: WatchMessage[] } | null>,
): Promise<MessageTarget | null> {
  if (row.startMessageId) return { messageId: row.startMessageId, timestamp: row.startedAt };
  const cached = findWatchMessage(row, messages ?? []);
  if (cached) return cached;
  const page = await loadAround(row.startedAt);
  return findWatchMessage(row, page?.messages ?? []);
}
