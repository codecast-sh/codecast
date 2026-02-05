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
import { SharePopover } from "../../../components/SharePopover";
import { toast } from "sonner";
import { useConversationMessages } from "../../../hooks/useConversationMessages";
import { useSharedConversationMessages } from "../../../hooks/useSharedConversationMessages";
import { useDiffViewerStore } from "../../../store/diffViewerStore";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVEX_ID_REGEX = /^[a-z0-9]{32}$/;

function ConversationLoadingSkeleton() {
  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto px-4 py-4 space-y-6 animate-pulse motion-reduce:animate-none">
        <div className="bg-sol-blue/10 border border-sol-blue/30 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-6 h-6 rounded bg-sol-blue/30" />
            <div className="h-3 w-12 bg-sol-blue/30 rounded" />
            <div className="h-3 w-16 bg-sol-blue/20 rounded" />
          </div>
          <div className="pl-8 space-y-2">
            <div className="h-3 bg-sol-blue/20 rounded w-3/4" />
            <div className="h-3 bg-sol-blue/20 rounded w-1/2" />
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-6 h-6 rounded bg-sol-yellow/60" />
            <div className="h-3 w-14 bg-sol-bg-alt rounded" />
            <div className="h-3 w-16 bg-sol-bg-alt rounded" />
          </div>
          <div className="pl-8 space-y-2">
            <div className="h-3 bg-sol-bg-alt rounded w-full" />
            <div className="h-3 bg-sol-bg-alt rounded w-5/6" />
            <div className="h-3 bg-sol-bg-alt rounded w-4/5" />
          </div>
        </div>

        <div className="bg-sol-blue/10 border border-sol-blue/30 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-6 h-6 rounded bg-sol-blue/30" />
            <div className="h-3 w-12 bg-sol-blue/30 rounded" />
            <div className="h-3 w-16 bg-sol-blue/20 rounded" />
          </div>
          <div className="pl-8">
            <div className="h-3 bg-sol-blue/20 rounded w-2/3" />
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-6 h-6 rounded bg-sol-yellow/60" />
            <div className="h-3 w-14 bg-sol-bg-alt rounded" />
            <div className="h-3 w-16 bg-sol-bg-alt rounded" />
          </div>
          <div className="pl-8 space-y-2">
            <div className="h-3 bg-sol-bg-alt rounded w-full" />
            <div className="h-3 bg-sol-bg-alt rounded w-11/12" />
            <div className="h-3 bg-sol-bg-alt rounded w-3/4" />
            <div className="h-3 bg-sol-bg-alt rounded w-5/6" />
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

function OwnerView({
  id,
  highlightQuery,
  onClearHighlight,
  targetMessageId,
  isOwner,
}: {
  id: string;
  highlightQuery?: string;
  onClearHighlight: () => void;
  targetMessageId?: string;
  isOwner: boolean;
}) {
  const toggleDiffPanel = useDiffViewerStore((state) => state.toggleDiffPanel);

  const { conversation, hasMoreAbove, hasMoreBelow, isLoadingOlder, isLoadingNewer, loadOlder, loadNewer, isSearchingForTarget } = useConversationMessages(id, targetMessageId, highlightQuery);
  const commits = useQuery(api.commits.getCommitsForConversation, {
    conversation_id: id as Id<"conversations">,
  });
  const pullRequests = useQuery(api.pull_requests.getPRsForConversation, {
    conversation_id: id as Id<"conversations">,
  });

  const setPrivacy = useMutation(api.conversations.setPrivacy);
  const setTeamVisibility = useMutation(api.conversations.setTeamVisibility);
  const generateShareLink = useMutation(api.conversations.generateShareLink);

  const shareUrl = conversation?.share_token
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/conversation/${id}`
    : null;

  const handleSetPrivate = async () => {
    await setPrivacy({ conversation_id: id as Id<"conversations">, is_private: true });
    toast.success("Made private");
  };

  const handleSetTeamVisibility = async (mode: "summary" | "full") => {
    await setTeamVisibility({ conversation_id: id as Id<"conversations">, team_visibility: mode });
    toast.success(mode === "full" ? "Sharing full conversation with team" : "Sharing summary with team");
  };

  const handleGenerateShareLink = async () => {
    await generateShareLink({ conversation_id: id as Id<"conversations"> });
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

  const shareControls = conversation && isOwner ? (
    <SharePopover
      isPrivate={conversation.is_private !== false}
      teamVisibility={conversation.team_visibility}
      hasShareToken={!!conversation.share_token}
      onSetPrivate={handleSetPrivate}
      onSetTeamVisibility={handleSetTeamVisibility}
      onGenerateShareLink={handleGenerateShareLink}
      shareUrl={shareUrl}
    />
  ) : null;

  if (!conversation) {
    return <ConversationLoadingSkeleton />;
  }

  return (
    <DashboardLayout>
      {isSearchingForTarget && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-sol-bg-alt border border-sol-border rounded-full px-4 py-2 shadow-lg flex items-center gap-2">
          <svg className="w-4 h-4 animate-spin text-sol-cyan" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-sm text-sol-text-secondary">Finding message...</span>
        </div>
      )}
      <ConversationDiffLayout
        conversation={conversation as ConversationData}
        commits={commits || []}
        pullRequests={pullRequests || []}
        headerExtra={shareControls}
        hasMoreAbove={hasMoreAbove}
        hasMoreBelow={hasMoreBelow}
        isLoadingOlder={isLoadingOlder}
        isLoadingNewer={isLoadingNewer}
        onLoadOlder={loadOlder}
        onLoadNewer={loadNewer}
        highlightQuery={highlightQuery}
        onClearHighlight={onClearHighlight}
        embedded
        targetMessageId={targetMessageId}
      />
    </DashboardLayout>
  );
}

function SharedView({ id, highlightQuery, onClearHighlight }: { id: string; highlightQuery?: string; onClearHighlight: () => void }) {
  const router = useRouter();
  const [isForking, setIsForking] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);

  const { conversation, hasMoreAbove, isLoadingOlder, loadOlder, isSearchingForTarget } = useSharedConversationMessages(id, highlightQuery);

  const forkConversation = useMutation(api.conversations.forkConversation);
  const currentUser = useQuery(api.users.getCurrentUser);

  const commentCount = useQuery(
    api.publicComments.getPublicComments,
    conversation ? { conversation_id: conversation._id as Id<"conversations"> } : "skip"
  );

  const handleFork = async () => {
    if (isForking || !conversation?.share_token) return;
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

  if (!conversation) {
    return <ConversationLoadingSkeleton />;
  }

  const forkCount = conversation.fork_count ?? 0;

  return (
    <>
      {isSearchingForTarget && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-sol-bg-alt border border-sol-border rounded-full px-4 py-2 shadow-lg flex items-center gap-2">
          <svg className="w-4 h-4 animate-spin text-sol-cyan" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-sm text-sol-text-secondary">Finding message...</span>
        </div>
      )}
      <ConversationView
        conversation={conversation as ConversationData}
        commits={[]}
        backHref="/"
        backLabel="Home"
        showMessageInput={false}
        hasMoreAbove={hasMoreAbove}
        isLoadingOlder={isLoadingOlder}
        onLoadOlder={loadOlder}
        highlightQuery={highlightQuery}
        onClearHighlight={onClearHighlight}
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
  const [targetMessageId, setTargetMessageId] = useState<string | undefined>(undefined);

  useEffect(() => {
    const hash = window.location.hash;
    if (hash && hash.startsWith("#msg-")) {
      setTargetMessageId(hash.slice(5));
    }
  }, []);

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
      return <ConversationLoadingSkeleton />;
    }
    if (sessionLookup === null) {
      return <NotFoundView />;
    }
    return null;
  }

  if (publicData === undefined) {
    return <ConversationLoadingSkeleton />;
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
        targetMessageId={targetMessageId}
        isOwner={publicData.access_level === "owner"}
      />
    );
  }

  if (publicData.access_level === "shared") {
    return <SharedView id={id} highlightQuery={highlightQuery} onClearHighlight={handleClearHighlight} />;
  }

  return <DeniedView />;
}
