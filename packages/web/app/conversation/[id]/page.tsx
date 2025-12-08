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
    <div className="flex items-center gap-2">
      {conversation?.is_private ? (
        <>
          <span className="px-2 py-1 text-xs bg-sol-base02 text-sol-base1 rounded flex items-center gap-1">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
            </svg>
            Private
          </span>
          <button
            onClick={handleShareWithTeam}
            className="px-2 py-1 text-xs bg-sol-green hover:bg-green-700 text-white rounded transition-colors"
          >
            Share with team
          </button>
        </>
      ) : (
        <>
          <span className="px-2 py-1 text-xs bg-sol-base02 text-sol-base1 rounded flex items-center gap-1">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zM18 8a2 2 0 11-4 0 2 2 0 014 0zM14 15a4 4 0 00-8 0v3h8v-3zM6 8a2 2 0 11-4 0 2 2 0 014 0zM16 18v-3a5.972 5.972 0 00-.75-2.906A3.005 3.005 0 0119 15v3h-3zM4.75 12.094A5.973 5.973 0 004 15v3H1v-3a3 3 0 013.75-2.906z" />
            </svg>
            Team visible
          </span>
          <button
            onClick={handleMakePrivate}
            className="px-2 py-1 text-xs bg-sol-base02 hover:bg-slate-700 text-sol-base1 rounded transition-colors"
          >
            Make private
          </button>
          {!shareUrl ? (
            <button
              onClick={handleShare}
              className="px-2 py-1 text-xs bg-sol-base02 hover:bg-slate-700 text-sol-base1 rounded transition-colors"
            >
              Share publicly
            </button>
          ) : (
            <button
              onClick={handleCopyShareUrl}
              className="px-2 py-1 text-xs bg-sol-base02 hover:bg-slate-700 text-sol-base1 rounded transition-colors"
            >
              {showShareCopied ? "Copied!" : "Copy Link"}
            </button>
          )}
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
