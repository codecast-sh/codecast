import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { useInboxStore } from "../../../store/inboxStore";

/**
 * Every accessible conversation renders through the inbox — single codepath.
 * Pre-populates `conversations[id].is_own` so the inbox picks the right UI
 * (owner-only controls hidden for teammate sessions) before
 * getConversationWithMeta resolves. Sets deep-link state (scroll target,
 * highlight) before navigating so QueuePageClient picks it up.
 */
function RedirectToInbox({
  id,
  isOwn,
  targetMessageId,
  highlightQuery,
}: {
  id: string;
  isOwn: boolean;
  targetMessageId?: string;
  highlightQuery?: string;
}) {
  const router = useRouter();
  useMountEffect(() => {
    const store = useInboxStore.getState();
    const updates: Record<string, any> = {};
    if (targetMessageId) updates.pendingScrollToMessageId = targetMessageId;
    if (highlightQuery) updates.pendingHighlightQuery = highlightQuery;
    if (Object.keys(updates).length > 0) useInboxStore.setState(updates);
    // Seed is_own so the inbox picks the right UI before getConversationWithMeta resolves.
    store.syncRecord("conversations", id, { _id: id, is_own: isOwn });
    store.navigateToSession(id);
    router.replace('/inbox');
  });
  return <ConversationLoadingSkeleton />;
}

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
            <div className="w-6 h-6 rounded bg-sol-orange/60" />
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
            <div className="w-6 h-6 rounded bg-sol-orange/60" />
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

function DeniedView() {
  return (
    <DashboardLayout>
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md px-4">
          <svg className="w-16 h-16 mx-auto mb-4 text-sol-base01" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <h1 className="text-xl text-sol-base0 mb-2">No Permission</h1>
          <p className="text-sol-base00 text-sm">
            This conversation is private. You don't have permission to view it.
          </p>
        </div>
      </div>
    </DashboardLayout>
  );
}

function NotFoundView() {
  return (
    <DashboardLayout>
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md px-4">
          <svg className="w-16 h-16 mx-auto mb-4 text-sol-base01" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <h1 className="text-xl text-sol-base0 mb-2">Not Found</h1>
          <p className="text-sol-base00 text-sm">
            This conversation doesn't exist or has been deleted.
          </p>
        </div>
      </div>
    </DashboardLayout>
  );
}

export default function ConversationPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const highlightQuery = searchParams.get("highlight") || undefined;
  const [targetMessageId] = useState<string | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    const hash = window.location.hash;
    if (hash && hash.startsWith("#msg-")) {
      return hash.slice(5);
    }
    return undefined;
  });

  // Local-first: resolve from inbox store instantly when available.
  // Falls back to server resolver for shared links / external navigation.
  const localSession = useInboxStore(s => s.sessions[id] ?? s.dismissedSessions[id]);
  const resolved = useQuery(api.conversations.resolveConversation, { id });
  const effective = resolved ?? (localSession ? { access_level: "owner" as const, conversation_id: localSession._id } : undefined);

  if (effective === undefined) return <ConversationLoadingSkeleton />;
  if (effective.access_level === "denied") return <DeniedView />;
  if (effective.access_level === "not_found" || !effective.conversation_id) return <NotFoundView />;

  // Every accessible session (owner, team, shared) renders through the inbox — single codepath.
  return (
    <RedirectToInbox
      id={effective.conversation_id}
      isOwn={effective.access_level === "owner"}
      targetMessageId={targetMessageId}
      highlightQuery={highlightQuery}
    />
  );
}
