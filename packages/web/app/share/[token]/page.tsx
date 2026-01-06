"use client";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams, useRouter } from "next/navigation";
import { ConversationView, ConversationData } from "../../../components/ConversationView";
import { PublicCommentSection } from "../../../components/PublicCommentSection";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";

export default function SharedConversationPage() {
  const params = useParams();
  const token = params.token as string;
  const router = useRouter();
  const [isForking, setIsForking] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);

  const conversation = useQuery(api.conversations.getSharedConversation, {
    share_token: token,
  });

  const forkConversation = useMutation(api.conversations.forkConversation);
  const currentUser = useQuery(api.users.getCurrentUser);

  const commentCount = useQuery(
    api.publicComments.getPublicComments,
    conversation ? { conversation_id: conversation._id as Id<"conversations"> } : "skip"
  );

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

  const conversationData = conversation as ConversationData | null | undefined;
  const forkCount = conversation?.fork_count ?? 0;

  return (
    <>
      <ConversationView
        conversation={conversationData}
        commits={[]}
        backHref="/"
        backLabel="Home"
        showMessageInput={false}
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
      {conversationData && conversationData.user_id && (
        <>
          {/* Comments toggle button */}
          <button
            onClick={() => setCommentsOpen(!commentsOpen)}
            className="fixed bottom-4 right-4 bg-sol-blue hover:bg-sol-cyan text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 text-sm font-medium transition-colors z-40"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            {commentsOpen ? "Hide Comments" : `Comments${commentCount && commentCount.length > 0 ? ` (${commentCount.length})` : ""}`}
          </button>

          {/* Comments panel */}
          {commentsOpen && (
            <div className="fixed bottom-0 right-0 left-0 bg-sol-base03 border-t border-sol-border max-h-[60vh] overflow-y-auto shadow-2xl z-50">
              <div className="max-w-4xl mx-auto w-full px-4 py-4">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sol-text text-lg font-medium">Comments</h2>
                  <button
                    onClick={() => setCommentsOpen(false)}
                    className="text-sol-text-dim hover:text-sol-text p-1"
                    title="Close comments"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <PublicCommentSection
                  conversationId={conversationData._id as Id<"conversations">}
                  conversationOwnerId={conversationData.user_id as Id<"users">}
                  currentUserId={currentUser?._id}
                />
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
