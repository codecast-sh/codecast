"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="shrink-0"
    >
      <rect width="24" height="24" rx="6" fill="#D97706" />
      <path
        d="M7 8.5C7 7.67157 7.67157 7 8.5 7H11C11.8284 7 12.5 7.67157 12.5 8.5V11C12.5 11.8284 11.8284 12.5 11 12.5H8.5C7.67157 12.5 7 11.8284 7 11V8.5Z"
        fill="white"
      />
      <path
        d="M11.5 13C11.5 12.1716 12.1716 11.5 13 11.5H15.5C16.3284 11.5 17 12.1716 17 13V15.5C17 16.3284 16.3284 17 15.5 17H13C12.1716 17 11.5 16.3284 11.5 15.5V13Z"
        fill="white"
      />
    </svg>
  );
}

function CollapsibleSection({
  title,
  badge,
  badgeColor = "slate",
  children,
  defaultOpen = false,
}: {
  title: string;
  badge?: string;
  badgeColor?: "slate" | "amber" | "red" | "emerald";
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const colors = {
    slate: "bg-slate-700 text-slate-300",
    amber: "bg-amber-800/50 text-amber-300",
    red: "bg-red-900/50 text-red-300",
    emerald: "bg-emerald-900/50 text-emerald-300",
  };

  return (
    <div className="border border-slate-700/50 rounded-lg overflow-hidden my-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 bg-slate-800/30 flex items-center justify-between text-left hover:bg-slate-800/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {badge && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${colors[badgeColor]}`}>
              {badge}
            </span>
          )}
          <span className="text-xs font-medium text-slate-300">{title}</span>
        </div>
        <span className="text-slate-500 text-[10px]">
          {expanded ? "collapse" : "expand"}
        </span>
      </button>
      {expanded && (
        <div className="p-3 bg-slate-900/30 text-xs">{children}</div>
      )}
    </div>
  );
}

function ThinkingBlock({ content }: { content: string }) {
  return (
    <CollapsibleSection title="Thinking" badge="thinking" badgeColor="amber">
      <div className="text-slate-400 italic whitespace-pre-wrap font-mono text-[11px] max-h-[300px] overflow-y-auto">
        {content}
      </div>
    </CollapsibleSection>
  );
}

function ToolCallBlock({ tool }: { tool: ToolCall }) {
  let parsedInput = tool.input;
  try {
    const obj = JSON.parse(tool.input);
    parsedInput = JSON.stringify(obj, null, 2);
  } catch {}

  return (
    <CollapsibleSection title={tool.name} badge="tool" badgeColor="emerald">
      <pre className="text-slate-300 font-mono text-[11px] overflow-x-auto whitespace-pre-wrap">
        {parsedInput}
      </pre>
    </CollapsibleSection>
  );
}

function ToolResultBlock({ result }: { result: ToolResult }) {
  const lines = result.content.split("\n");
  const truncated = lines.length > 50;
  const [showAll, setShowAll] = useState(false);
  const displayContent = showAll ? result.content : lines.slice(0, 50).join("\n");

  return (
    <CollapsibleSection
      title={result.is_error ? "Error" : "Result"}
      badge="output"
      badgeColor={result.is_error ? "red" : "slate"}
    >
      <pre
        className={`font-mono text-[11px] overflow-x-auto whitespace-pre-wrap max-h-[400px] overflow-y-auto ${
          result.is_error ? "text-red-300" : "text-slate-300"
        }`}
      >
        {displayContent}
      </pre>
      {truncated && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-2 text-[10px] text-blue-400 hover:text-blue-300"
        >
          Show all {lines.length} lines
        </button>
      )}
    </CollapsibleSection>
  );
}

function ImageBlock({ image }: { image: ImageData }) {
  return (
    <div className="my-2">
      <img
        src={`data:${image.media_type};base64,${image.data}`}
        alt="User provided image"
        className="max-w-full rounded-lg border border-slate-700"
      />
    </div>
  );
}

function SystemMessage({ content, subtype }: { content: string; subtype?: string }) {
  const subtypeLabels: Record<string, string> = {
    local_command: "Command",
    stop_hook_summary: "Hook",
    compact_boundary: "Compact",
  };

  return (
    <div className="mb-3 px-3 py-2 bg-slate-800/30 border-l-2 border-amber-600/50 text-xs">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/50 text-amber-400">
          {subtypeLabels[subtype || ""] || "System"}
        </span>
      </div>
      <div className="text-slate-400 font-mono text-[11px] whitespace-pre-wrap">
        {content.replace(/<[^>]+>/g, "")}
      </div>
    </div>
  );
}

function MessageBubble({
  role,
  content,
  timestamp,
  thinking,
  toolCalls,
  toolResults,
  images,
  subtype,
  userName,
}: {
  role: string;
  content?: string;
  timestamp: number;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  images?: ImageData[];
  subtype?: string;
  userName?: string;
}) {
  const isUser = role === "user";
  const isSystem = role === "system";
  const isAssistant = role === "assistant";

  const hasContent = content && content.trim().length > 0;
  const hasThinking = thinking && thinking.trim().length > 0;
  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const hasToolResults = toolResults && toolResults.length > 0;
  const hasImages = images && images.length > 0;

  if (isSystem) {
    return <SystemMessage content={content || ""} subtype={subtype} />;
  }

  if (!hasContent && !hasThinking && !hasToolCalls && !hasToolResults && !hasImages) {
    return null;
  }

  return (
    <div
      className={`mb-4 ${isUser ? "flex justify-end" : "flex justify-start gap-3"}`}
    >
      {isAssistant && <ClaudeIcon />}
      <div
        className={`rounded-lg px-4 py-3 ${
          isUser
            ? "bg-blue-600 text-white max-w-2xl"
            : "bg-slate-800 border border-slate-700 text-slate-200 flex-1 max-w-3xl"
        }`}
      >
        <div className="flex items-center gap-2 mb-2">
          <span
            className={`text-xs font-medium ${isUser ? "text-blue-200" : "text-slate-400"}`}
          >
            {isAssistant ? "Claude" : isUser && userName ? userName : "User"}
          </span>
          <span
            className={`text-xs ${isUser ? "text-blue-300" : "text-slate-500"}`}
          >
            {formatTimestamp(timestamp)}
          </span>
        </div>

        {hasImages && images?.map((img, i) => <ImageBlock key={i} image={img} />)}

        {hasThinking && <ThinkingBlock content={thinking!} />}

        {hasToolCalls && toolCalls?.map((tc) => <ToolCallBlock key={tc.id} tool={tc} />)}

        {hasToolResults && toolResults?.map((tr) => <ToolResultBlock key={tr.tool_use_id} result={tr} />)}

        {hasContent && (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
              {content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ConversationPage() {
  const params = useParams();
  const id = params.id as string;
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevMessageCount = useRef<number>(0);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [showShareCopied, setShowShareCopied] = useState(false);

  const conversation = useQuery(api.conversations.getConversation, {
    conversation_id: id as Id<"conversations">,
  });

  const generateShareLink = useMutation(api.conversations.generateShareLink);

  const messageCount = conversation?.messages.length ?? 0;

  useEffect(() => {
    if (messageCount > prevMessageCount.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevMessageCount.current = messageCount;
  }, [messageCount]);

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

  const title =
    conversation?.title || `Session ${conversation?.session_id?.slice(0, 8) || "..."}`;

  return (
    <AuthGuard>
      <main className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
        <header className="border-b border-slate-700 bg-slate-800/50 backdrop-blur sticky top-0 z-10">
          <div className="max-w-4xl mx-auto px-4 py-4 flex items-center gap-4">
            <Link
              href="/dashboard"
              className="text-slate-400 hover:text-white transition-colors"
            >
              <span aria-hidden="true">&larr;</span> Back
            </Link>
            <h1 className="text-lg font-medium text-white truncate">{title}</h1>
            {conversation && (
              <>
                <span className="text-xs text-slate-500 ml-auto">
                  {conversation.agent_type}
                </span>
                <div className="flex items-center gap-2">
                  {!shareUrl ? (
                    <button
                      onClick={handleShare}
                      className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
                    >
                      Share
                    </button>
                  ) : (
                    <button
                      onClick={handleCopyShareUrl}
                      className="px-3 py-1.5 text-sm bg-slate-700 hover:bg-slate-600 text-white rounded-md transition-colors relative"
                    >
                      {showShareCopied ? "Copied!" : "Copy Link"}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </header>
        <div className="max-w-4xl mx-auto px-4 py-6">
          {!conversation ? (
            <div className="text-slate-400 text-center py-8">Loading...</div>
          ) : conversation.messages.length === 0 ? (
            <div className="text-slate-400 text-center py-8">
              No messages in this conversation
            </div>
          ) : (
            <>
              {conversation.messages.map((msg) => (
                <MessageBubble
                  key={msg._id}
                  role={msg.role}
                  content={msg.content}
                  timestamp={msg.timestamp}
                  thinking={msg.thinking}
                  toolCalls={msg.tool_calls}
                  toolResults={msg.tool_results}
                  images={msg.images}
                  subtype={msg.subtype}
                  userName={conversation.user?.name || "User"}
                />
              ))}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>
      </main>
    </AuthGuard>
  );
}
