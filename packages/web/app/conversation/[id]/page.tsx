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

  const shareControls = (
    <>
      {!shareUrl ? (
        <button
          onClick={handleShare}
          className="px-2 py-1 text-xs bg-sol-base02 hover:bg-slate-700 text-sol-base1 rounded transition-colors"
        >
          Share
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
