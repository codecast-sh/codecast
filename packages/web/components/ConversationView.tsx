"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useMemo } from "react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

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
  _id: string;
  title?: string;
  session_id?: string;
  agent_type?: string;
  share_token?: string;
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
};

type ConversationViewProps = {
  conversation: ConversationData | null | undefined;
  backHref: string;
  backLabel?: string;
  headerExtra?: React.ReactNode;
};

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ClaudeIcon() {
  return (
    <div className="w-6 h-6 rounded bg-sol-yellow flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path
          d="M7 8.5C7 7.67 7.67 7 8.5 7H11C11.83 7 12.5 7.67 12.5 8.5V11C12.5 11.83 11.83 12.5 11 12.5H8.5C7.67 12.5 7 11.83 7 11V8.5Z"
          fill="white"
        />
        <path
          d="M11.5 13C11.5 12.17 12.17 11.5 13 11.5H15.5C16.33 11.5 17 12.17 17 13V15.5C17 16.33 16.33 17 15.5 17H13C12.17 17 11.5 16.33 11.5 15.5V13Z"
          fill="white"
        />
      </svg>
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

function computeDiff(oldLines: string[], newLines: string[]): Array<{ type: 'added' | 'removed' | 'context'; content: string }> {
  // Simple LCS-based diff
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const result: Array<{ type: 'added' | 'removed' | 'context'; content: string }> = [];
  let i = m, j = n;
  const temp: typeof result = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      temp.push({ type: 'context', content: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      temp.push({ type: 'added', content: newLines[j - 1] });
      j--;
    } else {
      temp.push({ type: 'removed', content: oldLines[i - 1] });
      i--;
    }
  }

  return temp.reverse();
}

function DiffView({ oldStr, newStr, contextLines = 3, startLine = 1 }: { oldStr: string; newStr: string; contextLines?: number; startLine?: number }) {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const changes = computeDiff(oldLines, newLines);

  // Build flat list with line numbers
  type DiffLine = { type: 'added' | 'removed' | 'context'; content: string; oldNum?: number; newNum?: number };
  const allLines: DiffLine[] = [];
  let oldLineNum = startLine;
  let newLineNum = startLine;

  for (const change of changes) {
    if (change.type === 'added') {
      allLines.push({ ...change, newNum: newLineNum++ });
    } else if (change.type === 'removed') {
      allLines.push({ ...change, oldNum: oldLineNum++ });
    } else {
      allLines.push({ ...change, oldNum: oldLineNum++, newNum: newLineNum++ });
    }
  }

  // Mark which context lines to show (within N lines of a change)
  const showLine = new Set<number>();
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].type !== 'context') {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(allLines.length - 1, i + contextLines); j++) {
        showLine.add(j);
      }
    }
  }

  // Build output with separators for gaps
  const output: Array<DiffLine | 'separator'> = [];
  let lastShown = -1;
  for (let i = 0; i < allLines.length; i++) {
    if (showLine.has(i)) {
      if (lastShown >= 0 && i > lastShown + 1) {
        output.push('separator');
      }
      output.push(allLines[i]);
      lastShown = i;
    }
  }

  const maxLineNum = Math.max(oldLineNum, newLineNum);
  const lineNumWidth = String(maxLineNum).length;

  return (
    <div className="font-mono text-xs p-2 overflow-x-auto">
      {output.map((item, i) => {
        if (item === 'separator') {
          return (
            <div key={`sep-${i}`} className="text-center py-0.5" style={{ color: '#586e75' }}>
              ···
            </div>
          );
        }
        const { type, content, oldNum, newNum } = item;
        // Show line number in single column: old for removed, new for added/context
        const lineNum = type === 'removed' ? oldNum : newNum;
        const lineNumStr = lineNum !== undefined ? String(lineNum).padStart(lineNumWidth) : ' '.repeat(lineNumWidth);
        const prefix = type === 'added' ? '+' : type === 'removed' ? '-' : ' ';
        const style = type === 'added'
          ? { backgroundColor: 'rgba(133, 153, 0, 0.15)', color: '#859900' }
          : type === 'removed'
          ? { backgroundColor: 'rgba(220, 50, 47, 0.15)', color: '#dc322f' }
          : { color: '#586e75' };

        return (
          <div key={i} style={style} className="whitespace-pre">
            <span className="select-none" style={{ color: '#586e75' }}>{lineNumStr}</span>
            <span className="select-none"> {prefix} </span>
            {content}
          </div>
        );
      })}
    </div>
  );
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
        className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-white/5 transition-colors"
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

function ToolBlock({ tool, result }: { tool: ToolCall; result?: ToolResult }) {
  const isAgentOutput = tool.name === "AgentOutputTool";
  const [expanded, setExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(!isAgentOutput);
  const isEdit = tool.name === "Edit" || tool.name === "Write";
  const isRead = tool.name === "Read";
  const isBash = tool.name === "Bash";

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const getToolSummary = () => {
    if (isEdit && parsedInput.file_path) {
      return String(parsedInput.file_path);
    }
    if (isRead && parsedInput.file_path) {
      const lines = parsedInput.limit ? ` (${parsedInput.limit} lines)` : "";
      return String(parsedInput.file_path) + lines;
    }
    if (isBash && parsedInput.command) {
      const cmd = String(parsedInput.command);
      return cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
    }
    if (tool.name === "Glob" && parsedInput.pattern) {
      return String(parsedInput.pattern);
    }
    if (tool.name === "Grep" && parsedInput.pattern) {
      return String(parsedInput.pattern);
    }
    return null;
  };

  const getResultSummary = () => {
    if (!result) return null;
    if (isEdit) {
      if (result.content.includes("has been updated")) {
        const match = result.content.match(/with (\d+) additions? and (\d+) removals?/);
        if (match) return `+${match[1]} -${match[2]}`;
        return "updated";
      }
      return result.is_error ? "failed" : "done";
    }
    if (isRead) {
      const lines = result.content.split("\n").length;
      return `${lines} lines`;
    }
    return null;
  };

  const summary = getToolSummary();
  const resultSummary = getResultSummary();
  const resultTruncated = result ? truncateLines(result.content, expanded ? 100 : 8) : null;

  // Extract starting line number from Edit result (format: "   42→content")
  const getStartLine = () => {
    if (!isEdit || !result) return 1;
    const match = result.content.match(/^\s*(\d+)→/m);
    return match ? parseInt(match[1], 10) : 1;
  };
  const startLine = getStartLine();

  const toolColors: Record<string, string> = {
    Edit: "text-amber-600 dark:text-sol-orange",
    Write: "text-amber-600 dark:text-sol-orange",
    Read: "text-blue-600 dark:text-sol-blue",
    Bash: "text-green-600 dark:text-sol-green",
    Glob: "text-violet-600 dark:text-sol-violet",
    Grep: "text-violet-600 dark:text-sol-violet",
    Task: "text-cyan-600 dark:text-sol-cyan",
    TodoWrite: "text-pink-600 dark:text-sol-magenta",
  };

  const bulletColors: Record<string, string> = {
    Edit: "bg-amber-500",
    Write: "bg-amber-500",
    Read: "bg-blue-500",
    Bash: "bg-green-500",
    Glob: "bg-violet-500",
    Grep: "bg-violet-500",
    Task: "bg-cyan-500",
    TodoWrite: "bg-pink-500",
  };

  const toolColor = toolColors[tool.name] || "text-sol-text-muted";
  const bulletColor = bulletColors[tool.name] || "bg-sol-text-muted";

  return (
    <div className="my-1">
      <div
        className="flex items-start gap-2 cursor-pointer group py-0.5"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${bulletColor}`} />
        <span className={`font-mono text-sm font-medium ${toolColor}`}>
          {tool.name}
        </span>
        {summary && (
          <span className="text-sol-text-muted text-sm font-mono truncate">
            {summary}
          </span>
        )}
        {resultSummary && (
          <span className="text-sol-text-dim text-sm font-mono ml-auto flex-shrink-0">
            {resultSummary}
          </span>
        )}
      </div>

      {isEdit && !expanded && !!parsedInput.old_string && !!parsedInput.new_string && (
        <div className="ml-3.5 mt-1 rounded overflow-hidden" style={{ backgroundColor: '#002b36' }}>
          <DiffView
            oldStr={String(parsedInput.old_string)}
            newStr={String(parsedInput.new_string)}
            startLine={startLine}
          />
        </div>
      )}

      {expanded && (
        <div className="ml-3.5 mt-1 space-y-2">
          <div className="rounded p-2" style={{ backgroundColor: '#002b36' }}>
            {isEdit && !!parsedInput.old_string && !!parsedInput.new_string ? (
              <DiffView
                oldStr={String(parsedInput.old_string)}
                newStr={String(parsedInput.new_string)}
                startLine={startLine}
              />
            ) : (
              <pre className="text-sm font-mono whitespace-pre-wrap overflow-x-auto" style={{ color: '#93a1a1' }}>
                {JSON.stringify(parsedInput, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}

      {result && resultTruncated && resultExpanded && !isEdit && (
        <div className={`ml-3.5 mt-1 rounded p-2 ${result.is_error ? "bg-red-900/20" : ""}`} style={result.is_error ? {} : { backgroundColor: '#002b36' }}>
          <pre className={`text-sm font-mono whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto ${
            result.is_error ? "text-red-400" : ""
          }`} style={result.is_error ? {} : { color: '#93a1a1' }}>
            {resultTruncated.text}
          </pre>
          {resultTruncated.truncated && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
              className="text-xs text-sol-text-dim hover:text-sol-text-muted mt-1"
            >
              {expanded ? "show less" : `+${resultTruncated.totalLines - 8} more lines`}
            </button>
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
  const truncated = truncateLines(content, expanded ? 50 : 3);

  return (
    <div className="my-3 border-l-2 border-sol-yellow/50 pl-3">
      <div
        className="flex items-center gap-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-sol-yellow text-xs font-medium">thinking</span>
      </div>
      <div className="mt-1 text-sol-text-dim text-xs italic font-mono whitespace-pre-wrap">
        {truncated.text}
        {truncated.truncated && !expanded && "..."}
      </div>
      {truncated.truncated && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-sol-text-dim hover:text-sol-text-dim mt-1"
        >
          {expanded ? "collapse" : "expand"}
        </button>
      )}
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
      <span className="text-sol-text-dim">{formatTimestamp(timestamp)}</span>
      <span className="px-1.5 py-0.5 rounded bg-sol-bg-alt/50 text-sol-text-muted font-mono text-[10px]">
        {cmdType || "status"}
      </span>
      <span className="font-mono truncate">{displayText}</span>
    </div>
  );
}

function UserPrompt({ content, timestamp, messageId, collapsed, userName }: { content: string; timestamp: number; messageId: string; collapsed?: boolean; userName?: string }) {
  const truncated = collapsed ? content.split("\n").slice(0, 2).join("\n") : content;
  const wasTruncated = collapsed && content.split("\n").length > 2;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success("Copied!");
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  return (
    <div id={`msg-${messageId}`} className={`group bg-sol-blue/10 border border-sol-blue/30 rounded-lg p-4 scroll-mt-20 ${collapsed ? "mb-2" : "mb-6"} relative`}>
      <button
        onClick={handleCopy}
        className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded hover:bg-sol-blue/20 text-sol-blue"
        title="Copy message"
        aria-label="Copy message"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      </button>
      <div className="flex items-center gap-2 mb-2">
        <UserIcon />
        <span className="text-sol-blue text-xs font-medium">{userName || "You"}</span>
        <a href={`#msg-${messageId}`} className="text-sol-text-dim hover:text-sol-text-muted text-xs transition-colors">{formatTimestamp(timestamp)}</a>
      </div>
      <div className={`text-sol-text text-sm pl-8 ${collapsed ? "line-clamp-2" : "whitespace-pre-wrap"}`}>
        {truncated}{wasTruncated && "..."}
      </div>
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
}) {
  const hasContent = content && content.trim().length > 0;
  const hasThinking = thinking && thinking.trim().length > 0;
  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const hasImages = images && images.length > 0;

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

  const truncatedContent = collapsed && content ? content.split("\n").slice(0, 2).join("\n") : content;
  const wasTruncated = collapsed && content && content.split("\n").length > 2;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content || "");
      toast.success("Copied!");
    } catch (err) {
      toast.error("Failed to copy");
    }
  };

  return (
    <div id={`msg-${messageId}`} className={`group scroll-mt-20 ${collapsed ? "mb-2" : "mb-6"} relative`}>
      {hasContent && (
        <button
          onClick={handleCopy}
          className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary z-10"
          title="Copy message"
          aria-label="Copy message"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
      )}
      <div className="flex items-center gap-2 mb-2">
        <ClaudeIcon />
        <span className="text-sol-text-secondary text-xs font-medium">Claude</span>
        <a href={`#msg-${messageId}`} className="text-sol-text-dim hover:text-sol-text-muted text-xs transition-colors">{formatTimestamp(timestamp)}</a>
        {collapsed && hasToolCalls && (
          <span className="text-sol-text-dim text-xs">[{toolCalls!.length} tool{toolCalls!.length > 1 ? "s" : ""}]</span>
        )}
      </div>

      <div className="pl-8">
        {!collapsed && hasImages && images?.map((img, i) => <ImageBlock key={i} image={img} />)}

        {!collapsed && hasThinking && <ThinkingBlock content={thinking!} />}

        {!collapsed && hasToolCalls && toolCalls?.map((tc) => (
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
            <ToolBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} />
          )
        ))}

        {hasContent && (
          <div className={`text-sol-text-secondary ${collapsed ? "text-sm line-clamp-2" : "prose prose-invert prose-sm max-w-none"}`}>
            {collapsed ? (
              <span>{truncatedContent}{wasTruncated && "..."}</span>
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
      </div>
    </div>
  );
}

function ToolResultMessage({ toolResults, toolName }: { toolResults: ToolResult[]; toolName?: string }) {
  const isAgentOutput = toolName === "AgentOutputTool";
  const isTodoWrite = toolName === "TodoWrite";
  const isEdit = toolName === "Edit" || toolName === "Write";
  const [expanded, setExpanded] = useState(false);
  const [showContent, setShowContent] = useState(!isAgentOutput);

  // Don't show result for TodoWrite or Edit - already rendered in the tool block
  if (!toolResults.length || isTodoWrite || isEdit) return null;

  const result = toolResults[0];
  const truncated = truncateLines(result.content, expanded ? 50 : 8);

  return (
    <div className="mb-3 pl-8">
      <div className="border-l-2 border-sol-border pl-3">
        <div
          className="flex items-center gap-2 cursor-pointer group"
          onClick={() => isAgentOutput ? setShowContent(!showContent) : setExpanded(!expanded)}
        >
          <span className="font-mono text-xs font-medium text-sol-text-dim">
            {toolName || "Result"}
          </span>
          {!showContent && (
            <span className="text-sol-text-dim text-[10px]">
              ({truncated.totalLines} lines)
            </span>
          )}
          <span className="text-sol-text-dim text-[10px] ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
            {isAgentOutput ? (showContent ? "hide" : "show") : (expanded ? "collapse" : "expand")}
          </span>
        </div>
        {showContent && (
          <div className={`mt-2 rounded p-2 ${result.is_error ? "bg-sol-red/20" : "bg-sol-bg-alt/30"}`}>
            <pre className={`text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto ${
              result.is_error ? "text-sol-red" : "text-sol-text-muted"
            }`}>
              {truncated.text}
            </pre>
            {truncated.truncated && (
              <button
                onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                className="text-[10px] text-sol-text-dim hover:text-sol-text-muted mt-1"
              >
                {expanded ? "show less" : `+${truncated.totalLines - 8} more lines`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
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
            <div className="rounded overflow-hidden" style={{ backgroundColor: '#002b36' }}>
              <GitDiffView diff={gitDiffStaged} />
            </div>
          </div>
        )}
        {gitDiff && gitDiff.trim().length > 0 && (
          <div>
            {gitDiffStaged && gitDiffStaged.trim().length > 0 && (
              <div className="text-sol-orange text-[10px] font-semibold mb-1">Unstaged</div>
            )}
            <div className="rounded overflow-hidden" style={{ backgroundColor: '#002b36' }}>
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
        let style: React.CSSProperties = { color: '#586e75' };
        let prefix = ' ';

        if (line.startsWith('+') && !line.startsWith('+++')) {
          style = { backgroundColor: 'rgba(133, 153, 0, 0.15)', color: '#859900' };
          prefix = '+';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          style = { backgroundColor: 'rgba(220, 50, 47, 0.15)', color: '#dc322f' };
          prefix = '-';
        } else if (line.startsWith('@@')) {
          style = { color: '#268bd2' };
          prefix = '@';
        } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
          style = { color: '#93a1a1', fontWeight: 500 };
          prefix = ' ';
        }

        return (
          <div key={i} style={style} className="whitespace-pre">
            {line}
          </div>
        );
      })}
    </div>
  );
}

export function ConversationView({ conversation, backHref, backLabel = "Back", headerExtra }: ConversationViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [diffExpanded, setDiffExpanded] = useState(false);

  const messages = conversation?.messages || [];

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
    count: messages.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => {
      const msg = messages[index];
      if (!msg) return 100;

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
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;
      setUserScrolled(!isNearBottom);
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (!userScrolled && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: "end", behavior: "smooth" });
    }
  }, [messages.length, userScrolled, virtualizer]);

  const hasInitialScrolled = useRef(false);
  useEffect(() => {
    if (messages.length > 0 && !hasInitialScrolled.current && !window.location.hash) {
      hasInitialScrolled.current = true;
      setTimeout(() => {
        virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
      }, 100);
    }
  }, [messages.length, virtualizer]);

  useEffect(() => {
    if (messages.length && window.location.hash) {
      const targetId = window.location.hash.slice(1);
      const msgIndex = messages.findIndex(m => `msg-${m._id}` === targetId);
      if (msgIndex >= 0) {
        setUserScrolled(true);
        setTimeout(() => virtualizer.scrollToIndex(msgIndex, { align: "center", behavior: "smooth" }), 100);
      }
    }
  }, [messages.length, virtualizer]);

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

  const renderMessage = (msg: Message) => {
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
        return <UserPrompt key={msg._id} content={msg.content} timestamp={msg.timestamp} messageId={msg._id} collapsed={collapsed} userName={userName} />;
      }
      return null;
    }

    if (msg.role === "assistant") {
      return (
        <AssistantBlock
          key={msg._id}
          content={msg.content}
          timestamp={msg.timestamp}
          thinking={msg.thinking}
          toolCalls={msg.tool_calls}
          toolResults={msg.tool_results}
          images={msg.images}
          messageId={msg._id}
          messageUuid={msg.message_uuid}
          collapsed={collapsed}
          childConversationMap={conversation?.child_conversation_map}
        />
      );
    }

    return null;
  };

  return (
    <main className="h-screen flex flex-col bg-sol-bg">
      <header className="border-b border-sol-border bg-sol-bg-alt/80 backdrop-blur shrink-0">
        <div className="max-w-4xl mx-auto px-4 py-3">
          <div className="flex items-center gap-3">
            <Link
              href={backHref}
              className="text-sol-text-dim hover:text-sol-text-secondary transition-colors text-sm flex-shrink-0"
            >
              &larr; {backLabel}
            </Link>
            <h1 className="text-sm font-medium text-sol-text-secondary truncate flex-1">{truncatedTitle}</h1>

            {conversation && (
              <>
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
          <div className="text-sol-text-dim text-center py-8 text-sm">Loading...</div>
        ) : messages.length === 0 ? (
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
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const msg = messages[virtualItem.index];
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
                  <div className="max-w-4xl mx-auto px-4 py-1">
                    {renderMessage(msg)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
