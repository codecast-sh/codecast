"use client";
import { useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useMemo } from "react";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ConversationView, ConversationData } from "../../../components/ConversationView";
import { ConversationDiffLayout } from "../../../components/ConversationDiffLayout";
import { PublicCommentSection } from "../../../components/PublicCommentSection";
import { toast } from "sonner";
import { useConversationMessages } from "../../../hooks/useConversationMessages";
import { useDiffViewerStore } from "../../../store/diffViewerStore";
import { copyToClipboard } from "../../../lib/utils";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVEX_ID_REGEX = /^[a-z0-9]{32}$/;

function OwnerView({
  id,
  highlightQuery,
  onClearHighlight,
}: {
  id: string;
  highlightQuery?: string;
  onClearHighlight: () => void;
}) {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [showShareCopied, setShowShareCopied] = useState(false);
  const toggleDiffPanel = useDiffViewerStore((state) => state.toggleDiffPanel);

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
      const url = `${window.location.origin}/conversation/${id}`;
      setShareUrl(url);
    }
  }, [conversation?.share_token, id]);

  const handleShare = async () => {
    try {
      let url = shareUrl;
      if (!conversation?.share_token) {
        await generateShareLink({ conversation_id: id as Id<"conversations"> });
      }
      url = `${window.location.origin}/conversation/${id}`;
      setShareUrl(url);
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
          onClearHighlight={onClearHighlight}
          embedded
        />
      )}
    </DashboardLayout>
  );
}

function SharedView({ conversation }: { conversation: ConversationData }) {
  const router = useRouter();
  const [isForking, setIsForking] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);

  const forkConversation = useMutation(api.conversations.forkConversation);
  const currentUser = useQuery(api.users.getCurrentUser);

  const commentCount = useQuery(
    api.publicComments.getPublicComments,
    { conversation_id: conversation._id as Id<"conversations"> }
  );

  const handleFork = async () => {
    if (isForking || !conversation.share_token) return;
    setIsForking(true);
    try {
      const newConversationId = await forkConversation({ share_token: conversation.share_token });
      toast.success("Conversation forked successfully");
      router.push(`/conversation/${newConversationId}`);
    } catch (error) {
      console.error("Fork failed:", error);
      const message = error instanceof Error ? error.message : "Failed to fork conversation";
      toast.error(message);
      setIsForking(false);
    }
  };

  const forkCount = conversation.fork_count ?? 0;

  return (
    <>
      <ConversationView
        conversation={conversation}
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
              disabled={isForking || !conversation.share_token}
              className="text-[10px] text-sol-base0 px-2 py-1 bg-sol-blue/20 hover:bg-sol-blue/30 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isForking ? "Forking..." : "Fork"}
            </button>
          </div>
        }
      />
      {conversation.user_id && (
        <>
          <button
            onClick={() => setCommentsOpen(!commentsOpen)}
            className="fixed bottom-4 right-4 bg-sol-blue hover:bg-sol-cyan text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 text-sm font-medium transition-colors z-40"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            {commentsOpen ? "Hide Comments" : `Comments${commentCount && commentCount.length > 0 ? ` (${commentCount.length})` : ""}`}
          </button>

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
                  conversationId={conversation._id as Id<"conversations">}
                  conversationOwnerId={conversation.user_id as Id<"users">}
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

function DeniedView() {
  return (
    <main className="h-screen flex flex-col bg-sol-base03 items-center justify-center">
      <div className="text-center max-w-md px-4">
        <svg className="w-16 h-16 mx-auto mb-4 text-sol-base01" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        <h1 className="text-xl text-sol-base0 mb-2">No Permission</h1>
        <p className="text-sol-base00 text-sm">
          This conversation is private. You don't have permission to view it.
        </p>
      </div>
    </main>
  );
}

function NotFoundView() {
  return (
    <main className="h-screen flex flex-col bg-sol-base03 items-center justify-center">
      <div className="text-center max-w-md px-4">
        <svg className="w-16 h-16 mx-auto mb-4 text-sol-base01" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <h1 className="text-xl text-sol-base0 mb-2">Not Found</h1>
        <p className="text-sol-base00 text-sm">
          This conversation doesn't exist or has been deleted.
        </p>
      </div>
    </main>
  );
}

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

  const isUUID = useMemo(() => UUID_REGEX.test(id), [id]);
  const isValidConvexId = useMemo(() => CONVEX_ID_REGEX.test(id), [id]);

  const sessionLookup = useQuery(
    api.conversations.getConversationBySessionId,
    isUUID ? { session_id: id } : "skip"
  );

  useEffect(() => {
    if (sessionLookup?._id) {
      router.replace(`/conversation/${sessionLookup._id}`);
    }
  }, [sessionLookup, router]);

  const publicData = useQuery(
    api.conversations.getConversationPublic,
    !isUUID && isValidConvexId ? { conversation_id: id as Id<"conversations"> } : "skip"
  );

  if (!isUUID && !isValidConvexId) {
    return <NotFoundView />;
  }

  if (isUUID) {
    if (sessionLookup === undefined) {
      return (
        <main className="h-screen flex flex-col bg-sol-base03 items-center justify-center">
          <div className="text-sol-base0">Loading...</div>
        </main>
      );
    }
    if (sessionLookup === null) {
      return <NotFoundView />;
    }
    return null;
  }

  if (publicData === undefined) {
    return (
      <main className="h-screen flex flex-col bg-sol-base03 items-center justify-center">
        <div className="text-sol-base0">Loading...</div>
      </main>
    );
  }

  if (publicData.access_level === "not_found") {
    return <NotFoundView />;
  }

  if (publicData.access_level === "denied") {
    return <DeniedView />;
  }

  if (publicData.access_level === "owner" || publicData.access_level === "team") {
    return (
      <OwnerView
        id={id}
        highlightQuery={highlightQuery}
        onClearHighlight={handleClearHighlight}
      />
    );
  }

  if (publicData.access_level === "shared" && publicData.conversation) {
    return <SharedView conversation={publicData.conversation as ConversationData} />;
  }

  return <DeniedView />;
}
