"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState, useMemo } from "react";
import { AuthGuard } from "../../../components/AuthGuard";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
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

function ToolBlock({ tool, result }: { tool: ToolCall; result?: ToolResult }) {
  const [expanded, setExpanded] = useState(false);
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

      {isEdit && !expanded && parsedInput.old_string && parsedInput.new_string && (
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
            {isEdit && parsedInput.old_string && parsedInput.new_string ? (
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
          <pre className={`text-xs font-mono whitespace-pre-wrap overflow-x-auto ${
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

function UserPrompt({ content, timestamp }: { content: string; timestamp: number }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-slate-400 text-xs font-medium">You</span>
        <span className="text-slate-600 text-xs">{formatTimestamp(timestamp)}</span>
      </div>
      <div className="text-slate-200 text-sm whitespace-pre-wrap pl-4 border-l-2 border-slate-600">
        {content}
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
}: {
  content?: string;
  timestamp: number;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  images?: ImageData[];
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

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-2">
        <ClaudeIcon />
        <span className="text-slate-300 text-xs font-medium">Claude</span>
        <span className="text-slate-600 text-xs">{formatTimestamp(timestamp)}</span>
      </div>

      <div className="pl-8">
        {hasImages && images?.map((img, i) => <ImageBlock key={i} image={img} />)}

        {hasThinking && <ThinkingBlock content={thinking!} />}

        {hasToolCalls && toolCalls?.map((tc) => (
          <ToolBlock key={tc.id} tool={tc} result={toolResultMap[tc.id]} />
        ))}

        {hasContent && (
          <div className="prose prose-invert prose-sm max-w-none text-slate-200">
            <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
              {content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolResultMessage({ toolResults, timestamp }: { toolResults: ToolResult[]; timestamp: number }) {
  return (
    <div className="mb-4 pl-8">
      {toolResults.map((result) => (
        <div
          key={result.tool_use_id}
          className={`rounded p-2 mb-2 ${result.is_error ? "bg-red-950/30 border-l-2 border-red-700" : "bg-slate-900/30 border-l-2 border-slate-700"}`}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[10px] font-medium ${result.is_error ? "text-red-400" : "text-slate-500"}`}>
              {result.is_error ? "error" : "output"}
            </span>
          </div>
          <pre className={`text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto ${
            result.is_error ? "text-red-300" : "text-slate-400"
          }`}>
            {truncateLines(result.content, 12).text}
          </pre>
        </div>
      ))}
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

export default function ConversationPage() {
  const params = useParams();
  const id = params.id as string;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [showShareCopied, setShowShareCopied] = useState(false);
  const [userScrolled, setUserScrolled] = useState(false);

  const conversation = useQuery(api.conversations.getConversation, {
    conversation_id: id as Id<"conversations">,
  });

  const generateShareLink = useMutation(api.conversations.generateShareLink);

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
    if (conversation?.share_token) {
      const url = `${window.location.origin}/share/${conversation.share_token}`;
      setShareUrl(url);
    }
  }, [conversation?.share_token]);

  const handleShare = async () => {
    try {
      const token = await generateShareLink({ conversation_id: id as Id<"conversations"> });
      const url = `${window.location.origin}/share/${token}`;
      setShareUrl(url);
      await navigator.clipboard.writeText(url);
      setShowShareCopied(true);
      setTimeout(() => setShowShareCopied(false), 2000);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Failed to generate share link");
    }
  };

  const handleCopyShareUrl = async () => {
    if (shareUrl) {
      await navigator.clipboard.writeText(shareUrl);
      setShowShareCopied(true);
      setTimeout(() => setShowShareCopied(false), 2000);
    }
  };

  const title = conversation?.title || `Session ${conversation?.session_id?.slice(0, 8) || "..."}`;

  const renderMessage = (msg: {
    _id: string;
    role: string;
    content?: string;
    timestamp: number;
    thinking?: string;
    tool_calls?: ToolCall[];
    tool_results?: ToolResult[];
    images?: ImageData[];
    subtype?: string;
  }) => {
    if (msg.role === "system") {
      return <SystemBlock key={msg._id} content={msg.content || ""} subtype={msg.subtype} />;
    }

    if (msg.role === "user") {
      if (msg.tool_results && msg.tool_results.length > 0) {
        return <ToolResultMessage key={msg._id} toolResults={msg.tool_results} timestamp={msg.timestamp} />;
      }
      if (msg.content && msg.content.trim()) {
        return <UserPrompt key={msg._id} content={msg.content} timestamp={msg.timestamp} />;
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
        />
      );
    }

    return null;
  };

  return (
    <AuthGuard>
      <main className="h-screen flex flex-col bg-slate-950">
        <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur shrink-0">
          <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-4">
            <Link
              href="/dashboard"
              className="text-slate-500 hover:text-slate-300 transition-colors text-sm"
            >
              &larr; Back
            </Link>
            <h1 className="text-sm font-medium text-slate-200 truncate">{title}</h1>
            {conversation && (
              <>
                <span className="text-[10px] text-slate-600 ml-auto font-mono">
                  {conversation.agent_type}
                </span>
                <div className="flex items-center gap-2">
                  {!shareUrl ? (
                    <button
                      onClick={handleShare}
                      className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors"
                    >
                      Share
                    </button>
                  ) : (
                    <button
                      onClick={handleCopyShareUrl}
                      className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors"
                    >
                      {showShareCopied ? "Copied!" : "Copy Link"}
                    </button>
                  )}
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
    </AuthGuard>
  );
}
