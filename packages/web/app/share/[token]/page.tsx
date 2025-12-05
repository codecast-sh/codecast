"use client";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import { ConversationView, ConversationData } from "../../../components/ConversationView";

export default function SharedConversationPage() {
  const params = useParams();
  const token = params.token as string;

  const conversation = useQuery(api.conversations.getSharedConversation, {
    share_token: token,
  });

  if (conversation === null) {
    return (
      <main className="h-screen flex flex-col bg-slate-950 items-center justify-center">
        <div className="text-slate-400 text-center py-8">
          This conversation is not available. It may be private or the link may be invalid.
        </div>
      </main>
    );
  }

  return (
    <ConversationView
      conversation={conversation as ConversationData | null | undefined}
      backHref="/"
      backLabel="Home"
      headerExtra={
        <span className="text-[10px] text-slate-500 px-2 py-1 bg-slate-800 rounded">
          Shared
        </span>
      }
    />
  );
}
