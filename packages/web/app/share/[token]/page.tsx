"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams, useRouter } from "next/navigation";
import { ConversationView, ConversationData } from "../../../components/ConversationView";
import { useState } from "react";
import { toast } from "sonner";

export default function SharedConversationPage() {
  const params = useParams();
  const token = params.token as string;
  const router = useRouter();
  const [isForking, setIsForking] = useState(false);

  const conversation = useQuery(api.conversations.getSharedConversation, {
    share_token: token,
  });

  const forkConversation = useMutation(api.conversations.forkConversation);

  const handleFork = async () => {
    if (isForking) return;
    setIsForking(true);
    try {
      const newConversationId = await forkConversation({ share_token: token });
      toast.success("Conversation forked successfully");
      router.push(`/conversations/${newConversationId}`);
    } catch (error) {
      console.error("Fork failed:", error);
      const message = error instanceof Error ? error.message : "Failed to fork conversation";
      toast.error(message);
      setIsForking(false);
    }
  };

  if (conversation === null) {
    return (
      <main className="h-screen flex flex-col bg-sol-base03 items-center justify-center">
        <div className="text-sol-base0 text-center py-8">
          This conversation is not available. It may be private or the link may be invalid.
        </div>
      </main>
    );
  }

  const forkCount = conversation?.fork_count ?? 0;

  return (
    <ConversationView
      conversation={conversation as ConversationData | null | undefined}
      commits={[]}
      backHref="/"
      backLabel="Home"
      headerExtra={
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-sol-base00 px-2 py-1 bg-sol-base02 rounded">
            Shared
          </span>
          {forkCount > 0 && (
            <span className="text-[10px] text-sol-base00 px-2 py-1 bg-sol-base02 rounded">
              {forkCount} {forkCount === 1 ? "fork" : "forks"}
            </span>
          )}
          <button
            onClick={handleFork}
            disabled={isForking}
            className="text-[10px] text-sol-base0 px-2 py-1 bg-sol-blue/20 hover:bg-sol-blue/30 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isForking ? "Forking..." : "Fork"}
          </button>
        </div>
      }
    />
  );
}
