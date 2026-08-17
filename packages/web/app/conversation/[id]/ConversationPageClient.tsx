import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { setGuestImageScope } from "../../../hooks/useStorageImageUrl";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { ConversationDiffLayout } from "../../../components/ConversationDiffLayout";
import { ConversationData } from "../../../components/ConversationView";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { useConversationMessages } from "../../../hooks/useConversationMessages";
import { useInboxStore } from "../../../store/inboxStore";
import { PREFILL_PARAM, buildPrefillText } from "../../../lib/composerPrefill";
import { setShareTokenScope } from "../../../lib/shareTokenScope";

/**
 * Every accessible conversation renders through the inbox — single codepath —
 * EXCEPT unauthenticated visitors: /inbox sits behind AuthGuard (which bounces
 * guests to the marketing root), so public share links render the standalone
 * read-only GuestConversationView below instead.
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
  prefill,
}: {
  id: string;
  isOwn: boolean;
  targetMessageId?: string;
  highlightQuery?: string;
  prefill?: string;
}) {
  const router = useRouter();
  useMountEffect(() => {
    const store = useInboxStore.getState();
    // Seed is_own so the inbox picks the right UI before getConversationWithMeta resolves.
    store.syncRecord("conversations", id, { _id: id, is_own: isOwn });
    // `?prefill=` rides the store, not the URL: the redirect below drops the
    // query and the inbox rewrites the address again once the session resolves.
    // That redirect is also what keeps a refresh from re-seeding the composer —
    // the param never reaches the address bar the user ends up on.
    const prefillText = buildPrefillText(prefill);
    if (prefillText) store.setComposerPrefill({ convId: id, text: prefillText });
    // Deep-link state travels through requestNavigate — target session, scroll
    // target, and highlight in ONE action. Setting pendingScrollToMessageId as
    // a bare field first (the old shape) raced: with another inbox pane
    // mounted in the tab shell, its cache-hit watcher paired the scroll target
    // with whatever session IT was showing and consumed it, so #msg- deep
    // links landed at the conversation tail instead of the target message.
    if (targetMessageId || highlightQuery) {
      store.requestNavigate(id, {
        scrollToMessageId: targetMessageId ?? null,
        highlightQuery: highlightQuery ?? null,
      });
    } else {
      store.navigateToSession(id);
    }
    // Hand the target id to the inbox via its durable `?s=` deep-link param rather
    // than relying solely on the transient `pendingNavigateId` store flag. When this
    // redirect lands inside the dashboard tab shell, the tab swaps its mounted route
    // (conversation → inbox) and the flag can be consumed-and-cleared before the inbox
    // settles, dropping us onto an auto-selected session or a "Not Found". The URL
    // param survives that remount and is re-read on every render, so the inbox reliably
    // injects and shows the right conversation. navigateToSession above still gives the
    // instant path for sessions already in the queue.
    router.replace(`/inbox?s=${id}`);
  });
  return <ConversationLoadingSkeleton />;
}

/**
 * Read-only viewer for unauthenticated visitors on a shared link. Renders the
 * same conversation surface as the inbox (ConversationDiffLayout fed by
 * useConversationMessages) inside DashboardLayout's chrome-less guest branch —
 * no send input, no owner controls.
 */
function GuestConversationView({
  id,
  targetMessageId,
  highlightQuery,
}: {
  id: string;
  targetMessageId?: string;
  highlightQuery?: string;
}) {
  const router = useRouter();
  // Storage-backed transcript images resolve through the batched getImageUrls
  // queue, which needs this conversation as its share scope while the viewer
  // is anonymous (the server only serves guests ids it can verify belong to
  // the shared conversation).
  useMountEffect(() => {
    setGuestImageScope(id);
    return () => setGuestImageScope(null);
  });
  // Jumps to messages outside the loaded window (message browser, minimap)
  // travel through the store's navigate request — the same codepath the inbox
  // uses. Its consumer (QueuePageClient) isn't mounted on this page, so consume
  // requests aimed at this conversation and re-target the message hook directly.
  const [jumpTargetId, setJumpTargetId] = useState<string | undefined>(undefined);
  const pendingNavigateId = useInboxStore((s) => s.pendingNavigateId);
  useWatchEffect(() => {
    if (pendingNavigateId !== id) return;
    const msgId = useInboxStore.getState().pendingScrollToMessageId;
    useInboxStore.setState({ pendingNavigateId: null, pendingScrollToMessageId: null, pendingScrollToMessageTimestamp: null, pendingHighlightQuery: null });
    if (msgId) setJumpTargetId(msgId);
  }, [pendingNavigateId, id]);
  const {
    conversation,
    hasMoreAbove,
    hasMoreBelow,
    isLoadingOlder,
    isLoadingNewer,
    loadOlder,
    loadNewer,
    jumpToStart,
    jumpToEnd,
    jumpToTimestamp,
    effectiveTargetMessageId,
    isJumpingToTarget,
  } = useConversationMessages(id, jumpTargetId ?? targetMessageId, highlightQuery);

  if (!conversation) return <ConversationLoadingSkeleton />;

  return (
    <DashboardLayout>
      <ErrorBoundary name="GuestConversation" level="panel">
        <div className="h-full">
          <ConversationDiffLayout
            conversation={conversation as ConversationData}
            embedded
            hasMoreAbove={hasMoreAbove}
            hasMoreBelow={hasMoreBelow}
            isLoadingOlder={isLoadingOlder}
            isLoadingNewer={isLoadingNewer}
            onLoadOlder={loadOlder}
            onLoadNewer={loadNewer}
            onJumpToStart={jumpToStart}
            onJumpToEnd={jumpToEnd}
            onJumpToTimestamp={jumpToTimestamp}
            isOwner={false}
            guest
            showMessageInput={false}
            targetMessageId={effectiveTargetMessageId}
            isJumpingToTarget={isJumpingToTarget}
            highlightQuery={highlightQuery}
            onClearHighlight={() => {
              const url = new URL(window.location.href);
              url.searchParams.delete("highlight");
              router.replace(url.pathname + url.search);
            }}
          />
        </div>
      </ErrorBoundary>
    </DashboardLayout>
  );
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
  const router = useRouter();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const treatAsAuthed = isAuthenticated;
  const id = params.id as string;
  const highlightQuery = searchParams.get("highlight") || undefined;
  const prefill = searchParams.get(PREFILL_PARAM) || undefined;
  // A share-link visit carries its token (`?share=`, set by the /share/<token>
  // redirect). Access via a link requires PRESENTING the token — the server
  // denies id-only reads of link-shared conversations (issue #27).
  const shareToken = searchParams.get("share") || undefined;
  const [targetMessageId] = useState<string | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    const hash = window.location.hash;
    if (hash && hash.startsWith("#msg-")) {
      return hash.slice(5);
    }
    return undefined;
  });

  const resolved = useQuery(
    api.conversations.resolveConversation,
    id ? { id, ...(shareToken ? { share_token: shareToken } : {}) } : "skip"
  );
  // Cached presence is not access evidence. This public/shared route waits for
  // the server's explicit access result until it has its own offline-capable
  // view contract.
  const effective = resolved;

  if (!id) return <NotFoundView />;
  if (effective === undefined) return <ConversationLoadingSkeleton />;
  if (effective.access_level === "denied") {
    if (!isAuthLoading && !treatAsAuthed) {
      const returnTo = `/conversation/${id}${window.location.search}${window.location.hash}`;
      router.replace(`/login?return_to=${encodeURIComponent(returnTo)}`);
      return <ConversationLoadingSkeleton />;
    }
    return <DeniedView />;
  }
  if (effective.access_level === "not_found" || !effective.conversation_id) return <NotFoundView />;

  // Register the presented token under the RESOLVED id before any child
  // mounts, so every id-keyed query in the tree re-presents it.
  if (shareToken) setShareTokenScope(effective.conversation_id, shareToken);

  // Wait for auth to settle before committing to a render path: while loading,
  // resolveConversation may have answered with the anonymous identity, and we
  // don't want to flash the guest view at a signed-in owner (or vice versa).
  if (isAuthLoading) return <ConversationLoadingSkeleton />;

  // Unauthenticated visitor on a shared link: the inbox is behind AuthGuard
  // (it would bounce them to the marketing root), so render read-only in place.
  if (!treatAsAuthed) {
    return (
      <GuestConversationView
        id={effective.conversation_id}
        targetMessageId={targetMessageId}
        highlightQuery={highlightQuery}
      />
    );
  }

  // A signed-in share-link viewer redeems the token BEFORE entering the inbox:
  // the redemption row is what lets every id-keyed inbox query (which carries
  // no token) resolve them to "shared". Owner/team viewers skip it — their
  // access never depended on the token.
  if (shareToken && effective.access_level === "shared") {
    return (
      <RedeemThenRedirect
        id={effective.conversation_id}
        shareToken={shareToken}
        targetMessageId={targetMessageId}
        highlightQuery={highlightQuery}
        prefill={prefill}
      />
    );
  }

  // Every accessible session (owner, team, shared) renders through the inbox — single codepath.
  return (
    <RedirectToInbox
      id={effective.conversation_id}
      isOwn={effective.access_level === "owner"}
      targetMessageId={targetMessageId}
      highlightQuery={highlightQuery}
      prefill={prefill}
    />
  );
}

/**
 * Signed-in viewer arriving via a share link: trade the presented token for a
 * durable server-side redemption (redeemShareToken), then continue into the
 * inbox. Without the redemption the inbox's id-keyed queries — which never
 * carry the token — would all deny. The redirect waits for the mutation so the
 * inbox mounts with the grant already in place.
 */
function RedeemThenRedirect({
  id,
  shareToken,
  targetMessageId,
  highlightQuery,
  prefill,
}: {
  id: string;
  shareToken: string;
  targetMessageId?: string;
  highlightQuery?: string;
  prefill?: string;
}) {
  const redeem = useMutation(api.conversations.redeemShareToken);
  const [redeemed, setRedeemed] = useState(false);
  useMountEffect(() => {
    // Best-effort: an invalid/rotated token redeems nothing and the inbox
    // shows denied, which is the honest outcome.
    redeem({ share_token: shareToken }).catch(() => {}).finally(() => setRedeemed(true));
  });
  if (!redeemed) return <ConversationLoadingSkeleton />;
  return (
    <RedirectToInbox
      id={id}
      isOwn={false}
      targetMessageId={targetMessageId}
      highlightQuery={highlightQuery}
      prefill={prefill}
    />
  );
}
