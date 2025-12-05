"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@code-chat-sync/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AuthGuard } from "../../../components/AuthGuard";
import { Id } from "@code-chat-sync/convex/convex/_generated/dataModel";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { ToolCallDisplay } from "../../../components/ToolCallDisplay";
import "highlight.js/styles/github-dark.css";

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

function MessageBubble({
  role,
  content,
  timestamp,
  toolName,
  toolInput,
  toolOutput,
  thinking,
  userName,
}: {
  role: string;
  content?: string;
  timestamp: number;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  thinking?: string;
  userName?: string;
}) {
  const isUser = role === "user";
  const isSystem = role === "system";
  const isTool = role === "tool";
  const isAssistant = role === "assistant";

  const hasContent = content && content.trim().length > 0;
  const hasTool = toolName || toolInput || toolOutput;

  if (isAssistant && !hasContent && hasTool) {
    return (
      <div className="mb-4 flex justify-start gap-3">
        <ClaudeIcon />
        <div className="flex-1 max-w-2xl">
          <ToolCallDisplay
            name={toolName || "Tool"}
            input={toolInput}
            output={toolOutput}
            timestamp={timestamp}
          />
        </div>
      </div>
    );
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
            : isSystem
              ? "bg-amber-900/50 border border-amber-700 text-amber-200 max-w-2xl"
              : isTool
                ? "bg-slate-700/50 border border-slate-600 text-slate-300 max-w-2xl"
                : "bg-slate-800 border border-slate-700 text-slate-200 max-w-2xl"
        }`}
      >
        <div className="flex items-center gap-2 mb-2">
          <span
            className={`text-xs font-medium ${isUser ? "text-blue-200" : "text-slate-400"}`}
          >
            {isAssistant ? "Claude" : isUser && userName ? userName : role.charAt(0).toUpperCase() + role.slice(1)}
          </span>
          <span
            className={`text-xs ${isUser ? "text-blue-300" : "text-slate-500"}`}
          >
            {formatTimestamp(timestamp)}
          </span>
        </div>
        {thinking && (
          <div className="text-xs text-slate-400 italic mb-2 border-l-2 border-slate-600 pl-2">
            {thinking}
          </div>
        )}
        {hasContent && (
          <div className="prose prose-invert prose-sm max-w-none">
            <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
              {content}
            </ReactMarkdown>
          </div>
        )}
        {hasTool && hasContent && (
          <div className="mt-3">
            <ToolCallDisplay
              name={toolName || "Tool"}
              input={toolInput}
              output={toolOutput}
              timestamp={timestamp}
            />
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
                  toolName={msg.tool_name}
                  toolInput={msg.tool_input}
                  toolOutput={msg.tool_output}
                  thinking={msg.thinking}
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
