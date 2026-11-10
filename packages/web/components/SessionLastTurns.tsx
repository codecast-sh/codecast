// A small window onto a session's transcript for its hover card: the last
// couple of things said, as chat bubbles. Tool calls, tool results and machine
// framing never show. Reads the store when the conversation is already loaded,
// and otherwise asks the server for the newest readable turns.
import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { lastTurns } from "../lib/lastTurns";

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
            {t.from && <div className="text-meta font-medium text-sol-blue mb-0.5 truncate">{t.from}</div>}
            <p className="text-meta leading-snug line-clamp-4 break-words">{t.text}</p>
          </div>
        );
      })}
    </div>
  );
}
