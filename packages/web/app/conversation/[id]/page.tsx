"use client";
import { useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useMemo } from "react";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ConversationData } from "../../../components/ConversationView";
import { ConversationDiffLayout } from "../../../components/ConversationDiffLayout";
import { toast } from "sonner";
import { useConversationMessages } from "../../../hooks/useConversationMessages";
import { useDiffViewerStore } from "../../../store/diffViewerStore";
import { copyToClipboard } from "../../../lib/utils";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ConversationPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const highlightQuery = searchParams.get("highlight") || undefined;
  const handleClearHighlight = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("highlight");
    router.replace(url.pathname + url.search);
  };
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [showShareCopied, setShowShareCopied] = useState(false);
  const toggleDiffPanel = useDiffViewerStore((state) => state.toggleDiffPanel);

  const isUUID = useMemo(() => UUID_REGEX.test(id), [id]);

  const sessionLookup = useQuery(
    api.conversations.getConversationBySessionId,
    isUUID ? { session_id: id } : "skip"
  );

  useEffect(() => {
    if (sessionLookup?._id) {
      router.replace(`/conversation/${sessionLookup._id}`);
    }
  }, [sessionLookup, router]);

  const { conversation, hasMoreAbove, isLoadingOlder, loadOlder } = useConversationMessages(id);
  const commits = useQuery(api.commits.getCommitsForConversation, {
    conversation_id: id as Id<"conversations">,
  });
  const pullRequests = useQuery(api.pull_requests.getPRsForConversation, {
    conversation_id: id as Id<"conversations">,
  });

  const setPrivacy = useMutation(api.conversations.setPrivacy);
  const generateShareLink = useMutation(api.conversations.generateShareLink);

  useEffect(() => {
    if (conversation?.share_token) {
      const url = `${window.location.origin}/share/${conversation.share_token}`;
      setShareUrl(url);
    }
  }, [conversation?.share_token]);

  const handleShare = async () => {
    try {
      let url = shareUrl;
      if (!url) {
        const token = await generateShareLink({ conversation_id: id as Id<"conversations"> });
        url = `${window.location.origin}/share/${token}`;
        setShareUrl(url);
      }
      await copyToClipboard(url);
      toast.success("Share link copied to clipboard");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to generate share link");
    }
  };

  const handleCopyShareUrl = async () => {
    if (shareUrl) {
      await copyToClipboard(shareUrl);
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
        toggleDiffPanel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleDiffPanel]);

  const shareControls = (
    <div className="flex items-center gap-1">
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
      <DashboardLayout>
        {conversation && (
          <ConversationDiffLayout
            conversation={conversation as ConversationData}
            commits={commits || []}
            pullRequests={pullRequests || []}
            headerExtra={shareControls}
            hasMoreAbove={hasMoreAbove}
            isLoadingOlder={isLoadingOlder}
            onLoadOlder={loadOlder}
            highlightQuery={highlightQuery}
            onClearHighlight={handleClearHighlight}
            embedded
          />
        )}
      </DashboardLayout>
    </AuthGuard>
  );
}
