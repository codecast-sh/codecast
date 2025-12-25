"use client";
import { useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthGuard } from "../../../components/AuthGuard";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ConversationView, ConversationData } from "../../../components/ConversationView";
import { ShareDialog } from "../../../components/ShareDialog";
import { toast } from "sonner";
import { useConversationMessages } from "../../../hooks/useConversationMessages";
import Link from "next/link";

export default function ConversationPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [showShareCopied, setShowShareCopied] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);

  const { conversation, hasMoreAbove, isLoadingOlder, loadOlder } = useConversationMessages(id);
  const commits = useQuery(api.commits.getCommitsForConversation, {
    conversation_id: id as Id<"conversations">,
  });

  const setPrivacy = useMutation(api.conversations.setPrivacy);

  useEffect(() => {
    if (conversation?.share_token) {
      const url = `${window.location.origin}/share/${conversation.share_token}`;
      setShareUrl(url);
    }
  }, [conversation?.share_token]);

  const handleShare = () => {
    setShowShareDialog(true);
  };

  const handleCopyShareUrl = async () => {
    if (shareUrl) {
      await navigator.clipboard.writeText(shareUrl);
      setShowShareCopied(true);
      toast.success("Share link copied to clipboard");
      setTimeout(() => setShowShareCopied(false), 2000);
    }
  };

  const handleShareWithTeam = async () => {
    try {
      await setPrivacy({ conversation_id: id as Id<"conversations">, is_private: false });
      toast.success("Shared with team");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to share with team");
    }
  };

  const handleMakePrivate = async () => {
    try {
      await setPrivacy({ conversation_id: id as Id<"conversations">, is_private: true });
      toast.success("Made private");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to make private");
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "d" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
          return;
        }
        e.preventDefault();
        router.push(`/conversation/${id}/diff`);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [id, router]);

  const shareControls = (
    <div className="flex items-center gap-1">
      {/* Diff viewer toggle */}
      <Link
        href={`/conversation/${id}/diff`}
        className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-magenta transition-colors"
        title="View diff (d)"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
      </Link>
      {/* Team privacy toggle */}
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
        <button
          onClick={handleMakePrivate}
          className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-green hover:text-sol-text-secondary transition-colors"
          title="Make private"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
          </svg>
        </button>
      )}
      {/* Public share button - always visible */}
      <button
        onClick={shareUrl ? handleCopyShareUrl : handleShare}
        className={`p-1.5 rounded hover:bg-sol-bg-alt transition-colors ${
          shareUrl ? "text-sol-cyan hover:text-sol-cyan" : "text-sol-text-dim hover:text-sol-text-secondary"
        }`}
        title={shareUrl ? (showShareCopied ? "Copied!" : "Copy public link") : "Create public link"}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
        </svg>
      </button>
    </div>
  );

  return (
    <AuthGuard>
      <ConversationView
        conversation={conversation as ConversationData | null | undefined}
        commits={commits || []}
        backHref="/dashboard"
        backLabel="Back"
        headerExtra={shareControls}
        hasMoreAbove={hasMoreAbove}
        isLoadingOlder={isLoadingOlder}
        onLoadOlder={loadOlder}
      />
      <ShareDialog
        open={showShareDialog}
        onOpenChange={setShowShareDialog}
        conversationId={id as Id<"conversations">}
        conversationTitle={conversation?.title}
        shareToken={conversation?.share_token}
        onShareGenerated={(token) => {
          const url = `${window.location.origin}/share/${token}`;
          setShareUrl(url);
        }}
      />
    </AuthGuard>
  );
}
