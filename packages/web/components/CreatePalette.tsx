import { useState, useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { nanoid } from "nanoid";
import { soundNewSession } from "../lib/sounds";
import { useInboxStore } from "../store/inboxStore";
import { useConversationMessages } from "../hooks/useConversationMessages";
import { ConversationView, ConversationData } from "./ConversationView";

function ComposeSession({ sessionId }: { sessionId: string }) {
  const { conversation, hasMoreAbove, hasMoreBelow, isLoadingOlder, isLoadingNewer, loadOlder, loadNewer, jumpToStart, jumpToEnd } = useConversationMessages(sessionId);

  return (
    <ConversationView
      conversation={conversation as ConversationData}
      embedded
      hideHeader
      isOwner={true}
      autoFocusInput
      backHref=""
      hasMoreAbove={hasMoreAbove}
      hasMoreBelow={hasMoreBelow}
      isLoadingOlder={isLoadingOlder}
      isLoadingNewer={isLoadingNewer}
      onLoadOlder={loadOlder}
      onLoadNewer={loadNewer}
      onJumpToStart={jumpToStart}
      onJumpToEnd={jumpToEnd}
    />
  );
}

export function CreatePalette() {
  const isOpen = useInboxStore((s) => s.composePalette.isOpen);
  const initialMessage = useInboxStore((s) => s.composePalette.initialMessage);
  const closePalette = useInboxStore((s) => s.closeComposePalette);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const paletteRef = useRef<HTMLDivElement>(null);

  useWatchEffect(() => {
    (window as any).__CODECAST_COMPOSE_SHOW = (msg?: string) => {
      useInboxStore.getState().openComposePalette(msg || "");
    };
    (window as any).__CODECAST_START_SESSION = async (data: { message: string; agentType: string; projectPath?: string }) => {
      const store = useInboxStore.getState();
      const sid = nanoid(10);
      const now = Date.now();
      const agentType = data.agentType || "claude_code";
      const path = data.projectPath || store.currentConversation.projectPath || store.currentConversation.gitRoot || store.recentProjects?.[0]?.path;

      soundNewSession();
      store.setConversationMeta(sid, {
        _id: sid, _creationTime: now, user_id: "", agent_type: agentType,
        session_id: sid, project_path: path, git_root: path,
        started_at: now, updated_at: now, message_count: 0, status: "active",
        title: "New session", messages: [], user: null,
        child_conversations: [], child_conversation_map: {},
        has_more_above: false, oldest_timestamp: null, last_timestamp: null,
        fork_count: 0, forked_from_details: null, compaction_count: 0,
        fork_children: [], parent_conversation_id: null,
      });
      store.createSession({
        agent_type: agentType,
        project_path: path,
        git_root: path,
        session_id: sid,
      }).then((convexId: string) => {
        if (convexId) {
          store.resolveSessionId(sid, convexId);
          store.sendMessage(convexId, data.message);
          window.history.pushState({ inboxId: convexId }, "", `/conversation/${convexId}`);
        }
      });
      store.setCurrentSession(sid);
    };
    return () => {
      delete (window as any).__CODECAST_COMPOSE_SHOW;
      delete (window as any).__CODECAST_START_SESSION;
    };
  }, []);

  useWatchEffect(() => {
    if (!isOpen) {
      setSessionId(null);
      return;
    }

    soundNewSession();
    const store = useInboxStore.getState();
    const ctx = store.currentConversation;
    const path = ctx.projectPath || ctx.gitRoot || store.recentProjects?.[0]?.path;
    const agentType = (ctx.agentType || "claude_code") as "claude_code" | "codex" | "cursor" | "gemini";
    const sid = nanoid(10);
    const now = Date.now();

    store.setConversationMeta(sid, {
      _id: sid, _creationTime: now, user_id: "", agent_type: agentType,
      session_id: sid, project_path: path, git_root: path,
      started_at: now, updated_at: now, message_count: 0, status: "active",
      title: "New session", messages: [], user: null,
      child_conversations: [], child_conversation_map: {},
      has_more_above: false, oldest_timestamp: null, last_timestamp: null,
      fork_count: 0, forked_from_details: null, compaction_count: 0,
      fork_children: [], parent_conversation_id: null,
    });
    store.createSession({
      agent_type: agentType,
      project_path: path,
      git_root: path,
      session_id: sid,
    });

    if (initialMessage) {
      store.setDraft(sid, { draft_message: initialMessage });
    }

    setSessionId(sid);
  }, [isOpen, initialMessage]);

  useWatchEffect(() => {
    if (!isOpen) return;
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); closePalette(); }
    }
    function handleClickOutside(e: MouseEvent) {
      if (paletteRef.current && !paletteRef.current.contains(e.target as Node)) closePalette();
    }
    document.addEventListener("keydown", handleEsc, true);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleEsc, true);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, closePalette]);

  const messageCount = useInboxStore((s) => sessionId ? (s.messages[sessionId]?.length ?? 0) : 0);
  const closingRef = useRef(false);

  useWatchEffect(() => {
    if (!sessionId || messageCount === 0 || closingRef.current) return;
    closingRef.current = true;
    closePalette();
  }, [messageCount, sessionId, closePalette]);

  useWatchEffect(() => {
    if (!isOpen) closingRef.current = false;
  }, [isOpen]);

  if (!isOpen || !sessionId) return null;

  return (
    <div className="fixed inset-0 z-[9999]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          ref={paletteRef}
          className="w-[640px] h-[360px] max-h-[75vh] rounded-xl border border-sol-border/80 bg-sol-bg shadow-2xl shadow-black/40 overflow-hidden flex flex-col animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150"
        >
          <ComposeSession sessionId={sessionId} />
        </div>
      </div>
    </div>
  );
}
