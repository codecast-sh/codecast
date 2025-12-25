"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useMemo, useImperativeHandle, forwardRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import "highlight.js/styles/base16/solarized-dark.css";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isCommandMessage, getCommandType, cleanContent } from "../lib/conversationProcessor";
import { createReducer, reducer } from "../lib/messageReducer";
import { UsageDisplay } from "./UsageDisplay";
import { toast } from "sonner";
import { CodeBlock } from "./CodeBlock";
import { useDiffViewerStore } from "../store/diffViewerStore";
import { extractFileChanges } from "../lib/fileChangeExtractor";
import { CommitCard } from "./CommitCard";
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
  data: string;
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
  status?: "active" | "completed";
  fork_count?: number;
  forked_from?: string;
  forked_from_details?: {
    conversation_id: string;
    share_token?: string;
    username: string;
  } | null;
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
};

type ConversationViewProps = {
  conversation: ConversationData | null | undefined;
  commits?: Commit[];
  backHref: string;
  backLabel?: string;
  headerExtra?: React.ReactNode;
  hasMoreAbove?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
  highlightQuery?: string;
  embedded?: boolean;
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
  messageCount
}: {
  agentType?: string;
  model?: string;
  startedAt?: number;
  messageCount?: number;
}) {
  if (!agentType && !model && !startedAt && !messageCount) return null;

  return (
    <div className="flex items-center gap-1.5 sm:gap-2 md:gap-3 text-[10px] sm:text-xs text-sol-text-dim flex-wrap">
      {agentType && (
        <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
          <AgentTypeIcon agentType={agentType} />
          <span className="hidden sm:inline">{formatAgentType(agentType)}</span>
        </div>
      )}
      {model && (
        <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
          <span className="text-sol-text-dim hidden sm:inline">•</span>
          <span className="font-mono truncate max-w-[120px] sm:max-w-none" title={model}>{formatModel(model)}</span>
        </div>
      )}
      {startedAt && (
        <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
          <span className="text-sol-text-dim hidden sm:inline">•</span>
          <span title={formatFullTimestamp(startedAt)}>{formatRelativeTime(startedAt)}</span>
        </div>
      )}
      {messageCount !== undefined && messageCount > 0 && (
        <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
          <span className="text-sol-text-dim hidden sm:inline">•</span>
          <span>{messageCount} {messageCount === 1 ? "msg" : "msgs"}</span>
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
            {model}
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
        <div className="text-sol-text-secondary text-xs font-mono whitespace-pre-wrap leading-relaxed">
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
    sh: "bash", bash: "bash", zsh: "bash",
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

function ToolBlock({ tool, result, changeIndex }: { tool: ToolCall; result?: ToolResult; changeIndex?: number }) {
  const isEdit = tool.name === "Edit" || tool.name === "Write";
  const [expanded, setExpanded] = useState(isEdit);
  const isRead = tool.name === "Read";
  const isBash = tool.name === "Bash";
  const isGlob = tool.name === "Glob";
  const isGrep = tool.name === "Grep";

  const { selectedChangeIndex, rangeStart, rangeEnd, selectChange, selectRange } = useDiffViewerStore();

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const filePath = String(parsedInput.file_path || "");
  const relativePath = getRelativePath(filePath);
  const language = getFileExtension(filePath);

  const getToolSummary = () => {
    if (isEdit || isRead) return relativePath;
    if (isBash && parsedInput.command) {
      const cmd = String(parsedInput.command);
      return cmd.length > 100 ? cmd.slice(0, 100) + "..." : cmd;
    }
    if (isGlob && parsedInput.pattern) return String(parsedInput.pattern);
    if (isGrep && parsedInput.pattern) return String(parsedInput.pattern);
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
    if (isGlob || isGrep) {
      const lines = result.content.trim().split("\n").filter(l => l.trim()).length;
      return `(${lines} matches)`;
    }
    return null;
  };

  const summary = getToolSummary();
  const resultSummary = getResultSummary();

  // Process result content - strip line numbers for Read tool
  const processedContent = result ? (isRead ? stripLineNumbers(result.content) : result.content) : "";

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
    TodoWrite: "text-sol-magenta/80",
  };

  const toolColor = toolColors[tool.name] || "text-sol-text-dim";

  const isClickable = isEdit && changeIndex !== undefined;
  const isSelected = isClickable && (
    selectedChangeIndex === changeIndex ||
    (rangeStart !== null && rangeEnd !== null && changeIndex >= rangeStart && changeIndex <= rangeEnd)
  );

  const handleClick = (e: React.MouseEvent) => {
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
        <span className={`font-mono ${toolColor}`}>{tool.name}</span>
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
          {isEdit && !!parsedInput.old_string && !!parsedInput.new_string ? (
            <DiffView
              oldStr={String(parsedInput.old_string)}
              newStr={String(parsedInput.new_string)}
              startLine={startLine}
              language={language}
            />
          ) : tool.name === "Write" && !!parsedInput.content ? (
            <DiffView
              oldStr=""
              newStr={String(parsedInput.content)}
              startLine={1}
              language={language}
            />
          ) : isBash && parsedInput.command ? (
            <div className="max-h-80 overflow-auto">
              <div className="px-2 py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
                <pre className="text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
                  $ {String(parsedInput.command)}
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
              {language && (
                <div className="text-[10px] px-2 py-1 border-b border-sol-border/20 text-sol-text-dim">
                  {language}
                </div>
              )}
              <pre className={`p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap ${result?.is_error ? "text-sol-red" : "text-sol-text-secondary"}`}>
                {processedContent}
              </pre>
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

function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = truncateLines(content, expanded ? 50 : 2);
  const isTruncated = truncated.truncated;

  return (
    <div className="my-0.5 opacity-50">
      <div
        className={`flex items-start gap-1 ${isTruncated || expanded ? 'cursor-pointer' : ''}`}
        onClick={() => (isTruncated || expanded) && setExpanded(!expanded)}
      >
        {(isTruncated || expanded) && (
          <svg
            className={`w-3 h-3 mt-0.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        )}
        <div className="flex-1 text-sol-text-muted font-mono whitespace-pre-wrap text-xs">
          {truncated.text}
          {truncated.truncated && !expanded && "..."}
        </div>
      </div>
    </div>
  );
}

function ImageBlock({ image }: { image: ImageData }) {
  return (
    <div className="my-2">
      <img
        src={`data:${image.media_type};base64,${image.data}`}
        alt="User provided image"
        className="max-w-md rounded border border-sol-border"
      />
    </div>
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

function UserPrompt({ content, timestamp, messageId, collapsed, userName, onOpenComments, isHighlighted }: { content: string; timestamp: number; messageId: string; collapsed?: boolean; userName?: string; onOpenComments?: () => void; isHighlighted?: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const MAX_LINES = 25;
  const COLLAPSED_LINES = 2;
  const lines = content.split("\n");

  // In collapsed mode, individual expansion is allowed
  const effectivelyCollapsed = collapsed && !isExpanded;
  const needsTruncation = !effectivelyCollapsed && lines.length > MAX_LINES;

  let displayContent: string;
  let wasTruncated = false;

  if (effectivelyCollapsed) {
    displayContent = lines.slice(0, COLLAPSED_LINES).join("\n");
    wasTruncated = lines.length > COLLAPSED_LINES;
  } else if (needsTruncation && !isExpanded) {
    displayContent = lines.slice(0, MAX_LINES).join("\n");
    wasTruncated = true;
  } else {
    displayContent = content;
  }

  const commentCount = useQuery(api.comments.getCommentCount, {
    message_id: messageId as Id<"messages">,
  });

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success("Copied!");
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  const handleExpand = () => {
    if (effectivelyCollapsed || needsTruncation) {
      setIsExpanded(!isExpanded);
    }
  };

  return (
    <div id={`msg-${messageId}`} className={`group bg-sol-blue/10 border border-sol-blue/30 rounded-lg scroll-mt-20 p-4 mb-6 relative transition-all ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg" : ""}`}>
      <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
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
          title={formatFullTimestamp(timestamp)}
        >
          {formatRelativeTime(timestamp)}
        </a>
      </div>
      <div
        className={`text-sol-text text-sm pl-8 whitespace-pre-wrap ${(effectivelyCollapsed || (needsTruncation && !isExpanded)) ? "cursor-pointer hover:bg-sol-blue/5 -mx-2 px-2 py-1 rounded transition-colors" : ""}`}
        onClick={handleExpand}
      >
        {displayContent}{wasTruncated && !isExpanded && "..."}
      </div>
      {wasTruncated && (
        <button
          onClick={handleExpand}
          className="text-xs text-sol-text-dim hover:text-sol-blue mt-2 ml-8 transition-colors"
        >
          {isExpanded ? "Show less" : effectivelyCollapsed ? `Show all (${lines.length} lines)` : `Show ${lines.length - MAX_LINES} more lines`}
        </button>
      )}
    </div>
  );
}

function AssistantBlock({
  content,
  timestamp,
  thinking,
  toolCalls,
  toolResults,
  images,
  messageId,
  messageUuid,
  collapsed,
  childConversationMap,
  showHeader = true,
  onOpenComments,
  toolCallToChangeIndexMap,
  isHighlighted,
}: {
  content?: string;
  timestamp: number;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  images?: ImageData[];
  messageId: string;
  messageUuid?: string;
  collapsed?: boolean;
  childConversationMap?: Record<string, string>;
  showHeader?: boolean;
  onOpenComments?: () => void;
  toolCallToChangeIndexMap?: Record<string, number>;
  isHighlighted?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const COLLAPSED_LINES = 2;

  const hasContent = content && content.trim().length > 0;
  const hasThinking = thinking && thinking.trim().length > 0;
  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const hasImages = images && images.length > 0;

  // Effective collapsed state allows individual expansion
  const effectivelyCollapsed = collapsed && !isExpanded;

  const commentCount = useQuery(api.comments.getCommentCount, {
    message_id: messageId as Id<"messages">,
  });

  const toolResultMap = useMemo(() => {
    const map: Record<string, ToolResult> = {};
    if (toolResults) {
      for (const r of toolResults) {
        map[r.tool_use_id] = r;
      }
    }
    return map;
  }, [toolResults]);

  if (!hasContent && !hasThinking && !hasToolCalls && !hasImages) {
    return null;
  }

  const lines = content ? content.split("\n") : [];
  const getCollapsedContent = () => {
    if (!effectivelyCollapsed || !content) return { text: content || "", wasTruncated: false };
    if (lines.length <= COLLAPSED_LINES) return { text: content, wasTruncated: false };
    return { text: lines.slice(0, COLLAPSED_LINES).join("\n"), wasTruncated: true };
  };
  const { text: truncatedContent, wasTruncated } = getCollapsedContent();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content || "");
      toast.success("Copied!");
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  // Only show Claude header for first message in sequence and messages with actual content
  const shouldShowHeader = showHeader && (hasContent || hasThinking);
  const onlyToolCalls = hasToolCalls && !hasContent && !hasThinking;

  const handleExpand = () => {
    if (effectivelyCollapsed) {
      setIsExpanded(true);
    }
  };

  // When collapsed and only tool calls (no text content), hide completely
  if (effectivelyCollapsed && onlyToolCalls) {
    return null;
  }

  // Determine if we need to show expand button (has hidden content)
  const hasHiddenContent = effectivelyCollapsed && (wasTruncated || hasToolCalls || hasThinking || hasImages);

  return (
    <div id={`msg-${messageId}`} className={`group scroll-mt-20 ${effectivelyCollapsed ? "mb-1" : onlyToolCalls ? "mb-1" : "mb-6"} relative transition-all ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg rounded-lg p-2 -m-2" : ""}`}>
      {hasContent && (
        <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 z-10">
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
          <ClaudeIcon />
          <span className="text-sol-text-secondary text-xs font-medium">Claude</span>
          <a
            href={`#msg-${messageId}`}
            className="text-sol-text-dim hover:text-sol-text-muted text-xs transition-colors"
            title={formatFullTimestamp(timestamp)}
          >
            {formatRelativeTime(timestamp)}
          </a>
        </div>
      )}

      <div className={shouldShowHeader || !showHeader ? "pl-8" : "pl-0"}>
        {!effectivelyCollapsed && hasImages && images?.map((img, i) => <ImageBlock key={i} image={img} />)}

        {!effectivelyCollapsed && hasThinking && <ThinkingBlock content={thinking!} />}

        {!effectivelyCollapsed && hasToolCalls && toolCalls?.map((tc) => (
          tc.name === "Task" ? (
            <TaskToolBlock
              key={tc.id}
              tool={tc}
              result={toolResultMap[tc.id]}
              childConversationId={messageUuid && childConversationMap ? childConversationMap[messageUuid] : undefined}
            />
          ) : tc.name === "TodoWrite" ? (
            <TodoWriteBlock key={tc.id} tool={tc} />
          ) : (
            <ToolBlock
              key={tc.id}
              tool={tc}
              result={toolResultMap[tc.id]}
              changeIndex={toolCallToChangeIndexMap?.[tc.id]}
            />
          )
        ))}

        {hasContent && (
          <div
            className={`text-sol-text ${effectivelyCollapsed ? "text-sm whitespace-pre-wrap cursor-pointer hover:bg-sol-bg-alt/30 -mx-2 px-2 py-1 rounded transition-colors" : "prose prose-invert prose-sm max-w-none"}`}
            onClick={effectivelyCollapsed ? handleExpand : undefined}
          >
            {effectivelyCollapsed ? (
              <>
                <span>{truncatedContent}</span>
                {wasTruncated && <span className="text-sol-text-dim">...</span>}
              </>
            ) : (
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
            )}
          </div>
        )}

        {hasHiddenContent && (
          <button
            onClick={handleExpand}
            className="text-xs text-sol-text-dim hover:text-sol-text-muted mt-1 transition-colors"
          >
            Show all
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

function SystemBlock({ content, subtype }: { content: string; subtype?: string }) {
  const subtypeLabels: Record<string, string> = {
    local_command: "command",
    stop_hook_summary: "hook",
    compact_boundary: "compact",
  };

  return (
    <div className="mb-4 px-3 py-2 bg-sol-bg-alt/20 border-l-2 border-sol-border text-xs">
      <span className="text-sol-text-dim text-[10px] mr-2">
        {subtypeLabels[subtype || ""] || "system"}
      </span>
      <span className="text-sol-text-muted font-mono">
        {content.replace(/<[^>]+>/g, "").slice(0, 200)}
        {content.length > 200 && "..."}
      </span>
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

function MessageInput({ conversationId }: { conversationId: string }) {
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastStatus, setLastStatus] = useState<"delivered" | "failed" | null>(null);
  const sendMessage = useMutation(api.pendingMessages.sendMessageToSession);

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
    <div className="border-t border-sol-border bg-sol-bg-alt/80 backdrop-blur shrink-0">
      <form onSubmit={handleSubmit} className="max-w-4xl mx-auto px-4 py-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={isSubmitting}
            placeholder="Send a message to this session..."
            className="flex-1 px-3 py-2 bg-sol-bg border border-sol-border rounded text-sol-text text-sm placeholder:text-sol-text-dim focus:outline-none focus:ring-1 focus:ring-sol-blue disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!message.trim() || isSubmitting}
            className="px-4 py-2 bg-sol-blue hover:bg-sol-cyan text-white rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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
  );
}

export const ConversationView = forwardRef<ConversationViewHandle, ConversationViewProps>(
  function ConversationView({ conversation, commits = [], backHref, backLabel = "Back", headerExtra, hasMoreAbove, isLoadingOlder, onLoadOlder, highlightQuery, embedded }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [diffExpanded, setDiffExpanded] = useState(false);
  const [commentMessageId, setCommentMessageId] = useState<Id<"messages"> | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const prevScrollHeightRef = useRef<number>(0);
  const shouldRestoreScrollRef = useRef(false);

  const messages = conversation?.messages || [];

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

  // Merge messages and commits into a single timeline
  type TimelineItem =
    | { type: 'message'; data: Message; timestamp: number }
    | { type: 'commit'; data: Commit; timestamp: number };

  const timeline: TimelineItem[] = useMemo(() => {
    const items: TimelineItem[] = [
      ...messages.map(msg => ({ type: 'message' as const, data: msg, timestamp: msg.timestamp })),
      ...commits.map(commit => ({ type: 'commit' as const, data: commit, timestamp: commit.timestamp })),
    ];
    return items.sort((a, b) => a.timestamp - b.timestamp);
  }, [messages, commits]);

  // Track if we've already scrolled for this highlight query
  const hasScrolledToHighlight = useRef(false);

  // Find and highlight first message matching search query
  useEffect(() => {
    if (!highlightQuery || messages.length === 0) {
      setHighlightedMessageId(null);
      hasScrolledToHighlight.current = false;
      return;
    }
    const query = highlightQuery.toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    if (words.length === 0) return;

    for (const msg of messages) {
      const content = msg.content?.toLowerCase() || "";
      if (words.some(word => content.includes(word))) {
        setHighlightedMessageId(msg._id);
        return;
      }
    }
  }, [highlightQuery, messages]);

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
      await navigator.clipboard.writeText(formattedMessages);
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
        if (msg.role === "user" && msg.tool_results) return 0;
        if (msg.role === "user" && msg.content && isCommandMessage(msg.content)) return 0;
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
        const hasThinking = msg.thinking && msg.thinking.trim().length > 0;
        const contentLines = (msg.content || "").split("\n").length;
        return Math.max(120, toolCount * 150 + (hasThinking ? 100 : 0) + contentLines * 20 + 60);
      }
      return 100;
    },
    overscan: 5,
    paddingEnd: 100,
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
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
      setUserScrolled(!isNearBottom);

      // Load older messages when near top (within 300px)
      if (scrollTop < 300 && hasMoreAbove && !isLoadingOlder && onLoadOlder) {
        prevScrollHeightRef.current = scrollHeight;
        shouldRestoreScrollRef.current = true;
        onLoadOlder();
      }
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, [hasMoreAbove, isLoadingOlder, onLoadOlder]);

  // Restore scroll position after loading older messages
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !shouldRestoreScrollRef.current) return;

    // After messages are prepended, adjust scroll to maintain position
    const newScrollHeight = container.scrollHeight;
    const scrollDiff = newScrollHeight - prevScrollHeightRef.current;
    if (scrollDiff > 0) {
      container.scrollTop += scrollDiff;
    }
    shouldRestoreScrollRef.current = false;
  }, [messages.length]);

  useEffect(() => {
    if (!userScrolled && timeline.length > 0) {
      virtualizer.scrollToIndex(timeline.length - 1, { align: "end", behavior: "smooth" });
    }
  }, [timeline.length, userScrolled, virtualizer]);

  const hasInitialScrolled = useRef(false);
  useEffect(() => {
    if (timeline.length > 0 && !hasInitialScrolled.current && !window.location.hash) {
      hasInitialScrolled.current = true;
      setTimeout(() => {
        virtualizer.scrollToIndex(timeline.length - 1, { align: "end" });
      }, 100);
    }
  }, [timeline.length, virtualizer]);

  useEffect(() => {
    if (timeline.length && window.location.hash) {
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
  }, [timeline.length, virtualizer]);

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
        />
      );
    }

    const msg = item.data as Message;
    if (msg.role === "system") {
      if (collapsed) return null;
      return <SystemBlock key={msg._id} content={msg.content || ""} subtype={msg.subtype} />;
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
        const userName = conversation?.user?.name || conversation?.user?.email?.split("@")[0];
        return <UserPrompt key={msg._id} content={msg.content} timestamp={msg.timestamp} messageId={msg._id} collapsed={collapsed} userName={userName} onOpenComments={() => setCommentMessageId(msg._id as Id<"messages">)} isHighlighted={highlightedMessageId === msg._id} />;
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
      const relevantToolResults = msg.tool_calls
        ?.map(tc => globalToolResultMap[tc.id])
        .filter((tr): tr is ToolResult => tr !== undefined);
      return (
        <AssistantBlock
          key={msg._id}
          content={msg.content}
          timestamp={msg.timestamp}
          thinking={msg.thinking}
          toolCalls={msg.tool_calls}
          toolResults={relevantToolResults}
          images={msg.images}
          messageId={msg._id}
          messageUuid={msg.message_uuid}
          collapsed={collapsed}
          childConversationMap={conversation?.child_conversation_map}
          showHeader={isFirstInSequence}
          onOpenComments={() => setCommentMessageId(msg._id as Id<"messages">)}
          toolCallToChangeIndexMap={toolCallToChangeIndexMap}
          isHighlighted={highlightedMessageId === msg._id}
        />
      );
    }

    return null;
  };

  return (
    <main className={`flex flex-col bg-sol-bg ${embedded ? "h-[calc(100vh-56px)]" : "h-screen"}`}>
      <header className="border-b border-sol-border bg-sol-bg-alt/80 backdrop-blur shrink-0">
        <div className="max-w-4xl mx-auto px-2 sm:px-3 md:px-4 py-2 sm:py-3">
          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              href={backHref}
              className="text-sol-text-dim hover:text-sol-text-secondary transition-colors text-xs sm:text-sm flex-shrink-0"
            >
              &larr; {backLabel}
            </Link>
            <h1 className="text-xs sm:text-sm font-medium text-sol-text-secondary truncate min-w-0">{truncatedTitle}</h1>

            {conversation && (
              <>
                <ConversationMetadata
                  agentType={conversation.agent_type}
                  model={conversation.model}
                  startedAt={conversation.started_at}
                  messageCount={conversation.message_count}
                />
                {conversation.git_branch && (
                  <GitBranchBadge
                    gitBranch={conversation.git_branch}
                    gitStatus={conversation.git_status}
                    gitRemoteUrl={conversation.git_remote_url}
                    hasDiff={!!(conversation.git_diff?.trim() || conversation.git_diff_staged?.trim())}
                    diffExpanded={diffExpanded}
                    onToggleDiff={() => setDiffExpanded(!diffExpanded)}
                  />
                )}

                {conversation.parent_conversation_id && (
                  <Link
                    href={`/conversation/${conversation.parent_conversation_id}`}
                    className="text-sol-violet hover:text-sol-violet text-xs flex items-center gap-1 flex-shrink-0"
                    title="Parent conversation"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16l-4-4m0 0l4-4m-4 4h18" />
                    </svg>
                  </Link>
                )}

                {conversation.forked_from_details && (
                  <Link
                    href={conversation.forked_from_details.share_token ? `/share/${conversation.forked_from_details.share_token}` : `/conversation/${conversation.forked_from_details.conversation_id}`}
                    className="text-sol-text-secondary text-xs flex items-center gap-1 px-2 py-0.5 rounded bg-sol-bg-alt border border-sol-border hover:bg-sol-bg-hover transition-colors flex-shrink-0"
                    title="View original conversation"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    Forked from @{conversation.forked_from_details.username}
                  </Link>
                )}

                {conversation.child_conversations && conversation.child_conversations.length > 0 && (
                  <span className="text-sol-cyan text-xs flex-shrink-0" title={`${conversation.child_conversations.length} subagent${conversation.child_conversations.length > 1 ? "s" : ""}`}>
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                    </svg>
                  </span>
                )}

                {latestTodos && latestTodos.todos.length > 0 && (
                  <span className="text-sol-text-secondary text-xs flex items-center gap-1 px-2 py-0.5 rounded bg-sol-bg-alt border border-sol-border flex-shrink-0" title="Tasks completed">
                    <svg className="w-3 h-3 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                    </svg>
                    {latestTodos.todos.filter(t => t.status === 'completed').length}/{latestTodos.todos.length}
                  </span>
                )}

                <button
                  onClick={handleCopyAll}
                  className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors flex-shrink-0"
                  title="Copy all messages"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>

                {headerExtra}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors flex-shrink-0">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                      </svg>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setCollapsed((c) => !c)}>
                      {collapsed ? "Expand messages" : "Collapse messages"}
                      <span className="ml-auto text-[10px] text-sol-text-dim">Cmd+Shift+C</span>
                    </DropdownMenuItem>
                    {conversation?.session_id && (
                      <DropdownMenuItem onClick={() => {
                        navigator.clipboard.writeText(`claude --resume ${conversation.session_id}`);
                        toast.success("Resume command copied");
                      }}>
                        Copy resume command
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
              </>
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

      <div ref={containerRef} className="flex-1 overflow-y-auto">
        {!conversation ? (
          <ConversationSkeleton />
        ) : timeline.length === 0 ? (
          <div className="text-sol-text-dim text-center py-8 text-sm">
            No messages in this conversation
          </div>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {/* Earlier messages indicator at top */}
            {hasMoreAbove && !isLoadingOlder && (
              <div className="sticky top-0 z-10 flex justify-center py-2">
                <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-sol-bg border border-sol-border text-sol-text-muted0 text-xs shadow-sm">
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
              <div className="sticky top-0 z-10 flex justify-center py-2">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-sol-bg-alt/90 border border-sol-border text-sol-text-muted text-xs">
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
                  <div className={`max-w-4xl mx-auto px-2 sm:px-3 md:px-4 ${collapsed ? "py-0.5" : "py-1"}`}>
                    {renderItem(item, virtualItem.index)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {pendingPermissions && pendingPermissions.length > 0 && (
        <div className="border-t border-sol-border bg-sol-bg-alt/80 backdrop-blur shrink-0">
          <div className="max-w-4xl mx-auto px-2 sm:px-3 md:px-4 py-3 space-y-2">
            {pendingPermissions.map((permission) => (
              <PermissionCard key={permission._id} permission={permission} />
            ))}
          </div>
        </div>
      )}

      {conversation && conversation.status === "active" && (
        <MessageInput conversationId={conversation._id} />
      )}

      {commentMessageId && conversation && (
        <CommentPanel
          conversationId={conversation._id as Id<"conversations">}
          messageId={commentMessageId}
          onClose={() => setCommentMessageId(null)}
        />
      )}
    </main>
  );
});
