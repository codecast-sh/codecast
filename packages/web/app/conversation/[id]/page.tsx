"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthGuard } from "../../../components/AuthGuard";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ConversationView, ConversationData } from "../../../components/ConversationView";

export default function ConversationPage() {
  const params = useParams();
  const id = params.id as string;
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [showShareCopied, setShowShareCopied] = useState(false);

  const conversation = useQuery(api.conversations.getConversation, {
    conversation_id: id as Id<"conversations">,
  });

  const generateShareLink = useMutation(api.conversations.generateShareLink);
  const setPrivacy = useMutation(api.conversations.setPrivacy);

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

  const handleShareWithTeam = async () => {
    try {
      await setPrivacy({ conversation_id: id as Id<"conversations">, is_private: false });
    } catch (error) {
      alert(error instanceof Error ? error.message : "Failed to share with team");
    }
  };

  const handleMakePrivate = async () => {
    try {
      await setPrivacy({ conversation_id: id as Id<"conversations">, is_private: true });
    } catch (error) {
      alert(error instanceof Error ? error.message : "Failed to make private");
    }
  };

  const shareControls = (
    <div className="flex items-center gap-1">
      {conversation?.is_private ? (
        <button
          onClick={handleShareWithTeam}
          className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-green transition-colors"
          title="Share with team"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </button>
      ) : (
        <>
          <button
            onClick={handleMakePrivate}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-green hover:text-sol-text-secondary transition-colors"
            title="Make private"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
            </svg>
          </button>
          <button
            onClick={shareUrl ? handleCopyShareUrl : handleShare}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors"
            title={shareUrl ? (showShareCopied ? "Copied!" : "Copy share link") : "Share publicly"}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
          </button>
        </>
      )}
    </div>
  );

  return (
    <AuthGuard>
      <ConversationView
        conversation={conversation as ConversationData | null | undefined}
        backHref="/dashboard"
        backLabel="Back"
        headerExtra={shareControls}
      />
    </AuthGuard>
  );
}
