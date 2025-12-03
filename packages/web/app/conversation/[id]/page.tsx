"use client";
import { useQuery } from "convex/react";
import { api } from "@code-chat-sync/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AuthGuard } from "../../../components/AuthGuard";
import { Id } from "@code-chat-sync/convex/convex/_generated/dataModel";

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MessageBubble({
  role,
  content,
  timestamp,
  toolName,
  toolInput,
  toolOutput,
  thinking,
}: {
  role: string;
  content?: string;
  timestamp: number;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  thinking?: string;
}) {
  const isUser = role === "user";
  const isSystem = role === "system";
  const isTool = role === "tool";

  return (
    <div
      className={`mb-4 ${isUser ? "flex justify-end" : "flex justify-start"}`}
    >
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isUser
            ? "bg-blue-600 text-white"
            : isSystem
              ? "bg-amber-900/50 border border-amber-700 text-amber-200"
              : isTool
                ? "bg-slate-700/50 border border-slate-600 text-slate-300"
                : "bg-slate-800 border border-slate-700 text-slate-200"
        }`}
      >
        <div className="flex items-center gap-2 mb-1">
          <span
            className={`text-xs font-medium ${isUser ? "text-blue-200" : "text-slate-400"}`}
          >
            {role === "assistant" ? "Assistant" : role.charAt(0).toUpperCase() + role.slice(1)}
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
        {toolName && (
          <div className="text-xs text-cyan-400 mb-1">Tool: {toolName}</div>
        )}
        {toolInput && (
          <pre className="text-xs bg-slate-900/50 p-2 rounded mb-2 overflow-x-auto">
            {toolInput}
          </pre>
        )}
        {content && (
          <div className="whitespace-pre-wrap text-sm">{content}</div>
        )}
        {toolOutput && (
          <pre className="text-xs bg-slate-900/50 p-2 rounded mt-2 overflow-x-auto max-h-40 overflow-y-auto">
            {toolOutput}
          </pre>
        )}
      </div>
    </div>
  );
}

export default function ConversationPage() {
  const params = useParams();
  const id = params.id as string;

  const conversation = useQuery(api.conversations.getConversation, {
    conversation_id: id as Id<"conversations">,
  });

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
              <span className="text-xs text-slate-500 ml-auto">
                {conversation.agent_type}
              </span>
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
            conversation.messages.map((msg) => (
              <MessageBubble
                key={msg._id}
                role={msg.role}
                content={msg.content}
                timestamp={msg.timestamp}
                toolName={msg.tool_name}
                toolInput={msg.tool_input}
                toolOutput={msg.tool_output}
                thinking={msg.thinking}
              />
            ))
          )}
        </div>
      </main>
    </AuthGuard>
  );
}
