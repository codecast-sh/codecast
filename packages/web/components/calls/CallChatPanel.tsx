import { useMemo, useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { AvatarImg } from "../../lib/avatarCache";

import { useWatchEffect } from "../../hooks/useWatchEffect";
// The huddle's text lane: one thread per room, live on the call stage and
// preserved on the call page — links and asides dropped mid-call stay next to
// the words that prompted them. Optimistic rows keep sending instant; the
// server echo replaces them.
export function CallChatPanel({
  roomKey,
  className,
  readOnly,
}: {
  roomKey: string;
  className?: string;
  readOnly?: boolean;
}) {
  const { data: rows } = useQueryNoThrow(api.callChat.list, { room_key: roomKey });
  const post = useMutation(api.callChat.post);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Array<{ key: string; text: string; at: number }>>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = useMemo(() => {
    const server = rows ?? [];
    // A pending row retires once the server echoes a row of mine with its text.
    const echoed = new Set(server.filter((r: any) => r.mine).map((r: any) => r.text));
    const stillPending = pending.filter((p) => !echoed.has(p.text));
    return [
      ...server,
      ...stillPending.map((p) => ({
        _id: p.key,
        user_name: "you",
        user_image: undefined,
        text: p.text,
        at: p.at,
        mine: true,
        pending: true,
      })),
    ];
  }, [rows, pending]);

  useWatchEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    setPending((p) => [...p, { key: `p:${Date.now()}:${p.length}`, text: body, at: Date.now() }]);
    void post({ room_key: roomKey, text: body }).catch(() => {
      setPending((p) => p.filter((x) => x.text !== body));
    });
  };

  // What people said is content — the stage around this panel is chrome and
  // turns selection off, so the messages and the box turn it back on.
  return (
    <div className={`flex min-h-0 flex-col ${className ?? ""}`}>
      <div ref={scrollRef} className="min-h-0 flex-1 select-text space-y-2.5 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="px-1 py-6 text-center text-[12px] text-sol-text-muted">
            {readOnly ? "Nothing was said in chat." : "Drop links and asides here — they stay with the call."}
          </div>
        ) : (
          messages.map((m: any, i: number) => {
            const prev: any = messages[i - 1];
            const sameAuthor = prev && prev.user_name === m.user_name && m.at - prev.at < 180_000;
            return (
              <div key={m._id} className={`flex gap-2 ${sameAuthor ? "mt-0.5" : "mt-2"}`}>
                <span className="w-5 shrink-0 pt-0.5">
                  {!sameAuthor && (
                    <AvatarImg
                      src={m.user_image}
                      alt=""
                      className="h-5 w-5 rounded-full object-cover"
                      fallback={
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sol-bg-highlight text-[9px] font-medium text-sol-text-muted">
                          {(m.user_name || "?").charAt(0).toUpperCase()}
                        </span>
                      }
                    />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  {!sameAuthor && (
                    <div className="mb-0.5 flex items-baseline gap-1.5">
                      <span className="text-[11px] font-medium text-sol-text">
                        {m.mine ? "you" : (m.user_name || "").split("@")[0].split(" ")[0]}
                      </span>
                      <span className="text-[9.5px] text-sol-text-dim">
                        {new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  )}
                  <div
                    className={`whitespace-pre-wrap break-words text-[12.5px] leading-relaxed ${
                      m.pending ? "text-sol-text-muted" : "text-sol-text"
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
      {!readOnly && (
        <div className="shrink-0 p-2">
          <div className="flex items-end gap-1.5">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="Message the room…"
              className="max-h-24 min-w-0 flex-1 select-text resize-none rounded-xl bg-sol-bg-highlight px-3 py-1.5 text-[12.5px] text-sol-text placeholder:text-sol-text-muted focus:outline-none focus:ring-1 focus:ring-sol-cyan/50"
            />
            <button
              onClick={send}
              disabled={!text.trim()}
              className="rounded-full p-2 text-sol-cyan transition-colors hover:bg-sol-cyan/10 disabled:opacity-30"
              title="Send"
            >
              <SendHorizontal className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
