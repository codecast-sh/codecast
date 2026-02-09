"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useMemo, useImperativeHandle, forwardRef, useCallback } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isCommandMessage, getCommandType, cleanContent } from "../lib/conversationProcessor";
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
} from "./ui/dropdown-menu";
import { useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { CommentPanel } from "./CommentPanel";
import { PermissionCard } from "./PermissionCard";
import { copyToClipboard } from "../lib/utils";
import { MarkdownRenderer, isMarkdownFile, isPlanFile } from "./tools/MarkdownRenderer";
import { MessageSharePopover } from "./MessageSharePopover";
import { ConversationTree } from "./ConversationTree";

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
  share_token?: string;
  message_count?: number;
  messages: Message[];
  user?: { name?: string; email?: string } | null;
  parent_conversation_id?: string | null;
  child_conversations?: Array<{ _id: string; title: string }>;
  child_conversation_map?: Record<string, string>;
  git_branch?: string | null;
  git_status?: string | null;
  git_diff?: string | null;
  git_diff_staged?: string | null;
  git_remote_url?: string | null;
  short_id?: string;
  status?: "active" | "completed";
  fork_count?: number;
  forked_from?: string;
  forked_from_details?: {
    conversation_id: string;
    share_token?: string;
    username: string;
  } | null;
  compaction_count?: number;
  loaded_start_index?: number;
  fork_children?: Array<{
    _id: string;
    title: string;
    short_id?: string;
    started_at: number;
    username: string;
    parent_message_uuid?: string;
  }>;
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
};

export interface ConversationViewHandle {
  scrollToMessage: (messageId: string) => void;
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
  if (minutes < 1) return '<1m';
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
    .replace(/<\/?(?:command-(?:name|message|args)|antml:[a-z_]+)[^>]*>/g, '')
    .replace(/^\s*Caveat:.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
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

function AssistantIcon({ agentType }: { agentType?: string }) {
  if (agentType === "codex") return <CodexIcon />;
  if (agentType === "cursor") return <CursorIcon />;
  return <ClaudeIcon />;
}

function assistantLabel(agentType?: string): string {
  if (agentType === "codex") return "Codex";
  if (agentType === "cursor") return "Cursor";
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
  }
  return null;
}

function formatAgentType(agentType?: string): string {
  if (!agentType) return "Unknown";
  if (agentType === "claude_code") return "Claude Code";
  if (agentType === "codex") return "Codex";
  if (agentType === "cursor") return "Cursor";
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
        <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
          <span className="text-sol-text-dim hidden sm:inline">&middot;</span>
          <span className="font-mono truncate max-w-[120px] sm:max-w-none" title={model}>{formatModel(model)}</span>
        </div>
      )}
      {shortId && (
        <button
          className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0 font-mono bg-sol-bg-highlight px-1 py-0.5 rounded hover:bg-sol-border/40 transition-colors cursor-pointer"
          title="Copy short ID"
          onClick={() => { copyToClipboard(shortId).then(() => toast.success("ID copied")); }}
        >
          {shortId}
        </button>
      )}
      {startedAt && (
        <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
          <span className="text-sol-text-dim hidden sm:inline">&middot;</span>
          <span title={formatFullTimestamp(startedAt)}>{formatRelativeTime(startedAt)}</span>
        </div>
      )}
      {messageCount !== undefined && messageCount > 0 && (
        <button
          className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0 hover:text-sol-text-muted transition-colors cursor-pointer"
          title="Copy conversation ID"
          onClick={() => { if (conversationId) copyToClipboard(conversationId).then(() => toast.success("ID copied")); }}
        >
          <span className="text-sol-text-dim hidden sm:inline">&middot;</span>
          <span>{messageCount} {messageCount === 1 ? "msg" : "msgs"}</span>
        </button>
      )}
      {startedAt && (
        <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
          <span className="text-sol-text-dim hidden sm:inline">&middot;</span>
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


function TaskToolBlock({ tool, result, childConversationId }: { tool: ToolCall; result?: ToolResult; childConversationId?: string }) {
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
  const truncatedPrompt = prompt.length > 300 && !expanded ? prompt.slice(0, 300) + "..." : prompt;

  return (
    <div className={`my-3 rounded-lg ${colors.bg} border ${colors.border} overflow-hidden`}>
      <div
        className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-sol-bg-highlight/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
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
        {childConversationId && (
          <Link
            href={`/conversation/${childConversationId}`}
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

      {expanded && result && (
        <div className="border-t border-sol-border/50 px-3 py-2">
          <div className="text-[10px] text-sol-text-dim mb-1">Result</div>
          <pre className={`text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto ${
            result.is_error ? "text-sol-red" : "text-sol-text-muted"
          }`}>
            {result.content}
          </pre>
        </div>
      )}
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

function ToolBlock({ tool, result, changeIndex, shareSelectionMode, messageId, onStartShareSelection, collapsed, timestamp }: { tool: ToolCall; result?: ToolResult; changeIndex?: number; shareSelectionMode?: boolean; messageId?: string; onStartShareSelection?: (messageId: string) => void; collapsed?: boolean; timestamp?: number }) {
  const isEdit = tool.name === "Edit" || tool.name === "Write" || tool.name === "file_edit" || tool.name === "file_write" || tool.name === "apply_patch";
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

  const filePath = String(parsedInput.file_path || "");
  const relativePath = getRelativePath(filePath);
  const language = getFileExtension(filePath);

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
    if (isEdit || isRead) return relativePath;
    if (isBash) {
      const cmd = String(parsedInput.command || parsedInput.cmd || "");
      if (cmd) return cmd.length > 100 ? cmd.slice(0, 100) + "..." : cmd;
    }
    if (isGlob && parsedInput.pattern) return String(parsedInput.pattern);
    if (isGrep && parsedInput.pattern) return String(parsedInput.pattern);
    if (isCodeSearch && parsedInput.query) return truncateStr(String(parsedInput.query), 40);

    if (tool.name === "apply_patch") {
      const input = String(parsedInput.input || parsedInput.patch || "");
      const fileMatch = input.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/);
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

  // Process result content - strip line numbers for Read tool
  const processedContent = result ? (isRead ? stripLineNumbers(result.content) : result.content) : "";

  const isCodeTool = isBash || isEdit || isRead || isGlob || isGrep || isCodeSearch;
  const isMarkdownResult = result && !isCodeTool && typeof processedContent === 'string' && (
    processedContent.includes('###') || processedContent.includes('**') || processedContent.includes('```')
  );

  // Extract starting line number from Edit result (format: "   42→content")
  const getStartLine = () => {
    if (!isEdit || !result) return 1;
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

  const isClickable = isEdit && changeIndex !== undefined;
  const isSelected = isClickable && (
    selectedChangeIndex === changeIndex ||
    (rangeStart !== null && rangeEnd !== null && changeIndex >= rangeStart && changeIndex <= rangeEnd)
  );

  const handleClick = (e: React.MouseEvent) => {
    if (shareSelectionMode) {
      return;
    }
    if (isClickable) {
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey) {
        if (selectedChangeIndex !== null && selectedChangeIndex !== changeIndex) {
          selectRange(selectedChangeIndex, changeIndex);
        } else {
          selectChange(changeIndex);
        }
      } else {
        selectChange(changeIndex);
      }
    } else {
      setExpanded(!expanded);
    }
  };

  if (isPlanWrite && content) {
    return <PlanBlock content={content} timestamp={timestamp || Date.now()} collapsed={collapsed} messageId={messageId} onStartShareSelection={onStartShareSelection} shareSelectionMode={shareSelectionMode} />;
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
          <span className="text-sol-text-muted font-mono truncate">{summary}</span>
        )}
        {resultSummary && (
          <span className={`font-mono ${result?.is_error ? "text-sol-red/80" : "text-sol-text-dim"}`}>
            {resultSummary}
          </span>
        )}
      </div>

      {expanded && (
        <div className="mt-1 rounded overflow-hidden border border-sol-border/30 bg-sol-bg-alt">
          {/* Markdown toggle header */}
          {isMarkdown && (isRead || (tool.name === "Write" && parsedInput.content)) && (
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
          ) : isBash && (parsedInput.command || parsedInput.cmd) ? (
            <div className="max-h-80 overflow-auto">
              <div className="px-2 py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
                <pre className="text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
                  $ {String(parsedInput.command || parsedInput.cmd)}
                </pre>
              </div>
              {processedContent && processedContent.trim() ? (
                <pre className={`p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap ${result?.is_error ? "text-sol-red" : "text-sol-text-secondary"}`}>
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
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{processedContent}</ReactMarkdown>
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

function SendMessageBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const type = parsedInput.type || "message";
  const recipient = parsedInput.recipient;
  const summary = parsedInput.summary;

  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-mono text-amber-500/80">SendMessage</span>
        {type === "broadcast" ? (
          <span className="px-1 py-0.5 rounded text-[10px] font-mono bg-red-500/15 text-red-400">broadcast</span>
        ) : type === "shutdown_request" ? (
          <span className="px-1 py-0.5 rounded text-[10px] font-mono bg-red-500/15 text-red-400">shutdown</span>
        ) : recipient ? (
          <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 font-mono">@{recipient}</span>
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

function PlanModeBlock({ tool }: { tool: ToolCall }) {
  const isEnter = tool.name === "EnterPlanMode";
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
    </div>
  );
}

function AskUserQuestionBlock({ tool, result }: { tool: ToolCall; result?: ToolResult }) {
  let parsedInput: { questions?: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>; answers?: Record<string, string> } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const questions = parsedInput.questions || [];
  if (questions.length === 0) return null;

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

  return (
    <div className="my-1.5 ml-1 border-l-2 border-sol-violet/30 pl-3 space-y-2.5">
      {questions.map((q, i) => {
        const answer = answers[q.question];
        const isCustom = answer !== undefined && !q.options.some(
          o => o.label === answer || o.label.replace(" (Recommended)", "") === answer
        );
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
                return (
                  <span
                    key={j}
                    className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                      isSelected
                        ? "bg-sol-green/15 border-sol-green/40 text-sol-green"
                        : "border-sol-border/30 text-sol-text-dim"
                    }`}
                  >
                    {isSelected && (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                    {opt.label}
                  </span>
                );
              })}
              {isCustom && (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-sol-blue/15 border-sol-blue/40 text-sol-blue">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  {answer}
                </span>
              )}
            </div>
          </div>
        );
      })}
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

function ImageBlock({ image }: { image: ImageData }) {
  const storageUrl = useQuery(
    api.images.getImageUrl,
    image.storage_id ? { storageId: image.storage_id as Id<"_storage"> } : "skip"
  );
  const [fullscreen, setFullscreen] = useState(false);

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
      <div className="my-2 w-64 h-32 rounded border border-sol-border bg-sol-bg-alt flex items-center justify-center">
        <span className="text-sol-text-dim text-xs">Loading image...</span>
      </div>
    );
  }

  return (
    <>
      <div className="my-2 cursor-pointer" onClick={() => setFullscreen(true)}>
        <img
          src={src}
          alt="User provided image"
          className="max-w-md rounded border border-sol-border hover:border-sol-blue/50 transition-colors"
        />
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
  const displayText = cleanContent(content).slice(0, 100) || content.replace(/<[^>]+>/g, "").slice(0, 100);

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

function UserPrompt({ content, timestamp, messageId, conversationId, collapsed, userName, onOpenComments, isHighlighted, shareSelectionMode, isSelectedForShare, onToggleShareSelection, onStartShareSelection, onForkFromMessage, forkChildren, messageUuid }: { content: string; timestamp: number; messageId: string; conversationId?: Id<"conversations">; collapsed?: boolean; userName?: string; onOpenComments?: () => void; isHighlighted?: boolean; shareSelectionMode?: boolean; isSelectedForShare?: boolean; onToggleShareSelection?: () => void; onStartShareSelection?: (messageId: string) => void; onForkFromMessage?: (messageUuid: string) => void; forkChildren?: Array<{ _id: string; title: string; short_id?: string }>; messageUuid?: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [contentExpanded, setContentExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const isMarkdown = hasRichMarkdown(content);

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

  const commentCount = useQuery(api.comments.getCommentCount, {
    message_id: messageId as Id<"messages">,
  });

  const isBookmarked = useQuery(
    api.bookmarks.isBookmarked,
    messageId ? { message_id: messageId as Id<"messages"> } : "skip"
  );
  const toggleBookmark = useMutation(api.bookmarks.toggleBookmark);

  const handleCopy = async () => {
    try {
      await copyToClipboard(content);
      toast.success("Copied!");
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  const handleCopyLink = async () => {
    try {
      const url = `${window.location.origin}${window.location.pathname}#msg-${messageId}`;
      await copyToClipboard(url);
      toast.success("Link copied!");
    } catch (err) {
      toast.error("Failed to copy link");
    }
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
    <div id={`msg-${messageId}`} className={`group rounded-lg scroll-mt-20 p-4 ${effectivelyCollapsed ? "mb-2" : "mb-6"} relative transition-all border ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg message-highlight" : ""} ${shareSelectionMode ? "cursor-pointer" : ""} ${isSelectedForShare ? "border-2 border-sol-cyan bg-sol-cyan/20 ring-2 ring-sol-cyan/30" : "bg-sol-blue/15 border-sol-blue/40"}`} onClick={shareSelectionMode ? onToggleShareSelection : undefined}>
      <div className={`absolute top-3 right-3 transition-opacity flex gap-1 ${shareSelectionMode ? "opacity-0 pointer-events-none" : "opacity-0 group-hover:opacity-100"}`}>
        {onStartShareSelection && (
          <MessageSharePopover
            messageId={messageId}
            onStartShareSelection={onStartShareSelection}
            trigger={
              <span
                className="p-1.5 rounded hover:bg-sol-blue/20 text-sol-blue cursor-pointer"
                title="Share message"
                aria-label="Share message"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                </svg>
              </span>
            }
          />
        )}
        <button
          onClick={handleCopyLink}
          className="p-1.5 rounded hover:bg-sol-blue/20 text-sol-blue"
          title="Copy link to message"
          aria-label="Copy link to message"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        </button>
        <button
          onClick={handleToggleBookmark}
          className={`p-1.5 rounded hover:bg-sol-blue/20 ${isBookmarked ? "text-amber-400" : "text-sol-blue"}`}
          title={isBookmarked ? "Remove bookmark" : "Bookmark message"}
          aria-label={isBookmarked ? "Remove bookmark" : "Bookmark message"}
        >
          <svg className="w-4 h-4" fill={isBookmarked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
        </button>
        <button
          onClick={onOpenComments}
          className="p-1.5 rounded hover:bg-sol-blue/20 text-sol-blue flex items-center gap-1"
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
            className="p-1.5 rounded hover:bg-purple-500/20 text-purple-400"
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
          className="p-1.5 rounded hover:bg-sol-blue/20 text-sol-blue"
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
          onClick={(e) => { e.preventDefault(); copyToClipboard(formatFullTimestamp(timestamp)).then(() => toast.success("Timestamp copied")); }}
        >
          {formatRelativeTime(timestamp)}
        </a>
        {isBookmarked && (
          <svg className="w-3 h-3 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
        )}
      </div>
      <div
        ref={contentRef}
        className={`text-sol-text text-sm pl-8 break-words relative ${effectivelyCollapsed ? "line-clamp-2 whitespace-pre-wrap" : isMarkdown ? "prose prose-invert prose-sm max-w-none" : "whitespace-pre-wrap"}`}
        style={!effectivelyCollapsed && !contentExpanded && isOverflowing ? { maxHeight: USER_CONTENT_MAX_HEIGHT, overflow: 'hidden', maskImage: 'linear-gradient(to bottom, black calc(100% - 5rem), transparent)', WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 5rem), transparent)' } : undefined}
      >
        {effectivelyCollapsed ? content : (() => {
          const hasTeammate = content.includes('<teammate-message');
          if (hasTeammate) {
            const tmParts = parseTeammateMessages(content);
            return (
              <div className="space-y-1">
                {tmParts.map((part, i) => part.type === 'teammate' ? (
                  <TeammateMessageCard key={i} teammateId={part.teammateId} color={part.color} summary={part.summary} content={part.content} />
                ) : hasRichMarkdown(part.content) ? (
                  <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}
                    components={{ pre: ({ node, children, ...props }) => {
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
          const hasSkill = content.includes('<skill>');
          if (hasSkill) {
            const { parts } = parseSkillBlocks(content);
            return (
              <div className="space-y-2">
                {parts.map((part, i) => part.type === 'skill' ? (
                  <SkillCard key={i} name={part.skillName} description={part.skillDesc} path={part.skillPath} />
                ) : isMarkdown || hasRichMarkdown(part.content) ? (
                  <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}
                    components={{ pre: ({ node, children, ...props }) => {
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
            >{content}</ReactMarkdown>
          ) : content;
        })()}
      </div>
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

      {forkChildren && forkChildren.length > 0 && (
        <div className="flex items-center gap-1.5 mt-2 ml-8 flex-wrap">
          <svg className="w-3 h-3 text-purple-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
          {forkChildren.map((fork) => (
            <Link
              key={fork._id}
              href={`/conversation/${fork._id}`}
              className="text-[10px] text-purple-400 hover:text-purple-300 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/30 rounded px-1.5 py-0.5 transition-colors max-w-[200px] truncate"
              title={fork.title}
            >
              {fork.short_id ? `${fork.short_id} ${fork.title}` : fork.title}
            </Link>
          ))}
        </div>
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
  showHeader = true,
  onOpenComments,
  toolCallToChangeIndexMap,
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
  model,
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
  showHeader?: boolean;
  onOpenComments?: () => void;
  toolCallToChangeIndexMap?: Record<string, number>;
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
  forkChildren?: Array<{ _id: string; title: string; short_id?: string }>;
  model?: string;
}) {
  const COLLAPSED_LINES = 2;
  const CONTENT_MAX_HEIGHT = 1800;

  const [contentExpanded, setContentExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const displayContent = content ? stripSystemTags(content) : content;
  const hasContent = displayContent && displayContent.trim().length > 0;
  const hasThinking = thinking && thinking.trim().length > 0;
  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const hasImages = images && images.length > 0;

  const commentCount = useQuery(api.comments.getCommentCount, {
    message_id: messageId as Id<"messages">,
  });

  const isBookmarked = useQuery(
    api.bookmarks.isBookmarked,
    messageId ? { message_id: messageId as Id<"messages"> } : "skip"
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

  const handleCopy = async () => {
    try {
      await copyToClipboard(displayContent || "");
      toast.success("Copied!");
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  const handleCopyLink = async () => {
    try {
      const url = `${window.location.origin}${window.location.pathname}#msg-${messageId}`;
      await copyToClipboard(url);
      toast.success("Link copied!");
    } catch (err) {
      toast.error("Failed to copy link");
    }
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

  // Only show Claude header for first message in sequence and messages with actual content
  const visibleThinking = hasThinking && showThinking;
  const shouldShowHeader = showHeader && (hasContent || visibleThinking);
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
    <div id={`msg-${messageId}`} className={`group relative scroll-mt-20 ${collapsed ? "mb-1" : onlyToolCalls ? "mb-1" : "mb-6"} transition-all ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg rounded-lg p-2 -m-2 message-highlight" : ""} ${shareSelectionMode ? "cursor-pointer" : ""} ${isSelectedForShare ? "bg-sol-cyan/10 rounded-lg p-2 -m-2 border-2 border-sol-cyan ring-2 ring-sol-cyan/30" : ""}`} onClick={shareSelectionMode ? onToggleShareSelection : undefined}>
      {(hasContent || hasToolCalls) && (
        <div className={`absolute -top-2 right-0 transition-opacity flex gap-0.5 z-10 bg-sol-bg rounded shadow-md px-0.5 ${shareSelectionMode ? "opacity-0 pointer-events-none" : "opacity-0 group-hover:opacity-100"}`}>
          {onStartShareSelection && (
            <MessageSharePopover
              messageId={messageId}
              onStartShareSelection={onStartShareSelection}
              trigger={
                <span
                  className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary cursor-pointer"
                  title="Share message"
                  aria-label="Share message"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                  </svg>
                </span>
              }
            />
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
              className="p-1.5 rounded hover:bg-purple-500/20 text-purple-400"
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
            onClick={(e) => { e.preventDefault(); copyToClipboard(formatFullTimestamp(timestamp)).then(() => toast.success("Timestamp copied")); }}
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
        {!collapsed && hasImages && images?.map((img, i) => <ImageBlock key={i} image={img} />)}

        {!collapsed && hasThinking && showThinking && <ThinkingBlock content={thinking!} showContent={showThinking} />}

        {hasToolCalls && toolCalls?.map((tc) => {
          if (collapsed && !isPlanWriteToolCall(tc)) return null;
          return tc.name === "Task" ? (
            <TaskToolBlock
              key={tc.id}
              tool={tc}
              result={toolResultMap[tc.id]}
              childConversationId={messageUuid && childConversationMap ? childConversationMap[messageUuid] : undefined}
            />
          ) : tc.name === "TodoWrite" ? (
            <TodoWriteBlock key={tc.id} tool={tc} />
          ) : tc.name === "AskUserQuestion" ? (
            <AskUserQuestionBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} />
          ) : tc.name === "TaskList" ? (
            <TaskListBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} />
          ) : tc.name === "TaskCreate" || tc.name === "TaskUpdate" || tc.name === "TaskGet" ? (
            <TaskCreateUpdateBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} taskSubjectMap={taskSubjectMap} />
          ) : tc.name === "SendMessage" ? (
            <SendMessageBlock key={tc.id} tool={tc} />
          ) : tc.name === "TeamCreate" || tc.name === "TeamDelete" ? (
            <TeamCreateBlock key={tc.id} tool={tc} />
          ) : tc.name === "Skill" ? (
            <SkillBlock key={tc.id} tool={tc} />
          ) : tc.name === "EnterPlanMode" || tc.name === "ExitPlanMode" ? (
            <PlanModeBlock key={tc.id} tool={tc} />
          ) : (
            <ToolBlock
              key={tc.id}
              tool={tc}
              result={toolResultMap[tc.id]}
              changeIndex={toolCallToChangeIndexMap?.[tc.id]}
              shareSelectionMode={shareSelectionMode}
              messageId={messageId}
              onStartShareSelection={onStartShareSelection}
              collapsed={collapsed}
              timestamp={timestamp}
            />
          );
        })}

        {hasContent && (
          <>
            <div className={`text-sol-text ${collapsed ? "text-sm whitespace-pre-wrap break-words" : "prose prose-invert prose-sm max-w-none"}`}>
              {collapsed ? (
                <>
                  <span>{truncatedContent}</span>
                  {lines.length > COLLAPSED_LINES && <span className="text-sol-text-dim">...</span>}
                </>
              ) : (
                <div
                  ref={contentRef}
                  className="relative"
                  style={!contentExpanded && isOverflowing ? { maxHeight: CONTENT_MAX_HEIGHT, overflow: 'hidden', maskImage: 'linear-gradient(to bottom, black calc(100% - 5rem), transparent)', WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 5rem), transparent)' } : undefined}
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
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
            {!collapsed && (isOverflowing || contentExpanded) && (
              <div className="flex items-center gap-3 mt-2">
                <button
                  onClick={() => setContentExpanded(e => !e)}
                  className="text-sm font-medium text-sol-cyan hover:text-sol-cyan/80 transition-colors"
                >
                  {contentExpanded ? "Collapse" : "Expand"}
                </button>
                <button
                  onClick={() => setFullscreen(true)}
                  className="text-sm font-medium text-sol-cyan hover:text-sol-cyan/80 transition-colors"
                >
                  Fullscreen
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
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
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
    </div>
  );
}

function ToolResultMessage({ toolResults, toolName }: { toolResults: ToolResult[]; toolName?: string }) {
  // Don't render separate result messages - results are shown inline with tool calls
  // This component was showing duplicate content with the 1→ line number format
  return null;
}

function SystemBlock({ content, subtype, timestamp, messageUuid }: { content: string; subtype?: string; timestamp?: number; messageUuid?: string }) {
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
    return <PlanBlock content={content} timestamp={timestamp || Date.now()} />;
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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

const PLAN_MAX_HEIGHT = 1800;

function PlanBlock({ content, timestamp, collapsed, messageId, onStartShareSelection, shareSelectionMode }: { content: string; timestamp: number; collapsed?: boolean; messageId?: string; onStartShareSelection?: (messageId: string) => void; shareSelectionMode?: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

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
    <div className="mb-6 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-sol-border/40">
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          <span className="text-xs font-medium text-sol-text-muted">Plan</span>
          <span className="text-xs text-sol-text-dim">{formatRelativeTime(timestamp)}</span>
        </div>
        <div className="flex items-center gap-1">
          {onStartShareSelection && messageId && !shareSelectionMode && (
            <button
              onClick={() => onStartShareSelection(messageId)}
              className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors"
              title="Share"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            </button>
          )}
          <button
            onClick={() => setFullscreen(true)}
            className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors"
            title="Fullscreen"
          >
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
    <div className="font-mono text-xs p-2 overflow-x-auto">
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
  );
}

function MessageInput({ conversationId, status, embedded }: { conversationId: string; status?: string; embedded?: boolean }) {
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastStatus, setLastStatus] = useState<"delivered" | "failed" | null>(null);
  const sendMessage = useMutation(api.pendingMessages.sendMessageToSession);

  const isInactive = status && status !== "active";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setLastStatus(null);

    try {
      await sendMessage({
        conversation_id: conversationId as Id<"conversations">,
        content: message.trim(),
      });
      setLastStatus("delivered");
      setMessage("");
      toast.success("Message sent");

      setTimeout(() => setLastStatus(null), 2000);
    } catch (error) {
      setLastStatus("failed");
      toast.error(error instanceof Error ? error.message : "Failed to send message");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="sticky bottom-0 z-30 pointer-events-none mt-auto">
      <div className="h-16 bg-gradient-to-t from-sol-bg via-sol-bg/80 to-transparent" />
      <div className="bg-sol-bg pb-4 pointer-events-auto">
        {isInactive && (
          <div className="max-w-2xl mx-auto px-4 mb-2">
            <div className="bg-sol-blue/10 border border-sol-blue/30 rounded-lg px-3 py-2 text-xs text-sol-text-secondary">
              This session is inactive. Sending a message will auto-resume it in a new terminal.
            </div>
          </div>
        )}
        <form onSubmit={handleSubmit} className="max-w-2xl mx-auto px-4">
          <div className="flex items-center gap-2 bg-sol-bg-alt border border-sol-border rounded-full px-4 py-2 shadow-lg">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={isSubmitting}
              placeholder="Send a message to this session..."
              className="flex-1 bg-transparent text-sol-text text-sm placeholder:text-sol-text-dim focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!message.trim() || isSubmitting}
              className="px-4 py-1.5 bg-sol-blue hover:bg-sol-cyan text-white rounded-full text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Sending...
                </>
              ) : lastStatus === "delivered" ? (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Sent
                </>
              ) : (
                "Send"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export const ConversationView = forwardRef<ConversationViewHandle, ConversationViewProps>(
  function ConversationView({ conversation, commits = [], pullRequests = [], backHref, backLabel = "Back", headerExtra, hasMoreAbove, hasMoreBelow, isLoadingOlder, isLoadingNewer, onLoadOlder, onLoadNewer, onJumpToStart, onJumpToEnd, highlightQuery, onClearHighlight, embedded, showMessageInput = true, targetMessageId }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  const [isNearTop, setIsNearTop] = useState(true);
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
  const scrollProgressRef = useRef<HTMLDivElement>(null);
  const hasScrolledToTarget = useRef(false);
  const jumpDirectionRef = useRef<'start' | 'end' | null>(null);
  const isPaginatingRef = useRef(false);
  const [shareSelectionMode, setShareSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [isCreatingShareLink, setIsCreatingShareLink] = useState(false);

  const generateShareLink = useMutation(api.messages.generateMessageShareLink);
  const forkFromMessage = useMutation(api.conversations.forkFromMessage);

  const messages = conversation?.messages || [];

  const forkPointMap = useMemo(() => {
    const map: Record<string, Array<{ _id: string; title: string; short_id?: string }>> = {};
    if (conversation?.fork_children) {
      for (const fork of conversation.fork_children) {
        if (fork.parent_message_uuid) {
          if (!map[fork.parent_message_uuid]) map[fork.parent_message_uuid] = [];
          map[fork.parent_message_uuid].push(fork);
        }
      }
    }
    return map;
  }, [conversation?.fork_children]);

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

  const handleForkFromMessage = useCallback(async (messageUuid: string) => {
    if (!conversation?._id) return;
    try {
      const result = await forkFromMessage({
        conversation_id: conversation._id.toString(),
        message_uuid: messageUuid,
      });
      toast.success("Conversation forked");
      window.location.href = `/conversation/${result.conversation_id}`;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to fork");
    }
  }, [conversation?._id, forkFromMessage]);

  const toolCallToChangeIndexMap = useMemo(() => {
    const fileChanges = extractFileChanges(messages as any);
    const map: Record<string, number> = {};
    for (const change of fileChanges) {
      map[change.id] = change.sequenceIndex;
    }
    return map;
  }, [messages]);

  const pendingPermissions = useQuery(
    api.permissions.getPendingPermissions,
    conversation?._id ? { conversation_id: conversation._id } : "skip"
  );

  // Merge messages, commits, and PRs into a single timeline
  type TimelineItem =
    | { type: 'message'; data: Message; timestamp: number }
    | { type: 'commit'; data: Commit; timestamp: number }
    | { type: 'pull_request'; data: PullRequest; timestamp: number };

  const timeline: TimelineItem[] = useMemo(() => {
    const items: TimelineItem[] = [
      ...messages.map(msg => ({ type: 'message' as const, data: msg, timestamp: msg.timestamp })),
      ...commits.map(commit => ({ type: 'commit' as const, data: commit, timestamp: commit.timestamp })),
      ...pullRequests.map(pr => ({ type: 'pull_request' as const, data: pr, timestamp: pr.created_at })),
    ];
    return items.sort((a, b) => a.timestamp - b.timestamp);
  }, [messages, commits, pullRequests]);

  // Find the actual scrollable container (may be parent when embedded)
  const getScrollContainer = (): HTMLElement | null => {
    const container = containerRef.current;
    if (!container) return null;
    if (!embedded) return container;
    let el = container.parentElement;
    while (el) {
      const style = getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        return el;
      }
      el = el.parentElement;
    }
    return container;
  };

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
        if (msg.role === "user" && msg.tool_results) return false;
        if (msg.role === "user" && msg.content && isCommandMessage(msg.content)) return false;
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
    getScrollElement: () => scrollContainerRef.current || containerRef.current,
    estimateSize: (index) => {
      const item = timeline[index];
      if (!item) return 100;

      if (item.type === 'commit') {
        return 80;
      }

      const msg = item.data as Message;
      if (collapsed) {
        if (msg.role === "system") return 0;
        if (msg.role === "user" && msg.tool_results) return 0;
        if (msg.role === "user" && msg.content && isCommandMessage(msg.content)) return 0;
        if (msg.role === "assistant") {
          const hasTextContent = msg.content && msg.content.trim().length > 0;
          if (!hasTextContent) return 0;
          // Check if there's an earlier assistant with text in this sequence
          for (let i = index - 1; i >= 0; i--) {
            const checkItem = timeline[i];
            if (checkItem.type !== 'message') continue;
            const checkMsg = checkItem.data as Message;
            if (checkMsg.role === "user" && (!checkMsg.tool_results || checkMsg.tool_results.length === 0)) {
              break;
            }
            if (checkMsg.role === "assistant" && checkMsg.content && checkMsg.content.trim().length > 0) {
              return 0; // Earlier message in sequence has text, this won't render
            }
          }
        }
        return 80;
      }

      if (msg.role === "system") return 60;
      if (msg.role === "user") {
        if (msg.tool_results) return 120;
        if (msg.content && isCommandMessage(msg.content)) return 50;
        const lines = (msg.content || "").split("\n").length;
        return Math.max(100, lines * 20 + 60);
      }
      if (msg.role === "assistant") {
        const toolCount = msg.tool_calls?.length || 0;
        const hasThinking = showThinking && msg.thinking && msg.thinking.trim().length > 0;
        const contentLines = (msg.content || "").split("\n").length;
        return Math.max(120, toolCount * 150 + (hasThinking ? 100 : 0) + contentLines * 20 + 60);
      }
      return 100;
    },
    overscan: 50,
    paddingEnd: 100,
    isScrollingResetDelay: 150,
  });


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
    const scrollContainer = getScrollContainer();
    if (!scrollContainer) return;

    // Update ref so virtualizer uses correct scroll element
    scrollContainerRef.current = scrollContainer;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
      isNearBottomRef.current = isNearBottom;

      setIsNearTop(scrollTop < 300);

      if (!isNearBottom) {
        setUserScrolled(true);
      }

      if (scrollProgressRef.current) {
        const items = virtualizer.getVirtualItems();
        if (items.length > 0) {
          const centerIdx = items[Math.floor(items.length / 2)].index;
          const totalMessages = conversation?.message_count || messages.length;
          const loadedMessages = messages.length;
          const startOffset = conversation?.loaded_start_index ?? 0;
          const tLen = Math.max(timeline.length, 1);
          const progress = totalMessages > 0 ? Math.max(0, Math.min(1, (startOffset + (centerIdx / tLen) * loadedMessages) / totalMessages)) : 1;
          scrollProgressRef.current.style.height = `${progress * 100}%`;
        }
      }

      // Load older messages when near top (within 300px)
      if (scrollTop < 300 && hasMoreAbove && !isLoadingOlder && onLoadOlder) {
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
      if (distanceFromBottom < 300 && hasMoreBelow && !isLoadingNewer && onLoadNewer) {
        isPaginatingRef.current = true;
        onLoadNewer();
      }
    };

    scrollContainer.addEventListener("scroll", handleScroll);
    return () => scrollContainer.removeEventListener("scroll", handleScroll);
  }, [embedded, hasMoreAbove, hasMoreBelow, isLoadingOlder, isLoadingNewer, onLoadOlder, onLoadNewer]);

  useEffect(() => {
    if (!scrollProgressRef.current) return;
    const items = virtualizer.getVirtualItems();
    if (items.length === 0) return;
    const centerIdx = items[Math.floor(items.length / 2)].index;
    const totalMessages = conversation?.message_count || messages.length;
    const loadedMessages = messages.length;
    const startOffset = conversation?.loaded_start_index ?? 0;
    const tLen = Math.max(timeline.length, 1);
    const progress = totalMessages > 0 ? Math.max(0, Math.min(1, (startOffset + (centerIdx / tLen) * loadedMessages) / totalMessages)) : 1;
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

    // Scroll to the anchor item, then fine-tune pixel offset
    virtualizer.scrollToIndex(newIndex, { align: 'start' });
    scrollAnchorRef.current = null;
    requestAnimationFrame(() => {
      const scrollContainer = scrollContainerRef.current || containerRef.current;
      if (!scrollContainer) return;
      // scrollToIndex put the item at viewport top; adjust so it's at original offset
      scrollContainer.scrollTop -= pixelOffset;
    });
  }, [timeline, virtualizer]);

  useEffect(() => {
    const hasNewMessages = timeline.length > prevTimelineLengthRef.current;
    prevTimelineLengthRef.current = timeline.length;

    // Only auto-scroll for real-time new messages, not forward pagination
    if (hasNewMessages && isPaginatingRef.current) {
      isPaginatingRef.current = false;
      return;
    }

    if (hasNewMessages && timeline.length > 0 && !highlightQuery && !targetMessageId && !window.location.hash && isNearBottomRef.current && !hasMoreBelow) {
      virtualizer.scrollToIndex(timeline.length - 1, { align: "end", behavior: "smooth" });
      setUserScrolled(false);
    }
  }, [timeline.length, virtualizer, highlightQuery, targetMessageId, hasMoreBelow]);

  const hasInitialScrolled = useRef(false);
  useEffect(() => {
    if (timeline.length > 0 && !hasInitialScrolled.current && !window.location.hash && !highlightQuery) {
      hasInitialScrolled.current = true;
      setTimeout(() => {
        virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
      }, 100);
    }
  }, [timeline.length, virtualizer, highlightQuery]);

  // Scroll after jump to start/end
  useEffect(() => {
    if (jumpDirectionRef.current && timeline.length > 0) {
      const dir = jumpDirectionRef.current;
      jumpDirectionRef.current = null;
      setTimeout(() => {
        if (dir === 'start') {
          virtualizer.scrollToIndex(0, { align: "start" });
          setUserScrolled(true);
        } else {
          virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
          setUserScrolled(false);
        }
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

  const title = conversation?.title || `Session ${conversation?.session_id?.slice(0, 8) || "..."}`;
  const truncatedTitle = title.length > 60 ? title.slice(0, 57) + "..." : title;

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

  const renderItem = (item: TimelineItem, index: number) => {
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
      return <SystemBlock key={msg._id} content={msg.content || ""} subtype={msg.subtype} timestamp={msg.timestamp} messageUuid={msg.message_uuid} />;
    }

    if (msg.role === "user") {
      if (msg.tool_results && msg.tool_results.length > 0) {
        if (collapsed) return null;
        const toolName = msg.tool_results[0]?.tool_use_id
          ? toolCallMap[msg.tool_results[0].tool_use_id]
          : undefined;
        return <ToolResultMessage key={msg._id} toolResults={msg.tool_results} toolName={toolName} />;
      }
      if (msg.content && msg.content.trim()) {
        if (isCommandMessage(msg.content)) {
          if (collapsed) return null;
          return <CommandStatusLine key={msg._id} content={msg.content} timestamp={msg.timestamp} />;
        }
        // Check if previous message was a compact_boundary - if so, render as compaction summary
        const prevItem = index > 0 ? timeline[index - 1] : null;
        const prevMsg = prevItem?.type === 'message' ? (prevItem.data as Message) : null;
        if (prevMsg?.role === 'system' && prevMsg?.subtype === 'compact_boundary') {
          return <CompactionSummaryBlock key={msg._id} content={msg.content} />;
        }
        const planContent = extractPlanContent(msg.content);
        if (planContent) {
          return <PlanBlock key={msg._id} content={planContent} timestamp={msg.timestamp} collapsed={collapsed} messageId={msg._id} onStartShareSelection={handleStartShareSelection} shareSelectionMode={shareSelectionMode} />;
        }
        const userName = conversation?.user?.name || conversation?.user?.email?.split("@")[0];
        return <UserPrompt key={msg._id} content={msg.content} timestamp={msg.timestamp} messageId={msg._id} messageUuid={msg.message_uuid} conversationId={conversation?._id} collapsed={collapsed} userName={userName} onOpenComments={() => setCommentMessageId(msg._id as Id<"messages">)} isHighlighted={highlightedMessageId === msg._id} shareSelectionMode={shareSelectionMode} isSelectedForShare={selectedMessageIds.has(msg._id)} onToggleShareSelection={() => handleToggleMessageSelection(msg._id)} onStartShareSelection={handleStartShareSelection} onForkFromMessage={handleForkFromMessage} forkChildren={msg.message_uuid ? forkPointMap[msg.message_uuid] : undefined} />;
      }
      return null;
    }

    if (msg.role === "assistant") {
      // Find previous non-tool-result message to determine if this is first in Claude sequence
      let prevNonToolResultIdx = index - 1;
      while (prevNonToolResultIdx >= 0) {
        const prevItem = timeline[prevNonToolResultIdx];
        if (prevItem.type === 'commit') {
          prevNonToolResultIdx--;
          continue;
        }
        const prev = prevItem.data as Message;
        // Skip user messages that are just tool results
        if (prev.role === "user" && prev.tool_results && prev.tool_results.length > 0) {
          prevNonToolResultIdx--;
          continue;
        }
        break;
      }
      const prevItem = prevNonToolResultIdx >= 0 ? timeline[prevNonToolResultIdx] : null;
      const prevMsg = prevItem?.type === 'message' ? (prevItem.data as Message) : null;
      const isFirstInSequence = !prevMsg || prevMsg.role !== "assistant";

      // Find the sequence start ID (first assistant message with text in this sequence)
      let sequenceStartId = msg._id;
      for (let i = index - 1; i >= 0; i--) {
        const checkItem = timeline[i];
        if (checkItem.type !== 'message') continue;
        const checkMsg = checkItem.data as Message;
        // Stop at user messages (except tool results)
        if (checkMsg.role === "user" && (!checkMsg.tool_results || checkMsg.tool_results.length === 0)) {
          break;
        }
        // Found an earlier assistant message with text - that's the sequence start
        if (checkMsg.role === "assistant" && checkMsg.content && checkMsg.content.trim().length > 0) {
          sequenceStartId = checkMsg._id;
        }
      }

      const isSequenceExpanded = expandedSequences.has(sequenceStartId);

      // Compute all message IDs in the current run (for sharing)
      const runMessageIds: string[] = [];
      for (let i = index; i >= 0; i--) {
        const checkItem = timeline[i];
        if (checkItem.type !== 'message') continue;
        const checkMsg = checkItem.data as Message;
        if (checkMsg.role === "user" && (!checkMsg.tool_results || checkMsg.tool_results.length === 0)) {
          break;
        }
        if (checkMsg.role === "assistant") {
          runMessageIds.unshift(checkMsg._id);
        }
      }
      for (let i = index + 1; i < timeline.length; i++) {
        const checkItem = timeline[i];
        if (checkItem.type !== 'message') continue;
        const checkMsg = checkItem.data as Message;
        if (checkMsg.role === "user" && (!checkMsg.tool_results || checkMsg.tool_results.length === 0)) {
          break;
        }
        if (checkMsg.role === "assistant") {
          runMessageIds.push(checkMsg._id);
        }
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
            if (checkMsg.role === "user" && (!checkMsg.tool_results || checkMsg.tool_results.length === 0)) {
              break;
            }
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
        ?.map(tc => globalToolResultMap[tc.id])
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
          showHeader={effectiveCollapsed ? true : (isFirstInSequence || (collapsed && msg._id === sequenceStartId))}
          onOpenComments={() => setCommentMessageId(msg._id as Id<"messages">)}
          toolCallToChangeIndexMap={toolCallToChangeIndexMap}
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
          model={conversation?.model}
        />
      );
    }

    return null;
  };

  return (
    <main className={`relative flex flex-col bg-sol-bg ${embedded ? "" : "h-screen"}`}>
      <header className={`border-b border-sol-border bg-sol-bg-alt shrink-0 ${embedded ? "sticky top-0 z-20 bg-sol-bg-alt" : ""}`}>
        <div className="max-w-4xl mx-auto px-2 sm:px-3 md:px-4 py-1">
          <div className="flex items-center gap-2 min-w-0">
            <Link
              href={backHref}
              className="text-sol-text-dim hover:text-sol-text-secondary transition-colors text-xs flex-shrink-0"
            >
              &larr;
            </Link>
            <h1 className="text-xs sm:text-sm font-medium text-sol-text-secondary truncate min-w-0 flex-1">{truncatedTitle}</h1>

            {conversation && (
              <div className="flex items-center gap-1 flex-shrink-0">
                <ConversationMetadata
                  agentType={conversation.agent_type}
                  model={conversation.model}
                  startedAt={conversation.started_at}
                  messageCount={conversation.message_count}
                  shortId={conversation.short_id}
                  conversationId={conversation._id}
                />

                {conversation.parent_conversation_id && (
                  <Link
                    href={`/conversation/${conversation.parent_conversation_id}`}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/20 transition-colors"
                    title="View parent conversation"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                    </svg>
                    Parent
                  </Link>
                )}

                {conversation.status === 'active' && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Active
                  </span>
                )}

                {(conversation.compaction_count ?? 0) > 0 && (
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-500 border border-amber-500/30"
                    title={`Context was compacted ${conversation.compaction_count} time${conversation.compaction_count === 1 ? '' : 's'}`}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                    {conversation.compaction_count}
                  </span>
                )}

                {((conversation.fork_count ?? 0) > 0 || conversation.forked_from_details || (conversation.fork_children?.length ?? 0) > 0) && (
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/30"
                    title={conversation.forked_from_details
                      ? `Forked from @${conversation.forked_from_details.username}`
                      : `${conversation.fork_count || conversation.fork_children?.length || 0} fork${(conversation.fork_count || conversation.fork_children?.length || 0) === 1 ? '' : 's'}`}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                    </svg>
                    {conversation.forked_from_details ? "fork" : (conversation.fork_count || conversation.fork_children?.length || 0)}
                  </span>
                )}

                {conversation.child_conversations && conversation.child_conversations.length > 0 && (
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30"
                    title={`${conversation.child_conversations.length} subagent${conversation.child_conversations.length > 1 ? 's' : ''}`}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                    {conversation.child_conversations.length}
                  </span>
                )}

                {conversation.git_branch && (
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/5 text-emerald-400/80 border border-emerald-500/20 max-w-[150px] cursor-default"
                    title={conversation.git_branch}
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
                )}

                {taskStats && (
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border ${
                      taskStats.completed === taskStats.total
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : 'bg-sol-bg-highlight text-sol-text-dim border-sol-border/30'
                    }`}
                    title={`Tasks: ${taskStats.completed} completed of ${taskStats.total}`}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {taskStats.completed}/{taskStats.total}
                  </span>
                )}

                {latestTodos && latestTodos.todos.length > 0 && (
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border ${
                      latestTodos.todos.filter((t: any) => t.status === 'completed').length === latestTodos.todos.length
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : 'bg-sol-bg-highlight text-sol-text-dim border-sol-border/30'
                    }`}
                    title={`Todos: ${latestTodos.todos.filter((t: any) => t.status === 'completed').length} completed of ${latestTodos.todos.length}`}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                    </svg>
                    {latestTodos.todos.filter((t: any) => t.status === 'completed').length}/{latestTodos.todos.length}
                  </span>
                )}

                {latestUsage && (
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-sol-bg-highlight text-sol-text-dim border border-sol-border/30"
                    title={`Context: ${Math.round((latestUsage.contextSize / 200000) * 100)}% used`}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                    {Math.round((latestUsage.contextSize / 200000) * 100)}%
                  </span>
                )}

                {headerExtra}

                {highlightQuery && (
                  <div className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-amber-200/50 dark:bg-amber-800/30 text-amber-800 dark:text-amber-200">
                    <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <span className="max-w-[100px] truncate" title={highlightQuery}>{highlightQuery}</span>
                    {allMatchingMessageIds.length > 0 && (
                      <>
                        <span className="text-[10px] opacity-70 ml-1">
                          {currentMatchIndex + 1}/{allMatchingMessageIds.length}
                        </span>
                        <button
                          onClick={goToPrevMatch}
                          className="p-0.5 hover:bg-amber-300/50 dark:hover:bg-amber-700/40 rounded transition-colors"
                          title="Previous match"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                          </svg>
                        </button>
                        <button
                          onClick={goToNextMatch}
                          className="p-0.5 hover:bg-amber-300/50 dark:hover:bg-amber-700/40 rounded transition-colors"
                          title="Next match"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>
                      </>
                    )}
                    {allMatchingMessageIds.length === 0 && (
                      <span className="text-[10px] opacity-70 ml-1">0 matches</span>
                    )}
                    <button
                      onClick={onClearHighlight}
                      className="p-0.5 hover:bg-amber-300/50 dark:hover:bg-amber-700/40 rounded transition-colors ml-1"
                      title="Clear search"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                )}

                <button
                  onClick={handleCopyAll}
                  className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors"
                  title="Copy all messages"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>

                {conversation?.session_id && (
                  <button
                    onClick={async () => {
                      try {
                        const cmd = conversation.agent_type === 'codex'
                          ? `codex resume ${conversation.session_id}`
                          : `claude --resume ${conversation.session_id}`;
                        await copyToClipboard(cmd);
                        toast.success("Resume command copied");
                      } catch {
                        toast.error("Failed to copy");
                      }
                    }}
                    className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors"
                    title="Copy resume command"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </button>
                )}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                      </svg>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setCollapsed((c) => !c)}>
                      {collapsed ? "Expand messages" : "Collapse messages"}
                      <span className="ml-auto text-[10px] text-sol-text-dim">Cmd+Shift+C</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setShowThinking((s) => !s)}>
                      {showThinking ? "Hide thinking" : "Show thinking"}
                    </DropdownMenuItem>
                    {conversation.git_branch && (
                      <DropdownMenuItem onClick={() => setDiffExpanded(!diffExpanded)}>
                        {diffExpanded ? "Hide git diff" : "Show git diff"}
                      </DropdownMenuItem>
                    )}
                    {conversation.parent_conversation_id && (
                      <DropdownMenuItem asChild>
                        <Link href={`/conversation/${conversation.parent_conversation_id}`}>
                          View parent conversation
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {conversation.forked_from_details && (
                      <DropdownMenuItem asChild>
                        <Link href={conversation.forked_from_details.share_token ? `/share/${conversation.forked_from_details.share_token}` : `/conversation/${conversation.forked_from_details.conversation_id}`}>
                          <svg className="w-3 h-3 mr-1.5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                          </svg>
                          Forked from @{conversation.forked_from_details.username}
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {((conversation.fork_children && conversation.fork_children.length > 0) || conversation.forked_from) && (
                      <>
                        <DropdownMenuSeparator />
                        <ConversationTree conversationId={conversation._id.toString()} />
                      </>
                    )}
                    {conversation.child_conversations && conversation.child_conversations.length > 0 && (
                      <DropdownMenuItem disabled>
                        {conversation.child_conversations.length} subagent{conversation.child_conversations.length > 1 ? "s" : ""}
                      </DropdownMenuItem>
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
            )}
          </div>
        </div>
      </header>

      {diffExpanded && conversation && (conversation.git_diff?.trim() || conversation.git_diff_staged?.trim()) && (
        <GitDiffPanel
          gitDiff={conversation.git_diff}
          gitDiffStaged={conversation.git_diff_staged}
        />
      )}

      <div ref={containerRef} className={`flex-1 min-h-0 ${embedded ? "" : "overflow-y-auto"}`} style={{ overflowAnchor: "auto" }}>
        <div className="min-h-full flex flex-col">
        {!conversation ? (
          <ConversationSkeleton />
        ) : timeline.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-sol-text-dim text-sm">
            No messages in this conversation
          </div>
        ) : (
          <>
          {conversation?.parent_conversation_id && !hasMoreAbove && (
            <div className="max-w-4xl mx-auto px-2 sm:px-3 md:px-4 pt-2 pb-1">
              <Link
                href={`/conversation/${conversation.parent_conversation_id}`}
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
            className="flex-1"
            style={{
              minHeight: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {/* Earlier messages indicator at top */}
            {hasMoreAbove && !isLoadingOlder && (
              <div className="sticky top-0 z-10 flex justify-center py-2 pointer-events-none">
                <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-sol-bg border border-sol-border text-sol-text-muted0 text-xs shadow-sm pointer-events-auto">
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
              <div className="sticky top-0 z-10 flex justify-center py-2 pointer-events-none">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-sol-bg-alt/90 border border-sol-border text-sol-text-muted text-xs pointer-events-auto">
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
                  }}
                >
                  {content && (
                    <div className={`max-w-4xl mx-auto px-2 sm:px-3 md:px-4 ${collapsed ? "py-0.5" : "py-1"} ${isSearchDimmed ? "opacity-25" : ""} transition-opacity`}>
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
          {conversation?.child_conversations && conversation.child_conversations.length > 0 && !hasMoreBelow && (
            <div className="max-w-4xl mx-auto px-2 sm:px-3 md:px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] text-sol-text-dim uppercase tracking-wider">Subagents</span>
                {conversation.child_conversations.map((child) => (
                  <Link
                    key={child._id}
                    href={`/conversation/${child._id}`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-sol-cyan/10 text-sol-cyan/70 border border-sol-cyan/20 hover:bg-sol-cyan/20 hover:text-sol-cyan transition-colors truncate max-w-[200px]"
                  >
                    <svg className="w-2.5 h-2.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                    {child.title}
                  </Link>
                ))}
              </div>
            </div>
          )}
          </>
        )}

          {showMessageInput && conversation && (
            <MessageInput conversationId={conversation._id} status={conversation.status} embedded={embedded} />
          )}
        </div>
      </div>

      {timeline.length > 0 && (
        <div className="fixed bottom-24 right-8 z-30 flex items-center gap-2.5">
          <div className="flex flex-col gap-2">
            {(!isNearTop || hasMoreAbove) && (
              <button
                onClick={() => {
                  if (hasMoreAbove && onJumpToStart) {
                    jumpDirectionRef.current = 'start';
                    onJumpToStart();
                  } else if (embedded && containerRef.current) {
                    let el = containerRef.current.parentElement;
                    while (el) {
                      const style = getComputedStyle(el);
                      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                        el.scrollTo({ top: 0 });
                        break;
                      }
                      el = el.parentElement;
                    }
                  } else {
                    virtualizer.scrollToIndex(0, { align: "start" });
                  }
                }}
                className="p-2 rounded-full bg-sol-bg-alt border border-sol-border shadow-lg hover:bg-sol-cyan hover:text-white transition-all"
                aria-label="Scroll to top"
              >
                {isLoadingOlder ? (
                  <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                  </svg>
                )}
              </button>
            )}
            {(userScrolled || hasMoreBelow) && (
              <button
                onClick={() => {
                  if (hasMoreBelow && onJumpToEnd) {
                    jumpDirectionRef.current = 'end';
                    onJumpToEnd();
                  } else if (embedded && containerRef.current) {
                    let el = containerRef.current.parentElement;
                    while (el) {
                      const style = getComputedStyle(el);
                      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                        break;
                      }
                      el = el.parentElement;
                    }
                  } else {
                    virtualizer.scrollToIndex(timeline.length - 1, { align: "end", behavior: "smooth" });
                  }
                  setUserScrolled(false);
                }}
                className="p-2 rounded-full bg-sol-bg-alt border border-sol-border shadow-lg hover:bg-sol-cyan hover:text-white transition-all"
                aria-label="Scroll to bottom"
              >
                {isLoadingNewer ? (
                  <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                  </svg>
                )}
              </button>
            )}
          </div>
          {(conversation?.message_count ?? 0) > 150 && (!isNearTop || userScrolled || hasMoreAbove || hasMoreBelow) && (
            <div className="w-2 h-16 rounded-full relative shadow-[0_0_4px_1px_rgba(0,0,0,0.12)]">
              <div className="w-full h-full rounded-full bg-black/[0.06] overflow-hidden">
                <div
                  ref={scrollProgressRef}
                  className="w-full rounded-full bg-sol-cyan"
                  style={{ height: '0%', transition: 'height 0.15s ease-out' }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {pendingPermissions && pendingPermissions.length > 0 && (
        <div className={`border-t border-sol-border bg-sol-bg-alt shrink-0 ${embedded ? "-mx-[9999px] px-[9999px]" : ""}`}>
          <div className="max-w-4xl mx-auto px-2 sm:px-3 md:px-4 py-2 space-y-2">
            {pendingPermissions.map((permission) => (
              <PermissionCard key={permission._id} permission={permission} />
            ))}
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
