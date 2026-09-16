import { useCallback, useMemo, useRef, useState } from "react";
import { ExternalLink, ImagePlus, Sparkles } from "lucide-react";
import { useMutation } from "convex/react";
import ReactMarkdown from "react-markdown";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ACTIVE_AGENT_STATUSES } from "@codecast/shared/contracts";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { AvatarImg } from "../../lib/avatarCache";
import { navigateMainWindow } from "../../lib/desktop";
import { settleComposerAttachments } from "../../lib/draftImages";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { MessageInput } from "../ConversationView";
import { ChatAttachments } from "../chat/ChatMessage";
import { MESSAGE_MD_COMPONENTS, MESSAGE_MD_REHYPE, USER_MD_REMARK } from "../messageMarkdown";
import type { ChatAttachment } from "../../store/chatSlice";
import { FeedChip } from "./FeedChip";
import { findSessionRow } from "../../lib/calls/findSessionRow";
import { useRemoveLiveFeed } from "./useCallFeed";
import "../chat/chat.css";
import "./callSurface.css";

import { useWatchEffect } from "../../hooks/useWatchEffect";

function echoKey(text: string, attachments?: { storage_id: string }[] | null): string {
  return `${text}\0${(attachments ?? []).map((a) => a.storage_id).join(",")}`;
}

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
//
// Images and @mentions piggyback on team chat: MessageInput in bareComposer
// mode (paste, drop, pick, thumbnail strip, upload, chat-handle mentions),
// chat attachment tiles to render them, and pending_messages.image_storage_ids
// so a fed agent sees the picture.
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
  const [pending, setPending] = useState<Array<{ key: string; text: string; attachments: ChatAttachment[]; at: number }>>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dropFilesRef = useRef<((files: File[]) => void) | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const draftKey = `huddle:${roomKey}`;
  const mentionTeamId = useInboxStore((s: any) => s.clientState?.ui?.active_team_id as string | undefined);

  const messages = useMemo(() => {
    const server = rows ?? [];
    // A pending row retires once the server echoes a row of mine with the
    // same text and the same attached storage ids (image-only lines have
    // empty text, so text alone would retire the wrong row).
    const echoed = new Set(server.filter((r: any) => r.mine).map((r: any) => echoKey(r.text, r.attachments)));
    const stillPending = pending.filter((p) => !echoed.has(echoKey(p.text, p.attachments)));
    return [
      ...server,
      ...stillPending.map((p) => ({
        _id: p.key,
        user_name: "you",
        user_image: undefined,
        text: p.text,
        attachments: p.attachments,
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

  const send = (body: string, attachments: ChatAttachment[]) => {
    if (!body && attachments.length === 0) return;
    const key = `p:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    setPending((p) => [...p, { key, text: body, attachments, at: Date.now() }]);
    void post({
      room_key: roomKey,
      text: body,
      attachments: attachments.length
        ? attachments.map((a) => ({
            storage_id: a.storage_id as Id<"_storage">,
            mime: a.mime,
            name: a.name,
            width: a.width,
            height: a.height,
          }))
        : undefined,
    }).catch(() => {
      setPending((p) => p.filter((x) => x.key !== key));
    });
  };

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepthRef.current++;
    setDragging(true);
  }, []);
  const onDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragging(false);
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
  }, []);
  const onDrop = useCallback((e: React.DragEvent) => {
    dragDepthRef.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    dropFilesRef.current?.(files);
  }, []);

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
    <div
      className={`call-chat-panel flex min-h-0 flex-col ${className ?? ""}`}
      onDragEnter={readOnly ? undefined : onDragEnter}
      onDragLeave={readOnly ? undefined : onDragLeave}
      onDragOver={readOnly ? undefined : onDragOver}
      onDrop={readOnly ? undefined : onDrop}
    >
      {dragging && (
        <div className="ch-drop-overlay" aria-hidden="true">
          <div className="ch-drop-card">Drop images to attach</div>
        </div>
      )}
      {agents.length > 0 && live && (
        <AgentsStrip agents={agents} transcriptId={live.transcript_id} onOpen={openSession} />
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 select-text space-y-2.5 overflow-y-auto px-3 py-3">
        {messages.length === 0 && working.length === 0 ? (
          <div className="px-1 py-6 text-center text-[12px] text-sol-text-muted">
            {readOnly
              ? "Nothing was said in chat."
              : agents.length > 0
                ? "Drop links, images and asides here — the agent reads them, and answers here."
                : "Drop links, images and asides here — they stay with the call."}
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
                  ) : m.text ? (
                    <div
                      className={`whitespace-pre-wrap break-words text-[12.5px] leading-relaxed ${
                        m.pending ? "text-sol-text-muted" : "text-sol-text"
                      }`}
                    >
                      {m.text}
                    </div>
                  ) : null}
                  {m.attachments?.length > 0 && (
                    <ChatAttachments messageId={m._id} attachments={m.attachments} />
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
          <div className="ch-composer ch-composer-flush">
            <MessageInput
              key={draftKey}
              conversationId={draftKey}
              bareComposer
              chatMentionMode
              mentionTeamId={mentionTeamId}
              composerPlaceholder={placeholder}
              onDropFiles={dropFilesRef}
              onGateSend={async (text, images) => {
                const attachments = await settleComposerAttachments(images);
                const content = text.trim();
                if (!content && attachments.length === 0) return;
                send(content, attachments);
              }}
            />
            <div className="ch-composer-foot">
              <button
                type="button"
                className="ch-composer-attach"
                title="Attach an image"
                onClick={() => pickerRef.current?.click()}
              >
                <ImagePlus className="h-3.5 w-3.5" />
              </button>
              <input
                ref={pickerRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length) dropFilesRef.current?.(files);
                  e.target.value = "";
                }}
              />
            </div>
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
