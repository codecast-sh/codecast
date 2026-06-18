// Send-time expansion of `@[Title id]` entity mentions into the rich markdown the
// agent receives (task / plan / session / doc context appended after the mention).
//
// THE CARDINAL RULE: this is PURE ENRICHMENT and must never be able to block the
// durable message send. The whole never-drop / outbox machinery only protects a
// message once `sendMessage()` has actually fired — so anything awaited *before*
// that call is a place where the user's message can be silently lost. A one-shot
// `convex.query()` resolves promptly on a healthy socket but can hang
// indefinitely while the websocket reconnects or auth refreshes (common on the
// desktop client at the exact moment of a send). The original code awaited that
// query with no bound, so a stalled enrichment stranded the whole send: no
// pending row, no outbox entry, a permanently "Message hasn't reached the agent"
// bubble that kill-&-restart can't fix.
//
// So the expansion is bounded by a hard timeout: if it doesn't resolve in time we
// fall back to the raw text and the caller sends immediately. The mention still
// renders as a clickable card from the raw `@[Title id]` markdown; only the extra
// injected context block is skipped. Delivered-with-less-context beats
// never-delivered, every time.

export interface ParsedMention {
  type: string;
  shortId?: string;
  id?: string;
  fullMatch: string;
}

export interface ExpandedMention {
  type: string;
  shortId?: string;
  id?: string;
  markdown?: string;
}

// Returns the expanded markdown per mention. Injected so the send path can pass
// its live `convex.query(api.docs.expandMentions)` while tests drive it directly.
export type RunExpandQuery = (
  mentions: Array<{ type: string; shortId?: string; id?: string }>,
) => Promise<ExpandedMention[]>;

// Generous enough that a healthy enrichment read (a sub-second indexed query)
// always completes, tight enough that a stalled socket can't hold the send
// hostage for more than a beat.
export const MENTION_EXPAND_TIMEOUT_MS = 4000;

export function parseEntityMentions(text: string): ParsedMention[] {
  const mentionRegex = /@\[([^\]]*?)\s+(ct-\w+|pl-\w+|jx\w+|doc:\w+|label:\w+)\](?:\s*\([^)]*\))?/g;
  const docMentionLegacyRegex = /@\[([^\]]*?)\](?:\s*\(cast doc read (\w+)\))/g;
  const mentions: ParsedMention[] = [];
  let match: RegExpExecArray | null;

  mentionRegex.lastIndex = 0;
  while ((match = mentionRegex.exec(text)) !== null) {
    const id = match[2];
    if (id.startsWith("doc:")) {
      mentions.push({ type: "doc", id: id.slice(4), fullMatch: match[0] });
    } else if (id.startsWith("label:")) {
      mentions.push({ type: "label", id: id.slice(6), fullMatch: match[0] });
    } else {
      const type = id.startsWith("ct-") ? "task" : id.startsWith("pl-") ? "plan" : "session";
      mentions.push({ type, shortId: id, fullMatch: match[0] });
    }
  }

  docMentionLegacyRegex.lastIndex = 0;
  while ((match = docMentionLegacyRegex.exec(text)) !== null) {
    if (match[2] && !mentions.some((m) => m.fullMatch === match![0])) {
      mentions.push({ type: "doc", id: match[2], fullMatch: match[0] });
    }
  }

  return mentions;
}

// Bounded, never-throwing, never-hanging. Returns the original text unchanged
// when there are no mentions, when the query rejects, OR when it doesn't resolve
// within `timeoutMs` — so the caller can always proceed straight to the durable
// send. `runQuery` resolves to an array; the timeout branch resolves to `null`,
// which is the unambiguous "give up and send raw" signal.
export async function expandEntityMentions(
  text: string,
  runQuery: RunExpandQuery,
  timeoutMs: number = MENTION_EXPAND_TIMEOUT_MS,
): Promise<string> {
  const mentions = parseEntityMentions(text);
  if (mentions.length === 0) return text;

  let expanded: ExpandedMention[] | null = null;
  try {
    expanded = await Promise.race<ExpandedMention[] | null>([
      runQuery(mentions.map((m) => ({ type: m.type, shortId: m.shortId, id: m.id }))),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return text;
  }
  if (!expanded) return text;

  let result = text;
  for (const m of mentions) {
    const exp = expanded.find(
      (e) => (m.shortId && e.shortId === m.shortId) || (m.id && e.id === m.id),
    );
    if (exp?.markdown) result = result.replace(m.fullMatch, m.fullMatch + exp.markdown);
  }
  return result;
}
