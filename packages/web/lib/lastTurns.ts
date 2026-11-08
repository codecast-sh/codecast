import { classifyFeedMessage } from "./conversationProcessor";
import { stripMarkdown } from "./notificationText";
import { parseAgentAuthoredMessage } from "../components/sessionMessage";

/** `from` names another session or agent that wrote a user-role turn. */
export type Turn = { _id: string; role: "user" | "assistant"; text: string; from?: string };
type Row = { _id: string; role: string; content?: string | null; tool_results?: unknown[] | null; subtype?: string | null };

function readable(m: Row): Turn | null {
  if ((m.role !== "user" && m.role !== "assistant") || m.subtype || m.tool_results?.length) return null;
  let text = m.content ?? "";
  let from: string | undefined;
  const envelope = m.role === "user" ? parseAgentAuthoredMessage(text) : null;
  if (envelope) {
    text = envelope.body;
    from = envelope.name || envelope.from;
  } else if (m.role === "user") {
    const shown = classifyFeedMessage(text);
    if (shown.kind === "hidden") return null;
    text = shown.text;
  }
  text = stripMarkdown(text).trim();
  if (!text) return null;
  return from ? { _id: String(m._id), role: m.role, text, from } : { _id: String(m._id), role: m.role, text };
}

/** At most two turns, oldest first: the newest thing a person asked and the
 *  agent's newest words after it. When the person spoke last, the agent's
 *  words before it instead. With no ask in reach, the last two turns. */
export function lastTurns(rows: readonly Row[]): Turn[] {
  const turns = rows.map(readable).filter((t): t is Turn => t !== null);
  let ask = -1;
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === "user") { ask = i; break; }
  if (ask === -1) return turns.slice(-2);
  const newest = turns.length - 1;
  if (ask < newest) return [turns[ask], turns[newest]];
  const before = turns[ask - 1];
  return before ? [before, turns[ask]] : [turns[ask]];
}
