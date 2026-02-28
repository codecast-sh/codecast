"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useMemo, useImperativeHandle, forwardRef, useCallback, memo } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isCommandMessage, getCommandType, cleanContent, cleanTitle, isSkillExpansion, extractSkillInfo } from "../lib/conversationProcessor";
import { createReducer, reducer } from "../lib/messageReducer";
import { UsageDisplay } from "./UsageDisplay";
import { toast } from "sonner";
import { CodeBlock } from "./CodeBlock";
import { useDiffViewerStore } from "../store/diffViewerStore";
import { extractFileChanges } from "../lib/fileChangeExtractor";
import { CommitCard } from "./CommitCard";
import { PRCard } from "./PRCard";
import { DiffView } from "./DiffView";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip";
import { useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { CommentPanel } from "./CommentPanel";
import { PermissionStack } from "./PermissionCard";
import { copyToClipboard } from "../lib/utils";
import { MarkdownRenderer, isMarkdownFile, isPlanFile, CollapsibleImage } from "./tools/MarkdownRenderer";
import { MessageSharePopover } from "./MessageSharePopover";
import { ConversationTree } from "./ConversationTree";
import { useInboxStore, type ForkChild } from "../store/inboxStore";
import { useNewSessionStore } from "../store/newSessionStore";
import { useForkNavigationStore } from "../store/forkNavigationStore";
import { buildCompositeTimeline } from "../lib/compositeTimeline";
import { useMessageSelection } from "../hooks/useMessageSelection";
import { useForkMessages } from "../hooks/useForkMessages";
import { BranchSelector } from "./BranchSelector";
import { ForkTreePanel } from "./ForkTreePanel";
import { getApplyPatchInput, parseApplyPatchSections } from "../lib/applyPatchParser";
import { setupDesktopDrag, desktopHeaderClass } from "../lib/desktop";

function parseSearchTerms(query: string): string[] {
  const terms: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    const term = match[1] || match[2];
    if (term) terms.push(term.toLowerCase());
  }
  return terms;
}

type ToolCall = {
  id: string;
  name: string;
  input: string;
};

type ToolResult = {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

type ImageData = {
  media_type: string;
  data?: string;
  storage_id?: string;
  tool_use_id?: string;
};

type Message = {
  _id: string;
  message_uuid?: string;
  role: string;
  content?: string;
  timestamp: number;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_results?: ToolResult[];
  images?: ImageData[];
  subtype?: string;
  _isOptimistic?: true;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export type ConversationData = {
  _id: Id<"conversations">;
  user_id?: string;
  title?: string;
  session_id?: string;
  agent_type?: string;
  model?: string;
  started_at?: number;
  updated_at?: number;
  share_token?: string;
  message_count?: number;
  messages: Message[];
  user?: { name?: string; email?: string; avatar_url?: string | null } | null;
  parent_conversation_id?: string | null;
  child_conversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>;
  child_conversation_map?: Record<string, string>;
  git_branch?: string | null;
  git_status?: string | null;
  git_diff?: string | null;
  git_diff_staged?: string | null;
  git_remote_url?: string | null;
  project_path?: string | null;
  git_root?: string | null;
  short_id?: string;
  status?: "active" | "completed";
  fork_count?: number;
  forked_from?: string;
  forked_from_details?: {
    conversation_id: string;
    share_token?: string;
    username: string;
  } | null;
  is_favorite?: boolean;
  draft_message?: string;
  compaction_count?: number;
  loaded_start_index?: number;
  agent_name_map?: Record<string, string>;
  fork_children?: Array<{
    _id: string;
    title: string;
    short_id?: string;
    started_at: number;
    username: string;
    parent_message_uuid?: string;
    message_count?: number;
    agent_type?: string;
  }>;
  main_message_counts_by_fork?: Record<string, number>;
};

type CommitFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

type Commit = {
  _id: string;
  sha: string;
  message: string;
  timestamp: number;
  files_changed: number;
  insertions: number;
  deletions: number;
  author_name: string;
  author_email: string;
  repository?: string;
  files?: CommitFile[];
};

type PRFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

type PullRequest = {
  _id: Id<"pull_requests">;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  repository: string;
  author_github_username: string;
  head_ref?: string;
  base_ref?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits_count?: number;
  files?: PRFile[];
  created_at: number;
  updated_at: number;
  merged_at?: number;
};

type ConversationViewProps = {
  conversation: ConversationData | null | undefined;
  commits?: Commit[];
  pullRequests?: PullRequest[];
  backHref: string;
  backLabel?: string;
  headerExtra?: React.ReactNode;
  hasMoreAbove?: boolean;
  hasMoreBelow?: boolean;
  isLoadingOlder?: boolean;
  isLoadingNewer?: boolean;
  onLoadOlder?: () => void;
  onLoadNewer?: () => void;
  onJumpToStart?: () => void;
  onJumpToEnd?: () => void;
  highlightQuery?: string;
  onClearHighlight?: () => void;
  embedded?: boolean;
  showMessageInput?: boolean;
  targetMessageId?: string;
  isOwner?: boolean;
  onSendAndAdvance?: () => void;
  autoFocusInput?: boolean;
  fallbackStickyContent?: string | null;
};

export interface ConversationViewHandle {
  scrollToMessage: (messageId: string) => void;
}

function ProjectSwitcher({ conversation }: { conversation: ConversationData }) {
  const switchProject = useMutation(api.conversations.switchSessionProject);
  const recentProjects = useQuery(api.users.getRecentProjectPaths, { limit: 8 });
  const updateSessionProject = useInboxStore((s) => s.updateSessionProject);
  const storeSession = useInboxStore((s) =>
    s.sessions.find((sess) => sess._id === conversation._id || sess.stableKey === conversation._id)
  );
  const openNewSession = useNewSessionStore((s) => s.open);

  const resolvedId = storeSession?._id || conversation._id;

  const currentPath = storeSession?.project_path || storeSession?.git_root || conversation.git_root || conversation.project_path;
  const currentName = currentPath?.split("/").filter(Boolean).pop() || "unknown";

  const otherProjects = useMemo(() => {
    if (!recentProjects) return [];
    return recentProjects.filter((p) => p.path !== currentPath);
  }, [recentProjects, currentPath]);

  const handleSwitch = useCallback(async (projectPath: string) => {
    const trimmed = projectPath.trim();
    if (!trimmed) return;
    let realId = useInboxStore.getState().getRealId(resolvedId);
    updateSessionProject(realId, trimmed);
    if (realId.startsWith("temp_")) {
      realId = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => { unsub(); reject(new Error("timeout")); }, 15000);
        const check = () => {
          const id = useInboxStore.getState().getRealId(resolvedId);
          if (!id.startsWith("temp_")) { clearTimeout(timeout); unsub(); resolve(id); }
        };
        check();
        const unsub = useInboxStore.subscribe(check);
      }).catch(() => resolvedId);
      if (!realId.startsWith("temp_")) {
        updateSessionProject(realId, trimmed);
      }
    }
    if (!realId.startsWith("temp_")) {
      useInboxStore.getState().patch("conversations", realId, { project_path: trimmed, git_root: trimmed });
      switchProject({ conversation_id: realId as Id<"conversations">, project_path: trimmed }).catch(() => {});
    }
  }, [switchProject, resolvedId, updateSessionProject]);

  return (
    <TooltipProvider delayDuration={200}>
    <div className="flex flex-col items-center gap-3 mt-16">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2 text-sol-text-muted text-xs cursor-default">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
              <span className="font-medium text-sol-text">{currentName}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs font-mono">
            {currentPath}
          </TooltipContent>
        </Tooltip>

      <div className="flex flex-wrap justify-center gap-1.5">
        {otherProjects.slice(0, 6).map((p) => {
          const name = p.path.split("/").filter(Boolean).pop();
          return (
            <Tooltip key={p.path}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => handleSwitch(p.path)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-cyan/40 hover:bg-sol-cyan/5 transition-all"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                  </svg>
                  <span>{name}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs font-mono">
                {p.path}
              </TooltipContent>
            </Tooltip>
          );
        })}
        <button
          onClick={() => openNewSession({ projectPath: currentPath || undefined })}
          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-dashed border-sol-border/50 text-sol-text-dim hover:text-sol-cyan hover:border-sol-cyan/40 hover:bg-sol-cyan/5 transition-all"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM12.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM18.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
          </svg>
          <span>other</span>
        </button>
      </div>

    </div>
    </TooltipProvider>
  );
}

function AgentSwitcher({ conversation }: { conversation: ConversationData }) {
  const switchAgent = useMutation(api.conversations.switchSessionAgent);
  const setCurrentConversation = useInboxStore((s) => s.setCurrentConversation);
  const storeSession = useInboxStore((s) =>
    s.sessions.find((sess) => sess._id === conversation._id || sess.stableKey === conversation._id)
  );
  const resolvedId = storeSession?._id || conversation._id;
  const currentPath = storeSession?.project_path || storeSession?.git_root || conversation.git_root || conversation.project_path;
  const currentAgent = storeSession?.agent_type || conversation.agent_type || "claude_code";

  const handleAgentSwitch = useCallback((agentType: "claude_code" | "codex" | "gemini") => {
    if (agentType === currentAgent) return;
    useInboxStore.getState().patchSession(resolvedId, { agent_type: agentType });
    setCurrentConversation({
      conversationId: resolvedId,
      projectPath: currentPath || undefined,
      gitRoot: currentPath || undefined,
      agentType,
      source: "inbox",
    });
    if (!resolvedId.startsWith("temp_")) {
      switchAgent({ conversation_id: resolvedId as Id<"conversations">, agent_type: agentType }).catch(() => {});
    }
  }, [switchAgent, resolvedId, currentAgent, currentPath, setCurrentConversation]);

  const agents = [
    { type: "claude_code" as const, label: "Claude" },
    { type: "codex" as const, label: "Codex" },
    { type: "gemini" as const, label: "Gemini" },
  ];

  return (
    <div className="flex items-center justify-center gap-1.5 px-4 pb-7">
      {agents.map((a) => {
        const isActive = currentAgent === a.type;
        return (
          <button
            key={a.type}
            onClick={() => handleAgentSwitch(a.type)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-all ${
              isActive
                ? a.type === "claude_code"
                  ? "bg-sol-yellow/15 text-sol-yellow border-sol-yellow/40"
                  : a.type === "codex"
                    ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/40"
                    : "bg-blue-500/15 text-blue-400 border-blue-500/40"
                : "border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border/60"
            }`}
          >
            <AgentTypeIcon agentType={a.type} />
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

function ConversationSkeleton() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-4 space-y-6 animate-pulse motion-reduce:animate-none">
      <div className="bg-sol-blue/10 border border-sol-blue/30 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded bg-sol-blue/30" />
          <div className="h-3 w-12 bg-sol-blue/30 rounded" />
          <div className="h-3 w-16 bg-sol-blue/20 rounded" />
        </div>
        <div className="pl-8 space-y-2">
          <div className="h-3 bg-sol-blue/20 rounded w-3/4" />
          <div className="h-3 bg-sol-blue/20 rounded w-1/2" />
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded bg-sol-yellow/60" />
          <div className="h-3 w-14 bg-sol-bg-alt rounded" />
          <div className="h-3 w-16 bg-sol-bg-alt rounded" />
        </div>
        <div className="pl-8 space-y-2">
          <div className="h-3 bg-sol-bg-alt rounded w-full" />
          <div className="h-3 bg-sol-bg-alt rounded w-5/6" />
          <div className="h-3 bg-sol-bg-alt rounded w-4/5" />
        </div>
      </div>

      <div className="bg-sol-blue/10 border border-sol-blue/30 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded bg-sol-blue/30" />
          <div className="h-3 w-12 bg-sol-blue/30 rounded" />
          <div className="h-3 w-16 bg-sol-blue/20 rounded" />
        </div>
        <div className="pl-8">
          <div className="h-3 bg-sol-blue/20 rounded w-2/3" />
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded bg-sol-yellow/60" />
          <div className="h-3 w-14 bg-sol-bg-alt rounded" />
          <div className="h-3 w-16 bg-sol-bg-alt rounded" />
        </div>
        <div className="pl-8 space-y-2">
          <div className="h-3 bg-sol-bg-alt rounded w-full" />
          <div className="h-3 bg-sol-bg-alt rounded w-11/12" />
          <div className="h-3 bg-sol-bg-alt rounded w-3/4" />
          <div className="h-3 bg-sol-bg-alt rounded w-5/6" />
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(startTs: number): string {
  const diff = Date.now() - startTs;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return remainMin ? `${hours}h ${remainMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function stripSystemTags(content: string): string {
  return content
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<\/?(?:command-(?:name|message|args)|antml:[a-z_]+)[^>]*>/g, '')
    .replace(/^\s*Caveat:.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

type ParsedApiError = {
  statusCode: number;
  message: string;
  errorType?: string;
  requestId?: string;
};

function parseApiErrorContent(content?: string | null): ParsedApiError | null {
  if (!content) return null;
  const trimmed = content.trim();
  const match = trimmed.match(/^API Error:\s*(\d{3})\s*([\s\S]*)$/i);
  if (!match) return null;

  const statusCode = Number(match[1]);
  const payloadText = (match[2] || "").trim();
  let message = "";
  let errorType: string | undefined;
  let requestId: string | undefined;

  if (payloadText.startsWith("{")) {
    try {
      const parsed = JSON.parse(payloadText) as Record<string, unknown>;
      if (typeof parsed.request_id === "string") {
        requestId = parsed.request_id;
      }

      const parsedError = parsed.error;
      if (parsedError && typeof parsedError === "object" && !Array.isArray(parsedError)) {
        const errorRecord = parsedError as Record<string, unknown>;
        if (typeof errorRecord.type === "string") {
          errorType = errorRecord.type;
        }
        if (typeof errorRecord.message === "string") {
          message = errorRecord.message;
        }
      }
    } catch {
      // Keep fallback values for non-JSON payloads.
    }
  }

  if (!requestId) {
    requestId = trimmed.match(/\b(req_[A-Za-z0-9]+)\b/)?.[1];
  }
  if (!message) {
    message = statusCode === 500 ? "Internal server error" : "API request failed";
  }

  return { statusCode, message, errorType, requestId };
}

function ApiErrorCard({ error, compact = false }: { error: ParsedApiError; compact?: boolean }) {
  const isServerError = error.statusCode >= 500;

  return (
    <div className={`rounded-lg border ${isServerError ? "border-sol-red/40 bg-sol-red/10" : "border-amber-500/30 bg-amber-500/10"} ${compact ? "px-2.5 py-2" : "px-3 py-2.5"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-semibold ${isServerError ? "bg-sol-red/20 text-sol-red" : "bg-amber-500/20 text-amber-500"}`}>
          !
        </span>
        <span className={`text-xs font-semibold uppercase tracking-wide ${isServerError ? "text-sol-red" : "text-amber-500"}`}>
          API Error
        </span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${isServerError ? "border-sol-red/40 bg-sol-red/10 text-sol-red" : "border-amber-500/40 bg-amber-500/10 text-amber-500"}`}>
          {error.statusCode}
        </span>
        {error.errorType && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-border/40 bg-sol-bg-alt/50 text-sol-text-dim font-mono">
            {error.errorType}
          </span>
        )}
      </div>
      <p className={`mt-1 text-sm ${isServerError ? "text-sol-red" : "text-amber-500"}`}>
        {error.message}
      </p>
      {error.requestId && (
        <p className="mt-1 text-[11px] text-sol-text-muted font-mono">
          request_id: <span className="text-sol-text-secondary">{error.requestId}</span>
        </p>
      )}
      {!compact && (
        <p className="mt-1 text-xs text-sol-text-dim">
          Provider-side failure. Retry the request; if it repeats, include the request ID.
        </p>
      )}
    </div>
  );
}

function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname;
    if (path === "/" || path === "") return host;
    return host + (path.length > 25 ? path.slice(0, 22) + "..." : path);
  } catch {
    return truncateStr(url, 40);
  }
}

function hasRichMarkdown(text: string): boolean {
  const markers = [
    /^#{1,3}\s+\S/m,           // headers
    /\|.+\|.+\|/,              // tables
    /^```\w*/m,                 // fenced code blocks
    /^\d+\.\s+\*\*[^*]+\*\*/m, // numbered list with bold
    /^-\s+\[[ x]\]/im,         // task lists
  ];
  let hits = 0;
  for (const m of markers) {
    if (m.test(text)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

const PLAN_PREFIXES = [
  /^implement\s+the\s+following\s+plan\s*:\s*/i,
  /^implement\s+this\s+plan\s*:\s*/i,
  /^here(?:'s| is)\s+the\s+plan\s*:\s*/i,
  /^plan\s*:\s*\n/i,
];

function extractPlanContent(text: string): string | null {
  const trimmed = text.trim();
  for (const prefix of PLAN_PREFIXES) {
    const match = trimmed.match(prefix);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      if (rest.length > 200 && hasRichMarkdown(rest)) {
        return rest;
      }
    }
  }
  return null;
}

type UserMessageKind =
  | { kind: 'normal' }
  | { kind: 'command' }
  | { kind: 'interrupt'; tone: 'sky' | 'amber' }
  | { kind: 'skill_expansion'; cmdName?: string }
  | { kind: 'task_notification' }
  | { kind: 'task_prompt' }
  | { kind: 'compaction_prompt' }
  | { kind: 'compaction_summary' }
  | { kind: 'plan'; planContent: string }
  | { kind: 'noise' }
  | { kind: 'tool_results_only' }
  | { kind: 'empty' };

const STICKY_NOISE_PREFIXES = ["[Request interrupted", "This session is being continued", "continue", "<task-notification>", "Your task is to create a detailed summary", "Please continue the conversation"];

function classifyUserMessage(
  msg: Message,
  agentType?: string,
  immediatePrev?: Message | null,
  contextPrev?: Message | null,
): UserMessageKind {
  if (msg.tool_results && msg.tool_results.length > 0 && (!msg.content || !msg.content.trim())) {
    return { kind: 'tool_results_only' };
  }
  const content = msg.content;
  if (!content || !content.trim()) {
    return msg.images?.length ? { kind: 'normal' } : { kind: 'empty' };
  }
  const t = content.trim();
  if (isCommandMessage(t)) return { kind: 'command' };
  if (agentType === "codex" && isCodexTurnAbortedMessage(t)) return { kind: 'interrupt', tone: 'amber' };
  if (isInterruptMessage(t)) return { kind: 'interrupt', tone: 'sky' };
  if (isSkillExpansion(t)) return { kind: 'skill_expansion' };
  if (isTaskNotification(t)) {
    const stripped = t.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '').trim();
    if (!stripped || stripped.length < 4 || stripped.startsWith('Read the output file to retrieve the result:')) return { kind: 'task_notification' };
  }
  if (immediatePrev?.role === 'assistant' && immediatePrev?.tool_calls?.some(tc => tc.name === 'Task')) {
    return { kind: 'task_prompt' };
  }
  if (isCompactionPromptMessage(t)) return { kind: 'compaction_prompt' };
  if (t.startsWith('Read the output file to retrieve the result:')) return { kind: 'noise' };
  if (immediatePrev?.role === 'user' && immediatePrev?.content && isCommandMessage(immediatePrev.content) && t.length > 200) {
    const cmdMatch = immediatePrev.content.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
    return { kind: 'skill_expansion', cmdName: cmdMatch?.[1]?.replace(/^\//, "") };
  }
  if (contextPrev?.role === 'system' && contextPrev?.subtype === 'compact_boundary') {
    return { kind: 'compaction_summary' };
  }
  const planContent = extractPlanContent(t);
  if (planContent) return { kind: 'plan', planContent };
  const displayable = t
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/\[Image\s+\/tmp\/codecast\/images\/[^\]]*\]/gi, '')
    .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, '')
    .replace(/\[image\]/gi, '')
    .trim();
  if (!displayable) {
    if (!immediatePrev && !contextPrev) return { kind: 'normal' };
    return msg.images?.length ? { kind: 'normal' } : { kind: 'noise' };
  }
  if (STICKY_NOISE_PREFIXES.some(p => displayable.startsWith(p))) {
    return { kind: 'noise' };
  }
  return { kind: 'normal' };
}

function isStickyWorthy(kind: UserMessageKind): boolean {
  return kind.kind === 'normal' || kind.kind === 'plan';
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatFullTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function stripLineNumbers(content: string): string {
  // Strip Claude Code's line number format: "   42→content" or "42→content"
  return content
    .split("\n")
    .map((line) => line.replace(/^\s*\d+→/, ""))
    .join("\n");
}

function ClaudeIcon() {
  return (
    <div className="w-6 h-6 rounded bg-sol-yellow flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" fill="white"/>
      </svg>
    </div>
  );
}

function CodexIcon() {
  return (
    <div className="w-6 h-6 rounded bg-[#0f0f0f] flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729z" fill="white"/>
      </svg>
    </div>
  );
}

function CursorIcon() {
  return (
    <div className="w-6 h-6 rounded bg-[#1a1a2e] flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 4l16 6-8 2-2 8z"/>
      </svg>
    </div>
  );
}

function GeminiIcon() {
  return (
    <div className="w-6 h-6 rounded bg-[#1a73e8] flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 28 28" fill="white" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 0C12 0 12 6.268 8.134 10.134C4.268 14 0 14 0 14C0 14 6.268 14 10.134 17.866C14 21.732 14 28 14 28C14 28 14 21.732 17.866 17.866C21.732 14 28 14 28 14C28 14 21.732 14 17.866 10.134C14 6.268 14 0 14 0" />
      </svg>
    </div>
  );
}

function AssistantIcon({ agentType }: { agentType?: string }) {
  if (agentType === "codex") return <CodexIcon />;
  if (agentType === "cursor") return <CursorIcon />;
  if (agentType === "gemini") return <GeminiIcon />;
  return <ClaudeIcon />;
}

function assistantLabel(agentType?: string): string {
  if (agentType === "codex") return "Codex";
  if (agentType === "cursor") return "Cursor";
  if (agentType === "gemini") return "Gemini";
  return "Claude";
}

function AgentTypeIcon({ agentType }: { agentType: string }) {
  if (agentType === "claude_code") {
    return (
      <svg className="w-3 h-3 text-amber-400" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
      </svg>
    );
  } else if (agentType === "codex") {
    return (
      <svg className="w-3 h-3 text-emerald-400" viewBox="0 0 24 24" fill="currentColor">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
      </svg>
    );
  } else if (agentType === "cursor") {
    return (
      <svg className="w-3 h-3 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 4l16 6-8 2-2 8z"/>
      </svg>
    );
  } else if (agentType === "gemini") {
    return (
      <svg className="w-3 h-3 text-blue-400" viewBox="0 0 28 28" fill="currentColor">
        <path d="M12 0C12 0 12 6.268 8.134 10.134C4.268 14 0 14 0 14C0 14 6.268 14 10.134 17.866C14 21.732 14 28 14 28C14 28 14 21.732 17.866 17.866C21.732 14 28 14 28 14C28 14 21.732 14 17.866 10.134C14 6.268 14 0 14 0" />
      </svg>
    );
  }
  return null;
}

function formatAgentType(agentType?: string): string {
  if (!agentType) return "Unknown";
  if (agentType === "claude_code") return "Claude Code";
  if (agentType === "codex") return "Codex";
  if (agentType === "cursor") return "Cursor";
  if (agentType === "gemini") return "Gemini";
  return agentType;
}

function formatModel(model?: string): string {
  if (!model) return "";
  // Shorten long model names
  if (model.includes("claude-sonnet")) {
    return model.replace("claude-sonnet-", "sonnet-").replace("-20", "-'");
  }
  if (model.includes("claude-opus")) {
    return model.replace("claude-opus-", "opus-").replace("-20", "-'");
  }
  if (model.includes("claude-haiku")) {
    return model.replace("claude-haiku-", "haiku-").replace("-20", "-'");
  }
  return model;
}

function ConversationMetadata({
  agentType,
  model,
  startedAt,
  messageCount,
  shortId,
  conversationId,
}: {
  agentType?: string;
  model?: string;
  startedAt?: number;
  messageCount?: number;
  shortId?: string;
  conversationId?: string;
}) {
  if (!agentType && !model && !startedAt && !messageCount) return null;

  return (
    <div className="flex items-center gap-1.5 sm:gap-2 md:gap-3 text-[10px] sm:text-xs text-sol-text-dim flex-wrap">
      {agentType && (
        <div
          className="flex items-center flex-shrink-0 cursor-default"
          title={formatAgentType(agentType)}
        >
          <AgentTypeIcon agentType={agentType} />
        </div>
      )}
      {model && (
        <div className="hidden sm:flex items-center gap-1 flex-shrink-0">
          <span className="text-sol-text-dim">&middot;</span>
          <span className="font-mono truncate max-w-none" title={model}>{formatModel(model)}</span>
        </div>
      )}
      {startedAt && (
        <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
          <span className="text-sol-text-dim hidden sm:inline">&middot;</span>
          <span title={formatFullTimestamp(startedAt)}>{formatRelativeTime(startedAt)}</span>
        </div>
      )}
      {messageCount !== undefined && messageCount > 0 && (
        <button
          className="hidden sm:flex items-center gap-1 flex-shrink-0 hover:text-sol-text-muted transition-colors cursor-pointer"
          title="Copy conversation ID"
          onClick={() => { if (conversationId) setTimeout(() => { copyToClipboard(conversationId).then(() => toast.success("ID copied")); }); }}
        >
          <span className="text-sol-text-dim">&middot;</span>
          <span>{messageCount} {messageCount === 1 ? "msg" : "msgs"}</span>
        </button>
      )}
      {startedAt && (
        <div className="hidden sm:flex items-center gap-1 flex-shrink-0">
          <span className="text-sol-text-dim">&middot;</span>
          <span>{formatDuration(startedAt)}</span>
        </div>
      )}
    </div>
  );
}

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean; totalLines: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { text, truncated: false, totalLines: lines.length };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
    totalLines: lines.length,
  };
}


function findMatchingChild(
  prompt: string,
  childConversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>,
): string | undefined {
  if (!childConversations || !prompt) return undefined;
  const subagents = childConversations.filter(c => c.is_subagent && c.first_message_preview);
  if (subagents.length === 0) return undefined;

  const promptStart = prompt.slice(0, 100).toLowerCase().trim();

  for (const child of subagents) {
    const preview = child.first_message_preview!.slice(0, 100).toLowerCase().trim();
    if (promptStart === preview || promptStart.startsWith(preview) || preview.startsWith(promptStart)) {
      return child._id;
    }
  }
  return undefined;
}

function parseSpawnResult(content: string): { agentName?: string; teamName?: string; agentId?: string } | null {
  if (!content.startsWith("Spawned successfully")) return null;
  const lines = content.split("\n");
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) fields[m[1]] = m[2].trim();
  }
  return { agentName: fields.name, teamName: fields.team_name, agentId: fields.agent_id };
}

function TaskToolBlock({ tool, result, childConversationId, childConversations }: { tool: ToolCall; result?: ToolResult; childConversationId?: string; childConversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }> }) {
  const isCompleted = !!result;
  const [expanded, setExpanded] = useState(false);

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const subagentType = String(parsedInput.subagent_type || "unknown");
  const description = String(parsedInput.description || "");
  const prompt = String(parsedInput.prompt || "");
  const model = parsedInput.model ? String(parsedInput.model) : null;
  const name = parsedInput.name ? String(parsedInput.name) : null;
  const runInBackground = Boolean(parsedInput.run_in_background);

  const resolvedChildId = childConversationId || findMatchingChild(prompt, childConversations);

  const subagentColors: Record<string, { bg: string; border: string; text: string }> = {
    Explore: { bg: "bg-sol-green/20", border: "border-sol-green/50", text: "text-sol-green" },
    Plan: { bg: "bg-sol-blue/20", border: "border-sol-blue/50", text: "text-sol-blue" },
    implementor: { bg: "bg-sol-orange/20", border: "border-sol-orange/50", text: "text-sol-orange" },
    "general-purpose": { bg: "bg-sol-bg-alt/60", border: "border-sol-border/50", text: "text-sol-text-secondary" },
    "claude-code-guide": { bg: "bg-sol-violet/20", border: "border-sol-violet/50", text: "text-sol-violet" },
    "code-reviewer": { bg: "bg-sol-red/20", border: "border-sol-red/50", text: "text-sol-red" },
    "code-explorer": { bg: "bg-sol-cyan/20", border: "border-sol-cyan/50", text: "text-sol-cyan" },
    "code-architect": { bg: "bg-sol-magenta/20", border: "border-sol-magenta/50", text: "text-sol-magenta" },
    "code-simplifier": { bg: "bg-sol-cyan/20", border: "border-sol-cyan/50", text: "text-sol-cyan" },
  };

  const colors = subagentColors[subagentType] || { bg: "bg-sol-bg-alt/60", border: "border-sol-border/50", text: "text-sol-text-muted" };

  const spawnInfo = result?.content ? parseSpawnResult(result.content) : null;

  const resultSummary = result?.content && !spawnInfo
    ? result.content.length > 200 ? result.content.slice(0, 200) + "..." : result.content
    : null;

  if (isCompleted && spawnInfo) {
    return (
      <div className="my-0.5">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-emerald-400 text-[10px]">{"\u2713"}</span>
          <span className={`font-mono text-xs ${colors.text}`}>Task</span>
          <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${colors.bg} border ${colors.border} ${colors.text}`}>
            {subagentType}
          </span>
          {(spawnInfo.agentName || name) && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 font-mono">
              @{spawnInfo.agentName || name}
            </span>
          )}
          {description && <span className="text-sol-text-dim truncate flex-1">{description}</span>}
          {resolvedChildId && (
            <Link
              href={`/conversation/${resolvedChildId}`}
              onClick={(e) => e.stopPropagation()}
              className="text-sol-cyan hover:text-sol-cyan text-[10px] font-medium underline underline-offset-2"
            >
              view
            </Link>
          )}
        </div>
      </div>
    );
  }

  if (isCompleted) {
    return (
      <div className={`my-3 rounded-lg ${result?.is_error ? "bg-sol-red/10 border-sol-red/30" : `${colors.bg} ${colors.border}`} border overflow-hidden`}>
        <div
          className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-sol-bg-highlight/50 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className={`text-[10px] ${result?.is_error ? "text-sol-red" : "text-emerald-400"}`}>
            {result?.is_error ? "\u2717" : "\u2713"}
          </span>
          <span className={`font-mono text-xs font-medium ${result?.is_error ? "text-sol-red" : colors.text}`}>
            Task
          </span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors.bg} border ${colors.border} ${colors.text}`}>
            {subagentType}
          </span>
          {description && (
            <span className="text-sol-text-muted text-xs truncate flex-1">
              {description}
            </span>
          )}
          {resolvedChildId && (
            <Link
              href={`/conversation/${resolvedChildId}`}
              onClick={(e) => e.stopPropagation()}
              className="text-sol-cyan hover:text-sol-cyan text-[10px] font-medium underline underline-offset-2"
            >
              view
            </Link>
          )}
          <span className="text-sol-text-dim text-[10px] ml-auto">
            {expanded ? "collapse" : "expand"}
          </span>
        </div>

        {resultSummary && !expanded && (
          <div className="px-3 pb-2">
            <pre className={`text-xs font-mono whitespace-pre-wrap break-words leading-relaxed ${
              result?.is_error ? "text-sol-red/80" : "text-sol-text-secondary"
            }`}>
              {resultSummary}
            </pre>
          </div>
        )}

        {expanded && (
          <>
            <div className="border-t border-sol-border/30 px-3 py-2">
              <div className="text-[10px] text-sol-text-dim mb-1">Prompt</div>
              <div className="text-sol-text-dim text-xs font-mono whitespace-pre-wrap break-words leading-relaxed max-h-40 overflow-y-auto">
                {prompt}
              </div>
            </div>
            {result && (
              <div className="border-t border-sol-border/30 px-3 py-2">
                <div className="text-[10px] text-sol-text-dim mb-1">Result</div>
                <pre className={`text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto ${
                  result.is_error ? "text-sol-red" : "text-sol-text-secondary"
                }`}>
                  {result.content}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  const truncatedPrompt = prompt.length > 300 && !expanded ? prompt.slice(0, 300) + "..." : prompt;

  return (
    <div className={`my-3 rounded-lg ${colors.bg} border ${colors.border} overflow-hidden`}>
      <div
        className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-sol-bg-highlight/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin ${colors.text} opacity-60`} />
        <span className={`font-mono text-xs font-semibold ${colors.text}`}>
          Task
        </span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors.bg} border ${colors.border} ${colors.text}`}>
          {subagentType}
        </span>
        {description && (
          <span className="text-sol-text-muted text-xs truncate flex-1">
            {description}
          </span>
        )}
        {model && (
          <span className="text-sol-text-dim text-[10px] font-mono">
            {formatModel(model)}
          </span>
        )}
        {name && (
          <span className="text-sol-text-dim text-[10px] font-mono">
            {name}
          </span>
        )}
        {runInBackground && (
          <span className="text-sol-text-dim text-[10px]">background</span>
        )}
        {resolvedChildId && (
          <Link
            href={`/conversation/${resolvedChildId}`}
            onClick={(e) => e.stopPropagation()}
            className="text-sol-cyan hover:text-sol-cyan text-[10px] font-medium underline underline-offset-2"
          >
            view
          </Link>
        )}
        <span className="text-sol-text-dim text-[10px] ml-auto">
          {expanded ? "collapse" : "expand"}
        </span>
      </div>

      <div className="px-3 pb-2">
        <div className="text-sol-text-secondary text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
          {truncatedPrompt}
        </div>
        {prompt.length > 300 && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="text-[10px] text-sol-text-dim hover:text-sol-text-muted mt-1"
          >
            show more
          </button>
        )}
      </div>
    </div>
  );
}

function getFileExtension(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    cpp: "cpp", c: "c", h: "c", hpp: "cpp", cs: "csharp",
    json: "json", yaml: "yaml", yml: "yaml", md: "markdown",
    html: "html", css: "css", scss: "scss", sql: "sql",
    sh: "bash", bash: "bash", zsh: "bash", swift: "swift", kt: "kotlin",
  };
  return ext ? langMap[ext] : undefined;
}

function getRelativePath(fullPath: string): string {
  // Try to extract relative path from common patterns
  // /Users/*/src/project/path -> project/path
  // /home/*/projects/project/path -> project/path
  const patterns = [
    /\/Users\/[^/]+\/src\/(.+)$/,
    /\/Users\/[^/]+\/(.+)$/,
    /\/home\/[^/]+\/(?:src|projects|code)\/(.+)$/,
    /\/home\/[^/]+\/(.+)$/,
  ];
  for (const pattern of patterns) {
    const match = fullPath.match(pattern);
    if (match) return match[1];
  }
  // Fallback: show last 3 path components
  const parts = fullPath.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}

const mcpToolNames: Record<string, string> = {
  "mcp__claude-in-chrome__computer": "Browser",
  "mcp__claude-in-chrome__navigate": "Navigate",
  "mcp__claude-in-chrome__read_page": "Read Page",
  "mcp__claude-in-chrome__find": "Find",
  "mcp__claude-in-chrome__form_input": "Form",
  "mcp__claude-in-chrome__javascript_tool": "JS",
  "mcp__claude-in-chrome__tabs_context_mcp": "Tabs",
  "mcp__claude-in-chrome__tabs_create_mcp": "New Tab",
  "mcp__claude-in-chrome__update_plan": "Plan",
  "mcp__claude-in-chrome__gif_creator": "GIF",
  "mcp__claude-in-chrome__read_console_messages": "Console",
  "mcp__claude-in-chrome__read_network_requests": "Network",
  "mcp__claude-in-chrome__get_page_text": "Page Text",
  "mcp__claude-in-chrome__upload_image": "Upload",
  "mcp__claude-in-chrome__resize_window": "Resize",
  "mcp__claude-in-chrome__shortcuts_list": "Shortcuts",
  "mcp__claude-in-chrome__shortcuts_execute": "Shortcut",
};

const codexToolNames: Record<string, string> = {
  shell_command: "Terminal",
  shell: "Terminal",
  exec_command: "Terminal",
  "container.exec": "Terminal",
  apply_patch: "Patch",
  file_read: "Read",
  file_write: "Write",
  file_edit: "Edit",
  web_search: "Search",
  web_fetch: "Fetch",
  code_search: "Search",
  code_analysis: "Analyze",
};

function formatToolName(name: string): string {
  if (mcpToolNames[name]) return mcpToolNames[name];
  if (codexToolNames[name]) return codexToolNames[name];
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const method = parts[2] || parts[1] || "MCP";
    return method.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).slice(0, 12);
  }
  return name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function isPlanWriteToolCall(tc: ToolCall): boolean {
  if (tc.name !== "Write") return false;
  try {
    const parsed = JSON.parse(tc.input);
    return String(parsed.file_path || "").includes('.claude/plans/');
  } catch {
    return false;
  }
}

interface ToolChangeRange {
  start: number;
  end: number;
}

interface ToolCallChangeSelection {
  index: number;
  range: ToolChangeRange;
}

function ToolBlock({ tool, result, changeIndex, changeRange, shareSelectionMode, messageId, conversationId, onStartShareSelection, onOpenComments, collapsed, timestamp, images, globalImageMap }: { tool: ToolCall; result?: ToolResult; changeIndex?: number; changeRange?: ToolChangeRange; shareSelectionMode?: boolean; messageId?: string; conversationId?: Id<"conversations">; onStartShareSelection?: (messageId: string) => void; onOpenComments?: () => void; collapsed?: boolean; timestamp?: number; images?: ImageData[]; globalImageMap?: Record<string, ImageData> }) {
  const isApplyPatch = tool.name === "apply_patch";
  const isStandardEdit = tool.name === "Edit" || tool.name === "Write" || tool.name === "file_edit" || tool.name === "file_write";
  const isEdit = isStandardEdit || isApplyPatch;
  const [expanded, setExpanded] = useState(isEdit);
  const isRead = tool.name === "Read" || tool.name === "file_read";
  const isCodexShell = tool.name === "shell_command" || tool.name === "shell" || tool.name === "exec_command" || tool.name === "container.exec";
  const isBash = tool.name === "Bash" || isCodexShell;
  const isGlob = tool.name === "Glob";
  const isGrep = tool.name === "Grep";
  const isCodeSearch = tool.name === "code_search" || tool.name === "code_analysis";

  const { selectedChangeIndex, rangeStart, rangeEnd, selectChange, selectRange } = useDiffViewerStore();

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}
  const rawToolInput = tool.input || "";

  const filePath = String(parsedInput.file_path || "");
  const relativePath = getRelativePath(filePath);
  const language = getFileExtension(filePath);
  const applyPatchInput = tool.name === "apply_patch" ? getApplyPatchInput(rawToolInput) : "";
  const applyPatchDiffs = useMemo(
    () => (tool.name === "apply_patch" ? parseApplyPatchSections(applyPatchInput) : []),
    [tool.name, applyPatchInput],
  );

  // Markdown file detection
  const isMarkdown = isMarkdownFile(filePath);
  const content = isRead ? (result?.content || "") : String(parsedInput.content || "");
  const isPlan = isMarkdown && isPlanFile(filePath, content);
  const isPlanWrite = tool.name === "Write" && filePath.includes('.claude/plans/');
  const [viewMode, setViewMode] = useState<'raw' | 'rendered'>(isMarkdown ? 'rendered' : 'raw');
  const [mdExpanded, setMdExpanded] = useState(false);
  const [mdFullscreen, setMdFullscreen] = useState(false);
  const mdContainerRef = useRef<HTMLDivElement>(null);
  const [mdOverflowing, setMdOverflowing] = useState(false);
  const MD_COLLAPSED_HEIGHT = 600;

  useEffect(() => {
    if (mdContainerRef.current && !mdExpanded && viewMode === 'rendered') {
      requestAnimationFrame(() => {
        if (mdContainerRef.current) {
          setMdOverflowing(mdContainerRef.current.scrollHeight > MD_COLLAPSED_HEIGHT);
        }
      });
    }
  }, [content, mdExpanded, viewMode, expanded]);

  useEffect(() => {
    if (!mdFullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMdFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [mdFullscreen]);

  const getToolSummary = () => {
    if (isStandardEdit || isRead) return relativePath;
    if (isBash) {
      const cmd = String(parsedInput.command || parsedInput.cmd || "");
      if (cmd) return cmd.length > 100 ? cmd.slice(0, 100) + "..." : cmd;
    }
    if (isGlob && parsedInput.pattern) return String(parsedInput.pattern);
    if (isGrep && parsedInput.pattern) return String(parsedInput.pattern);
    if (isCodeSearch && parsedInput.query) return truncateStr(String(parsedInput.query), 40);

    if (tool.name === "apply_patch") {
      if (applyPatchDiffs.length > 0) {
        const firstPath = getRelativePath(applyPatchDiffs[0].filePath);
        return applyPatchDiffs.length > 1 ? `${firstPath} (+${applyPatchDiffs.length - 1})` : firstPath;
      }
      const fileMatch = applyPatchInput.match(/\*\*\* (?:Update|Add|Delete) File:\s+(.+)/);
      if (fileMatch) return getRelativePath(fileMatch[1].trim());
      return "Apply patch";
    }
    if (tool.name === "file_read" || tool.name === "file_write" || tool.name === "file_edit") {
      return getRelativePath(String(parsedInput.file_path || parsedInput.path || ""));
    }

    if (tool.name === "mcp__claude-in-chrome__computer") {
      const action = String(parsedInput.action || "");
      if (action === "screenshot") return "Screenshot";
      if (action === "left_click") {
        const coord = parsedInput.coordinate as number[] | undefined;
        return coord ? `Click (${coord[0]}, ${coord[1]})` : "Click";
      }
      if (action === "type") return `Type "${truncateStr(String(parsedInput.text || ""), 20)}"`;
      if (action === "key") return `Key: ${String(parsedInput.text || "")}`;
      if (action === "scroll") return `Scroll ${String(parsedInput.scroll_direction || "")}`;
      if (action === "wait") return `Wait ${String(parsedInput.duration || "")}s`;
      return action || "Browser";
    }
    if (tool.name === "mcp__claude-in-chrome__navigate") {
      const url = String(parsedInput.url || "");
      if (url === "back") return "Back";
      if (url === "forward") return "Forward";
      return url ? shortenUrl(url) : "Navigate";
    }
    if (tool.name === "mcp__claude-in-chrome__read_page") {
      if (parsedInput.ref_id) return `Element ${String(parsedInput.ref_id)}`;
      if (parsedInput.filter === "interactive") return "Interactive elements";
      return "Page content";
    }
    if (tool.name === "mcp__claude-in-chrome__find") {
      return parsedInput.query ? `"${truncateStr(String(parsedInput.query), 30)}"` : "Find";
    }
    if (tool.name === "mcp__claude-in-chrome__form_input") {
      const ref = parsedInput.ref ? String(parsedInput.ref) : "";
      const val = parsedInput.value;
      if (ref && val !== undefined) return `${ref} = "${truncateStr(String(val), 20)}"`;
      return "Set form";
    }
    if (tool.name === "mcp__claude-in-chrome__javascript_tool") {
      return parsedInput.text ? truncateStr(String(parsedInput.text), 40) : "Execute JS";
    }
    if (tool.name === "mcp__claude-in-chrome__tabs_context_mcp") return "Get tabs";
    if (tool.name === "mcp__claude-in-chrome__tabs_create_mcp") return "Create tab";
    if (tool.name === "mcp__claude-in-chrome__update_plan") {
      const domains = parsedInput.domains as string[] | undefined;
      if (Array.isArray(domains) && domains.length) {
        return domains.slice(0, 2).join(", ") + (domains.length > 2 ? "..." : "");
      }
      return "Plan";
    }
    if (tool.name === "mcp__claude-in-chrome__gif_creator") return String(parsedInput.action || "Record");
    if (tool.name === "mcp__claude-in-chrome__read_console_messages") {
      return parsedInput.pattern ? `Filter: ${String(parsedInput.pattern)}` : "Console";
    }
    if (tool.name === "mcp__claude-in-chrome__read_network_requests") {
      return parsedInput.urlPattern ? `Filter: ${String(parsedInput.urlPattern)}` : "Network";
    }
    if (tool.name === "mcp__claude-in-chrome__get_page_text") return "Extract text";
    if (tool.name === "mcp__claude-in-chrome__upload_image") return parsedInput.filename ? String(parsedInput.filename) : "Upload";
    if (tool.name === "mcp__claude-in-chrome__resize_window") return parsedInput.width && parsedInput.height ? `${parsedInput.width}x${parsedInput.height}` : "Resize";
    if (tool.name === "mcp__claude-in-chrome__shortcuts_list") return "List shortcuts";
    if (tool.name === "mcp__claude-in-chrome__shortcuts_execute") return parsedInput.command ? `/${String(parsedInput.command)}` : "Shortcut";

    if (tool.name === "TaskCreate") return parsedInput.subject ? truncateStr(String(parsedInput.subject), 50) : "New task";
    if (tool.name === "TaskUpdate") {
      const id = parsedInput.taskId ? `#${parsedInput.taskId}` : "";
      const status = parsedInput.status ? String(parsedInput.status) : "";
      if (id && status) return `${id} \u2192 ${status}`;
      return id || "Update task";
    }
    if (tool.name === "TaskList") {
      if (result) {
        const lines = result.content.split("\n").filter((l: string) => l.match(/#\d+\s+\[/));
        if (lines.length > 0) return `${lines.length} tasks`;
      }
      return "Tasks";
    }
    if (tool.name === "TaskGet") return parsedInput.taskId ? `#${parsedInput.taskId}` : "Get task";
    if (tool.name === "TeamCreate") return parsedInput.team_name ? String(parsedInput.team_name) : "New team";
    if (tool.name === "TeamDelete") return "Cleanup";
    if (tool.name === "SendMessage") {
      if (parsedInput.summary) return truncateStr(String(parsedInput.summary), 40);
      if (parsedInput.recipient) return `to ${String(parsedInput.recipient)}`;
      if (parsedInput.type === "broadcast") return "broadcast";
      return "Message";
    }

    if (tool.name === "WebSearch" || tool.name === "web_search") return parsedInput.query ? truncateStr(String(parsedInput.query), 40) : "Search";
    if (tool.name === "WebFetch" || tool.name === "web_fetch") return parsedInput.url ? shortenUrl(String(parsedInput.url)) : "Fetch";
    if (tool.name === "NotebookEdit") return parsedInput.notebook_path ? getRelativePath(String(parsedInput.notebook_path)) : "Notebook";
    if (tool.name === "Skill") return parsedInput.skill ? `/${String(parsedInput.skill)}` : "Skill";
    if (tool.name === "EnterPlanMode") return "Plan mode";
    if (tool.name === "ExitPlanMode") return "Exit plan";
    if (tool.name === "TaskOutput") return parsedInput.task_id ? `task ${String(parsedInput.task_id).slice(0, 8)}` : "Output";
    if (tool.name === "TaskStop") return parsedInput.task_id ? `stop ${String(parsedInput.task_id).slice(0, 8)}` : "Stop";
    if (tool.name === "TodoWrite") {
      const todos = parsedInput.todos as any[];
      return `${todos?.length || 0} tasks`;
    }
    if (tool.name === "AskUserQuestion") {
      const questions = parsedInput.questions as any[];
      return questions?.[0]?.question ? truncateStr(String(questions[0].question), 50) : "Question";
    }

    if (tool.name.startsWith("mcp__")) {
      const parts = tool.name.split("__");
      const method = parts[2] || "";
      const displayMethod = method.replace(/_/g, " ");
      if (parsedInput.url) return shortenUrl(String(parsedInput.url));
      if (parsedInput.query) return truncateStr(String(parsedInput.query), 30);
      return displayMethod || parts[1] || "MCP";
    }

    return null;
  };

  const getResultSummary = () => {
    if (!result) return null;
    if (result.is_error) return "(error)";
    if (isEdit) {
      const match = result.content.match(/with (\d+) additions? and (\d+) removals?/);
      if (match) return `(+${match[1]} -${match[2]})`;
      return result.content.includes("has been updated") ? "(ok)" : "";
    }
    if (isRead) {
      const lines = result.content.split("\n").length;
      return `(${lines} lines)`;
    }
    if (isGlob || isGrep || isCodeSearch) {
      const lines = result.content.trim().split("\n").filter(l => l.trim()).length;
      return `(${lines} matches)`;
    }
    if (isBash && result.content) {
      const lines = result.content.trim().split("\n").length;
      if (lines > 1) return `(${lines} lines)`;
    }
    if (tool.name === "TaskList") {
      const taskLines = result.content.split("\n").filter((l: string) => l.match(/#\d+\s+\[/));
      if (taskLines.length > 0) return `(${taskLines.length} tasks)`;
    }
    return null;
  };

  const summary = getToolSummary();
  const resultSummary = getResultSummary();

  const executedTabUrl = useMemo(() => {
    if (!result?.content || !tool.name.startsWith("mcp__claude-in-chrome__")) return null;
    const tabIdMatch = result.content.match(/Executed on tabId:\s*(\d+)/);
    if (!tabIdMatch) return null;
    return `https://clau.de/chrome/tab/${tabIdMatch[1]}`;
  }, [result?.content, tool.name]);

  // Process result content - strip line numbers for Read tool, strip Tab Context from MCP chrome results
  const processedContent = result ? (isRead ? stripLineNumbers(result.content) : tool.name.startsWith("mcp__claude-in-chrome__") ? result.content.replace(/\n?\n?Tab Context:[\s\S]*$/, "").trim() : result.content) : "";

  const isCodeTool = isBash || isEdit || isRead || isGlob || isGrep || isCodeSearch;
  const isMarkdownResult = result && !isCodeTool && typeof processedContent === 'string' && (
    processedContent.includes('###') || processedContent.includes('**') || processedContent.includes('```')
  );

  // Extract starting line number from Edit result (format: "   42→content")
  const getStartLine = () => {
    if (!isStandardEdit || !result) return 1;
    const match = result.content.match(/^\s*(\d+)→/m);
    return match ? parseInt(match[1], 10) : 1;
  };
  const startLine = getStartLine();

  const toolColors: Record<string, string> = {
    Edit: "text-sol-orange/80",
    Write: "text-sol-orange/80",
    Read: "text-sol-blue/80",
    Bash: "text-sol-green/80",
    Glob: "text-sol-violet/80",
    Grep: "text-sol-violet/80",
    Task: "text-sol-cyan/80",
    TaskCreate: "text-emerald-500/80",
    TaskUpdate: "text-emerald-500/80",
    TaskList: "text-emerald-500/80",
    TaskGet: "text-emerald-500/80",
    TaskOutput: "text-emerald-500/80",
    TaskStop: "text-emerald-500/80",
    AskUserQuestion: "text-sol-blue/80",
    TeamCreate: "text-sol-cyan/80",
    TeamDelete: "text-sol-cyan/80",
    SendMessage: "text-amber-500/80",
    TodoWrite: "text-sol-magenta/80",
    WebSearch: "text-sol-violet/80",
    WebFetch: "text-sol-cyan/80",
    NotebookEdit: "text-sol-orange/80",
    Skill: "text-sol-cyan/80",
    EnterPlanMode: "text-sol-violet/80",
    ExitPlanMode: "text-sol-violet/80",
    "mcp__claude-in-chrome__computer": "text-sol-orange/80",
    "mcp__claude-in-chrome__navigate": "text-sol-blue/80",
    "mcp__claude-in-chrome__read_page": "text-sol-blue/80",
    "mcp__claude-in-chrome__find": "text-sol-violet/80",
    "mcp__claude-in-chrome__form_input": "text-sol-orange/80",
    "mcp__claude-in-chrome__javascript_tool": "text-sol-orange/80",
    "mcp__claude-in-chrome__tabs_context_mcp": "text-sol-text-dim",
    "mcp__claude-in-chrome__tabs_create_mcp": "text-sol-text-dim",
    "mcp__claude-in-chrome__update_plan": "text-sol-cyan/80",
    "mcp__claude-in-chrome__gif_creator": "text-sol-magenta/80",
    "mcp__claude-in-chrome__read_console_messages": "text-sol-green/80",
    "mcp__claude-in-chrome__read_network_requests": "text-sol-green/80",
    "mcp__claude-in-chrome__get_page_text": "text-sol-blue/80",
    "mcp__claude-in-chrome__upload_image": "text-sol-blue/80",
    "mcp__claude-in-chrome__resize_window": "text-sol-text-dim",
    "mcp__claude-in-chrome__shortcuts_list": "text-sol-violet/80",
    "mcp__claude-in-chrome__shortcuts_execute": "text-sol-violet/80",
  };

  const codexToolColors: Record<string, string> = {
    shell_command: "text-sol-green/80",
    shell: "text-sol-green/80",
    exec_command: "text-sol-green/80",
    "container.exec": "text-sol-green/80",
    apply_patch: "text-sol-orange/80",
    file_read: "text-sol-blue/80",
    file_write: "text-sol-orange/80",
    file_edit: "text-sol-orange/80",
    web_search: "text-sol-violet/80",
    web_fetch: "text-sol-cyan/80",
    code_search: "text-sol-violet/80",
    code_analysis: "text-sol-violet/80",
  };

  const getMcpColor = (name: string) => {
    if (codexToolColors[name]) return codexToolColors[name];
    if (name.startsWith("mcp__")) return "text-sol-cyan/80";
    return "text-sol-text-dim";
  };

  const toolColor = toolColors[tool.name] || getMcpColor(tool.name);

  const targetStart = changeRange?.start ?? changeIndex;
  const targetEnd = changeRange?.end ?? changeIndex;
  const hasTargetRange = targetStart !== undefined && targetEnd !== undefined;
  const isClickable = isEdit && hasTargetRange;
  const isSelected = isClickable && (
    (selectedChangeIndex !== null &&
      targetStart !== undefined &&
      targetEnd !== undefined &&
      selectedChangeIndex >= targetStart &&
      selectedChangeIndex <= targetEnd) ||
    (rangeStart !== null &&
      rangeEnd !== null &&
      targetStart !== undefined &&
      targetEnd !== undefined &&
      Math.max(rangeStart, targetStart) <= Math.min(rangeEnd, targetEnd))
  );

  const handleClick = (e: React.MouseEvent) => {
    if (shareSelectionMode) {
      return;
    }
    if (isClickable && targetStart !== undefined && targetEnd !== undefined) {
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey) {
        if (selectedChangeIndex !== null) {
          selectRange(selectedChangeIndex, targetEnd);
        } else {
          selectRange(targetStart, targetEnd);
        }
      } else {
        if (targetStart !== targetEnd) {
          selectRange(targetStart, targetEnd);
        } else {
          selectChange(targetStart);
        }
      }
    } else {
      setExpanded(!expanded);
    }
  };

  if (isPlanWrite && content) {
    return <PlanBlock content={content} timestamp={timestamp || Date.now()} collapsed={collapsed} messageId={messageId} conversationId={conversationId} onOpenComments={onOpenComments} onStartShareSelection={onStartShareSelection} />;
  }

  const isCodecastImageRead = isRead && /codecast\/images\//.test(filePath);
  if (isCodecastImageRead) {
    return (
      <div className="my-0.5 flex items-center gap-1.5 text-xs">
        <svg className="w-3.5 h-3.5 text-sol-blue/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.64 0 8.577 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.64 0-8.577-3.007-9.963-7.178z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span className="text-sol-text-dim italic">Viewing your image</span>
      </div>
    );
  }

  return (
    <div className="my-0.5">
      <div
        className={`flex items-center gap-1.5 group text-xs ${
          isClickable
            ? 'cursor-pointer hover:bg-sol-bg-highlight/30 rounded px-1 -mx-1 transition-colors'
            : 'cursor-pointer'
        } ${
          isSelected
            ? 'bg-sol-blue/10 border border-sol-blue/30 rounded px-1 -mx-1'
            : ''
        }`}
        onClick={handleClick}
      >
        <span className={`font-mono ${toolColor}`}>{formatToolName(tool.name)}</span>
        {summary && (
          <span className="text-sol-text-muted font-mono truncate min-w-0">{summary}</span>
        )}
        {executedTabUrl && (
          <a
            href={executedTabUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sol-cyan/60 hover:text-sol-cyan transition-colors flex-shrink-0"
            onClick={(e) => e.stopPropagation()}
            title={executedTabUrl}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        )}
        {resultSummary && (
          <span className={`font-mono ${result?.is_error ? "text-sol-red/80" : "text-sol-text-dim"}`}>
            {resultSummary}
          </span>
        )}
      </div>

      {(() => {
        const toolImage = images?.find(img => img.tool_use_id === tool.id) || globalImageMap?.[tool.id];
        return toolImage ? <ImageBlock image={toolImage} /> : null;
      })()}

      {expanded && (
        <div className="mt-1 rounded overflow-hidden border border-sol-border/30 bg-sol-bg-alt">
          {/* Markdown toggle header */}
          {isMarkdown && (isRead || (tool.name === "Write" && Boolean(parsedInput.content))) && (
            <div className="flex items-center justify-between px-2 py-1 border-b border-sol-border/20 bg-sol-bg-highlight/30">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-sol-text-dim">{language}</span>
                {isPlan && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-sol-bg-highlight text-sol-text-muted font-medium">
                    PLAN
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 text-[10px]">
                <button
                  onClick={(e) => { e.stopPropagation(); setViewMode('raw'); }}
                  className={`px-1.5 py-0.5 rounded transition-colors ${
                    viewMode === 'raw'
                      ? 'bg-sol-bg-highlight text-sol-text'
                      : 'text-sol-text-dim hover:text-sol-text-muted'
                  }`}
                >
                  Raw
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setViewMode('rendered'); }}
                  className={`px-1.5 py-0.5 rounded transition-colors ${
                    viewMode === 'rendered'
                      ? 'bg-sol-bg-highlight text-sol-text'
                      : 'text-sol-text-dim hover:text-sol-text-muted'
                  }`}
                >
                  Rendered
                </button>
              </div>
            </div>
          )}
          {isEdit && !!parsedInput.old_string && !!parsedInput.new_string ? (
            <DiffView
              oldStr={String(parsedInput.old_string)}
              newStr={String(parsedInput.new_string)}
              startLine={startLine}
              language={language}
            />
          ) : tool.name === "Write" && !!parsedInput.content ? (
            isMarkdown && viewMode === 'rendered' ? (
              <>
                <div
                  ref={mdContainerRef}
                  className="relative p-3"
                  style={!mdExpanded && mdOverflowing ? { maxHeight: MD_COLLAPSED_HEIGHT, overflow: 'hidden', maskImage: 'linear-gradient(to bottom, black calc(100% - 5rem), transparent)', WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 5rem), transparent)' } : undefined}
                >
                  <MarkdownRenderer content={String(parsedInput.content)} filePath={filePath} />
                </div>
                <div className="flex items-center gap-3 px-3 pb-2">
                  {(mdOverflowing || mdExpanded) && (
                    <>
                      <button
                        onClick={(e) => { e.stopPropagation(); setMdExpanded(v => !v); }}
                        className="text-sm font-medium text-sol-cyan hover:text-sol-cyan/80 transition-colors"
                      >
                        {mdExpanded ? "Collapse" : "Expand"}
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setMdFullscreen(true); }}
                        className="text-sm font-medium text-sol-cyan hover:text-sol-cyan/80 transition-colors"
                      >
                        Fullscreen
                      </button>
                    </>
                  )}
                  {onStartShareSelection && messageId && !shareSelectionMode && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onStartShareSelection(messageId); }}
                      className="text-xs font-medium text-sol-cyan hover:text-sol-cyan/80 transition-colors flex items-center gap-1"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                      </svg>
                      Share
                    </button>
                  )}
                </div>
                {mdFullscreen && createPortal(
                  <div className="fixed inset-0 z-[9999] bg-sol-bg overflow-auto" onClick={() => setMdFullscreen(false)}>
                    <div className="max-w-4xl mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-between mb-6">
                        <span className="text-sol-text-secondary text-sm font-medium">{filePath.split('/').pop()}</span>
                        <button
                          onClick={() => setMdFullscreen(false)}
                          className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                          title="Close (Esc)"
                        >
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                      <MarkdownRenderer content={String(parsedInput.content)} filePath={filePath} />
                    </div>
                  </div>,
                  document.body
                )}
              </>
            ) : (
              <DiffView
                oldStr=""
                newStr={String(parsedInput.content)}
                startLine={1}
                language={language}
              />
            )
          ) : tool.name === "apply_patch" ? (
            applyPatchDiffs.length > 0 ? (
              <div className="max-h-80 overflow-auto">
                {applyPatchDiffs.map((diff, idx) => {
                  const diffLanguage = getFileExtension(diff.filePath);
                  const diffStartLine = diff.hunks[0]?.oldStart || diff.hunks[0]?.newStart || 1;
                  return (
                    <div key={`${diff.filePath}-${idx}`} className={idx > 0 ? "border-t border-sol-border/20" : ""}>
                      <div className="px-2 py-1 border-b border-sol-border/20 bg-sol-bg-highlight/20">
                        <span className="text-xs font-mono text-sol-text-dim truncate">{getRelativePath(diff.filePath)}</span>
                      </div>
                      <DiffView
                        oldStr={diff.oldContent}
                        newStr={diff.newContent}
                        startLine={diffStartLine}
                        language={diffLanguage}
                      />
                    </div>
                  );
                })}
              </div>
            ) : applyPatchInput.trim() ? (
              <div className="max-h-80 overflow-auto">
                <pre className="p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-sol-text-secondary">
                  {applyPatchInput}
                </pre>
              </div>
            ) : (
              <div className="p-2 text-xs text-sol-text-dim">Patch input unavailable</div>
            )
          ) : isBash && (parsedInput.command || parsedInput.cmd) ? (
            <div className="max-h-80 overflow-auto">
              <div className="px-1.5 sm:px-2 py-1 sm:py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
                <pre className="text-[11px] sm:text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
                  $ {String(parsedInput.command || parsedInput.cmd)}
                </pre>
              </div>
              {processedContent && processedContent.trim() ? (
                <pre className={`p-1.5 sm:p-2 text-[11px] sm:text-xs font-mono overflow-x-auto whitespace-pre-wrap ${result?.is_error ? "text-sol-red" : "text-sol-text-secondary"}`}>
                  {processedContent}
                </pre>
              ) : (
                <div className="p-2 text-xs text-sol-text-dim">No output</div>
              )}
            </div>
          ) : processedContent && processedContent.trim() ? (
            <div className="max-h-80 overflow-auto">
              {!isMarkdown && language && (
                <div className="text-[10px] px-2 py-1 border-b border-sol-border/20 text-sol-text-dim">
                  {language}
                </div>
              )}
              {isMarkdown && viewMode === 'rendered' ? (
                <div className="p-3">
                  <MarkdownRenderer content={processedContent} filePath={filePath} />
                </div>
              ) : isMarkdownResult ? (
                <div className="p-2 prose prose-invert prose-sm max-w-none text-xs">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} /> }}>{processedContent}</ReactMarkdown>
                </div>
              ) : (
                <pre className={`p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap ${result?.is_error ? "text-sol-red" : "text-sol-text-secondary"}`}>
                  {processedContent}
                </pre>
              )}
            </div>
          ) : (
            <div className="p-2 text-xs text-sol-text-dim">No output</div>
          )}
        </div>
      )}
    </div>
  );
}

function TodoWriteBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: { todos?: Array<{ content: string; status: string; activeForm?: string }> } = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const todos = parsedInput.todos || [];
  if (todos.length === 0) return null;

  const completed = todos.filter(t => t.status === 'completed').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;

  return (
    <div className="my-2">
      <div className="flex items-center gap-2 py-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-pink-500 flex-shrink-0" />
        <span className="font-mono text-sm font-medium text-pink-600 dark:text-sol-magenta">
          TodoWrite
        </span>
        <span className="text-sol-text-dim text-sm font-mono">
          {completed}/{todos.length} done
          {inProgress > 0 && `, ${inProgress} in progress`}
        </span>
      </div>
      <div className="ml-3.5 mt-1 space-y-0.5">
        {todos.map((todo, i) => (
          <div key={i} className="flex items-start gap-2 text-sm">
            {todo.status === 'completed' ? (
              <svg className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : todo.status === 'in_progress' ? (
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <circle cx="12" cy="12" r="9" strokeWidth={2} />
              </svg>
            )}
            <span className={`${
              todo.status === 'completed' ? 'text-sol-text-dim line-through' :
              todo.status === 'in_progress' ? 'text-sol-text-secondary' :
              'text-sol-text-muted'
            }`}>
              {todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskListBlock({ tool, result }: { tool: ToolCall; result?: ToolResult }) {
  if (!result) return null;
  const lines = result.content.split("\n");
  const items: Array<{ id: string; status: string; subject: string; owner?: string; blockedBy?: string[] }> = [];
  for (const line of lines) {
    const match = line.match(/#(\d+)\s+\[(\w+)]\s+(.+?)(?:\s+\(([^)]+)\))?(?:\s+\[blocked by ([^\]]+)])?$/);
    if (match) {
      items.push({
        id: match[1], status: match[2], subject: match[3].trim(),
        owner: match[4]?.trim(),
        blockedBy: match[5]?.split(",").map(s => s.trim().replace("#", "")),
      });
    }
  }
  if (items.length === 0) return null;

  const completed = items.filter(t => t.status === "completed").length;
  const inProgress = items.filter(t => t.status === "in_progress").length;

  return (
    <div className="my-2">
      <div className="flex items-center gap-2 py-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
        <span className="font-mono text-sm font-medium text-emerald-600 dark:text-emerald-400">TaskList</span>
        <span className="text-sol-text-dim text-sm font-mono">
          {completed}/{items.length} done{inProgress > 0 && `, ${inProgress} active`}
        </span>
      </div>
      <div className="ml-3.5 mt-1 space-y-0.5">
        {items.map(task => {
          const isBlocked = task.blockedBy && task.blockedBy.length > 0;
          return (
            <div key={task.id} className={`flex items-start gap-2 text-sm ${isBlocked ? "opacity-50" : ""}`}>
              {task.status === "completed" ? (
                <svg className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : task.status === "in_progress" ? (
                <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : isBlocked ? (
                <svg className="w-4 h-4 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <circle cx="12" cy="12" r="9" strokeWidth={2} />
                </svg>
              )}
              <span className="text-sol-text-dim text-xs font-mono mt-0.5">#{task.id}</span>
              <span className={
                task.status === "completed" ? "text-sol-text-dim line-through" :
                task.status === "in_progress" ? "text-sol-text-secondary" :
                "text-sol-text-muted"
              }>
                {task.subject}
              </span>
              {task.owner && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 font-mono">
                  @{task.owner}
                </span>
              )}
              {isBlocked && (
                <span className="text-[10px] text-sol-text-dim mt-0.5">
                  blocked by {task.blockedBy!.map(id => `#${id}`).join(", ")}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskCreateUpdateBlock({ tool, result, taskSubjectMap }: { tool: ToolCall; result?: ToolResult; taskSubjectMap?: Record<string, string> }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const isCreate = tool.name === "TaskCreate";
  const subject = parsedInput.subject;
  const taskId = parsedInput.taskId;
  const status = parsedInput.status;
  const owner = parsedInput.owner;
  const activeForm = parsedInput.activeForm;

  let resultId = "";
  if (result) {
    const idMatch = result.content.match(/Task #(\d+)/);
    if (idMatch) resultId = idMatch[1];
  }

  const resolvedSubject = subject || (taskId && taskSubjectMap?.[taskId]);

  if (!isCreate && resolvedSubject) {
    return (
      <div className="my-0.5">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-sol-text-muted">{String(resolvedSubject).slice(0, 60)}</span>
          {status && (
            <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${
              status === "completed" ? "bg-emerald-500/15 text-emerald-400" :
              status === "in_progress" ? "bg-amber-500/15 text-amber-400" :
              status === "deleted" ? "bg-red-500/15 text-red-400" :
              "bg-gray-500/15 text-gray-400"
            }`}>
              {status}
            </span>
          )}
          {owner && <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 font-mono">@{owner}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-mono text-emerald-500/80">{tool.name}</span>
        {isCreate ? (
          <>
            {resultId && <span className="text-sol-text-dim font-mono">#{resultId}</span>}
            {subject && <span className="text-sol-text-muted">{String(subject).slice(0, 60)}</span>}
            {activeForm && <span className="text-sol-text-dim italic">({activeForm})</span>}
          </>
        ) : (
          <>
            {taskId && <span className="text-sol-text-dim font-mono">#{taskId}</span>}
            {status && (
              <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${
                status === "completed" ? "bg-emerald-500/15 text-emerald-400" :
                status === "in_progress" ? "bg-amber-500/15 text-amber-400" :
                status === "deleted" ? "bg-red-500/15 text-red-400" :
                "bg-gray-500/15 text-gray-400"
              }`}>
                {status}
              </span>
            )}
            {owner && <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 font-mono">@{owner}</span>}
          </>
        )}
      </div>
    </div>
  );
}

function SendMessageBlock({ tool, agentNameToChildMap }: { tool: ToolCall; agentNameToChildMap?: Record<string, string> }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const type = parsedInput.type || "message";
  const recipient = parsedInput.recipient;
  const summary = parsedInput.summary;
  const childId = recipient && agentNameToChildMap?.[recipient];

  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-mono text-amber-500/80">SendMessage</span>
        {type === "broadcast" ? (
          <span className="px-1 py-0.5 rounded text-[10px] font-mono bg-red-500/15 text-red-400">broadcast</span>
        ) : type === "shutdown_request" ? (
          <span className="px-1 py-0.5 rounded text-[10px] font-mono bg-red-500/15 text-red-400">shutdown</span>
        ) : recipient ? (
          childId ? (
            <Link href={`/conversation/${childId}`} className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 font-mono hover:bg-amber-500/25 hover:text-amber-300 transition-colors" onClick={e => e.stopPropagation()}>@{recipient}</Link>
          ) : (
            <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 font-mono">@{recipient}</span>
          )
        ) : null}
        {summary && <span className="text-sol-text-muted">{String(summary).slice(0, 60)}</span>}
      </div>
    </div>
  );
}

function TeamCreateBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-mono text-sol-cyan/80">{tool.name}</span>
        {parsedInput.team_name && (
          <span className="px-1 py-0.5 rounded text-[10px] font-mono bg-cyan-500/15 text-cyan-400 border border-cyan-500/20">
            {parsedInput.team_name}
          </span>
        )}
        {parsedInput.description && <span className="text-sol-text-dim">{String(parsedInput.description).slice(0, 60)}</span>}
      </div>
    </div>
  );
}

function SkillBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: { skill?: string; args?: string } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}
  const skillName = parsedInput.skill || "skill";
  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-mono text-sol-cyan/80">/{skillName}</span>
        {parsedInput.args && <span className="text-sol-text-dim">{parsedInput.args}</span>}
      </div>
    </div>
  );
}

function PlanModeBlock({ tool, result, onSendMessage }: { tool: ToolCall; result?: ToolResult; onSendMessage?: (content: string) => void }) {
  const isEnter = tool.name === "EnterPlanMode";
  const isExit = tool.name === "ExitPlanMode";
  const isWaitingForApproval = isExit && !result && !!onSendMessage;
  const [sent, setSent] = useState(false);

  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <svg className="w-3 h-3 text-sol-violet/80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
        </svg>
        <span className="font-mono text-sol-violet font-semibold text-[11px]">Plan Mode</span>
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-sol-violet/15 text-sol-violet border border-sol-violet/30">
          {isEnter ? "enter" : "exit"}
        </span>
      </div>
      {isWaitingForApproval && !sent && (
        <div className="flex items-center gap-1.5 mt-1.5 ml-0.5">
          <button
            onClick={() => { setSent(true); onSendMessage(JSON.stringify({ __cc_poll: true, keys: ["1"], display: "Start implementing" })); }}
            className="text-[11px] px-2.5 py-1 rounded border border-sol-border/40 bg-sol-bg-alt text-sol-text hover:border-sol-green/40 hover:bg-sol-green/10 hover:text-sol-green transition-colors cursor-pointer"
          >
            Start implementing
          </button>
          <button
            onClick={() => { setSent(true); onSendMessage(JSON.stringify({ __cc_poll: true, keys: ["4"], text: "adjust the plan", display: "Adjust plan" })); }}
            className="text-[11px] px-2.5 py-1 rounded border border-sol-border/40 bg-sol-bg-alt text-sol-text-muted hover:bg-sol-bg-alt/80 transition-colors cursor-pointer"
          >
            Adjust plan
          </button>
        </div>
      )}
      {sent && (
        <div className="text-[10px] text-sol-text-dim mt-1 ml-0.5 italic">Message sent</div>
      )}
    </div>
  );
}

function AskUserQuestionBlock({ tool, result, onSendMessage }: { tool: ToolCall; result?: ToolResult; onSendMessage?: (content: string) => void }) {
  let parsedInput: { questions?: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>; answers?: Record<string, string> } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}
  const [sent, setSent] = useState(false);
  const [selections, setSelections] = useState<Record<number, { key: string; label: string; text?: string }>>({});
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});

  const questions = parsedInput.questions || [];
  if (questions.length === 0) return null;

  const isMultiQuestion = questions.length > 1;

  let answers: Record<string, string> = {};
  if (parsedInput.answers && typeof parsedInput.answers === "object") {
    answers = parsedInput.answers;
  } else if (result?.content) {
    const regex = /"([^"]+)"="([^"]+)"/g;
    let match;
    while ((match = regex.exec(result.content)) !== null) {
      answers[match[1]] = match[2];
    }
  }

  const isInteractive = !result && !!onSendMessage && !sent;
  const allAnswered = isMultiQuestion && questions.every((_, i) => selections[i] !== undefined);

  const buildPayload = (sels: typeof selections) => {
    const sorted = Object.keys(sels).sort((a, b) => Number(a) - Number(b));
    const hasText = sorted.some(k => sels[Number(k)].text);
    const display = sorted.map(k => sels[Number(k)].label).join(", ");
    if (hasText) {
      const steps = sorted.map(k => {
        const s = sels[Number(k)];
        return s.text ? { key: s.key, text: s.text } : { key: s.key };
      });
      return JSON.stringify({ __cc_poll: true, steps, display });
    }
    return JSON.stringify({ __cc_poll: true, keys: sorted.map(k => sels[Number(k)].key), display });
  };

  const handleSubmitAll = () => {
    if (!onSendMessage || !allAnswered) return;
    setSent(true);
    onSendMessage(buildPayload(selections));
  };

  const commitOther = (qIdx: number, text: string, optionsCount: number) => {
    const otherKey = String(optionsCount + 1);
    const sel = { key: otherKey, label: text, text };
    if (isMultiQuestion) {
      setSelections(prev => ({ ...prev, [qIdx]: sel }));
    } else {
      setSent(true);
      onSendMessage!(buildPayload({ 0: sel }));
    }
  };

  return (
    <div className="my-1.5 ml-1 border-l-2 border-sol-violet/30 pl-3 space-y-2.5">
      {questions.map((q, i) => {
        const answer = answers[q.question];
        const isCustom = answer !== undefined && !q.options.some(
          o => o.label === answer || o.label.replace(" (Recommended)", "") === answer
        );
        const sel = selections[i];
        const isOtherSelected = sel?.text !== undefined;
        return (
          <div key={i} className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              {q.header && (
                <span className="text-[9px] uppercase tracking-wider font-semibold px-1 py-px rounded bg-sol-violet/15 text-sol-violet/80 border border-sol-violet/20">
                  {q.header}
                </span>
              )}
            </div>
            <div className="text-xs text-sol-text-muted">{q.question}</div>
            <div className="flex flex-wrap gap-1">
              {q.options.map((opt, j) => {
                const cleanLabel = opt.label.replace(" (Recommended)", "");
                const isSelected = answer !== undefined && (opt.label === answer || cleanLabel === answer);
                const isLocalSelected = !isOtherSelected && sel?.label === cleanLabel;
                return isInteractive ? (
                  <button
                    key={j}
                    onClick={() => {
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                      if (isMultiQuestion) {
                        setSelections(prev => ({ ...prev, [i]: { key: String(j + 1), label: cleanLabel } }));
                      } else {
                        setSent(true);
                        onSendMessage!(JSON.stringify({ __cc_poll: true, keys: [String(j + 1)], display: cleanLabel }));
                      }
                    }}
                    className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors cursor-pointer ${
                      isLocalSelected
                        ? "bg-sol-violet/20 border-sol-violet/50 text-sol-violet"
                        : "border-sol-violet/30 text-sol-violet/80 hover:bg-sol-violet/15 hover:border-sol-violet/50 hover:text-sol-violet"
                    }`}
                  >
                    {isLocalSelected && (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    {opt.label}
                  </button>
                ) : (
                  <span
                    key={j}
                    className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                      isSelected || isLocalSelected
                        ? "bg-sol-green/15 border-sol-green/40 text-sol-green"
                        : "border-sol-border/30 text-sol-text-dim"
                    }`}
                  >
                    {(isSelected || isLocalSelected) && (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    {opt.label}
                  </span>
                );
              })}
              {isInteractive && !otherOpen[i] && (
                <button
                  onClick={() => {
                    setOtherOpen(prev => ({ ...prev, [i]: true }));
                    setSelections(prev => { const next = { ...prev }; delete next[i]; return next; });
                  }}
                  className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors cursor-pointer ${
                    isOtherSelected
                      ? "bg-sol-blue/20 border-sol-blue/50 text-sol-blue"
                      : "border-sol-border/30 text-sol-text-dim hover:border-sol-blue/40 hover:text-sol-blue/80"
                  }`}
                >
                  {isOtherSelected && (
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                  {isOtherSelected ? sel.label : "Other"}
                </button>
              )}
              {!isInteractive && (isCustom || isOtherSelected) && (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-sol-blue/15 border-sol-blue/40 text-sol-blue">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  {isOtherSelected ? sel.label : answer}
                </span>
              )}
            </div>
            {isInteractive && otherOpen[i] && (
              <div className="flex items-center gap-1.5 mt-1">
                <input
                  autoFocus
                  type="text"
                  value={otherTexts[i] || ""}
                  onChange={e => setOtherTexts(prev => ({ ...prev, [i]: e.target.value }))}
                  onKeyDown={e => {
                    if (e.key === "Enter" && otherTexts[i]?.trim()) {
                      commitOther(i, otherTexts[i].trim(), q.options.length);
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                    } else if (e.key === "Escape") {
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                    }
                  }}
                  placeholder="Type your answer..."
                  className="flex-1 text-xs px-2 py-1 rounded border border-sol-blue/30 bg-sol-bg-alt text-sol-text placeholder:text-sol-text-dim/50 focus:outline-none focus:border-sol-blue/60"
                />
                <button
                  onClick={() => {
                    if (otherTexts[i]?.trim()) {
                      commitOther(i, otherTexts[i].trim(), q.options.length);
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                    }
                  }}
                  disabled={!otherTexts[i]?.trim()}
                  className="text-[10px] px-2 py-1 rounded border border-sol-blue/40 text-sol-blue hover:bg-sol-blue/15 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  OK
                </button>
                <button
                  onClick={() => setOtherOpen(prev => ({ ...prev, [i]: false }))}
                  className="text-[10px] px-1.5 py-1 text-sol-text-dim hover:text-sol-text transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        );
      })}
      {isInteractive && isMultiQuestion && (
        <div className="pt-1">
          <button
            onClick={handleSubmitAll}
            disabled={!allAnswered}
            className={`text-[11px] px-3 py-1 rounded border transition-colors ${
              allAnswered
                ? "border-sol-green/40 bg-sol-green/10 text-sol-green hover:bg-sol-green/20 cursor-pointer"
                : "border-sol-border/30 bg-sol-bg-alt text-sol-text-dim cursor-not-allowed opacity-50"
            }`}
          >
            Submit answers ({Object.keys(selections).length}/{questions.length})
          </button>
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ content, showContent = true }: { content: string; showContent?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = truncateLines(content, expanded ? 50 : 2);
  const isLong = truncated.truncated || content.length > 200;

  if (!showContent) {
    return (
      <div className="my-0.5 opacity-30 text-xs text-sol-text-muted italic">
        thinking...
      </div>
    );
  }

  return (
    <div className="my-0.5 opacity-50">
      <div
        className={`flex items-start gap-1 ${isLong || expanded ? 'cursor-pointer' : ''}`}
        onClick={() => (isLong || expanded) && setExpanded(!expanded)}
      >
        {(isLong || expanded) && (
          <svg
            className={`w-3 h-3 mt-0.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        )}
        <div className="flex-1 text-sol-text-muted font-mono whitespace-pre-wrap break-words text-xs">
          {truncated.text}
          {truncated.truncated && !expanded && "..."}
        </div>
      </div>
    </div>
  );
}

const IMAGE_COLLAPSED_HEIGHT = 100;

function ImageBlock({ image }: { image: ImageData }) {
  const storageUrl = useQuery(
    api.images.getImageUrl,
    image.storage_id ? { storageId: image.storage_id as Id<"_storage"> } : "skip"
  );
  const [fullscreen, setFullscreen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [fullscreen]);

  const src = image.storage_id
    ? storageUrl ?? undefined
    : image.data
      ? `data:${image.media_type};base64,${image.data}`
      : undefined;

  if (!src) {
    return (
      <div className="my-2 max-w-md rounded-t border-x border-t border-sol-border bg-sol-bg-alt flex items-center justify-center" style={{ height: IMAGE_COLLAPSED_HEIGHT }}>
        <span className="text-sol-text-dim text-xs">Loading image...</span>
      </div>
    );
  }

  return (
    <>
      <div
        className="my-2 cursor-pointer relative max-w-md"
        style={{ minHeight: IMAGE_COLLAPSED_HEIGHT }}
        onClick={() => setFullscreen(true)}
      >
        {!loaded && (
          <div className="absolute inset-0 rounded-t border-x border-t border-sol-border bg-sol-bg-alt flex items-center justify-center z-10" style={{ height: IMAGE_COLLAPSED_HEIGHT }}>
            <span className="text-sol-text-dim text-xs">Loading image...</span>
          </div>
        )}
        <div
          className="overflow-hidden rounded-t border-x border-t border-sol-border hover:border-sol-blue/50 transition-all"
          style={{ height: IMAGE_COLLAPSED_HEIGHT }}
        >
          <img
            src={src}
            alt="User provided image"
            className="w-full"
            style={loaded ? undefined : { width: 0, height: 0, overflow: 'hidden', position: 'absolute' }}
            onLoad={() => setLoaded(true)}
          />
        </div>
        {loaded && (
          <div
            className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none"
            style={{ background: 'linear-gradient(to bottom, transparent, var(--image-fade-bg, var(--sol-bg, #0a0a0a)))' }}
          />
        )}
      </div>
      {fullscreen && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/90 flex items-center justify-center" onClick={() => setFullscreen(false)}>
          <button
            onClick={() => setFullscreen(false)}
            className="absolute top-4 right-4 text-white/70 hover:text-white p-2 transition-colors"
            title="Close (Esc)"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <img
            src={src}
            alt="User provided image"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded"
            onClick={e => e.stopPropagation()}
          />
        </div>,
        document.body
      )}
    </>
  );
}

function UserIcon() {
  return (
    <div className="w-6 h-6 rounded bg-sol-blue flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </div>
  );
}

function CommandStatusLine({ content, timestamp }: { content: string; timestamp: number }) {
  const cmdType = getCommandType(content);
  const cmdNameMatch = content.match(/<command-name>([^<]*)<\/command-name>/) || content.match(/<command-message>([^<]*)<\/command-message>/);
  const cmdName = cmdNameMatch?.[1]?.replace(/^\//, "");
  const cleaned = cleanContent(content);
  const isSkillCmd = cmdName && cleaned.length > 200;
  const rawDisplay = cleaned.slice(0, 100) || content.replace(/<[^>]+>/g, "").slice(0, 100);
  const displayText = cmdName ? rawDisplay.replace(new RegExp(`(/?${cmdName}\\s*)+`), "").trim() : rawDisplay;

  if (isSkillCmd) {
    return <SkillExpansionBlock content={content} timestamp={timestamp} cmdName={cmdName} />;
  }

  if (cmdName) {
    return (
      <div className="mb-2 px-3 py-1.5 flex items-center gap-2 text-xs text-sol-text-dim">
        <span className="text-sol-text-dim" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        <span className="font-mono text-sol-cyan/80 font-medium">/{cmdName}</span>
        {displayText && <span className="truncate text-sol-text-dim">{displayText}</span>}
      </div>
    );
  }

  return (
    <div className="mb-2 px-3 py-1.5 flex items-center gap-2 text-xs text-sol-text-dim">
      <span className="text-sol-text-dim" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      <span className="px-1.5 py-0.5 rounded bg-sol-bg-alt/50 text-sol-text-muted font-mono text-[10px]">
        {cmdType || "status"}
      </span>
      <span className="font-mono truncate">{displayText}</span>
    </div>
  );
}

function SkillExpansionBlock({ content, timestamp, cmdName }: { content: string; timestamp: number; cmdName?: string }) {
  const [expanded, setExpanded] = useState(false);
  const info = extractSkillInfo(content);
  const skillName = cmdName || info?.name || "skill";

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(e => !e)}
        className="group flex items-center gap-2 px-3 py-2 rounded-md bg-sol-bg-alt/40 border border-sol-border/30 hover:border-sol-cyan/30 transition-colors w-full text-left"
      >
        <svg className="w-3.5 h-3.5 text-sol-cyan/70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
        <span className="font-mono text-xs text-sol-cyan/80 font-medium">/{skillName}</span>
        {info?.preview && !expanded && (
          <span className="text-[11px] text-sol-text-dim truncate">{info.preview}</span>
        )}
        <span className="ml-auto text-sol-text-dim text-[10px] shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        <svg className={`w-3 h-3 text-sol-text-dim transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-1 rounded-md bg-sol-bg-alt/25 border border-sol-border/20 p-3 text-xs text-sol-text-muted overflow-y-auto leading-relaxed prose prose-invert prose-sm max-w-none">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
              pre: ({ node, children, ...props }) => {
                const codeElement = node?.children?.[0];
                if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
                  const className = codeElement.properties?.className as string[] | undefined;
                  const language = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
                  const codeContent = codeElement.children?.[0];
                  const code = codeContent && 'value' in codeContent ? String(codeContent.value) : '';
                  if (code) return <CodeBlock code={code} language={language} />;
                }
                return <pre {...props}>{children}</pre>;
              },
            }}
          >{content
            .replace(/<command-name>[^<]*<\/command-name>\s*/g, "")
            .replace(/<command-message>[^<]*<\/command-message>\s*/g, "")
            .replace(/^Base directory for this skill:[^\n]*\n?/, "")
            .replace(/<[^>]+>/g, "")
            .trim()}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function isInterruptMessage(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("[Request interrupted") || trimmed.startsWith("[Request cancelled");
}

function isCodexTurnAbortedMessage(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("<turn_aborted>") && trimmed.includes("</turn_aborted>");
}

function isInterruptLikeMessage(content: string, agentType?: string): boolean {
  if (isInterruptMessage(content)) return true;
  return agentType === "codex" && isCodexTurnAbortedMessage(content);
}

function InterruptStatusLine({ label = "user interrupted", tone = "sky" }: { label?: string; tone?: "sky" | "amber" }) {
  const lineClass = tone === "amber"
    ? "flex-1 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent"
    : "flex-1 h-px bg-gradient-to-r from-transparent via-sky-400/40 to-transparent";
  const textClass = tone === "amber" ? "text-xs text-amber-500 font-medium" : "text-xs text-sky-400 font-medium";
  return (
    <div className="my-6 flex items-center gap-3">
      <div className={lineClass} />
      <span className={textClass}>{label}</span>
      <div className={lineClass} />
    </div>
  );
}

function isTaskNotification(content: string): boolean {
  return content.trim().startsWith('<task-notification>');
}

function parseTaskNotification(content: string): { taskId: string; status: string; summary: string; outputFile?: string } | null {
  const match = content.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
  if (!match) return null;
  const inner = match[1];
  const taskId = inner.match(/<task-id>(.*?)<\/task-id>/)?.[1] || '';
  const status = inner.match(/<status>(.*?)<\/status>/)?.[1] || '';
  const summary = inner.match(/<summary>(.*?)<\/summary>/)?.[1] || '';
  const outputFile = inner.match(/<output-file>(.*?)<\/output-file>/)?.[1];
  return { taskId, status, summary, outputFile };
}

function isCompactionPromptMessage(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return (
    trimmed.includes("Your task is to create a detailed summary of the conversation so far") ||
    (trimmed.startsWith("Your task is to create a detailed summary") && trimmed.includes("<summary>"))
  );
}

function extractCompactionSummaryContent(content: string): string {
  if (!content) return "";
  const summaryMatch = content.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i);
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim();
  }
  return content.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
}

const taskStatusConfig: Record<string, { icon: string; color: string; bg: string }> = {
  completed: { icon: '\u2713', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  killed: { icon: '\u25A0', color: 'text-sol-orange', bg: 'bg-sol-orange/10 border-sol-orange/20' },
  failed: { icon: '\u2717', color: 'text-sol-red', bg: 'bg-sol-red/10 border-sol-red/20' },
  running: { icon: '\u25B6', color: 'text-sol-blue', bg: 'bg-sol-blue/10 border-sol-blue/20' },
};

function TaskNotificationLine({ content, timestamp }: { content: string; timestamp: number }) {
  const parsed = parseTaskNotification(content);
  if (!parsed) return null;
  const cfg = taskStatusConfig[parsed.status] || taskStatusConfig.killed;
  return (
    <div className={`mb-2 px-3 py-2 flex items-center gap-2.5 text-xs border rounded ${cfg.bg}`}>
      <span className={`font-mono text-sm leading-none ${cfg.color}`}>{cfg.icon}</span>
      <span className="text-sol-text-muted">{parsed.summary}</span>
      <span className="text-sol-text-dim font-mono text-[10px] ml-auto shrink-0">{parsed.taskId}</span>
      <span className="text-sol-text-dim" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
    </div>
  );
}

const USER_CONTENT_MAX_HEIGHT = 1800;

function parseSkillBlocks(text: string): { parts: Array<{ type: 'text' | 'skill'; content: string; skillName?: string; skillDesc?: string; skillPath?: string }>} {
  if (!text || typeof text !== 'string') {
    return { parts: [{ type: 'text', content: String(text || '') }] };
  }
  const parts: Array<{ type: 'text' | 'skill'; content: string; skillName?: string; skillDesc?: string; skillPath?: string }> = [];
  const skillRegex = /<skill>([\s\S]*?)<\/skill>/g;
  let lastIndex = 0;
  let match;
  while ((match = skillRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) parts.push({ type: 'text', content: before });
    }
    const inner = match[1];
    const nameMatch = inner.match(/<name>(.*?)<\/name>/);
    const pathMatch = inner.match(/<path>(.*?)<\/path>/);
    const descMatch = inner.match(/description:\s*(.+)/);
    parts.push({
      type: 'skill',
      content: match[0],
      skillName: nameMatch?.[1],
      skillDesc: descMatch?.[1]?.trim(),
      skillPath: pathMatch?.[1],
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) parts.push({ type: 'text', content: remaining });
  }
  if (parts.length === 0) parts.push({ type: 'text', content: text });
  return { parts };
}

function SkillCard({ name, description, path }: { name?: string; description?: string; path?: string }) {
  const shortPath = path ? path.replace(/^\/Users\/[^/]+\//, "~/") : undefined;
  return (
    <div className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-sol-bg-alt border border-sol-border/40 text-xs font-mono">
      <span className="text-sol-violet font-semibold">/{name || "skill"}</span>
      {description && <span className="text-sol-text-muted">{description}</span>}
      {shortPath && <span className="text-sol-text-dim text-[10px] hidden sm:inline">{shortPath}</span>}
    </div>
  );
}

type TeammateMessagePart = { type: 'text'; content: string } | { type: 'teammate'; teammateId: string; color?: string; summary?: string; content: string; };

function parseTeammateMessages(text: string): TeammateMessagePart[] {
  if (!text || typeof text !== 'string') {
    return [{ type: 'text', content: String(text || '') }];
  }
  const parts: TeammateMessagePart[] = [];
  const regex = /<teammate-message\s+([^>]*)>([\s\S]*?)<\/teammate-message>/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) parts.push({ type: 'text', content: before });
    }
    const attrs = match[1];
    const inner = match[2].trim();
    const idMatch = attrs.match(/teammate_id="([^"]+)"/);
    const colorMatch = attrs.match(/color="([^"]+)"/);
    const summaryMatch = attrs.match(/summary="([^"]+)"/);
    parts.push({
      type: 'teammate',
      teammateId: idMatch?.[1] || 'agent',
      color: colorMatch?.[1],
      summary: summaryMatch?.[1],
      content: inner,
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) parts.push({ type: 'text', content: remaining });
  }
  return parts;
}

const agentColorMap: Record<string, string> = {
  blue: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  red: "bg-red-500/20 text-red-400 border-red-500/30",
  green: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  yellow: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  purple: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  cyan: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  orange: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  pink: "bg-pink-500/20 text-pink-400 border-pink-500/30",
};

const agentBorderMap: Record<string, string> = {
  blue: "border-blue-500/30",
  red: "border-red-500/30",
  green: "border-emerald-500/30",
  yellow: "border-amber-500/30",
  purple: "border-violet-500/30",
  cyan: "border-cyan-500/30",
  orange: "border-orange-500/30",
  pink: "border-pink-500/30",
};

function TeammateMessageCard({ teammateId, color, summary, content }: { teammateId: string; color?: string; summary?: string; content: string }) {
  const [expanded, setExpanded] = useState(false);

  const safeContent = content || '';
  let parsed: any = null;
  try { if (safeContent) parsed = JSON.parse(safeContent); } catch {}

  if (parsed?.type === "idle_notification") {
    const idleSummary = parsed.summary;
    if (idleSummary) {
      return (
        <div className="flex items-center gap-2 py-1 text-xs text-sol-text-dim">
          <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${agentColorMap[color || "blue"] || agentColorMap.blue}`}>
            {teammateId}
          </span>
          <span className="italic">{idleSummary}</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 py-0.5 text-xs text-sol-text-dim opacity-50">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${agentColorMap[color || "blue"] || agentColorMap.blue}`}>
          {teammateId}
        </span>
        <span className="italic">idle</span>
      </div>
    );
  }

  if (parsed?.type === "task_assignment") {
    return (
      <div className="flex items-center gap-2 py-1 text-xs">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${agentColorMap[color || "blue"] || agentColorMap.blue}`}>
          {parsed.assignedBy || teammateId}
        </span>
        <span className="text-sol-text-muted">
          assigned <span className="font-mono text-sol-text-dim">#{parsed.taskId}</span> {parsed.subject}
        </span>
      </div>
    );
  }

  if (parsed?.type === "shutdown_request") {
    return (
      <div className="flex items-center gap-2 py-1 text-xs">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${agentColorMap[color || "red"] || agentColorMap.red}`}>
          {teammateId}
        </span>
        <span className="text-red-400 italic">shutdown request</span>
      </div>
    );
  }

  const borderColor = agentBorderMap[color || "blue"] || agentBorderMap.blue;
  const badgeColor = agentColorMap[color || "blue"] || agentColorMap.blue;
  const isLong = content.length > 200;

  return (
    <div className={`my-1.5 border-l-2 ${borderColor} pl-3 py-1`}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${badgeColor}`}>
          {teammateId}
        </span>
        {summary && <span className="text-xs text-sol-text-muted">{summary}</span>}
      </div>
      <div
        className={`text-sm text-sol-text-secondary whitespace-pre-wrap break-words ${isLong && !expanded ? "line-clamp-4" : ""}`}
      >
        {content}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-sol-text-dim hover:text-sol-blue mt-1 transition-colors"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function UserPrompt({ content, timestamp, messageId, conversationId, collapsed, userName, onOpenComments, isHighlighted, shareSelectionMode, isSelectedForShare, onToggleShareSelection, onStartShareSelection, onForkFromMessage, forkChildren, messageUuid, images, onBranchSwitch, activeBranchId, loadingBranchId, isPending, mainMessageCount }: { content: string; timestamp: number; messageId: string; conversationId?: Id<"conversations">; collapsed?: boolean; userName?: string; onOpenComments?: () => void; isHighlighted?: boolean; shareSelectionMode?: boolean; isSelectedForShare?: boolean; onToggleShareSelection?: () => void; onStartShareSelection?: (messageId: string) => void; onForkFromMessage?: (messageUuid: string) => void; forkChildren?: Array<{ _id: string; title: string; short_id?: string; started_at?: number; username?: string; message_count?: number; agent_type?: string }>; messageUuid?: string; images?: ImageData[]; onBranchSwitch?: (convId: string | null) => void; activeBranchId?: string | null; loadingBranchId?: string | null; isPending?: boolean; mainMessageCount?: number }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [contentExpanded, setContentExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const displayContent = content
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/\[Image\s+\/tmp\/codecast\/images\/[^\]]*\]/gi, "")
    .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
    .replace(/\[image\]/gi, "")
    .trim();
  const isMarkdown = hasRichMarkdown(displayContent);

  const effectivelyCollapsed = collapsed && !isExpanded;

  useEffect(() => {
    if (effectivelyCollapsed && contentRef.current) {
      const el = contentRef.current;
      setIsTruncated(el.scrollHeight > el.clientHeight);
    } else {
      setIsTruncated(false);
    }
  }, [effectivelyCollapsed, content]);

  useEffect(() => {
    if (!effectivelyCollapsed && contentRef.current && !contentExpanded) {
      setIsOverflowing(contentRef.current.scrollHeight > USER_CONTENT_MAX_HEIGHT);
    }
  }, [content, effectivelyCollapsed, contentExpanded]);

  useEffect(() => {
    if (!fullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [fullscreen]);

  const isRealMessageId = messageId && !messageId.startsWith("optimistic_");
  const commentCount = useQuery(api.comments.getCommentCount,
    isRealMessageId ? { message_id: messageId as Id<"messages"> } : "skip"
  );

  const isBookmarked = useQuery(
    api.bookmarks.isBookmarked,
    isRealMessageId ? { message_id: messageId as Id<"messages"> } : "skip"
  );
  const toggleBookmark = useMutation(api.bookmarks.toggleBookmark);

  const handleCopy = () => {
    setTimeout(() => { copyToClipboard(content).then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  const handleCopyLink = () => {
    const url = `${window.location.origin}${window.location.pathname}#msg-${messageId}`;
    setTimeout(() => { copyToClipboard(url).then(() => toast.success("Link copied!")).catch(() => toast.error("Failed to copy link")); });
  };

  const handleToggleBookmark = async () => {
    if (!conversationId) return;
    try {
      const result = await toggleBookmark({
        conversation_id: conversationId,
        message_id: messageId as Id<"messages">,
      });
      toast.success(result ? "Bookmarked!" : "Bookmark removed");
    } catch (err) {
      toast.error("Failed to toggle bookmark");
    }
  };

  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);
  };

  return (
    <div id={`msg-${messageId}`} className={`group relative scroll-mt-20 bg-sol-blue/10 -mx-4 px-4 py-4 rounded-lg border border-sol-blue/30 ${effectivelyCollapsed ? "mb-2" : "mb-6"} transition-all ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg rounded-lg message-highlight" : ""} ${shareSelectionMode ? "cursor-pointer" : ""} ${isSelectedForShare ? "bg-sol-cyan/10 border-2 border-sol-cyan ring-2 ring-sol-cyan/30" : ""} ${isPending ? "opacity-80" : ""}`} style={{ '--image-fade-bg': 'color-mix(in srgb, var(--sol-blue) 10%, var(--sol-bg))' } as React.CSSProperties} onClick={shareSelectionMode ? onToggleShareSelection : undefined}>
      <div className={`absolute -top-2 right-0 transition-opacity flex gap-0.5 z-10 bg-sol-bg rounded shadow-md px-0.5 ${shareSelectionMode ? "opacity-0 pointer-events-none" : "opacity-0 group-hover:opacity-100"}`}>
        {onStartShareSelection && (
          <button
            onClick={() => onStartShareSelection(messageId)}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
            title="Share message"
            aria-label="Share message"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
          </button>
        )}
        <button
          onClick={handleCopyLink}
          className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
          title="Copy link to message"
          aria-label="Copy link to message"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        </button>
        <button
          onClick={handleToggleBookmark}
          className={`p-1.5 rounded hover:bg-sol-bg-alt ${isBookmarked ? "text-amber-400" : "text-sol-text-dim hover:text-sol-text-secondary"}`}
          title={isBookmarked ? "Remove bookmark" : "Bookmark message"}
          aria-label={isBookmarked ? "Remove bookmark" : "Bookmark message"}
        >
          <svg className="w-4 h-4" fill={isBookmarked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
        </button>
        <button
          onClick={onOpenComments}
          className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary flex items-center gap-1"
          title="Comments"
          aria-label="Comments"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
          </svg>
          {commentCount !== undefined && commentCount > 0 && (
            <span className="text-xs">{commentCount}</span>
          )}
        </button>
        {onForkFromMessage && messageUuid && (
          <button
            onClick={() => onForkFromMessage(messageUuid)}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
            title="Fork from this message"
            aria-label="Fork from this message"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </button>
        )}
        <button
          onClick={handleCopy}
          className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
          title="Copy message"
          aria-label="Copy message"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <UserIcon />
        <span className="text-sol-blue text-xs font-medium">{userName || "You"}</span>
        <a
          href={`#msg-${messageId}`}
          className="text-sol-text-dim hover:text-sol-text-muted text-xs transition-colors"
          title={`${formatFullTimestamp(timestamp)} (click to copy)`}
          onClick={(e) => { e.preventDefault(); setTimeout(() => { copyToClipboard(formatFullTimestamp(timestamp)).then(() => toast.success("Timestamp copied")); }); }}
        >
          {formatRelativeTime(timestamp)}
        </a>
        {isBookmarked && (
          <svg className="w-3 h-3 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
        )}
      </div>
      {displayContent ? <div
        ref={contentRef}
        className={`text-sol-text text-sm pl-8 break-words relative ${effectivelyCollapsed ? "line-clamp-2 whitespace-pre-wrap" : isMarkdown ? "prose prose-invert prose-sm max-w-none" : "whitespace-pre-wrap"}`}
        style={!effectivelyCollapsed && !contentExpanded && isOverflowing ? { maxHeight: USER_CONTENT_MAX_HEIGHT, overflow: 'hidden', maskImage: 'linear-gradient(to bottom, black calc(100% - 5rem), transparent)', WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 5rem), transparent)' } : undefined}
      >
        {effectivelyCollapsed ? displayContent : (() => {
          const hasTeammate = displayContent.includes('<teammate-message');
          if (hasTeammate) {
            const tmParts = parseTeammateMessages(displayContent);
            return (
              <div className="space-y-1">
                {tmParts.map((part, i) => part.type === 'teammate' ? (
                  <TeammateMessageCard key={i} teammateId={part.teammateId} color={part.color} summary={part.summary} content={part.content} />
                ) : hasRichMarkdown(part.content) ? (
                  <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}
                    components={{ img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />, pre: ({ node, children, ...props }) => {
                      const codeElement = node?.children?.[0];
                      if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
                        const className = codeElement.properties?.className as string[] | undefined;
                        const language = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
                        const codeContent = codeElement.children?.[0];
                        const code = codeContent && 'value' in codeContent ? String(codeContent.value) : '';
                        if (code) return <CodeBlock code={code} language={language} />;
                      }
                      return <pre {...props}>{children}</pre>;
                    }}}
                  >{part.content}</ReactMarkdown>
                ) : <span key={i} className="whitespace-pre-wrap">{part.content}</span>)}
              </div>
            );
          }
          const hasSkill = displayContent.includes('<skill>');
          if (hasSkill) {
            const { parts } = parseSkillBlocks(displayContent);
            return (
              <div className="space-y-2">
                {parts.map((part, i) => part.type === 'skill' ? (
                  <SkillCard key={i} name={part.skillName} description={part.skillDesc} path={part.skillPath} />
                ) : isMarkdown || hasRichMarkdown(part.content) ? (
                  <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}
                    components={{ img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />, pre: ({ node, children, ...props }) => {
                      const codeElement = node?.children?.[0];
                      if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
                        const className = codeElement.properties?.className as string[] | undefined;
                        const language = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
                        const codeContent = codeElement.children?.[0];
                        const code = codeContent && 'value' in codeContent ? String(codeContent.value) : '';
                        if (code) return <CodeBlock code={code} language={language} />;
                      }
                      return <pre {...props}>{children}</pre>;
                    }}}
                  >{part.content}</ReactMarkdown>
                ) : <span key={i}>{part.content}</span>)}
              </div>
            );
          }
          return isMarkdown ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{
                img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
                pre: ({ node, children, ...props }) => {
                  const codeElement = node?.children?.[0];
                  if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
                    const className = codeElement.properties?.className as string[] | undefined;
                    const language = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
                    const codeContent = codeElement.children?.[0];
                    const code = codeContent && 'value' in codeContent ? String(codeContent.value) : '';
                    if (code) return <CodeBlock code={code} language={language} />;
                  }
                  return <pre {...props}>{children}</pre>;
                },
              }}
            >{displayContent}</ReactMarkdown>
          ) : displayContent;
        })()}
      </div> : null}
      {!effectivelyCollapsed && images && images.length > 0 && (
        <div className="pl-8 mt-2">
          {images.map((img, i) => <ImageBlock key={i} image={img} />)}
        </div>
      )}
      {isTruncated && (
        <button
          onClick={handleToggleExpand}
          className="text-xs text-sol-text-dim hover:text-sol-blue mt-2 ml-8 transition-colors"
        >
          Expand
        </button>
      )}
      {isExpanded && collapsed && (
        <button
          onClick={handleToggleExpand}
          className="text-xs text-sol-text-dim hover:text-sol-blue mt-2 ml-8 transition-colors"
        >
          Collapse
        </button>
      )}
      {!effectivelyCollapsed && (isOverflowing || contentExpanded) && (
        <div className="flex items-center gap-3 mt-2 ml-8">
          <button
            onClick={() => setContentExpanded(e => !e)}
            className="text-xs font-medium text-sol-blue hover:text-sol-blue/80 transition-colors"
          >
            {contentExpanded ? "Collapse" : "Expand"}
          </button>
          <button
            onClick={() => setFullscreen(true)}
            className="text-xs font-medium text-sol-blue hover:text-sol-blue/80 transition-colors"
          >
            Fullscreen
          </button>
        </div>
      )}

      {forkChildren && forkChildren.length > 0 && onBranchSwitch && (
        <BranchSelector
          forkChildren={forkChildren}
          activeBranchId={activeBranchId ?? null}
          onSwitchBranch={(convId) => onBranchSwitch(convId)}
          loadingBranchId={loadingBranchId}
          mainMessageCount={mainMessageCount}
        />
      )}

      {fullscreen && createPortal(
        <div className="fixed inset-0 z-[9999] bg-sol-bg overflow-auto" onClick={() => setFullscreen(false)}>
          <div className="max-w-4xl mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <span className="text-sol-text-secondary text-sm font-medium">{userName || "You"}</span>
              <button
                onClick={() => setFullscreen(false)}
                className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                title="Close (Esc)"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className={isMarkdown ? "prose prose-invert prose-sm max-w-none text-sol-text" : "text-sol-text text-sm whitespace-pre-wrap"}>
              {isMarkdown ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
                    pre: ({ node, children, ...props }) => {
                      const codeElement = node?.children?.[0];
                      if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
                        const className = codeElement.properties?.className as string[] | undefined;
                        const language = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
                        const codeContent = codeElement.children?.[0];
                        const code = codeContent && 'value' in codeContent ? String(codeContent.value) : '';
                        if (code) {
                          return <CodeBlock code={code} language={language} />;
                        }
                      }
                      return <pre {...props}>{children}</pre>;
                    },
                  }}
                >
                  {content}
                </ReactMarkdown>
              ) : content}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function linkifyMentions(text: string, map: Record<string, string>): string {
  if (!text || Object.keys(map).length === 0) return text;
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    return part.replace(/@([\w][\w-]*)/g, (match, name) => {
      const childId = map[name];
      if (childId) return `[@${name}](/conversation/${childId})`;
      return match;
    });
  }).join('');
}

function AssistantBlock({
  content,
  timestamp,
  thinking,
  showThinking,
  toolCalls,
  toolResults,
  images,
  messageId,
  messageUuid,
  conversationId,
  collapsed,
  childConversationMap,
  childConversations,
  agentNameToChildMap,
  showHeader = true,
  onOpenComments,
  toolCallChangeSelectionMap,
  isHighlighted,
  onToggleCollapsed,
  isSequenceExpanded,
  showCollapseButton,
  runMessageIds,
  shareSelectionMode,
  isSelectedForShare,
  onToggleShareSelection,
  onStartShareSelection,
  agentType,
  taskSubjectMap,
  onForkFromMessage,
  forkChildren,
  onBranchSwitch,
  activeBranchId,
  loadingBranchId,
  mainMessageCount,
  model,
  onSendInlineMessage,
  isConversationActive,
  globalImageMap,
}: {
  content?: string;
  timestamp: number;
  thinking?: string;
  showThinking?: boolean;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  images?: ImageData[];
  messageId: string;
  messageUuid?: string;
  conversationId?: Id<"conversations">;
  collapsed?: boolean;
  childConversationMap?: Record<string, string>;
  childConversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>;
  agentNameToChildMap?: Record<string, string>;
  showHeader?: boolean;
  onOpenComments?: () => void;
  toolCallChangeSelectionMap?: Record<string, ToolCallChangeSelection>;
  isHighlighted?: boolean;
  onToggleCollapsed?: () => void;
  isSequenceExpanded?: boolean;
  showCollapseButton?: boolean;
  runMessageIds?: string[];
  shareSelectionMode?: boolean;
  isSelectedForShare?: boolean;
  onToggleShareSelection?: () => void;
  onStartShareSelection?: (messageId: string) => void;
  agentType?: string;
  taskSubjectMap?: Record<string, string>;
  onForkFromMessage?: (messageUuid: string) => void;
  forkChildren?: Array<{ _id: string; title: string; short_id?: string; started_at?: number; username?: string; message_count?: number; agent_type?: string }>;
  onBranchSwitch?: (convId: string | null) => void;
  activeBranchId?: string | null;
  loadingBranchId?: string | null;
  mainMessageCount?: number;
  model?: string;
  onSendInlineMessage?: (content: string) => void;
  isConversationActive?: boolean;
  globalImageMap?: Record<string, ImageData>;
}) {
  const COLLAPSED_LINES = 2;
  const CONTENT_MAX_HEIGHT = 800;

  const [contentExpanded, setContentExpanded] = useState(true);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const strippedContent = content ? stripSystemTags(content) : content;
  const displayContent = strippedContent && agentNameToChildMap
    ? linkifyMentions(strippedContent, agentNameToChildMap)
    : strippedContent;
  const parsedApiError = useMemo(() => parseApiErrorContent(displayContent), [displayContent]);
  const hasContent = displayContent && displayContent.trim().length > 0;
  const hasThinking = thinking && thinking.trim().length > 0;
  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const hasImages = images && images.length > 0;

  const isRealMessageId = messageId && !messageId.startsWith("optimistic_");
  const commentCount = useQuery(api.comments.getCommentCount,
    isRealMessageId ? { message_id: messageId as Id<"messages"> } : "skip"
  );

  const isBookmarked = useQuery(
    api.bookmarks.isBookmarked,
    isRealMessageId ? { message_id: messageId as Id<"messages"> } : "skip"
  );
  const toggleBookmark = useMutation(api.bookmarks.toggleBookmark);

  const toolResultMap = useMemo(() => {
    const map: Record<string, ToolResult> = {};
    if (toolResults) {
      for (const r of toolResults) {
        map[r.tool_use_id] = r;
      }
    }
    return map;
  }, [toolResults]);

  useEffect(() => {
    if (!contentRef.current || collapsed) return;
    const el = contentRef.current;
    const check = () => setIsOverflowing(el.scrollHeight > CONTENT_MAX_HEIGHT);
    check();
    const obs = new ResizeObserver(check);
    obs.observe(el);
    return () => obs.disconnect();
  }, [content, collapsed]);

  useEffect(() => {
    if (!fullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [fullscreen]);

  if (!hasContent && !hasThinking && !hasToolCalls && !hasImages) {
    return null;
  }

  const lines = displayContent ? displayContent.split("\n") : [];
  const getCollapsedContent = () => {
    if (!collapsed || !displayContent) return { text: displayContent || "", wasTruncated: false };
    if (lines.length <= COLLAPSED_LINES) return { text: displayContent, wasTruncated: false };
    return { text: lines.slice(0, COLLAPSED_LINES).join("\n"), wasTruncated: true };
  };
  const { text: truncatedContent } = getCollapsedContent();

  const handleCopy = () => {
    setTimeout(() => { copyToClipboard(displayContent || "").then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  const handleCopyLink = () => {
    const url = `${window.location.origin}${window.location.pathname}#msg-${messageId}`;
    setTimeout(() => { copyToClipboard(url).then(() => toast.success("Link copied!")).catch(() => toast.error("Failed to copy link")); });
  };

  const handleToggleBookmark = async () => {
    if (!conversationId) return;
    try {
      const result = await toggleBookmark({
        conversation_id: conversationId,
        message_id: messageId as Id<"messages">,
      });
      toast.success(result ? "Bookmarked!" : "Bookmark removed");
    } catch (err) {
      toast.error("Failed to toggle bookmark");
    }
  };

  // Show Claude header for first message in sequence (regardless of content type)
  const visibleThinking = hasThinking && showThinking;
  const shouldShowHeader = showHeader;
  const onlyToolCalls = hasToolCalls && !hasContent && !visibleThinking;
  const hasVisibleContent = hasContent || visibleThinking || hasToolCalls || hasImages;

  // When nothing visible, hide completely
  if (!hasVisibleContent) {
    return null;
  }

  // When collapsed and only tool calls (no text content), hide completely -- unless it has plan writes
  const hasPlanWrite = hasToolCalls && toolCalls?.some(isPlanWriteToolCall);
  if (collapsed && onlyToolCalls && !hasPlanWrite) {
    return null;
  }

  return (
    <div id={`msg-${messageId}`} className={`group relative scroll-mt-20 ${collapsed ? "mb-1" : onlyToolCalls ? "mb-1" : "mb-6"} transition-all ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg rounded-lg p-2 -m-2 message-highlight" : ""} ${shareSelectionMode ? "cursor-pointer" : ""} ${isSelectedForShare ? "bg-sol-cyan/10 rounded-lg p-2 -m-2 border-2 border-sol-cyan ring-2 ring-sol-cyan/30" : ""}`} onClick={shareSelectionMode ? onToggleShareSelection : undefined} title={!shouldShowHeader ? formatRelativeTime(timestamp) : undefined}>
      {(hasContent || hasToolCalls) && (
        <div className={`absolute ${hasPlanWrite && onlyToolCalls ? "-top-6" : "-top-2"} right-0 transition-opacity flex gap-0.5 z-10 bg-sol-bg rounded shadow-md px-0.5 ${shareSelectionMode ? "opacity-0 pointer-events-none" : "opacity-0 group-hover:opacity-100"}`}>
          {onStartShareSelection && (
            <button
              onClick={() => onStartShareSelection(messageId)}
              className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
              title="Share message"
              aria-label="Share message"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            </button>
          )}
          <button
            onClick={handleCopyLink}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
            title="Copy link to message"
            aria-label="Copy link to message"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          </button>
          <button
            onClick={handleToggleBookmark}
            className={`p-1.5 rounded hover:bg-sol-bg-alt ${isBookmarked ? "text-amber-400" : "text-sol-text-dim hover:text-sol-text-secondary"}`}
            title={isBookmarked ? "Remove bookmark" : "Bookmark message"}
            aria-label={isBookmarked ? "Remove bookmark" : "Bookmark message"}
          >
            <svg className="w-4 h-4" fill={isBookmarked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          </button>
          <button
            onClick={onOpenComments}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary flex items-center gap-1"
            title="Comments"
            aria-label="Comments"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
            {commentCount !== undefined && commentCount > 0 && (
              <span className="text-xs">{commentCount}</span>
            )}
          </button>
          {onForkFromMessage && messageUuid && (
            <button
              onClick={() => onForkFromMessage(messageUuid)}
              className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
              title="Fork from this message"
              aria-label="Fork from this message"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </button>
          )}
          <button
            onClick={handleCopy}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
            title="Copy message"
            aria-label="Copy message"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
        </div>
      )}

      {shouldShowHeader && (
        <div className="flex items-center gap-2 mb-2">
          <AssistantIcon agentType={agentType} />
          <span className="text-sol-text-secondary text-xs font-medium">{assistantLabel(agentType)}</span>
          {model && (
            <span className="text-sol-text-dim text-[10px] font-mono">{formatModel(model)}</span>
          )}
          <a
            href={`#msg-${messageId}`}
            className="text-sol-text-dim hover:text-sol-text-muted text-xs transition-colors"
            title={`${formatFullTimestamp(timestamp)} (click to copy)`}
            onClick={(e) => { e.preventDefault(); setTimeout(() => { copyToClipboard(formatFullTimestamp(timestamp)).then(() => toast.success("Timestamp copied")); }); }}
          >
            {formatRelativeTime(timestamp)}
          </a>
          {isBookmarked && (
            <svg className="w-3 h-3 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
              <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          )}
        </div>
      )}

      <div className={shouldShowHeader || !showHeader ? "pl-8" : "pl-0"}>
        {!collapsed && hasImages && images?.filter(img => !img.tool_use_id).map((img, i) => <ImageBlock key={i} image={img} />)}

        {!collapsed && hasThinking && showThinking && <ThinkingBlock content={thinking!} showContent={showThinking} />}

        {hasToolCalls && toolCalls?.map((tc) => {
          if (collapsed && !isPlanWriteToolCall(tc)) return null;
          return tc.name === "Task" ? (
            <TaskToolBlock
              key={tc.id}
              tool={tc}
              result={toolResultMap[tc.id]}
              childConversationId={messageUuid && childConversationMap ? childConversationMap[messageUuid] : undefined}
              childConversations={childConversations}
            />
          ) : tc.name === "TodoWrite" ? (
            <TodoWriteBlock key={tc.id} tool={tc} />
          ) : tc.name === "AskUserQuestion" ? (
            <AskUserQuestionBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} onSendMessage={isConversationActive ? onSendInlineMessage : undefined} />
          ) : tc.name === "TaskList" ? (
            <TaskListBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} />
          ) : tc.name === "TaskCreate" || tc.name === "TaskUpdate" || tc.name === "TaskGet" ? (
            <TaskCreateUpdateBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} taskSubjectMap={taskSubjectMap} />
          ) : tc.name === "SendMessage" ? (
            <SendMessageBlock key={tc.id} tool={tc} agentNameToChildMap={agentNameToChildMap} />
          ) : tc.name === "TeamCreate" || tc.name === "TeamDelete" ? (
            <TeamCreateBlock key={tc.id} tool={tc} />
          ) : tc.name === "Skill" ? (
            <SkillBlock key={tc.id} tool={tc} />
          ) : tc.name === "EnterPlanMode" || tc.name === "ExitPlanMode" ? (
            <PlanModeBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} onSendMessage={isConversationActive ? onSendInlineMessage : undefined} />
          ) : (
            <ToolBlock
              key={tc.id}
              tool={tc}
              result={toolResultMap[tc.id]}
              changeIndex={toolCallChangeSelectionMap?.[tc.id]?.index}
              changeRange={toolCallChangeSelectionMap?.[tc.id]?.range}
              shareSelectionMode={shareSelectionMode}
              messageId={messageId}
              conversationId={conversationId}
              onStartShareSelection={onStartShareSelection}
              onOpenComments={onOpenComments}
              collapsed={collapsed}
              timestamp={timestamp}
              images={images}
              globalImageMap={globalImageMap}
            />
          );
        })}

        {hasContent && (
          <>
            <div className={parsedApiError ? "" : `text-sol-text ${collapsed ? "text-sm whitespace-pre-wrap break-words" : "prose prose-invert prose-sm max-w-none"}`}>
              {parsedApiError ? (
                <ApiErrorCard error={parsedApiError} compact={!!collapsed} />
              ) : collapsed ? (
                <div className="relative overflow-hidden" style={lines.length > COLLAPSED_LINES ? { maskImage: 'linear-gradient(to bottom, black 50%, transparent)', WebkitMaskImage: 'linear-gradient(to bottom, black 50%, transparent)' } : undefined}>
                  <span>{truncatedContent}</span>
                </div>
              ) : (
                <div
                  ref={contentRef}
                  className="relative"
                  style={!contentExpanded && isOverflowing ? { maxHeight: CONTENT_MAX_HEIGHT, overflow: 'hidden', maskImage: 'linear-gradient(to bottom, black calc(100% - 2rem), transparent)', WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 2rem), transparent)' } : undefined}
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                      img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
                      pre: ({ node, children, ...props }) => {
                        const codeElement = node?.children?.[0];
                        if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
                          const className = codeElement.properties?.className as string[] | undefined;
                          const language = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
                          const codeContent = codeElement.children?.[0];
                          const code = codeContent && 'value' in codeContent ? String(codeContent.value) : '';

                          if (code) {
                            return <CodeBlock code={code} language={language} />;
                          }
                        }
                        return <pre {...props}>{children}</pre>;
                      },
                    }}
                  >
                    {displayContent}
                  </ReactMarkdown>
                </div>
              )}
            </div>
            {!collapsed && !parsedApiError && (isOverflowing || !contentExpanded) && (
              <div className="flex items-center gap-1 mt-2">
                <button
                  onClick={() => setFullscreen(true)}
                  className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-cyan transition-colors flex items-center gap-1"
                  title="Fullscreen"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                  </svg>
                  <span className="hidden sm:inline text-xs text-sol-text-dim">Full Screen</span>
                </button>
                <button
                  onClick={() => setContentExpanded(e => !e)}
                  className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-cyan transition-colors"
                  title={contentExpanded ? "Collapse" : "Expand"}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    {contentExpanded ? (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    )}
                  </svg>
                </button>
              </div>
            )}
          </>
        )}

        {fullscreen && createPortal(
          <div className="fixed inset-0 z-[9999] bg-sol-bg overflow-auto" onClick={() => setFullscreen(false)}>
            <div className="max-w-4xl mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-6">
                <span className="text-sol-text-secondary text-sm font-medium">Message</span>
                <button
                  onClick={() => setFullscreen(false)}
                  className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                  title="Close"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="prose prose-invert prose-sm max-w-none text-sol-text">
                {parsedApiError ? (
                  <ApiErrorCard error={parsedApiError} />
                ) : (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                      img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
                      pre: ({ node, children, ...props }) => {
                        const codeElement = node?.children?.[0];
                        if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
                          const className = codeElement.properties?.className as string[] | undefined;
                          const language = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
                          const codeContent = codeElement.children?.[0];
                          const code = codeContent && 'value' in codeContent ? String(codeContent.value) : '';
                          if (code) {
                            return <CodeBlock code={code} language={language} />;
                          }
                        }
                        return <pre {...props}>{children}</pre>;
                      },
                    }}
                  >
                    {displayContent}
                  </ReactMarkdown>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}

        {collapsed && onToggleCollapsed && (
          <button
            onClick={onToggleCollapsed}
            className="text-xs text-sol-text-dim hover:text-sol-text-muted mt-1 transition-colors"
          >
            Expand
          </button>
        )}
        {showCollapseButton && onToggleCollapsed && (
          <button
            onClick={onToggleCollapsed}
            className="text-xs text-sol-text-dim hover:text-sol-text-muted mt-1 transition-colors"
          >
            Collapse
          </button>
        )}
      </div>

      {forkChildren && forkChildren.length > 0 && onBranchSwitch && (
        <BranchSelector
          forkChildren={forkChildren}
          activeBranchId={activeBranchId ?? null}
          onSwitchBranch={(convId) => onBranchSwitch(convId)}
          loadingBranchId={loadingBranchId}
          mainMessageCount={mainMessageCount}
        />
      )}
    </div>
  );
}

function ToolResultMessage({ toolResults, toolName }: { toolResults: ToolResult[]; toolName?: string }) {
  // Don't render separate result messages - results are shown inline with tool calls
  // This component was showing duplicate content with the 1→ line number format
  return null;
}

function SystemBlock({ content, subtype, timestamp, messageUuid, messageId, conversationId, onOpenComments, onStartShareSelection }: { content: string; subtype?: string; timestamp?: number; messageUuid?: string; messageId?: string; conversationId?: Id<"conversations">; onOpenComments?: () => void; onStartShareSelection?: (messageId: string) => void }) {
  if (subtype === "compact_boundary") {
    return (
      <div className="my-6 flex items-center gap-3">
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent" />
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/30">
          <svg className="w-3.5 h-3.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <span className="text-xs text-amber-500 font-medium">Context compacted</span>
        </div>
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent" />
      </div>
    );
  }

  if (subtype === "compaction_summary" && content) {
    return <CompactionSummaryBlock content={content} />;
  }

  if (subtype === "plan" && content) {
    return <PlanBlock content={content} timestamp={timestamp || Date.now()} messageId={messageId} conversationId={conversationId} onOpenComments={onOpenComments} onStartShareSelection={onStartShareSelection} />;
  }

  if (subtype === "pull_request" && content) {
    const prMatch = content.match(/^#(\d+)\s+(.*)/);
    const prNum = prMatch ? prMatch[1] : "";
    const prTitle = prMatch ? prMatch[2] : content;
    return (
      <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-sol-violet/5 border border-sol-violet/20 rounded text-xs">
        <svg className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
        {prNum && <span className="text-sol-violet font-mono font-medium">#{prNum}</span>}
        <span className="text-sol-text-secondary truncate">{prTitle}</span>
        {timestamp && <span className="text-sol-text-dim ml-auto flex-shrink-0">{formatRelativeTime(timestamp)}</span>}
      </div>
    );
  }

  if (subtype === "commit" && content) {
    const sha = messageUuid?.slice(0, 7) || "";
    return (
      <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-emerald-500/5 border border-emerald-500/20 rounded text-xs">
        <svg className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m0 0l4-4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
        {sha && <span className="text-emerald-500 font-mono font-medium">{sha}</span>}
        <span className="text-sol-text-secondary truncate">{content}</span>
        {timestamp && <span className="text-sol-text-dim ml-auto flex-shrink-0">{formatRelativeTime(timestamp)}</span>}
      </div>
    );
  }

  if ((subtype === "stop_hook_summary" || subtype === "local_command") && content) {
    const label = subtype === "stop_hook_summary" ? "hook" : "command";
    const trimmed = content.slice(0, 200);
    return (
      <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-sol-bg-alt/30 border-l-2 border-sol-border text-xs">
        <span className="text-[10px] text-sol-text-dim bg-sol-bg-highlight px-1.5 py-0.5 rounded font-mono">{label}</span>
        <span className="text-sol-text-muted font-mono truncate">{trimmed}</span>
      </div>
    );
  }

  const cleanText = content.replace(/<[^>]+>/g, "").slice(0, 200);
  if (!cleanText) return null;

  return (
    <div className="mb-4 px-3 py-2 bg-sol-bg-alt/20 border-l-2 border-sol-border text-xs">
      {subtype && (
        <span className="text-sol-text-dim text-[10px] mr-2">
          {subtype.replace(/_/g, " ")}
        </span>
      )}
      <span className="text-sol-text-muted font-mono">
        {cleanText}
        {content.length > 200 && "..."}
      </span>
    </div>
  );
}

function CompactionSummaryBlock({ content }: { content: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="mb-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-xs text-sol-text-dim hover:text-sol-text-muted transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-amber-500/70">Previous context summary</span>
      </button>
      {isExpanded && (
        <div className="mt-2 px-3 py-2 bg-sol-bg-alt/20 border-l-2 border-amber-500/30 text-xs prose prose-invert prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} /> }}>
            {content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

const PLAN_MAX_HEIGHT = 1800;

function PlanBlock({ content, timestamp, collapsed, messageId, conversationId, onOpenComments, onStartShareSelection }: { content: string; timestamp: number; collapsed?: boolean; messageId?: string; conversationId?: Id<"conversations">; onOpenComments?: () => void; onStartShareSelection?: (messageId: string) => void }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  const isRealMessageId = messageId && !messageId.startsWith("optimistic_");
  const commentCount = useQuery(api.comments.getCommentCount,
    isRealMessageId ? { message_id: messageId as Id<"messages"> } : "skip"
  );
  const isBookmarked = useQuery(
    api.bookmarks.isBookmarked,
    isRealMessageId ? { message_id: messageId as Id<"messages"> } : "skip"
  );
  const toggleBookmark = useMutation(api.bookmarks.toggleBookmark);

  useEffect(() => {
    if (contentRef.current && !isExpanded) {
      setIsOverflowing(contentRef.current.scrollHeight > PLAN_MAX_HEIGHT);
    }
  }, [content, isExpanded]);

  useEffect(() => {
    if (!fullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [fullscreen]);

  const handleCopy = () => {
    setTimeout(() => { copyToClipboard(content || "").then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  const handleCopyLink = () => {
    const url = `${window.location.origin}${window.location.pathname}#msg-${messageId}`;
    setTimeout(() => { copyToClipboard(url).then(() => toast.success("Link copied!")).catch(() => toast.error("Failed to copy link")); });
  };

  const handleToggleBookmark = async () => {
    if (!conversationId || !messageId) return;
    try {
      const result = await toggleBookmark({
        conversation_id: conversationId,
        message_id: messageId as Id<"messages">,
      });
      toast.success(result ? "Bookmarked!" : "Bookmark removed");
    } catch {
      toast.error("Failed to toggle bookmark");
    }
  };

  const title = content.match(/^#\s+(.+)$/m)?.[1] || "Plan";

  if (collapsed) {
    return (
      <div className="mb-2 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-sol-text-muted">
          <svg className="w-3.5 h-3.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          <span className="font-medium">{title}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="group/plan relative mb-6 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-sol-border/40">
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          <span className="text-xs font-medium text-sol-text-muted">Plan</span>
          <span className="text-xs text-sol-text-dim">{formatRelativeTime(timestamp)}</span>
        </div>
        <div className="flex items-center gap-0.5">
          {onStartShareSelection && messageId && (
            <button onClick={() => onStartShareSelection(messageId)} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Share">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            </button>
          )}
          {messageId && (
            <button onClick={handleCopyLink} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Copy link">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
            </button>
          )}
          {isRealMessageId && conversationId && (
            <button onClick={handleToggleBookmark} className={`p-1 rounded hover:bg-sol-bg-highlight ${isBookmarked ? "text-amber-400" : "text-sol-text-dim hover:text-sol-text-muted"} transition-colors`} title={isBookmarked ? "Remove bookmark" : "Bookmark"}>
              <svg className="w-3.5 h-3.5" fill={isBookmarked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
            </button>
          )}
          {onOpenComments && (
            <button onClick={onOpenComments} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors flex items-center gap-0.5" title="Comments">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
              {commentCount !== undefined && commentCount > 0 && (
                <span className="text-[10px]">{commentCount}</span>
              )}
            </button>
          )}
          <button onClick={handleCopy} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Copy">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
          <button onClick={() => setFullscreen(true)} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Fullscreen">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
        </div>
      </div>
      <div className="px-4 py-3">
        <div
          ref={contentRef}
          className="relative prose prose-invert prose-sm max-w-none"
          style={!isExpanded && isOverflowing ? { maxHeight: PLAN_MAX_HEIGHT, overflow: 'hidden', maskImage: 'linear-gradient(to bottom, black calc(100% - 5rem), transparent)', WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 5rem), transparent)' } : undefined}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
              pre: ({ node, children, ...props }) => {
                const codeElement = node?.children?.[0];
                if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
                  const className = codeElement.properties?.className as string[] | undefined;
                  const language = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
                  const codeContent = codeElement.children?.[0];
                  const code = codeContent && 'value' in codeContent ? String(codeContent.value) : '';
                  if (code) {
                    return <CodeBlock code={code} language={language} />;
                  }
                }
                return <pre {...props}>{children}</pre>;
              },
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
        {(isOverflowing || isExpanded) && (
          <div className="flex items-center gap-3 mt-2 pt-2 border-t border-sol-border/30">
            <button
              onClick={() => setIsExpanded(e => !e)}
              className="text-sm font-medium text-sol-cyan hover:text-sol-cyan/80 transition-colors"
            >
              {isExpanded ? "Collapse" : "Expand"}
            </button>
            <button
              onClick={() => setFullscreen(true)}
              className="text-sm font-medium text-sol-cyan hover:text-sol-cyan/80 transition-colors"
            >
              Fullscreen
            </button>
          </div>
        )}
      </div>

      {fullscreen && createPortal(
        <div className="fixed inset-0 z-[9999] bg-sol-bg overflow-auto" onClick={() => setFullscreen(false)}>
          <div className="max-w-4xl mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
                <span className="text-sol-text-secondary text-sm font-medium">Plan</span>
              </div>
              <button
                onClick={() => setFullscreen(false)}
                className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                title="Close"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="prose prose-invert prose-sm max-w-none text-sol-text">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
                  pre: ({ node, children, ...props }) => {
                    const codeElement = node?.children?.[0];
                    if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
                      const className = codeElement.properties?.className as string[] | undefined;
                      const language = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
                      const codeContent = codeElement.children?.[0];
                      const code = codeContent && 'value' in codeContent ? String(codeContent.value) : '';
                      if (code) {
                        return <CodeBlock code={code} language={language} />;
                      }
                    }
                    return <pre {...props}>{children}</pre>;
                  },
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          </div>
        </div>,
        document.body
      )}

    </div>
  );
}

function GitBranchBadge({
  gitBranch,
  gitStatus,
  gitRemoteUrl,
  hasDiff,
  diffExpanded,
  onToggleDiff,
}: {
  gitBranch: string;
  gitStatus?: string | null;
  gitRemoteUrl?: string | null;
  hasDiff: boolean;
  diffExpanded: boolean;
  onToggleDiff: () => void;
}) {
  const isClean = gitStatus === "(clean)" || gitStatus === "clean" || !gitStatus;

  const githubUrl = gitRemoteUrl
    ? (() => {
        const match = gitRemoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
        if (match) {
          return `https://github.com/${match[1]}/tree/${gitBranch}`;
        }
        return null;
      })()
    : null;

  return (
    <button
      onClick={() => hasDiff && onToggleDiff()}
      className={`font-mono text-[11px] text-sol-text-muted flex-shrink-0 ${hasDiff ? "cursor-pointer hover:text-sol-text-secondary" : "cursor-default"}`}
      title={hasDiff ? (diffExpanded ? "hide diff" : "show diff") : undefined}
    >
      (
      {githubUrl ? (
        <a
          href={githubUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sol-green hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {gitBranch}
        </a>
      ) : (
        <span className="text-sol-green">{gitBranch}</span>
      )}
      {!isClean && <span className="text-sol-orange ml-0.5">*</span>})
    </button>
  );
}

function GitDiffPanel({
  gitDiff,
  gitDiffStaged,
}: {
  gitDiff?: string | null;
  gitDiffStaged?: string | null;
}) {
  return (
    <div className="border-t border-sol-border bg-sol-bg-alt/30">
      <div className="max-w-4xl mx-auto px-4 py-2 max-h-96 overflow-y-auto">
        {gitDiffStaged && gitDiffStaged.trim().length > 0 && (
          <div className="mb-2">
            <div className="text-sol-green text-[10px] font-semibold mb-1">Staged</div>
            <div className="rounded overflow-hidden bg-sol-bg-alt border border-sol-border/30">
              <GitDiffView diff={gitDiffStaged} />
            </div>
          </div>
        )}
        {gitDiff && gitDiff.trim().length > 0 && (
          <div>
            {gitDiffStaged && gitDiffStaged.trim().length > 0 && (
              <div className="text-sol-orange text-[10px] font-semibold mb-1">Unstaged</div>
            )}
            <div className="rounded overflow-hidden bg-sol-bg-alt border border-sol-border/30">
              <GitDiffView diff={gitDiff} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function GitDiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');

  return (
    <div className="font-mono text-xs p-2 overflow-x-auto scrollbar-auto">
      <div className="min-w-fit">
      {lines.map((line, i) => {
        let className = 'whitespace-pre text-sol-text-muted';

        if (line.startsWith('+') && !line.startsWith('+++')) {
          className = 'whitespace-pre bg-sol-green/10 text-sol-green';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          className = 'whitespace-pre bg-sol-red/10 text-sol-red';
        } else if (line.startsWith('@@')) {
          className = 'whitespace-pre text-sol-blue';
        } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
          className = 'whitespace-pre text-sol-text-secondary font-medium';
        }

        return (
          <div key={i} className={className}>
            {line}
          </div>
        );
      })}
      </div>
    </div>
  );
}

function ShortcutHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sol-text/70">{label}</span>
      <span className="flex items-center gap-0.5">
        {keys.map((k, i) => (
          <kbd key={i} className="px-1 py-px rounded border border-sol-border/40 bg-sol-bg-alt text-[9px] font-mono leading-tight min-w-[18px] text-center">{k}</kbd>
        ))}
      </span>
    </div>
  );
}

const MessageInput = memo(function MessageInput({ conversationId, status, embedded, onSendAndAdvance, autoFocusInput, initialDraft, isWaitingForResponse, isThinking, isConversationLive, sessionId, agentType, agentStatus, selectedMessageContent, selectedMessageUuid, onClearSelection, onForkFromMessage }: { conversationId: string; status?: string; embedded?: boolean; onSendAndAdvance?: () => void; autoFocusInput?: boolean; initialDraft?: string; isWaitingForResponse?: boolean; isThinking?: boolean; isConversationLive?: boolean; sessionId?: string; agentType?: string; agentStatus?: "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected"; selectedMessageContent?: string | null; selectedMessageUuid?: string | null; onClearSelection?: () => void; onForkFromMessage?: (uuid: string) => void }) {
  const cached = useInboxStore.getState().getDraft(conversationId);
  const [message, setMessage] = useState(() => cached?.draft_message ?? initialDraft ?? "");
  const messageRef = useRef(message);
  messageRef.current = message;
  const convIdRef = useRef(conversationId);
  const [isWaitingForUpload, setIsWaitingForUpload] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [shortcutTooltip, setShortcutTooltip] = useState<{ x: number; y: number } | null>(null);
  const [pendingMessageId, setPendingMessageId] = useState<Id<"pending_messages"> | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [showStuckBanner, setShowStuckBanner] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const resumeSessionMutation = useMutation(api.users.resumeSession);
  const getRealId = useInboxStore((s) => s.getRealId);
  const addOptimistic = useInboxStore((s) => s.addOptimisticMessage);

  const messageStatus = useQuery(
    api.pendingMessages.getMessageStatus,
    pendingMessageId ? { message_id: pendingMessageId } : "skip"
  );

  const realId = getRealId(conversationId);
  const isRealConvId = realId.length > 10 && !realId.startsWith("pending-") && !realId.startsWith("temp_");
  const existingPending = useQuery(
    api.pendingMessages.getConversationPendingMessage,
    isRealConvId ? { conversation_id: realId as Id<"conversations"> } : "skip"
  );

  useEffect(() => {
    if (pendingMessageId) return;
    if (!existingPending) {
      if (!isWaitingForResponse) setShowStuckBanner(false);
      return;
    }
    const age = Date.now() - existingPending.created_at;
    if (age > 15_000) {
      setShowStuckBanner(true);
    } else {
      const timer = setTimeout(() => setShowStuckBanner(true), 15_000 - age);
      return () => clearTimeout(timer);
    }
  }, [existingPending, pendingMessageId, isWaitingForResponse]);

  useEffect(() => {
    if (!sentAt || !pendingMessageId) return;
    if (messageStatus?.status === "delivered") {
      setPendingMessageId(null);
      setSentAt(null);
      setShowStuckBanner(false);
      return;
    }
    const timer = setTimeout(() => {
      if (messageStatus?.status === "pending") {
        setShowStuckBanner(true);
      }
    }, 15_000);
    return () => clearTimeout(timer);
  }, [sentAt, pendingMessageId, messageStatus?.status]);

  // Removed: generic 60s timeout was showing "not responding" even when no message was sent.
  // The banner should only show when we sent a message and it wasn't delivered (handled by the effects above).

  const sendRef = useRef<HTMLDivElement>(null);
  const pastedImagesRef = useRef<Array<{ file: File; previewUrl: string; storageId?: Id<"_storage">; uploading: boolean }>>([]);
  const [pastedImages, setPastedImages] = useState<Array<{ file: File; previewUrl: string; storageId?: Id<"_storage">; uploading: boolean }>>(() => {
    if (cached?.draft_image_storage_ids) {
      return (cached.draft_image_storage_ids as Array<{ storageId: string; previewUrl: string; name: string }>).map(img => ({
        file: new File([], img.name || "image"),
        previewUrl: img.previewUrl || "",
        storageId: img.storageId as Id<"_storage">,
        uploading: false,
      }));
    }
    if (cached?.draft_image_storage_id) {
      return [{ file: new File([], cached.draft_image_name || "image"), previewUrl: cached.draft_image_preview || "", storageId: cached.draft_image_storage_id, uploading: false }];
    }
    return [];
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendMessage = useMutation(api.pendingMessages.sendMessageToSession);
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);
  pastedImagesRef.current = pastedImages;

  const handleForceResume = useCallback(async () => {
    if (isResuming) return;
    setIsResuming(true);
    try {
      const realId = getRealId(conversationId);
      await resumeSessionMutation({ conversation_id: realId as Id<"conversations"> });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resume session");
      setIsResuming(false);
    }
  }, [conversationId, getRealId, resumeSessionMutation, isResuming]);

  useEffect(() => {
    if (isResuming && (isConversationLive || isThinking)) {
      setIsResuming(false);
      setShowStuckBanner(false);
      return;
    }
    if (!isResuming) return;
    const timeout = setTimeout(() => {
      setIsResuming(false);
      toast.error("Resume timed out — session may need manual restart");
    }, 30_000);
    return () => clearTimeout(timeout);
  }, [isResuming, isConversationLive, isThinking]);

  const updateDraft = useCallback((text: string, images?: Array<{ storageId?: string; previewUrl?: string; name?: string }> | null) => {
    if (!text && (!images || images.length === 0)) {
      useInboxStore.getState().clearDraft(conversationId);
    } else {
      useInboxStore.getState().setDraft(conversationId, {
        draft_message: text || null,
        draft_image_storage_ids: images && images.length > 0 ? images : null,
      });
    }
  }, [conversationId]);

  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (convIdRef.current !== conversationId) {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      const currentMsg = messageRef.current;
      if (currentMsg) {
        useInboxStore.getState().setDraft(conversationId, {
          ...useInboxStore.getState().getDraft(conversationId),
          draft_message: currentMsg,
        });
      }
      convIdRef.current = conversationId;
    }
  }, [conversationId]);

  useEffect(() => () => {
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    const msg = messageRef.current;
    const id = convIdRef.current;
    if (msg) {
      useInboxStore.getState().setDraft(id, {
        ...useInboxStore.getState().getDraft(id),
        draft_message: msg,
      });
    }
  }, []);

  const handleMessageChange = useCallback((val: string) => {
    setMessage(val);
    if (savedDraftRef.current !== null) {
      isSelectionEditedRef.current = true;
    }
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      const existing = useInboxStore.getState().getDraft(conversationId);
      if (!val && !existing?.draft_image_storage_ids?.length) {
        useInboxStore.getState().clearDraft(conversationId);
      } else {
        useInboxStore.getState().setDraft(conversationId, { ...existing, draft_message: val || null });
      }
    }, 300);
  }, [conversationId]);

  const isSelectionActive = !!(selectedMessageContent && selectedMessageUuid);
  const savedDraftRef = useRef<string | null>(null);
  const isSelectionEditedRef = useRef(false);
  const prevSelectionRef = useRef<string | null>(null);

  useEffect(() => {
    const wasActive = prevSelectionRef.current !== null;
    const isActive = !!(selectedMessageContent && selectedMessageUuid);
    prevSelectionRef.current = selectedMessageUuid || null;

    if (isActive && !wasActive) {
      savedDraftRef.current = message;
      isSelectionEditedRef.current = false;
      setMessage(selectedMessageContent);
    } else if (isActive && wasActive) {
      setMessage(selectedMessageContent);
    } else if (!isActive && wasActive) {
      const restored = savedDraftRef.current ?? "";
      savedDraftRef.current = null;
      isSelectionEditedRef.current = false;
      setMessage(restored);
    }
  }, [selectedMessageContent, selectedMessageUuid]);

  const isInactive = status && status !== "active";
  const hasContent = message.trim().length > 0 || pastedImages.length > 0;
  const isExpanded = !!onSendAndAdvance || isFocused || message.length > 0 || pastedImages.length > 0;

  const resetTextareaHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  };

  useEffect(() => {
    resetTextareaHeight();
  }, [message]);

  const mountConvIdRef = useRef(conversationId);
  useEffect(() => {
    if (textareaRef.current) {
      const isIdTransition = mountConvIdRef.current !== conversationId;
      mountConvIdRef.current = conversationId;
      if (isIdTransition) {
        if (autoFocusInput) textareaRef.current.focus();
        return;
      }
      const len = textareaRef.current.value.length;
      if (len > 0) {
        textareaRef.current.focus();
        textareaRef.current.select();
      } else if (autoFocusInput) {
        textareaRef.current.focus();
      }
    }
  }, [autoFocusInput, conversationId]);

  const clearImage = useCallback((index: number) => {
    setPastedImages(prev => {
      const img = prev[index];
      if (img) URL.revokeObjectURL(img.previewUrl);
      const next = prev.filter((_, i) => i !== index);
      updateDraft(message, next.length > 0 ? next.map(i => ({ storageId: i.storageId as string, previewUrl: i.previewUrl, name: i.file.name })) : null);
      return next;
    });
  }, [updateDraft, message]);

  const clearAllImages = useCallback(() => {
    pastedImages.forEach(img => URL.revokeObjectURL(img.previewUrl));
    setPastedImages([]);
    updateDraft(message, null);
  }, [pastedImages, updateDraft, message]);

  const uploadImage = useCallback(async (file: File) => {
    const previewUrl = URL.createObjectURL(file);
    const placeholder = { file, previewUrl, uploading: true };
    setPastedImages(prev => [...prev, placeholder]);
    try {
      const uploadUrl = await generateUploadUrl({});
      const result = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const { storageId } = await result.json();
      setPastedImages(prev => {
        const next = prev.map(img => img.previewUrl === previewUrl ? { ...img, storageId, uploading: false } : img);
        updateDraft(message, next.map(i => ({ storageId: i.storageId as string, previewUrl: i.previewUrl, name: i.file.name })));
        return next;
      });
    } catch {
      toast.error("Failed to upload image");
      URL.revokeObjectURL(previewUrl);
      setPastedImages(prev => prev.filter(img => img.previewUrl !== previewUrl));
    }
  }, [generateUploadUrl, updateDraft, message]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let hasImage = false;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        if (!hasImage) { e.preventDefault(); hasImage = true; }
        const file = items[i].getAsFile();
        if (file) uploadImage(file);
      }
    }
  }, [uploadImage]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const hasUploadingImages = pastedImages.some(img => img.uploading);
    const readyImages = pastedImages.filter(img => !img.uploading && img.storageId);
    const canSend = message.trim() || readyImages.length > 0 || hasUploadingImages;
    if (!canSend) return;

    if (hasUploadingImages) {
      setIsWaitingForUpload(true);
      const waitForUploads = () => new Promise<void>((resolve) => {
        const check = () => {
          const current = pastedImagesRef.current;
          if (current.every(img => !img.uploading)) {
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
      await waitForUploads();
      setIsWaitingForUpload(false);
    }

    const finalImages = pastedImagesRef.current.filter(img => !img.uploading && img.storageId);
    const finalCanSend = message.trim() || finalImages.length > 0;
    if (!finalCanSend) return;

    // If a message is selected, fork from it then send the new content
    if (isSelectionActive && selectedMessageUuid && onForkFromMessage) {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      isSelectionEditedRef.current = true;
      savedDraftRef.current = null;
      const content = message.trim();
      setMessage("");
      onClearSelection?.();
      await onForkFromMessage(selectedMessageUuid);
      requestAnimationFrame(async () => {
        try {
          const branches = useInboxStore.getState().activeBranches;
          const forkId = Object.values(branches)[0];
          if (!forkId) return;
          const realId = useInboxStore.getState().getRealId(forkId);
          if (realId.startsWith("temp_")) return;
          const msgId = await sendMessage({
            conversation_id: realId as Id<"conversations">,
            content,
          });
          setPendingMessageId(msgId);
          setSentAt(Date.now());
          addOptimistic(realId, content);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Failed to send rewrite");
        }
      });
      return;
    }

    const realId = getRealId(conversationId);
    if (realId.startsWith("temp_")) {
      toast.error("Session is still being created, please try again in a moment");
      return;
    }
    const trimmed = message.trim() || (finalImages.length > 0 ? "[image]" : "");
    const storageIds = finalImages.map(img => img.storageId!);
    const optimisticImages = finalImages.map(img => ({ media_type: img.file.type, storage_id: img.storageId as string }));
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    addOptimistic(realId, trimmed, optimisticImages.length > 0 ? optimisticImages : undefined);
    setMessage("");
    clearAllImages();
    updateDraft("", null);
    requestAnimationFrame(() => textareaRef.current?.focus());

    try {
      const msgId = await sendMessage({
        conversation_id: realId as Id<"conversations">,
        content: trimmed,
        image_storage_ids: storageIds.length > 0 ? storageIds : undefined,
      });
      setPendingMessageId(msgId);
      setSentAt(Date.now());
      setShowStuckBanner(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send message");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && e.altKey && onSendAndAdvance) {
      e.preventDefault();
      handleSubmit(e).then(() => onSendAndAdvance());
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const canSubmit = hasContent && !isWaitingForUpload;

  return (
    <div className="shrink-0 z-40 pointer-events-none sticky bottom-0">
      <div className="h-16 bg-gradient-to-t from-sol-bg via-sol-bg/80 to-transparent -mt-16 relative" />
      <div className="bg-sol-bg pb-4 pointer-events-auto">
        <div className="relative">
          {(isFocused || shortcutTooltip || showStuckBanner || (agentStatus && agentStatus !== "idle") || (!agentStatus && (isWaitingForResponse || isThinking || isConversationLive))) && (
            <div className={`mx-auto px-4 mb-1 flex justify-between items-center ${isExpanded ? "max-w-4xl" : "max-w-md"}`}>
              <p className="text-[11px] text-sol-text-dim/70">
                {showStuckBanner && sessionId ? (
                  isResuming ? (
                    <span className="flex items-center gap-1.5 text-sol-orange">
                      <span className="w-1.5 h-1.5 rounded-full bg-sol-orange animate-pulse" />
                      Resuming session — waiting for daemon to reconnect...
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-sol-orange">
                      <span className="w-1.5 h-1.5 rounded-full bg-sol-orange" />
                      {existingPending || pendingMessageId ? "Message not reaching session" : "Session not responding"}
                      <button
                        type="button"
                        onClick={handleForceResume}
                        className="ml-1 px-1.5 py-0.5 rounded bg-sol-orange/10 hover:bg-sol-orange/20 border border-sol-orange/30 text-sol-orange transition-colors text-[10px]"
                      >
                        Force resume
                      </button>
                    </span>
                  )
                ) : agentStatus === "thinking" ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-sol-violet/50 animate-pulse" />
                    Thinking...
                  </span>
                ) : agentStatus === "compacting" ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60 animate-pulse" />
                    Compacting...
                  </span>
                ) : agentStatus === "permission_blocked" ? (
                  <span className="flex items-center gap-1.5 text-sol-orange">
                    <span className="w-1.5 h-1.5 rounded-full bg-sol-orange animate-pulse" />
                    Permission needed
                  </span>
                ) : agentStatus === "connected" ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Connected
                  </span>
                ) : agentStatus === "working" ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Working
                  </span>
                ) : agentStatus === "idle" ? (
                  "\u00A0"
                ) : isThinking ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-sol-violet/50 animate-pulse" />
                    Thinking...
                  </span>
                ) : isWaitingForResponse ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Connecting...
                  </span>
                ) : isConversationLive ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Working
                  </span>
                ) : isInactive ? "Session inactive — message to resume in new terminal" : "\u00A0"}
              </p>
              <div className="flex items-center gap-2">
                <p className="text-[11px] opacity-[0.55] hidden sm:flex items-center gap-1">
                  <kbd className="px-1 py-0.5 rounded border border-current/40 text-[10px] leading-none font-semibold bg-sol-bg/50">Alt</kbd>
                  <span className="text-[9px]">+</span>
                  <kbd className="px-1 py-0.5 rounded border border-current/40 text-[10px] leading-none font-semibold bg-sol-bg/50">↵</kbd>
                  <span className="ml-1.5 text-[10px] opacity-80">reply and advance</span>
                </p>
                <button
                  type="button"
                  onClick={() => {
                    const rect = sendRef.current?.getBoundingClientRect();
                    if (rect) setShortcutTooltip(prev => prev ? null : { x: rect.right, y: rect.top });
                  }}
                  onMouseEnter={() => {
                    const rect = sendRef.current?.getBoundingClientRect();
                    if (rect) setShortcutTooltip({ x: rect.right, y: rect.top });
                  }}
                  onMouseLeave={(e) => {
                    const related = e.relatedTarget as Element | null;
                    if (!related?.closest?.('[data-shortcut-tooltip]')) setShortcutTooltip(null);
                  }}
                  className="text-[9px] text-sol-text-dim hover:text-sol-text transition-colors w-4 h-4 flex items-center justify-center rounded-full border border-sol-text-dim/50 hover:border-sol-text-dim bg-sol-bg-alt font-semibold"
                >
                  ?
                </button>
              </div>
            </div>
          )}
          <form onSubmit={handleSubmit} className={`mx-auto px-2 sm:px-4 transition-all duration-200 ease-out ${isExpanded ? "max-w-4xl" : "max-w-md"}`}>
            <div className={`flex flex-col bg-sol-bg-alt border px-4 py-2 shadow-lg transition-all duration-200 ${isExpanded ? "rounded-2xl" : "rounded-full"} ${isSelectionActive ? "border-sol-cyan/40 ring-1 ring-sol-cyan/20" : "border-sol-border"}`}>
              {isSelectionActive && (
                <div className="flex items-center gap-2 pb-1.5 mb-1.5 border-b border-sol-cyan/20 text-[10px] text-sol-cyan">
                  <span className="font-medium">Rewriting message</span>
                  <span className="text-sol-text-dim">Enter to fork &amp; send</span>
                  <span className="text-sol-text-dim">Esc to cancel</span>
                </div>
              )}
              {pastedImages.length > 0 && (
                <div className="flex items-center gap-2 pb-2 mb-2 border-b border-sol-border/50 flex-wrap">
                  {pastedImages.map((img, idx) => (
                    <div key={idx} className="relative group">
                      <div className="relative h-16 w-16 rounded-lg overflow-hidden bg-sol-bg shrink-0">
                        <img src={img.previewUrl} alt="Pasted" className="h-full w-full object-cover" />
                        {img.uploading && (
                          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                            <svg className="w-5 h-5 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                          </div>
                        )}
                      </div>
                      <button type="button" onClick={() => clearImage(idx)} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-sol-bg-alt border border-sol-border flex items-center justify-center text-sol-text-secondary hover:text-sol-text transition-colors opacity-0 group-hover:opacity-100">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  value={message}
                  onChange={(e) => handleMessageChange(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  onFocus={() => setIsFocused(true)}
                  onBlur={() => setIsFocused(false)}
                  disabled={isWaitingForUpload}
                  placeholder={agentStatus === "permission_blocked" ? "Approve or deny permission to continue..." : "Send a message..."}
                  rows={1}
                  className={`flex-1 bg-transparent text-sm placeholder:text-sol-text-dim focus:outline-none disabled:opacity-50 resize-none overflow-hidden leading-relaxed py-1 ${isSelectionActive && !isSelectionEditedRef.current ? "text-sol-text-dim italic" : "text-sol-text"}`}
                />
                <div ref={sendRef} className="shrink-0">
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className={`w-8 h-8 rounded-full transition-colors flex items-center justify-center border ${!canSubmit ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed" : "border-sol-blue/50 bg-sol-blue/20 text-sol-blue hover:bg-sol-blue/30 hover:border-sol-blue hover:text-sol-blue"}`}
                  >
                    {isWaitingForUpload ? (
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
      {shortcutTooltip && (
        <div
          data-shortcut-tooltip
          className="fixed z-[100] bg-sol-bg border border-sol-border/60 rounded-lg shadow-lg p-3 w-56 transition-opacity duration-150"
          style={{ top: shortcutTooltip.y - 30, left: shortcutTooltip.x, transform: 'translate(-100%, -100%)' }}
          onMouseLeave={() => setShortcutTooltip(null)}
        >
          <div className="text-[10px] font-medium text-sol-text/80 mb-2">Keyboard Shortcuts</div>
          <div className="space-y-1.5 text-[9px] text-sol-text-dim/70">
            <ShortcutHint keys={["Cmd", "K"]} label="Command palette" />
            <ShortcutHint keys={["Ctrl", "I"]} label="Jump to needs input" />
            <ShortcutHint keys={["Ctrl", "J"]} label="Next session" />
            <ShortcutHint keys={["Ctrl", "K"]} label="Previous session" />
            <ShortcutHint keys={["Ctrl", "Tab"]} label="Next session" />
            <ShortcutHint keys={["Shift", "Ctrl", "Tab"]} label="Previous session" />
            <ShortcutHint keys={["Shift", "←"]} label="Defer session" />
            <ShortcutHint keys={["Ctrl", "←"]} label="Dismiss session" />
            <ShortcutHint keys={["Esc"]} label="Escape to session" />
            <ShortcutHint keys={["Cmd", "Shift", "C"]} label="Collapse tool blocks" />
            <ShortcutHint keys={["Ctrl", "."]} label="Zen mode" />
            <div className="border-t border-sol-border/20 my-1.5" />
            <ShortcutHint keys={["Shift", "Enter"]} label="New line" />
            <ShortcutHint keys={["Alt", "Enter"]} label="Reply and advance" />
            <ShortcutHint keys={["Enter"]} label="Send message" />
          </div>
        </div>
      )}
    </div>
  );
});

export const ConversationView = forwardRef<ConversationViewHandle, ConversationViewProps>(
  function ConversationView({ conversation, commits = [], pullRequests = [], backHref, backLabel = "Back", headerExtra, hasMoreAbove, hasMoreBelow, isLoadingOlder, isLoadingNewer, onLoadOlder, onLoadNewer, onJumpToStart, onJumpToEnd, highlightQuery, onClearHighlight, embedded, showMessageInput = true, targetMessageId, isOwner = true, onSendAndAdvance, autoFocusInput, fallbackStickyContent }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolled, _setUserScrolled] = useState(false);
  const userScrolledRef = useRef(false);
  const setUserScrolled = useCallback((v: boolean) => { userScrolledRef.current = v; _setUserScrolled(v); }, []);
  const [isNearTop, setIsNearTop] = useState(true);
  const [isScrollable, setIsScrollable] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [expandedSequences, setExpandedSequences] = useState<Set<string>>(new Set());
  const [diffExpanded, setDiffExpanded] = useState(false);
  const [commentMessageId, setCommentMessageId] = useState<Id<"messages"> | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [allMatchingMessageIds, setAllMatchingMessageIds] = useState<string[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const scrollAnchorRef = useRef<{ messageId: string; pixelOffset: number } | null>(null);
  const prevTimelineLengthRef = useRef<number>(0);
  const isNearBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const scrollProgressRef = useRef<HTMLDivElement>(null);
  const hasScrolledToTarget = useRef(false);
  const jumpDirectionRef = useRef<'start' | 'end' | null>(null);
  const isPaginatingRef = useRef(false);
  const paginationCooldownRef = useRef(false);
  const knownItemIdsRef = useRef<Set<string>>(new Set());
  const newItemIdsRef = useRef<Set<string>>(new Set());
  const [shareSelectionMode, setShareSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [isCreatingShareLink, setIsCreatingShareLink] = useState(false);
  const [stickyMsgVisible, setStickyMsgVisible] = useState(false);
  const prevStickyMsgIdRef = useRef<string | null>(null);
  const prevStickyIdxRef = useRef<number | null>(null);
  const stickyGapRef = useRef<{ prevIdx: number } | null>(null);
  const dismissedStickyIdsRef = useRef<Set<string>>(new Set());
  const stickyElRef = useRef<HTMLDivElement>(null);
  const [stickyDisabled, setStickyDisabled] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('stickyHeadersDisabled') === 'true';
  });
  const headerRef = useRef<HTMLElement>(null);
  const [headerHeight, setHeaderHeight] = useState(32);
  const messageInputRef = useRef<HTMLDivElement>(null);
  const [messageInputHeight, setMessageInputHeight] = useState(0);

  const pathname = usePathname();
  const convLink = useCallback((id: string) => pathname === "/inbox" ? `/inbox?s=${id}` : `/conversation/${id}`, [pathname]);

  const generateShareLink = useMutation(api.messages.generateMessageShareLink);
  const forkFromMessage = useMutation(api.conversations.forkFromMessage);
  const sendEscape = useMutation(api.conversations.sendEscapeToSession);
  const sendKeys = useMutation(api.conversations.sendKeysToSession);
  const sendInlineMessage = useMutation(api.pendingMessages.sendMessageToSession);
  const toggleFavoriteMutation = useMutation(api.conversations.toggleFavorite);
  const addOptimisticMsg = useInboxStore((s) => s.addOptimisticMessage);

  const handleSendInlineMessage = useCallback(async (content: string) => {
    if (!conversation) return;
    let displayContent = content;
    try {
      const parsed = JSON.parse(content);
      if (parsed.__cc_poll && parsed.display) displayContent = parsed.display;
    } catch {}
    addOptimisticMsg(conversation._id, displayContent);
    try {
      await sendInlineMessage({ conversation_id: conversation._id, content });
    } catch {
      toast.error("Failed to send message");
    }
  }, [conversation, sendInlineMessage, addOptimisticMsg]);
  const managedSession = useQuery(
    api.managedSessions.isSessionManaged,
    conversation && isOwner && conversation.status === "active" && !conversation._id.startsWith("temp_")
      ? { conversation_id: conversation._id }
      : "skip"
  );
  const isSessionLive = managedSession?.managed === true;

  const forkSelectedIndex = useForkNavigationStore((s) => s.selectedIndex);

  useEffect(() => {
    if (!conversation || !isOwner || conversation.status !== "active") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (forkSelectedIndex !== null) return;
      e.preventDefault();
      sendEscape({ conversation_id: conversation._id });
      toast.info("Escape sent to session");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [conversation, isOwner, sendEscape, forkSelectedIndex]);

  useEffect(() => {
    if (!conversation || !isOwner || conversation.status !== "active") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !e.shiftKey) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      e.preventDefault();
      sendKeys({ conversation_id: conversation._id, keys: "BTab" });
      toast.info("Mode toggled");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [conversation, isOwner, sendKeys]);

  const messages = conversation?.messages || [];

  const agentNameToChildMap = conversation?.agent_name_map as Record<string, string> | undefined;

  const optimisticForkChildren = useInboxStore((s) => s.optimisticForkChildren);
  const addOptimisticFork = useInboxStore((s) => s.addOptimisticFork);
  const pruneOptimisticForks = useInboxStore((s) => s.pruneOptimisticForks);

  const forkPointMap = useMemo(() => {
    const map: Record<string, Array<ForkChild>> = {};
    const allForks = [...(conversation?.fork_children || []), ...optimisticForkChildren];
    const seen = new Set<string>();
    for (const fork of allForks) {
      if (seen.has(fork._id)) continue;
      seen.add(fork._id);
      if (fork.parent_message_uuid) {
        if (!map[fork.parent_message_uuid]) map[fork.parent_message_uuid] = [];
        map[fork.parent_message_uuid].push(fork);
      }
    }
    return map;
  }, [conversation?.fork_children, optimisticForkChildren]);

  useEffect(() => {
    if (!conversation?.fork_children) return;
    const serverIds = new Set(conversation.fork_children.map(f => f._id));
    pruneOptimisticForks(serverIds);
  }, [conversation?.fork_children, pruneOptimisticForks]);

  const handleStartShareSelection = useCallback((messageId: string) => {
    setShareSelectionMode(true);
    setSelectedMessageIds(new Set([messageId]));
  }, []);

  const handleToggleMessageSelection = useCallback((messageId: string) => {
    setSelectedMessageIds(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const handleCancelShareSelection = useCallback(() => {
    setShareSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  const handleConfirmShare = useCallback(async () => {
    if (selectedMessageIds.size === 0) return;

    setIsCreatingShareLink(true);
    try {
      const sortedIds = Array.from(selectedMessageIds).sort((a, b) => {
        const msgA = messages.find(m => m._id === a);
        const msgB = messages.find(m => m._id === b);
        return (msgA?.timestamp || 0) - (msgB?.timestamp || 0);
      });

      const token = await generateShareLink({
        message_id: sortedIds[0] as Id<"messages">,
        context_before: 0,
        context_after: 0,
        message_ids: sortedIds as Id<"messages">[],
      });

      const url = `${window.location.origin}/share/message/${token}`;
      await copyToClipboard(url);
      toast.success("Share link copied!");
      setShareSelectionMode(false);
      setSelectedMessageIds(new Set());
    } catch (err) {
      toast.error("Failed to create share link");
    } finally {
      setIsCreatingShareLink(false);
    }
  }, [selectedMessageIds, messages, generateShareLink]);

  const toolCallChangeSelectionMap = useMemo(() => {
    const fileChanges = extractFileChanges(messages as any);
    const map: Record<string, ToolCallChangeSelection> = {};
    for (const change of fileChanges) {
      const key = change.toolCallId || change.id;
      const existing = map[key];
      if (!existing) {
        map[key] = {
          index: change.sequenceIndex,
          range: {
            start: change.sequenceIndex,
            end: change.sequenceIndex,
          },
        };
        continue;
      }
      existing.index = change.sequenceIndex;
      existing.range.end = change.sequenceIndex;
    }
    return map;
  }, [messages]);

  const pendingPermissions = useQuery(
    api.permissions.getPendingPermissions,
    conversation?._id && !conversation._id.startsWith("temp_") ? { conversation_id: conversation._id } : "skip"
  );

  // Fork navigation state (data in inbox store, UI state in forkNavigationStore)
  const activeBranches = useInboxStore((s) => s.activeBranches);
  const inboxMessages = useInboxStore((s) => s.messages);
  const forkSwitchBranch = useInboxStore((s) => s.switchBranch);
  const forkClearBranch = useInboxStore((s) => s.clearBranch);
  const forkSetMessages = useInboxStore((s) => s.setMessages);
  const resolveForkId = useInboxStore((s) => s.resolveForkId);
  const forkTreePanelOpen = useForkNavigationStore((s) => s.treePanelOpen);
  const toggleTreePanel = useForkNavigationStore((s) => s.toggleTreePanel);
  const forkSetSelectedIndex = useForkNavigationStore((s) => s.setSelectedIndex);
  const resetForkNav = useInboxStore((s) => s.resetForkNav);

  const prevConvIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = conversation?._id ?? null;
    if (id && id !== prevConvIdRef.current) {
      if (prevConvIdRef.current !== null) {
        resetForkNav();
        const url = new URL(window.location.href);
        if (url.searchParams.has('branch')) {
          url.searchParams.delete('branch');
          window.history.replaceState({}, '', url.toString());
        }
      }
      prevConvIdRef.current = id;
    }
  }, [conversation?._id, resetForkNav]);

  const handleForkFromMessage = useCallback(async (messageUuid: string) => {
    if (!conversation?._id) return;
    const tempId = `temp_fork_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    addOptimisticFork({
      _id: tempId,
      title: conversation.title ? `Fork: ${conversation.title}` : "Fork",
      started_at: Date.now(),
      username: conversation.user?.name || conversation.user?.email?.split("@")[0],
      parent_message_uuid: messageUuid,
      message_count: 0,
      agent_type: conversation.agent_type,
    });
    forkSetMessages(tempId, []);
    forkSwitchBranch(messageUuid, tempId);
    const url = new URL(window.location.href);
    url.searchParams.set('branch', tempId);
    window.history.replaceState({}, '', url.toString());
    toast.success("Forked -- switched to branch");
    try {
      const result = await forkFromMessage({
        conversation_id: conversation._id.toString(),
        message_uuid: messageUuid,
      });
      resolveForkId(tempId, result.conversation_id);
      const resolvedUrl = new URL(window.location.href);
      resolvedUrl.searchParams.set('branch', result.conversation_id);
      window.history.replaceState({}, '', resolvedUrl.toString());
    } catch (err) {
      forkClearBranch(messageUuid);
      toast.error(err instanceof Error ? err.message : "Failed to fork");
    }
  }, [conversation?._id, conversation?.title, conversation?.user, conversation?.agent_type, forkFromMessage, forkSwitchBranch, forkClearBranch, forkSetMessages, addOptimisticFork, resolveForkId]);

  // Preload branch from URL param
  const urlBranchPreloaded = useRef(false);
  useEffect(() => {
    if (urlBranchPreloaded.current || !conversation?.fork_children) return;
    const url = new URL(window.location.href);
    const branchId = url.searchParams.get('branch');
    if (!branchId) return;
    const fork = conversation.fork_children.find(f => f._id === branchId);
    if (fork?.parent_message_uuid) {
      forkSwitchBranch(fork.parent_message_uuid, branchId);
      urlBranchPreloaded.current = true;
    }
  }, [conversation?.fork_children, forkSwitchBranch]);

  // Load fork messages for the first active branch (scoped to current conversation)
  const firstActiveForkId = useMemo(() => {
    const entries = Object.entries(activeBranches);
    if (entries.length === 0) return null;
    const [, convId] = entries[0];
    const allForks = [...(conversation?.fork_children || []), ...optimisticForkChildren];
    if (!allForks.some(f => f._id === convId)) return null;
    return convId;
  }, [activeBranches, conversation?.fork_children, optimisticForkChildren]);
  const { isLoading: isForkLoading } = useForkMessages(firstActiveForkId);
  const [loadingBranchId, setLoadingBranchId] = useState<string | null>(null);

  // Merge messages, commits, and PRs into a single timeline (with fork branch support)
  type TimelineItem =
    | { type: 'message'; data: Message; timestamp: number }
    | { type: 'commit'; data: Commit; timestamp: number }
    | { type: 'pull_request'; data: PullRequest; timestamp: number };

  const timeline: TimelineItem[] = useMemo(() => {
    return buildCompositeTimeline(
      messages,
      commits,
      pullRequests,
      activeBranches,
      inboxMessages,
    ) as TimelineItem[];
  }, [messages, commits, pullRequests, activeBranches, inboxMessages]);

  const userMsgKindMap = useMemo(() => {
    const map = new Map<string, UserMessageKind>();
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const msg = item.data as Message;
      if (msg.role !== 'user') continue;
      let immediatePrev: Message | null = null;
      for (let j = i - 1; j >= 0; j--) {
        if (timeline[j].type === 'message') { immediatePrev = timeline[j].data as Message; break; }
      }
      let contextPrev: Message | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const p = timeline[j];
        if (p.type !== 'message') continue;
        const pm = p.data as Message;
        if (pm.role === 'user' && pm.tool_results?.length && (!pm.content || !pm.content.trim())) continue;
        if (pm.role === 'user' && pm.content && isCommandMessage(pm.content)) continue;
        contextPrev = pm;
        break;
      }
      map.set(msg._id, classifyUserMessage(msg, conversation?.agent_type, immediatePrev, contextPrev));
    }
    return map;
  }, [timeline, conversation?.agent_type]);

  const isWaitingForResponse = useMemo(() => {
    if (!conversation || conversation.status !== "active" || timeline.length === 0 || hasMoreBelow) return false;
    const last = timeline[timeline.length - 1];
    if (last.type !== 'message') return false;
    const msg = last.data as Message;
    if (msg.role !== 'user') return false;
    const kind = userMsgKindMap.get(msg._id);
    if (kind?.kind === 'interrupt') return false;
    return true;
  }, [conversation, timeline, hasMoreBelow, userMsgKindMap]);

  const isThinking = useMemo(() => {
    if (!conversation || conversation.status !== "active" || timeline.length === 0 || hasMoreBelow) return false;
    const last = timeline[timeline.length - 1];
    if (last.type !== 'message') return false;
    const msg = last.data as Message;
    if (msg.role !== 'assistant') return false;
    const hasThinkingContent = msg.thinking && msg.thinking.trim().length > 0;
    const hasVisibleContent = (msg.content && stripSystemTags(msg.content).trim().length > 0) || (msg.tool_calls && msg.tool_calls.length > 0);
    return !!(hasThinkingContent && !hasVisibleContent);
  }, [conversation, timeline, hasMoreBelow]);

  const stickyUserMsgIndices = useMemo(() => {
    const indices: number[] = [];
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const msg = item.data as Message;
      if (msg.role !== 'user') continue;
      const kind = userMsgKindMap.get(msg._id);
      if (kind && isStickyWorthy(kind)) indices.push(i);
    }
    return indices;
  }, [timeline, userMsgKindMap]);

  const [activeStickyMsg, setActiveStickyMsg] = useState<{ index: number; content: string; id: string } | null>(null);

  useEffect(() => {
    const currentIds = new Set(timeline.map(item => {
      if (item.type === 'message') return (item.data as Message)._id;
      if (item.type === 'commit') return `commit-${(item.data as any).sha || (item.data as any)._id}`;
      return `pr-${(item.data as any)._id}`;
    }));

    if (knownItemIdsRef.current.size > 0 && !isPaginatingRef.current) {
      const fresh = new Set<string>();
      for (const id of currentIds) {
        if (!knownItemIdsRef.current.has(id)) {
          if (!id.startsWith("optimistic_")) {
            const item = timeline.find(i => {
              if (i.type === 'message') return (i.data as Message)._id === id;
              if (i.type === 'commit') return `commit-${(i.data as any).sha || (i.data as any)._id}` === id;
              return `pr-${(i.data as any)._id}` === id;
            });
            if (item?.type === 'message' && (item.data as Message).role === 'user') continue;
          }
          fresh.add(id);
        }
      }
      if (fresh.size > 0 && fresh.size <= 20) {
        newItemIdsRef.current = fresh;
        knownItemIdsRef.current = currentIds;
        const timer = setTimeout(() => { newItemIdsRef.current = new Set(); }, 400);
        return () => clearTimeout(timer);
      }
    }

    knownItemIdsRef.current = currentIds;
  }, [timeline]);

  // Track if we've already scrolled for this highlight query
  const hasScrolledToHighlight = useRef(false);

  // Find all messages matching search query
  useEffect(() => {
    if (!highlightQuery || messages.length === 0) {
      setHighlightedMessageId(null);
      setAllMatchingMessageIds([]);
      setCurrentMatchIndex(0);
      hasScrolledToHighlight.current = false;
      return;
    }
    const terms = parseSearchTerms(highlightQuery);
    if (terms.length === 0) return;

    const matchingIds: string[] = [];
    for (const msg of messages) {
      const content = msg.content?.toLowerCase() || "";
      if (terms.some(term => content.includes(term))) {
        matchingIds.push(msg._id);
      }
    }

    setAllMatchingMessageIds(matchingIds);
    if (matchingIds.length > 0) {
      setHighlightedMessageId(matchingIds[0]);
      setCurrentMatchIndex(0);
    } else {
      setHighlightedMessageId(null);
    }
  }, [highlightQuery, messages]);

  const goToNextMatch = useCallback(() => {
    if (allMatchingMessageIds.length === 0) return;
    const nextIndex = (currentMatchIndex + 1) % allMatchingMessageIds.length;
    setCurrentMatchIndex(nextIndex);
    setHighlightedMessageId(allMatchingMessageIds[nextIndex]);
    hasScrolledToHighlight.current = false;
  }, [allMatchingMessageIds, currentMatchIndex]);

  const goToPrevMatch = useCallback(() => {
    if (allMatchingMessageIds.length === 0) return;
    const prevIndex = currentMatchIndex === 0 ? allMatchingMessageIds.length - 1 : currentMatchIndex - 1;
    setCurrentMatchIndex(prevIndex);
    setHighlightedMessageId(allMatchingMessageIds[prevIndex]);
    hasScrolledToHighlight.current = false;
  }, [allMatchingMessageIds, currentMatchIndex]);

  // Highlight all text occurrences of search query in the DOM
  useEffect(() => {
    if (!highlightQuery || !containerRef.current) return;

    const terms = parseSearchTerms(highlightQuery);
    if (terms.length === 0) return;

    const pattern = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const regex = new RegExp(`(${pattern})`, 'gi');

    const applyHighlights = () => {
      if (!containerRef.current) return;

      // Find text nodes that haven't been processed yet
      const walker = document.createTreeWalker(
        containerRef.current,
        NodeFilter.SHOW_TEXT,
        null
      );

      const textNodes: Text[] = [];
      let node;
      while ((node = walker.nextNode())) {
        // Skip if parent is already a highlight mark or script/style
        const parent = node.parentNode as HTMLElement;
        if (!parent) continue;
        if (parent.hasAttribute?.('data-search-highlight')) continue;
        if (parent.nodeName === 'SCRIPT' || parent.nodeName === 'STYLE' || parent.nodeName === 'MARK') continue;
        textNodes.push(node as Text);
      }

      textNodes.forEach(textNode => {
        const text = textNode.textContent || '';
        if (!regex.test(text)) return;
        regex.lastIndex = 0;

        const parent = textNode.parentNode;
        if (!parent) return;

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let match;

        while ((match = regex.exec(text)) !== null) {
          if (match.index > lastIndex) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
          }
          const mark = document.createElement('mark');
          mark.setAttribute('data-search-highlight', 'true');
          mark.className = 'bg-amber-300/50 text-amber-900 dark:bg-amber-700/40 dark:text-amber-100 rounded px-0.5 font-medium';
          mark.textContent = match[0];
          fragment.appendChild(mark);
          lastIndex = regex.lastIndex;
        }

        if (lastIndex < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }

        if (fragment.childNodes.length > 0) {
          parent.replaceChild(fragment, textNode);
        }
      });
    };

    // Apply highlights initially and on DOM changes (for virtualized content)
    const observer = new MutationObserver(() => {
      requestAnimationFrame(applyHighlights);
    });

    // Initial highlight after a brief delay to let virtualizer render
    const timeoutId = setTimeout(applyHighlights, 100);

    observer.observe(containerRef.current, {
      childList: true,
      subtree: true
    });

    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
      // Cleanup highlights
      if (containerRef.current) {
        const marks = containerRef.current.querySelectorAll('mark[data-search-highlight]');
        marks.forEach(mark => {
          const parent = mark.parentNode;
          if (parent) {
            parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
            parent.normalize();
          }
        });
      }
    };
  }, [highlightQuery]);

  const handleCopyAll = async () => {
    if (!conversation || messages.length === 0) {
      toast.error("No messages to copy");
      return;
    }

    const formattedMessages = messages
      .filter((msg) => {
        if (msg.role === "system") return false;
        if (msg.role === "user") {
          const kind = userMsgKindMap.get(msg._id);
          if (!kind || !isStickyWorthy(kind)) return false;
        }
        return msg.content && msg.content.trim().length > 0;
      })
      .map((msg) => {
        const timestamp = new Date(msg.timestamp).toLocaleString();
        const label = msg.role === "user" ? "User" : "Assistant";
        return `[${timestamp}] ${label}:\n${msg.content}\n`;
      })
      .join("\n");

    try {
      await copyToClipboard(formattedMessages);
      toast.success("Conversation copied to clipboard");
    } catch (err) {
      toast.error("Failed to copy to clipboard");
    }
  };

  const buildResumeCommand = useCallback((targetAgent: "claude" | "codex"): string | null => {
    const sessionId = managedSession?.session_id || conversation?.session_id;
    if (!sessionId || !conversation) return null;
    const projectDir = conversation.project_path || conversation.git_root;
    const cdPrefix = projectDir ? `cd ${projectDir} && ` : "";
    const flags = (conversation as any).cli_flags ? ` ${(conversation as any).cli_flags}` : "";
    const sourceAgent = conversation.agent_type === "codex" ? "codex" : "claude";
    if (targetAgent === sourceAgent) {
      return targetAgent === "codex"
        ? `${cdPrefix}codex resume ${sessionId}`
        : `${cdPrefix}claude --resume ${sessionId}${flags}`;
    }
    return `${cdPrefix}codecast resume ${sessionId} --as ${targetAgent}`;
  }, [managedSession?.session_id, conversation?.session_id, conversation?.agent_type, conversation?.project_path, conversation?.git_root, (conversation as any)?.cli_flags]);

  const handleCopyResumeCommand = useCallback(async (targetAgent: "claude" | "codex") => {
    try {
      const cmd = buildResumeCommand(targetAgent);
      if (!cmd) {
        toast.error("No session to resume");
        return;
      }
      await copyToClipboard(cmd);
      toast.success(`Resume command copied (${targetAgent})`);
    } catch {
      toast.error("Failed to copy");
    }
  }, [buildResumeCommand]);

  // Extract todos and usage from messages using reducer
  const { latestTodos, latestUsage } = useMemo(() => {
    if (!messages || messages.length === 0) {
      return { latestTodos: undefined, latestUsage: undefined };
    }

    const state = createReducer();
    reducer(state, messages);

    return {
      latestTodos: state.latestTodos,
      latestUsage: state.latestUsage,
    };
  }, [messages]);

  const taskStats = useMemo(() => {
    if (!messages || messages.length === 0) return null;
    let total = 0;
    let completed = 0;
    for (const msg of messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.name === "TaskCreate") total++;
          if (tc.name === "TaskUpdate") {
            try {
              const inp = JSON.parse(tc.input);
              if (inp.status === "completed") completed++;
            } catch {}
          }
        }
      }
    }
    return total > 0 ? { total, completed } : null;
  }, [messages]);

  const virtualizer = useVirtualizer({
    count: timeline.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => {
      const item = timeline[index];
      if (!item) return 100;

      if (item.type === 'commit') {
        return 80;
      }

      const msg = item.data as Message;
      if (collapsed) {
        if (msg.role === "system") return 0;
        if (msg.role === "user") {
          const kind = userMsgKindMap.get(msg._id);
          if (kind && kind.kind !== 'normal' && kind.kind !== 'plan') return 0;
        }
        if (msg.role === "assistant") {
          const hasTextContent = msg.content && msg.content.trim().length > 0;
          if (!hasTextContent) return 0;
          // Check if there's an earlier assistant with text in this sequence
          for (let i = index - 1; i >= 0; i--) {
            const checkItem = timeline[i];
            if (checkItem.type !== 'message') continue;
            const checkMsg = checkItem.data as Message;
            if (checkMsg.role === "user") break;
            if (checkMsg.role === "assistant" && checkMsg.content && checkMsg.content.trim().length > 0) {
              return 0;
            }
          }
        }
        return 80;
      }

      if (msg.role === "system") return 8;
      if (msg.role === "user") {
        const kind = userMsgKindMap.get(msg._id);
        switch (kind?.kind) {
          case 'command': return 30;
          case 'interrupt': return 30;
          case 'skill_expansion': return 44;
          case 'task_notification': return 40;
          case 'task_prompt': return 0;
          case 'compaction_prompt': return 0;
          case 'compaction_summary': return 60;
          case 'noise': return 0;
          case 'tool_results_only': return 0;
          case 'empty': return 0;
        }
        const lines = (msg.content || "").split("\n").length;
        return Math.max(60, lines * 18 + 40);
      }
      if (msg.role === "assistant") {
        const hasTextContent = msg.content && msg.content.trim().length > 0;
        const toolCount = msg.tool_calls?.length || 0;
        if (!hasTextContent && !msg.thinking && !msg.images?.length) return 8;
        if (!hasTextContent && toolCount > 0) return toolCount * 30;
        const hasThinking = showThinking && msg.thinking && msg.thinking.trim().length > 0;
        const contentLines = (msg.content || "").split("\n").length;
        return Math.max(60, toolCount * 30 + (hasThinking ? 80 : 0) + contentLines * 18 + 40);
      }
      return 40;
    },
    overscan: 5,
    paddingStart: 16,
    paddingEnd: 100,
    isScrollingResetDelay: 150,
  });

  // Fork navigation: message selection (Option+j/k to navigate, Option+f to fork)
  const [selectedMessageContent, setSelectedMessageContent] = useState<string | null>(null);
  const [selectedMessageUuid, setSelectedMessageUuid] = useState<string | null>(null);
  const handleSelectMessage = useCallback((uuid: string | null, content: string | null) => {
    setSelectedMessageUuid(uuid);
    setSelectedMessageContent(content);
  }, []);
  const handleClearSelection = useCallback(() => {
    forkSetSelectedIndex(null);
    setSelectedMessageContent(null);
    setSelectedMessageUuid(null);
  }, [forkSetSelectedIndex]);
  const forkSelectionIdx = useForkNavigationStore((s) => s.selectedIndex);
  const { selectedIndex: _forkSelIdx } = useMessageSelection({
    timeline: timeline as any,
    virtualizer,
    onForkFromMessage: handleForkFromMessage,
    onSelectMessage: handleSelectMessage,
    enabled: isOwner,
  });

  // Fork navigation: handle branch switching
  const handleBranchSwitch = useCallback((messageUuid: string, convId: string | null) => {
    if (convId === null) {
      forkClearBranch(messageUuid);
      setLoadingBranchId(null);
    } else {
      forkSwitchBranch(messageUuid, convId);
      if (!inboxMessages[convId]) {
        setLoadingBranchId(convId);
      }
    }
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (convId) {
        url.searchParams.set('branch', convId);
      } else {
        url.searchParams.delete('branch');
      }
      window.history.replaceState({}, '', url.toString());
    }
  }, [forkSwitchBranch, forkClearBranch, inboxMessages]);

  // Clear loading state when fork messages arrive
  useEffect(() => {
    if (loadingBranchId && inboxMessages[loadingBranchId]) {
      setLoadingBranchId(null);
    }
  }, [loadingBranchId, inboxMessages]);

  // Fork tree panel: handle switching to a different conversation
  const handleTreeSwitchConversation = useCallback((convId: string) => {
    if (convId === conversation?._id?.toString()) {
      Object.keys(activeBranches).forEach(uuid => forkClearBranch(uuid));
      return;
    }
    const forkChild = conversation?.fork_children?.find(f => f._id === convId);
    if (forkChild && forkChild.parent_message_uuid) {
      Object.keys(activeBranches).forEach(uuid => forkClearBranch(uuid));
      forkSwitchBranch(forkChild.parent_message_uuid, convId);
      if (!inboxMessages[convId]) {
        setLoadingBranchId(convId);
      }
      return;
    }
    window.location.href = `/conversation/${convId}`;
  }, [conversation?._id, conversation?.fork_children, activeBranches, forkClearBranch, forkSwitchBranch, inboxMessages]);

  // Active branch IDs for tree panel highlighting
  const activeBranchIdSet = useMemo(
    () => new Set(Object.values(activeBranches)),
    [activeBranches]
  );

  // t key for tree panel (when not in selection mode)
  useEffect(() => {
    if (!isOwner) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 't') return;
      if (forkSelectionIdx !== null) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      const hasForks = (conversation?.fork_children && conversation.fork_children.length > 0) || conversation?.forked_from;
      if (!hasForks) return;
      e.preventDefault();
      toggleTreePanel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOwner, forkSelectionIdx, toggleTreePanel, conversation?.fork_children, conversation?.forked_from]);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeaderHeight(el.offsetHeight));
    setHeaderHeight(el.offsetHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [deskClass, setDeskClass] = useState("");
  useEffect(() => {
    setDeskClass(desktopHeaderClass());
  }, []);

  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    return setupDesktopDrag(el);
  }, [deskClass]);

  useEffect(() => {
    const el = messageInputRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setMessageInputHeight(el.offsetHeight));
    setMessageInputHeight(el.offsetHeight);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      if (stickyUserMsgIndices.length === 0 && !fallbackStickyContent) {
        setActiveStickyMsg(null);
        setStickyMsgVisible(false);
      }
      return;
    }
    let ticking = false;
    const check = () => {
      ticking = false;
      const scrollTop = el.scrollTop;
      if (scrollTop <= headerHeight + 40) {
        prevStickyMsgIdRef.current = null;
        prevStickyIdxRef.current = null;
        stickyGapRef.current = null;
        setActiveStickyMsg(null);
        setStickyMsgVisible(false);
        return;
      }
      if (stickyDisabled) {
        setActiveStickyMsg(null);
        setStickyMsgVisible(false);
        return;
      }
      const virtualItems = virtualizer.getVirtualItems();
      let bestIdx: number | null = null;
      let bestArrayIdx: number | null = null;
      for (let i = stickyUserMsgIndices.length - 1; i >= 0; i--) {
        const tlIdx = stickyUserMsgIndices[i];
        const item = timeline[tlIdx];
        if (item?.type === 'message') {
          const msgId = (item.data as Message)._id;
          if (dismissedStickyIdsRef.current.has(msgId)) continue;
        }
        const vItem = virtualItems.find(v => v.index === tlIdx);
        if (vItem) {
          const domEl = el.querySelector(`[data-index="${tlIdx}"]`);
          if (!domEl) continue;
          const msgBottom = domEl.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
          if (msgBottom <= 0) {
            bestIdx = tlIdx;
            bestArrayIdx = i;
            break;
          }
        } else {
          if (tlIdx < (virtualItems[0]?.index ?? 0) && scrollTop > el.clientHeight) {
            bestIdx = tlIdx;
            bestArrayIdx = i;
            break;
          }
        }
      }
      if (bestIdx !== null) {
        const viewportHeight = el.clientHeight;
        let hideForNextMsg = false;
        const stickyBottom = headerHeight + (stickyElRef.current?.offsetHeight ?? 0);
        if (bestArrayIdx !== null) {
          const nextArrayIdx = bestArrayIdx + 1;
          if (nextArrayIdx < stickyUserMsgIndices.length) {
            const nextTlIdx = stickyUserMsgIndices[nextArrayIdx];
            const nextVItem = virtualItems.find(v => v.index === nextTlIdx);
            if (nextVItem) {
              const nextMsgTop = nextVItem.start - scrollTop;
              if (nextMsgTop < stickyBottom) {
                hideForNextMsg = true;
              }
            }
          } else {
            const contentBottom = virtualizer.getTotalSize() - scrollTop;
            if (contentBottom < viewportHeight + 100) {
              hideForNextMsg = true;
            }
          }
        }
        const item = timeline[bestIdx];
        const msg = item.data as Message;
        const msgId = msg._id;
        const prevId = prevStickyMsgIdRef.current;
        if (msgId !== prevId) {
          if (prevId !== null && prevId !== '__fallback__' && prevStickyIdxRef.current !== null) {
            stickyGapRef.current = { prevIdx: prevStickyIdxRef.current };
          }
          prevStickyMsgIdRef.current = msgId;
          prevStickyIdxRef.current = bestIdx;
        }
        let inGap = false;
        if (stickyGapRef.current) {
          const gapVItem = virtualItems.find(v => v.index === stickyGapRef.current!.prevIdx);
          if (gapVItem) {
            const prevMsgTopVisual = gapVItem.start - scrollTop;
            if (prevMsgTopVisual < headerHeight + 200) {
              inGap = true;
            } else {
              stickyGapRef.current = null;
            }
          } else {
            stickyGapRef.current = null;
          }
        }
        setActiveStickyMsg({ index: bestIdx, content: msg.content!, id: msgId });
        setStickyMsgVisible(!inGap && !hideForNextMsg);
      } else if (fallbackStickyContent && scrollTop > el.clientHeight) {
        prevStickyMsgIdRef.current = '__fallback__';
        prevStickyIdxRef.current = null;
        stickyGapRef.current = null;
        setActiveStickyMsg({ index: -1, content: fallbackStickyContent, id: '__fallback__' });
        setStickyMsgVisible(true);
      } else {
        prevStickyMsgIdRef.current = null;
        prevStickyIdxRef.current = null;
        stickyGapRef.current = null;
        setActiveStickyMsg(null);
        setStickyMsgVisible(false);
      }
    };
    check();
    const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(check); } };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [stickyUserMsgIndices, virtualizer, timeline, fallbackStickyContent, headerHeight, stickyDisabled]);

  useImperativeHandle(ref, () => ({
    scrollToMessage: (messageId: string) => {
      const itemIndex = timeline.findIndex(item => {
        if (item.type === 'message') {
          return item.data._id === messageId;
        }
        return false;
      });

      if (itemIndex >= 0) {
        setUserScrolled(true);
        virtualizer.scrollToIndex(itemIndex, { align: "center", behavior: "smooth" });
        setHighlightedMessageId(messageId);
        setTimeout(() => setHighlightedMessageId(null), 2000);
      }
    }
  }), [timeline, virtualizer]);

  useEffect(() => {
    const scrollContainer = containerRef.current;
    if (!scrollContainer) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
      isNearBottomRef.current = isNearBottom;

      setIsScrollable(scrollHeight > clientHeight + 10);
      setIsNearTop(scrollTop < 300);

      const scrolledDown = scrollTop > lastScrollTopRef.current + 2;
      lastScrollTopRef.current = scrollTop;

      // Only clear userScrolled when the user actively scrolls DOWN to
      // the bottom. This prevents small wheel-up events (still near bottom)
      // from being immediately overridden by the isNearBottom check.
      if (isNearBottom && scrolledDown) {
        setUserScrolled(false);
      }

      if (scrollProgressRef.current) {
        const totalMessages = conversation?.message_count || messages.length;
        const isPaginated = totalMessages > 150;
        let progress: number;
        if (isPaginated) {
          const items = virtualizer.getVirtualItems();
          if (items.length > 0) {
            const centerIdx = items[Math.floor(items.length / 2)].index;
            const loadedMessages = messages.length;
            const startOffset = conversation?.loaded_start_index ?? 0;
            const tLen = Math.max(timeline.length, 1);
            progress = totalMessages > 0 ? Math.max(0, Math.min(1, (startOffset + (centerIdx / tLen) * loadedMessages) / totalMessages)) : 1;
          } else {
            progress = 0;
          }
        } else {
          const maxScroll = scrollHeight - clientHeight;
          progress = maxScroll > 0 ? scrollTop / maxScroll : 1;
        }
        scrollProgressRef.current.style.height = `${progress * 100}%`;
      }

      // Load older messages when near top (within 300px)
      if (scrollTop < 300 && hasMoreAbove && !isLoadingOlder && !isLoadingNewer && !paginationCooldownRef.current && onLoadOlder) {
        // Save anchor: find first visible message to restore position after load
        const items = virtualizer.getVirtualItems();
        for (const item of items) {
          if (item.end > scrollTop) {
            const tItem = timeline[item.index];
            if (tItem?.type === 'message') {
              scrollAnchorRef.current = {
                messageId: tItem.data._id,
                pixelOffset: item.start - scrollTop,
              };
              break;
            }
          }
        }
        isPaginatingRef.current = true;
        onLoadOlder();
      }

      // Load newer messages when near bottom (within 300px)
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      if (distanceFromBottom < 300 && hasMoreBelow && !isLoadingNewer && !isLoadingOlder && !paginationCooldownRef.current && onLoadNewer) {
        isPaginatingRef.current = true;
        onLoadNewer();
      }
    };

    scrollContainer.addEventListener("scroll", handleScroll);

    // When collapsed changes, content may shrink below viewport making scroll
    // impossible. Run pagination check after the DOM settles so we still load
    // older/newer pages even when the container isn't scrollable.
    const rafId = requestAnimationFrame(handleScroll);

    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
      cancelAnimationFrame(rafId);
    };
  }, [hasMoreAbove, hasMoreBelow, isLoadingOlder, isLoadingNewer, onLoadOlder, onLoadNewer, collapsed]);

  useEffect(() => {
    if (!scrollProgressRef.current) return;
    const totalMessages = conversation?.message_count || messages.length;
    const isPaginated = totalMessages > 150;
    let progress: number;
    if (isPaginated) {
      const items = virtualizer.getVirtualItems();
      if (items.length === 0) return;
      const centerIdx = items[Math.floor(items.length / 2)].index;
      const loadedMessages = messages.length;
      const startOffset = conversation?.loaded_start_index ?? 0;
      const tLen = Math.max(timeline.length, 1);
      progress = totalMessages > 0 ? Math.max(0, Math.min(1, (startOffset + (centerIdx / tLen) * loadedMessages) / totalMessages)) : 1;
    } else {
      const scrollEl = containerRef.current;
      if (!scrollEl) return;
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      progress = maxScroll > 0 ? scrollEl.scrollTop / maxScroll : 1;
    }
    scrollProgressRef.current.style.height = `${progress * 100}%`;
  });

  // Restore scroll position after loading older messages using anchor
  useEffect(() => {
    if (!scrollAnchorRef.current) return;
    const { messageId, pixelOffset } = scrollAnchorRef.current;
    const newIndex = timeline.findIndex(item =>
      item.type === 'message' && (item.data as Message)._id === messageId
    );
    if (newIndex < 0) return;

    paginationCooldownRef.current = true;
    virtualizer.scrollToIndex(newIndex, { align: 'start' });
    scrollAnchorRef.current = null;
    requestAnimationFrame(() => {
      const scrollContainer = containerRef.current;
      if (!scrollContainer) return;
      scrollContainer.scrollTop -= pixelOffset;
      requestAnimationFrame(() => {
        paginationCooldownRef.current = false;
      });
    });
  }, [timeline, virtualizer]);

  const [initialScrollDone, setInitialScrollDone] = useState(false);

  // New messages auto-scroll (only after initial scroll is done)
  useEffect(() => {
    const hasNewMessages = timeline.length > prevTimelineLengthRef.current;
    prevTimelineLengthRef.current = timeline.length;

    if (!initialScrollDone) return;

    if (hasNewMessages && isPaginatingRef.current) {
      isPaginatingRef.current = false;
      return;
    }

    if (hasNewMessages && timeline.length > 0 && !highlightQuery && !targetMessageId && !window.location.hash && !hasMoreBelow && !userScrolledRef.current) {
      const el = containerRef.current;
      if (el) {
        el.style.scrollBehavior = "smooth";
        virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
          lastScrollTopRef.current = el.scrollTop;
          setTimeout(() => { el.style.scrollBehavior = ""; }, 500);
        });
      }
      setUserScrolled(false);
    }
  }, [timeline.length, virtualizer, highlightQuery, targetMessageId, hasMoreBelow, initialScrollDone]);

  useEffect(() => {
    if (isWaitingForResponse && containerRef.current && isNearBottomRef.current && !userScrolledRef.current) {
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
          lastScrollTopRef.current = containerRef.current.scrollTop;
        }
      });
    }
  }, [isWaitingForResponse]);

  // Initial scroll: snap to bottom before paint (chatdoc pattern: scroll(0, 9999999))
  useLayoutEffect(() => {
    if (timeline.length === 0 || initialScrollDone) return;
    if (window.location.hash || highlightQuery) {
      setInitialScrollDone(true);
      return;
    }
    const sc = containerRef.current;
    if (sc) {
      paginationCooldownRef.current = true;
      sc.scrollTop = sc.scrollHeight;
      lastScrollTopRef.current = sc.scrollTop;
      // Fallback: clear cooldown after virtualizer has had time to measure
      setTimeout(() => { paginationCooldownRef.current = false; }, 1000);
    }
    setInitialScrollDone(true);
  }, [timeline.length, highlightQuery, initialScrollDone]);

  // Detect user scroll-up via wheel events (fires synchronously, no race condition
  // with the async scroll event). This ensures userScrolledRef is set before any
  // re-render or auto-correct effect can run.
  useEffect(() => {
    const sc = containerRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) setUserScrolled(true);
    };
    sc.addEventListener('wheel', onWheel, { passive: true });
    return () => sc.removeEventListener('wheel', onWheel);
  }, [setUserScrolled]);

  // Auto-pin: observe scroll container size changes and pin to bottom.
  // Uses ResizeObserver instead of rAF loop to avoid fighting with the
  // virtualizer's item measurement or triggering spurious pagination.
  const totalSize = virtualizer.getTotalSize();
  useEffect(() => {
    if (!initialScrollDone) return;
    if (window.location.hash || highlightQuery) return;
    const sc = containerRef.current;
    if (!sc) return;
    let lastHeight = sc.scrollHeight;
    let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (userScrolledRef.current) return;
      const newHeight = sc.scrollHeight;
      if (newHeight !== lastHeight) {
        lastHeight = newHeight;
        sc.scrollTop = newHeight;
        lastScrollTopRef.current = sc.scrollTop;
      }
      if (paginationCooldownRef.current) {
        if (cooldownTimer) clearTimeout(cooldownTimer);
        cooldownTimer = setTimeout(() => { paginationCooldownRef.current = false; }, 300);
      }
    });
    // Observe the virtualizer's inner container (first child) for size changes
    if (sc.firstElementChild) {
      observer.observe(sc.firstElementChild);
    }
    observer.observe(sc);
    return () => { observer.disconnect(); if (cooldownTimer) clearTimeout(cooldownTimer); };
  }, [initialScrollDone, highlightQuery]);

  // Scroll after jump to start/end
  useEffect(() => {
    if (jumpDirectionRef.current && timeline.length > 0) {
      const dir = jumpDirectionRef.current;
      jumpDirectionRef.current = null;
      paginationCooldownRef.current = true;
      setTimeout(() => {
        if (dir === 'start') {
          virtualizer.scrollToIndex(0, { align: "start" });
          setUserScrolled(true);
        } else {
          virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
          setUserScrolled(false);
        }
        requestAnimationFrame(() => {
          paginationCooldownRef.current = false;
        });
      }, 50);
    }
  }, [timeline, virtualizer]);

  useEffect(() => {
    if (timeline.length && window.location.hash && !targetMessageId) {
      const targetId = window.location.hash.slice(1);
      const itemIndex = timeline.findIndex(item => {
        if (item.type === 'message') {
          return `msg-${item.data._id}` === targetId;
        } else if (item.type === 'commit') {
          return `commit-${item.data.sha}` === targetId;
        }
        return false;
      });
      if (itemIndex >= 0) {
        setUserScrolled(true);
        setTimeout(() => virtualizer.scrollToIndex(itemIndex, { align: "center", behavior: "smooth" }), 100);
      }
    }
  }, [timeline.length, virtualizer, targetMessageId]);

  // Scroll to highlighted message from search
  useEffect(() => {
    if (highlightedMessageId && timeline.length > 0 && !hasScrolledToHighlight.current) {
      const itemIndex = timeline.findIndex(item => {
        if (item.type === 'message') {
          return item.data._id === highlightedMessageId;
        }
        return false;
      });
      if (itemIndex >= 0) {
        hasScrolledToHighlight.current = true;
        setUserScrolled(true);
        setTimeout(() => virtualizer.scrollToIndex(itemIndex, { align: "center", behavior: "smooth" }), 150);
      }
    }
  }, [highlightedMessageId, timeline, virtualizer]);

  useEffect(() => {
    if (!targetMessageId || timeline.length === 0 || hasScrolledToTarget.current) {
      return;
    }

    const itemIndex = timeline.findIndex(item => {
      if (item.type === 'message') {
        return item.data._id === targetMessageId;
      }
      return false;
    });

    if (itemIndex >= 0) {
      hasScrolledToTarget.current = true;
      setUserScrolled(true);
      // First jump instantly to get close (estimates may be off)
      virtualizer.scrollToIndex(itemIndex, { align: "center" });
      // After virtualizer measures nearby items, scroll again precisely
      setTimeout(() => {
        virtualizer.scrollToIndex(itemIndex, { align: "center" });
        setHighlightedMessageId(targetMessageId);
        setTimeout(() => setHighlightedMessageId(null), 3000);
      }, 300);
    }
  }, [targetMessageId, timeline, virtualizer]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "c") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const title = cleanTitle(conversation?.title || "New Session");
  const truncatedTitle = title.length > 60 ? title.slice(0, 57) + "..." : title;
  const latestMessageTimestamp = useMemo(() => {
    if (!conversation?.messages || conversation.messages.length === 0) return undefined;
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
      const message = conversation.messages[i];
      if (message.role !== "system") return message.timestamp;
    }
    return conversation.messages[conversation.messages.length - 1]?.timestamp;
  }, [conversation?.messages]);
  const lastActivityAt = latestMessageTimestamp ?? conversation?.updated_at ?? conversation?.started_at ?? 0;
  const lastMessageRole = useMemo(() => {
    if (!conversation?.messages || conversation.messages.length === 0) return undefined;
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
      if (conversation.messages[i].role !== "system") return conversation.messages[i].role;
    }
    return undefined;
  }, [conversation?.messages]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);
  const isSessionConnected = !!conversation && conversation.status === "active" && (now - lastActivityAt) < 5 * 60 * 1000;
  const isWorking = isSessionConnected && (now - lastActivityAt) < 45 * 1000 && lastMessageRole === "assistant";
  const isConversationLive = isWorking;

  useEffect(() => {
    if (conversation) {
      document.title = `codecast | ${truncatedTitle}`;
    }
    return () => {
      document.title = "codecast";
    };
  }, [truncatedTitle, conversation]);

  const toolCallMap = useMemo(() => {
    const map: Record<string, string> = {};
    if (conversation?.messages) {
      for (const msg of conversation.messages) {
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            map[tc.id] = tc.name;
          }
        }
      }
    }
    return map;
  }, [conversation?.messages]);

  const globalToolResultMap = useMemo(() => {
    const map: Record<string, ToolResult> = {};
    if (conversation?.messages) {
      for (const msg of conversation.messages) {
        if (msg.role === "user" && msg.tool_results) {
          for (const tr of msg.tool_results) {
            map[tr.tool_use_id] = tr;
          }
        }
      }
    }
    return map;
  }, [conversation?.messages]);

  const globalImageMap = useMemo(() => {
    const map: Record<string, ImageData> = {};
    if (conversation?.messages) {
      for (const msg of conversation.messages) {
        if (msg.images) {
          for (const img of msg.images) {
            if (img.tool_use_id) {
              map[img.tool_use_id] = img;
            }
          }
        }
      }
    }
    return map;
  }, [conversation?.messages]);

  const taskSubjectMap = useMemo(() => {
    const createInputs: Record<string, string> = {};
    const idMap: Record<string, string> = {};
    if (conversation?.messages) {
      for (const msg of conversation.messages) {
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.name === "TaskCreate") {
              try {
                const inp = JSON.parse(tc.input);
                if (inp.subject) createInputs[tc.id] = String(inp.subject);
              } catch {}
            }
          }
        }
        if (msg.role === "user" && msg.tool_results) {
          for (const tr of msg.tool_results) {
            if (createInputs[tr.tool_use_id]) {
              const m = tr.content.match(/Task #(\d+)/);
              if (m) idMap[m[1]] = createInputs[tr.tool_use_id];
            }
          }
        }
      }
    }
    return idMap;
  }, [conversation?.messages]);

  const getPreviousNonToolResultMessage = (index: number): Message | null => {
    for (let i = index - 1; i >= 0; i--) {
      const prevItem = timeline[i];
      if (!prevItem || prevItem.type !== "message") continue;
      const prevMsg = prevItem.data as Message;
      if (prevMsg.role === "user") {
        const kind = userMsgKindMap.get(prevMsg._id);
        if (kind?.kind === 'tool_results_only' || kind?.kind === 'command') continue;
      }
      return prevMsg;
    }
    return null;
  };

  const renderItem = (item: TimelineItem, index: number) => {
    if (!item || index < 0 || index >= timeline.length) return null;
    if (item.type === 'commit') {
      const commit = item.data;
      return (
        <CommitCard
          key={commit._id}
          sha={commit.sha}
          message={commit.message}
          timestamp={commit.timestamp}
          filesChanged={commit.files_changed}
          insertions={commit.insertions}
          deletions={commit.deletions}
          authorName={commit.author_name}
          authorEmail={commit.author_email}
          repository={commit.repository}
          files={commit.files}
        />
      );
    }

    if (item.type === 'pull_request') {
      const pr = item.data;
      return (
        <PRCard
          key={pr._id}
          _id={pr._id}
          number={pr.number}
          title={pr.title}
          body={pr.body}
          state={pr.state}
          repository={pr.repository}
          author_github_username={pr.author_github_username}
          head_ref={pr.head_ref}
          base_ref={pr.base_ref}
          additions={pr.additions}
          deletions={pr.deletions}
          changed_files={pr.changed_files}
          commits_count={pr.commits_count}
          files={pr.files}
          created_at={pr.created_at}
          updated_at={pr.updated_at}
          merged_at={pr.merged_at}
        />
      );
    }

    const msg = item.data as Message;
    if (msg.role === "system") {
      if (collapsed) return null;
      return <SystemBlock key={msg._id} content={msg.content || ""} subtype={msg.subtype} timestamp={msg.timestamp} messageUuid={msg.message_uuid} messageId={msg._id} conversationId={conversation?._id} onOpenComments={() => setCommentMessageId(msg._id as Id<"messages">)} onStartShareSelection={handleStartShareSelection} />;
    }

    if (msg.role === "user") {
      const kind = userMsgKindMap.get(msg._id) ?? { kind: 'normal' as const };
      switch (kind.kind) {
        case 'tool_results_only':
        case 'compaction_prompt':
        case 'noise':
        case 'empty':
          return null;
        case 'command':
          if (collapsed) return null;
          return <CommandStatusLine key={msg._id} content={msg.content!} timestamp={msg.timestamp} />;
        case 'interrupt':
          if (collapsed) return null;
          return <InterruptStatusLine key={msg._id} label={kind.tone === 'amber' ? "turn aborted" : undefined} tone={kind.tone} />;
        case 'skill_expansion':
          if (collapsed) return null;
          return <SkillExpansionBlock key={msg._id} content={msg.content!} timestamp={msg.timestamp} cmdName={kind.cmdName} />;
        case 'task_notification':
          if (collapsed) return null;
          return <TaskNotificationLine key={msg._id} content={msg.content!} timestamp={msg.timestamp} />;
        case 'task_prompt':
          return null;
        case 'compaction_summary':
          return <CompactionSummaryBlock key={msg._id} content={msg.content!} />;
        case 'plan':
          return <PlanBlock key={msg._id} content={kind.planContent} timestamp={msg.timestamp} collapsed={collapsed} messageId={msg._id} conversationId={conversation?._id} onOpenComments={() => setCommentMessageId(msg._id as Id<"messages">)} onStartShareSelection={handleStartShareSelection} />;
        case 'normal': {
          if (!msg.content?.trim() && !(msg.images && msg.images.length > 0)) return null;
          const userName = conversation?.user?.name || conversation?.user?.email?.split("@")[0];
          return <UserPrompt key={msg._id} content={msg.content || ""} images={msg.images} timestamp={msg.timestamp} messageId={msg._id} messageUuid={msg.message_uuid} conversationId={conversation?._id} collapsed={collapsed} userName={userName} onOpenComments={() => setCommentMessageId(msg._id as Id<"messages">)} isHighlighted={highlightedMessageId === msg._id} shareSelectionMode={shareSelectionMode} isSelectedForShare={selectedMessageIds.has(msg._id)} onToggleShareSelection={() => handleToggleMessageSelection(msg._id)} onStartShareSelection={handleStartShareSelection} onForkFromMessage={handleForkFromMessage} forkChildren={msg.message_uuid ? forkPointMap[msg.message_uuid] : undefined} onBranchSwitch={msg.message_uuid ? (convId) => handleBranchSwitch(msg.message_uuid!, convId) : undefined} activeBranchId={msg.message_uuid ? activeBranches[msg.message_uuid] : undefined} loadingBranchId={loadingBranchId} isPending={!!msg._isOptimistic} mainMessageCount={msg.message_uuid ? conversation?.main_message_counts_by_fork?.[msg.message_uuid] : undefined} />;
        }
      }
    }

    if (msg.role === "assistant") {
      const prevMsgForCompaction = getPreviousNonToolResultMessage(index);
      if (prevMsgForCompaction?.role === "user" && userMsgKindMap.get(prevMsgForCompaction._id)?.kind === 'compaction_prompt') {
        const summaryContent = extractCompactionSummaryContent(msg.content || "");
        if (!summaryContent) return null;
        return <CompactionSummaryBlock key={msg._id} content={summaryContent} />;
      }

      // Find previous VISIBLE non-commit assistant item to determine if this is first in assistant sequence
      // Skip invisible assistant messages (those whose content is only system tags with no tool calls/thinking/images)
      let prevIdx = index - 1;
      while (prevIdx >= 0) {
        const checkItem = timeline[prevIdx];
        if (checkItem.type === 'commit') { prevIdx--; continue; }
        if (checkItem.type !== 'message') break;
        const checkMsg = checkItem.data as Message;
        if (checkMsg.role !== 'assistant') break;
        const hasVisibleContent = (checkMsg.content && stripSystemTags(checkMsg.content).trim().length > 0)
          || (checkMsg.tool_calls && checkMsg.tool_calls.length > 0)
          || (showThinking && checkMsg.thinking && checkMsg.thinking.trim().length > 0)
          || (checkMsg.images && checkMsg.images.length > 0);
        if (hasVisibleContent) break;
        prevIdx--;
      }
      const prevItem = prevIdx >= 0 ? timeline[prevIdx] : null;
      const prevMsg = prevItem?.type === 'message' ? (prevItem.data as Message) : null;
      const isFirstInSequence = !prevMsg || prevMsg.role !== "assistant";

      // Find the sequence start ID (first assistant message with text in this sequence)
      let sequenceStartId = msg._id;
      for (let i = index - 1; i >= 0; i--) {
        const checkItem = timeline[i];
        if (checkItem.type !== 'message') continue;
        const checkMsg = checkItem.data as Message;
        if (checkMsg.role === "user") break;
        if (checkMsg.role === "assistant" && checkMsg.content && checkMsg.content.trim().length > 0) {
          sequenceStartId = checkMsg._id;
        }
      }

      const isSequenceExpanded = expandedSequences.has(sequenceStartId);

      // Compute all message IDs in the current run (for sharing)
      const runMessageIds: string[] = [];
      for (let i = index; i >= 0; i--) {
        const checkItem = timeline[i];
        if (!checkItem) break;
        if (checkItem.type !== 'message') continue;
        const checkMsg = checkItem.data as Message;
        if (checkMsg.role === "user") break;
        if (checkMsg.role === "assistant") runMessageIds.unshift(checkMsg._id);
      }
      for (let i = index + 1; i < timeline.length; i++) {
        const checkItem = timeline[i];
        if (!checkItem) break;
        if (checkItem.type !== 'message') continue;
        const checkMsg = checkItem.data as Message;
        if (checkMsg.role === "user") break;
        if (checkMsg.role === "assistant") runMessageIds.push(checkMsg._id);
      }

      // In collapsed mode, only render messages if sequence is expanded OR this is the first with text
      if (collapsed && !isSequenceExpanded) {
        const hasMsgPlanWrite = msg.tool_calls?.some(isPlanWriteToolCall);
        if (!hasMsgPlanWrite) {
          const hasTextContent = msg.content && msg.content.trim().length > 0;

          // Check if there's an earlier assistant message with text content in this sequence
          let hasEarlierTextContent = false;
          for (let i = index - 1; i >= 0; i--) {
            const checkItem = timeline[i];
            if (checkItem.type !== 'message') continue;
            const checkMsg = checkItem.data as Message;
            if (checkMsg.role === "user") break;
            if (checkMsg.role === "assistant" && checkMsg.content && checkMsg.content.trim().length > 0) {
              hasEarlierTextContent = true;
              break;
            }
          }

          // Skip this message if: no text content, or there's earlier text content in sequence
          if (!hasTextContent || hasEarlierTextContent) {
            return null;
          }
        }
      }

      const relevantToolResults = msg.tool_calls
        ?.map(tc => msg.tool_results?.find((tr) => tr.tool_use_id === tc.id) || globalToolResultMap[tc.id])
        .filter((tr): tr is ToolResult => tr !== undefined);

      // Determine effective collapsed state for this message
      const effectiveCollapsed = collapsed && !isSequenceExpanded;

      return (
        <AssistantBlock
          key={msg._id}
          content={msg.content}
          timestamp={msg.timestamp}
          thinking={msg.thinking}
          showThinking={showThinking}
          toolCalls={msg.tool_calls}
          toolResults={relevantToolResults}
          images={msg.images}
          messageId={msg._id}
          messageUuid={msg.message_uuid}
          conversationId={conversation?._id}
          collapsed={effectiveCollapsed}
          childConversationMap={conversation?.child_conversation_map}
          childConversations={conversation?.child_conversations}
          agentNameToChildMap={agentNameToChildMap}
          showHeader={effectiveCollapsed ? true : (isFirstInSequence || (collapsed && msg._id === sequenceStartId))}
          onOpenComments={() => setCommentMessageId(msg._id as Id<"messages">)}
          toolCallChangeSelectionMap={toolCallChangeSelectionMap}
          isHighlighted={highlightedMessageId === msg._id}
          isSequenceExpanded={isSequenceExpanded}
          runMessageIds={runMessageIds}
          onToggleCollapsed={collapsed ? () => {
            setExpandedSequences(prev => {
              const next = new Set(prev);
              if (next.has(sequenceStartId)) {
                next.delete(sequenceStartId);
              } else {
                next.add(sequenceStartId);
              }
              return next;
            });
          } : undefined}
          showCollapseButton={collapsed && isSequenceExpanded && isFirstInSequence}
          shareSelectionMode={shareSelectionMode}
          isSelectedForShare={selectedMessageIds.has(msg._id)}
          onToggleShareSelection={() => handleToggleMessageSelection(msg._id)}
          onStartShareSelection={handleStartShareSelection}
          agentType={conversation?.agent_type}
          taskSubjectMap={taskSubjectMap}
          onForkFromMessage={handleForkFromMessage}
          forkChildren={msg.message_uuid ? forkPointMap[msg.message_uuid] : undefined}
          onBranchSwitch={msg.message_uuid ? (convId) => handleBranchSwitch(msg.message_uuid!, convId) : undefined}
          activeBranchId={msg.message_uuid ? activeBranches[msg.message_uuid] : undefined}
          loadingBranchId={loadingBranchId}
          mainMessageCount={msg.message_uuid ? conversation?.main_message_counts_by_fork?.[msg.message_uuid] : undefined}
          model={conversation?.model}
          onSendInlineMessage={handleSendInlineMessage}
          isConversationActive={conversation?.status === "active"}
          globalImageMap={globalImageMap}
        />
      );
    }

    return null;
  };

  return (
    <main className={`relative flex flex-col bg-sol-bg ${embedded ? "h-full" : "h-screen"}`}>
      <header ref={headerRef} className={`border-b border-sol-border bg-sol-bg-alt shrink-0 relative ${embedded ? "sticky top-0 z-20 bg-sol-bg-alt" : ""} ${deskClass}`}>
        <div className="max-w-4xl mx-auto px-1.5 sm:px-3 md:px-4 py-0.5 sm:py-1">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href={backHref}
              className="text-sol-text-dim hover:text-sol-text-secondary transition-colors text-sm sm:text-xs flex-shrink-0 p-1 -m-1 sm:p-0 sm:m-0"
            >
              &larr;
            </Link>
            <TooltipProvider delayDuration={500}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <h1 className="text-xs sm:text-sm font-medium text-sol-text-secondary truncate min-w-0 flex-1 cursor-default">{truncatedTitle}</h1>
                </TooltipTrigger>
                {conversation?.messages?.[0]?.content && (() => {
                  const cleaned = cleanContent(conversation.messages[0].content);
                  return cleaned ? (
                    <TooltipContent side="bottom" className="max-w-sm bg-white text-gray-800 border border-gray-200 shadow-lg text-xs leading-relaxed">
                      {cleaned.length > 200 ? cleaned.slice(0, 200) + "..." : cleaned}
                    </TooltipContent>
                  ) : null;
                })()}
              </Tooltip>
            </TooltipProvider>

            {(managedSession?.agent_status === "working" || managedSession?.agent_status === "thinking" || managedSession?.agent_status === "compacting" || managedSession?.agent_status === "permission_blocked" || managedSession?.agent_status === "connected" || (!managedSession?.agent_status && isConversationLive)) && (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 ${
                managedSession?.agent_status === "thinking" ? "bg-sol-violet/10 text-sol-violet border border-sol-violet/30" :
                managedSession?.agent_status === "compacting" ? "bg-amber-500/10 text-amber-400 border border-amber-500/30" :
                managedSession?.agent_status === "permission_blocked" ? "bg-sol-orange/10 text-sol-orange border border-sol-orange/30" :
                managedSession?.agent_status === "connected" ? "bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30" :
                "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                  managedSession?.agent_status === "thinking" ? "bg-sol-violet" :
                  managedSession?.agent_status === "compacting" ? "bg-amber-400" :
                  managedSession?.agent_status === "permission_blocked" ? "bg-sol-orange" :
                  managedSession?.agent_status === "connected" ? "bg-sol-cyan" :
                  "bg-emerald-400"
                }`} />
                <span className="hidden sm:inline">{managedSession?.agent_status === "thinking" ? "Thinking" :
                 managedSession?.agent_status === "compacting" ? "Compacting" :
                 managedSession?.agent_status === "permission_blocked" ? "Needs Input" :
                 managedSession?.agent_status === "connected" ? "Connected" :
                 "Working"}</span>
                <span className="sm:hidden">{managedSession?.agent_status === "thinking" ? "Think" :
                 managedSession?.agent_status === "compacting" ? "Compact" :
                 managedSession?.agent_status === "permission_blocked" ? "Input" :
                 managedSession?.agent_status === "connected" ? "Conn" :
                 "Work"}</span>
              </span>
            )}

            {conversation && (
              <TooltipProvider delayDuration={300}>
              <div className="flex items-center gap-1 flex-shrink-0 overflow-hidden">
                <ConversationMetadata
                  agentType={conversation.agent_type}
                  model={conversation.model}
                  startedAt={conversation.started_at}
                  messageCount={conversation.message_count}
                  shortId={conversation.short_id}
                  conversationId={conversation._id}
                />

                {conversation.parent_conversation_id && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link
                        href={convLink(conversation.parent_conversation_id)}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/20 transition-colors"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                        </svg>
                        Parent
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent>View parent conversation</TooltipContent>
                  </Tooltip>
                )}

                {conversation.git_branch && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/5 text-emerald-400/80 border border-emerald-500/20 max-w-[150px] cursor-default"
                        onClick={() => {
                          if (conversation.git_remote_url) {
                            const match = conversation.git_remote_url.match(/github\.com[:/](.+?)(?:\.git)?$/);
                            if (match) {
                              window.open(`https://github.com/${match[1]}/tree/${conversation.git_branch}`, '_blank');
                            }
                          }
                        }}
                        style={conversation.git_remote_url ? { cursor: 'pointer' } : undefined}
                      >
                        <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                        </svg>
                        <span className="truncate">{conversation.git_branch}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{conversation.git_branch}</TooltipContent>
                  </Tooltip>
                )}

                {!isOwner && conversation.user?.avatar_url && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <img
                        src={conversation.user.avatar_url}
                        alt={conversation.user.name || "User"}
                        className="w-5 h-5 rounded-full ring-1 ring-sol-border/50"
                      />
                    </TooltipTrigger>
                    <TooltipContent>{conversation.user.name || conversation.user.email || "User"}</TooltipContent>
                  </Tooltip>
                )}

                {headerExtra}

                {highlightQuery && (
                  <div className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-amber-200/50 dark:bg-amber-800/30 text-amber-800 dark:text-amber-200">
                    <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <span className="max-w-[100px] truncate">{highlightQuery}</span>
                    {allMatchingMessageIds.length > 0 && (
                      <>
                        <span className="text-[10px] opacity-70 ml-1">
                          {currentMatchIndex + 1}/{allMatchingMessageIds.length}
                        </span>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={goToPrevMatch}
                              className="p-0.5 hover:bg-amber-300/50 dark:hover:bg-amber-700/40 rounded transition-colors"
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                              </svg>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Previous match</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={goToNextMatch}
                              className="p-0.5 hover:bg-amber-300/50 dark:hover:bg-amber-700/40 rounded transition-colors"
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>Next match</TooltipContent>
                        </Tooltip>
                      </>
                    )}
                    {allMatchingMessageIds.length === 0 && (
                      <span className="text-[10px] opacity-70 ml-1">0 matches</span>
                    )}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={onClearHighlight}
                          className="p-0.5 hover:bg-amber-300/50 dark:hover:bg-amber-700/40 rounded transition-colors ml-1"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>Clear search</TooltipContent>
                    </Tooltip>
                  </div>
                )}

                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => { setCollapsed((c) => !c); setExpandedSequences(new Set()); }}
                      className={`p-1 rounded hover:bg-sol-bg-alt transition-colors ${collapsed ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text-secondary"}`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                        {collapsed
                          ? <><path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" /></>
                          : <><path d="M4 14h6v6M3 21l6.1-6.1M20 10h-6V4M21 3l-6.1 6.1" /></>
                        }
                      </svg>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{collapsed ? "Expand messages" : "Collapse messages"}</TooltipContent>
                </Tooltip>

                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                          </svg>
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent>More options</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end">
                    {managedSession?.tmux_session && (
                      <>
                        <DropdownMenuItem onSelect={() => { setTimeout(() => { copyToClipboard(`tmux attach -t '${managedSession.tmux_session}'`).then(() => toast.success("tmux attach copied")).catch(() => toast.error("Failed to copy")); }); }}>
                          <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          <span className="font-bold">tmux attach</span>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    )}
                    {conversation?.short_id && (
                      <DropdownMenuItem onSelect={() => { setTimeout(() => { copyToClipboard(conversation.short_id!).then(() => toast.success("ID copied")).catch(() => toast.error("Failed to copy")); }); }}>
                        <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
                        </svg>
                        Copy ID ({conversation.short_id})
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => setTimeout(handleCopyAll)}>
                      <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy all messages
                    </DropdownMenuItem>
                    {conversation?.session_id && (
                      <>
                        <DropdownMenuItem onSelect={() => setTimeout(() => handleCopyResumeCommand("claude"))}>
                          <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          Copy Claude resume
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setTimeout(() => handleCopyResumeCommand("codex"))}>
                          <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          Copy Codex resume
                        </DropdownMenuItem>
                      </>
                    )}
                    {isOwner && (
                      <DropdownMenuItem onSelect={() => {
                        setTimeout(async () => {
                          try {
                            await toggleFavoriteMutation({ conversation_id: conversation._id });
                            toast.success(conversation.is_favorite ? "Removed from favorites" : "Added to favorites");
                          } catch { toast.error("Failed to update favorite"); }
                        });
                      }}>
                        <svg className={`w-3 h-3 mr-1.5 ${conversation.is_favorite ? "text-amber-400" : ""}`} fill={conversation.is_favorite ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                        </svg>
                        {conversation.is_favorite ? "Remove from favorites" : "Add to favorites"}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setShowThinking((s) => !s)}>
                      {showThinking ? "Hide thinking" : "Show thinking"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => {
                      const next = !stickyDisabled;
                      setStickyDisabled(next);
                      localStorage.setItem('stickyHeadersDisabled', String(next));
                      if (next) { setStickyMsgVisible(false); setActiveStickyMsg(null); }
                    }}>
                      {stickyDisabled ? "Enable sticky headers" : "Disable sticky headers"}
                    </DropdownMenuItem>
                    {conversation.git_branch && (
                      <DropdownMenuItem onClick={() => setDiffExpanded(!diffExpanded)}>
                        {diffExpanded ? "Hide git diff" : "Show git diff"}
                      </DropdownMenuItem>
                    )}
                    {conversation.parent_conversation_id && (
                      <DropdownMenuItem asChild>
                        <Link href={convLink(conversation.parent_conversation_id)}>
                          View parent conversation
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {conversation.forked_from_details && (
                      <DropdownMenuItem asChild>
                        <Link href={conversation.forked_from_details.share_token ? `/share/${conversation.forked_from_details.share_token}` : convLink(conversation.forked_from_details.conversation_id)}>
                          <svg className="w-3 h-3 mr-1.5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                          </svg>
                          Forked from @{conversation.forked_from_details.username}
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {isOwner && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <svg className="w-3 h-3 mr-1.5 text-sol-violet" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 5H4m0 0l4 4m-4-4l4-4" />
                            </svg>
                            Switch agent
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {(["claude_code", "codex", "cursor", "gemini"] as const)
                              .filter((t) => t !== conversation.agent_type)
                              .map((t) => (
                                <DropdownMenuItem
                                  key={t}
                                  onClick={() => {
                                    setTimeout(async () => {
                                      try {
                                        const result = await forkFromMessage({
                                          conversation_id: conversation._id.toString(),
                                          target_agent_type: t,
                                        });
                                        toast.success(`Forked as ${formatAgentType(t)}`);
                                        window.location.href = `/conversation/${result.conversation_id}`;
                                      } catch (err) {
                                        toast.error(err instanceof Error ? err.message : "Failed to switch agent");
                                      }
                                    });
                                  }}
                                >
                                  <AgentTypeIcon agentType={t} />
                                  <span className="ml-1.5">{formatAgentType(t)}</span>
                                </DropdownMenuItem>
                              ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                      </>
                    )}
                    {((conversation.fork_children && conversation.fork_children.length > 0) || conversation.forked_from) && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => toggleTreePanel()}>
                          <svg className="w-3 h-3 mr-1.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                          </svg>
                          Fork tree
                          <kbd className="ml-auto text-[9px] text-sol-text-dim bg-sol-bg-alt border border-sol-border rounded px-1 py-0.5">t</kbd>
                        </DropdownMenuItem>
                      </>
                    )}
                    {((conversation.fork_count ?? 0) > 0 || (conversation.fork_children?.length ?? 0) > 0) && (
                      <DropdownMenuItem disabled>
                        <svg className="w-3 h-3 mr-1.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                        </svg>
                        {conversation.fork_count || conversation.fork_children?.length || 0} fork{(conversation.fork_count || conversation.fork_children?.length || 0) === 1 ? '' : 's'}
                      </DropdownMenuItem>
                    )}
                    {(conversation.compaction_count ?? 0) > 0 && (
                      <DropdownMenuItem disabled>
                        <svg className="w-3 h-3 mr-1.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                        </svg>
                        {conversation.compaction_count} compaction{conversation.compaction_count === 1 ? '' : 's'}
                      </DropdownMenuItem>
                    )}
                    {conversation.child_conversations && conversation.child_conversations.filter(c => c.is_subagent).length > 0 && (
                      <>
                        <DropdownMenuItem disabled className="text-[10px] uppercase tracking-wider text-sol-text-dim">
                          Subagents ({conversation.child_conversations.filter(c => c.is_subagent).length})
                        </DropdownMenuItem>
                        {conversation.child_conversations.filter(c => c.is_subagent).map((child) => (
                          <DropdownMenuItem key={child._id} asChild>
                            <Link href={convLink(child._id)} className="text-xs">
                              <svg className="w-3 h-3 mr-1.5 text-sol-cyan flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                              </svg>
                              <span className="truncate">{child.title}</span>
                            </Link>
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}
                    {taskStats && (
                      <DropdownMenuItem disabled>
                        Tasks: {taskStats.completed}/{taskStats.total}
                      </DropdownMenuItem>
                    )}
                    {latestTodos && latestTodos.todos.length > 0 && (
                      <DropdownMenuItem disabled>
                        Todos: {latestTodos.todos.filter(t => t.status === 'completed').length}/{latestTodos.todos.length}
                      </DropdownMenuItem>
                    )}
                    {latestUsage && (
                      <>
                        <DropdownMenuSeparator />
                        <div className="px-2 py-1.5">
                          <UsageDisplay usage={latestUsage} />
                        </div>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              </TooltipProvider>
            )}
          </div>
        </div>
      </header>

      {stickyMsgVisible && activeStickyMsg && (
        <div
          ref={stickyElRef}
          className="absolute left-0 right-0 z-[15] px-2 sm:px-3 md:px-4 pt-1 cursor-pointer"
          style={{ top: headerHeight }}
          onClick={() => {
            if (activeStickyMsg.index >= 0) {
              virtualizer.scrollToIndex(activeStickyMsg.index, { align: 'start' });
            } else if (onJumpToEnd) {
              onJumpToEnd();
            }
          }}
        >
          <div className="max-w-4xl mx-auto">
            <div className="bg-sol-blue/10 px-4 py-3 rounded-b-lg border border-sol-blue/30 backdrop-blur-md shadow-lg relative group">
              <button
                className="absolute top-1.5 right-1.5 p-0.5 rounded hover:bg-sol-blue/20 text-sol-text-dim hover:text-sol-text opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => {
                  e.stopPropagation();
                  dismissedStickyIdsRef.current.add(activeStickyMsg!.id);
                  setStickyMsgVisible(false);
                  setActiveStickyMsg(null);
                }}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <div className="flex items-center gap-2 mb-1">
                <UserIcon />
                <span className="text-sol-blue text-xs font-medium">{conversation?.user?.name || conversation?.user?.email?.split("@")[0] || "You"}</span>
              </div>
              <div className="text-sm text-sol-text whitespace-pre-wrap break-words line-clamp-3 pl-8 pr-4">{activeStickyMsg.content.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "").replace(/\[Image\s+\/tmp\/codecast\/images\/[^\]]*\]/gi, "").replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "").replace(/\[image\]/gi, "").trim()}</div>
            </div>
          </div>
        </div>
      )}

      {diffExpanded && conversation && (conversation.git_diff?.trim() || conversation.git_diff_staged?.trim()) && (
        <GitDiffPanel
          gitDiff={conversation.git_diff}
          gitDiffStaged={conversation.git_diff_staged}
        />
      )}

      <div className="flex-1 min-h-0 relative flex">
      <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto" style={{ overflowAnchor: "none" }}>
        <div className="flex flex-col">
        {!conversation ? (
          <ConversationSkeleton />
        ) : timeline.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sol-text-dim text-sm">
            {conversation.status === "active" && (conversation.message_count ?? 0) > 0 ? (
              <>
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 animate-spin text-sol-cyan/60" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span>Loading messages...</span>
                </div>
              </>
            ) : conversation.status === "active" && (conversation.message_count ?? 0) === 0 ? (
              null
            ) : conversation.status !== "active" ? (
              "No messages in this conversation"
            ) : null}
            {conversation.status === "active" && (conversation.message_count ?? 0) === 0 && (conversation.project_path || conversation.git_root) && (
              <ProjectSwitcher conversation={conversation} />
            )}
          </div>
        ) : (
          <>
          {conversation?.parent_conversation_id && !hasMoreAbove && (
            <div className="max-w-4xl mx-auto px-2 sm:px-3 md:px-4 pt-2 pb-1">
              <Link
                href={convLink(conversation.parent_conversation_id)}
                className="inline-flex items-center gap-1.5 text-xs text-sol-cyan/70 hover:text-sol-cyan transition-colors"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
                Spawned from parent session
              </Link>
            </div>
          )}
          <div
            style={{
              minHeight: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {/* Earlier messages indicator at top */}
            {hasMoreAbove && !isLoadingOlder && (
              <div className="sticky top-0 z-10 flex justify-center py-1 sm:py-2 pointer-events-none">
                <div className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-0.5 sm:py-1 rounded-full bg-sol-bg border border-sol-border text-sol-text-muted0 text-[10px] sm:text-xs shadow-sm pointer-events-auto">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                  </svg>
                  {conversation?.message_count && messages.length < conversation.message_count
                    ? `${conversation.message_count - messages.length} earlier messages`
                    : "Scroll up to load more"}
                </div>
              </div>
            )}
            {/* Loading indicator at top */}
            {isLoadingOlder && (
              <div className="sticky top-0 z-10 flex justify-center py-1 sm:py-2 pointer-events-none">
                <div className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full bg-sol-bg-alt/90 border border-sol-border text-sol-text-muted text-[10px] sm:text-xs pointer-events-auto">
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Loading older messages...
                </div>
              </div>
            )}
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = timeline[virtualItem.index];
              const content = renderItem(item, virtualItem.index);
              const isSearchDimmed = highlightQuery && allMatchingMessageIds.length > 0 && item.type === 'message' && !allMatchingMessageIds.includes((item.data as Message)._id);
              const itemId = item.type === 'message' ? (item.data as Message)._id : item.type === 'commit' ? `commit-${(item.data as any).sha || (item.data as any)._id}` : `pr-${(item.data as any)._id}`;
              const isNew = newItemIdsRef.current.has(itemId);
              const isForkSelected = forkSelectionIdx !== null && forkSelectionIdx === virtualItem.index;
              const isBelowForkSelection = forkSelectionIdx !== null && virtualItem.index > forkSelectionIdx;
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItem.start}px)`,
                    ...(content ? {} : { height: 0, overflow: "hidden" }),
                  }}
                >
                  {content && (
                    <div className={`max-w-4xl mx-auto px-1.5 sm:px-3 md:px-4 ${collapsed ? "py-0.5" : "py-0.5 sm:py-1"} ${isNew ? "animate-message-in" : ""} ${isForkSelected ? "ring-2 ring-sol-cyan/60 bg-sol-cyan/5 rounded-lg" : ""} ${isBelowForkSelection ? "opacity-30 pointer-events-none" : ""} transition-opacity`}>
                      {content}
                    </div>
                  )}
                </div>
              );
            })}
            {/* Loading indicator at bottom */}
            {isLoadingNewer && (
              <div className="sticky bottom-0 z-10 flex justify-center py-2 pointer-events-none">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-sol-bg-alt/90 border border-sol-border text-sol-text-muted text-xs pointer-events-auto">
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Loading newer messages...
                </div>
              </div>
            )}
            {/* Later messages indicator at bottom - hide when near top to avoid confusing placement */}
            {hasMoreBelow && !isLoadingNewer && !isNearTop && (
              <div className="sticky bottom-0 z-10 flex justify-center py-2 pointer-events-none">
                <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-sol-bg border border-sol-border text-sol-text-muted0 text-xs shadow-sm pointer-events-auto">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                  Scroll down to load more
                </div>
              </div>
            )}
          </div>
          {conversation?.child_conversations && conversation.child_conversations.length > 0 && !hasMoreBelow && (() => {
            const childMap = conversation.child_conversation_map || {};
            const messageUuids = new Set(messages.map(m => m.message_uuid).filter(Boolean));
            const renderedInlineIds = new Set(
              Object.entries(childMap)
                .filter(([uuid]) => messageUuids.has(uuid))
                .map(([, childId]) => childId)
            );
            const continuationChildren = conversation.child_conversations.filter(c => !renderedInlineIds.has(c._id) && !c.is_subagent && c._id !== conversation._id);
            if (continuationChildren.length === 0) return null;
            return (
              <div className="max-w-4xl mx-auto px-2 sm:px-3 md:px-4 pt-3 pb-8">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-sol-text-secondary uppercase tracking-wider font-medium">Continued in</span>
                  {continuationChildren.map((child) => (
                    <Link
                      key={child._id}
                      href={convLink(child._id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-sol-cyan/15 text-sol-text-secondary border border-sol-cyan/30 hover:bg-sol-cyan/25 hover:text-sol-text transition-colors truncate max-w-[400px]"
                    >
                      <svg className="w-2.5 h-2.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                      </svg>
                      {child.title}
                    </Link>
                  ))}
                </div>
              </div>
            );
          })()}
          </>
        )}

        </div>
      </div>

      {conversation && (
        <ForkTreePanel
          conversationId={conversation._id.toString()}
          open={forkTreePanelOpen}
          onClose={toggleTreePanel}
          activeBranchIds={activeBranchIdSet}
          onSwitchToConversation={handleTreeSwitchConversation}
        />
      )}
      </div>

      {showMessageInput && conversation && (
        <div ref={messageInputRef} className="relative">
          {conversation.status === "active" && (conversation.message_count ?? 0) === 0 && (
            <div className="absolute left-0 right-0 bottom-full">
              <AgentSwitcher conversation={conversation} />
            </div>
          )}
          <MessageInput conversationId={firstActiveForkId || conversation._id} status={conversation.status} embedded={embedded} onSendAndAdvance={onSendAndAdvance} autoFocusInput={autoFocusInput} initialDraft={conversation.draft_message} isWaitingForResponse={isWaitingForResponse} isThinking={isThinking} isConversationLive={isConversationLive} sessionId={conversation.session_id} agentType={conversation.agent_type} agentStatus={managedSession?.agent_status as any} selectedMessageContent={selectedMessageContent} selectedMessageUuid={selectedMessageUuid} onClearSelection={handleClearSelection} onForkFromMessage={handleForkFromMessage} />
        </div>
      )}

      {timeline.length > 0 && (
        <div className="absolute right-3 sm:right-8 z-30 flex items-stretch gap-2.5" style={{ bottom: Math.max(messageInputHeight + 16, 115) }}>
          <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  if (hasMoreAbove && onJumpToStart) {
                    jumpDirectionRef.current = 'start';
                    onJumpToStart();
                  } else {
                    virtualizer.scrollToIndex(0, { align: "start" });
                    requestAnimationFrame(() => {
                      if (containerRef.current) containerRef.current.scrollTop = 0;
                    });
                  }
                }}
                className={`p-1.5 sm:p-2 rounded-full bg-sol-bg-alt border border-sol-border shadow-lg hover:bg-sol-cyan hover:text-white transition-all ${((!isNearTop && isScrollable) || hasMoreAbove) ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                aria-label="Scroll to top"
              >
                {isLoadingOlder ? (
                  <svg className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => {
                  if (hasMoreBelow && onJumpToEnd) {
                    jumpDirectionRef.current = 'end';
                    onJumpToEnd();
                  } else {
                    virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
                    requestAnimationFrame(() => {
                      if (containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
                    });
                  }
                  setUserScrolled(false);
                }}
                className={`p-1.5 sm:p-2 rounded-full bg-sol-bg-alt border border-sol-border shadow-lg hover:bg-sol-cyan hover:text-white transition-all ${((userScrolled && isScrollable) || hasMoreBelow) ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                aria-label="Scroll to bottom"
              >
                {isLoadingNewer ? (
                  <svg className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                  </svg>
                )}
              </button>
          </div>
          {(isScrollable && (!isNearTop || userScrolled) || hasMoreAbove || hasMoreBelow) && (
            <div className="hidden sm:block w-1.5 relative border border-sol-border overflow-hidden">
              <div
                ref={scrollProgressRef}
                className="w-full bg-sol-cyan/60 absolute inset-x-0 top-0"
                style={{ height: '0%', transition: 'height 0.15s ease-out' }}
              />
            </div>
          )}
        </div>
      )}

      {pendingPermissions && pendingPermissions.length > 0 && (
        <div className={`border-t border-sol-border/40 shrink-0 ${embedded ? "-mx-[9999px] px-[9999px]" : ""}`}>
          <div className="max-w-4xl mx-auto px-2 sm:px-3 md:px-4 py-1.5">
            <PermissionStack permissions={pendingPermissions as any} />
          </div>
        </div>
      )}

      {commentMessageId && conversation && (
        <CommentPanel
          conversationId={conversation._id as Id<"conversations">}
          messageId={commentMessageId}
          onClose={() => setCommentMessageId(null)}
        />
      )}

      {shareSelectionMode && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-sol-bg-alt border border-sol-border rounded-lg shadow-xl px-4 py-3">
          <span className="text-sm text-sol-text-secondary">
            {selectedMessageIds.size} message{selectedMessageIds.size !== 1 ? "s" : ""} selected
          </span>
          <button
            onClick={handleCancelShareSelection}
            className="px-3 py-1.5 text-sm text-sol-text-dim hover:text-sol-text-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmShare}
            disabled={selectedMessageIds.size === 0 || isCreatingShareLink}
            className="px-4 py-1.5 text-sm bg-sol-cyan hover:bg-sol-cyan/80 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreatingShareLink ? "Creating..." : "Copy share link"}
          </button>
        </div>
      )}
    </main>
  );
});
