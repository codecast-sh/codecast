import { bareEntityIdRegex, entityTypeFromId } from "@codecast/shared/entities";

/** The decisions a message names (`sd-N`, bare or inside an `@[Title sd-N]`
 *  mention), in the order it first names them, each once. */
export function messageDecisionRefs(text: string | undefined): string[] {
  if (!text || !/sd-\d/i.test(text)) return [];
  const seen = new Set<string>();
  for (const m of text.matchAll(bareEntityIdRegex())) {
    const id = m[0].toLowerCase();
    if (entityTypeFromId(id) === "decision") seen.add(id);
  }
  return [...seen];
}

// Agents repeat their "waiting on you" list turn after turn. A decision
// belongs to the review of the latest assistant message that names it, so
// the same asks never draw a bar on every message. One map per messages ref.
const latestByMessages = new WeakMap<object, Map<string, string>>();
export function latestDecisionNamers(messages: ReadonlyArray<{ _id: string; role?: string; content?: string }>): Map<string, string> {
  let map = latestByMessages.get(messages);
  if (!map) {
    map = new Map();
    for (const m of messages) if (m.role === "assistant") for (const id of messageDecisionRefs(m.content)) map.set(id, m._id);
    latestByMessages.set(messages, map);
  }
  return map;
}
