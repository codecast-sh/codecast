"use client";
import { useState, useRef, useCallback } from "react";
import { ArrowUp } from "lucide-react";
import { nanoid } from "nanoid";
import { useInboxStore } from "../store/inboxStore";
import { soundNewSession } from "../lib/sounds";
import { AgentTypeIcon } from "./AgentTypeIcon";

type AgentKey = "claude" | "codex" | "cursor" | "gemini";
const AGENT_TYPES: { key: AgentKey; convex: string; label: string; active: string }[] = [
  { key: "claude", convex: "claude_code", label: "Claude", active: "bg-sol-yellow/20 text-sol-yellow border-sol-yellow/50" },
  { key: "codex", convex: "codex", label: "Codex", active: "bg-emerald-500/20 text-emerald-400 border-emerald-500/50" },
  { key: "cursor", convex: "cursor", label: "Cursor", active: "bg-purple-500/20 text-purple-400 border-purple-500/50" },
  { key: "gemini", convex: "gemini", label: "Gemini", active: "bg-blue-500/20 text-blue-400 border-blue-500/50" },
];

interface ContextChatInputProps {
  contextType: string;
  contextTitle: string;
  getContextBody: () => string;
  placeholder?: string;
  linkedObjectId?: string;
}

export function ContextChatInput({
  contextType,
  contextTitle,
  getContextBody,
  placeholder,
  linkedObjectId,
}: ContextChatInputProps) {
  const [message, setMessage] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const currentAgent = useInboxStore((s) => s.currentConversation.agentType || "claude_code");
  const [selectedAgent, setSelectedAgent] = useState<AgentKey | null>(null);

  const agentKey = selectedAgent || (currentAgent === "claude_code" ? "claude" : currentAgent === "codex" ? "codex" : currentAgent === "cursor" ? "cursor" : "gemini") as AgentKey;
  const isExpanded = isFocused || message.length > 0;

  const resetHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);

  const handleSubmit = useCallback(async () => {
    const text = message.trim();
    if (!text) return;

    const body = getContextBody();
    const contextBlock = body
      ? `<context type="${contextType}" title="${contextTitle}">\n${body}\n</context>\n\n`
      : `[Viewing ${contextType}: ${contextTitle}]\n\n`;
    const fullMessage = contextBlock + text;

    const store = useInboxStore.getState();
    const { projectPath, gitRoot } = store.currentConversation;
    const path = projectPath || gitRoot;
    const convexAgentType = AGENT_TYPES.find(a => a.key === agentKey)?.convex || "claude_code";

    soundNewSession();
    const sid = nanoid(10);
    const now = Date.now();

    store.syncRecord("conversations", sid, {
      _id: sid,
      _creationTime: now,
      user_id: "",
      agent_type: convexAgentType,
      session_id: sid,
      project_path: path,
      git_root: gitRoot || path,
      started_at: now,
      updated_at: now,
      message_count: 0,
      status: "active",
      title: "New session",
      messages: [],
    });

    store.syncRecord("sessions", sid, {
      _id: sid,
      session_id: sid,
      title: "New session",
      updated_at: now,
      started_at: now,
      project_path: path,
      git_root: gitRoot || path,
      agent_type: convexAgentType,
      message_count: 0,
      is_idle: true,
      has_pending: false,
      last_user_message: null,
    });

    const clientId = store.addOptimisticMessage(sid, fullMessage);

    setMessage("");
    setSelectedAgent(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    useInboxStore.setState({ sidePanelSessionId: sid });

    const convexId = await store._dispatch("createSession", [{
      agent_type: convexAgentType,
      project_path: path,
      git_root: gitRoot || path,
      session_id: sid,
    }]);

    if (convexId) {
      store.resolveSessionId(sid, convexId);
      store._dispatch("sendMessage", [convexId, fullMessage, null, clientId]);
      if (linkedObjectId) {
        store._dispatch("linkConversation", [contextType, linkedObjectId, convexId]);
      }
    }
  }, [message, contextType, contextTitle, getContextBody, agentKey, linkedObjectId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  const defaultPlaceholder = `Send a message...`;
  const hasText = message.trim().length > 0;

  return (
    <div className="shrink-0 pointer-events-none sticky bottom-0 z-10">
      <div className="h-16 bg-gradient-to-t from-sol-bg via-sol-bg/80 to-transparent -mt-16 relative" />
      <div className={`pb-4 pointer-events-auto bg-sol-bg`}>
      <div className={`mx-auto px-2 sm:px-4 transition-all duration-200 ease-out ${isExpanded ? "max-w-7xl" : "max-w-xs"}`}>
      {isExpanded && (
        <div className={`mx-auto px-4 mb-1 flex justify-between items-center ${isExpanded ? "max-w-7xl" : "max-w-md"}`}>
          <div className="flex items-center gap-1">
            {AGENT_TYPES.map((agent) => (
              <button
                key={agent.key}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setSelectedAgent(agent.key)}
                className={`px-2 py-0.5 text-[11px] font-medium rounded-md border transition-colors flex items-center gap-1 ${
                  agentKey === agent.key
                    ? agent.active
                    : "bg-transparent text-sol-text-dim border-transparent hover:text-sol-text-muted"
                }`}
              >
                <AgentTypeIcon agentType={agent.convex} className="w-3 h-3" />
                {agent.label}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-sol-text-dim/50">
            {contextType}
          </span>
        </div>
      )}
      <div className={`flex flex-col border shadow-lg transition-all duration-200 ${isExpanded ? "px-4 py-2 rounded-2xl" : "px-3 py-1.5 rounded-full"} bg-sol-bg-alt ${isFocused ? "border-sol-border" : "border-sol-border/50"}`}>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            data-chat-input
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              resetHeight();
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => {
              if (!message.trim()) setIsFocused(false);
            }}
            placeholder={placeholder || defaultPlaceholder}
            rows={1}
            className={`flex-1 bg-transparent text-sol-text placeholder:text-sol-text-dim focus:outline-none resize-none overflow-hidden leading-relaxed ${isExpanded ? "text-sm py-1" : "text-xs py-0.5"}`}
          />
          <div className="shrink-0">
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!hasText}
              className={`${isExpanded ? "w-8 h-8" : "w-6 h-6"} rounded-full transition-colors flex items-center justify-center border ${
                !hasText
                  ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed"
                  : "border-sol-blue/50 bg-sol-blue/20 text-sol-blue hover:bg-sol-blue/30 hover:border-sol-blue"
              }`}
            >
              <ArrowUp className={isExpanded ? "w-4 h-4" : "w-3 h-3"} />
            </button>
          </div>
        </div>
      </div>
    </div>
    </div>
    </div>
  );
}
