const conversationId = /^jx[a-z0-9]{30}$/;

export function formatAgentPrompt(from: string, body: string, subagent = false): string {
  if (!conversationId.test(from)) throw new Error("Agent prompt requires a resolved parent conversation ID");
  if (!body.trim()) throw new Error("Agent prompt is empty");
  return `<session-message from="${from}"${subagent ? ' subagent="true"' : ''}>\n${body}\n</session-message>`;
}

export function subagentPromptParent(content: string, knownParents: ReadonlySet<string>, self?: string): string | undefined {
  const prefix = '<session-message from="';
  const from = content.slice(prefix.length, prefix.length + 32);
  if (!content.startsWith(`${prefix}${from}" subagent="true">\n`) || !content.endsWith("\n</session-message>")) return undefined;
  return conversationId.test(from) && from !== self && knownParents.has(from) ? from : undefined;
}

export function mergeAgentPromptSources(own: Record<string, string>, managed: Record<string, { threadId?: string }>): Record<string, string> {
  const cache: Record<string, string> = {};
  const conflicts = new Set<string>();
  for (const [ref, id] of [...Object.entries(own), ...Object.entries(managed).map(([id, row]) => [row?.threadId, id] as const)]) {
    if (!ref || !conversationId.test(id)) continue;
    cache[id] = id;
    if (conflicts.has(ref)) continue;
    if (cache[ref] && cache[ref] !== id) {
      delete cache[ref];
      conflicts.add(ref);
    } else cache[ref] = id;
  }
  return cache;
}

export function resolveAgentPromptSource(ref: string | undefined, cache: Record<string, string>): string | undefined {
  if (!ref) return undefined;
  if (conversationId.test(ref)) return Object.values(cache).includes(ref) ? ref : undefined;
  if (cache[ref] && conversationId.test(cache[ref])) return cache[ref];
  if (!/^jx[a-z0-9]{5,29}$/.test(ref)) return undefined;
  const matches = [...new Set(Object.values(cache).filter(id => id.startsWith(ref) && conversationId.test(id)))];
  return matches.length === 1 ? matches[0] : undefined;
}
