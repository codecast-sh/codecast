"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import "highlight.js/styles/github-dark.css";

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
    <div className="w-6 h-6 rounded bg-amber-600 flex items-center justify-center shrink-0">
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

function DiffView({ oldStr, newStr, filePath }: { oldStr: string; newStr: string; filePath: string }) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  return (
    <div className="font-mono text-xs">
      <div className="text-slate-400 mb-2 text-[11px]">{filePath}</div>
      <div className="space-y-0">
        {oldLines.map((line, i) => (
          <div key={`old-${i}`} className="bg-red-950/40 text-red-300 px-2 py-0.5">
            <span className="text-red-500 mr-2">-</span>{line}
          </div>
        ))}
        {newLines.map((line, i) => (
          <div key={`new-${i}`} className="bg-emerald-950/40 text-emerald-300 px-2 py-0.5">
            <span className="text-emerald-500 mr-2">+</span>{line}
          </div>
        ))}
      </div>
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
    Explore: { bg: "bg-emerald-950/40", border: "border-emerald-700/50", text: "text-emerald-400" },
    Plan: { bg: "bg-blue-950/40", border: "border-blue-700/50", text: "text-blue-400" },
    implementor: { bg: "bg-amber-950/40", border: "border-amber-700/50", text: "text-amber-400" },
    "general-purpose": { bg: "bg-slate-800/60", border: "border-slate-600/50", text: "text-slate-300" },
    "claude-code-guide": { bg: "bg-violet-950/40", border: "border-violet-700/50", text: "text-violet-400" },
    "code-reviewer": { bg: "bg-rose-950/40", border: "border-rose-700/50", text: "text-rose-400" },
    "code-explorer": { bg: "bg-cyan-950/40", border: "border-cyan-700/50", text: "text-cyan-400" },
    "code-architect": { bg: "bg-indigo-950/40", border: "border-indigo-700/50", text: "text-indigo-400" },
  };

  const colors = subagentColors[subagentType] || { bg: "bg-slate-800/60", border: "border-slate-600/50", text: "text-slate-400" };
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
          <span className="text-slate-400 text-xs truncate flex-1">
            {description}
          </span>
        )}
        {model && (
          <span className="text-slate-600 text-[10px] font-mono">
            {model}
          </span>
        )}
        {runInBackground && (
          <span className="text-slate-500 text-[10px]">background</span>
        )}
        {childConversationId && (
          <Link
            href={`/conversation/${childConversationId}`}
            onClick={(e) => e.stopPropagation()}
            className="text-cyan-500 hover:text-cyan-400 text-[10px] font-medium underline underline-offset-2"
          >
            view
          </Link>
        )}
        <span className="text-slate-600 text-[10px] ml-auto">
          {expanded ? "collapse" : "expand"}
        </span>
      </div>

      <div className="px-3 pb-2">
        <div className="text-slate-300 text-xs font-mono whitespace-pre-wrap leading-relaxed">
          {truncatedPrompt}
        </div>
        {prompt.length > 300 && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="text-[10px] text-slate-500 hover:text-slate-400 mt-1"
          >
            show more
          </button>
        )}
      </div>

      {expanded && result && (
        <div className="border-t border-slate-700/50 px-3 py-2">
          <div className="text-[10px] text-slate-500 mb-1">Result</div>
          <pre className={`text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto ${
            result.is_error ? "text-red-300" : "text-slate-400"
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
      const fileName = String(parsedInput.file_path).split("/").pop();
      return fileName;
    }
    if (isRead && parsedInput.file_path) {
      const fileName = String(parsedInput.file_path).split("/").pop();
      return fileName;
    }
    if (isBash && parsedInput.command) {
      const cmd = String(parsedInput.command);
      return cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
    }
    if (tool.name === "Glob" && parsedInput.pattern) {
      return String(parsedInput.pattern);
    }
    if (tool.name === "Grep" && parsedInput.pattern) {
      return String(parsedInput.pattern);
    }
    return null;
  };

  const summary = getToolSummary();
  const resultTruncated = result ? truncateLines(result.content, expanded ? 100 : 8) : null;

  const toolColors: Record<string, string> = {
    Edit: "text-amber-400",
    Write: "text-amber-400",
    Read: "text-blue-400",
    Bash: "text-emerald-400",
    Glob: "text-purple-400",
    Grep: "text-purple-400",
    Task: "text-cyan-400",
    TodoWrite: "text-pink-400",
  };

  const toolColor = toolColors[tool.name] || "text-slate-400";

  return (
    <div className="my-3 border-l-2 border-slate-700 pl-3">
      <div
        className="flex items-center gap-2 cursor-pointer group"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`font-mono text-xs font-medium ${toolColor}`}>
          {tool.name}
        </span>
        {summary && (
          <span className="text-slate-500 text-xs font-mono truncate max-w-md">
            {summary}
          </span>
        )}
        <span className="text-slate-600 text-[10px] ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
          {expanded ? "collapse" : "expand"}
        </span>
      </div>

      {isEdit && !expanded && !!parsedInput.old_string && !!parsedInput.new_string && (
        <div className="mt-2 bg-slate-900/50 rounded p-2 max-h-40 overflow-hidden">
          <DiffView
            oldStr={String(parsedInput.old_string)}
            newStr={String(parsedInput.new_string)}
            filePath={String(parsedInput.file_path || "")}
          />
        </div>
      )}

      {expanded && (
        <div className="mt-2 space-y-2">
          <div className="bg-slate-900/50 rounded p-2">
            <div className="text-[10px] text-slate-500 mb-1">Input</div>
            {isEdit && !!parsedInput.old_string && !!parsedInput.new_string ? (
              <DiffView
                oldStr={String(parsedInput.old_string)}
                newStr={String(parsedInput.new_string)}
                filePath={String(parsedInput.file_path || "")}
              />
            ) : (
              <pre className="text-xs text-slate-300 font-mono whitespace-pre-wrap overflow-x-auto">
                {JSON.stringify(parsedInput, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}

      {result && resultTruncated && (
        <div className={`mt-2 rounded p-2 ${result.is_error ? "bg-red-950/30" : "bg-slate-900/30"}`}>
          {!resultExpanded ? (
            <button
              onClick={(e) => { e.stopPropagation(); setResultExpanded(true); }}
              className="text-[10px] text-slate-500 hover:text-slate-400"
            >
              show result ({resultTruncated.totalLines} lines)
            </button>
          ) : (
            <>
              <pre className={`text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto ${
                result.is_error ? "text-red-300" : "text-slate-400"
              }`}>
                {resultTruncated.text}
              </pre>
              {resultTruncated.truncated && (
                <button
                  onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                  className="text-[10px] text-slate-500 hover:text-slate-400 mt-1"
                >
                  {expanded ? "show less" : `+${resultTruncated.totalLines - 8} more lines`}
                </button>
              )}
              {isAgentOutput && (
                <button
                  onClick={(e) => { e.stopPropagation(); setResultExpanded(false); }}
                  className="text-[10px] text-slate-500 hover:text-slate-400 mt-1 ml-2"
                >
                  hide
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = truncateLines(content, expanded ? 50 : 3);

  return (
    <div className="my-3 border-l-2 border-amber-800/50 pl-3">
      <div
        className="flex items-center gap-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-amber-600 text-xs font-medium">thinking</span>
      </div>
      <div className="mt-1 text-slate-500 text-xs italic font-mono whitespace-pre-wrap">
        {truncated.text}
        {truncated.truncated && !expanded && "..."}
      </div>
      {truncated.truncated && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-slate-600 hover:text-slate-500 mt-1"
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
        className="max-w-md rounded border border-slate-700"
      />
    </div>
  );
}

function UserIcon() {
  return (
    <div className="w-6 h-6 rounded bg-blue-600 flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </div>
  );
}

function isCommandMessage(content: string): boolean {
  const trimmed = content.trim();
  return /^<(command-name|command-message|local-command-stdout|local-command-stderr)>/.test(trimmed) ||
    trimmed.startsWith("Caveat:");
}

function parseCommandMessage(content: string): { type: string; value: string } | null {
  const match = content.match(/<(command-name|command-message)>([^<]*)<\/\1>/);
  if (match) {
    return { type: match[1], value: match[2] };
  }
  if (content.includes("<local-command-stdout>")) {
    return { type: "command-output", value: "command output" };
  }
  if (content.trim().startsWith("Caveat:")) {
    return { type: "caveat", value: content.trim().slice(0, 80) + (content.length > 80 ? "..." : "") };
  }
  return null;
}

function CommandStatusLine({ content, timestamp }: { content: string; timestamp: number }) {
  const parsed = parseCommandMessage(content);
  const displayText = parsed?.value || content.replace(/<[^>]+>/g, "").slice(0, 100);

  const typeLabels: Record<string, string> = {
    "command-name": "cmd",
    "command-message": "msg",
    "command-output": "output",
    "caveat": "note",
  };

  return (
    <div className="mb-2 px-3 py-1.5 flex items-center gap-2 text-xs text-slate-500">
      <span className="text-slate-600">{formatTimestamp(timestamp)}</span>
      <span className="px-1.5 py-0.5 rounded bg-slate-800/50 text-slate-400 font-mono text-[10px]">
        {typeLabels[parsed?.type || ""] || "status"}
      </span>
      <span className="font-mono truncate">{displayText}</span>
    </div>
  );
}

function UserPrompt({ content, timestamp, messageId, collapsed, userName }: { content: string; timestamp: number; messageId: string; collapsed?: boolean; userName?: string }) {
  const truncated = collapsed ? content.split("\n").slice(0, 2).join("\n") : content;
  const wasTruncated = collapsed && content.split("\n").length > 2;

  return (
    <div id={`msg-${messageId}`} className={`bg-blue-950/20 border border-blue-900/30 rounded-lg p-4 scroll-mt-20 ${collapsed ? "mb-2" : "mb-6"}`}>
      <div className="flex items-center gap-2 mb-2">
        <UserIcon />
        <span className="text-blue-300 text-xs font-medium">{userName || "You"}</span>
        <a href={`#msg-${messageId}`} className="text-slate-600 hover:text-slate-400 text-xs transition-colors">{formatTimestamp(timestamp)}</a>
      </div>
      <div className={`text-slate-100 text-sm pl-8 ${collapsed ? "line-clamp-2" : "whitespace-pre-wrap"}`}>
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

  return (
    <div id={`msg-${messageId}`} className={`scroll-mt-20 ${collapsed ? "mb-2" : "mb-6"}`}>
      <div className="flex items-center gap-2 mb-2">
        <ClaudeIcon />
        <span className="text-slate-300 text-xs font-medium">Claude</span>
        <a href={`#msg-${messageId}`} className="text-slate-600 hover:text-slate-400 text-xs transition-colors">{formatTimestamp(timestamp)}</a>
        {collapsed && hasToolCalls && (
          <span className="text-slate-600 text-xs">[{toolCalls!.length} tool{toolCalls!.length > 1 ? "s" : ""}]</span>
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
          ) : (
            <ToolBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} />
          )
        ))}

        {hasContent && (
          <div className={`text-slate-200 ${collapsed ? "text-sm line-clamp-2" : "prose prose-invert prose-sm max-w-none"}`}>
            {collapsed ? (
              <span>{truncatedContent}{wasTruncated && "..."}</span>
            ) : (
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
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
  const [expanded, setExpanded] = useState(false);
  const [showContent, setShowContent] = useState(!isAgentOutput);
  if (!toolResults.length) return null;

  const result = toolResults[0];
  const truncated = truncateLines(result.content, expanded ? 50 : 8);

  return (
    <div className="mb-3 pl-8">
      <div className="border-l-2 border-slate-700 pl-3">
        <div
          className="flex items-center gap-2 cursor-pointer group"
          onClick={() => isAgentOutput ? setShowContent(!showContent) : setExpanded(!expanded)}
        >
          <span className="font-mono text-xs font-medium text-slate-500">
            {toolName || "Result"}
          </span>
          {!showContent && (
            <span className="text-slate-600 text-[10px]">
              ({truncated.totalLines} lines)
            </span>
          )}
          <span className="text-slate-600 text-[10px] ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
            {isAgentOutput ? (showContent ? "hide" : "show") : (expanded ? "collapse" : "expand")}
          </span>
        </div>
        {showContent && (
          <div className={`mt-2 rounded p-2 ${result.is_error ? "bg-red-950/30" : "bg-slate-900/30"}`}>
            <pre className={`text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-60 overflow-y-auto ${
              result.is_error ? "text-red-300" : "text-slate-400"
            }`}>
              {truncated.text}
            </pre>
            {truncated.truncated && (
              <button
                onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                className="text-[10px] text-slate-500 hover:text-slate-400 mt-1"
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
    <div className="mb-4 px-3 py-2 bg-slate-800/20 border-l-2 border-slate-600 text-xs">
      <span className="text-slate-500 text-[10px] mr-2">
        {subtypeLabels[subtype || ""] || "system"}
      </span>
      <span className="text-slate-400 font-mono">
        {content.replace(/<[^>]+>/g, "").slice(0, 200)}
        {content.length > 200 && "..."}
      </span>
    </div>
  );
}

export function ConversationView({ conversation, backHref, backLabel = "Back", headerExtra }: ConversationViewProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

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
    if (!userScrolled && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [conversation?.messages.length, userScrolled]);

  useEffect(() => {
    if (conversation?.messages.length && window.location.hash) {
      const el = document.getElementById(window.location.hash.slice(1));
      if (el) {
        setUserScrolled(true);
        setTimeout(() => el.scrollIntoView({ behavior: "smooth" }), 100);
      }
    }
  }, [conversation?.messages.length]);

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
    <main className="h-screen flex flex-col bg-slate-950">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur shrink-0">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-4">
          <Link
            href={backHref}
            className="text-slate-500 hover:text-slate-300 transition-colors text-sm"
          >
            &larr; {backLabel}
          </Link>
          <h1 className="text-sm font-medium text-slate-200 truncate">{truncatedTitle}</h1>
          {conversation && (
            <>
              {conversation.parent_conversation_id && (
                <Link
                  href={`/conversation/${conversation.parent_conversation_id}`}
                  className="text-violet-400 hover:text-violet-300 text-xs flex items-center gap-1"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16l-4-4m0 0l4-4m-4 4h18" />
                  </svg>
                  Parent
                </Link>
              )}
              {conversation.child_conversations && conversation.child_conversations.length > 0 && (
                <span className="text-cyan-400 text-xs">
                  {conversation.child_conversations.length} subagent{conversation.child_conversations.length > 1 ? "s" : ""}
                </span>
              )}
              <span className="ml-auto text-amber-500">
                {conversation.agent_type === "claude_code" ? (
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M4.709 15.955l4.72-2.647.08-.08 2.726-4.721c.398-.65 1.063-1.063 1.808-1.063h.08c.744 0 1.409.413 1.807 1.063l2.727 4.72.079.08 4.72 2.728c.65.398 1.063 1.063 1.063 1.808v.08c0 .744-.413 1.409-1.063 1.807l-4.72 2.727-.08.08-2.727 4.72c-.398.65-1.063 1.063-1.808 1.063h-.08c-.744 0-1.409-.413-1.807-1.063l-2.727-4.72-.079-.08-4.72-2.727c-.65-.398-1.063-1.063-1.063-1.808v-.08c0-.744.413-1.409 1.063-1.807zm7.248-1.41l-1.33 2.302 2.302 1.33c.16.08.319.08.479 0l2.302-1.33-1.33-2.302c-.08-.16-.08-.319 0-.479l1.33-2.302-2.302-1.33c-.16-.08-.319-.08-.479 0l-2.302 1.33 1.33 2.302c.08.16.08.319 0 .479z" />
                  </svg>
                ) : (
                  <span className="text-[10px] text-slate-600 font-mono">{conversation.agent_type}</span>
                )}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCollapsed((c) => !c)}
                  className={`px-2 py-1 text-xs rounded transition-colors ${collapsed ? "bg-amber-800 text-amber-200" : "bg-slate-800 hover:bg-slate-700 text-slate-300"}`}
                  title="Toggle collapse (Cmd+Shift+C)"
                >
                  {collapsed ? "Expand" : "Collapse"}
                </button>
                {headerExtra}
              </div>
            </>
          )}
        </div>
      </header>

      <div ref={containerRef} className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-4 py-6">
          {!conversation ? (
            <div className="text-slate-500 text-center py-8 text-sm">Loading...</div>
          ) : conversation.messages.length === 0 ? (
            <div className="text-slate-500 text-center py-8 text-sm">
              No messages in this conversation
            </div>
          ) : (
            <>
              {conversation.messages.map(renderMessage)}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
