import { useMemo, useRef, useState } from "react";
import { ExternalLink, SendHorizontal, Sparkles } from "lucide-react";
import { useMutation } from "convex/react";
import ReactMarkdown from "react-markdown";
import { api } from "@codecast/convex/convex/_generated/api";
import { ACTIVE_AGENT_STATUSES } from "@codecast/shared/contracts";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { AvatarImg } from "../../lib/avatarCache";
import { navigateMainWindow } from "../../lib/desktop";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { MESSAGE_MD_COMPONENTS, MESSAGE_MD_REHYPE, USER_MD_REMARK } from "../messageMarkdown";
import { FeedChip, findSessionRow } from "./FeedChip";
import { useRemoveLiveFeed } from "./useCallFeed";
import "./callSurface.css";

import { useWatchEffect } from "../../hooks/useWatchEffect";
// The huddle's text lane: one thread per room, live on the call stage and
// preserved on the call page — links and asides dropped mid-call stay next to
// the words that prompted them. Optimistic rows keep sending instant; the
// server echo replaces them.
//
// AGENTS SIT IN THIS LANE. A session fed the live transcript is a participant:
// the strip at the top names it, its replies arrive as its own rows (the
// server mirrors what it answers at the end of each turn — callChat.ts), a
// line typed here reaches it, and while it works the foot of the list says
// so. The stage passes `live` (the transcript and its routes); the call page
// reads the same thread after the fact and passes nothing.
export function CallChatPanel({
  roomKey,
  className,
  readOnly,
  live,
  panel,
}: {
  roomKey: string;
  className?: string;
  readOnly?: boolean;
  live?: {
    transcript_id: string;
    routes: Array<{ kind: string; target: string; mode: string; added_by: string }>;
  } | null;
  /** The desktop call window: links to a session open in the main window. */
  panel?: boolean;
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
        agent: null,
      })),
    ];
  }, [rows, pending]);

  const agents = useAgentsInRoom(live?.routes ?? null);
  const working = agents.filter((a) => a.working);

  useWatchEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, working.length]);

  const send = () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    setPending((p) => [...p, { key: `p:${Date.now()}:${p.length}`, text: body, at: Date.now() }]);
    void post({ room_key: roomKey, text: body }).catch(() => {
      setPending((p) => p.filter((x) => x.text !== body));
    });
  };

  const openSession = (id: string) => {
    if (panel) return void navigateMainWindow(`/conversation/${id}`);
    useInboxStore.getState().openSidePanel(id);
  };

  const placeholder =
    agents.length > 0
      ? `Message the room — ${agents.length === 1 ? agents[0].name : "the agents"} read${agents.length === 1 ? "s" : ""} along`
      : "Message the room…";

  // What people said is content — the stage around this panel is chrome and
  // turns selection off, so the messages and the box turn it back on.
  return (
    <div className={`flex min-h-0 flex-col ${className ?? ""}`}>
      {agents.length > 0 && live && (
        <AgentsStrip agents={agents} transcriptId={live.transcript_id} onOpen={openSession} />
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 select-text space-y-2.5 overflow-y-auto px-3 py-3">
        {messages.length === 0 && working.length === 0 ? (
          <div className="px-1 py-6 text-center text-[12px] text-sol-text-muted">
            {readOnly
              ? "Nothing was said in chat."
              : agents.length > 0
                ? "Drop links and asides here — the agent reads them, and answers here."
                : "Drop links and asides here — they stay with the call."}
          </div>
        ) : (
          messages.map((m: any, i: number) => {
            const prev: any = messages[i - 1];
            const sameAuthor = prev && prev.user_name === m.user_name && !!prev.agent === !!m.agent && m.at - prev.at < 180_000;
            return (
              <div key={m._id} className={`flex gap-2 ${sameAuthor ? "mt-0.5" : "mt-2"}`}>
                <span className="w-5 shrink-0 pt-0.5">
                  {!sameAuthor &&
                    (m.agent ? (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sol-violet/15">
                        <AgentTypeIcon agentType={m.agent.agent_type} className="h-3 w-3" />
                      </span>
                    ) : (
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
                    ))}
                </span>
                <div className="min-w-0 flex-1">
                  {!sameAuthor && (
                    <div className="mb-0.5 flex items-baseline gap-1.5">
                      {m.agent ? (
                        <button
                          onClick={() => openSession(m.agent.conversation_id)}
                          className="max-w-[200px] truncate text-[11px] font-medium text-sol-violet hover:underline"
                          title="Open the agent's session"
                        >
                          {m.agent.title}
                        </button>
                      ) : (
                        <span className="text-[11px] font-medium text-sol-text">
                          {m.mine ? "you" : (m.user_name || "").split("@")[0].split(" ")[0]}
                        </span>
                      )}
                      <span className="text-[9.5px] text-sol-text-dim">
                        {new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  )}
                  {m.agent ? (
                    <div className="call-chat-agent-body text-[12.5px] leading-relaxed text-sol-text">
                      <ReactMarkdown
                        remarkPlugins={USER_MD_REMARK}
                        rehypePlugins={MESSAGE_MD_REHYPE}
                        components={MESSAGE_MD_COMPONENTS}
                      >
                        {m.text}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div
                      className={`whitespace-pre-wrap break-words text-[12.5px] leading-relaxed ${
                        m.pending ? "text-sol-text-muted" : "text-sol-text"
                      }`}
                    >
                      {m.text}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        {working.map((a) => (
          <div key={`working-${a.id}`} className="mt-2 flex items-center gap-2 text-[11.5px] text-sol-text-muted">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-sol-violet/15">
              <AgentTypeIcon agentType={a.agentType} className="h-3 w-3" />
            </span>
            <span className="truncate">{a.name} is working</span>
            <span className="call-chat-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        ))}
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
              placeholder={placeholder}
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

type AgentInRoom = {
  id: string;
  target: string;
  addedBy: string;
  name: string;
  agentType: string;
  working: boolean;
};

// The sessions the live transcript feeds, as participants: name, kind, and
// whether one is mid-turn. Read from the store's session rows, subscribed
// through a signature of the fields shown so the strip does not re-render
// on every heartbeat of every session.
function useAgentsInRoom(routes: Array<{ kind: string; target: string; added_by: string }> | null): AgentInRoom[] {
  const targets = (routes ?? []).filter((r) => r.kind === "session");
  const sig = targets.map((r) => r.target).join("|");
  const s = useTrackedStore([
    (st: any) =>
      targets
        .map((r) => {
          const row = findSessionRow(st, r.target);
          return row ? `${row._id}:${row.title ?? ""}:${row.agent_type ?? ""}:${row.agent_status ?? ""}` : r.target;
        })
        .join("|"),
  ]);
  return useMemo(
    () =>
      targets.map((r) => {
        const row = findSessionRow(s, r.target);
        return {
          id: String(row?._id ?? r.target),
          target: r.target,
          addedBy: r.added_by,
          name: (row?.title || "agent session").slice(0, 40),
          agentType: row?.agent_type ?? "claude_code",
          working: ACTIVE_AGENT_STATUSES.has(row?.agent_status ?? ""),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig stands in for the routes list
    [sig, s],
  );
}

// Who is listening: one chip per fed session, its feed removable by whoever
// added it, and a link into the session. This is the room's roster of agents,
// beside the people the stage already shows.
function AgentsStrip({
  agents,
  transcriptId,
  onOpen,
}: {
  agents: AgentInRoom[];
  transcriptId: string;
  onOpen: (id: string) => void;
}) {
  const removeFeed = useRemoveLiveFeed(transcriptId);
  const myUserId = useInboxStore((s: any) => s.currentUser?._id?.toString?.() ?? null);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-white/[0.06] py-2 pl-3 pr-9">
      <span className="flex items-center gap-1 font-mono text-[10.5px] text-sol-text-dim">
        <Sparkles className="h-3 w-3 text-sol-violet" />
        in the room
      </span>
      {agents.map((a) => (
        <span key={a.id} className="flex items-center gap-0.5">
          <FeedChip
            route={{ kind: "session", target: a.target, mode: "live" }}
            removable={!!myUserId && a.addedBy === myUserId}
            onRemove={() => void removeFeed("session", a.target)}
          />
          <button
            onClick={() => onOpen(a.id)}
            className="rounded p-0.5 text-sol-text-dim hover:text-sol-text"
            title="Open the agent's session"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
