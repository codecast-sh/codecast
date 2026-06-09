import { useState, useCallback, useRef, memo, useMemo, useDeferredValue } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { useShortcutContext } from "../../shortcuts";
import { useQuery, useMutation } from "convex/react";
import { useSearchParams } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { DashboardLayout } from "../../components/DashboardLayout";
import { KeyCap } from "../../components/KeyboardShortcutsHelp";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { ConversationDiffLayout } from "../../components/ConversationDiffLayout";
import { ConversationData } from "../../components/ConversationView";
import { shareOrigin } from "../../lib/utils";
import { useConversationMessages } from "../../hooks/useConversationMessages";
import { useInboxStore, isConvexId, sortSessions, isInterruptControlMessage, ensureHydrated } from "../../store/inboxStore";
import { SharePopover } from "../../components/SharePopover";
import { ActivityFeed } from "../../components/ActivityFeed";
import { PlanContextPanel } from "../../components/PlanContextPanel";
import { WorkflowContextPanel } from "../../components/WorkflowContextPanel";
import { toast } from "sonner";
import { animatedStashSession } from "../../store/undoActions";
import { cleanUserMessage } from "../../components/GlobalSessionPanel";

const InboxConversation = memo(function InboxConversation({ sessionId: liveSessionId, isIdle, onSendAndAdvance, onSendAndDismiss, lastUserMessage, sessionError, onBack, targetMessageId, highlightQuery, onClearHighlight }: { sessionId: string; isIdle: boolean; onSendAndAdvance: () => void; onSendAndDismiss?: () => void; lastUserMessage?: string | null; sessionError?: string; onBack?: () => void; targetMessageId?: string; highlightQuery?: string; onClearHighlight?: () => void }) {
  // Non-blocking switch: the heavy work of a session switch is mounting the new
  // conversation's message tree (every block keyed by msg._id unmounts/remounts,
  // re-parsing markdown). Defer the id the BODY renders from so a switch stays
  // interruptible — React keeps the previous conversation painted and
  // interactive while it mounts the next one at transition priority, instead of
  // freezing the main thread on one synchronous render. The parent's sidebar
  // highlight still moves instantly off the live id. Renaming the prop to
  // liveSessionId means every existing reference below reads the deferred value,
  // so the whole pane (body + banners + resume target) stays self-consistent and
  // swaps atomically when the next conversation is ready.
  const sessionId = useDeferredValue(liveSessionId);
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
  } = useConversationMessages(sessionId, targetMessageId);

  const convCommand = useInboxStore((s) => s.convCommand);
  const setPrivacy = useInboxStore((s) => s.setPrivacy);
  const setTeamVisibility = useInboxStore((s) => s.setTeamVisibility);
  const generateShareLink = useMutation(api.conversations.generateShareLink);
  const [resumeState, setResumeState] = useState<"idle" | "resuming" | "sent" | "failed">("idle");
  const forceRestartAttemptedRef = useRef(false);
  const [_trackedSessionId, _setTrackedSessionId] = useState(sessionId);
  if (_trackedSessionId !== sessionId) {
    _setTrackedSessionId(sessionId);
    setResumeState("idle");
    forceRestartAttemptedRef.current = false;
  }

  const lastMsg = conversation?.messages?.[conversation.messages.length - 1];
  const lastRoleIsUser = lastMsg?.role === "user";
  const isStale = (Date.now() - (conversation?.updated_at || 0)) > 5 * 60 * 1000;
  const looksAbandoned = isIdle && lastRoleIsUser && !isInterruptControlMessage(lastMsg?.content) && isStale;

  useWatchEffect(() => {
    if (!isIdle && (resumeState === "sent" || resumeState === "resuming")) {
      setResumeState("idle");
      forceRestartAttemptedRef.current = false;
    }
  }, [isIdle, resumeState]);

  useWatchEffect(() => {
    if (resumeState !== "sent") return;
    const timeout = setTimeout(async () => {
      if (!forceRestartAttemptedRef.current && isConvexId(sessionId)) {
        forceRestartAttemptedRef.current = true;
        try {
          await convCommand(sessionId, "restartSession");
          setResumeState("sent");
        } catch {
          setResumeState("failed");
        }
      } else {
        setResumeState("failed");
      }
    }, 45_000);
    return () => clearTimeout(timeout);
  }, [resumeState, sessionId, convCommand]);

  const handleManualResume = useCallback(() => {
    setResumeState("resuming");
    convCommand(sessionId, "resumeSession")
      .then(() => setResumeState("sent"))
      .catch(() => setResumeState("failed"));
  }, [sessionId, convCommand]);

  if (!conversation) {
    return (
      <div className="h-full flex items-center justify-center text-sol-text-dim">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <span className="text-sm">Loading conversation...</span>
        </div>
      </div>
    );
  }

  const convId = conversation._id as Id<"conversations">;
  const isOwnSession = (conversation as any).is_own !== false;
  const shareUrl = conversation.share_token
    ? `${shareOrigin()}/conversation/${convId}`
    : null;
  const shareControls = isOwnSession ? (
    <SharePopover
      isPrivate={conversation.is_private !== false}
      teamVisibility={(conversation as any).team_visibility || (conversation as any).effective_team_visibility}
      hasShareToken={!!conversation.share_token}
      hasTeam={!!(conversation as any).team_id}
      onSetPrivate={() => { setPrivacy(convId, true); toast.success("Made private"); }}
      onSetTeamVisibility={(mode) => { setTeamVisibility(convId, mode); toast.success(mode === "full" ? "Sharing full conversation with team" : "Sharing summary with team"); }}
      onGenerateShareLink={async () => { await generateShareLink({ conversation_id: convId }); return `${shareOrigin()}/conversation/${convId}`; }}
      shareUrl={shareUrl}
    />
  ) : null;

  const activePlanId = (conversation as any)?.active_plan_id;
  const workflowRunId = (conversation as any)?.workflow_run_id;

  return (
    <div className="relative h-full flex flex-col">
      {isOwnSession && (resumeState === "resuming" || resumeState === "sent") && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-sol-orange/90 text-sol-bg text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-bg animate-pulse" />
          Resuming session...
        </div>
      )}
      {isOwnSession && resumeState === "failed" && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-sol-red/90 text-sol-bg text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-bg" />
          Resume timed out
          <button onClick={handleManualResume} className="ml-1 px-1.5 py-0.5 rounded bg-sol-bg/20 hover:bg-sol-bg/30 transition-colors">
            Retry
          </button>
        </div>
      )}
      {isOwnSession && sessionError && resumeState === "idle" && (
        // Normal flow (not an absolute overlay) so it can't be clipped behind the
        // conversation header's higher-z elements; persistent so it earns its row.
        <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-sol-red/90 text-sol-bg text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-bg flex-shrink-0" />
          <span className="truncate min-w-0 flex-1" title={sessionError}>{sessionError}</span>
          <button onClick={handleManualResume} className="ml-1 px-1.5 py-0.5 rounded bg-sol-bg/20 hover:bg-sol-bg/30 transition-colors flex-shrink-0">
            Resume
          </button>
        </div>
      )}
      {isOwnSession && looksAbandoned && !sessionError && resumeState === "idle" && (
        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-sol-bg-alt/90 border-b border-sol-border/50 text-sol-text-dim text-xs backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/50" />
          Session unresponsive — send a message or
          <button onClick={handleManualResume} className="px-1.5 py-0.5 rounded bg-sol-cyan/10 hover:bg-sol-cyan/20 border border-sol-cyan/30 text-sol-cyan transition-colors">
            Resume
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ConversationDiffLayout
          conversation={conversation as ConversationData}
          embedded
          headerExtra={shareControls}
          hasMoreAbove={hasMoreAbove}
          hasMoreBelow={hasMoreBelow}
          isLoadingOlder={isLoadingOlder}
          isLoadingNewer={isLoadingNewer}
          onLoadOlder={loadOlder}
          onLoadNewer={loadNewer}
          onJumpToStart={jumpToStart}
          onJumpToEnd={jumpToEnd}
          onJumpToTimestamp={jumpToTimestamp}
          isOwner={isOwnSession}
          onSendAndAdvance={isOwnSession ? onSendAndAdvance : undefined}
          onSendAndDismiss={isOwnSession ? onSendAndDismiss : undefined}
          autoFocusInput
          backHref="/inbox"
          onBack={onBack}
          targetMessageId={effectiveTargetMessageId}
          highlightQuery={highlightQuery}
          onClearHighlight={onClearHighlight}
          fallbackStickyContent={isOwnSession ? cleanUserMessage(lastUserMessage) : undefined}
          subHeaderContent={<>
            {activePlanId && <PlanContextPanel planId={activePlanId} />}
            {workflowRunId && <WorkflowContextPanel workflowRunId={workflowRunId} />}
          </>}
        />
      </div>
    </div>
  );
});

// SessionCard moved to GlobalSessionPanel.tsx as part of the shared SessionListPanel

function InboxShortcuts() {
  useShortcutContext('inbox');
  return null;
}

export function QueuePageClient() {
  const searchParams = useSearchParams();

  // Auto-open session panel when entering inbox (DashboardLayout renders it)
  useMountEffect(() => {
    const store = useInboxStore.getState();
    if (!store.sidePanelOpen && !store.sidePanelUserClosed) {
      store.toggleSidePanel();
    }
  });


  const sessions = useInboxStore((s) => s.sessions);
  const clientStateInitialized = useInboxStore((s) => s.clientStateInitialized);
  const currentSessionId = useInboxStore((s) => s.currentSessionId);
  const advanceToNext = useInboxStore((s) => s.advanceToNext);
  const setCurrentSession = useInboxStore((s) => s.setCurrentSession);
  const navigateToSession = useInboxStore((s) => s.navigateToSession);
  const viewingDismissedId = useInboxStore((s) => s.viewingDismissedId);
  const setViewingDismissedId = useInboxStore((s) => s.setViewingDismissedId);
  const touchMru = useInboxStore((s) => s.touchMru);
  const showMySessions = useInboxStore((s) => s.showMySessions);
  const setShowMySessions = useInboxStore((s) => s.setShowMySessions);
  const sortedSessions = useMemo(() => sortSessions(sessions), [sessions]);

  // inbox_shortcuts_hidden is mirrored to localStorage (see CRITICAL_UI_KEYS in
  // inboxStore.ts), so it's seeded synchronously and correct on first paint.
  const shortcutsHidden = useInboxStore(s => s.clientState.ui?.inbox_shortcuts_hidden ?? false);
  const showShortcuts = !shortcutsHidden;



  const isPopstateRef = useRef(false);
  const lastAppliedParamId = useRef<string | null>(null);
  const paramProcessedRef = useRef(!searchParams.get("s"));

  const injectSession = useInboxStore((s) => s.injectSession);

  // ID we're trying to navigate to that isn't yet in the queue
  const [pendingInjectId, setPendingInjectId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ sessionId: string; messageId: string } | null>(null);
  const [activeHighlight, setActiveHighlight] = useState<string | undefined>(undefined);

  const shouldQueryDirect = pendingInjectId && isConvexId(pendingInjectId);

  // Query conversation for sessions not in the queue
  const directConv = useQuery(
    api.conversations.getConversation,
    shouldQueryDirect ? { conversation_id: pendingInjectId as Id<"conversations">, limit: 1 } : "skip"
  );

  // Select session from URL param -- only when the param actually changes
  const paramSessionId = searchParams.get("s") || null;
  useWatchEffect(() => {
    if (!paramSessionId || paramSessionId === lastAppliedParamId.current) return;
    if (Object.keys(sessions).length === 0 && !clientStateInitialized) return;
    lastAppliedParamId.current = paramSessionId;
    // Consume any pending highlight/scroll from the store (set by ConversationPageClient redirect)
    const store = useInboxStore.getState();
    if (store.pendingHighlightQuery) {
      setActiveHighlight(store.pendingHighlightQuery);
      useInboxStore.setState({ pendingHighlightQuery: null });
    }
    if (store.pendingScrollToMessageId) {
      setScrollTarget({ sessionId: paramSessionId, messageId: store.pendingScrollToMessageId });
      useInboxStore.setState({ pendingScrollToMessageId: null });
    }
    if (sessions[paramSessionId]) {
      navigateToSession(paramSessionId);
      setPendingInjectId(null);
      paramProcessedRef.current = true;
    } else {
      setPendingInjectId(paramSessionId);
    }
  }, [paramSessionId, sessions, navigateToSession, clientStateInitialized]);

  // Once we have the conversation data, inject it into the queue
  useWatchEffect(() => {
    if (!pendingInjectId) return;
    if (sessions[pendingInjectId]) {
      navigateToSession(pendingInjectId);
      setPendingInjectId(null);
      paramProcessedRef.current = true;
      return;
    }
    // Invalid ID format -- query was skipped, just clear pending state
    if (!isConvexId(pendingInjectId)) {
      setPendingInjectId(null);
      paramProcessedRef.current = true;
      return;
    }
    // directConv: undefined = still loading, null = not found/no access
    if (directConv === undefined) return;
    if (directConv === null) {
      setPendingInjectId(null);
      paramProcessedRef.current = true;
      return;
    }
    injectSession({
      _id: pendingInjectId,
      session_id: directConv.session_id || pendingInjectId,
      title: directConv.title,
      updated_at: directConv.updated_at,
      project_path: directConv.project_path,
      git_root: directConv.git_root,
      agent_type: directConv.agent_type || "claude_code",
      message_count: directConv.message_count || 0,
      is_idle: true,
      has_pending: false,
      forked_from: directConv.forked_from || null,
      parent_message_uuid: directConv.parent_message_uuid || null,
      // Carry the author so a deep-linked teammate session shows whose it is.
      user_id: directConv.user_id,
      author_name: directConv.user?.name ?? null,
    });
    setPendingInjectId(null);
    paramProcessedRef.current = true;
  }, [pendingInjectId, directConv, sessions, navigateToSession, injectSession]);

  // Handle store-based navigation (from CommandPalette, bookmarks, etc.)
  const pendingNavigateId = useInboxStore((s) => s.pendingNavigateId);
  const pendingScrollToMessageId = useInboxStore((s) => s.pendingScrollToMessageId);
  const pendingHighlightQuery = useInboxStore((s) => s.pendingHighlightQuery);
  useWatchEffect(() => {
    if (!pendingNavigateId) return;
    const scrollTarget = pendingScrollToMessageId;
    const highlight = pendingHighlightQuery;
    useInboxStore.setState({ pendingNavigateId: null, pendingScrollToMessageId: null, pendingHighlightQuery: null, showMySessions: false });
    if (highlight) setActiveHighlight(highlight);
    if (scrollTarget) {
      setScrollTarget({ sessionId: pendingNavigateId, messageId: scrollTarget });
    }
    if (sessions[pendingNavigateId]) {
      setPendingInjectId(null);
      navigateToSession(pendingNavigateId);
    } else {
      setPendingInjectId(pendingNavigateId);
    }
  }, [pendingNavigateId, pendingScrollToMessageId, sessions, navigateToSession]);

  // Consume pendingScrollToMessageId / pendingHighlightQuery on cache-hit navigation:
  // navigateToSession sets currentSessionId (or viewingDismissedId for a dismissed
  // target) directly when sessions[id] is in store, bypassing pendingNavigateId, so the
  // watcher above never fires for deep-links to already-cached sessions.
  //
  // Bail while a pendingNavigateId navigation is in flight: that scroll target belongs
  // to the *incoming* conversation, and the watcher above owns pairing it. Consuming it
  // here would pin it to the stale currentSessionId (the conversation we're leaving).
  // Use viewingDismissedId as the view target so bookmarks into dismissed conversations
  // scroll to the right message instead of keying off the previous session.
  useWatchEffect(() => {
    if (pendingNavigateId) return;
    const viewSessionId = viewingDismissedId ?? currentSessionId;
    if (!viewSessionId) return;
    if (!pendingScrollToMessageId && !pendingHighlightQuery) return;
    const scrollTarget = pendingScrollToMessageId;
    const highlight = pendingHighlightQuery;
    useInboxStore.setState({ pendingScrollToMessageId: null, pendingHighlightQuery: null });
    if (highlight) setActiveHighlight(highlight);
    if (scrollTarget) {
      setScrollTarget({ sessionId: viewSessionId, messageId: scrollTarget });
    }
  }, [currentSessionId, viewingDismissedId, pendingNavigateId, pendingScrollToMessageId, pendingHighlightQuery]);

  const prevSessionRef = useRef(currentSessionId);
  prevSessionRef.current = currentSessionId;

  // One-shot deep-link scroll target. A bookmark/link/search jump sets
  // `scrollTarget`, which drives `targetMessageId` (load the window AROUND that
  // message + scroll to it once). We keep it for the WHOLE visit so target mode
  // stays stable — clearing it mid-visit would flip useConversationMessages back
  // to normal mode and swap the message window out from under the user. Instead
  // we drop it only once we've navigated AWAY from the targeted session, so
  // returning later opens at the live tail instead of re-jumping to the message.
  const scrollTargetArrivedRef = useRef(false);
  useWatchEffect(() => {
    if (!scrollTarget) { scrollTargetArrivedRef.current = false; return; }
    const viewSessionId = viewingDismissedId ?? currentSessionId;
    if (viewSessionId === scrollTarget.sessionId) {
      scrollTargetArrivedRef.current = true;
    } else if (scrollTargetArrivedRef.current && viewSessionId) {
      setScrollTarget(null);
      scrollTargetArrivedRef.current = false;
    }
  }, [currentSessionId, viewingDismissedId, scrollTarget]);

  const handleSendAndAdvance = useCallback(() => {
    advanceToNext();
  }, [advanceToNext]);

  const handleSendAndDismiss = useCallback(() => {
    if (currentSessionId) animatedStashSession(currentSessionId);
  }, [currentSessionId]);

  const viewingDismissedSession = viewingDismissedId
    ? sessions[viewingDismissedId] ?? null
    : null;

  const setCurrentConversation = useInboxStore((s) => s.setCurrentConversation);

  const rawCurrentSession = currentSessionId ? sessions[currentSessionId] : undefined;
  const currentSession = pendingInjectId && rawCurrentSession && rawCurrentSession._id !== pendingInjectId
    ? undefined
    : rawCurrentSession;

  useWatchEffect(() => {
    if (currentSession) {
      setCurrentConversation({
        conversationId: currentSession._id,
        projectPath: currentSession.project_path,
        gitRoot: currentSession.git_root,
        agentType: currentSession.agent_type,
        source: "inbox",
      });
      touchMru(currentSession._id);
    }
  }, [currentSession?._id, currentSession?.project_path, currentSession?.git_root, currentSession?.agent_type, setCurrentConversation, touchMru]);

  useWatchEffect(() => {
    if (currentSessionId || currentSession || showMySessions || viewingDismissedId || pendingInjectId) return;
    if (sortedSessions.length > 0) setCurrentSession(sortedSessions[0]._id);
  }, [currentSessionId, currentSession, showMySessions, viewingDismissedId, pendingInjectId, sortedSessions, setCurrentSession]);

  // Sync URL when current session changes (but not before initial param is resolved)
  useWatchEffect(() => {
    if (!paramProcessedRef.current) return;
    if (isPopstateRef.current) {
      isPopstateRef.current = false;
      return;
    }
    const targetId = viewingDismissedId
      ? undefined
      : useInboxStore.getState().getCurrentSession()?._id;
    if (!targetId) return;
    const targetPath = `/conversation/${targetId}`;
    if (window.location.pathname !== targetPath) {
      // Switching from one session to another (URL already points at a session) is a
      // real navigation — push so browser back/forward cycles through viewed sessions.
      // The first resolution from the bare inbox (or a deep-link param) only
      // canonicalizes the URL, so replace it to avoid a dead bare-inbox entry that
      // would just auto-select again on back.
      const switchingSessions = window.location.pathname.startsWith("/conversation/");
      window.history[switchingSessions ? "pushState" : "replaceState"]({ inboxId: targetId }, "", targetPath);
    }
  }, [currentSession?._id, viewingDismissedId]);

  // Handle browser back/forward
  useEventListener("popstate", (e: PopStateEvent) => {
    const url = new URL(window.location.href);
    const id = e.state?.inboxId
      || url.searchParams.get("s")
      || url.pathname.match(/^\/conversation\/([a-z0-9]{32})$/)?.[1];
    if (!id) return;
    if (sessions[id]) {
      isPopstateRef.current = true;
      navigateToSession(id);
      if (showMySessions) setShowMySessions(false);
    }
  });


  // Warm IDB cache for visible sessions — no hooks, no components
  const seen = new Set<string>();
  if (currentSession) seen.add(currentSession._id);
  for (const s of sortedSessions) {
    if (!seen.has(s._id)) {
      seen.add(s._id);
      ensureHydrated(s._id);
    }
  }

  const handleClearHighlight = useCallback(() => {
    setActiveHighlight(undefined);
    // Also clean URL param if present
    const url = new URL(window.location.href);
    if (url.searchParams.has("highlight")) {
      url.searchParams.delete("highlight");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
  }, []);

  const handleNavigateToConversation = useCallback((conversationId: string) => {
    navigateToSession(conversationId);
    if (showMySessions) setShowMySessions(false);
  }, [navigateToSession, showMySessions, setShowMySessions]);

  const handleBack = useCallback(() => {
    setShowMySessions(true);
  }, [setShowMySessions]);

  const inboxContent = (
    <>
      {showMySessions ? (
        <div className="h-full overflow-y-auto" data-main-scroll>
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-8">
            <ErrorBoundary name="ActivityFeed" level="inline">
              <ActivityFeed mode="personal" compact onNavigate={handleNavigateToConversation} />
            </ErrorBoundary>
          </div>
        </div>
      ) : viewingDismissedSession ? (
        <ErrorBoundary name="Conversation" level="inline">
          <InboxConversation
            sessionId={viewingDismissedSession._id}
            isIdle={viewingDismissedSession.is_idle}
            onSendAndAdvance={() => setViewingDismissedId(null)}
            lastUserMessage={viewingDismissedSession.last_user_message}
            sessionError={viewingDismissedSession.session_error}
            onBack={handleBack}
            targetMessageId={scrollTarget?.sessionId === viewingDismissedSession._id ? scrollTarget.messageId : undefined}
            highlightQuery={activeHighlight}
            onClearHighlight={handleClearHighlight}          />
        </ErrorBoundary>
      ) : currentSession ? (
        <ErrorBoundary name="Conversation" level="inline">
          <InboxConversation
            sessionId={currentSession._id}
            isIdle={currentSession.is_idle}
            onSendAndAdvance={handleSendAndAdvance}
            onSendAndDismiss={handleSendAndDismiss}
            lastUserMessage={currentSession.last_user_message}
            sessionError={currentSession.session_error}
            onBack={handleBack}
            targetMessageId={scrollTarget?.sessionId === currentSession._id ? scrollTarget.messageId : undefined}
            highlightQuery={activeHighlight}
            onClearHighlight={handleClearHighlight}          />
        </ErrorBoundary>
      ) : pendingInjectId ? (
        <div className="h-full flex items-center justify-center text-sol-text-dim">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-sm">Loading session...</span>
          </div>
        </div>
      ) : sortedSessions.length > 0 ? (
        <div className="h-full" />
      ) : (
        <div className="h-full overflow-y-auto" data-main-scroll>
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 pb-8">
            <ErrorBoundary name="ActivityFeed" level="inline">
              <ActivityFeed mode="personal" compact onNavigate={handleNavigateToConversation} />
            </ErrorBoundary>
          </div>
        </div>
      )}
    </>
  );

  return (
    <DashboardLayout>
      <InboxShortcuts />
      <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0">{inboxContent}</div>
      {showShortcuts && (
        <div className="flex-shrink-0 px-3 py-1 border-t border-sol-border/30 bg-sol-bg-alt/30 flex items-center gap-3 text-[10px] text-sol-text-dim">
          <span className="flex items-center gap-1">
            <span className="flex items-center gap-[2px]"><KeyCap size="xs">{"\u2303"}</KeyCap><KeyCap size="xs">J</KeyCap><span className="text-sol-text-dim/40">/</span><KeyCap size="xs">K</KeyCap></span> nav
          </span>
          <span className="flex items-center gap-1">
            <span className="flex items-center gap-[2px]"><KeyCap size="xs">{"\u2303"}</KeyCap><KeyCap size="xs">I</KeyCap></span> idle
          </span>
          <span className="flex items-center gap-1">
            <span className="flex items-center gap-[2px]"><KeyCap size="xs">{"\u2303"}</KeyCap><KeyCap size="xs">{"\u232b"}</KeyCap></span> dismiss
          </span>
          <button onClick={() => useInboxStore.getState().toggleShortcutsPanel()} className="ml-auto flex items-center gap-1 hover:text-sol-text-muted transition-colors">
            <KeyCap size="xs">?</KeyCap> all shortcuts
          </button>
        </div>
      )}
      </div>
    </DashboardLayout>
  );
}
