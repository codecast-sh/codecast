"use client";
import Link from "next/link";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { EmptyState } from "./EmptyState";
import { useState, useMemo, useRef, useCallback } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useConvexSync } from "../hooks/useConvexSync";
import { cleanTitle, isSystemMessage, isCommandMessage } from "../lib/conversationProcessor";
import { shouldShowSession, isSubagent, isTrivialSubagent, isWarmupSession } from "../lib/sessionFilters";
import { useConversationsWithError } from "../hooks/useConversationsWithError";
import { useStableOrder } from "../hooks/useStableOrder";
import { useFlipAnimation } from "../hooks/useFlipAnimation";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { soundNewSession } from "../lib/sounds";

function VisibilityDropdown({
  conversationId,
  isPrivate,
  visibilityMode,
  teamVisibility,
}: {
  conversationId: string;
  isPrivate: boolean;
  visibilityMode?: string;
  teamVisibility?: string | null;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [optimisticState, setOptimisticState] = useState<{ isPrivate?: boolean; teamVisibility?: string | null } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const setPrivacy = useMutation(api.conversations.setPrivacy);
  const setTeamVisibility = useMutation(api.conversations.setTeamVisibility);

  const effectivePrivate = optimisticState?.isPrivate !== undefined ? optimisticState.isPrivate : isPrivate;
  const effectiveTeamVisibility = optimisticState?.teamVisibility !== undefined ? optimisticState.teamVisibility : teamVisibility;
  const effectiveMode = effectivePrivate ? "private" : (effectiveTeamVisibility || visibilityMode || "summary");

  useWatchEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleSetPrivate = async () => {
    setOptimisticState({ isPrivate: true });
    setIsOpen(false);
    try {
      await setPrivacy({ conversation_id: conversationId as Id<"conversations">, is_private: true });
    } catch {
      setOptimisticState(null);
      toast.error("Failed to update visibility");
    }
  };

  const handleSetTeamVisibility = async (mode: "summary" | "full") => {
    setOptimisticState({ isPrivate: false, teamVisibility: mode });
    setIsOpen(false);
    try {
      await setTeamVisibility({ conversation_id: conversationId as Id<"conversations">, team_visibility: mode });
    } catch {
      setOptimisticState(null);
      toast.error("Failed to update visibility");
    }
  };

  const getLabel = () => {
    if (effectiveMode === "private") return "Private";
    if (effectiveMode === "full") return "Full";
    return "Summary";
  };

  const PrivateIcon = () => (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
    </svg>
  );

  const SummaryIcon = () => (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
    </svg>
  );

  const FullIcon = () => (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
          effectiveMode === "private"
            ? "bg-sol-base02/30 text-sol-text-muted border border-sol-border/30 hover:border-sol-border/50"
            : effectiveMode === "full"
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 hover:border-emerald-500/50"
              : "bg-teal-500/15 text-teal-600 dark:text-teal-400 border border-teal-500/30 hover:border-teal-500/50"
        }`}
      >
        {effectiveMode === "private" && <PrivateIcon />}
        {effectiveMode === "summary" && <SummaryIcon />}
        {effectiveMode === "full" && <FullIcon />}
        {getLabel()}
        <svg className="w-2.5 h-2.5 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isOpen && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-sol-bg border border-sol-border rounded-lg shadow-lg py-1 min-w-[150px]">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleSetPrivate();
            }}
            className={`w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 hover:bg-sol-bg-alt transition-colors ${effectiveMode === "private" ? "text-sol-text font-medium" : "text-sol-text-muted"}`}
          >
            <PrivateIcon />
            <div>
              <div>Private</div>
              <div className="text-[10px] text-sol-text-dim">Hidden from team</div>
            </div>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleSetTeamVisibility("summary");
            }}
            className={`w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 hover:bg-sol-bg-alt transition-colors ${effectiveMode === "summary" ? "text-teal-600 dark:text-teal-400 font-medium" : "text-sol-text-muted"}`}
          >
            <SummaryIcon />
            <div>
              <div>Summary</div>
              <div className="text-[10px] text-sol-text-dim">Title + activity</div>
            </div>
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleSetTeamVisibility("full");
            }}
            className={`w-full px-3 py-1.5 text-left text-xs flex items-center gap-2 hover:bg-sol-bg-alt transition-colors ${effectiveMode === "full" ? "text-emerald-600 dark:text-emerald-400 font-medium" : "text-sol-text-muted"}`}
          >
            <FullIcon />
            <div>
              <div>Full</div>
              <div className="text-[10px] text-sol-text-dim">Complete conversation</div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

function FavoriteButton({
  conversationId,
  isFavorite,
}: {
  conversationId: string;
  isFavorite: boolean;
}) {
  const [optimisticFavorite, setOptimisticFavorite] = useState<boolean | null>(null);
  const toggleFavorite = useMutation(api.conversations.toggleFavorite);

  const effectiveFavorite = optimisticFavorite !== null ? optimisticFavorite : isFavorite;

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOptimisticFavorite(!effectiveFavorite);
    try {
      await toggleFavorite({ conversation_id: conversationId as Id<"conversations"> });
    } catch {
      setOptimisticFavorite(null);
      toast.error("Failed to update favorite");
    }
  };

  return (
    <button
      onClick={handleClick}
      className={`p-1 rounded transition-colors ${
        effectiveFavorite
          ? "text-amber-400 hover:text-amber-300"
          : "text-sol-text-dim/30 hover:text-amber-400 opacity-0 group-hover:opacity-100"
      }`}
      title={effectiveFavorite ? "Remove from favorites" : "Add to favorites"}
    >
      <svg className="w-4 h-4" fill={effectiveFavorite ? "currentColor" : "none"} stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    </button>
  );
}

type Conversation = {
  _id: string;
  user_id: string;
  title?: string;
  subtitle?: string | null;
  first_user_message?: string;
  first_assistant_message?: string;
  message_alternates?: Array<{ role: "user" | "assistant"; content: string }>;
  tool_names?: string[];
  subagent_types?: string[];
  agent_type?: string;
  model?: string | null;
  slug?: string | null;
  started_at: number;
  updated_at: number;
  duration_ms: number;
  message_count?: number;
  ai_message_count?: number;
  tool_call_count?: number;
  is_active: boolean;
  author_name: string;
  is_own: boolean;
  parent_conversation_id?: string | null;
  parent_message_uuid?: string | null;
  is_subagent?: boolean;
  parent_title?: string | null;
  children?: Conversation[];
  latest_todos?: { todos: Array<{ status: string; content: string; activeForm?: string }>; timestamp: number };
  latest_usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreation: number;
    cacheRead: number;
    contextSize: number;
    timestamp: number;
  };
  project_path?: string | null;
  git_root?: string | null;
  is_favorite?: boolean;
  fork_count?: number;
  forked_from?: string | null;
  is_private?: boolean;
  auto_shared?: boolean;
  visibility_mode?: "full" | "detailed" | "summary" | "minimal";
  activity_summary?: string;
  author_avatar?: string | null;
};

function formatDuration(ms: number): string {
  if (ms < 60000) return "<1m";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function getDurationColor(ms: number): string {
  const minutes = ms / 60000;
  if (minutes < 5) return "text-sol-text-muted0 border-sol-border/40";
  if (minutes < 20) return "text-sol-text-muted border-sol-border/50";
  if (minutes < 60) return "text-amber-500/80 border-amber-600/40";
  if (minutes < 120) return "text-amber-400 border-amber-500/50";
  return "text-orange-400 border-orange-500/50";
}

function getMessageCountColor(count: number): string {
  if (count < 10) return "bg-sol-bg-alt/60 text-sol-text-muted0 border-sol-border/40";
  if (count < 30) return "bg-sol-bg-alt/80 text-sol-text-muted border-sol-border/50";
  if (count < 100) return "bg-blue-500/20 text-blue-400 border-blue-600/40";
  if (count < 200) return "bg-blue-500/30 text-blue-400 border-blue-500/50";
  return "bg-indigo-500/30 text-indigo-400 border-indigo-500/50";
}

function TodoBadge({ todos }: { todos: Array<{ status: string; content: string; activeForm?: string }> }) {
  const [showTooltip, setShowTooltip] = useState(false);
  const completed = todos.filter(t => t.status === 'completed').length;
  const activeTodo = todos.find(t => t.status === 'in_progress');

  return (
    <div className="relative inline-block">
      <span
        className="inline-flex items-center gap-1 text-sol-green cursor-default"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        {activeTodo ? (
          <span className="text-sol-text-secondary text-xs truncate max-w-[120px]">
            {activeTodo.activeForm || activeTodo.content}
          </span>
        ) : (
          <span>{completed}/{todos.length}</span>
        )}
      </span>
      {showTooltip && (
        <div className="absolute left-0 top-full mt-1 z-50 bg-sol-bg border border-sol-border rounded p-2 min-w-[180px] max-w-xs shadow-lg">
          <div className="space-y-1">
            {todos.map((todo, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                {todo.status === 'completed' ? (
                  <svg className="w-3 h-3 text-emerald-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : todo.status === 'in_progress' ? (
                  <svg className="w-3 h-3 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <circle cx="12" cy="12" r="9" strokeWidth={2} />
                  </svg>
                )}
                <span className={`${
                  todo.status === 'completed' ? 'text-sol-text-dim line-through' :
                  todo.status === 'in_progress' ? 'text-sol-text' :
                  'text-sol-text-muted'
                }`}>
                  {todo.content}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ClaudeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
    </svg>
  );
}

function OpenAIIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

function CursorIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 4l16 6-8 2-2 8z"/>
    </svg>
  );
}

function GeminiIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C12 0 12 6.268 8.134 10.134C4.268 14 0 14 0 14C0 14 6.268 14 10.134 17.866C14 21.732 14 28 14 28C14 28 14 21.732 17.866 17.866C21.732 14 28 14 28 14C28 14 21.732 14 17.866 10.134C14 6.268 14 0 14 0" transform="scale(0.857) translate(1, -2)"/>
    </svg>
  );
}

function AgentIcon({ agentType, className = "w-4 h-4" }: { agentType: string; className?: string }) {
  if (agentType === "codex" || agentType === "codex_cli") {
    return (
      <span className={`${className} rounded bg-[#0f0f0f] flex items-center justify-center shrink-0`}>
        <OpenAIIcon className="w-2.5 h-2.5 text-white" />
      </span>
    );
  } else if (agentType === "cursor") {
    return (
      <span className={`${className} rounded bg-[#1a1a2e] flex items-center justify-center shrink-0`}>
        <CursorIcon className="w-2.5 h-2.5 text-white" />
      </span>
    );
  } else if (agentType === "gemini") {
    return (
      <span className={`${className} rounded bg-[#1a73e8] flex items-center justify-center shrink-0`}>
        <GeminiIcon className="w-2.5 h-2.5 text-white" />
      </span>
    );
  }
  return (
    <span className={`${className} rounded bg-sol-orange flex items-center justify-center shrink-0`}>
      <ClaudeIcon className="w-2.5 h-2.5 text-sol-bg" />
    </span>
  );
}


type TimeGroup = {
  label: string;
  conversations: Conversation[];
};

function getRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";

  const date = new Date(timestamp);

  if (diffDays < 7) {
    return date.toLocaleDateString("en-US", { weekday: "long" });
  }

  const thisYear = new Date().getFullYear();
  if (date.getFullYear() === thisYear) {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function groupByTime(conversations: Conversation[]): TimeGroup[] {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const sixHoursAgo = now - 6 * 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  const groups: TimeGroup[] = [
    { label: "Last Hour", conversations: [] },
    { label: "Last 6 Hours", conversations: [] },
    { label: "Last 24 Hours", conversations: [] },
    { label: "This Week", conversations: [] },
    { label: "Older", conversations: [] },
  ];

  conversations.forEach((conv) => {
    if (conv.updated_at >= oneHourAgo) {
      groups[0].conversations.push(conv);
    } else if (conv.updated_at >= sixHoursAgo) {
      groups[1].conversations.push(conv);
    } else if (conv.updated_at >= oneDayAgo) {
      groups[2].conversations.push(conv);
    } else if (conv.updated_at >= weekAgo) {
      groups[3].conversations.push(conv);
    } else {
      groups[4].conversations.push(conv);
    }
  });

  return groups.filter((g) => g.conversations.length > 0);
}

function getAgentTypeLabel(agentType: string): string {
  if (agentType === "claude_code") return "Claude Code";
  if (agentType === "codex" || agentType === "codex_cli") return "Codex";
  if (agentType === "cursor") return "Cursor";
  if (agentType === "gemini") return "Gemini";
  return agentType;
}

function createConversationAriaLabel(conv: Conversation): string {
  const title = cleanTitle(conv.title || "Untitled");
  const agentType = getAgentTypeLabel(conv.agent_type || "claude_code");
  const time = getRelativeTime(conv.updated_at);
  const status = conv.is_active ? ", active" : "";
  return `${title}, ${agentType}, ${time}${status}`;
}

export function NewSessionModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [agentType, setAgentType] = useState<"claude" | "codex" | "gemini">("claude");
  const [projectPath, setProjectPath] = useState("");
  const [isolated, setIsolated] = useState(false);
  const [worktreeName, setWorktreeName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [dropdownIndex, setDropdownIndex] = useState(-1);
  const createQuickSession = useMutation(api.conversations.createQuickSession);
  const freshProjects = useQuery(api.users.getRecentProjectPaths, { limit: 15 });
  const cachedProjects = useInboxStore((s) => s.recentProjects);
  const setRecentProjects = useInboxStore((s) => s.setRecentProjects);
  const recentProjects = freshProjects ?? (cachedProjects.length > 0 ? cachedProjects : null);
  const modalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const context = useInboxStore((s) => s.newSession.context);

  useConvexSync(freshProjects, setRecentProjects);

  const filteredProjects = useMemo(() => {
    if (!recentProjects || recentProjects.length === 0) return [];
    if (!projectPath) return recentProjects;
    const lower = projectPath.toLowerCase();
    return recentProjects.filter((p: { path: string }) => p.path.toLowerCase().includes(lower));
  }, [recentProjects, projectPath]);

  useWatchEffect(() => {
    if (isOpen && context.projectPath) {
      setProjectPath(context.projectPath);
    } else if (isOpen && !context.projectPath && recentProjects?.length) {
      setProjectPath(recentProjects[0].path);
    }
    if (isOpen && context.agentType) {
      const mapped = context.agentType === "claude_code" ? "claude" : context.agentType === "codex" ? "codex" : "gemini";
      setAgentType(mapped as "claude" | "codex" | "gemini");
    }
  }, [isOpen, context, recentProjects]);

  useWatchEffect(() => {
    if (!isOpen) return;
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function handleClickOutside(e: MouseEvent) {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("keydown", handleEsc);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("keydown", handleEsc);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    setIsSubmitting(true);
    soundNewSession();
    try {
      const convexAgentType = agentType === "claude" ? "claude_code" as const : agentType === "codex" ? "codex" as const : "gemini" as const;
      const conversationId = await createQuickSession({
        agent_type: convexAgentType,
        project_path: projectPath || undefined,
        git_root: projectPath || undefined,
        isolated: isolated || undefined,
        worktree_name: (isolated && worktreeName) ? worktreeName : undefined,
      });
      router.push(`/conversation/${conversationId}?focus=1`);
      onClose();
      setProjectPath("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create session");
    } finally {
      setIsSubmitting(false);
    }
  };


  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-sm">
      <div ref={modalRef} className="bg-white dark:bg-sol-bg border border-sol-border rounded-xl shadow-2xl w-full max-w-md mx-4">
        <div className="px-5 pt-5 pb-3">
          <h3 className="text-base font-semibold text-sol-text">New Session</h3>
          <p className="text-xs text-sol-text-muted mt-0.5">Start a coding session on your machine</p>
        </div>

        <div className="px-5 pb-4 space-y-3">
          {/* Agent type */}
          <div className="flex gap-2">
            {(["claude", "codex", "gemini"] as const).map((type) => (
              <button
                key={type}
                onClick={() => setAgentType(type)}
                className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors border ${
                  agentType === type
                    ? type === "claude"
                      ? "bg-sol-yellow/20 text-sol-yellow border-sol-yellow/50"
                      : type === "codex"
                        ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/50"
                        : "bg-blue-500/20 text-blue-400 border-blue-500/50"
                    : "bg-sol-bg-alt/60 text-sol-text-muted border-sol-border/40 hover:border-sol-border"
                }`}
              >
                <div className="flex items-center justify-center gap-1.5">
                  <AgentIcon agentType={type === "claude" ? "claude_code" : type} className="w-4 h-4" />
                  {type === "claude" ? "Claude" : type === "codex" ? "Codex" : "Gemini"}
                </div>
              </button>
            ))}
          </div>

          {/* Project path */}
          <div className="relative">
            <label className="block text-xs font-medium text-sol-text-muted mb-1">Project directory</label>
            <input
              ref={inputRef}
              type="text"
              value={projectPath}
              onChange={(e) => {
                setProjectPath(e.target.value);
                setShowDropdown(true);
                setDropdownIndex(-1);
              }}
              onFocus={() => setShowDropdown(true)}
              onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
              placeholder="~/src/my-project"
              className="w-full px-3 py-2 text-sm bg-sol-bg-alt border border-sol-border/50 rounded-lg text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-yellow/50"
              onKeyDown={(e) => {
                if (showDropdown && filteredProjects.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setDropdownIndex((i) => Math.min(i + 1, filteredProjects.length - 1));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setDropdownIndex((i) => Math.max(i - 1, -1));
                    return;
                  }
                  if (e.key === "Enter" && dropdownIndex >= 0) {
                    e.preventDefault();
                    setProjectPath(filteredProjects[dropdownIndex].path);
                    setShowDropdown(false);
                    return;
                  }
                  if (e.key === "Tab" && dropdownIndex >= 0) {
                    e.preventDefault();
                    setProjectPath(filteredProjects[dropdownIndex].path);
                    setShowDropdown(false);
                    return;
                  }
                }
                if (e.key === "Escape") {
                  setShowDropdown(false);
                  return;
                }
                if (e.key === "Enter") handleSubmit();
              }}
            />
            {showDropdown && filteredProjects.length > 0 && (
              <div ref={dropdownRef} className="absolute z-10 left-0 right-0 mt-1 bg-white dark:bg-sol-bg border border-sol-border rounded-lg shadow-lg overflow-hidden max-h-[200px] overflow-y-auto">
                {filteredProjects.map((p, i) => {
                  const parts = p.path.split("/");
                  const dirName = parts.pop() || "";
                  const parentPath = parts.join("/");
                  return (
                    <button
                      key={p.path}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setProjectPath(p.path);
                        setShowDropdown(false);
                      }}
                      onMouseEnter={() => setDropdownIndex(i)}
                      className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between gap-2 transition-colors ${
                        i === dropdownIndex
                          ? "bg-sol-yellow/15 text-sol-text"
                          : "text-sol-text-muted hover:bg-sol-bg-alt"
                      }`}
                    >
                      <span className="truncate">
                        <span className="text-sol-text-dim">{parentPath}/</span>
                        <span className="font-medium text-sol-text">{dirName}</span>
                      </span>
                      <span className="text-[10px] text-sol-text-dim shrink-0">{p.count} session{p.count !== 1 ? "s" : ""}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="px-5 pb-3">
          <button
            onClick={() => setIsolated(!isolated)}
            className={`flex items-center gap-2 text-xs transition-colors ${
              isolated ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text-muted"
            }`}
          >
            <span className={`w-7 h-4 rounded-full transition-colors relative ${isolated ? "bg-sol-cyan/30" : "bg-sol-border/50"}`}>
              <span className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${isolated ? "left-3.5 bg-sol-cyan" : "left-0.5 bg-sol-text-dim"}`} />
            </span>
            Isolated worktree
          </button>
          {isolated && (
            <input
              type="text"
              value={worktreeName}
              onChange={(e) => setWorktreeName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))}
              placeholder="feature-name (optional)"
              className="mt-2 w-full px-3 py-1.5 text-xs bg-sol-bg-alt border border-sol-border/50 rounded-lg text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan/50 font-mono"
            />
          )}
        </div>

        <div className="px-5 pb-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-sol-text-muted hover:text-sol-text transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium bg-sol-yellow text-sol-bg rounded-lg hover:bg-sol-yellow/90 transition-colors disabled:opacity-50"
          >
            {isSubmitting ? "Creating..." : "Create Session"}
          </button>
        </div>
      </div>
    </div>
  );
}

type TimeFilter = "all" | "long" | "active";
type SubagentFilter = "all" | "main" | "subagent";

interface ConversationListProps {
  filter: "my" | "team";
  directoryFilter?: string | null;
  memberFilter?: string | null;
  onMemberFilterChange?: (memberId: string | null) => void;
  onNavigate?: (conversationId: string) => void;
}

export function ConversationList({ filter, directoryFilter, memberFilter, onMemberFilterChange, onNavigate }: ConversationListProps) {
  const router = useRouter();
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [subagentFilter, setSubagentFilter] = useState<SubagentFilter>("all");
  const serverSubagentFilter = subagentFilter === "all" ? null : subagentFilter;
  const serverTimeFilter = timeFilter === "all" ? null : timeFilter;
  const { conversations, hasMore, loadMore, isLoadingMore, isLoading, hasSubagents } = useConversationsWithError(filter, memberFilter, serverSubagentFilter, directoryFilter, serverTimeFilter);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const showNewSession = useInboxStore((s) => s.newSession.isOpen);
  const openNewSession = useInboxStore((s) => s.openNewSession);
  const closeNewSession = useInboxStore((s) => s.closeNewSession);
  const listRef = useRef<HTMLDivElement>(null);
  const isHoveredRef = useRef(false);
  const { containerRef: flipContainerRef, beforeReorder } = useFlipAnimation();
  const getConvKey = useCallback((c: Conversation) => c._id, []);

  const user = useQuery(api.users.getCurrentUser);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const effectiveTeamId = activeTeamId || user?.team_id;
  const teamMembers = useQuery(
    api.teams.getTeamMembers,
    effectiveTeamId ? { team_id: effectiveTeamId } : "skip"
  );
  const userTeams = useQuery(api.teams.getUserTeams);
  const activeTeam = activeTeamId ? userTeams?.find(t => t?._id === activeTeamId) : null;
  const hasTeammates = teamMembers && teamMembers.length > 1;
  const hasTeam = !!effectiveTeamId;

  useMountEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 60000);
    return () => clearInterval(interval);
  });

  useWatchEffect(() => {
    if (!hasMore || isLoadingMore) return;

    const scrollContainer = document.querySelector("[data-main-scroll]") as HTMLElement | null;
    if (!scrollContainer) return;

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
      if (scrollHeight - scrollTop - clientHeight < 400) {
        loadMore();
      }
    };

    scrollContainer.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => scrollContainer.removeEventListener("scroll", onScroll);
  }, [hasMore, isLoadingMore, loadMore]);

  const { filteredConversations, counts } = useMemo(() => {
    if (!conversations || conversations.length === 0) return { filteredConversations: [], counts: { long: 0, active: 0, main: 0 } };
    const convs = conversations as Conversation[];

    const nonTrivialConvs = convs.filter(c => {
      if (c.visibility_mode === "summary" || c.visibility_mode === "minimal") {
        return !isTrivialSubagent(c) && !isWarmupSession(c);
      }
      return shouldShowSession(c, { excludeDefaultTitles: filter === "team" && !c.is_own });
    });

    const counts = {
      long: nonTrivialConvs.filter(c => c.duration_ms >= 20 * 60 * 1000).length,
      active: nonTrivialConvs.filter(c => c.is_active).length,
      main: nonTrivialConvs.filter(c => !isSubagent(c)).length,
    };

    const filtered = [...nonTrivialConvs];
    filtered.sort((a, b) => b.updated_at - a.updated_at);

    return { filteredConversations: filtered, counts };
  }, [conversations, filter]);

  const stableConversations = useStableOrder({
    items: filteredConversations,
    getKey: getConvKey,
    isHovered: isHoveredRef,
    onBeforeReorder: beforeReorder,
  });

  const flatConversations = stableConversations;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (flatConversations.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((prev) => {
          if (prev < flatConversations.length - 1) {
            return prev + 1;
          }
          return prev;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((prev) => {
          if (prev > 0) {
            return prev - 1;
          }
          return prev;
        });
      } else if (e.key === "Enter" && focusedIndex >= 0) {
        e.preventDefault();
        const conversation = flatConversations[focusedIndex];
        if (conversation) {
          if (onNavigate) {
            onNavigate(conversation._id);
          } else {
            router.push(`/conversation/${conversation._id}`);
          }
        }
      }
    },
    [flatConversations, focusedIndex, router, onNavigate]
  );

  useWatchEffect(() => {
    if (focusedIndex === -1 && flatConversations.length > 0 && document.activeElement === listRef.current) {
      setFocusedIndex(0);
    }
  }, [focusedIndex, flatConversations.length]);

  if (isLoading && conversations.length === 0) {
    return <LoadingSkeleton />;
  }

  if (!isLoading && conversations.length === 0) {
    if (filter === "team") {
      return (
        <EmptyState
          title="No team conversations yet"
          description="Your team hasn't synced any conversations. Invite team members to start sharing conversations."
          action={{
            label: "Invite team members",
            href: "/settings/team",
          }}
        />
      );
    }

    return (
      <EmptyState
        title="No conversations yet"
        description="Your synced conversations will appear here. Start a conversation in Claude Code or Cursor to see it listed."
        action={{
          label: "Learn how to sync",
          href: "/cli",
        }}
        variant="onboarding"
        hasOtherSessions={hasTeam}
      />
    );
  }

  const groups = groupByTime(stableConversations);

  return (
    <div
      ref={listRef}
      className="space-y-6"
      tabIndex={0}
      role="list"
      aria-label="Conversation list"
      onKeyDown={handleKeyDown}
      onMouseEnter={() => { isHoveredRef.current = true; }}
      onMouseLeave={() => { isHoveredRef.current = false; }}
      onFocus={() => {
        if (focusedIndex === -1 && flatConversations.length > 0) {
          setFocusedIndex(0);
        }
      }}
      onBlur={() => setFocusedIndex(-1)}>
      {/* Filter bar */}
      <div className="flex gap-1.5 sm:gap-2 items-center pt-1 sm:pt-2 overflow-x-auto pb-1 scrollbar-auto sm:flex-wrap sm:overflow-x-visible sm:pb-0">
        {filter === "my" && (
          <button
            onClick={() => openNewSession()}
            className="px-2 sm:px-2.5 md:px-3 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors whitespace-nowrap bg-sol-yellow/20 text-sol-yellow border border-sol-yellow/40 hover:bg-sol-yellow/30"
          >
            <span className="flex items-center gap-1">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              <span className="hidden sm:inline">New Session</span>
              <span className="sm:hidden">New</span>
            </span>
          </button>
        )}
        {filter === "my" && <div className="w-px h-5 bg-sol-border/30 mx-0.5" />}
        {/* Time filters */}
        <button
          onClick={() => setTimeFilter("all")}
          className={`px-2 sm:px-2.5 md:px-3 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors whitespace-nowrap ${
            timeFilter === "all"
              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
              : "bg-sol-bg-alt/60 text-sol-text-muted border border-sol-border/40 hover:border-sol-border bg-sol-bg-alt border-sol-border"
          }`}
        >
          All
        </button>
        <button
          onClick={() => setTimeFilter("long")}
          className={`px-2 sm:px-2.5 md:px-3 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors whitespace-nowrap ${
            timeFilter === "long"
              ? "bg-amber-500/20 text-amber-400 border border-amber-500/40"
              : "bg-sol-bg-alt/60 text-sol-text-muted border border-sol-border/40 hover:border-sol-border bg-sol-bg-alt border-sol-border"
          }`}
        >
          <span className="hidden sm:inline">Long Running</span>
          <span className="sm:hidden">Long</span>
          {counts.long > 0 && ` (${counts.long})`}
        </button>
        <button
          onClick={() => setTimeFilter("active")}
          className={`px-2 sm:px-2.5 md:px-3 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors whitespace-nowrap ${
            timeFilter === "active"
              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
              : "bg-sol-bg-alt/60 text-sol-text-muted border border-sol-border/40 hover:border-sol-border bg-sol-bg-alt border-sol-border"
          }`}
        >
          Active{counts.active > 0 && ` (${counts.active})`}
        </button>

        <div className="w-px bg-sol-border/30 mx-1" />

        {/* Subagent filters */}
        <button
          onClick={() => setSubagentFilter(subagentFilter === "main" ? "all" : "main")}
          className={`px-2 sm:px-2.5 md:px-3 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors whitespace-nowrap ${
            subagentFilter === "main"
              ? "bg-sol-blue/20 text-sol-blue border border-sol-blue/40"
              : "bg-sol-bg-alt/40 text-sol-text-muted border border-sol-border/30 hover:border-sol-border/50"
          }`}
        >
          Main{counts.main > 0 && ` (${counts.main})`}
        </button>
        <button
          onClick={() => setSubagentFilter(subagentFilter === "subagent" ? "all" : "subagent")}
          className={`px-2 sm:px-2.5 md:px-3 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors whitespace-nowrap ${
            subagentFilter === "subagent"
              ? "bg-sol-violet/20 text-sol-violet border border-sol-violet/40"
              : "bg-sol-bg-alt/40 text-sol-text-muted border border-sol-border/30 hover:border-sol-border/50"
          }`}
        >
          <span className="hidden sm:inline">Subagent</span>
          <span className="sm:hidden">Sub</span>
          {hasSubagents && subagentFilter !== "subagent" && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-sol-violet/60 inline-block" />}
        </button>

        {/* Member filter (team only) */}
        {filter === "team" && teamMembers && teamMembers.length > 0 && (
          <>
            <div className="w-px bg-sol-border/30 mx-1" />
            <select
              value={memberFilter || ""}
              onChange={(e) => onMemberFilterChange?.(e.target.value || null)}
              className={`appearance-none cursor-pointer px-2 sm:px-2.5 md:px-3 py-1 sm:py-1.5 pr-7 text-xs sm:text-sm rounded-lg transition-colors whitespace-nowrap border ${
                memberFilter
                  ? "bg-purple-500/20 text-purple-400 border-purple-500/40"
                  : "bg-sol-bg-alt text-sol-text-muted border-sol-border/30 hover:border-sol-border/50"
              }`}
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%23888'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`, backgroundSize: '12px', backgroundPosition: 'right 8px center', backgroundRepeat: 'no-repeat' }}
            >
              <option value="">All {activeTeam?.name || "Team"}</option>
              {teamMembers.filter((m): m is NonNullable<typeof m> => m !== null).map((member) => (
                <option key={member._id} value={member._id}>
                  {member.name || member.email}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {/* Screen reader announcement for focused item */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {focusedIndex >= 0 && focusedIndex < flatConversations.length && (
          `Selected: ${createConversationAriaLabel(flatConversations[focusedIndex])}`
        )}
      </div>

      <div ref={flipContainerRef}>
      {groups.length === 0 && (
        <LoadingSkeleton />
      )}
      {groups.map((group) => (
        <div key={group.label} className="first:mt-0 mt-4 sm:mt-6">
          <div className="pb-1.5 sm:pb-2 mb-2 sm:mb-3">
            <h2 className="text-[10px] sm:text-xs font-medium tracking-wide uppercase text-sol-text-muted0">
              {group.label}
            </h2>
          </div>

          <div className="space-y-2 sm:space-y-3">
            {group.conversations.map((conv) => {
              const convIndex = flatConversations.findIndex(c => c._id === conv._id);
              const isFocused = convIndex === focusedIndex;

              // Minimal mode: just show activity line (e.g., "Worked in outreach for 4m")
              if (conv.visibility_mode === "minimal") {
                const minimalContent = (
                  <div className="flex items-center gap-3">
                    {conv.author_avatar ? (
                      <img
                        src={conv.author_avatar}
                        alt={conv.author_name}
                        className="w-6 h-6 rounded-full shrink-0"
                      />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-sol-base02 flex items-center justify-center shrink-0">
                        <span className="text-xs text-sol-text-muted">{conv.author_name?.charAt(0).toUpperCase()}</span>
                      </div>
                    )}
                    <span className="font-medium text-sol-text text-sm">{conv.author_name}</span>
                    {conv.is_active && (
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    )}
                    <span className="text-sol-text-muted text-sm flex-1">{conv.activity_summary}</span>
                    <span className="text-sol-text-dim text-xs">{getRelativeTime(conv.updated_at)}</span>
                  </div>
                );

                // Own conversations are clickable even in minimal mode
                if (conv.is_own) {
                  return (
                    <Link
                      key={conv._id}
                      href={`/conversation/${conv._id}`}
                      className="group block relative"
                      role="listitem"
                      data-flip-key={conv._id}
                      onClick={onNavigate ? (e) => { e.preventDefault(); onNavigate(conv._id); } : undefined}
                    >
                      <div className="relative bg-blue-50/50 dark:bg-blue-950/20 border-2 border-blue-300/50 dark:border-blue-500/30 rounded-lg p-3 hover:border-blue-400 transition-colors">
                        {minimalContent}
                      </div>
                    </Link>
                  );
                }

                return (
                  <div
                    key={conv._id}
                    className="relative bg-sol-bg-alt/30 border border-sol-border/30 rounded-lg p-3"
                    role="listitem"
                    data-flip-key={conv._id}
                  >
                    {minimalContent}
                  </div>
                );
              }

              // Summary mode: shows title + subtitle but not clickable for others
              // Detailed mode: shows title + subtitle but not clickable for others

              const isOthersRestrictedView = (conv.visibility_mode === "detailed" || conv.visibility_mode === "summary") && !conv.is_own;

              return (
                <Link
                  key={conv._id}
                  href={isOthersRestrictedView ? "#" : `/conversation/${conv._id}`}
                  className={`group block relative ${isOthersRestrictedView ? "cursor-default" : ""}`}
                  role="listitem"
                  aria-label={createConversationAriaLabel(conv)}
                  aria-current={isFocused ? "true" : undefined}
                  onClick={isOthersRestrictedView ? (e) => e.preventDefault() : onNavigate ? (e) => { e.preventDefault(); onNavigate(conv._id); } : undefined}
                  data-flip-key={conv._id}
                >
                  <div className={`relative border rounded-lg sm:rounded-xl transition-all duration-200 dark:shadow-none ${
                    conv.is_subagent
                      ? !conv.is_active
                        ? "p-2 sm:p-2.5 bg-sol-bg-alt/20 dark:bg-sol-bg-alt/10 border-sol-border/20 opacity-40 hover:opacity-60"
                        : "p-2 sm:p-2.5 bg-sol-bg-alt/30 dark:bg-sol-bg-alt/20 border-violet-500/20 hover:border-violet-500/40 opacity-60 hover:opacity-80"
                    : isOthersRestrictedView
                      ? "p-2.5 sm:p-3 md:p-4 shadow-sm bg-white dark:bg-sol-bg-alt border-sol-border/30 opacity-70"
                      : filter === "team" && conv.is_own && !conv.is_private
                        ? isFocused
                          ? "p-2.5 sm:p-3 md:p-4 shadow-sm bg-[#fcfffc] dark:bg-[#0d1f15] ring-2 ring-sol-yellow border-2 border-emerald-400/40 hover:border-emerald-400/60 hover:shadow-md"
                          : "p-2.5 sm:p-3 md:p-4 shadow-sm bg-[#fcfffc] dark:bg-[#0d1f15] border-2 border-emerald-400/35 hover:border-emerald-400/50 hover:shadow-md"
                        : isFocused
                          ? "p-2.5 sm:p-3 md:p-4 shadow-sm bg-white dark:bg-sol-bg-alt ring-2 ring-sol-yellow border-sol-yellow/60 hover:border-sol-yellow/50 hover:shadow-md"
                          : "p-2.5 sm:p-3 md:p-4 shadow-sm bg-white dark:bg-sol-bg-alt border-sol-border/40 hover:border-sol-yellow/50 hover:shadow-md"
                  }`}>
                  <div className="flex items-start justify-between gap-2 sm:gap-3 md:gap-4">
                    <div className="flex-1 min-w-0">
                      {/* Header row: title + timestamp */}
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <AgentIcon agentType={conv.agent_type || "claude_code"} className="w-4 h-4 shrink-0" />
                          <span className={`font-medium text-sm sm:text-base transition-colors truncate ${
                            isOthersRestrictedView
                              ? "text-sol-text-muted"
                              : "text-sol-text"
                          }`}>
                            {cleanTitle(conv.title || "Untitled")}
                          </span>
                          {conv.is_active && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-green/20 border border-sol-green/50 shrink-0 select-none">
                              <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse" />
                              <span className="text-[10px] text-sol-green font-semibold">LIVE</span>
                            </span>
                          )}
                        </div>
                        <div
                          className="flex items-center gap-1.5 shrink-0 select-none"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {filter === "team" && hasTeam && conv.is_own && (
                            <VisibilityDropdown
                              conversationId={conv._id}
                              isPrivate={conv.is_private ?? false}
                              visibilityMode={conv.visibility_mode}
                              teamVisibility={conv.team_visibility}
                            />
                          )}
                          {filter === "team" && hasTeam && !conv.is_own && conv.visibility_mode && (
                            <span className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              conv.visibility_mode === "full" ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30" :
                              conv.visibility_mode === "summary" ? "bg-teal-500/15 text-teal-600 dark:text-teal-400 border border-teal-500/30" :
                              "bg-sol-base02/50 text-sol-text-muted border border-sol-border/40"
                            }`}>
                              {(conv.visibility_mode === "full" || conv.visibility_mode === "summary") && (
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
                                </svg>
                              )}
                              {conv.visibility_mode === "full" ? "Full" :
                               conv.visibility_mode === "summary" ? "Summary" :
                               conv.visibility_mode === "minimal" ? "Activity" :
                               conv.visibility_mode}
                            </span>
                          )}
                          <FavoriteButton
                            conversationId={conv._id}
                            isFavorite={conv.is_favorite ?? false}
                          />
                          <span className="text-[11px] text-sol-text-dim/50">
                            {getRelativeTime(conv.updated_at)}
                          </span>
                        </div>
                      </div>

                      {/* Subagent parent link */}
                      {conv.parent_conversation_id && (
                        <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-sol-text-dim">
                          <svg className="w-3 h-3 rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                          </svg>
                          <span>sub of</span>
                          <button
                            className="text-sol-cyan/70 hover:text-sol-cyan truncate max-w-[200px] transition-colors text-left"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              router.push(`/conversation/${conv.parent_conversation_id}`);
                            }}
                          >
                            {conv.parent_title || "parent session"}
                          </button>
                        </div>
                      )}

                      {/* Subtitle - shown for full/detailed/summary modes */}
                      {conv.subtitle && conv.visibility_mode !== "minimal" && (
                        <p className="text-xs sm:text-sm text-sol-text-muted mb-1.5 sm:mb-2 line-clamp-2 whitespace-pre-line">{conv.subtitle}</p>
                      )}

                      {(() => {
                        // Trust backend's visibility_mode - no frontend re-computation
                        if (conv.visibility_mode && conv.visibility_mode !== "full") return null;

                        const alternates = conv.message_alternates || [];
                        if (alternates.length === 0) return null;

                        const cleanTeammate = (c: string) => {
                          if (!c?.includes('<teammate-message')) return c;
                          return c.replace(/<teammate-message\s+[^>]*>[\s\S]*?<\/teammate-message>/g, '').trim();
                        };
                        const clean = (c: string) => cleanTeammate(c)?.replace(/<[^>]+>/g, "").replace(/^\s*Caveat:.*$/gm, "").trim() || "";
                        const commandLabel = (c: string) => {
                          const m = c.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
                          return m ? `/${m[1].replace(/^\//, "")}` : null;
                        };

                        const processed = alternates
                          .map(m => {
                            const isCmd = m.role === "user" && isCommandMessage(m.content);
                            return { ...m, cleanContent: isCmd ? (commandLabel(m.content) || clean(m.content)) : clean(m.content), isCmd };
                          })
                          .filter(m => m.cleanContent.length > 0 && !isSystemMessage(m.cleanContent));

                        if (processed.length === 0) return null;

                        const firstMsgs = processed.slice(0, 2);
                        const lastMsgs = processed.length > 4 ? processed.slice(-2) : [];
                        const showEllipsis = processed.length > 4;

                        const renderMessage = (m: typeof processed[0], key: string) => (
                          <div key={key} className="flex items-start gap-2 min-w-0">
                            {m.role === "assistant" ? (
                              <span className="flex-shrink-0 mt-0.5">
                                <AgentIcon agentType={conv.agent_type || "claude_code"} className="w-4 h-4" />
                              </span>
                            ) : (
                              <span className="flex-shrink-0 w-4 h-4 rounded-full bg-sol-violet/60 flex items-center justify-center mt-0.5 text-[8px] font-medium text-white">
                                {(conv.author_name?.charAt(0) || "U").toUpperCase()}
                              </span>
                            )}
                            {m.isCmd ? (
                              <span className="font-mono text-sol-cyan/80 font-medium truncate min-w-0 leading-relaxed">{m.cleanContent}</span>
                            ) : (
                              <span className={`truncate min-w-0 leading-relaxed ${m.role === "user" ? "text-sky-700 dark:text-sky-300" : "text-sol-text-muted"}`}>{m.cleanContent}</span>
                            )}
                          </div>
                        );

                        return (
                          <div className="mb-2 sm:mb-3 space-y-1 sm:space-y-1.5 text-[11px] sm:text-xs overflow-hidden opacity-70">
                            {firstMsgs.map((m, idx) => renderMessage(m, `first-${idx}`))}
                            {showEllipsis && (
                              <div className="flex items-center gap-2 pl-6">
                                <span className="text-sol-text-muted0">...</span>
                              </div>
                            )}
                            {lastMsgs.map((m, idx) => renderMessage(m, `last-${idx}`))}
                          </div>
                        );
                      })()}


                      <div className="flex items-center gap-1.5 sm:gap-2 text-[11px] sm:text-xs flex-wrap text-sol-text-muted0 select-none">
                        {(filter === "team" || !conv.is_own) && (
                          <span className="flex items-center gap-1.5 font-medium">
                            {conv.author_avatar ? (
                              <img
                                src={conv.author_avatar}
                                alt={conv.author_name}
                                className="w-4 h-4 rounded-full"
                              />
                            ) : (
                              <span className="w-4 h-4 rounded-full bg-sol-base02 flex items-center justify-center text-[8px] text-sol-text-muted">
                                {conv.author_name?.charAt(0).toUpperCase()}
                              </span>
                            )}
                            {conv.is_own ? (
                              <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-700 dark:text-blue-300 font-semibold text-xs border border-blue-500/30">You</span>
                            ) : conv.author_name}
                          </span>
                        )}
                        {(conv.project_path || conv.git_root) && (
                          <span className="inline-flex items-center gap-1 text-sol-text-dim" title={conv.project_path || conv.git_root || ""}>
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                            </svg>
                            <span className="truncate max-w-[100px]">{(conv.git_root || conv.project_path || "").split("/").pop()}</span>
                          </span>
                        )}
                        {filter === "team" && !conv.is_own && conv.is_private === false && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30 text-[10px] font-medium">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                            Shared
                          </span>
                        )}
                        {conv.duration_ms > 60000 && (
                          <span className={`hidden sm:inline-flex items-center gap-1 ${getDurationColor(conv.duration_ms).split(' ')[0]}`}>
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            {formatDuration(conv.duration_ms)}
                          </span>
                        )}
                        {(conv.message_count ?? 0) > 0 && (
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border ${getMessageCountColor(conv.message_count ?? 0)}`}>
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                            <span className="text-[10px] font-semibold">{conv.message_count}</span>
                          </span>
                        )}
                        {conv.latest_todos && conv.latest_todos.todos.length > 0 && (
                          <TodoBadge todos={conv.latest_todos.todos} />
                        )}
                        {((conv.fork_count ?? 0) > 0 || conv.forked_from) && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/30"
                            title={conv.forked_from ? "This is a fork" : `${conv.fork_count} fork${conv.fork_count === 1 ? '' : 's'}`}
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                            </svg>
                            {conv.forked_from ? "fork" : conv.fork_count}
                          </span>
                        )}
                        {conv.subagent_types && conv.subagent_types.length > 0 && conv.subagent_types.map((type) => (
                          <span
                            key={type}
                            className="inline-flex items-center px-1.5 py-0.5 rounded bg-sol-cyan/20 text-sol-cyan border border-sol-cyan/40 text-[10px] font-mono"
                          >
                            {type}
                          </span>
                        ))}
                        {(conv.is_subagent || conv.title?.startsWith("Session agent-")) && (
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            !conv.is_active
                              ? "bg-sol-bg-alt/50 text-sol-text-dim border border-sol-border/30 line-through"
                              : "bg-violet-900/40 text-violet-300 border border-violet-600/50"
                          }`}>
                            {!conv.is_active ? "Terminated" : "Subagent"}
                          </span>
                        )}
                        {conv.parent_conversation_id && !conv.is_subagent && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sol-blue/20 text-sol-blue border border-sol-blue/40 text-[10px] font-medium">
                            Plan
                          </span>
                        )}
                        {(conv as any).active_plan && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20 text-[10px] font-medium max-w-[120px] truncate" title={(conv as any).active_plan.title}>
                            {(conv as any).active_plan.title}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </Link>
              );
            })}
          </div>
        </div>
      ))}
      </div>

      {(hasMore || isLoadingMore) && (
        <div className="flex justify-center pt-4 pb-8">
          {isLoadingMore && (
            <span className="flex items-center gap-2 text-sol-text-muted">
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Loading...
            </span>
          )}
        </div>
      )}
    </div>
  );
}
