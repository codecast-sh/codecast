import { AGENT_CLIENTS, fromConvexAgentType, toConvexAgentType, parseAgentSwitchNotice } from "@codecast/shared/contracts";

type Message = {
  _id: string;
  role: string;
  content?: string;
  model?: string;
  timestamp: number;
};

function agentFromLabel(label?: string): string | undefined {
  const name = label?.split(" · ", 1)[0].trim().toLowerCase();
  const client = Object.values(AGENT_CLIENTS).find(c => c.displayName.toLowerCase() === name);
  return client ? toConvexAgentType(client.id) : undefined;
}

function agentFromModel(model?: string): string | undefined {
  const name = model?.toLowerCase();
  if (!name) return undefined;
  if (/^(claude-|opus\b|sonnet\b|haiku\b|fable\b)/.test(name)) return "claude_code";
  if (/^(gpt-|o[1-9](?:-|$)|codex(?:-|$))/.test(name)) return "codex";
  if (name.startsWith("gemini-")) return "gemini";
  if (name.startsWith("grok-")) return "grok";
  return undefined;
}

export function messageAgentTypes(messages: readonly Message[], currentAgent?: string): Map<string, string | undefined> {
  const ordered = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const switches = new Map<string, { from?: string; to?: string }>();
  for (const message of ordered) {
    if (message.role !== "user" && message.role !== "system") continue;
    const notice = parseAgentSwitchNotice(message.content);
    if (notice) switches.set(message._id, { from: agentFromLabel(notice.fromLabel), to: agentFromLabel(notice.toLabel) });
  }
  const firstSwitch = switches.values().next().value;
  const fallback = currentAgent ? toConvexAgentType(fromConvexAgentType(currentAgent)) : undefined;
  let agent = firstSwitch ? firstSwitch.from : fallback;
  const authors = new Map<string, string | undefined>();
  for (const message of ordered) {
    const change = switches.get(message._id);
    if (change) agent = change.to;
    const multiProvider = agent === "cursor" || agent === "opencode" || agent === "pi";
    const author = switches.size > 0 || multiProvider
      ? agent ?? agentFromModel(message.model)
      : agentFromModel(message.model) ?? agent;
    authors.set(message._id, author);
  }
  return authors;
}

export function sameMessageAuthor(a: Message, b: Message, authors: ReadonlyMap<string, string | undefined>): boolean {
  return authors.get(a._id) === authors.get(b._id) && a.model === b.model;
}
