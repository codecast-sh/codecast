"use client";
import { useQuery } from "convex/react";
import { api } from "@code-chat-sync/convex/convex/_generated/api";
import Link from "next/link";

export function ConversationList({ filter }: { filter: "my" | "team" }) {
  const conversations = useQuery(api.conversations.listConversations, {
    filter,
  });

  if (!conversations) {
    return <div className="text-slate-400">Loading...</div>;
  }

  if (conversations.length === 0) {
    return (
      <div className="text-center py-16 text-slate-400">
        No conversations found
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {conversations.map((conv) => (
        <Link
          key={conv._id}
          href={`/conversation/${conv._id}`}
          className="block bg-slate-800/50 border border-slate-700 rounded-lg p-4 hover:border-slate-600 transition-colors"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-white font-medium">{conv.title}</h3>
            <span className="text-xs text-slate-500">{conv.agent_type}</span>
          </div>
          <p className="text-sm text-slate-400 mt-1">
            {new Date(conv.started_at).toLocaleDateString()}
          </p>
        </Link>
      ))}
    </div>
  );
}
