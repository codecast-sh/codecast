import { isShellTool } from "@codecast/shared/render";
import { parseCastCommandString } from "../components/castCommand";
import { backgroundStartedTaskId, type MonitorRow } from "../components/monitorRows";

type WatchMessage = {
  _id: string;
  timestamp: number;
  tool_calls?: readonly { id?: string; name?: string; input?: unknown }[];
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

// A workflow run is stamped (created_at) moments after the call that launched
// it: the Workflow tool, or a shell `cast workflow run`. The launch is the
// newest such call inside this window before the stamp; an older one belongs
// to an earlier run.
const LAUNCH_BEFORE_MS = 10 * 60_000;
const LAUNCH_AFTER_MS = 60_000;

function isWorkflowLaunchCall(tool: { name?: string; input?: unknown }): boolean {
  if (tool.name === "Workflow" || tool.name === "workflow") return true;
  if (!tool.name || !isShellTool(tool.name)) return false;
  try {
    const input = (typeof tool.input === "string" ? JSON.parse(tool.input) : tool.input) as { command?: unknown; cmd?: unknown } | undefined;
    const cmd = parseCastCommandString(String(input?.command || input?.cmd || ""));
    return cmd?.category === "workflow" && cmd.subcommand === "run";
  } catch {
    return false;
  }
}

function findWorkflowLaunch(startedAt: number, messages: readonly WatchMessage[]): WatchMessage | undefined {
  let launch: WatchMessage | undefined;
  for (const message of messages) {
    if (message.timestamp < startedAt - LAUNCH_BEFORE_MS || message.timestamp > startedAt + LAUNCH_AFTER_MS) continue;
    if (!message.tool_calls?.some(isWorkflowLaunchCall)) continue;
    if (!launch || message.timestamp > launch.timestamp) launch = message;
  }
  return launch;
}

// The spot in the conversation a workflow row jumps to: the call that launched
// the run, or, when the run was started from outside the session (no launch
// call in it), the first message at or after the run began.
export async function resolveWorkflowMessage(
  startedAt: number,
  messages: readonly WatchMessage[] | undefined,
  loadAround: (timestamp: number) => Promise<{ messages: WatchMessage[] } | null>,
): Promise<MessageTarget | null> {
  const cached = findWorkflowLaunch(startedAt, messages ?? []);
  if (cached) return { messageId: cached._id, timestamp: cached.timestamp };
  const page = (await loadAround(startedAt))?.messages ?? [];
  const found = findWorkflowLaunch(startedAt, page)
    ?? page.filter((m) => m.timestamp >= startedAt).sort((a, b) => a.timestamp - b.timestamp)[0]
    ?? page.filter((m) => m.timestamp < startedAt).sort((a, b) => b.timestamp - a.timestamp)[0];
  return found ? { messageId: found._id, timestamp: found.timestamp } : null;
}
