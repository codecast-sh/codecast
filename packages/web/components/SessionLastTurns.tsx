// A small window onto a session's transcript for its hover card: the last
// couple of things said, as chat bubbles. Tool calls, tool results and machine
// framing never show. Reads the store when the conversation is already loaded,
// and otherwise asks the server for the newest readable turns.
import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { classifyFeedMessage } from "../lib/conversationProcessor";
import { stripMarkdown } from "../lib/notificationText";
import { parseAgentAuthoredMessage } from "./sessionMessage";

/** `from` names another session or agent that wrote a user-role turn. */
type Turn = { _id: string; role: "user" | "assistant"; text: string; from?: string };
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

export function SessionLastTurns({ conversationId, className = "" }: { conversationId: string; className?: string }) {
  const local = useInboxStore((s) => s.messages[conversationId]);
  const hasLocal = !!local?.length;
  const { data: remote } = useQueryNoThrow(
    api.sessionPeek.recentTurns,
    hasLocal ? "skip" : { conversation_id: conversationId, limit: 6 },
    { remember: true },
  );
  const turns = useMemo(() => lastTurns((hasLocal ? local : remote) ?? []), [hasLocal, local, remote]);
  if (turns.length === 0) return null;
  return (
    <div className={`flex flex-col ${className}`}>
      {turns.map((t, i) => {
        const user = t.role === "user";
        const grouped = i > 0 && turns[i - 1].role === t.role;
        const lastOfRun = turns[i + 1]?.role !== t.role;
        const tail = lastOfRun ? (user ? "rounded-br-sm" : "rounded-bl-sm") : "";
        return (
          <div
            key={t._id}
            className={`max-w-[88%] rounded-xl px-2.5 py-1.5 ${grouped ? "mt-0.5" : i > 0 ? "mt-1.5" : ""} ${tail} ${
              user ? "self-end bg-sol-blue/15 text-sol-text" : "self-start bg-sol-bg-alt text-sol-text-muted"
            }`}
          >
            {t.from && <div className="text-[10px] font-medium text-sol-blue mb-0.5 truncate">{t.from}</div>}
            <p className="text-[11px] leading-snug line-clamp-4 break-words">{t.text}</p>
          </div>
        );
      })}
    </div>
  );
}
