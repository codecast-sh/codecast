import { HandoffLinkChip, HandoffSessionLink, SessionHandoffCard, SessionHandoffNotice } from "./conversation/SessionHandoff";
import { sessionRepository } from "../lib/repoNavigation";
import { repoTreeHref, repoCommitsHref } from "../lib/repoView";
import { madeInTranscript, transcriptGitOutcomes } from "../lib/gitToolOutcome";
import { useConversationCommits, useConversationPullRequests, useSyncConversationCommits, useSyncConversationPullRequests } from "../hooks/useSyncTimeline";
import { BranchCodeLink } from "./repo/RepositoryLinks";
import { captureException } from "@sentry/react";
import { RefreshCw as PaletteRestart, Copy as PaletteCopy, Search as PaletteSearch, Eye as PaletteEye, Pin as PalettePin, GitBranch as PaletteBranch, Rows3 as PaletteRows } from "lucide-react";
import { usePaletteSessionCommands } from "../lib/paletteSessionCommands";
import Link from "next/link";
import { dragCarriesPane } from "../lib/stage";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef, useState, useMemo, useImperativeHandle, forwardRef, useCallback, memo, useContext, Fragment, lazy, Suspense, type ForwardedRef } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useEventListener } from "../hooks/useEventListener";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useTeamRosterIdentity } from "../hooks/useTeamRoster";
import { useShortcutContext, useShortcutAction, isMac, hasOpenModal } from "../shortcuts";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useShallow } from "zustand/react/shallow";
import { useStorageImageUrls } from "../hooks/useStorageImageUrl";
import { extractSessionImages, mergeSessionImages, type SessionImageEntry } from "../lib/sessionImages";
import { isRemoteImageSrc } from "../lib/trustedImageOrigins";
import { shareTokenArg } from "../lib/shareTokenScope";
import { BrowserPaneOfferChip } from "./browser/BrowserPaneOfferChip";
import { BrowserSessionContext } from "../hooks/useBrowserTabActions";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { isCommandMessage, cleanContent, cleanTitle, extractFilePaths, isHiddenSystemNotice, isContextOnlyUserMessage, initialSubagentPromptId } from "../lib/conversationProcessor";
import { agentSupportsFork, agentForksFromAnyMessage, isModelSwitchStdout, isForkSeedClientId } from "@codecast/shared/contracts";
import { GROUP_WINDOW_MS } from "@codecast/shared/chat";
import { useNowWhen } from "../hooks/useCoarseNow";
import { isAskTool } from "@codecast/shared/render";
import { resolveSessionSkills } from "../lib/sessionSkills";
import { latestUsageOf } from "../lib/messageReducer";
import { UsageDisplay } from "./UsageDisplay";
import { StableContextCards } from "./StableContextCards";
import { ErrorBoundary } from "./ErrorBoundary";
import { cssZoomOf } from "../lib/cssZoom";
import { RevealAncestryCtx, RevealInBandCtx, useHostsReveal, useRevealAncestryWith } from "../lib/revealHost";
import { MenuKeyCaps, ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { animatedHideSession } from "../store/undoActions";
import { toast } from "sonner";
import { isJumpReadyToScroll, shouldFollowStreaming, shouldLoadOlder, shouldLoadNewer, shouldAdjustScrollForResize, jumpRowForMessage, initialScrollEdge } from "./conversationScroll";
import { deriveRunningPhrase, shouldShowIdleGap, workingSinceForClock, isProducingAgentStatus } from "./workingStatus";
import { quoteToComposer, submitReview } from "../lib/reviewActions";
import { quoteSelectionIntoReply } from "../lib/quoteSelection";
import { enterReviewNearCenter } from "../lib/reviewNav";
import { SelectionQuoteToolbar } from "./SelectionQuoteToolbar";
import { ReviewComposerContext } from "./reviewContext";
import { ReviewScrollIndicators } from "./ReviewNavigation";
import { useReviewNavigation } from "../hooks/useReviewNavigation";
import { useConversationCommentsSync } from "../hooks/useConversationComments";
import { useSyncConversationExternalEvents, useExternalEvents, externalEventsOldestFirst } from "../hooks/useSyncExternalEvents";
import { ExternalEventRow } from "./feed/ExternalEventRow";
import { externalEventRowToExternalEvent, isQuietExternalEvent, type ExternalEventRecord } from "../lib/externalEvents";
import { RoleWakeBlock } from "./RoleWakeBlock";
import { sentToRef } from "./roleWake";
import { extractFileChanges } from "../lib/fileChangeExtractor";
import { CommitCard } from "./CommitCard";
import { PRCard } from "./PRCard";
import { AnchorHeaderPill } from "./anchor/AnchorHeaderPill";
import { useSqueezeToFit } from "../hooks/useSqueezeToFit";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "./ui/dropdown-menu";
import { TooltipProvider } from "./ui/tooltip";
import { useMutation, useQuery, useConvex } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ConversationAssignmentBadge } from "./AssignmentBadge";
import { AssignedToYouBanner, useOwnersFromStore, type HandoffInfo } from "./OwnersBadge";
import { TmuxAttachPill } from "./TmuxAttachPill";
import { useAttachCopy } from "../hooks/useAttachCopy";
import { SessionDaemonChip } from "./DaemonStatusChip";
import { BrowserWatchSplit } from "./browser/BrowserWatchSplit";
import { PermissionStack, PERMISSION_SKIP_TOOLS } from "./PermissionCard";
import { SessionDecisionCard } from "./SessionDecisionCard";
import { DecisionStepperContext, usePendingDecisionItem } from "../hooks/useDecisionQueue";
import { copyToClipboard, shareOrigin, inferHomeDir } from "../lib/utils";
import { useWorkflowRun, useWorkflows } from "../hooks/useSyncWorkflows";
import { usePendingMessageStatus, usePendingPermissions } from "../hooks/useSyncPendingPermissions";
import { useAckActiveConversation } from "../hooks/useAckActiveConversation";
import type { SentFileData } from "./tools/SentFileBlock";
import { dropScrapedProseTwins } from "../lib/proseTwins";
import { MessagePromptPreview } from "./MessagePromptPreview";
import { ImageGalleryProvider, GalleryMessageScope, type GalleryImage } from "./ImageGallery";
import { PlanBadge, TaskBadge } from "./PlanTaskHoverCard";
import { EntityIdPill } from "./EntityIdPill";
import { ThreadStatePanel } from "./ThreadStatePanel";
import { HighlightContext } from "./HighlightContext";
import { instancesFromMatches, planActivation, skipDeadHit, stepIndex, walkSearchPages, type MatchInstance, type PendingHit } from "../lib/conversationSearch";
import { FilePathContext } from "../lib/filePathLinks";
import { WorktreesProvider } from "./worktree/WorktreesContext";
import { SessionWorktreePills } from "./worktree/WorktreePill";
import { isStickyEligible, pickStickyFallbackFromLoaded, stickyPromptContent, mergeNavigatorSources, buildNavigatorRows, resolveStickyPrompt, resolveNavigatorCurrentId, topVisibleIndexFromRects } from "../lib/messageNavigator";
import { isToolResultCarrier, foldNudgeRuns, nudgeLabel, type NudgeRow, type ChatWakePrompt } from "./sessionMessage";
import { CollabRequestBanner, OwnerComposerPresence } from "./CollabComposer";
import { composerPresenceEnabled } from "../lib/composerPresence";
import { ConversationViewers } from "./presence/ViewerFaces";
import { anchorFromRects } from "../lib/follow";
import { normalizeCastCategory, buildBrowserRowMap, sameBrowserRowMap, type BrowserRowInput, type BrowserRowState } from "./castCommand";
import { useInboxStore, isConvexId, computeNewDividerIndex, convBucketMap, type BucketItem, type ForkChild, type InboxSession, resolveSimpleView } from "../store/inboxStore";
import { DispatchNotWiredError, isParkedDispatchError } from "../store/mutativeMiddleware";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { useForkNavigationStore } from "../store/forkNavigationStore";
import { buildCompositeTimeline, mergeTimelineMessages } from "../lib/compositeTimeline";
import { useMessageSelection } from "../hooks/useMessageSelection";
import { ForkMapBox, ForkMapFallback } from "./ForkTreePanel";
import { setupDesktopDrag, desktopHeaderClass } from "../lib/desktop";
import { useTitlebarHead } from "../hooks/useTitlebarHead";
import { MessageNavButton } from "./MessageBrowserPopover";
import type { MentionItem } from "./editor/MentionList";
import { Maximize2, CornerDownRight, Split, Workflow, Loader2, Bot, Forward, ArrowRightLeft, Cpu, FolderTree } from "lucide-react";
import { filesHref } from "../lib/vault/vaultHref";
import { openFiles } from "../lib/filesPane";
import { openForwardToChat } from "../lib/forwardToChat";
import { useCallsAvailable, useTeamFeature } from "../lib/teamFeatures";
import { CursorPopover, useContextMenu } from "./ui/context-menu";
import { IdentityFace } from "./identity";
import { CharacterPicker } from "./identity/CharacterPicker";
import { identityRowOf, type IdentityRow } from "../lib/sessionIdentity";
import { buildMentionItems } from "../hooks/useMentionQuery";
import { isActiveAgentStatus, serverPendingBubbleVisible, type LiveAgentStatus } from "../lib/pendingBanner";
import { sessionStartupState, SESSION_STARTING_GRACE_MS } from "../lib/sessionLifecycle";
import { messageRowKey, uniqueRowKeys } from "../lib/messageRowKey";
import { messageAgentTypes, sameMessageAuthor } from "../lib/messageAuthors";
import { useSessionRestart, ghostRestartContextFor } from "../hooks/useSessionRestart";
import { devRenderCount, devCountElements } from "../lib/devRenderCount";
import { MessageInput } from "./MessageInput";
import { PlanBlock } from "./conversation/blocks/planBlock";
import { CastBrowserRowContext, ChatWakeContext } from "../lib/conversationBlockContexts";
import { UserIcon } from "./conversation/blocks/shared";
import { agentColorMap } from "../lib/conversationBlockStyles";
import { AgentSwitchDivider, BashCommandBlock, ChatWakeBlock, CommandMessageBlock, CompactionSummaryBlock, EscalationDivider, HuddleSummaryBlock, InterruptStatusLine, MachineMoveDivider, NudgeLine, ScheduledTaskBlock, SessionMessageBlock, SkillExpansionBlock, SystemBlock, TaskNotificationLine, TeammateEventsBlock, WorkflowEventBlock } from "./conversation/blocks/systemBlocks";
import { AssistantBlock, CompactCollapsedTurn, CompactTurnCard, ForkSeedMark, GitDiffPanel, StoryTimelineView, ThreadSummaryView, UserPrompt } from "./conversation/blocks/turnBlocks";
import { COMPACT_TAIL_HEIGHT, EMPTY_CHILD_CONVERSATIONS, EMPTY_RECEIPT_ENTRIES } from "../lib/conversationTurnDefaults";
import { FOLD_KEPT_USER_KINDS, canAnchorForkChips, classifyUserMessage, cleanStickyContent, extractCompactionSummaryContent, isAlwaysVisibleToolCall, isHiddenStubMessage, isStickyWorthy, isToolReceiptRow, normalizePendingContent, parseCastCommand, parseWorkflowEventContent, sameStringArray, stripSystemTags } from "./conversation/classify";
import { formatMessagePartsForCopy, formatRelativeTime } from "../lib/conversationFormat";
import { ConversationMetadata, ConversationTaskProgress, ConversationTaskStatsMenuItem, DensityMenuOptions, DeviceMoveStatusStrip, EdgeMessagesIndicator, HandoffMarker, MessagesUnavailableState, RestartStatusStrip, SessionGalleryButton, SqueezedHeaderActions, TimelineRule } from "./conversation/sessionChrome";
import { DENSITY_BY_CONVERSATION, DENSITY_OPTIONS, FEED_DENSITY_CYCLE, defaultDensity } from "../lib/conversationDensity";
import { followRestoredConversation } from "../lib/followRestoredConversation";
import { NewSessionView, NonOwnerMessageInput, ProjectSwitcher } from "./conversation/sessionControls";
import type { Commit, CondensedReceipt, ConversationDensity, ConversationViewHandle, ConversationViewProps, ImageData, Message, MessageFeedDensity, PullRequest, ReceiptEntry, TaskRecord, TimelineItem, ToolCallChangeSelection, ToolResult, UserMessageKind } from "./conversation/types";
import { useConversationFileDrop } from "../hooks/useConversationFileDrop";
import { useWorkflowLaunch } from "../hooks/useWorkflowLaunch";
import { usePermissionModeSwitch } from "../hooks/usePermissionModeSwitch";
import { useForkActions } from "../hooks/useForkActions";
import { useTimelineTurns } from "../hooks/useTimelineTurns";
import { useSessionMentions } from "../hooks/useSessionMentions";
import { useNavigatorIndex } from "../hooks/useNavigatorIndex";
import { useToolResultMaps } from "../hooks/useToolResultMaps";
import { useBrowserAndWakeRows } from "../hooks/useBrowserAndWakeRows";
import { useSessionImages } from "../hooks/useSessionImages";
import { useConversationTaskMaps } from "../hooks/useConversationTaskMaps";
const api = _typedApi as any;

const CommentDock = lazy(() => import("./comments/CommentDock").then((m) => ({ default: m.CommentDock })));
const ConversationTerminalSplit = lazy(() => import("./terminal/ConversationTerminal").then((m) => ({ default: m.ConversationTerminalSplit })));
const SessionHuddleButton = lazy(() => import("./calls/OccupancyChip").then((m) => ({ default: m.SessionHuddleButton })));

const EMPTY_PENDING: any[] = [];
const EMPTY_MESSAGES: any[] = [];
const EMPTY_ID_SET: ReadonlySet<string> = new Set();
const EMPTY_MATCH_INSTANCES: MatchInstance[] = [];

/** Search marks for one message inside its virtualizer row. Scoped to the
 *  message's own block when it has one; a message folded into another row
 *  (condensed density) has none, so the whole row is the scope. */
function searchMarksIn(rowEl: Element | null, messageId: string): HTMLElement[] {
  if (!rowEl) return [];
  const scope = rowEl.querySelector(`#msg-${CSS.escape(messageId)}`) ?? rowEl;
  return Array.from(scope.querySelectorAll<HTMLElement>('mark[data-search-highlight]'));
}

/** Exactly one mark in the feed carries the active look (globals.css). */
function markActive(container: Element, target: HTMLElement) {
  container.querySelectorAll('mark[data-search-active]').forEach((m) => { if (m !== target) m.removeAttribute('data-search-active'); });
  target.setAttribute('data-search-active', 'true');
}

// Skips a Convex query for the first paint after the keyed value (e.g. conversation id)
// changes, then enables it on the next macrotask. Lets the message list paint before the
// non-critical query cascade fires.
function useDeferUntilSettled(key: string | null | undefined): boolean {
  const [enabledKey, setEnabledKey] = useState<string | null | undefined>(key);
  useWatchEffect(() => {
    if (!key || enabledKey === key) return;
    const id = setTimeout(() => setEnabledKey(key), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return enabledKey === key;
}

// Persistent measured-height cache for the message virtualizer, keyed by the
// stable per-item key (message _id) + collapse mode. It SURVIVES unmount, so
// switching back to a conversation — or a row the virtualizer recycled while
// scrolling — feeds estimateSize an accurate height instead of the flat ~200px
// guess. That guess was the root of a cold switch's cost: every text row
// estimated at 200, then corrected to its real height on measure, cascading
// into ~120ms of @tanstack/react-virtual layout work (the dominant script in
// the post-deferral switch trace). FIFO-capped so a long-lived tab stays bounded.
const VIRT_HEIGHT_CACHE = new Map<string, number>();
const VIRT_HEIGHT_CACHE_MAX = 8000;

// cssZoomOf (lib/cssZoom): rect-derived lengths are screen px under the in-app
// zoom and must be divided by it before mixing with the virtualizer's layout
// px. Feeding raw rect heights into resizeItem at 50% zoom halved every
// believed row height, overlapping all rows into settled garble.
function virtHeightKey(itemKey: string | number, densityKey: string): string {
  return `${itemKey}|${densityKey}`;
}

function recordVirtHeight(key: string, size: number) {
  if (size <= 0) return; // 0-height rows are already exact via the heuristic; don't cache
  if (VIRT_HEIGHT_CACHE.size >= VIRT_HEIGHT_CACHE_MAX && !VIRT_HEIGHT_CACHE.has(key)) {
    const oldest = VIRT_HEIGHT_CACHE.keys().next().value;
    if (oldest !== undefined) VIRT_HEIGHT_CACHE.delete(oldest);
  }
  VIRT_HEIGHT_CACHE.set(key, size);
}

// Scroll a virtualized timeline item to a fixed offset from the container top,
// settling across re-measures: items above the target report estimated heights
// until they actually render, so a single scrollToIndex lands off-target. The
// retry loop first waits for the item's element to mount, nudges scrollTop
// each frame until the offset holds, then keeps watching for `watchMs` —
// freshly mounted markdown/images above re-measure for a couple of seconds
// after the first convergence and would otherwise drag the target away.
// `onSettled` fires once at the first convergence. The watch aborts the moment
// the user scrolls, and starting a new settle cancels the previous one.
let cancelActiveItemSettle: (() => void) | null = null;
function settleTimelineItemAtOffset(
  container: HTMLElement,
  virtualizer: { scrollToIndex: (index: number, opts: { align: "start" }) => void },
  itemIndex: number,
  offsetPx: number,
  opts?: {
    initialDelayMs?: number;
    watchMs?: number;
    onSettled?: () => void;
    // Identity of the target row (its data-vkey — the stable message key).
    // The index is a snapshot of ONE timeline: a same-session jump starts on
    // the tail timeline, then the target-mode window replaces it and every
    // index shifts, so an index-only settle pins whatever row inherited the
    // number (measured: every decision-card jump landed the same six rows
    // late). The key survives the swap; resolveIndex re-derives the index on
    // the CURRENT timeline for the scrollToIndex that brings the row into
    // the render window.
    itemKey?: string;
    resolveIndex?: () => number;
  },
) {
  cancelActiveItemSettle?.();
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    container.removeEventListener("wheel", cancel);
    container.removeEventListener("touchstart", cancel);
    if (cancelActiveItemSettle === cancel) cancelActiveItemSettle = null;
  };
  cancelActiveItemSettle = cancel;
  container.addEventListener("wheel", cancel, { passive: true });
  container.addEventListener("touchstart", cancel, { passive: true });

  const currentIndex = () => {
    const i = opts?.resolveIndex ? opts.resolveIndex() : itemIndex;
    return i >= 0 ? i : itemIndex;
  };
  const findEl = (idx: number) => {
    if (opts?.itemKey) {
      // With an identity, the index lookup is only a fallback — an index hit
      // that isn't the keyed row is exactly the wrong-row pin this guards
      // against, so verify before trusting it.
      const byKey = container.querySelector(`[data-vkey="${CSS.escape(opts.itemKey)}"]`);
      if (byKey) return byKey;
      const byIndex = container.querySelector(`[data-index="${idx}"]`);
      return byIndex?.getAttribute("data-vkey") === opts.itemKey ? byIndex : null;
    }
    return container.querySelector(`[data-index="${idx}"]`);
  };
  virtualizer.scrollToIndex(currentIndex(), { align: "start" });
  const scrollElToOffset = (el: Element) => {
    const elRect = el.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    // Rect deltas are screen px; scrollTop is layout px — divide by CSS zoom.
    container.scrollTop += (elRect.top - containerRect.top) / cssZoomOf(container) - offsetPx;
  };
  const watchMs = opts?.watchMs ?? 2500;
  const start = performance.now();
  let findAttempts = 0;
  let settledFired = false;
  const attempt = () => {
    if (cancelled) return;
    findAttempts++;
    const idx = currentIndex();
    const el = findEl(idx);
    if (el) {
      scrollElToOffset(el);
      // Pin the DOM node, not the index: rows are keyed by stable message key,
      // so the node survives re-renders, while data-index shifts whenever the
      // loaded window grows (target mode pages in above the anchor).
      let settleCount = 0;
      const settle = () => {
        if (cancelled) return;
        settleCount++;
        if (!el.isConnected) {
          // The row unmounted (a window swap re-rendered the list). The jump
          // isn't done — re-find the row by identity while time remains.
          if (performance.now() - start < watchMs && findAttempts < 20) setTimeout(attempt, 100);
          else cancel();
          return;
        }
        const rect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const off = (rect.top - containerRect.top) / cssZoomOf(container) - offsetPx;
        if (Math.abs(off) > 2) scrollElToOffset(el);
        if (!settledFired && (Math.abs(off) <= 2 || settleCount >= 15)) {
          settledFired = true;
          opts?.onSettled?.();
        }
        if (performance.now() - start < watchMs) requestAnimationFrame(settle);
        else cancel();
      };
      requestAnimationFrame(settle);
    } else if (findAttempts < 20) {
      virtualizer.scrollToIndex(idx, { align: "start" });
      requestAnimationFrame(() => setTimeout(attempt, 100));
    } else {
      cancel();
    }
  };
  setTimeout(attempt, opts?.initialDelayMs ?? 300);
}

// The forwardRef render function itself. Never call it as a plain function
// from another component: its hooks would then run on the caller's fiber, and
// Fast Refresh signs the caller, whose own hook list never changes, so an edit
// that adds a hook here keeps the fiber and crashes on the shifted hook slot
// ("Should have a queue"). The dev sizing happens inside the body instead.
const ConversationViewInner = (
  function ConversationView({ conversation, commits = [], pullRequests = [], backHref, backLabel = "Back", headerExtra, headerLeft, headerEnd, hasMoreAbove, hasMoreBelow, isLoadingOlder, isLoadingNewer, onLoadOlder, onLoadNewer, onJumpToStart, onJumpToEnd, onJumpToTimestamp, highlightQuery: propHighlightQuery, onClearHighlight: propClearHighlight, embedded, showMessageInput = true, targetMessageId, targetNonce, isJumpingToTarget, isOwner = true, guest = false, onSendAndAdvance, onSendAndDismiss, autoFocusInput, fallbackStickyContent: rawFallbackStickyContent, onBack, subHeaderContent, hideHeader, onSubmitWithIntent, onSendOverride, composerNode, leadNode, leadPinned, stickyPrompt = true, initialDensity, foldWorkingTurns = false, openAtTop = false, composerPlaceholder }: ConversationViewProps, ref: ForwardedRef<ConversationViewHandle>) {
  devRenderCount("ConversationView2");
  const renderStart = performance.now();
  const fallbackStickyContent = useMemo(() => stickyPromptContent(rawFallbackStickyContent), [rawFallbackStickyContent]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolled, _setUserScrolled] = useState(false);
  const userScrolledRef = useRef(false);
  const setUserScrolled = useCallback((v: boolean) => { userScrolledRef.current = v; _setUserScrolled(v); }, []);
  // Unsigned share-link visitors stay at the top until they choose the tail
  // (jump-to-end / scroll-to-bottom). End-follow and the size-reconciler pin
  // would otherwise yank them to the latest message as rows measure in.
  const [guestStayAtTop, _setGuestStayAtTop] = useState(() => (guest || openAtTop) && !targetMessageId && !propHighlightQuery);
  const guestStayAtTopRef = useRef(guestStayAtTop);
  const setGuestStayAtTop = useCallback((v: boolean) => { guestStayAtTopRef.current = v; _setGuestStayAtTop(v); }, []);
  const [isNearTop, setIsNearTop] = useState(true);
  // Position twin of isNearTop for the bottom edge (200px band). The jump
  // buttons hide inside these bands — the userScrolled gesture latch alone
  // showed the down arrow on a 2px nudge while still parked at the bottom.
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [isScrollable, setIsScrollable] = useState(false);
  // Guests read in simple view (DashboardLayout's guest branch), so they get
  // its calmer condensed default too — without owning a simple_view pref.
  const resolveDefaultDensity = useCallback(
    (): ConversationDensity => initialDensity ?? (guest ? "condensed" : defaultDensity()),
    [guest, initialDensity]
  );
  const [density, setDensityState] = useState<ConversationDensity>(resolveDefaultDensity);
  const setDensity = useCallback((d: ConversationDensity) => {
    setDensityState(d);
    if (conversation?._id) DENSITY_BY_CONVERSATION.set(conversation._id, d);
  }, [conversation?._id]);
  // Toggling Simple view retunes the open conversation immediately — but only
  // when the user hasn't explicitly picked a density for it (that choice wins).
  const simpleViewPref = useInboxStore((st) => resolveSimpleView(st.clientState.ui));
  // Minimal tucks the schedule, plan and workflow strips under the header
  // away; this preference (session menu, command palette) brings them back.
  const minimalStyle = useInboxStore((st) => st.clientState.ui?.visual_style === "minimal");
  const showSessionContext = useInboxStore((st) => st.clientState.ui?.show_session_context === true);
  useWatchEffect(() => {
    if (conversation?._id && DENSITY_BY_CONVERSATION.has(conversation._id)) return;
    setDensityState(resolveDefaultDensity());
  }, [simpleViewPref]);
  // Feed-rendering density: story/summary swap the feed out entirely, so the
  // virtualizer (and its height cache keys) only ever sees the first three.
  const feedDensity: MessageFeedDensity = density === "condensed" || density === "compact" ? density : "full";
  const condensedFeed = feedDensity !== "full";
  // Turn level folding: compact's own, or fold mode's on any density.
  const foldTurns = foldWorkingTurns || feedDensity === "compact";
  // Disclosure state for the condensed/compact feeds. Compact keys by TURN (the
  // first-assistant message id): opening expands the collapsed turn to full.
  // Condensed keys by RECEIPT OWNER (the message whose row carries the chip):
  // opening reveals just that segment's tools, nested under the chip inside the
  // owner's row — nothing above the click changes, so the reader's spot holds.
  // Cleared when the feed density changes (below) and on conversation switch.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);
  const prevFeedDensityRef = useRef(feedDensity);
  if (prevFeedDensityRef.current !== feedDensity) {
    prevFeedDensityRef.current = feedDensity;
    if (expandedGroups.size) setExpandedGroups(new Set());
  }
  const [diffExpanded, setDiffExpanded] = useState(false);
  // Global thinking visibility, off by default — opencode/pi carry real
  // reasoning text that's otherwise noisy in the timeline. Off = ThinkingBlock
  // doesn't render at all. On, each block still opens collapsed to a 2-line
  // preview (ThinkingBlock's own per-message state).
  const [showThinking, setShowThinking] = useState(false);
  const convex = useConvex();
  const convexConvId = conversation?._id && isConvexId(conversation._id) ? conversation._id as Id<"conversations"> : undefined;
  // Defer non-critical Convex queries one macrotask past a conversation switch so the
  // message list paints before the cascade fires.
  const deferredQueriesEnabled = useDeferUntilSettled(conversation?._id);
  const gitDiffData = useQuery(
    api.conversations.getConversationGitDiff,
    deferredQueriesEnabled && diffExpanded && convexConvId
      ? { conversation_id: convexConvId, ...shareTokenArg(convexConvId) }
      : "skip"
  );
  const renamingSessionId = useInboxStore((s) => s.renamingSessionId);
  const isRenaming = renamingSessionId === conversation?._id;
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  useWatchEffect(() => {
    if (isRenaming) {
      setRenameDraft(cleanTitle(conversation?.title || ""));
      setTimeout(() => renameInputRef.current?.select(), 0);
    }
  }, [isRenaming]);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [matchingMessageIds, setMatchingMessageIds] = useState<ReadonlySet<string>>(EMPTY_ID_SET);
  const [matchInstances, setMatchInstances] = useState<MatchInstance[]>(EMPTY_MATCH_INSTANCES);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [searchStatus, setSearchStatus] = useState<"idle" | "searching" | "done" | "error">("idle");
  // The hit the view is bringing into view right now. Navigation points at
  // it; the activation loop (after the virtualizer) consumes it. Declared
  // here, above the session-switch reset that clears it during render.
  const pendingHitRef = useRef<PendingHit | null>(null);
  // The hit currently shown as active. State, not a DOM attribute set once:
  // the virtualizer remounts rows and streaming re-renders markdown, and
  // either one recreates the <mark> without the attribute. An effect below
  // re-applies it after every render.
  const [activeHit, setActiveHit] = useState<{ messageId: string; localIndex: number } | null>(null);
  const activationSeqRef = useRef(0);
  const [isLocalSearchOpen, setIsLocalSearchOpen] = useState(false);
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const localSearchInputRef = useRef<HTMLInputElement>(null);
  useWatchEffect(() => {
    if (!localSearchQuery) { setDebouncedSearchQuery(""); return; }
    const timer = setTimeout(() => setDebouncedSearchQuery(localSearchQuery), 300);
    return () => clearTimeout(timer);
  }, [localSearchQuery]);
  const highlightQuery = isLocalSearchOpen ? (debouncedSearchQuery || undefined) : propHighlightQuery;
  const onClearHighlight = useCallback(() => {
    if (isLocalSearchOpen) {
      setIsLocalSearchOpen(false);
      setLocalSearchQuery("");
      setDebouncedSearchQuery("");
    } else {
      propClearHighlight?.();
    }
  }, [isLocalSearchOpen, propClearHighlight]);
  const scrollAnchorRef = useRef<number | null>(null); // savedScrollHeight before a loadOlder
  const prevTimelineLengthRef = useRef<number>(0);
  const isNearBottomRef = useRef(true);
  const scrollToBottomFnRef = useRef<() => void>(() => {});
  const lastScrollTopRef = useRef(0);
  const scrollProgressRef = useRef<HTMLDivElement>(null);
  const [navScrollProgress, setNavScrollProgress] = useState(() => (guest && !targetMessageId && !propHighlightQuery ? 0 : 1));
  const hasScrolledToTarget = useRef(false);
  const [jumpPending, _setJumpPending] = useState<'start' | 'end' | null>(null);
  // Synchronous mirror of jumpPending so scroll handlers / effects can read it
  // without going through React state (which lags a render behind).
  const jumpPendingRef = useRef<'start' | 'end' | null>(null);
  const setJumpPending = useCallback((v: 'start' | 'end' | null) => { jumpPendingRef.current = v; _setJumpPending(v); }, []);
  const jumpDirectionRef = useRef<'start' | 'end' | null>(null);
  const isPaginatingRef = useRef(false);
  // Armed by a genuine user scroll-up (wheel/touch) and CONSUMED on each
  // older-page load. This is what keeps "scroll to the top → load older" from
  // running away: the virtualizer re-estimates item heights after every prepend,
  // which jerks scrollTop around and re-crosses any position-based trigger band
  // with no user input. A wheel event, by contrast, is only ever produced by the
  // user's hand — never by the virtualizer or a programmatic scroll — so gating
  // on it ties loading to real scrolling. Stop scrolling and loading stops.
  const loadOlderArmedRef = useRef(false);
  // The mirror for the newer direction (target mode only): armed by a genuine
  // wheel-down, consumed per newer-page load. Without it, the virtualizer's
  // end-anchor snapping to the new bottom after each append re-crossed the
  // bottom trigger band and looped through every remaining page.
  const loadNewerArmedRef = useRef(false);
  // Suppresses scroll-triggered pagination while we programmatically move the
  // scroll position (prepend restore, jump-to-edge, initial snap). Holds a
  // deadline timestamp in ms; 0 means inactive. Self-expiring on purpose: a
  // boolean latch could get stuck `true` if its clear (a starved rAF or a
  // throttled background-tab timer) never ran, permanently killing "scroll to
  // top → load older". A deadline can only ever block for a bounded window.
  const paginationCooldownRef = useRef(0);
  // Captured at pagination trigger time (either direction): the topmost visible
  // message element and its exact viewport offset, so we can pin it right back
  // once the page mounts (above for 'older', below for 'newer'). DOM-measured
  // (not virtualizer estimates) → pixel-perfect.
  const pageAnchorRef = useRef<{ id: string; relTop: number; scrollHeight: number; scrollTop: number; dir: 'older' | 'newer' } | null>(null);
  const paginationPropsRef = useRef({ hasMoreAbove: false, hasMoreBelow: false, isLoadingOlder: false, isLoadingNewer: false, onLoadOlder: undefined as (() => void) | undefined, onLoadNewer: undefined as (() => void) | undefined });
  paginationPropsRef.current = { hasMoreAbove: !!hasMoreAbove, hasMoreBelow: !!hasMoreBelow, isLoadingOlder: !!isLoadingOlder, isLoadingNewer: !!isLoadingNewer, onLoadOlder, onLoadNewer };
  const scrollCtxRef = useRef({ messageCount: 0, messagesLen: 0, timelineLen: 0, loadedStartIndex: 0 });
  const knownItemIdsRef = useRef<Set<string>>(new Set());
  const newItemIdsRef = useRef<Set<string>>(new Set());
  const mountTimeRef = useRef(Date.now());
  const [shareSelectionMode, setShareSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [isCreatingShareLink, setIsCreatingShareLink] = useState(false);
  const [shareIncludeConversation, setShareIncludeConversation] = useState(false);
  const chatOn = useTeamFeature("chat");
  const callsAvailable = useCallsAvailable();
  const [isImageLightboxActive, setIsImageLightboxActive] = useState(false);
  const [stickyMsgVisible, setStickyMsgVisible] = useState(false);
  const [stickyExpanded, setStickyExpanded] = useState(false);
  const [stickyClamped, setStickyClamped] = useState(false);
  const stickyTextRef = useRef<HTMLDivElement>(null);
  const prevStickyMsgIdRef = useRef<string | null>(null);
  const prevStickyIdxRef = useRef<number | null>(null);
  const stickyGapRef = useRef<{ prevIdx: number } | null>(null);
  const dismissedStickyIdsRef = useRef<Set<string>>(new Set());
  const stickyElRef = useRef<HTMLDivElement>(null);
  const stickyPrefDisabled = useInboxStore(s => s.clientState.ui?.sticky_headers_disabled ?? false);
  const stickyDisabled = stickyPrefDisabled || !stickyPrompt;
  const updateUI = useInboxStore(s => s.updateClientUI);
  const headerRef = useRef<HTMLElement>(null);
  // Zen mode on desktop: the head ROW is the window titlebar (drag +
  // traffic-light inset). The ref goes on the inner cc-panel__head — the
  // element that paints the head background and bottom border — so the inset
  // padding shares its surface; on the outer wrapper the padding area showed
  // the wrapper's own darker background as a 78px block with a hard seam.
  const titlebarHeadRef = useTitlebarHead<HTMLDivElement>();
  // The header row sheds chip detail level by level until the title fits
  // (see hooks/useSqueezeToFit and the .cq-sq* tiers in globals.css).
  const squeezeRowRef = useRef<HTMLDivElement>(null);
  useSqueezeToFit(squeezeRowRef, 7);
  // Subagents carry parent_conversation_id; visible children (agent-team
  // teammates, spawns) carry spawned_by_conversation_id. The header chip and
  // the overflow menu row both link here, so folding the chip loses nothing.
  const parentLinkId = conversation?.parent_conversation_id || (conversation as any)?.spawned_by_conversation_id;
  // The unified session control panel behind the header badge (model, effort,
  // switch, fork, hand off). Controlled here so the overflow menu's one row
  // opens the same panel instead of duplicating it.
  const [sessionControlOpen, setSessionControlOpen] = useState(false);
  const handedOffFrom = conversation?.handed_off_from_details ?? null;
  const handedOffTo = conversation?.handed_off_to_details ?? null;
  const [headerHeight, setHeaderHeight] = useState(32);
  const messageInputRef = useRef<HTMLDivElement>(null);
  const [messageInputHeight, setMessageInputHeight] = useState(0);
  const [initialScrollDone, setInitialScrollDone] = useState(false);

  // Conversation transition: reset per-session state when staying mounted
  // across session switches (no key-based remount). Tracked by the STABLE
  // identity (session_id), not _id: an optimistic fork/create rekeys its row
  // from a stub id to the real Convex id ~1s after creation, and keying this
  // reset on _id treated that pure id-correction as a fresh conversation —
  // wiping scroll/density/expansion state and re-running the snap-to-bottom
  // layout effect, the "flash + scroll up" a beat after forking. session_id is
  // preserved verbatim across the rekey (the daemon resumes by it), so the same
  // logical conversation keeps one key while a real switch still changes it.
  const stableConvKey = conversation?.session_id ?? conversation?._id;
  const [_trackedConvId, _setTrackedConvId] = useState(stableConvKey);
  if (_trackedConvId !== stableConvKey) {
    _setTrackedConvId(stableConvKey);
    _setUserScrolled(false);
    userScrolledRef.current = false;
    setGuestStayAtTop(guest && !targetMessageId && !propHighlightQuery);
    setIsNearTop(true);
    setIsNearBottom(true);
    setDensityState((conversation?._id && DENSITY_BY_CONVERSATION.get(conversation._id)) || resolveDefaultDensity());
    setExpandedGroups(new Set());
    setDiffExpanded(false);
    setShowThinking(false);
    setHighlightedMessageId(null);
    setMatchingMessageIds(EMPTY_ID_SET);
    setMatchInstances(EMPTY_MATCH_INSTANCES);
    setCurrentMatchIndex(0);
    setSearchStatus("idle");
    pendingHitRef.current = null;
    setActiveHit(null);
    setIsLocalSearchOpen(false);
    setLocalSearchQuery("");
    setDebouncedSearchQuery("");
    setShareSelectionMode(false);
    setSelectedMessageIds(new Set());
    setIsImageLightboxActive(false);
    setStickyMsgVisible(false);
    setNavScrollProgress(1);
    setInitialScrollDone(false);
    isNearBottomRef.current = true;
    lastScrollTopRef.current = 0;
    prevTimelineLengthRef.current = 0;
    scrollAnchorRef.current = null;
    hasScrolledToTarget.current = false;
    setJumpPending(null);
    jumpDirectionRef.current = null;
    isPaginatingRef.current = false;
    paginationCooldownRef.current = 0;
    scrollCtxRef.current = { messageCount: 0, messagesLen: 0, timelineLen: 0, loadedStartIndex: 0 };
    knownItemIdsRef.current = new Set();
    newItemIdsRef.current = new Set();
    mountTimeRef.current = Date.now();
    prevStickyMsgIdRef.current = null;
    prevStickyIdxRef.current = null;
    stickyGapRef.current = null;
    dismissedStickyIdsRef.current = new Set();
    // A settle-watcher from the previous conversation corrects against stale
    // data-index rows — kill it before the new conversation paints.
    cancelActiveItemSettle?.();
  }

  // Reset scroll target tracking when the jump request changes — a new message
  // id, or a new nonce for the same id (clicking "jump to the ask" twice).
  const _targetReqKey = `${targetNonce ?? ""}:${targetMessageId ?? ""}`;
  const [_trackedTargetReq, _setTrackedTargetReq] = useState(_targetReqKey);
  if (_trackedTargetReq !== _targetReqKey) {
    _setTrackedTargetReq(_targetReqKey);
    if (targetMessageId) {
      hasScrolledToTarget.current = false;
    }
  }

  const convLink = useCallback((id: string) => `/conversation/${id}`, []);

  const generateShareLink = useMutation(api.messages.generateMessageShareLink);
  const pinToProfile = useMutation(api.conversations.pinToProfile);
  const unpinFromProfile = useMutation(api.conversations.unpinFromProfile);
  // Session-control commands (fork/restart/repair/rewind/sendKeys/sendEscape)
  // route through the local-first convCommand action — optimistic + dispatch
  // outbox — instead of direct useMutation. The command strings map to Convex
  // mutations via SESSION_COMMANDS in convex/dispatch.ts.
  const convCommand = useInboxStore((s) => s.convCommand);
  // Durable send via the dispatch outbox (survives reload mid-send).
  const sendInlineMessage = useInboxStore((s) => s.sendMessage);
  const toggleFavoriteMutation = useInboxStore((s) => s.toggleFavorite);

  const addOptimisticMsg = useInboxStore((s) => s.addOptimisticMessage);
  const moveDraft = useInboxStore((s) => s.moveDraft);
  const navigateToSession = useInboxStore((s) => s.navigateToSession);
  const injectSession = useInboxStore((s) => s.injectSession);
  const optimisticForkChildren = useInboxStore((s) => s.optimisticForkChildren);

  const { user: currentUser } = useCurrentUser();
  const effectiveIsOwner = isOwner;
  // Per-message sender attribution. A user message carries from_user_id when
  // someone other than the conversation owner sent it (team send into a
  // teammate's daemon, fork replies); resolve it against the cached team
  // roster so the prompt shows the actual sender, falling back to the
  // conversation owner for owner-typed and legacy messages.
  const teamRoster = useTeamRosterIdentity();
  const senderById = useMemo(() => {
    const m = new Map<string, { name?: string; avatar_url?: string | null }>();
    for (const mem of teamRoster || []) {
      if (!mem?._id) continue;
      m.set(String(mem._id), {
        name: mem.name || mem.email?.split("@")[0],
        avatar_url: mem.image || mem.github_avatar_url || null,
      });
    }
    const me = currentUser as any;
    if (me?._id && !m.has(String(me._id))) {
      m.set(String(me._id), {
        name: me.name || me.email?.split("@")[0],
        avatar_url: me.image || me.github_avatar_url || null,
      });
    }
    return m;
  }, [teamRoster, currentUser]);
  const resolveMsgSender = useCallback((msg: Message): { name?: string; avatar_url?: string | null } | undefined => {
    // Locally-created optimistic rows have no server from_user_id yet, but the
    // sender is by definition the viewer.
    const senderId = msg.from_user_id ?? ((msg._isOptimistic || msg._isQueued) ? (currentUser as any)?._id : undefined);
    if (!senderId) return undefined;
    return senderById.get(String(senderId));
  }, [senderById, currentUser]);
  // Width reserved on the right by the teammate comment rail (per-conversation, so
  // multiple tab panes don't fight). Pads the transcript/composer and nudges the
  // scroll affordances left so nothing hides under the panel.
  const commentRailW = useInboxStore((s) => (conversation ? s.commentRailWidth[conversation._id] ?? 0 : 0));
  // Pipe this conversation's comment thread into the inbox cache once; the dock
  // and the inline per-message threads all read from the store.
  useConversationCommentsSync(conversation?._id?.toString());
  // Git activity for this conversation: the feeder subscribes, the store keeps
  // the rows, and the timeline memo below reads them. Same shape as comments.
  useSyncConversationExternalEvents(conversation?._id?.toString());
  const effectiveConversationId = conversation?._id;
  const convIdForEvents = conversation?._id?.toString();
  // Only this conversation's own events: the ones the daemon attributed to it
  // (the one live session in the checkout, or the transcript that printed the
  // sha) and the PR events of the PR it shepherds. Never the team's.
  const externalEventsWhere = useMemo(
    () => (convIdForEvents ? (e: ExternalEventRecord) => e.conversation_id === convIdForEvents && !isQuietExternalEvent(e) : () => false),
    [convIdForEvents],
  );
  const conversationExternalEvents = useExternalEvents(externalEventsWhere, externalEventsOldestFirst);

  const handleSendInlineMessage = useCallback(async (content: string) => {
    if (!conversation || !effectiveConversationId) return;
    const clientId = addOptimisticMsg(effectiveConversationId, content);
    setUserScrolled(false);
    requestAnimationFrame(() => scrollToBottomFnRef.current());
    sendInlineMessage(effectiveConversationId, content, undefined, clientId);
  }, [conversation, effectiveConversationId, sendInlineMessage, addOptimisticMsg, setUserScrolled]);
  // Narrow subscription: this monolith only reads agent_status, permission_mode,
  // session_id, is_connected, tmux_session and team_id from the session row — but
  // the row's identity churns every ~1s heartbeat (updated_at / last_heartbeat /
  // is_idle overlay). Subscribing to the whole row re-rendered the entire
  // ConversationView (~120ms) on every heartbeat for a LIVE session. useShallow
  // re-renders only when one of these six fields actually changes.
  const managedSession = useInboxStore(useShallow((s) => {
    const sess = effectiveConversationId ? s.sessions[effectiveConversationId] : null;
    if (!sess) return null;
    return {
      agent_status: sess.agent_status,
      permission_mode: sess.permission_mode,
      session_id: sess.session_id,
      is_connected: sess.is_connected,
      tmux_session: sess.tmux_session,
      team_id: sess.team_id,
    };
  }));
  // Who this session is (docs/architecture/session-characters.md S3): the
  // header wears the same face as its inbox card, at 22 px, and clicking it
  // opens the character picker. Narrow like managedSession above — the
  // identity fields alone, so the heartbeat's churn re-renders nothing.
  const identityRow = useInboxStore(useShallow((s) => {
    const sess = effectiveConversationId ? (s.sessions[effectiveConversationId] as any) : null;
    return sess ? identityRowOf(sess) : null;
  }));
  const headerCharacterPicker = useContextMenu<IdentityRow[]>();
  const isSessionLive = !!managedSession?.is_connected;
  // The command palette's "Copy tmux attach command" — the same gesture as the
  // header pill's copy button, so it copies the same command for the same machine.
  const { copyAttach: copyTmuxAttach } = useAttachCopy(managedSession?.tmux_session, conversation?._id?.toString());

  // Store-fed (hooks/useSyncWorkflows): the gate banner paints from the cached
  // run on the first frame; the feeder keeps it live.
  const workflowRun = useWorkflowRun(
    deferredQueriesEnabled && conversation?.workflow_run_id ? conversation.workflow_run_id : null,
  ) as { _id: string; status: string; gate_prompt?: string; gate_choices?: Array<{ key: string; label: string; target: string }>; gate_response?: string | null } | null | undefined;
  const { gateResponding, handleGateChoice, handleGateRespond, showWorkflow, setShowWorkflow, selectedWorkflowId, setSelectedWorkflowId, workflows, handleWorkflowLaunch } = useWorkflowLaunch({ workflowRun, conversation });

  // Claude Code owns the shift+tab cycle (it changed when auto mode arrived,
  // and bypass is only in it when the launch enabled it), so the client never
  // predicts where a press lands: the daemon presses, reads the mode back off
  // the pane, and publishes it. Until that lands the pill pulses: "switching"
  // is derived from the mode the request started on still being the live
  // mode, so it ends in the render the observed mode arrives, with a bounded
  // fallback for a press the daemon could not honour.
  const effectiveMode = managedSession?.permission_mode || "default";
  const { handleCycleMode, modeSwitching, handleEnableBypass } = usePermissionModeSwitch({ effectiveMode, conversation, effectiveIsOwner, convexConvId, convCommand });

  const forkSelectedIndex = useForkNavigationStore((s) => s.selectedIndex);

  useWatchEffect(() => {
    if (!conversation || !effectiveIsOwner || conversation.status !== "active") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !e.shiftKey) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (hasOpenModal()) return;
      e.preventDefault();
      handleCycleMode();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [conversation, effectiveIsOwner, handleCycleMode]);

  const messagesFromConv = conversation?.messages;
  const messages = useMemo<Message[]>(() => {
    if (!messagesFromConv) return EMPTY_MESSAGES;
    // Context-only import truncation notices are never user-facing. Rows synced by
    // older CLIs still carry them; drop here (some() guard keeps the common-case
    // array identity stable).
    const base = messagesFromConv.some(m => m.role === "user" && isContextOnlyUserMessage(m.content))
      ? messagesFromConv.filter(m => !(m.role === "user" && isContextOnlyUserMessage(m.content)))
      : messagesFromConv;
    // A real (JSONL) AskUserQuestion tool call carries full fidelity. During the
    // brief race before its tool_use is detected, the daemon may also emit a
    // synthetic `interactive-prompt-` scrape of the same on-screen menu — a
    // degraded duplicate that should be hidden. But that duplication only happens
    // when the two land within seconds of each other. TUI slash menus (/model,
    // /agents, …) are *only ever* synthetic and have no JSONL counterpart, so a
    // conversation-global "drop all synthetic polls" filter wrongly erases them.
    // Suppress a synthetic poll only when a real AUQ sits near it in time.
    const withoutProseTwins = dropScrapedProseTwins(base);

    const realAskTimes = withoutProseTwins
      .filter(m =>
        m.tool_calls?.some(tc => isAskTool(tc.name)) &&
        !m.message_uuid?.startsWith("interactive-prompt-")
      )
      .map(m => m.timestamp);
    if (realAskTimes.length === 0) return withoutProseTwins;
    const DUP_WINDOW_MS = 2 * 60_000;
    return withoutProseTwins.filter(m => {
      if (!m.message_uuid?.startsWith("interactive-prompt-")) return true;
      return !realAskTimes.some(rt => Math.abs(rt - m.timestamp) <= DUP_WINDOW_MS);
    });
  }, [messagesFromConv]);

  const messageAuthors = useMemo(
    () => messageAgentTypes(messages, conversation?.agent_type),
    [messages, conversation?.agent_type],
  );

  // Most clients redact thinking server-side now — only opencode (and
  // occasionally pi) still send real reasoning text. Only surface the
  // toggle/shortcut when this conversation actually has some, loaded window
  // included, so the menu doesn't carry a dead entry for everyone else.
  const hasAnyThinking = useMemo(
    () => messages.some(m => m.role === "assistant" && !!m.thinking && m.thinking.trim().length > 0),
    [messages]
  );

  const agentNameToChildMap = useMemo(() => {
    const entries = conversation?.agent_name_entries;
    if (Array.isArray(entries)) {
      const map: Record<string, string> = {};
      for (const [name, childId] of entries) {
        if (typeof name !== "string" || typeof childId !== "string") continue;
        map[name] = childId;
      }
      return map;
    }
    return conversation?.agent_name_map as Record<string, string> | undefined;
  }, [conversation?.agent_name_entries, conversation?.agent_name_map]);

  const addOptimisticFork = useInboxStore((s) => s.addOptimisticFork);
  const pruneOptimisticForks = useInboxStore((s) => s.pruneOptimisticForks);
  const preloadForkSessions = useInboxStore((s) => s.preloadForkSessions);

  const forkPointMap = useMemo(() => {
    const map: Record<string, Array<ForkChild>> = {};
    // Forks recorded against a message the timeline hides (a "No response
    // requested." stub) re-anchor to the nearest earlier message that renders
    // branch chips (user/assistant blocks) — chips render attached to their
    // anchor, so a hidden anchor would make the branch invisible everywhere.
    const reanchor: Record<string, string> = {};
    let lastVisibleUuid: string | undefined;
    for (const m of (conversation?.messages || []) as Message[]) {
      if (!m.message_uuid) continue;
      if (isHiddenStubMessage(m)) {
        if (lastVisibleUuid) reanchor[m.message_uuid] = lastVisibleUuid;
      } else if (canAnchorForkChips(m)) {
        lastVisibleUuid = m.message_uuid;
      }
    }
    // Each fork is stamped with the line it was forked from: children came off
    // this conversation, siblings off its parent. The chip row derives the
    // origin line's post-fork size from that stamp (BranchSelector).
    const thisId = conversation?._id?.toString();
    const parentId = conversation?.forked_from?.toString();
    const allForks: ForkChild[] = [
      ...(conversation?.fork_children || []).map((f) => ({ ...f, origin_id: thisId }) as ForkChild),
      ...(conversation?.fork_siblings || []).map((f) => ({ ...f, origin_id: parentId }) as ForkChild),
      ...optimisticForkChildren,
    ];
    const seen = new Set<string>();
    for (const fork of allForks) {
      if (seen.has(fork._id)) continue;
      seen.add(fork._id);
      if (fork.parent_message_uuid) {
        const anchor = reanchor[fork.parent_message_uuid] ?? fork.parent_message_uuid;
        if (!map[anchor]) map[anchor] = [];
        map[anchor].push(fork);
      }
    }
    return map;
  }, [conversation?._id, conversation?.forked_from, conversation?.fork_children, conversation?.fork_siblings, conversation?.messages, optimisticForkChildren]);

  useWatchEffect(() => {
    if (!conversation?.fork_children) return;
    const serverIds = new Set(conversation.fork_children.map(f => f._id));
    pruneOptimisticForks(serverIds);
  }, [conversation?.fork_children, pruneOptimisticForks]);

  // Branch chips are listed straight from the server fork metadata, independent of
  // the local cache. Seed every accessible branch (children, siblings, and the
  // parent) into the store the moment we have that metadata, so clicking any chip
  // is an instant local switch instead of a getConversation fetch-and-spin. The
  // server already filtered these to forks the viewer can open, so preloading can't
  // surface a private session. Gap-fill only — live rows are never downgraded.
  useWatchEffect(() => {
    if (conversation?.fork_children?.length) {
      preloadForkSessions(conversation.fork_children as ForkChild[], conversation._id?.toString());
    }
    if (conversation?.fork_siblings?.length) {
      preloadForkSessions(conversation.fork_siblings as ForkChild[], conversation.forked_from?.toString());
    }
    const ffd = conversation?.forked_from_details;
    if (ffd?.conversation_id) {
      // Pass the triage fields through: a stashed/dismissed parent must seed
      // as such, or it flashes into the inbox as an active card at boot.
      preloadForkSessions([{
        _id: ffd.conversation_id.toString(),
        title: ffd.title || "Parent session",
        inbox_dismissed_at: ffd.inbox_dismissed_at,
        inbox_stashed_at: ffd.inbox_stashed_at,
        inbox_killed_at: ffd.inbox_killed_at,
        inbox_pinned_at: ffd.inbox_pinned_at,
      }]);
    }
  }, [conversation?.fork_children, conversation?.fork_siblings, conversation?.forked_from_details, conversation?._id, conversation?.forked_from, preloadForkSessions]);

  const activeBranchId = conversation?.forked_from ? conversation._id.toString() : null;

  const handleStartShareSelection = useCallback((messageId: string) => {
    setShareSelectionMode(true);
    setSelectedMessageIds(new Set([messageId]));
  }, []);

  const handleToggleMessageSelection = useCallback((messageId: string) => {
    setSelectedMessageIds(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const handleCancelShareSelection = useCallback(() => {
    setShareSelectionMode(false);
    setSelectedMessageIds(new Set());
    setShareIncludeConversation(false);
  }, []);

  const handleConfirmShare = useCallback(async (destination?: "chat") => {
    if (selectedMessageIds.size === 0) return;

    setIsCreatingShareLink(true);
    try {
      const sortedIds = Array.from(selectedMessageIds).sort((a, b) => {
        const msgA = messages.find(m => m._id === a);
        const msgB = messages.find(m => m._id === b);
        return (msgA?.timestamp || 0) - (msgB?.timestamp || 0);
      });

      const token = await generateShareLink({
        message_id: sortedIds[0] as Id<"messages">,
        context_before: 0,
        context_after: 0,
        message_ids: sortedIds as Id<"messages">[],
        include_conversation_link: shareIncludeConversation || undefined,
      });

      const url = `${shareOrigin()}/share/message/${token}`;
      if (destination === "chat") {
        openForwardToChat({
          url,
          label: selectedMessageIds.size > 1 ? "messages" : "message",
          previewTitle: conversation?.title,
          previewText: sortedIds.map((id) => messages.find((m) => m._id === id)?.content).filter(Boolean).join("\n\n"),
        });
      } else {
        await copyToClipboard(url);
        toast.success(shareIncludeConversation ? "Share link copied! The full conversation is now public via its link." : "Share link copied!");
      }
      setShareSelectionMode(false);
      setSelectedMessageIds(new Set());
      setShareIncludeConversation(false);
    } catch (err) {
      toast.error("Failed to create share link");
    } finally {
      setIsCreatingShareLink(false);
    }
  }, [selectedMessageIds, messages, generateShareLink, shareIncludeConversation, conversation?.title]);

  const toolCallChangeSelectionMap = useMemo(() => {
    const fileChanges = extractFileChanges(messages as any);
    const map: Record<string, ToolCallChangeSelection> = {};
    for (const change of fileChanges) {
      const key = change.toolCallId || change.id;
      const existing = map[key];
      if (!existing) {
        map[key] = {
          index: change.sequenceIndex,
          range: {
            start: change.sequenceIndex,
            end: change.sequenceIndex,
          },
        };
        continue;
      }
      existing.index = change.sequenceIndex;
      existing.range.end = change.sequenceIndex;
    }
    return map;
  }, [messages]);

  // Store-fed (hooks/useSyncPendingPermissions): the permission stack paints
  // from cached rows on the first frame; a resolved request leaves the store
  // (and disk) on the next push.
  const pendingPermissionsRaw = usePendingPermissions(
    conversation?._id && isConvexId(conversation._id) ? conversation._id : null,
    deferredQueriesEnabled,
  );
  const pendingPermissions = pendingPermissionsRaw?.filter((p: any) => !PERMISSION_SKIP_TOOLS.has(p.tool_name));
  const hasAskUserQuestion = pendingPermissionsRaw?.some((p: any) => isAskTool(p.tool_name)) ?? false;
  // A `cast decide` ask renders as a card inside the pane: blocking owns the
  // pane, advisory docks above the composer (SessionDecisionCard). The queue
  // supplies a stepper — and, for a poll/permission card, the item itself.
  const decisionStepper = useContext(DecisionStepperContext);
  const pendingDecision = usePendingDecisionItem(conversation?._id && isConvexId(conversation._id) ? conversation._id : null);
  const decisionItem = pendingDecision ?? decisionStepper?.item ?? null;
  const forkSetSelectedIndex = useForkNavigationStore((s) => s.setSelectedIndex);
  // Branch map open-state. One surface: a command-palette-style popover anchored
  // above the message input. Ctrl+B / the header icon open it at the branch
  // tree (mapDrill = null); double-Esc opens it drilled into the current
  // branch's messages (mapDrill = current conversation id).
  const [treePopoverOpen, setTreePopoverOpen] = useState(false);
  const [mapDrill, setMapDrill] = useState<string | null>(null);
  const treeChipRef = useRef<HTMLButtonElement>(null);

  const timelineRef = useRef<any[]>([]);
  // "Send and stash" outside the inbox queue (the conversation page, a stage
  // pane): the queue passes its own handler with its advance logic; here the
  // viewer's own session simply hides after the send. Guests and non-owners
  // can't triage, so they get no button.
  const sendAndStashConvId = conversation?._id;
  const sendAndStashFallback = useMemo(
    () => (isOwner && !guest && sendAndStashConvId ? () => animatedHideSession(sendAndStashConvId, "stash") : undefined),
    [isOwner, guest, sendAndStashConvId],
  );

  const isForkLoading = false;
  const [loadingBranchId, setLoadingBranchId] = useState<string | null>(null);


  // Pending messages: read directly so they ALWAYS render, regardless of what
  // setMessages/mergeMessages/buildCompositeTimeline do to the server message arrays.
  const pendingConvId = effectiveConversationId || conversation?._id || '';
  const pendingMsgs = useInboxStore((s) => s.pendingMessages[pendingConvId] ?? EMPTY_PENDING);
  // Server-side pending row — the SAME pending_messages rail a human web send uses. The local
  // optimistic queue above only exists in the browser that hit Send; this surfaces a queued
  // message to EVERY viewer, and to CLI-originated `cast send`s that no browser optimistically
  // rendered, so it shows as pending immediately (before the JSONL echo) instead of nothing.
  const serverPending = usePendingMessageStatus(isConvexId(pendingConvId) ? pendingConvId : null);
  // Slack-style "New" divider anchor: "seen up to" advances only when you leave
  // a session, so it holds steady for the whole visit. Everything strictly after
  // it arrived while you were away.
  const unreadAnchorAt = useInboxStore((s) => s._seenUpToAt[pendingConvId] ?? 0);
  // The server-backed read mark, which is a different thing from the divider
  // above: the divider is where THIS device stopped reading, the ack is what
  // clears the card's unread dot on every device. Presence-gated inside.
  useAckActiveConversation(pendingConvId);
  // Upper bound for the "New" divider — the moment you last focused this
  // session (re-stamped on every entry, including window-focus). Messages newer
  // than this arrived while you were here watching and must not be split off.
  const enteredAt = useInboxStore((s) => s._lastViewedAt[pendingConvId] ?? 0);

  // Commits and pull requests linked to this session but made outside the
  // transcript: a push the webhook matched to it, a commit the daemon
  // published from its checkout, a PR opened from a terminal on its branch.
  // The ones a shell call here produced already render on that call, so they
  // are left out; what remains earns a card of its own in the timeline.
  const gitLinkConversationId = conversation?._id ? String(conversation._id) : undefined;
  useSyncConversationCommits(gitLinkConversationId);
  useSyncConversationPullRequests(gitLinkConversationId);
  const linkedCommits = useConversationCommits(gitLinkConversationId);
  const linkedPullRequests = useConversationPullRequests(gitLinkConversationId);
  const transcriptOutcomes = useMemo(() => transcriptGitOutcomes(messages as any), [messages]);
  const outsideCommits = useMemo(
    () => linkedCommits.filter((c: any) => typeof c.sha === "string" && !madeInTranscript(c.sha, transcriptOutcomes.commitShas)),
    [linkedCommits, transcriptOutcomes],
  );
  const outsidePullRequests = useMemo(
    () => linkedPullRequests.filter((p: any) => !transcriptOutcomes.prRefs.has(`${p.repository}#${p.number}`)),
    [linkedPullRequests, transcriptOutcomes],
  );
  const allCommits = useMemo(() => (outsideCommits.length ? [...commits, ...outsideCommits] : commits), [commits, outsideCommits]);
  const allPullRequests = useMemo(() => (outsidePullRequests.length ? [...pullRequests, ...outsidePullRequests] : pullRequests), [pullRequests, outsidePullRequests]);

  const timeline: TimelineItem[] = useMemo(() => {
    const base = buildCompositeTimeline(
      messages,
      allCommits,
      allPullRequests,
      conversationExternalEvents,
    ) as TimelineItem[];
    // Guaranteed render: append any pending messages not already in the timeline.
    // This is the ONLY merge point — the store never mixes pending into messages[].
    const seen = new Set<string>();
    const seenContent = new Set<string>();
    let newestServerTs = 0;
    for (const item of base) {
      if (item.type === 'message') {
        const m = item.data as any;
        seen.add(m._id);
        if (m.client_id) seen.add(m.client_id);
        if (m.role === 'user' && m.content) seenContent.add(normalizePendingContent(m.content));
        if (!m._isOptimistic && !m._isQueued && !m._isFailed && m.timestamp > newestServerTs) newestServerTs = m.timestamp;
      }
    }
    const toAdd: any[] = pendingMsgs.filter((m: any) => {
      if (seen.has(m._id) || (m._clientId && seen.has(m._clientId))) return false;
      // Slash commands: the daemon can't always carry a client_id across the pending
      // "/cmd args" → synced tag-form echo, so also drop a pending command whose canonical
      // content already rendered as a synced message (prevents the command showing twice).
      if (m.role === 'user' && m.content) {
        const norm = normalizePendingContent(m.content);
        if (norm.startsWith('/') && seenContent.has(norm)) return false;
      }
      return true;
    });
    for (const m of toAdd) if (m.content) seenContent.add(normalizePendingContent(m.content));
    // Server-side pending row: a queued message (e.g. a CLI `cast send`) that no browser
    // optimistically rendered. Surface it as a pending bubble for every viewer — but only if
    // its content isn't already on screen as a synced message or a local optimistic copy
    // (the sender's own browser already shows it via addOptimisticMessage). Dropped the moment
    // the real JSONL echo lands, since that fills seenContent with the same normalized key.
    // A delivered row keeps its bubble (as a plain message) while this window's transcript
    // still ends before the send: the echo is on the server but not here yet, and a message
    // that vanished until the tail caught up is the bug (serverPendingBubbleVisible).
    if (serverPending && serverPendingBubbleVisible(serverPending, { newestServerTs, atLiveTail: !hasMoreBelow })) {
      const norm = normalizePendingContent(serverPending.content);
      if (norm && !seenContent.has(norm)) {
        toAdd.push({
          _id: `serverpending_${serverPending.message_id}`,
          role: 'user',
          content: serverPending.content,
          timestamp: serverPending.created_at,
          ...(serverPending.status === 'delivered' ? {} : { _isOptimistic: true }),
          _serverPendingStatus: serverPending.status,
          _serverPendingReason: serverPending.hold_reason,
        });
      }
    }
    return mergeTimelineMessages(base, toAdd) as TimelineItem[];
  }, [messages, allCommits, allPullRequests, conversationExternalEvents, pendingMsgs, serverPending, pendingConvId, hasMoreBelow]);
  timelineRef.current = timeline;
  scrollCtxRef.current = { messageCount: conversation?.message_count || messages.length, messagesLen: messages.length, timelineLen: timeline.length, loadedStartIndex: conversation?.loaded_start_index ?? 0 };

  // One card per workflow run: fork copies and transcript round-trips can leave
  // several messages carrying the same run anchor (with or without the
  // workflow_event subtype). The first occurrence owns the card; the rest
  // render nothing.
  const wfRunCardOwner = useMemo(() => {
    const owner = new Map<string, string>();
    for (const item of timeline) {
      if (item.type !== 'message') continue;
      const m = item.data as Message;
      if (m.role !== 'assistant') continue;
      const ev = parseWorkflowEventContent(m.content);
      if (ev?.__wf === 'workflow_run' && ev.run_id && !owner.has(ev.run_id)) owner.set(ev.run_id, m._id);
    }
    return owner;
  }, [timeline]);

  // Index of the first timeline item that arrived while you were away — newer
  // than your last leave (`unreadAnchorAt`) but no newer than your last focus
  // (`enteredAt`). The "New" divider renders above this row; -1 = nothing new
  // (first-ever visit, or everything unseen actually arrived live this visit).
  const firstUnseenIndex = useMemo(
    () => computeNewDividerIndex(timeline, unreadAnchorAt, enteredAt),
    [timeline, unreadAnchorAt, enteredAt],
  );
  // Handoff markers, drawn the same way: each transfer sits above the first
  // row at or after the moment it happened, with the assigner's note under
  // the rule. A session handed over after its last message (the usual case:
  // a finished thread passed on) anchors below the final row instead — index
  // timeline.length. Every viewer sees every handoff; the assignee's own
  // "Got it" strip is the header banner.
  const ownersApi = useOwnersFromStore(pendingConvId);
  const handoffMeId = ownersApi.currentUser?._id?.toString?.();
  const handoffsByIndex = useMemo(() => {
    const byIndex = new Map<number, HandoffInfo[]>();
    if (timeline.length === 0) return byIndex;
    for (const h of ownersApi.handoffs) {
      const idx = timeline.findIndex((it) => it.timestamp >= h.at);
      const at = idx === -1 ? timeline.length : idx;
      byIndex.set(at, [...(byIndex.get(at) ?? []), h]);
    }
    return byIndex;
  }, [timeline, ownersApi.handoffs]);
  const handoffRulesAt = (index: number) => handoffsByIndex.get(index)?.map((h) => (
    <HandoffMarker key={`${h.to}:${h.at}`} handoff={h} meId={handoffMeId} />
  ));


  const populateInputRef = useRef<((text: string, opts?: { append?: boolean }) => void) | null>(null);
  const { handleForkFromMessage, forkHandler, handleForkFromBranch, handleForkReply, forkSendHandler } = useForkActions({ injectSession, conversation, addOptimisticFork, currentUser, hasMoreAbove, convCommand, timelineRef, populateInputRef, addOptimisticMsg, sendInlineMessage });
  // Bridge for the quote/comment review UI: lets MessageReview, the selection
  // toolbar, and the review bar push text into the composer without prop-drilling.
  const { dropFilesRef, isDragging, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useConversationFileDrop();

  // Rewind/fork navigator reads the same cached list (populated by
  // useConversationMessages), gated to owners of an active session since
  // rewinding only applies there.
  const cachedUserMessages = useInboxStore(
    (s) => (conversation?._id ? s.userMessages[conversation._id] : undefined)
  );
  // Escape in an empty composer interrupts the agent. Every press on an owned,
  // active conversation is forwarded and paints the "user interrupted" line at
  // once (convCommand's optimistic branch). The web does NOT judge whether the
  // agent is mid-turn: its live status is a windowed overlay that goes stale,
  // and a press dropped on a stale "idle" never reached the agent at all. The
  // daemon holds the facts and decides (cli/src/escapeInterrupt.ts); the press
  // time rides along so an Escape aimed at the previous turn cannot cancel the
  // one a queued message started after the press (the 2026-08-28 race).
  const handleSendEscape = useCallback(() => {
    if (!conversation || !effectiveIsOwner || conversation.status !== "active" || !convexConvId) return;
    setUserScrolled(false);
    void convCommand(convexConvId, "sendEscapeToSession", { pressed_at: Date.now() }).catch((err) => {
        if (isParkedDispatchError(err)) {
          toast.info("Escape queued — it will send when the connection recovers");
          return;
        }
        toast.error(err instanceof Error ? err.message : "Failed to send Escape");
    });
    requestAnimationFrame(() => scrollToBottomFnRef.current());
  }, [conversation, effectiveIsOwner, convCommand, convexConvId, setUserScrolled]);

  const handleMessageSent = useCallback(() => {
    setUserScrolled(false);
    requestAnimationFrame(() => scrollToBottomFnRef.current());
  }, [setUserScrolled]);

  // Double-Esc opens the unified branch map drilled straight into the current
  // branch's messages (the old standalone navigator is retired into the map).
  const handleOpenNavigator = useCallback(() => {
    if (!isOwner || !conversation?._id) return;
    // Always open — even a disconnected/finished session or one with no user
    // messages yet drills into its (possibly empty) message list. The drilled
    // view fetches its own messages, so it doesn't depend on session status.
    setMapDrill(conversation._id.toString());
    setTreePopoverOpen(true);
  }, [isOwner, conversation?._id]);

  // Branch map rewind (Enter in the drilled current-branch messages): fork at
  // that point and rewind the live session.
  const handleRewindCurrent = useCallback((messageUuid: string, indexFromEnd: number) => {
    if (!conversation) return;
    handleForkFromMessage(messageUuid);
    if (effectiveIsOwner && conversation.status === "active" && convexConvId) {
      void convCommand(convexConvId, "rewindSession", { steps_back: indexFromEnd + 1 }).catch((err) => {
        if (isParkedDispatchError(err)) return;
        toast.error(err instanceof Error ? err.message : "Failed to rewind session");
      });
    }
  }, [handleForkFromMessage, conversation, effectiveIsOwner, convCommand, convexConvId]);
  const { userMsgKindMap, turnAggregates, openAsk, commandExpansionMap, nudgeRuns, isThinking, isWaitingForResponse } = useTimelineTurns({ messages, conversation, hasMoreAbove, timeline, messageAuthors, hasMoreBelow, foldWorkingTurns });
  const { sessionSkills, sessionFilePaths, mentionItemsRef, handleMentionQuery } = useSessionMentions({ currentUser, conversation, managedSession });
  const { serverUserMessages, stickyUserMsgIndices, navigatorTimelineIndices, timelineMessageIds, serverStickyFallback } = useNavigatorIndex({ cachedUserMessages, messages, timeline, userMsgKindMap, hasMoreAbove });

  const [activeStickyMsg, setActiveStickyMsgRaw] = useState<{ index: number; content: string; id: string; fromUserId?: string } | null>(null);
  const [navigatorCurrentId, setNavigatorCurrentId] = useState<string | null>(null);
  const setActiveStickyMsg = useCallback((val: { index: number; content: string; id: string; fromUserId?: string } | null) => {
    setActiveStickyMsgRaw(prev => {
      if (prev === val) return prev;
      if (prev === null || val === null) return val;
      if (prev.index === val.index && prev.id === val.id && prev.content === val.content) return prev;
      return val;
    });
  }, []);

  const stickyMessageId = activeStickyMsg?.id;
  const stickyImages = useMemo(() => {
    if (!stickyMessageId) return undefined;
    return messages.find(message => message._id === stickyMessageId)?.images
      ?? serverUserMessages?.find(message => message._id === stickyMessageId)?.images;
  }, [stickyMessageId, messages, serverUserMessages]);

  // Collapse and re-measure clamping whenever the sticky switches to a different message.
  useWatchEffect(() => {
    setStickyExpanded(false);
  }, [activeStickyMsg?.id]);
  useWatchEffect(() => {
    const el = stickyTextRef.current;
    setStickyClamped(el ? el.scrollHeight > el.clientHeight + 1 : false);
  }, [activeStickyMsg?.id, activeStickyMsg?.content, stickyMsgVisible, stickyExpanded]);

  // Publish the sticky prompt card's height on the header as --conv-sticky-h so
  // header-anchored overlays (the files-changed pill) slide below it instead of
  // overlapping at narrow widths. Imperative write: no re-render on resize.
  useWatchEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const el = stickyElRef.current;
    if (!stickyMsgVisible || !el) {
      header.style.setProperty("--conv-sticky-h", "0px");
      return;
    }
    const update = () => header.style.setProperty("--conv-sticky-h", `${el.offsetHeight}px`);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [stickyMsgVisible, activeStickyMsg?.id]);

  useWatchEffect(() => {
    const currentIds = new Set(timeline.map(item => {
      if (item.type === 'message') return (item.data as Message)._id;
      if (item.type === 'commit') return `commit-${(item.data as any).sha || (item.data as any)._id}`;
      return `pr-${(item.data as any)._id}`;
    }));

    // Suppress animation during initial hydration — IDB delivers cached messages first,
    // then Convex syncs the latest. Without this window, the Convex delta would
    // trigger slide-in animations for messages that aren't actually new.
    const isSettling = Date.now() - mountTimeRef.current < 1500;

    if (knownItemIdsRef.current.size > 0 && !isPaginatingRef.current && !isSettling) {
      const fresh = new Set<string>();
      for (const id of currentIds) {
        if (!knownItemIdsRef.current.has(id)) {
          if (isConvexId(id)) {
            const item = timeline.find(i => {
              if (i.type === 'message') return (i.data as Message)._id === id;
              if (i.type === 'commit') return `commit-${(i.data as any).sha || (i.data as any)._id}` === id;
              return `pr-${(i.data as any)._id}` === id;
            });
            if (item?.type === 'message' && (item.data as Message).role === 'user') continue;
          }
          fresh.add(id);
        }
      }
      if (fresh.size > 0 && fresh.size <= 20) {
        newItemIdsRef.current = fresh;
        knownItemIdsRef.current = currentIds;
        const timer = setTimeout(() => { newItemIdsRef.current = new Set(); }, 400);
        return () => clearTimeout(timer);
      }
    }

    knownItemIdsRef.current = currentIds;
  }, [timeline]);

  // Ref of loaded message IDs for fast membership checks during navigation.
  const loadedIdsRef = useRef<Set<string>>(new Set());
  loadedIdsRef.current = useMemo(() => new Set(messages.map((m: Message) => m._id)), [messages]);
  const matchInstancesRef = useRef(matchInstances);
  matchInstancesRef.current = matchInstances;
  const currentMatchIndexRef = useRef(currentMatchIndex);
  currentMatchIndexRef.current = currentMatchIndex;

  const [activationTick, setActivationTick] = useState(0);
  const navigateToHit = useCallback((index: number, dir: 1 | -1, instances: MatchInstance[]) => {
    const target = instances[index];
    if (!target) return;
    setCurrentMatchIndex(index);
    setHighlightedMessageId(target.messageId);
    pendingHitRef.current = { ...target, dir, startedAt: Date.now(), jumped: false, skipped: 0 };
    setActivationTick((t) => t + 1);
  }, []);
  const goToNextMatch = useCallback(() => {
    if (matchInstances.length === 0) return;
    navigateToHit(stepIndex(currentMatchIndex, 1, matchInstances.length), 1, matchInstances);
  }, [matchInstances, currentMatchIndex, navigateToHit]);
  const goToPrevMatch = useCallback(() => {
    if (matchInstances.length === 0) return;
    navigateToHit(stepIndex(currentMatchIndex, -1, matchInstances.length), -1, matchInstances);
  }, [matchInstances, currentMatchIndex, navigateToHit]);

  // Every hit across the whole conversation, one bounded server page at a
  // time (messages.findAllMessagesByContent), so a match outside the loaded
  // window still counts. A one-shot walk, not a live subscription: a live
  // query over a long transcript re-ran the full scan on every new message
  // and yanked the counter back to hit 1 each time. The first page that
  // carries a hit shows it at once; later pages only grow the counter.
  const cleanedHighlight = highlightQuery?.trim();
  const searchGenRef = useRef(0);
  useWatchEffect(() => {
    const gen = ++searchGenRef.current;
    pendingHitRef.current = null;
    setActiveHit(null);
    setMatchInstances(EMPTY_MATCH_INSTANCES);
    setMatchingMessageIds(EMPTY_ID_SET);
    setCurrentMatchIndex(0);
    if (!convexConvId || !cleanedHighlight) {
      setHighlightedMessageId(null);
      setSearchStatus("idle");
      return;
    }
    setSearchStatus("searching");
    let shown = false;
    walkSearchPages(
      (after) => convex.query(api.messages.findAllMessagesByContent, {
        conversation_id: convexConvId,
        search_term: cleanedHighlight,
        after_ts: after,
        ...shareTokenArg(convexConvId),
      }),
      (all, done) => {
        const instances = instancesFromMatches(all);
        setMatchInstances(instances);
        setMatchingMessageIds(new Set(all.map((m) => m.message_id)));
        if (done) setSearchStatus("done");
        if (!shown && instances.length > 0) {
          shown = true;
          navigateToHit(0, 1, instances);
        }
      },
      () => gen !== searchGenRef.current,
    ).catch((err: unknown) => {
      if (gen !== searchGenRef.current) return;
      console.warn("[ConversationView] conversation search failed", { conversationId: convexConvId, err });
      setSearchStatus("error");
    });
  }, [convexConvId, cleanedHighlight]);

  const jumpToStoryMessage = useCallback((messageId: string, timestamp: number) => {
    setDensity("full");
    setHighlightedMessageId(messageId);
    let jumped = false;
    const attempt = (tries: number) => {
      const el = containerRef.current?.querySelector(`#msg-${CSS.escape(messageId)}`);
      if (el) { el.scrollIntoView({ block: "center" }); return; }
      if (!jumped && tries >= 2 && !loadedIdsRef.current.has(messageId) && onJumpToTimestamp) {
        jumped = true;
        onJumpToTimestamp(timestamp);
      }
      if (tries < 16) setTimeout(() => attempt(tries + 1), 150);
    };
    setTimeout(() => attempt(0), 60);
  }, [onJumpToTimestamp, setDensity]);

  const handleCopyAll = () => {
    if (!convexConvId) {
      toast.error("No messages to copy");
      return;
    }

    const loadFormatted = async (): Promise<string> => {
      const allMessages: any[] = [];
      let cursor: string | null = null;
      // Safety cap: stop after ~100k messages so a corrupt cursor can't infinite-loop.
      for (let i = 0; i < 500; i++) {
        const result: any = await convex.query(api.conversations.copyAllMessages, {
          conversation_id: convexConvId,
          paginationOpts: { numItems: 200, cursor },
          ...shareTokenArg(convexConvId),
        });
        if (!result) break;
        if (result.page?.length) allMessages.push(...result.page);
        if (result.isDone) break;
        cursor = result.continueCursor;
      }
      return allMessages
        .filter((msg: any) => msg.role !== "system" && msg.subtype !== "compact_boundary")
        .map((msg: any) => {
          const ts = new Date(msg.timestamp).toLocaleString();
          const label = msg.role === "user" ? "User" : "Assistant";
          const text = formatMessagePartsForCopy(msg.content, msg.tool_calls, msg.tool_results);
          if (!text) return null;
          return `[${ts}] ${label}:\n${text}\n`;
        })
        .filter(Boolean)
        .join("\n");
    };

    toast.info("Loading all messages...");

    // Pagination requires multiple awaits, which lose transient user activation
    // and cause both execCommand("copy") and navigator.clipboard.writeText to
    // fail. ClipboardItem with a Promise is the one clipboard API that keeps
    // the write bound to the original gesture across async work.
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      const item = new ClipboardItem({
        "text/plain": loadFormatted().then((text) => {
          if (!text) throw new Error("empty");
          return new Blob([text], { type: "text/plain" });
        }),
      });
      navigator.clipboard
        .write([item])
        .then(() => toast.success("Conversation copied to clipboard"))
        .catch((err: unknown) => {
          if (err instanceof Error && err.message === "empty") {
            toast.error("No messages to copy");
          } else {
            toast.error("Failed to copy to clipboard");
          }
        });
      return;
    }

    loadFormatted()
      .then((text) => {
        if (!text) {
          toast.error("No messages to copy");
          return;
        }
        return copyToClipboard(text).then(() =>
          toast.success("Conversation copied to clipboard"),
        );
      })
      .catch(() => toast.error("Failed to copy to clipboard"));
  };

  const buildResumeCommand = useCallback((targetAgent: "claude" | "codex"): string | null => {
    if (!conversation) return null;
    const projectDir = conversation.project_path || conversation.git_root;
    const cdPrefix = projectDir ? `cd ${projectDir} && ` : "";
    const sourceAgent = conversation.agent_type === "codex" ? "codex" : "claude";
    if (targetAgent === sourceAgent && targetAgent === "codex") {
      const codexId = managedSession?.session_id || conversation.session_id;
      if (!codexId) return null;
      return `${cdPrefix}codex resume ${codexId}`;
    }
    const resumeId = conversation.short_id || managedSession?.session_id || conversation.session_id;
    if (!resumeId) return null;
    return `${cdPrefix}cast resume ${resumeId}${targetAgent !== sourceAgent ? ` --as ${targetAgent}` : ""}`;
  }, [conversation?.short_id, managedSession?.session_id, conversation?.session_id, conversation?.agent_type, conversation?.project_path, conversation?.git_root]);

  const handleCopyResumeCommand = useCallback(async (targetAgent: "claude" | "codex") => {
    try {
      const cmd = buildResumeCommand(targetAgent);
      if (!cmd) {
        toast.error("No session to resume");
        return;
      }
      await copyToClipboard(cmd);
      toast.success(`Resume command copied (${targetAgent})`);
    } catch {
      toast.error("Failed to copy");
    }
  }, [buildResumeCommand]);

  // Extract usage from loaded messages (local)
  const latestUsage = useMemo(() => {
    if (!messages || messages.length === 0) return undefined;
    return latestUsageOf(messages as any);
  }, [messages]);

  // Tool/task stats live in ConversationTaskProgress / ...MenuItem so this
  // monolith does not re-render when a streaming TodoWrite updates the store.
  // (See useConversationTaskStats.)

  // Key a message row by its STABLE client id (present on both the optimistic
  // copy as `_clientId` and the server echo as `client_id`, equal by
  // construction) so the pending→synced handoff reuses the SAME DOM node
  // instead of unmounting the optimistic row and mounting a fresh server row.
  // The `_id` flips at that handoff (clientId → Convex id); keying on it makes
  // the virtualizer destroy+recreate+re-measure the row — a one-frame blank
  // that, in a brand-new session where this is the only row, reads as the
  // message disappearing for a beat before it "syncs in".
  // uniqueRowKeys then de-collides the full set: synced data CAN carry the same
  // client_id on two messages (a delivery ack once stamped it on the harness's
  // boot <task-notification> turn AND on the real echo), and rows sharing a key
  // garble the virtualizer — overlapping ghost copies accreting on re-renders.
  const rowKeys = useMemo(() => uniqueRowKeys(timeline.map((item) => {
    if (item.type === 'message') return messageRowKey(item.data as Message);
    if (item.type === 'commit') return `commit-${(item.data as any).sha || (item.data as any)._id}`;
    if (item.type === 'external_event') return `event-${(item.data as any)._id}`;
    return `pr-${(item.data as any)._id}`;
  })), [timeline]);
  const getItemKey = useCallback((index: number) => rowKeys[index] ?? index, [rowKeys]);

  // Height-cache discriminator. In compact and condensed a row's height depends
  // on its disclosure state (compact: card vs full turn; condensed: the owner
  // row grows by its opened tool group), so the key must flip with that —
  // otherwise a toggled row reads a stale cached height and the virtualizer
  // mis-lays the list.
  const rowDensityKey = useCallback((index: number): string => {
    const base = foldWorkingTurns ? `${feedDensity}:fold` : feedDensity;
    if (feedDensity === "full" && !foldWorkingTurns) return base;
    const item = timeline[index];
    if (item?.type !== "message") return base;
    const msg = item.data as Message;
    const groupKey = foldTurns ? turnAggregates.turnKeyOf.get(msg._id) : msg._id;
    const expanded = groupKey ? expandedGroups.has(groupKey) : false;
    return `${base}:${expanded ? "e" : "c"}`;
  }, [feedDensity, foldWorkingTurns, foldTurns, timeline, turnAggregates, expandedGroups]);

  const estimateUncachedSize = useCallback((index: number) => {
    const item = timeline[index];
    if (!item) return 100;

    if (item.type === 'commit') return 80;
    // A git event is one line plus its pill row. Everything below this point
    // reads item.data as a Message, so a non-message type must return here.
    if (item.type === 'external_event') return 44;
    if (item.type === 'pull_request') return 120;

    const msg = item.data as Message;
    // Compact: a collapsed turn is one card on the first assistant message; the
    // rest of the turn is height 0 until expanded.
    if (foldTurns && msg.role === "assistant") {
      const turnKey = turnAggregates.turnKeyOf.get(msg._id);
      if (turnKey && !expandedGroups.has(turnKey)) {
        const lastText = turnAggregates.lastTextOf.get(turnKey);
        if (foldWorkingTurns) {
          if (msg._id === lastText) return 240;
          if (openAsk(msg, index, turnKey)) return 200;
          return !lastText && turnAggregates.firstAssistOf.get(turnKey) === msg._id ? 44 : 0;
        }
        if (lastText) return msg._id === lastText ? COMPACT_TAIL_HEIGHT : 0;
        return turnAggregates.firstAssistOf.get(turnKey) === msg._id ? 64 : 0;
      }
    }
    if (feedDensity === "condensed" && msg.role === "assistant") {
      // Tool-only messages folded into an earlier segment's receipt never
      // render: their tools show inside the owner's opened group.
      if (turnAggregates.absorbed.has(msg._id)) return 0;
      const hasTextContent = msg.content && msg.content.trim().length > 0;
      const receiptToolCount = turnAggregates.receiptOf.get(msg._id)?.reduce((n, e) => n + e.tools.length, 0) ?? 0;
      const groupHeight = receiptToolCount > 0 && expandedGroups.has(msg._id) ? Math.min(receiptToolCount * 36, 400) : 0;
      if (msg.tool_calls?.some(isAlwaysVisibleToolCall)) return 200 + groupHeight;
      // A tool-only receipt owner is just the one receipt row (plus its open group).
      if (!hasTextContent && receiptToolCount > 0) return 28 + groupHeight;
      if (groupHeight) return 200 + groupHeight;
    }

    if (msg.role === "system") return 8;
    if (msg.role === "user") {
      const kind = userMsgKindMap.get(msg._id);
      if (foldWorkingTurns && !FOLD_KEPT_USER_KINDS.has(kind?.kind ?? 'normal')) return kind?.kind === 'role_wake' ? 40 : 0;
      switch (kind?.kind) {
        case 'command': return 120;
        case 'bash_input': return 130;
        case 'bash_output': return commandExpansionMap.consumed.has(msg._id) ? 0 : 110;
        case 'interrupt': return 30;
        case 'machine_move': return commandExpansionMap.consumed.has(msg._id) ? 0 : 40;
        case 'agent_switch': return commandExpansionMap.consumed.has(msg._id) ? 0 : 40;
        case 'session_escalation': return kind.escalation.line ? 110 : 40;
        case 'continuation': return 30;
        case 'normal':
          if (nudgeRuns.folded.has(msg._id)) return 0;
          if (nudgeRuns.runs.has(msg._id)) return 36;
          break;
        case 'skill_expansion': return commandExpansionMap.consumed.has(msg._id) ? 0 : 44;
        case 'task_notification': return 40;
        case 'scheduled_task': return 56;
        case 'teammate_events': return 80;
        case 'task_prompt': return 0;
        case 'compaction_prompt': return 0;
        case 'compaction_summary': return 60;
        case 'noise': return 0;
        case 'tool_results_only': return 0;
        case 'empty': return 0;
        case 'poll_response': return 0;
      }
      return 100;
    }
    if (msg.role === "assistant") {
      const hasTextContent = msg.content && msg.content.trim().length > 0;
      const toolCount = msg.tool_calls?.length || 0;
      if (!hasTextContent && !msg.thinking && !msg.images?.length && toolCount === 0) return 8;
      if (!hasTextContent && toolCount > 0) return Math.min(toolCount * 20, 200);
      return 200;
    }
    return 40;
  }, [timeline, feedDensity, foldTurns, foldWorkingTurns, openAsk, userMsgKindMap, commandExpansionMap, nudgeRuns, turnAggregates, expandedGroups]);

  const estimateSize = useCallback((index: number) => {
    const estimate = estimateUncachedSize(index);
    if (estimate === 0) return 0;
    return VIRT_HEIGHT_CACHE.get(virtHeightKey(getItemKey(index), rowDensityKey(index))) ?? estimate;
  }, [estimateUncachedSize, getItemKey, rowDensityKey]);

  // Mirror @tanstack/virtual-core's default measureElement, but persist every
  // measured height into VIRT_HEIGHT_CACHE keyed by the stable item key so a
  // future mount (conversation switch, recycled scroll row) gets an accurate
  // estimateSize and skips the reflow cascade. Keyed by collapse mode because a
  // collapsed row renders different content (and height) than an expanded one.
  //
  // Attribution guard: the virtualizer files every measurement under
  // getItemKey(el.dataset.index). The data-index attribute is written at React
  // COMMIT time while getItemKey reflects the timeline at RENDER time — under a
  // deferred update (conversation switch via useDeferredValue, a pending-row
  // prune, an older-page prepend) those can disagree, so a row's height would
  // be filed under a NEIGHBORING message's key. Such a wrong entry never
  // self-corrects: the ResizeObserver only reports size CHANGES (a stable row
  // stays silent) and the no-entry path below prefers the cached belief over
  // the DOM — which is how the settled overlapping-rows / phantom-void states
  // happen. Each row stamps its own key as data-vkey; when the stamp disagrees
  // with what the virtualizer is about to attribute, return the current belief
  // (a no-op) and record nothing.
  const measureElement = useCallback((element: Element, entry: ResizeObserverEntry | undefined, instance: any) => {
    const horizontal = instance.options.horizontal;
    const index = instance.indexFromElement(element);
    const key = instance.options.getItemKey(index);
    const stampedKey = (element as HTMLElement).dataset?.vkey;
    if (stampedKey !== undefined && stampedKey !== String(key)) {
      return instance.itemSizeCache.get(key) ?? instance.options.estimateSize(index);
    }
    const box = entry?.borderBoxSize?.[0];
    let size: number;
    if (box) {
      size = Math.round(horizontal ? box.inlineSize : box.blockSize);
    } else {
      const cached = instance.itemSizeCache.get(key);
      size = cached !== undefined ? cached : (element as HTMLElement)[horizontal ? "offsetWidth" : "offsetHeight"];
    }
    if (index >= 0) recordVirtHeight(virtHeightKey(key, rowDensityKey(index)), size);
    return size;
  }, [rowDensityKey]);

  const updateScrollProgress = useCallback((instance: Virtualizer<HTMLDivElement, Element>) => {
    if (!scrollProgressRef.current || jumpPendingRef.current) return;
    const ctx = scrollCtxRef.current;
    let progress: number;
    if (ctx.messageCount > 150) {
      const items = instance.getVirtualItems();
      if (items.length === 0) return;
      const centerIdx = items[Math.floor(items.length / 2)].index;
      progress = Math.max(0, Math.min(1, (ctx.loadedStartIndex + (centerIdx / Math.max(ctx.timelineLen, 1)) * ctx.messagesLen) / ctx.messageCount));
    } else {
      const maxScroll = instance.getTotalSize() - (instance.scrollRect?.height ?? 0);
      progress = maxScroll > 0 ? Math.max(0, Math.min(1, (instance.scrollOffset ?? 0) / maxScroll)) : 1;
    }
    scrollProgressRef.current.style.height = `${progress * 100}%`;
    setNavScrollProgress(progress);
  }, []);

  const virtualizer = useVirtualizer({
    directDomUpdates: true,
    onChange: updateScrollProgress,
    count: timeline.length,
    getScrollElement: () => containerRef.current,
    getItemKey,
    estimateSize,
    measureElement,
    overscan: 10,
    paddingStart: 16,
    paddingEnd: 100,
    isScrollingResetDelay: 150,
    // Native chat anchoring (virtual-core 3.17+). The virtualizer itself owns
    // bottom-pinning because it's the only thing that knows whether *it* moved
    // the scroll or the user did — a question the old code guessed at from
    // outside with isVirtualizerCorrectingRef and got wrong (the "parked at the
    // bottom, then yanked up a page" jump).
    //   anchorTo:'end'      — when within scrollEndThreshold of the bottom, any
    //                         size change (streaming growth OR an off-screen
    //                         message above re-measuring) re-pins to the bottom;
    //                         and older-message prepends keep the visible item
    //                         stable by key (replaces the manual scrollTop+=delta
    //                         restore — running both double-shifted the view).
    //   followOnAppend:auto — follow a newly appended message ONLY if already at
    //                         the tail; a reader scrolled up is left in place.
    //   scrollEndThreshold  — the pin/follow tolerance; 8px matches the old
    //                         hand-tuned epsilon so a small real scroll-up unpins
    //                         instead of snapping back down.
    // The virtualizer's own proximity heuristic is not enough: streaming row
    // growth and re-measurements can move the geometry without user intent.
    // Gate both mechanisms on our real upward-scroll latch so a reader who left
    // the tail is never pulled back down by a newly rendered chunk.
    anchorTo: shouldFollowStreaming(userScrolled, guestStayAtTop) ? "end" : undefined,
    followOnAppend: shouldFollowStreaming(userScrolled, guestStayAtTop) ? "auto" : false,
    scrollEndThreshold: 8,
  });

  const rowLayoutsRef = useRef(new Map<string | number, string>());
  useLayoutEffect(() => {
    const previous = rowLayoutsRef.current;
    const layouts = new Map<string | number, string>();
    const corrections: { index: number; size: number }[] = [];
    const canMeasure = containerRef.current?.offsetParent != null;
    for (let index = 0; index < timeline.length; index++) {
      const key = getItemKey(index);
      const estimate = estimateUncachedSize(index);
      const layout = `${rowDensityKey(index)}:${estimate}`;
      layouts.set(key, layout);
      if (!previous.has(key) || previous.get(key) === layout) continue;
      const element = virtualizer.elementsCache.get(key) as HTMLElement | undefined;
      const mounted = canMeasure && element?.isConnected && element.dataset.index === String(index) && element.dataset.vkey === String(key);
      corrections.push({ index, size: estimate === 0 ? 0 : mounted ? element.offsetHeight : estimateSize(index) });
    }
    rowLayoutsRef.current = layouts;
    for (const { index, size } of corrections) virtualizer.resizeItem(index, size);
  }, [timeline.length, getItemKey, rowDensityKey, estimateUncachedSize, estimateSize, virtualizer]);

  scrollToBottomFnRef.current = () => {
    virtualizer.scrollToEnd({ behavior: "auto" });
  };

  // Opening or closing a condensed tool group resizes the CLICKED row at its
  // bottom (the group nests under the chip). Two things would otherwise move
  // the reader's spot: (1) the virtualizer's default rule treats a resize of
  // any row that starts above the viewport top as growth ABOVE the viewport
  // and shifts scrollTop by the delta — for a long, half-scrolled message that
  // throws the chip just clicked off the top; (2) with the reader parked at
  // the tail, anchorTo:'end' re-pins to the bottom on any size change, so the
  // opened tools push the chip up and away. So a toggle latches userScrolled
  // (the reader took the view; the tail-follow re-arms the moment they scroll
  // back down) and names its row for a short window during which that row's
  // resize leaves scrollTop alone. Every other row follows the rule in
  // shouldAdjustScrollForResize (the library rule minus its scroll-direction
  // clause — see there for why).
  const scrollHoldRef = useRef<{ key: string | number; until: number } | null>(null);
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const hold = scrollHoldRef.current;
    // getScrollOffset/scrollAdjustments are not on the public type.
    const v = instance as unknown as { getScrollOffset: () => number; scrollAdjustments: number };
    return shouldAdjustScrollForResize({
      itemStart: item.start,
      scrollOffset: v.getScrollOffset() + (v.scrollAdjustments ?? 0),
      scrollDirection: instance.scrollDirection,
      held: !!hold && item.key === hold.key && Date.now() < hold.until,
    });
  };
  const rowLookupRef = useRef({ timeline, getItemKey });
  rowLookupRef.current = { timeline, getItemKey };
  const toggleReceipt = useCallback((ownerId: string) => {
    const { timeline: tl, getItemKey: keyOf } = rowLookupRef.current;
    const index = tl.findIndex((it) => it.type === "message" && (it.data as Message)._id === ownerId);
    if (index >= 0) scrollHoldRef.current = { key: keyOf(index), until: Date.now() + 800 };
    setUserScrolled(true);
    toggleGroup(ownerId);
  }, [toggleGroup, setUserScrolled]);

  // Size-drift self-heal. If a measurement ever landed under the wrong key
  // (see the attribution guard in measureElement) — or a row changed height
  // without a ResizeObserver report — the virtualizer's believed size and the
  // DOM disagree indefinitely: the observer stays silent because the element's
  // real size isn't changing, and attach-measure echoes the cached belief.
  // That's the settled overlapping-rows / phantom-void state. Once a second,
  // outside active scrolling, feed any diverging real height back through
  // resizeItem — the same entry point an observer report uses — so the list
  // converges to DOM truth within a tick instead of staying broken until a
  // remount.
  useWatchEffect(() => {
    const tick = () => {
      // Resolve the container per-tick: at effect time (mount) the ref may not
      // be attached yet, and the [virtualizer] dep never changes identity, so
      // an early return here would disable the reconciler for good. Skip while
      // this pane is hidden (keepalive tab under display:none): every rect
      // reads 0 there, and feeding those through resizeItem would zero out the
      // hidden pane's whole layout. Plain setInterval, not rAF: rAF never fires
      // in a backgrounded tab, and drift must heal there too so the layout is
      // right the moment the user comes back.
      const container = containerRef.current;
      if (!container || container.offsetParent === null) return;
      if (virtualizer.isScrolling) return;
      const byIndex = new Map(virtualizer.getVirtualItems().map((v) => [v.index, v]));
      if (byIndex.size === 0) return;
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
      const corrections: { index: number; size: number }[] = [];
      for (const el of container.querySelectorAll<HTMLElement>("[data-index]")) {
        const v = byIndex.get(Number(el.dataset.index));
        if (!v || el.dataset.vkey !== String(v.key)) continue; // mid-commit row — skip
        // offsetHeight, NOT getBoundingClientRect: rect heights are screen px,
        // scaled by the in-app CSS zoom. Feeding scaled heights into resizeItem
        // shrank every row's believed size at zoom-out (rows overlapped into
        // garble) and the tick re-poisoned them every second. offsetHeight is
        // the same layout-px border box the virtualizer's own measurements use.
        const real = el.offsetHeight;
        if (Math.abs(real - v.size) > 1) {
          if ((window as any).__RECON_DEBUG) (((window as any).__RECON_LOG) ??= []).push({ i: v.index, from: v.size, to: real });
          corrections.push({ index: v.index, size: real });
        }
      }
      for (const { index, size } of corrections) virtualizer.resizeItem(index, size);
      // A correction while the reader sits at the tail must keep them there
      // (same contract as followOnAppend) — without this, healing the sizes
      // under a bottom-pinned view leaves the last message's tail cut off.
      if (corrections.length > 0 && nearBottom && !userScrolledRef.current && !guestStayAtTopRef.current) virtualizer.scrollToEnd({ behavior: "auto" });
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [virtualizer]);

  // Scroll to absolute top or bottom of the loaded list with retries to handle
  // virtualizer height-estimation drift. Reassigned every render so closures
  // always capture the latest timeline/virtualizer. bailOnUserScroll stops the
  // retry ladder as soon as the user scrolls somewhere on purpose (wheel latch)
  // — used by the initial open-at-bottom pin, where later retries must never
  // fight a reader who already started moving.
  const scrollToEdgeRef = useRef<(edge: 'top' | 'bottom', opts?: { bailOnUserScroll?: boolean }) => void>(() => {});
  scrollToEdgeRef.current = (edge, opts) => {
    const sc = containerRef.current;
    if (!sc) return;
    const pull = () => {
      if (opts?.bailOnUserScroll && userScrolledRef.current) return;
      if (edge === 'top') {
        if (timeline.length > 0) virtualizer.scrollToIndex(0, { align: 'start' });
        sc.scrollTop = 0;
      } else {
        if (timeline.length > 0) virtualizer.scrollToIndex(timeline.length - 1, { align: 'end' });
        sc.scrollTop = sc.scrollHeight;
      }
      // Force the virtualizer to recompute its visible range against the offset
      // we just wrote. Programmatic scrollTop writes don't reliably emit a
      // scroll event (same-value writes, batching), so without this the list can
      // paint one frame showing the items from the *previous* offset.
      queueMicrotask(() => {
        if (sc.isConnected) sc.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
    };
    pull();
    requestAnimationFrame(pull);
    [100, 300, 600].forEach((ms) => setTimeout(pull, ms));
  };

  // Fork navigation: message selection (Option+j/k to navigate, Option+f to fork)
  const [selectedMessageContent, setSelectedMessageContent] = useState<string | null>(null);
  const [selectedMessageUuid, setSelectedMessageUuid] = useState<string | null>(null);
  const handleSelectMessage = useCallback((uuid: string | null, content: string | null) => {
    setSelectedMessageUuid(uuid);
    setSelectedMessageContent(content);
  }, []);
  const handleClearSelection = useCallback(() => {
    forkSetSelectedIndex(null);
    setSelectedMessageContent(null);
    setSelectedMessageUuid(null);
  }, [forkSetSelectedIndex]);
  // Selection is scoped to its conversation, and ConversationView stays
  // mounted across session switches — without this, a rewrite preview left
  // active while switching would inject the old conversation's message into
  // the next composer.
  useWatchEffect(() => () => handleClearSelection(), [conversation?._id, handleClearSelection]);
  const forkSelectionIdx = useForkNavigationStore((s) => s.selectedIndex);
  const { selectedIndex: _forkSelIdx } = useMessageSelection({
    timeline: timeline as any,
    virtualizer,
    onForkFromMessage: forkHandler,
    onSelectMessage: handleSelectMessage,
    enabled: isOwner,
  });

  // One-shot anchor for a scroll-stable branch switch: captured at chip-click
  // time, consumed when the target branch renders. Lives in a ref because
  // ConversationView stays mounted across session switches (no key remount).
  const branchAnchorRef = useRef<{
    sourceId: string;
    targetId: string;
    messageUuid: string;
    timestamp: number;
    offset: number;
    at: number;
    jumped: boolean;
  } | null>(null);

  // BranchSelector / tree panel: switching branches is a local, store-driven switch —
  // the same instant path the sidebar uses. navigateToSession sets currentSessionId, the
  // inbox re-renders from cache, and QueuePageClient's URL-sync effect updates the address
  // bar via history.replaceState. Routing through `/conversation/{id}` here would instead
  // bounce through the redirector page (server resolveConversation + loading skeleton +
  // redirect back to /inbox) — a full reload for data the store already has.
  // null = switch to the conversation's parent (back to "main"); otherwise switch to that fork.
  const handleBranchSwitch = useCallback((messageUuid: string, convId: string | null) => {
    let targetId: string | undefined;
    if (convId === null) {
      const parentId = conversation?.forked_from;
      if (parentId) targetId = parentId.toString();
    } else {
      targetId = convId;
    }
    if (!targetId) return;
    if (targetId === conversation?._id?.toString()) return;
    // Scroll-stable switch: branches share an identical message prefix (fork
    // copy preserves message_uuid + timestamp), so remember where the fork
    // point sits in the viewport and put its twin back at the same offset
    // after the switch, instead of opening the target at its live tail.
    branchAnchorRef.current = null;
    const tl = timelineRef.current;
    const anchorIdx = tl.findIndex((it) => it.type === "message" && it.data?.message_uuid === messageUuid);
    if (anchorIdx >= 0 && conversation?._id) {
      const container = containerRef.current;
      let offset = 96;
      if (container) {
        const el = container.querySelector(`[data-index="${anchorIdx}"]`);
        if (el) {
          const rect = el.getBoundingClientRect();
          const raw = (rect.top - container.getBoundingClientRect().top) / cssZoomOf(container);
          // Negative offsets are normal — a tall fork-point message often has
          // its top above the fold while its chips sit in view; restoring the
          // raw value is what keeps the visible part stable. Only clamp so the
          // anchor row keeps a sliver in the viewport (a navigator-driven
          // switch can anchor on a fully off-screen message).
          offset = Math.min(Math.max(raw, Math.min(80 - (el as HTMLElement).offsetHeight, 0)), Math.max(container.clientHeight - 160, 0));
        }
      }
      branchAnchorRef.current = {
        sourceId: conversation._id.toString(),
        targetId,
        messageUuid,
        timestamp: tl[anchorIdx].data.timestamp,
        offset,
        at: Date.now(),
        jumped: false,
      };
    }
    // Branches are normally preloaded into the store by the effect above, so this
    // is an instant local switch. Belt-and-suspenders: if the target somehow isn't
    // cached yet (a click landing before the seed flushed), seed it from the chip's
    // own metadata so we still avoid the getConversation fetch-and-spin.
    if (!useInboxStore.getState().sessions[targetId]) {
      if (convId === null) {
        const ffd = conversation?.forked_from_details;
        if (ffd?.conversation_id) preloadForkSessions([{
          _id: ffd.conversation_id.toString(),
          title: ffd.title || "Parent session",
          inbox_dismissed_at: ffd.inbox_dismissed_at,
          inbox_stashed_at: ffd.inbox_stashed_at,
          inbox_killed_at: ffd.inbox_killed_at,
          inbox_pinned_at: ffd.inbox_pinned_at,
        }]);
      } else {
        const child = (conversation?.fork_children || []).find(f => f._id === targetId);
        const sibling = child ? undefined : (conversation?.fork_siblings || []).find(f => f._id === targetId);
        if (child) preloadForkSessions([child as ForkChild], conversation?._id?.toString());
        else if (sibling) preloadForkSessions([sibling as ForkChild], conversation?.forked_from?.toString());
      }
    }
    // The spinner is now a rare fallback (only if the switch can't resolve locally);
    // it clears when the conversation changes, or via the safety timeout below.
    setLoadingBranchId(convId === null ? "main" : targetId);
    navigateToSession(targetId);
  }, [conversation?.forked_from, conversation?._id, conversation?.fork_children, conversation?.fork_siblings, conversation?.forked_from_details, navigateToSession, preloadForkSessions]);

  // Clear the branch-switch spinner once we've landed on a new conversation, and
  // guard against a switch that never resolves (e.g. a teammate's private fork
  // the resolver denies) by timing the spinner out instead of hanging forever.
  useWatchEffect(() => {
    if (loadingBranchId) setLoadingBranchId(null);
  }, [conversation?._id]);
  useWatchEffect(() => {
    if (!loadingBranchId) return;
    const t = setTimeout(() => setLoadingBranchId(null), 8000);
    return () => clearTimeout(t);
  }, [loadingBranchId]);

  const handleTreeSwitchConversation = useCallback((convId: string) => {
    if (convId === conversation?._id?.toString()) return;
    navigateToSession(convId);
  }, [conversation?._id, navigateToSession]);

  // Open/close the branch map. Shared by the header icon, the menu item, and
  // the Ctrl+B shortcut. Always available — even a single-branch session opens
  // the map (its own branch + drillable message list); only suppressed while a
  // message-fork selection is active.
  const toggleMap = useCallback(() => {
    if (!isOwner || forkSelectionIdx !== null) return;
    setMapDrill(null); // open at the branch tree
    setTreePopoverOpen((o) => !o);
  }, [isOwner, forkSelectionIdx]);

  useShortcutContext('conversation');
  useShortcutAction('conv.toggleTree', useCallback(() => {
    if (!isOwner || forkSelectionIdx !== null) return false;
    setMapDrill(null); // open at the branch tree
    setTreePopoverOpen((o) => !o);
    return true;
  }, [isOwner, forkSelectionIdx]));

  useShortcutAction('conv.copyLink', useCallback(() => {
    const url = `${shareOrigin()}/conversation/${conversation?._id}`;
    copyToClipboard(url).then(() => toast.success("Link copied!"));
  }, [conversation?._id]));

  useShortcutAction('conv.favorite', useCallback(() => {
    if (!conversation || !isOwner) return;
    toggleFavoriteMutation(conversation._id);
    toast.success(conversation.is_favorite ? "Removed from favorites" : "Added to favorites");
  }, [conversation, isOwner, toggleFavoriteMutation]));

  // `r` = quote. With text selected inside a reply it quotes THAT selection (the
  // key behind the floating "Quote into reply" button); with nothing selected it
  // enters inline review on the assistant reply nearest the viewport center, so a
  // keyboard-only user can start quoting/commenting without a mouse.
  useShortcutAction('conv.review', useCallback(() => {
    if (!conversation) return;
    if (quoteSelectionIntoReply(conversation._id)) return;
    enterReviewNearCenter();
  }, [conversation]));

  useShortcutAction('conv.toggleDiff', useCallback(() => {
    if (!conversation?.git_branch) return;
    setDiffExpanded((s) => !s);
  }, [conversation?.git_branch]));

  useShortcutAction('conv.toggleThinking', useCallback(() => {
    if (!hasAnyThinking) return;
    setShowThinking((s) => !s);
  }, [hasAnyThinking]));

  // The header's height anchors everything that floats under it (the pinned
  // prompt bubble, the files pill, the jump toast). Bound through a callback
  // ref, not a mount effect: an effect observes whichever node the ref held at
  // mount, and once that node is replaced the observer reports the detached
  // node's height, zero, forever. The pinned bubble then sat under the header
  // with its first line cut. The ref callback follows the element instead and
  // disconnects when it leaves.
  const bindHeader = useCallback((el: HTMLElement | null) => {
    headerRef.current = el;
    if (!el) return;
    const measure = () => setHeaderHeight(el.offsetHeight);
    const ro = new ResizeObserver(measure);
    measure();
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const isZenMode = useInboxStore(s => s.clientState.ui?.zen_mode ?? false);
  const [deskClass, setDeskClass] = useState("");
  useMountEffect(() => {
    setDeskClass(desktopHeaderClass());
  });

  useWatchEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    return setupDesktopDrag(el);
  }, [deskClass]);

  useMountEffect(() => {
    // The floating scroll buttons sit just above everything below the feed —
    // composer, pinned state panel, a docked decision card — so measure that
    // whole band (pane bottom minus feed bottom), not the composer alone.
    // The feed is the flex-1 column child, so any change in the band resizes
    // it; observing feed + pane catches every case.
    const feed = containerRef.current;
    const pane = feed?.closest("main");
    if (!feed || !pane) return;
    const measure = () =>
      setMessageInputHeight(Math.max(0, Math.round(pane.getBoundingClientRect().bottom - feed.getBoundingClientRect().bottom)));
    const ro = new ResizeObserver(measure);
    measure();
    ro.observe(feed);
    ro.observe(pane);
    return () => ro.disconnect();
  });


  useWatchEffect(() => {
    const el = containerRef.current;
    if (!el) {
      if (stickyUserMsgIndices.length === 0 && !fallbackStickyContent) {
        setActiveStickyMsg(null);
        setStickyMsgVisible(false);
        setNavigatorCurrentId(null);
      }
      return;
    }
    let ticking = false;
    const check = () => {
      ticking = false;
      if ((window as any).__STICKY_DEBUG) { (((window as any).__STICKY_TOP) ??= []).push({ scrollTop: el.scrollTop, headerHeight, stickyDisabled, jumpPending: !!jumpPendingRef.current, idxCount: stickyUserMsgIndices.length, serverFb: serverStickyFallback?.id ?? null, svrLen: (serverUserMessages?.length ?? -1), hasMoreAbove: paginationPropsRef.current.hasMoreAbove, fb: !!fallbackStickyContent }); }
      // Frozen during a pending jump — the sticky header must not flip to the
      // target edge before the view actually moves there.
      if (jumpPendingRef.current) return;
      const scrollTop = el.scrollTop;
      const containerRect = el.getBoundingClientRect();
      const virtualItems = virtualizer.getVirtualItems();
      const rects = [];
      for (const v of virtualItems) {
        const domEl = el.querySelector(`[data-index="${v.index}"]`);
        if (!domEl) continue;
        const r = domEl.getBoundingClientRect();
        rects.push({ index: v.index, top: r.top, bottom: r.bottom });
      }
      const { topVisibleIndex, visible } = topVisibleIndexFromRects(rects, containerRect.top, containerRect.bottom);
      // Follow mode: while someone mirrors this window, its place in the
      // transcript rides the same measurement the sticky prompt takes. Read
      // off the store without subscribing; a window nobody follows writes
      // nothing here.
      {
        const st = useInboxStore.getState();
        if (st.followedBy.length > 0 && conversation?._id) {
          const a = anchorFromRects(rects, topVisibleIndex, containerRect.top, timelineMessageIds);
          st.setViewAnchor(a ? { conversationId: String(conversation._id), ...a } : null);
        }
      }
      const navId = resolveNavigatorCurrentId(
        navigatorTimelineIndices,
        timelineMessageIds,
        topVisibleIndex,
        serverStickyFallback?.id ?? null,
      );
      setNavigatorCurrentId(navId);

      const bannerOff = stickyDisabled && localStorage.getItem('__STICKY_FORCE') !== '1';
      const stickyResolved = resolveStickyPrompt(stickyUserMsgIndices, topVisibleIndex, visible);
      if ((window as any).__STICKY_DEBUG) { (((window as any).__STICKY_LOG) ??= []).push({ scrollTop, headerHeight, stickyDisabled, idxCount: stickyUserMsgIndices.length, topVisibleIndex, navId, stickyIdx: stickyResolved?.index ?? null, serverFb: serverStickyFallback?.id ?? null, fb: !!fallbackStickyContent, clientHeight: el.clientHeight, hasMoreAbove: paginationPropsRef.current.hasMoreAbove, svrLen: (serverUserMessages?.length ?? -1) }); }

      if (bannerOff) {
        setActiveStickyMsg(null);
        setStickyMsgVisible(false);
        return;
      }

      if (stickyResolved) {
        const item = timeline[stickyResolved.index];
        if (item?.type !== 'message') return;
        const msg = item.data as Message;
        const msgId = msg._id;
        if (dismissedStickyIdsRef.current.has(msgId)) {
          setActiveStickyMsg(null);
          setStickyMsgVisible(false);
          return;
        }
        let hideForNextMsg = false;
        const stickyBottom = headerHeight + (stickyElRef.current?.offsetHeight ?? 0);
        const nextArrayIdx = stickyUserMsgIndices.indexOf(stickyResolved.index) + 1;
        if (nextArrayIdx > 0 && nextArrayIdx < stickyUserMsgIndices.length) {
          const nextTlIdx = stickyUserMsgIndices[nextArrayIdx];
          const nextVItem = virtualItems.find(v => v.index === nextTlIdx);
          if (nextVItem) {
            const nextDom = el.querySelector(`[data-index="${nextTlIdx}"]`);
            const nextTop = nextDom
              ? nextDom.getBoundingClientRect().top - containerRect.top
              : nextVItem.start - scrollTop;
            if (nextTop < stickyBottom) hideForNextMsg = true;
          }
        }
        const prevId = prevStickyMsgIdRef.current;
        if (msgId !== prevId) {
          if (prevId !== null && prevId !== '__fallback__' && prevStickyIdxRef.current !== null) {
            stickyGapRef.current = { prevIdx: prevStickyIdxRef.current };
          }
          prevStickyMsgIdRef.current = msgId;
          prevStickyIdxRef.current = stickyResolved.index;
        }
        let inGap = false;
        if (stickyGapRef.current) {
          const gapVItem = virtualItems.find(v => v.index === stickyGapRef.current!.prevIdx);
          if (gapVItem) {
            const prevMsgTopVisual = gapVItem.start - scrollTop;
            if (prevMsgTopVisual < headerHeight + 200) {
              inGap = true;
            } else {
              stickyGapRef.current = null;
            }
          } else {
            stickyGapRef.current = null;
          }
        }
        setActiveStickyMsg({ index: stickyResolved.index, content: msg.content!, id: msgId, fromUserId: msg.from_user_id });
        setStickyMsgVisible(!stickyResolved.hidden && !inGap && !hideForNextMsg);
      } else if (serverStickyFallback) {
        prevStickyMsgIdRef.current = serverStickyFallback.id;
        prevStickyIdxRef.current = null;
        stickyGapRef.current = null;
        setActiveStickyMsg({ index: -1, content: serverStickyFallback.content, id: serverStickyFallback.id, fromUserId: serverStickyFallback.fromUserId });
        setStickyMsgVisible(true);
      } else if (fallbackStickyContent && scrollTop > el.clientHeight) {
        prevStickyMsgIdRef.current = '__fallback__';
        prevStickyIdxRef.current = null;
        stickyGapRef.current = null;
        setActiveStickyMsg({ index: -1, content: fallbackStickyContent, id: '__fallback__' });
        setStickyMsgVisible(true);
      } else {
        prevStickyMsgIdRef.current = null;
        prevStickyIdxRef.current = null;
        stickyGapRef.current = null;
        setActiveStickyMsg(null);
        setStickyMsgVisible(false);
      }
    };
    check();
    const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(check); } };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [stickyUserMsgIndices, navigatorTimelineIndices, timelineMessageIds, virtualizer, timeline, fallbackStickyContent, serverStickyFallback, headerHeight, stickyDisabled]);

  const scrollToMessageById = useCallback((messageId: string) => {
    const jump = jumpRowForMessage(messageId, feedDensity, { ...turnAggregates, nudgeHeadOf: nudgeRuns.headOf });
    if (jump.expandKey) {
      setExpandedGroups((prev) => {
        if (prev.has(jump.expandKey!)) return prev;
        const next = new Set(prev);
        next.add(jump.expandKey!);
        return next;
      });
    }
    const itemIndex = timeline.findIndex(item =>
      item.type === 'message' && item.data._id === jump.scrollToId
    );

    if (itemIndex >= 0) {
      setUserScrolled(true);
      virtualizer.scrollToIndex(itemIndex, { align: "start", behavior: "auto" });
      setHighlightedMessageId(jump.scrollToId);
      setTimeout(() => setHighlightedMessageId(null), 2000);
    } else if (conversation?._id) {
      useInboxStore.getState().requestNavigate(conversation._id, { scrollToMessageId: messageId });
    }
  }, [timeline, virtualizer, conversation?._id, feedDensity, turnAggregates, nudgeRuns]);

  useImperativeHandle(ref, () => ({
    scrollToMessage: scrollToMessageById,
  }), [scrollToMessageById]);

  const onReviewNavigate = useCallback(() => setUserScrolled(true), []);
  const reviewNavigation = useReviewNavigation(containerRef, virtualizer, scrollToMessageById, onReviewNavigate, stickyElRef);
  const reviewComposer = useMemo(() => {
    const populate = (t: string, o?: { append?: boolean }) => populateInputRef.current?.(t, o);
    return {
      quote: (text: string) => quoteToComposer(text, populate),
      submit: () => submitReview(conversation?._id ?? "", populate),
      ...reviewNavigation,
    };
  }, [conversation?._id, reviewNavigation]);

  useMountEffect(() => {
    const scrollContainer = containerRef.current;
    if (!scrollContainer) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
      // A hidden tab pane (display:none ancestor) has zero geometry: every
      // metric reads 0, which computes as "at the bottom" and would overwrite
      // the latches that remember the real reading position. Those events are
      // noise — ignore them until the pane is visible again.
      if (clientHeight === 0) return;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      const isAtBottom = distanceFromBottom < 100;
      isNearBottomRef.current = isAtBottom;

      setIsScrollable(scrollHeight > clientHeight + 10);
      // 200px edge bands hiding the jump buttons; wider than the 100px pin band.
      setIsNearTop(scrollTop < 200);
      setIsNearBottom(distanceFromBottom < 200);

      const scrolledDown = scrollTop > lastScrollTopRef.current + 2;
      const scrolledUp = scrollTop < lastScrollTopRef.current - 2;
      lastScrollTopRef.current = scrollTop;

      // Latch on ANY genuine upward scroll, not only >100px ones, so a small
      // nudge inside the 100px buffer still registers. The virtualizer owns
      // bottom-pinning natively now (anchorTo:'end'), so we no longer special-
      // case library scroll corrections here; the pagination cooldown below
      // already masks the prepend-driven offset adjustment.
      if (scrolledUp && Date.now() >= paginationCooldownRef.current) {
        setUserScrolled(true);
      }

      if (isAtBottom && scrolledDown) {
        setUserScrolled(false);
      }

      if (scrollProgressRef.current && !jumpPendingRef.current) {
        const ctx = scrollCtxRef.current;
        const totalMessages = ctx.messageCount;
        const isPaginated = totalMessages > 150;
        let progress: number;
        if (isPaginated) {
          const items = virtualizer.getVirtualItems();
          if (items.length > 0) {
            const centerIdx = items[Math.floor(items.length / 2)].index;
            const tLen = Math.max(ctx.timelineLen, 1);
            progress = totalMessages > 0 ? Math.max(0, Math.min(1, (ctx.loadedStartIndex + (centerIdx / tLen) * ctx.messagesLen) / totalMessages)) : 1;
          } else {
            progress = 0;
          }
        } else {
          const maxScroll = scrollHeight - clientHeight;
          progress = maxScroll > 0 ? scrollTop / maxScroll : 1;
        }
        scrollProgressRef.current.style.height = `${progress * 100}%`;
      }

      // Pagination in BOTH directions is owned by the wheel handler (one page
      // per scroll gesture — see maybeLoadOlderRef/maybeLoadNewerRef below).
      // Position-based triggers here proved forgeable: the virtualizer's own
      // anchor corrections re-cross any band with no user input and rip through
      // every remaining page (older: ct-33523; newer: end-anchor snap-to-bottom
      // after each append did the same on the way down).
    };

    scrollContainer.addEventListener("scroll", handleScroll);
    requestAnimationFrame(handleScroll);

    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
    };
  });

  // Freeze the reading position across a hidden spell. A background tab pane
  // is display:none, so this container's geometry collapses to zero; on
  // re-show the browser restores scrollTop, but the virtualizer treats the
  // 0→height resize as a size change and — "at the end" being trivially true
  // at zero geometry — re-pins the view to the bottom. Save the last visible
  // offset when the pane hides and re-assert it when it shows, keeping the
  // tail-follow latch off unless the reader really was at the bottom.
  const hiddenFreezeRef = useRef<{ scrollTop: number; pinned: boolean } | null>(null);
  useMountEffect(() => {
    const sc = containerRef.current;
    if (!sc) return;
    let lastHeight = sc.clientHeight;
    const ro = new ResizeObserver(() => {
      const h = sc.clientHeight;
      if (h === 0 && lastHeight > 0) {
        hiddenFreezeRef.current = { scrollTop: lastScrollTopRef.current, pinned: isNearBottomRef.current };
      } else if (h > 0 && lastHeight === 0 && hiddenFreezeRef.current) {
        const frozen = hiddenFreezeRef.current;
        hiddenFreezeRef.current = null;
        if (frozen.pinned) {
          scrollToBottomFnRef.current();
        } else {
          setUserScrolled(true);
          // Re-assert across a few ticks: the virtualizer's own resize
          // handling lands on its own schedule and must not win.
          const reassert = () => { if (Math.abs(sc.scrollTop - frozen.scrollTop) > 1) sc.scrollTop = frozen.scrollTop; };
          reassert();
          requestAnimationFrame(reassert);
          setTimeout(reassert, 80);
        }
      }
      lastHeight = h;
    });
    ro.observe(sc);
    return () => ro.disconnect();
  });

  // Load the previous (older) page when the user scrolls the content near the top.
  // The trigger is the WHEEL handler (below), not a scroll/position observer:
  // every load consumes an "arm" that only a genuine wheel-up sets, so a page is
  // pulled once per scroll-up to the top and never again on its own. This is what
  // tamed the runaway — the virtualizer re-estimates item heights after each
  // prepend, jerking scrollTop back across any position band with no user input;
  // the old rAF pump rode that thrash and ripped through every remaining page
  // from a single scroll. A wheel event is the one signal the virtualizer can't
  // forge, so loading now tracks the user's hand: stop scrolling and it stops.
  const TOP_LOAD_TRIGGER_PX = 600;
  const BOTTOM_LOAD_TRIGGER_PX = 600;
  // Pixel-perfect pagination: remember the topmost visible message and its exact
  // viewport offset; the layout effect below pins it right back after the page
  // mounts (above or below), so the text on screen never moves.
  const capturePageAnchor = (sc: HTMLElement, dir: 'older' | 'newer') => {
    const scTop = sc.getBoundingClientRect().top;
    let anchorEl: Element | null = null;
    for (const m of sc.querySelectorAll('[id^="msg-"]')) {
      if (m.getBoundingClientRect().bottom > scTop + 1) { anchorEl = m; break; }
    }
    pageAnchorRef.current = anchorEl
      ? { id: anchorEl.id, relTop: (anchorEl.getBoundingClientRect().top - scTop) / cssZoomOf(sc), scrollHeight: sc.scrollHeight, scrollTop: sc.scrollTop, dir }
      : null;
    // If the page never arrives (empty result), drop the anchor so it can't be
    // misapplied to a later streaming append.
    const captured = pageAnchorRef.current;
    if (captured) setTimeout(() => { if (pageAnchorRef.current === captured) pageAnchorRef.current = null; }, 3000);
  };
  const maybeLoadOlderRef = useRef<() => void>(() => {});
  maybeLoadOlderRef.current = () => {
    const sc = containerRef.current;
    const pp = paginationPropsRef.current;
    if (!sc || !pp.onLoadOlder) return;
    if (!loadOlderArmedRef.current) return;
    if (!shouldLoadOlder({
      nearTop: sc.scrollTop < TOP_LOAD_TRIGGER_PX,
      userScrolled: userScrolledRef.current,
      hasMoreAbove: pp.hasMoreAbove,
      isLoadingOlder: pp.isLoadingOlder,
      isLoadingNewer: pp.isLoadingNewer,
      cooldownActive: Date.now() < paginationCooldownRef.current,
    })) return;
    loadOlderArmedRef.current = false; // consume — one page per scroll-up to the top
    capturePageAnchor(sc, 'older');
    isPaginatingRef.current = true;
    // Bridge the render gap: isLoadingOlder (a prop derived from paginationStatus)
    // only flips true on the next render, so a burst of wheel events could
    // otherwise re-enter loadMore before it lands. The restore effect clears this
    // cooldown when the page settles; it also self-expires if the load stalls.
    paginationCooldownRef.current = Date.now() + 700;
    pp.onLoadOlder();
  };

  // The newer-direction mirror (reachable only in target mode — a deep-linked
  // window with content below). Same wheel-armed, anchor-pinned shape as older:
  // without it, the virtualizer's end-anchor snapped the view to the new bottom
  // after each append and the position trigger looped through every page.
  const maybeLoadNewerRef = useRef<() => void>(() => {});
  maybeLoadNewerRef.current = () => {
    const sc = containerRef.current;
    const pp = paginationPropsRef.current;
    if (!sc || !pp.onLoadNewer) return;
    if (!loadNewerArmedRef.current) return;
    if (!shouldLoadNewer({
      nearBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight < BOTTOM_LOAD_TRIGGER_PX,
      hasMoreBelow: pp.hasMoreBelow,
      isLoadingOlder: pp.isLoadingOlder,
      isLoadingNewer: pp.isLoadingNewer,
      cooldownActive: Date.now() < paginationCooldownRef.current,
    })) return;
    loadNewerArmedRef.current = false; // consume — one page per scroll-down to the bottom
    capturePageAnchor(sc, 'newer');
    isPaginatingRef.current = true;
    paginationCooldownRef.current = Date.now() + 700;
    pp.onLoadNewer();
  };

  const totalSize = virtualizer.getTotalSize();
  useWatchEffect(() => {
    updateScrollProgress(virtualizer);
  }, [conversation?.message_count, messages.length, timeline.length, conversation?.loaded_start_index, totalSize, virtualizer, updateScrollProgress]);

  // Pixel-perfect page mount, both directions. The virtualizer's own
  // anchorTo:'end' is estimate-based and doesn't hold the scroll when a page
  // mounts above (we measured the view snapping to the freshly-loaded content)
  // — and actively snaps it to the new bottom when a page mounts below while
  // the user sits at the tail of the window. So we finalize it ourselves: pin
  // the message captured at trigger time back to the EXACT viewport offset it
  // had before the load — visible text must not move a pixel.
  // It runs in a layout effect (after the virtualizer's own anchor write, before
  // paint) and targets an ABSOLUTE position, so it's idempotent: it composes with
  // the library anchor instead of fighting it (an additive scrollTop+=delta would
  // double-compensate). The rAF re-pin catches any late virtualizer/measure write.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const a = pageAnchorRef.current;
    if (!a) return;
    pageAnchorRef.current = null;
    const sc = containerRef.current;
    if (!sc) return;
    paginationCooldownRef.current = Date.now() + 500;
    const pinExact = () => {
      const el = sc.querySelector(`#${CSS.escape(a.id)}`);
      if (!el) return false;
      const correction = (el.getBoundingClientRect().top - sc.getBoundingClientRect().top) / cssZoomOf(sc) - a.relTop;
      if (correction !== 0) sc.scrollTop += correction;
      lastScrollTopRef.current = sc.scrollTop;
      return true;
    };
    if (!pinExact()) {
      // Anchor scrolled out of the render window (the estimate-based virtualizer
      // didn't hold position): coarse-restore to pull it back into view, then pin
      // it exactly on the next frame. Older pages mount ABOVE, so position shifts
      // by how much the content grew; newer pages mount BELOW, so the pre-load
      // scrollTop is still the right offset (the end-anchor snap is what moved us).
      if (a.dir === 'older') {
        const grew = sc.scrollHeight - a.scrollHeight;
        if (grew > 0) { sc.scrollTop += grew; lastScrollTopRef.current = sc.scrollTop; }
      } else {
        sc.scrollTop = a.scrollTop;
        lastScrollTopRef.current = sc.scrollTop;
      }
    }
    requestAnimationFrame(() => { pinExact(); paginationCooldownRef.current = 0; });
  }, [timeline.length]);

  // Pagination bookkeeping only. A timeline growth from loading an older/newer
  // page must NOT be seen as a fresh append by other effects (the new-item
  // settle gate at knownItemIdsRef reads isPaginatingRef), so clear the flag
  // here. Scrolling the tail into view on a genuine new message is handled
  // natively by the virtualizer (followOnAppend) — no manual scroll.
  useWatchEffect(() => {
    const hasNewMessages = timeline.length > prevTimelineLengthRef.current;
    prevTimelineLengthRef.current = timeline.length;
    if (!initialScrollDone) return;
    if (hasNewMessages && isPaginatingRef.current) {
      isPaginatingRef.current = false;
    }
  }, [timeline.length, initialScrollDone]);

  // Initial scroll: authed viewers snap to the live tail; unsigned share-link
  // visitors stay at the top so the thread reads from the beginning.
  useLayoutEffect(() => {
    if (timeline.length === 0 || initialScrollDone) return;
    const edge = initialScrollEdge({
      guest: guest || openAtTop,
      hasExplicitTarget: !!(window.location.hash || highlightQuery),
    });
    if (edge === null) {
      setInitialScrollDone(true);
      return;
    }
    // A branch switch carries its own scroll anchor (placed by the effect
    // below) — opening at the live tail would yank the view away from it.
    if (branchAnchorRef.current?.targetId === conversation?._id?.toString()) {
      setInitialScrollDone(true);
      return;
    }
    const sc = containerRef.current;
    if (sc && edge === "top") {
      // Stay at offset 0. Do not run scrollToEdge's retry ladder: that would
      // keep writing scrollTop=0 for 600ms and fight a guest who started
      // reading downward. End-follow is already off (guestStayAtTop).
      paginationCooldownRef.current = Date.now() + 1000;
      if (timeline.length > 0) virtualizer.scrollToIndex(0, { align: "start" });
      sc.scrollTop = 0;
      lastScrollTopRef.current = 0;
      setNavScrollProgress(0);
      setTimeout(() => {
        paginationCooldownRef.current = 0;
        sc.dispatchEvent(new Event("scroll"));
      }, 1000);
      setInitialScrollDone(true);
      return;
    }
    if (sc) {
      paginationCooldownRef.current = Date.now() + 1000;
      // One shot is not enough: the target offset is computed from believed
      // sizes, which on a cold open are still estimates — as rows measure in,
      // the "end" moves down by whole screens and a single scrollToIndex
      // strands the view mid-conversation (anchorTo:'end' can't rescue it
      // because the tracked offset lags the programmatic write). Re-pin on
      // the settle ladder, then keep pulling while heights keep settling —
      // stopping the moment the reader scrolls somewhere on purpose.
      scrollToEdgeRef.current('bottom', { bailOnUserScroll: true });
      lastScrollTopRef.current = sc.scrollTop;
      // Height settling has a long tail (late images, fonts, the drift
      // reconciler's 1s ticks), and the virtualizer's own end-anchor misses
      // growth that lands right after a programmatic pull — so hold the pin
      // for a while rather than trusting one ladder pass. Bails permanently
      // the moment the reader scrolls somewhere on purpose.
      const settleStart = Date.now();
      const settleId = setInterval(() => {
        const el = containerRef.current;
        if (!el || userScrolledRef.current || Date.now() - settleStart > 8000) { clearInterval(settleId); return; }
        if (el.scrollHeight - el.scrollTop - el.clientHeight > 20) scrollToEdgeRef.current('bottom', { bailOnUserScroll: true });
      }, 350);
      // Fallback: clear cooldown after virtualizer has had time to measure,
      // then re-run scroll handler so pagination fires if we're already near top.
      setTimeout(() => {
        paginationCooldownRef.current = 0;
        sc.dispatchEvent(new Event('scroll'));
      }, 1000);
    }
    setInitialScrollDone(true);
  }, [timeline.length, highlightQuery, initialScrollDone, virtualizer, guest, openAtTop]);

  // Detect user scroll-up via wheel events (fires synchronously, no race condition
  // with the async scroll event). This ensures userScrolledRef is set before any
  // re-render or auto-correct effect can run. A real wheel-up is also the only
  // thing that arms an older-page load (consumed per load below) — the signal the
  // virtualizer can't forge, which is what keeps loading from running away.
  useWatchEffect(() => {
    const sc = containerRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        setUserScrolled(true);
        loadOlderArmedRef.current = true;
        maybeLoadOlderRef.current(); // load older if this scroll-up reached the top
      } else if (e.deltaY > 0) {
        loadNewerArmedRef.current = true;
        maybeLoadNewerRef.current(); // load newer if this scroll-down reached the bottom
      }
    };
    sc.addEventListener('wheel', onWheel, { passive: true });
    return () => sc.removeEventListener('wheel', onWheel);
  }, [setUserScrolled]);

  // Bottom-pinning during streaming/new content is native now: anchorTo:'end'
  // re-pins on every item size change when within scrollEndThreshold of the
  // bottom, so the hand-rolled ResizeObserver auto-pin (and its shouldPinToBottom
  // "was I at the bottom?" heuristic) is gone.

  // After a jump (jumpToStart/jumpToEnd) the target page loads and the timeline
  // swaps to the new window. We scroll to the target edge in a *layout* effect —
  // the same commit as the swap, before the browser paints — so the user sees a
  // single jump (old position → edge), never the freshly-loaded content sitting
  // at the old scroll offset. The jumpDirectionRef guard ensures this fires only
  // for a real jump (not the button click or normal pagination); the isLoading
  // guard waits for the real data (the timeline transiently holds stale
  // normal-mode fallback messages while the first page is loading).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!isJumpReadyToScroll({
      direction: jumpDirectionRef.current,
      hasTimeline: timeline.length > 0,
      isLoadingOlder: paginationPropsRef.current.isLoadingOlder,
      isLoadingNewer: paginationPropsRef.current.isLoadingNewer,
    })) return;
    const dir = jumpDirectionRef.current!;
    jumpDirectionRef.current = null;
    paginationCooldownRef.current = Date.now() + 900;
    setUserScrolled(dir === 'start');
    if (dir === 'end') setGuestStayAtTop(false);

    scrollToEdgeRef.current(dir === 'start' ? 'top' : 'bottom');

    // Indicators were frozen for the whole pending window; snap them to the edge
    // we just landed on so they move in lockstep with this single jump rather
    // than lying ("at the top") while the content was still elsewhere.
    const edgeProgress = dir === 'start' ? 0 : 1;
    if (scrollProgressRef.current) scrollProgressRef.current.style.height = `${edgeProgress * 100}%`;
    setNavScrollProgress(edgeProgress);

    // Release the freeze NOW, in this same commit. The scroll above is
    // synchronous, so the paint that shows the edge also shows the spinner
    // gone and the indicators snapped — truly atomic. Do NOT defer this to a
    // requestAnimationFrame: a hidden/occluded tab never fires one (macOS
    // occlusion tracking), so the jump would land but jumpPending stayed set
    // — stuck spinner, frozen indicators — until the tab was next visible;
    // and under timeline churn a canceled rAF left it stuck forever. The
    // pagination cooldown set above self-expires, which also keeps the
    // scrollToEdge retry tail (100-600ms) from triggering an auto-load.
    setJumpPending(null);
  }, [timeline, virtualizer]);

  // Cancel an in-flight jump (clicking the spinner) — leave the user exactly
  // where they are. Clear jumpDirectionRef FIRST so the completion effect above
  // won't fire a scroll, hide the spinner, then exit target mode (onJumpToEnd).
  // We deliberately do NOT scroll: during a start-jump the on-screen content is
  // still the pre-jump window (the normal subscription is kept alive across the
  // jump — see useConversationMessages — so that window never collapsed), so
  // simply dropping the target overlay leaves scrollTop pointing at the same
  // content. Releasing the freeze lets the indicators recompute to match.
  const handleCancelJump = useCallback(() => {
    jumpDirectionRef.current = null;
    setJumpPending(null);
    paginationCooldownRef.current = Date.now() + 500;
    onJumpToEnd?.();
  }, [onJumpToEnd, setJumpPending]);

  const scrollToHash = useCallback(() => {
    if (!timeline.length || !window.location.hash) return;
    if (targetMessageId && !hasScrolledToTarget.current) return;
    const targetId = window.location.hash.slice(1);
    const itemIndex = timeline.findIndex(item => {
      if (item.type === 'message') {
        return `msg-${item.data._id}` === targetId;
      } else if (item.type === 'commit') {
        return `commit-${item.data.sha}` === targetId;
      }
      return false;
    });
    if (itemIndex >= 0) {
      setUserScrolled(true);
      const item = timeline[itemIndex];
      const msgId = item.type === 'message' ? item.data._id : null;
      setTimeout(() => {
        virtualizer.scrollToIndex(itemIndex, { align: "center", behavior: "smooth" });
        if (msgId) {
          setHighlightedMessageId(msgId);
          setTimeout(() => setHighlightedMessageId(null), 3000);
        }
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }, 100);
    }
  }, [timeline, virtualizer, targetMessageId]);

  useWatchEffect(() => {
    scrollToHash();
  }, [timeline.length, virtualizer, targetMessageId]);

  useEventListener("hashchange", () => scrollToHash());

  // Rows that hold a hit at the current density — a folded tool message maps
  // to the row it shows inside — so the dimming of everything else does not
  // grey out the very row the active mark lives in.
  const matchRowIds = useMemo(() => {
    if (matchingMessageIds.size === 0) return EMPTY_ID_SET;
    const rows = new Set<string>();
    const aggregates = { ...turnAggregates, nudgeHeadOf: nudgeRuns.headOf };
    for (const id of matchingMessageIds) rows.add(jumpRowForMessage(id, feedDensity, aggregates).scrollToId);
    return rows;
  }, [matchingMessageIds, feedDensity, turnAggregates, nudgeRuns]);

  // Bring the pending search hit into view. One owner for the whole motion:
  // ask the server for the window when the message is not loaded, open the
  // fold it sits in at this density, scroll the virtualizer to its row, then
  // scroll the mark itself into view once the row has rendered its text. A
  // short poll rather than fixed timers, so a slow mount (a long transcript
  // under load) still lands; a hit that never renders a mark (a row the
  // transcript hides, text inside a tag the renderer strips) is skipped in
  // the direction of travel. planActivation (lib/conversationSearch) decides
  // each step; this effect only reads the DOM and acts.
  useWatchEffect(() => {
    void activationTick; void messages; void expandedGroups;
    if (!pendingHitRef.current) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (cancelled) return;
      const hit = pendingHitRef.current;
      const container = containerRef.current;
      if (!hit || !container) return;
      const jump = jumpRowForMessage(hit.messageId, feedDensity, { ...turnAggregates, nudgeHeadOf: nudgeRuns.headOf });
      const rowIndex = timeline.findIndex((item) => item.type === 'message' && item.data._id === jump.scrollToId);
      // The virtualizer's wrapper, not `#msg-<id>`: command cards, plan and
      // skill blocks and system rows carry no message id, but their marks
      // live inside the wrapper all the same.
      const rowEl = rowIndex >= 0 ? container.querySelector(`[data-index="${rowIndex}"]`) : null;
      const marks = searchMarksIn(rowEl, hit.messageId);
      const loaded = loadedIdsRef.current.has(hit.messageId);
      const now = Date.now();
      if (loaded && hit.loadedAt === undefined) hit.loadedAt = now;
      const step = planActivation(hit, {
        loaded,
        rowIndex,
        expandKey: jump.expandKey,
        expanded: jump.expandKey ? expandedGroups.has(jump.expandKey) : false,
        mounted: !!rowEl,
        markCount: marks.length,
        canJump: !!onJumpToTimestamp,
        elapsedMs: now - hit.startedAt,
        sinceLoadedMs: hit.loadedAt === undefined ? 0 : now - hit.loadedAt,
      });
      switch (step.kind) {
        case "jump":
          hit.jumped = true;
          onJumpToTimestamp?.(hit.timestamp);
          break;
        case "expand":
          setExpandedGroups((prev) => {
            if (prev.has(step.key)) return prev;
            const next = new Set(prev);
            next.add(step.key);
            return next;
          });
          return; // the effect re-runs on expandedGroups
        case "scrollRow":
          setUserScrolled(true);
          virtualizer.scrollToIndex(step.index, { align: "start", behavior: "auto" });
          container.dispatchEvent(new Event('scroll', { bubbles: true }));
          break;
        case "wait":
          break;
        case "dead": {
          const next = skipDeadHit(hit, currentMatchIndexRef.current, matchInstancesRef.current, Date.now());
          if (!next) { pendingHitRef.current = null; return; }
          pendingHitRef.current = next.hit;
          setCurrentMatchIndex(next.index);
          setHighlightedMessageId(next.hit.messageId);
          break;
        }
        case "activate": {
          const target = marks[step.markIndex];
          markActive(container, target);
          setActiveHit({ messageId: hit.messageId, localIndex: step.markIndex });
          setUserScrolled(true);
          // Scroll the feed itself (not every ancestor, as scrollIntoView
          // would) so the mark sits in the band the reader can actually see:
          // below the sticky prompt that floats over the top of the feed.
          const placeInBand = () => {
            const c = container.getBoundingClientRect();
            const top = Math.max(c.top, stickyElRef.current?.getBoundingClientRect().bottom ?? c.top);
            const r = target.getBoundingClientRect();
            if (r.top >= top + 8 && r.bottom <= c.bottom - 8) return;
            const goal = top + (c.bottom - top) * 0.4;
            container.scrollTop += r.top + r.height / 2 - goal;
          };
          placeInBand();
          pendingHitRef.current = null;
          // The virtualizer re-measures rows as their content mounts (code
          // blocks, images), and a server jump scrolls to its own center a
          // beat later; either can shove the mark out of view. Look again,
          // until a newer hit takes over or the reader moves the feed
          // themselves. Its own token, not the effect's cancel flag: this
          // effect re-runs on every new message.
          const seq = ++activationSeqRef.current;
          let readerMoved = false;
          const onReader = () => { readerMoved = true; };
          const readerEvents = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
          for (const ev of readerEvents) container.addEventListener(ev, onReader, { passive: true, once: true });
          const settle = (last: boolean) => {
            if (last) for (const ev of readerEvents) container.removeEventListener(ev, onReader);
            if (readerMoved || seq !== activationSeqRef.current || !target.isConnected) return;
            placeInBand();
          };
          for (const ms of [250, 700, 1500, 3000]) setTimeout(() => settle(ms === 3000), ms);
          return;
        }
      }
      // A jump in flight resolves through `messages`, which re-runs this
      // effect; polling it fast only burns the main thread.
      timer = setTimeout(tick, step.kind === "wait" && !loadedIdsRef.current.has(hit.messageId) ? 500 : 100);
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [activationTick, messages, expandedGroups, timeline, feedDensity]);

  // Keep the active hit painted. Runs after every render while a hit is
  // active (two selector lookups): a row that scrolled out and back, or a
  // message that re-rendered, comes back with plain marks.
  const activeRowIndex = useMemo(() => {
    if (!activeHit) return -1;
    const rowId = jumpRowForMessage(activeHit.messageId, feedDensity, { ...turnAggregates, nudgeHeadOf: nudgeRuns.headOf }).scrollToId;
    return timeline.findIndex((item) => item.type === 'message' && item.data._id === rowId);
  }, [activeHit, timeline, feedDensity, turnAggregates, nudgeRuns]);
  useWatchEffect(() => {
    const container = containerRef.current;
    if (!activeHit || activeRowIndex < 0 || !container) return;
    const marks = searchMarksIn(container.querySelector(`[data-index="${activeRowIndex}"]`), activeHit.messageId);
    const target = marks[Math.min(activeHit.localIndex, marks.length - 1)];
    if (target && !target.hasAttribute('data-search-active')) markActive(container, target);
  });

  useWatchEffect(() => {
    if (!targetMessageId || timeline.length === 0 || hasScrolledToTarget.current) {
      return;
    }

    const jump = jumpRowForMessage(targetMessageId, feedDensity, { ...turnAggregates, nudgeHeadOf: nudgeRuns.headOf });
    if (jump.expandKey && !expandedGroups.has(jump.expandKey)) {
      setExpandedGroups((prev) => {
        if (prev.has(jump.expandKey!)) return prev;
        const next = new Set(prev);
        next.add(jump.expandKey!);
        return next;
      });
      return;
    }

    const itemIndex = timeline.findIndex(item => {
      if (item.type === 'message') {
        return item.data._id === jump.scrollToId;
      }
      return false;
    });

    if (itemIndex >= 0) {
      hasScrolledToTarget.current = true;
      setUserScrolled(true);
      const container = containerRef.current;
      if (!container) return;

      const targetItem = timeline[itemIndex];
      const scrollToId = jump.scrollToId;
      settleTimelineItemAtOffset(container, virtualizer, itemIndex, 50, {
        // A same-session jump starts on the tail timeline and the target-mode
        // window then replaces it — identity + re-resolution keep the settle
        // on the target row across that swap.
        itemKey: targetItem?.type === "message" ? messageRowKey(targetItem.data as Message) : undefined,
        resolveIndex: () =>
          timelineRef.current.findIndex(
            (item: any) => item.type === "message" && item.data._id === scrollToId,
          ),
        onSettled: () => {
          setHighlightedMessageId(scrollToId);
          setTimeout(() => setHighlightedMessageId(null), 3000);
          if (window.location.hash) {
            history.replaceState(null, "", window.location.pathname + window.location.search);
          }
        },
      });
    }
  }, [targetMessageId, targetNonce, timeline, virtualizer, feedDensity, turnAggregates, expandedGroups, nudgeRuns]);

  // Land a branch switch scroll-stable: once the target conversation renders,
  // find the fork-point message (same message_uuid — fork copies preserve it)
  // and restore it to the viewport offset captured at click time. Everything
  // above the fork point is identical between branches, so the switch reads as
  // "only the content below the fork changed". If the fork point is outside
  // the target's loaded window, jump the window to the fork point's timestamp
  // (also preserved by the copy) and place the anchor when that window lands.
  // Layout effect so the placement happens in the same commit that gated the
  // initial snap-to-bottom above — no bottom-flash in between.
  useLayoutEffect(() => {
    const anchor = branchAnchorRef.current;
    if (!anchor) return;
    if (Date.now() - anchor.at > 15000) {
      // Stale capture from a switch that never landed — don't ambush a later visit.
      branchAnchorRef.current = null;
      return;
    }
    const convId = conversation?._id?.toString();
    if (!convId) return;
    if (convId !== anchor.targetId) {
      // Wandered off to an unrelated conversation — drop the anchor.
      if (convId !== anchor.sourceId) branchAnchorRef.current = null;
      return;
    }
    const itemIndex = timeline.findIndex(
      (item) => item.type === "message" && item.data.message_uuid === anchor.messageUuid
    );
    if (itemIndex >= 0) {
      branchAnchorRef.current = null;
      const container = containerRef.current;
      if (!container) return;
      setUserScrolled(true);
      settleTimelineItemAtOffset(container, virtualizer, itemIndex, anchor.offset, { initialDelayMs: 0 });
    } else if (!anchor.jumped) {
      anchor.jumped = true;
      // No window-jump available (embedded views) — fall back to the default landing.
      if (onJumpToTimestamp) onJumpToTimestamp(anchor.timestamp);
      else branchAnchorRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?._id, timeline, virtualizer, onJumpToTimestamp, setUserScrolled]);

  // Cycle the three local feed densities; the LLM views stay dropdown-only.
  // Bound through the shortcut registry (not a raw keydown) so the key combo, this
  // handler, and every tooltip / help-panel mention all read from one definition —
  // rebind 'conv.cycleDensity' once and the binding and its docs move together.
  useShortcutAction('conv.cycleDensity', useCallback(() => {
    setDensity(FEED_DENSITY_CYCLE[(FEED_DENSITY_CYCLE.indexOf(feedDensity) + 1) % FEED_DENSITY_CYCLE.length]);
  }, [feedDensity, setDensity]));

  const title = cleanTitle(conversation?.title || "New Session");
  const truncatedTitle = title.length > 60 ? title.slice(0, 57) + "..." : title;
  const latestMessageTimestamp = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item.type === 'message' && (item.data as Message).role !== 'system') {
        return item.timestamp;
      }
    }
    return undefined;
  }, [timeline]);
  // ConversationView stays mounted across session switches. Stamp the last
  // moment we saw this row producing so a mid-turn session whose loaded tail
  // is days old is not labeled "3d ago" under a response that just landed.
  const lastLiveAtRef = useRef({ id: "", at: 0 });
  const convIdForLive = conversation?._id ? String(conversation._id) : "";
  if (lastLiveAtRef.current.id !== convIdForLive) lastLiveAtRef.current = { id: convIdForLive, at: 0 };
  if (isProducingAgentStatus(managedSession?.agent_status)) lastLiveAtRef.current.at = Date.now();
  const lastActivityAt = Math.max(latestMessageTimestamp ?? 0, lastLiveAtRef.current.at)
    || conversation?.updated_at
    || conversation?.started_at
    || 0;
  const lastMessageRole = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item.type === 'message' && (item.data as Message).role !== 'system') {
        return (item.data as Message).role;
      }
    }
    return undefined;
  }, [timeline]);
  // What is in flight, for the "working" status line: a multi-minute deploy
  // reads as "Working · 3:14 · running deploy.sh". The composer prefers the
  // row's server side activity stamp; this is its fallback from the loaded
  // timeline. See deriveRunningPhrase.
  const workingPhrase = useMemo(() => deriveRunningPhrase(timeline), [timeline]);
  // Clock for the liveness booleans below. Re-renders THIS whole view only when
  // one of them would flip (45s / 5min since last activity; 30s / 120s of age),
  // not on every tick — an unconditional 10s ticker re-rendered the entire
  // conversation view (60–250ms) forever, for three booleans.
  const startedAtForClock = conversation?.started_at ?? 0;
  const now = useNowWhen(
    (t) => {
      const idle = t - lastActivityAt;
      const age = t - startedAtForClock;
      return `${idle < 45 * 1000 ? 1 : 0}${idle < 5 * 60 * 1000 ? 1 : 0}${age < SESSION_STARTING_GRACE_MS ? 1 : 0}${age < 120_000 ? 1 : 0}`;
    },
    10_000,
  );
  const isSessionConnected = !!conversation && conversation.status === "active" && (now - lastActivityAt) < 5 * 60 * 1000;
  const isWorking = isSessionConnected && (now - lastActivityAt) < 45 * 1000 && lastMessageRole === "assistant";
  const isConversationLive = isWorking;
  const isSessionDisconnected = !!conversation && conversation.status === "active" && !!managedSession && !managedSession.is_connected && !isSessionConnected;
  const sessionAge = now - (conversation?.started_at ?? 0);
  const isNewEmptySession = !!conversation && conversation.status === "active" && (conversation.message_count ?? 0) === 0;
  // A fresh fork has messages but no daemon yet — give it the same
  // "Starting session…" → "Ready" lifecycle above the input as a new session.
  const isFreshFork = !!conversation && conversation.status === "active" && !!conversation.forked_from && sessionAge < 120_000;
  // Same Starting…/Ready rule the inbox row renders, so the two never disagree
  // (see lib/sessionLifecycle). The < 120_000 visibility gate keeps the affordance
  // off an old-but-still-empty session — past it, it's just a normal live session.
  const isFreshSession = isNewEmptySession || isFreshFork;
  const sessionStartup = sessionStartupState({ isConnected: managedSession?.is_connected, ageMs: sessionAge });
  const isSessionStarting = isFreshSession && sessionStartup === "starting";
  const isSessionReady = isFreshSession && sessionStartup === "ready" && sessionAge < 120_000;

  // The header dropdown's single "Restart session" action. One click drives both
  // recovery codepaths (resume-first, then a forced rebuild if it doesn't come
  // live) so a session is never left dead — see useSessionRestart. "Live" is any
  // authoritative sign the session is up: daemon-connected, the agent active, or
  // recent assistant activity.
  const restartLive =
    !!managedSession?.is_connected ||
    isConversationLive ||
    isThinking ||
    isActiveAgentStatus(managedSession?.agent_status as LiveAgentStatus | undefined);
  const restartGhostContext = useCallback(
    () => (conversation?._id ? ghostRestartContextFor(conversation._id) : {}),
    [conversation?._id],
  );
  const onRestartRestored = useCallback(
    (res: unknown) => (conversation?._id ? followRestoredConversation(res, conversation._id) : false),
    [conversation?._id],
  );
  const restartNotify = useCallback((kind: "success" | "error" | "info", message: string) => {
    if (kind === "error") toast.error(message);
    else if (kind === "success") toast.success(message);
    else toast(message);
  }, []);
  const {
    restart: handleRestartSession,
    isRestarting: isHeaderRestarting,
    phase: restartPhase,
    stage: restartStripStage,
    failure: restartFailure,
    startedAt: restartStartedAt,
  } = useSessionRestart({
    conversationId: conversation?._id ?? "",
    isLive: restartLive,
    ghostContext: restartGhostContext,
    onRestored: onRestartRestored,
    notify: restartNotify,
  });

  const togglePublicProfilePin = () => {
    if (!conversation || !isOwner) return;
    const pinned = !!conversation.profile_pinned_at;
    void (pinned ? unpinFromProfile({ conversation_id: conversation._id as any }) : pinToProfile({ conversation_id: conversation._id as any }))
      .then(() => toast.success(pinned ? "Removed from your public profile" : "Pinned — this session is now public on your profile"))
      .catch((error) => { captureException(error); toast.error(error instanceof Error ? error.message : "Failed to update profile pin"); });
  };

  const codeRouter = useRouter();
  const codeRepository = conversation ? sessionRepository(conversation) : null;
  usePaletteSessionCommands(conversation?._id, [
    { key: "view_restart", label: "Restart session", icon: PaletteRestart, available: !!isOwner && !!conversation?.session_id, run: handleRestartSession },
    { key: "view_profile_pin", label: conversation?.profile_pinned_at ? "Unpin from public profile" : "Pin to public profile", icon: PalettePin, available: !!isOwner, run: togglePublicProfilePin },
    { key: "view_copy_all", label: "Copy all messages", icon: PaletteCopy, run: handleCopyAll },
    { key: "view_resume_claude", label: "Copy Claude resume command", icon: PaletteCopy, available: !!conversation?.session_id, run: () => { void handleCopyResumeCommand("claude"); } },
    { key: "view_resume_codex", label: "Copy Codex resume command", icon: PaletteCopy, available: !!conversation?.session_id, run: () => { void handleCopyResumeCommand("codex"); } },
    { key: "view_tmux", label: "Copy tmux attach command", icon: PaletteCopy, available: !!managedSession?.tmux_session, run: copyTmuxAttach },
    { key: "view_search", label: "Search in conversation", icon: PaletteSearch, run: () => { setIsLocalSearchOpen(true); setLocalSearchQuery(""); setTimeout(() => localSearchInputRef.current?.focus(), 0); } },
    { key: "view_thinking", label: showThinking ? "Hide thinking" : "Show thinking", icon: PaletteEye, shortcutAction: "conv.toggleThinking", available: hasAnyThinking, run: () => setShowThinking(s => !s) },
    { key: "view_context", label: showSessionContext ? "Hide schedule and plan" : "Show schedule and plan", icon: PaletteEye, available: minimalStyle, run: () => updateUI({ show_session_context: !showSessionContext }) },
    { key: "view_sticky", label: stickyDisabled ? "Enable sticky headers" : "Disable sticky headers", icon: PalettePin, run: () => { updateUI({ sticky_headers_disabled: !stickyDisabled }); setStickyMsgVisible(false); setActiveStickyMsg(null); } },
    { key: "view_source", label: "Browse repository source", icon: PaletteBranch, available: !!codeRepository, run: () => { if (codeRepository) codeRouter.push(repoTreeHref(codeRepository, conversation?.git_branch || "HEAD")); } },
    { key: "view_history", label: "Browse commit history", icon: PaletteBranch, available: !!codeRepository, run: () => { if (codeRepository) codeRouter.push(repoCommitsHref(codeRepository, conversation?.git_branch || "HEAD")); } },
    { key: "view_diff", label: diffExpanded ? "Hide git diff" : "Show git diff", icon: PaletteBranch, available: !!conversation?.git_branch, run: () => setDiffExpanded(s => !s) },
    { key: "view_branches", label: "Branch map", icon: PaletteBranch, shortcutAction: "conv.toggleTree", available: !!isOwner, run: toggleMap },
    { key: "view_density", label: "Cycle message density", icon: PaletteRows, shortcutAction: "conv.cycleDensity", run: () => setDensity(DENSITY_OPTIONS[(DENSITY_OPTIONS.findIndex(o => o.value === density) + 1) % DENSITY_OPTIONS.length].value) },
  ]);
  const { globalToolResultMap, globalImageMap, globalFileMap, filePathBase, filePathCtx } = useToolResultMaps({ conversation, codeRepository });
  // What this transcript is nested in, plus itself: the bound a reveal band
  // in it checks before showing a conversation (lib/revealHost).
  const revealAncestry = useRevealAncestryWith(conversation?._id ?? "");
  const inRevealBand = useContext(RevealInBandCtx);
  // Keyed on the conversation as well as the band: one instance of this view
  // serves every session the inbox selects, and a fold left over from the
  // session that hosted a band used to follow the reader to the next one.
  const hostingReveal = useHostsReveal(headerRef, "[data-cc-conversation]", effectiveConversationId);
  const compactChrome = inRevealBand || hostingReveal;
  const { browserRowMap, lastBrowserPage, browserSession, chatWakeMap } = useBrowserAndWakeRows({ conversation, globalToolResultMap, managedSession, userMsgKindMap });
  const { sessionGalleryImages } = useSessionImages({ deferredQueriesEnabled, conversation });
  const { taskSubjectMap, taskRecordMap } = useConversationTaskMaps({ conversation, deferredQueriesEnabled });

  const getPreviousNonToolResultMessage = (index: number): Message | null => {
    for (let i = index - 1; i >= 0; i--) {
      const prevItem = timeline[i];
      if (!prevItem || prevItem.type !== "message") continue;
      const prevMsg = prevItem.data as Message;
      if (prevMsg.role === "user") {
        const kind = userMsgKindMap.get(prevMsg._id);
        if (kind?.kind === 'tool_results_only' || kind?.kind === 'command' || kind?.kind === 'bash_input' || kind?.kind === 'bash_output') continue;
      }
      return prevMsg;
    }
    return null;
  };

  // Caches for renderItem's per-row derived props (see the assistant branch).
  // Keyed by the message row object, which the store keeps identity-stable
  // until the message itself changes; entries validate against the inputs
  // they were derived from, and reuse the previous array when its contents
  // did not change (a new timeline array from an unrelated append must not
  // hand every row a fresh runMessageIds).
  const assistantRowCacheRef = useRef(new WeakMap<Message, { timeline: TimelineItem[]; messageAuthors: typeof messageAuthors; showThinking: boolean; isFirstInSequence: boolean; runMessageIds: string[] }>());
  const assistantRowDerived = (msg: Message, index: number) => {
    const cache = assistantRowCacheRef.current;
    const hit = cache.get(msg);
    if (hit && hit.timeline === timeline && hit.messageAuthors === messageAuthors && hit.showThinking === showThinking) return hit;
    // Find previous VISIBLE non-commit assistant item to determine if this is first in assistant sequence
    // Skip invisible assistant messages (those whose content is only system tags with no tool calls/thinking/images)
    let prevIdx = index - 1;
    while (prevIdx >= 0) {
      const checkItem = timeline[prevIdx];
      if (checkItem.type === 'commit') { prevIdx--; continue; }
      if (checkItem.type !== 'message') break;
      const checkMsg = checkItem.data as Message;
      if (checkMsg.role !== 'assistant') break;
      const hasVisibleContent = (checkMsg.content && stripSystemTags(checkMsg.content).trim().length > 0)
        || (checkMsg.tool_calls && checkMsg.tool_calls.length > 0)
        || (showThinking && checkMsg.thinking && checkMsg.thinking.trim().length > 0)
        || (checkMsg.images && checkMsg.images.length > 0);
      if (hasVisibleContent) break;
      prevIdx--;
    }
    const prevItem = prevIdx >= 0 ? timeline[prevIdx] : null;
    const prevMsg = prevItem?.type === 'message' ? (prevItem.data as Message) : null;
    const isFirstInSequence = !prevMsg || prevMsg.role !== "assistant" || !sameMessageAuthor(prevMsg, msg, messageAuthors) || msg.timestamp - prevMsg.timestamp > GROUP_WINDOW_MS;
    // Compute all message IDs in the current run (for sharing)
    let runMessageIds: string[] = [];
    for (let i = index; i >= 0; i--) {
      const checkItem = timeline[i];
      if (!checkItem) break;
      if (checkItem.type !== 'message') continue;
      const checkMsg = checkItem.data as Message;
      if (checkMsg.role === "user") break;
      if (checkMsg.role === "assistant") runMessageIds.unshift(checkMsg._id);
    }
    for (let i = index + 1; i < timeline.length; i++) {
      const checkItem = timeline[i];
      if (!checkItem) break;
      if (checkItem.type !== 'message') continue;
      const checkMsg = checkItem.data as Message;
      if (checkMsg.role === "user") break;
      if (checkMsg.role === "assistant") runMessageIds.push(checkMsg._id);
    }
    if (hit && sameStringArray(hit.runMessageIds, runMessageIds)) runMessageIds = hit.runMessageIds;
    const entry = { timeline, messageAuthors, showThinking, isFirstInSequence, runMessageIds };
    cache.set(msg, entry);
    return entry;
  };
  const toolResultsCacheRef = useRef(new WeakMap<Message, { globalToolResultMap: typeof globalToolResultMap; results: ToolResult[] | undefined }>());
  const relevantToolResultsFor = (msg: Message): ToolResult[] | undefined => {
    const cache = toolResultsCacheRef.current;
    const hit = cache.get(msg);
    if (hit && hit.globalToolResultMap === globalToolResultMap) return hit.results;
    let results = msg.tool_calls
      ?.map(tc => msg.tool_results?.find((tr) => tr.tool_use_id === tc.id) || globalToolResultMap[tc.id])
      .filter((tr): tr is ToolResult => tr !== undefined);
    if (hit && hit.results && results && hit.results.length === results.length && hit.results.every((r, i) => r === results![i])) results = hit.results;
    cache.set(msg, { globalToolResultMap, results });
    return results;
  };

  // Same identity discipline for the condensed/compact per-row objects: a fresh
  // `{entries, expanded, onToggle}` per render re-rendered every visible row on
  // every virtualizer pass in condensed view.
  const receiptCacheRef = useRef(new WeakMap<Message, { entries: ReceiptEntry[]; expanded: boolean; toggleReceipt: typeof toggleReceipt; value: CondensedReceipt | undefined }>());
  const condensedReceiptFor = (msg: Message, entries: ReceiptEntry[], expanded: boolean): CondensedReceipt | undefined => {
    if (!entries.length) return undefined;
    const cache = receiptCacheRef.current;
    const hit = cache.get(msg);
    if (hit && hit.entries === entries && hit.expanded === expanded && hit.toggleReceipt === toggleReceipt) return hit.value;
    const value = { entries, expanded, onToggle: () => toggleReceipt(msg._id) };
    cache.set(msg, { entries, expanded, toggleReceipt, value });
    return value;
  };
  const collapseHandlerCacheRef = useRef(new WeakMap<Message, { turnKey: string; toggleGroup: typeof toggleGroup; fn: () => void }>());
  const collapseTurnHandlerFor = (msg: Message, turnKey: string) => {
    const cache = collapseHandlerCacheRef.current;
    const hit = cache.get(msg);
    if (hit && hit.turnKey === turnKey && hit.toggleGroup === toggleGroup) return hit.fn;
    const fn = () => toggleGroup(turnKey);
    cache.set(msg, { turnKey, toggleGroup, fn });
    return fn;
  };

  // A client that forks natively copies its whole context (grok), so its fork
  // control is offered on the latest message only; rebuild/API clients fork
  // from any message. The tip is the last timeline message carrying a uuid.
  const forkAnyMessage = agentForksFromAnyMessage(conversation?.agent_type);
  const forkTipUuid = useMemo(() => {
    if (forkAnyMessage) return undefined;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const it = timeline[i];
      if (it.type === 'message' && it.data.message_uuid) return it.data.message_uuid;
    }
    return undefined;
  }, [forkAnyMessage, timeline]);
  const forkHandlerFor = (messageUuid: string | undefined) =>
    forkHandler && (forkAnyMessage || (!!messageUuid && messageUuid === forkTipUuid)) ? forkHandler : undefined;

  const renderItem = (item: TimelineItem, index: number) => {
    if (!item || index < 0 || index >= timeline.length) return null;
    if (item.type === 'commit') {
      const commit = item.data;
      return (
        <CommitCard
          key={commit._id}
          sha={commit.sha}
          message={commit.message}
          timestamp={commit.timestamp}
          filesChanged={commit.files_changed}
          insertions={commit.insertions}
          deletions={commit.deletions}
          authorName={commit.author_name}
          authorEmail={commit.author_email}
          repository={commit.repository}
          files={commit.files}
        />
      );
    }

    if (item.type === 'pull_request') {
      const pr = item.data;
      return (
        <PRCard
          key={pr._id}
          _id={pr._id}
          number={pr.number}
          title={pr.title}
          body={pr.body}
          state={pr.state}
          repository={pr.repository}
          author_github_username={pr.author_github_username}
          head_ref={pr.head_ref}
          base_ref={pr.base_ref}
          additions={pr.additions}
          deletions={pr.deletions}
          changed_files={pr.changed_files}
          commits_count={pr.commits_count}
          files={pr.files}
          created_at={pr.created_at}
          updated_at={pr.updated_at}
          merged_at={pr.merged_at}
        />
      );
    }

    if (item.type === 'external_event') {
      const row = item.data as ExternalEventRecord;
      return (
        <div key={row._id} className="mx-auto conv-col px-2 sm:px-4 py-0.5" title="This session's own git activity, and events on the pull request it shepherds">
          <ExternalEventRow
            event={externalEventRowToExternalEvent(row)}
            density="transcript"
            omitRefs={["session_id"]}
          />
        </div>
      );
    }

    const msg = item.data as Message;
    if (msg.role === "system") {
      return <SystemBlock key={msg._id} content={msg.content || ""} subtype={msg.subtype} timestamp={msg.timestamp} messageUuid={msg.message_uuid} messageId={msg._id} conversationId={conversation?._id} onStartShareSelection={handleStartShareSelection} />;
    }

    if (msg.role === "user") {
      const kind = userMsgKindMap.get(msg._id) ?? { kind: 'normal' as const };
      if (foldWorkingTurns && !FOLD_KEPT_USER_KINDS.has(kind.kind)) {
        // A machine sent this. A wake frame still says where the turn's
        // message went (F4.2): the hands it started, the sessions it wrote to.
        if (kind.kind === 'role_wake') {
          return <RoleWakeBlock key={msg._id} frame={kind.frame} timestamp={msg.timestamp} conversationId={conversation?._id} until={turnAggregates.routingOf.get(msg._id)?.until ?? null} sentTo={turnAggregates.routingOf.get(msg._id)?.sentTo} routingOnly />;
        }
        return null;
      }
      switch (kind.kind) {
        case 'session_handoff':
          return <SessionHandoffCard key={msg._id} handoff={kind.handoff} source={handedOffFrom} timestamp={msg.timestamp} convLink={convLink} navigateToSession={navigateToSession} />;
        case 'tool_results_only':
        case 'compaction_prompt':
        case 'noise':
        case 'empty':
        case 'poll_response':
          return null;
        case 'command': {
          const cmdSender = resolveMsgSender(msg);
          return <CommandMessageBlock key={msg._id} messageId={msg._id} content={msg.content!} expansion={commandExpansionMap.byCommand.get(msg._id)} timestamp={msg.timestamp} userName={cmdSender?.name || conversation?.user?.name || conversation?.user?.email?.split("@")[0]} avatarUrl={cmdSender ? cmdSender.avatar_url : conversation?.user?.avatar_url} agentType={conversation?.agent_type} />;
        }
        case 'bash_input': {
          const bashSender = resolveMsgSender(msg);
          const paired = commandExpansionMap.bashByInput.get(msg._id);
          return <BashCommandBlock key={msg._id} messageId={msg._id} command={kind.command} stdout={paired?.stdout} stderr={paired?.stderr} timestamp={msg.timestamp} userName={bashSender?.name || conversation?.user?.name || conversation?.user?.email?.split("@")[0]} avatarUrl={bashSender ? bashSender.avatar_url : conversation?.user?.avatar_url} />;
        }
        case 'bash_output': {
          if (commandExpansionMap.consumed.has(msg._id)) return null;
          const bashSender = resolveMsgSender(msg);
          return <BashCommandBlock key={msg._id} messageId={msg._id} stdout={kind.stdout} stderr={kind.stderr} timestamp={msg.timestamp} userName={bashSender?.name || conversation?.user?.name || conversation?.user?.email?.split("@")[0]} avatarUrl={bashSender ? bashSender.avatar_url : conversation?.user?.avatar_url} />;
        }
        case 'interrupt':
          return <InterruptStatusLine key={msg._id} label={kind.tone === 'amber' ? "turn aborted" : undefined} tone={kind.tone} />;
        case 'machine_move':
          if (commandExpansionMap.consumed.has(msg._id)) return null;
          return <MachineMoveDivider key={msg._id} content={msg.content || ""} destination={kind.destination} fromLabel={kind.fromLabel} machineChanged={kind.machineChanged} extra={commandExpansionMap.machineMoveExtra.get(msg._id)} timestamp={msg.timestamp} />;
        case 'agent_switch':
          if (commandExpansionMap.consumed.has(msg._id)) return null;
          return <AgentSwitchDivider key={msg._id} toLabel={kind.toLabel} fromLabel={kind.fromLabel} content={msg.content || ""} timestamp={msg.timestamp} />;
        case 'session_escalation':
          return <EscalationDivider key={msg._id} escalation={kind.escalation} conversationShortId={conversation?.short_id ?? (conversation?._id ? String(conversation._id).slice(0, 7) : undefined)} timestamp={msg.timestamp} />;
        case 'background_agent_stopped':
          return <InterruptStatusLine key={msg._id} label={kind.agentName ? `background agent "${kind.agentName}" stopped` : "background agent stopped"} tone="amber" />;
        case 'continuation':
          return <InterruptStatusLine key={msg._id} label="session continued" tone="sky" />;
        case 'skill_expansion':
          if (commandExpansionMap.consumed.has(msg._id)) return null;
          return <SkillExpansionBlock key={msg._id} content={msg.content!} timestamp={msg.timestamp} cmdName={kind.cmdName} collapsed={condensedFeed} />;
        case 'task_notification':
          return <TaskNotificationLine key={msg._id} content={msg.content!} timestamp={msg.timestamp} agentNameToChildMap={agentNameToChildMap} />;
        case 'scheduled_task':
          return <ScheduledTaskBlock key={msg._id} content={msg.content!} timestamp={msg.timestamp} />;
        case 'session_message':
          return <SessionMessageBlock key={msg._id} variant={kind.variant === 'agent' ? "agent" : "session"} from={kind.from} name={kind.name} body={kind.body} timestamp={msg.timestamp} pendingStatus={(msg as any)._serverPendingStatus} pendingReason={(msg as any)._serverPendingReason} recipientConversationId={conversation?._id} linkToConversationId={kind.variant === 'agent' ? agentNameToChildMap?.[kind.from] : undefined} />;
        case 'huddle_summary':
          return <HuddleSummaryBlock key={msg._id} huddle={kind.huddle} timestamp={msg.timestamp} />;
        case 'chat_wake':
          return <ChatWakeBlock key={msg._id} wake={kind.wake} timestamp={msg.timestamp} />;
        case 'role_wake':
          return <RoleWakeBlock key={msg._id} frame={kind.frame} timestamp={msg.timestamp} conversationId={conversation?._id} until={turnAggregates.routingOf.get(msg._id)?.until ?? null} sentTo={turnAggregates.routingOf.get(msg._id)?.sentTo} />;
        case 'task_prompt':
          return null;
        case 'compaction_summary':
          return <CompactionSummaryBlock key={msg._id} content={msg.content!} />;
        case 'plan':
          return <PlanBlock key={msg._id} content={kind.planContent} timestamp={msg.timestamp} collapsed={false} messageId={msg._id} conversationId={conversation?._id} onStartShareSelection={handleStartShareSelection} />;
        case 'teammate_events':
          return <TeammateEventsBlock key={msg._id} content={msg.content || ""} timestamp={msg.timestamp} spawnedByConversationId={(conversation as any)?.spawned_by_conversation_id} agentNameToChildMap={agentNameToChildMap} />;
        case 'direct_user':
        case 'decision_answer':
        case 'normal': {
          if (!msg.content?.trim() && !msg.images?.some(img => !img.tool_use_id)) return null;
          if (nudgeRuns.folded.has(msg._id)) return null;
          const msgSender = resolveMsgSender(msg);
          const nudgeRun = kind.kind === 'normal' ? nudgeRuns.runs.get(msg._id) : undefined;
          if (nudgeRun) {
            return <NudgeLine key={msg._id} messageId={msg._id} text={nudgeRun.text} count={nudgeRun.count} timestamp={msg.timestamp} userName={msgSender?.name || conversation?.user?.name || conversation?.user?.email?.split("@")[0]} avatarUrl={msgSender ? msgSender.avatar_url : conversation?.user?.avatar_url} />;
          }
          // A direct send names its sender on the wire, so the bubble is theirs
          // even when the roster can't resolve the row (no from_user_id yet, or
          // a sender outside the viewer's team).
          const directFrom = kind.kind === 'direct_user' ? kind.from : undefined;
          const userName = msgSender?.name || directFrom || conversation?.user?.name || conversation?.user?.email?.split("@")[0];
          // A decision answer is a normal user bubble whose body is the chosen
          // option; the footer carries the question and the way back to the ask.
          const decision = kind.kind === 'decision_answer' ? kind.decision : undefined;
          const forkSeedParent = isForkSeedClientId(msg.client_id) ? conversation?.forked_from : undefined;
          const prompt = <UserPrompt key={msg._id} content={kind.kind === 'direct_user' ? kind.body : decision ? decision.answer : (msg.content || "")} decision={decision} images={msg.images} timestamp={msg.timestamp} messageId={msg._id} messageUuid={msg.message_uuid} conversationId={conversation?._id} collapsed={false} userName={userName} avatarUrl={msgSender ? msgSender.avatar_url : directFrom ? null : conversation?.user?.avatar_url} isHighlighted={highlightedMessageId === msg._id} shareSelectionMode={shareSelectionMode} isSelectedForShare={selectedMessageIds.has(msg._id)} onToggleShareSelection={handleToggleMessageSelection} onStartShareSelection={handleStartShareSelection} onForkFromMessage={forkHandlerFor(msg.message_uuid)} forkChildren={msg.message_uuid ? forkPointMap[msg.message_uuid] : undefined} onBranchSwitch={handleBranchSwitch} activeBranchId={activeBranchId} loadingBranchId={loadingBranchId} isPending={!!msg._isOptimistic} isQueued={!!msg._isQueued} agentStatus={isSessionDisconnected || conversation?.status !== "active" ? undefined : (managedSession?.agent_status as LiveAgentStatus | undefined)} mainDivergentPreview={msg.message_uuid ? conversation?.main_divergent_previews_by_fork?.[msg.message_uuid] : undefined} />;
          if (!forkSeedParent) return prompt;
          return (
            <Fragment key={msg._id}>
              <ForkSeedMark parentId={forkSeedParent} parentTitle={conversation?.forked_from_details?.title} parentUsername={conversation?.forked_from_details?.username} convLink={convLink} />
              {prompt}
            </Fragment>
          );
        }
      }
    }

    if (msg.role === "assistant") {
      const wfEvent = parseWorkflowEventContent(msg.content);
      if (msg.subtype === "workflow_event" || wfEvent) {
        if (wfEvent?.__wf === "workflow_run" && wfEvent.run_id && wfRunCardOwner.get(wfEvent.run_id) !== msg._id) return null;
        return <WorkflowEventBlock key={msg._id} content={msg.content || ""} workflowRun={workflowRun as any} onGateChoice={handleGateChoice} gateResponding={gateResponding} />;
      }

      const prevMsgForCompaction = getPreviousNonToolResultMessage(index);
      if (prevMsgForCompaction?.role === "user" && userMsgKindMap.get(prevMsgForCompaction._id)?.kind === 'compaction_prompt') {
        const summaryContent = extractCompactionSummaryContent(msg.content || "");
        if (!summaryContent) return null;
        return <CompactionSummaryBlock key={msg._id} content={summaryContent} />;
      }

      // Skip empty "No response requested." messages
      if (isHiddenStubMessage(msg)) return null;

      // Per-message derived props (first-in-sequence, the run's ids), cached on
      // the message row so a re-render that changed neither the timeline nor the
      // thinking toggle hands AssistantBlock the SAME arrays — memo(AssistantBlock)
      // holds and the row is skipped. Without this every virtualizer range
      // change re-rendered every visible row (fresh arrays each pass).
      const { isFirstInSequence, runMessageIds } = assistantRowDerived(msg, index);

      // Turn-level behavior for the compact feed.
      const turnKey = turnAggregates.turnKeyOf.get(msg._id);
      const turnExpanded = turnKey ? expandedGroups.has(turnKey) : false;
      // Compact: a collapsed turn shows the bottom ~300px of its final reply with
      // the top faded out; the rest of the turn renders nothing until expanded. A
      // turn with no text (tool-only) falls back to a one-line card.
      // Fold mode: the last reply in full, the steps before it behind the
      // card on that reply; a tool-only turn is the card alone. The live
      // turn's ask cards (a question, a permission prompt) stay.
      let foldCard: React.ReactNode = null;
      let foldedTurn = false;
      if (foldTurns && turnKey && !turnExpanded) {
        const lastText = turnAggregates.lastTextOf.get(turnKey);
        const stats = turnAggregates.statsOf.get(turnKey);
        const card = (
          <CompactTurnCard
            key={foldWorkingTurns ? `${msg._id}:folded` : msg._id}
            preview={stats?.preview || ""}
            messageCount={stats?.messages || 0}
            toolCount={stats?.tools || 0}
            onExpand={() => toggleGroup(turnKey)}
          />
        );
        if (!foldWorkingTurns) {
          if (lastText) {
            if (msg._id !== lastText) return null;
            return <CompactCollapsedTurn key={msg._id} content={msg.content || ""} onExpand={() => toggleGroup(turnKey)} />;
          }
          if (turnAggregates.firstAssistOf.get(turnKey) !== msg._id) return null;
          return card;
        }
        const liveAsk = openAsk(msg, index, turnKey);
        if (msg._id !== lastText && !liveAsk) {
          return !lastText && turnAggregates.firstAssistOf.get(turnKey) === msg._id ? card : null;
        }
        foldedTurn = true;
        if (msg._id === lastText && ((stats?.messages ?? 0) > 1 || (stats?.tools ?? 0) > 0)) foldCard = card;
      }
      // Condensed: a tool-only message folded into an earlier segment's receipt
      // never renders on its own — its tools show inside the owner's group.
      if (feedDensity === "condensed" && turnAggregates.absorbed.has(msg._id)) return null;
      // An expanded compact turn renders at full density (nothing clipped); the
      // collapse control sits on its first message.
      // A folded turn's kept reply reads condensed with no receipt: its own
      // tools are part of what folded.
      const effectiveDensity: MessageFeedDensity = foldedTurn ? "condensed" : feedDensity === "compact" ? "full" : feedDensity;
      const isTurnFirst = turnKey ? turnAggregates.firstAssistOf.get(turnKey) === msg._id : false;
      // Condensed: this message's segment tools fold into one receipt rendered
      // inline right after its text — where the activity happened. Opening it
      // reveals the group under the chip, inside this same row.
      const receiptEntries = feedDensity === "condensed" && !foldedTurn ? (turnAggregates.receiptOf.get(msg._id) ?? EMPTY_RECEIPT_ENTRIES) : EMPTY_RECEIPT_ENTRIES;
      const condensedReceipt = condensedReceiptFor(msg, receiptEntries, expandedGroups.has(msg._id));
      const onCollapseTurn = foldTurns && turnKey && isTurnFirst ? collapseTurnHandlerFor(msg, turnKey) : undefined;

      const relevantToolResults = relevantToolResultsFor(msg);

      const assistantBlock = (
        <AssistantBlock
          key={msg._id}
          content={msg.content}
          timestamp={msg.timestamp}
          thinking={msg.thinking}
          showThinking={showThinking}
          toolCalls={msg.tool_calls}
          toolResults={relevantToolResults}
          images={msg.images}
          messageId={msg._id}
          messageUuid={msg.message_uuid}
          conversationId={conversation?._id}
          density={effectiveDensity}
          condensedReceipt={condensedReceipt}
          globalToolResultMap={condensedReceipt ? globalToolResultMap : undefined}
          onCollapseTurn={onCollapseTurn}
          childConversationMap={conversation?.child_conversation_map}
          childConversations={conversation?.child_conversations}
          agentNameToChildMap={agentNameToChildMap}
          showHeader={isFirstInSequence}
          toolCallChangeSelectionMap={toolCallChangeSelectionMap}
          isHighlighted={highlightedMessageId === msg._id}
          runMessageIds={runMessageIds}
          shareSelectionMode={shareSelectionMode}
          isSelectedForShare={selectedMessageIds.has(msg._id)}
          onToggleShareSelection={handleToggleMessageSelection}
          onStartShareSelection={handleStartShareSelection}
          agentType={messageAuthors.get(msg._id)}
          taskSubjectMap={taskSubjectMap}
          taskRecordMap={taskRecordMap}
          onForkFromMessage={forkHandlerFor(msg.message_uuid)}
          forkChildren={msg.message_uuid ? forkPointMap[msg.message_uuid] : undefined}
          onBranchSwitch={handleBranchSwitch}
          activeBranchId={activeBranchId}
          loadingBranchId={loadingBranchId}
          mainDivergentPreview={msg.message_uuid ? conversation?.main_divergent_previews_by_fork?.[msg.message_uuid] : undefined}
          model={msg.model}
          onSendInlineMessage={handleSendInlineMessage}
          isConversationActive={conversation?.status === "active"}
          globalImageMap={globalImageMap}
          globalFileMap={globalFileMap}
        />
      );
      return foldCard ? <Fragment key={msg._id}>{foldCard}{assistantBlock}</Fragment> : assistantBlock;
    }

    return null;
  };

  // "Continued in" chips at the feed's end. Derived per (children, inline map,
  // messages) change rather than per render — it walked all loaded messages
  // on every pass.
  const continuationChildren = useMemo(() => {
    const children = conversation?.child_conversations;
    if (!children || children.length === 0) return EMPTY_CHILD_CONVERSATIONS;
    const childMap = conversation.child_conversation_map || {};
    const messageUuids = new Set(messages.map(m => m.message_uuid).filter(Boolean));
    const renderedInlineIds = new Set(
      Object.entries(childMap)
        .filter(([uuid]) => messageUuids.has(uuid))
        .map(([, childId]) => childId)
    );
    return children.filter(c => !renderedInlineIds.has(c._id) && !c.is_subagent && c._id !== conversation._id);
  }, [conversation?.child_conversations, conversation?.child_conversation_map, conversation?._id, messages]);

  // Header menu: the subagent list. Built once per change of the child set,
  // not per render — a parent with 174 subagents otherwise re-created ~900
  // elements on every conversation re-render (a closed Radix menu never mounts
  // them, but the JSX was still evaluated each pass).
  const subagentChildren = conversation?.child_conversations;
  const subagentMenuSig = useMemo(() => {
    if (!subagentChildren) return "";
    let sig = "";
    for (const c of subagentChildren) if (c.is_subagent) sig += `${c._id}\u0000${c.title ?? ""}\n`;
    return sig;
  }, [subagentChildren]);
  const subagentMenuItems = useMemo(() => {
    if (!subagentMenuSig) return null;
    const subagents = subagentChildren!.filter((c) => c.is_subagent);
    return (
      <>
        <DropdownMenuItem disabled className="text-[10px] uppercase tracking-wider text-sol-text-dim">
          Subagents ({subagents.length})
        </DropdownMenuItem>
        {subagents.map((child) => (
          <DropdownMenuItem key={child._id} asChild>
            <Link href={convLink(child._id)} className="text-xs">
              <svg className="w-3 h-3 mr-1.5 text-sol-cyan flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
              <span className="truncate">{child.title}</span>
            </Link>
          </DropdownMenuItem>
        ))}
      </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig stands in for the array
  }, [subagentMenuSig]);

  // The pinned thread state (`cast state`) is one node with two homes: under
  // the owner composer's status line when that composer is mounted, else in
  // the feed/composer seam (see the render below).
  const ownerComposerMounted = !!(showMessageInput && conversation && !(pendingPermissions && pendingPermissions.length > 0) && effectiveIsOwner);
  const threadStatePanel = conversation ? (
    <div data-cc-thread-state>
      <ThreadStatePanel
        conversationId={conversation._id.toString()}
        threadState={conversation.thread_state}
        threadStateAt={conversation.thread_state_at}
        threadStateMsgCount={conversation.thread_state_msg_count}
        threadStateStatus={conversation.thread_state_status}
        messageCount={conversation.message_count}
        canClear={effectiveIsOwner}
      />
    </div>
  ) : null;

  const el = (
    <HighlightContext.Provider value={highlightQuery}>
    <FilePathContext.Provider value={filePathCtx}>
    <WorktreesProvider repository={codeRepository}>
    <CastBrowserRowContext.Provider value={browserRowMap}>
    <BrowserSessionContext.Provider value={browserSession}>
    <RevealAncestryCtx.Provider value={revealAncestry}>
    <ChatWakeContext.Provider value={chatWakeMap}>
    <ImageGalleryProvider conversationId={conversation?._id} onJumpToMessage={scrollToMessageById}>
    <ReviewComposerContext.Provider value={reviewComposer}>
    <main data-cc-conversation data-cc-context={showSessionContext ? "" : undefined} data-reveal-chrome={compactChrome ? "" : undefined} className="relative flex flex-col bg-sol-bg h-full overflow-x-clip" onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-sol-bg/80 backdrop-blur-sm" style={{ animation: "fadeIn 150ms ease-out" }}>
          <div className="border-2 border-dashed border-sol-cyan rounded-xl p-12 text-center">
            <svg className="w-10 h-10 mx-auto mb-3 text-sol-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            <p className="text-sol-cyan text-sm font-medium">Drop images to attach</p>
          </div>
        </div>
      )}
      <header ref={bindHeader} data-sv-convhead className={`cq-container shrink-0 relative ${embedded ? "sticky top-0 z-20 bg-sol-bg-alt" : ""} ${!embedded ? deskClass : ""} ${isImageLightboxActive ? "invisible" : ""} ${hideHeader ? "hidden" : ""}`}>
        <div>
          <div ref={titlebarHeadRef} className="cc-panel__head gap-2 min-w-0">
            <div ref={squeezeRowRef} className="cq-squeeze-row flex items-center gap-2 min-w-0 overflow-hidden flex-1">
            {isZenMode && (
              <ShortcutTooltip label="Exit zen mode" action="ui.zenToggle" side="bottom">
                <button
                  onClick={() => useInboxStore.getState().updateClientUI({ zen_mode: false })}
                  className="p-1 rounded text-sol-text-dim/20 hover:text-sol-text-dim/50 transition-colors"
                >
                  <Maximize2 className="w-3 h-3 -scale-x-100" />
                </button>
              </ShortcutTooltip>
            )}
            {headerLeft}
            {identityRow && (
              <IdentityFace
                row={identityRow}
                size={22}
                className="flex-shrink-0"
                onPick={(e) => headerCharacterPicker.open(e, [identityRow], { force: true })}
                side="bottom"
                align="start"
              />
            )}
            {isRenaming ? (
              <input
                ref={renameInputRef}
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => {
                  const trimmed = renameDraft.trim();
                  if (trimmed && trimmed !== cleanTitle(conversation?.title || "")) {
                    useInboxStore.getState().renameSession(conversation!._id, trimmed);
                  }
                  useInboxStore.setState({ renamingSessionId: null });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.currentTarget.blur(); }
                  if (e.key === "Escape") { useInboxStore.setState({ renamingSessionId: null }); }
                }}
                className="text-xs sm:text-sm font-medium text-sol-text-secondary flex-1 min-w-0 bg-transparent border-b border-sol-cyan focus:outline-none"
              />
            ) : (
              <h1
                className="cc-panel__title truncate flex-1 min-w-0 cursor-default"
                title={conversation?.messages?.[0]?.content ? cleanContent(conversation.messages[0].content)?.slice(0, 200) ?? undefined : undefined}
                onDoubleClick={() => { if (isOwner) useInboxStore.setState({ renamingSessionId: conversation!._id }); }}
              >
                {truncatedTitle}
              </h1>
            )}
            {conversation && <AnchorHeaderPill conversationId={conversation._id.toString()} />}
            {conversation && <BrowserPaneOfferChip conversationId={conversation._id.toString()} />}

            {/* A hibernated session says so above the composer (MessageInput
                status line), not here: the header stays quiet rather than
                showing a "Disconnected" pill for a park the daemon lifts on send. */}
            {managedSession?.agent_status === "hibernated" ? null : isSessionDisconnected && (managedSession?.agent_status === "starting" || managedSession?.agent_status === "resuming" || managedSession?.agent_status === "connected") ? (
              <span data-cc-conv-status className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] flex-shrink-0 bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30">
                <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan animate-pulse" />
                <span className="hidden sm:inline cq-sq3">{managedSession?.agent_status === "starting" ? "Starting" : managedSession?.agent_status === "resuming" ? "Resuming" : "Delivering"}</span>
                <span className="sm:hidden cq-sq3">{managedSession?.agent_status === "starting" ? "Start" : managedSession?.agent_status === "resuming" ? "Rsum" : "Dlvr"}</span>
              </span>
            ) : isSessionDisconnected ? (
              <span data-cc-conv-status className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] flex-shrink-0 bg-sol-text-dim/5 text-sol-text-dim/50 border border-sol-text-dim/10">
                <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/30" />
                <span className="hidden sm:inline cq-sq3">Disconnected</span>
                <span className="sm:hidden cq-sq3">Disc</span>
              </span>
            ) : null}

            {!isSessionDisconnected && (managedSession?.agent_status === "working" || managedSession?.agent_status === "thinking" || managedSession?.agent_status === "compacting" || managedSession?.agent_status === "waiting" || managedSession?.agent_status === "dormant" || managedSession?.agent_status === "permission_blocked" || managedSession?.agent_status === "connected" || managedSession?.agent_status === "starting" || managedSession?.agent_status === "resuming" || (!managedSession?.agent_status && isConversationLive)) && (
              <span data-cc-conv-status className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] flex-shrink-0 ${
                managedSession?.agent_status === "thinking" ? "bg-sol-violet/10 text-sol-violet border border-sol-violet/30" :
                managedSession?.agent_status === "compacting" ? "bg-amber-500/10 text-amber-400 border border-amber-500/30" :
                managedSession?.agent_status === "waiting" || managedSession?.agent_status === "dormant" ? "bg-sol-blue/10 text-sol-blue border border-sol-blue/30" :
                managedSession?.agent_status === "permission_blocked" ? "bg-sol-orange/10 text-sol-orange border border-sol-orange/30" :
                managedSession?.agent_status === "connected" || managedSession?.agent_status === "starting" || managedSession?.agent_status === "resuming" ? "bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30" :
                "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                  managedSession?.agent_status === "thinking" ? "bg-sol-violet" :
                  managedSession?.agent_status === "compacting" ? "bg-amber-400" :
                  managedSession?.agent_status === "waiting" || managedSession?.agent_status === "dormant" ? "bg-sol-blue" :
                  managedSession?.agent_status === "permission_blocked" ? "bg-sol-orange" :
                  managedSession?.agent_status === "connected" || managedSession?.agent_status === "starting" || managedSession?.agent_status === "resuming" ? "bg-sol-cyan" :
                  "bg-emerald-400"
                }`} />
                <span className="hidden sm:inline cq-sq3">{managedSession?.agent_status === "thinking" ? "Thinking" :
                 managedSession?.agent_status === "compacting" ? "Compacting" :
                 managedSession?.agent_status === "waiting" || managedSession?.agent_status === "dormant" ? "Dormant" :
                 managedSession?.agent_status === "permission_blocked" ? "Needs Input" :
                 managedSession?.agent_status === "starting" ? "Starting" :
                 managedSession?.agent_status === "resuming" ? "Resuming" :
                 managedSession?.agent_status === "connected" ? "Connected" :
                 "Working"}</span>
                <span className="sm:hidden cq-sq3">{managedSession?.agent_status === "thinking" ? "Think" :
                 managedSession?.agent_status === "compacting" ? "Compact" :
                 managedSession?.agent_status === "waiting" || managedSession?.agent_status === "dormant" ? "Dormant" :
                 managedSession?.agent_status === "permission_blocked" ? "Input" :
                 managedSession?.agent_status === "starting" ? "Start" :
                 managedSession?.agent_status === "resuming" ? "Rsum" :
                 managedSession?.agent_status === "connected" ? "Conn" :
                 "Work"}</span>
              </span>
            )}

            {conversation && (
              // The facts strip: what this session is (agent and model), where
              // its code sits, and what it is for (task, plan, workflow run),
              // as one run of dim text with dots between. The pills' own
              // colours are stripped by [data-cc-facts] in globals.css; only
              // things that are alive keep a tint on this row. Simple view
              // keeps the strip (it owns the model picker) but dims it; the
              // plan, task and workflow drop away there.
              <span data-cc-facts data-cc-conv-meta data-simple-dim className="cq-sq3 flex items-center min-w-0 flex-shrink-0">
                <ConversationMetadata
                  agentType={conversation.agent_type}
                  model={conversation.model}
                  effort={(conversation as any).effort}
                  startedAt={conversation.started_at}
                  messageCount={conversation.message_count}
                  shortId={conversation.short_id}
                  conversationId={conversation._id}
                  canEditModel={effectiveIsOwner}
                  controlOpen={sessionControlOpen}
                  onControlOpenChange={setSessionControlOpen}
                />
                <BranchCodeLink session={conversation} />
                <SessionWorktreePills session={conversation} repository={codeRepository} className="text-[10px] max-w-[180px]" />
            {(conversation as any)?.active_task && (
              <span data-simple-hide className="contents">
                <TaskBadge task={(conversation as any).active_task} />
              </span>
            )}
            {(conversation as any)?.active_plan && (
              <span data-simple-hide className="contents">
                <PlanBadge plan={(conversation as any).active_plan} />
              </span>
            )}
            {/* A workflow run in flight inside this session. The launch card
                sits wherever the run was armed — often far above the tail —
                so the header carries the standing signal, linking to the run's
                live view. Server truth via the conversation's stamped run. */}
            {(conversation as any)?.is_workflow_primary && (conversation as any)?.workflow_run_id &&
              ["pending", "running", "paused"].includes((conversation as any)?.workflow_run_status) && (
              <span data-simple-hide className="contents">
                <Link
                  href={`/workflows/runs/${(conversation as any).workflow_run_id}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] flex-shrink-0 bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20 hover:bg-sol-cyan/20 transition-colors max-w-[180px]"
                  title={`Workflow ${(conversation as any).workflow_run_status}${(conversation as any).workflow_run_name ? `: ${(conversation as any).workflow_run_name}` : ""} — open the live run`}
                >
                  <span className="w-1 h-1 rounded-full bg-sol-cyan animate-pulse motion-reduce:animate-none" />
                  <Workflow className="w-2.5 h-2.5 flex-shrink-0" />
                  <span className="truncate">{(conversation as any).workflow_run_name || "workflow"}</span>
                </Link>
              </span>
            )}
              </span>
            )}

            {conversation && (
              <TooltipProvider delayDuration={300}>
              <div data-cc-conv-actions className="flex items-center gap-1 flex-shrink-0 overflow-hidden ml-auto">

                {parentLinkId && (
                  <Link
                    href={convLink(parentLinkId)}
                    onClick={(e) => {
                      // Plain left-click is an instant, store-driven switch (same as the
                      // BranchSelector chips) — bypass the /conversation redirector so the
                      // parent loads from cache without the resolveConversation + skeleton
                      // bounce. Modified clicks fall through to the Link for open-in-new-tab.
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                      e.preventDefault();
                      navigateToSession(parentLinkId);
                    }}
                    className="cq-sq6 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/20 transition-colors"
                    title="View parent conversation"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                    </svg>
                    <span className="cq-sq2">Parent</span>
                  </Link>
                )}

                {handedOffFrom && (
                  <HandoffLinkChip details={handedOffFrom} direction="from" convLink={convLink} navigateToSession={navigateToSession} />
                )}
                {handedOffTo && (
                  <HandoffLinkChip details={handedOffTo} direction="to" convLink={convLink} navigateToSession={navigateToSession} />
                )}

                {((conversation.fork_children?.length ?? 0) > 0 || conversation.forked_from) && (() => {
                  // Family size from the details payload alone (no store sub):
                  // me + my children, plus parent + my siblings when forked.
                  const familyCount =
                    1 +
                    (conversation.fork_children?.length ?? 0) +
                    (conversation.forked_from ? 1 + (conversation.fork_siblings?.length ?? 0) : 0);
                  return (
                    <button
                      ref={treeChipRef}
                      onClick={toggleMap}
                      className={`cq-sq6 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border transition-colors ${
                        treePopoverOpen
                          ? "bg-sol-cyan/20 text-sol-cyan border-sol-cyan/40"
                          : "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/30 hover:bg-sol-cyan/20"
                      }`}
                      title={`Branch map — ${familyCount} branch${familyCount === 1 ? "" : "es"} (${isMac ? "⌘B" : "Ctrl+B"})`}
                    >
                      <Split className="w-3 h-3" />
                      {familyCount > 1 && (
                        <span className="tabular-nums">{familyCount}</span>
                      )}
                    </button>
                  );
                })()}

                {/* The runner: which machine, whose account, is its daemon
                    delivering, and the terminal one click away. Three pills
                    joined into one by [data-cc-runner] in globals.css, so
                    "where is this running" reads as one thing. */}
                <span data-cc-runner data-cc-keep="live" className="inline-flex items-center flex-shrink-0">
                <ConversationAssignmentBadge conversation={conversation} isOwner={isOwner} guest={guest} compact={simpleViewPref} />
                {conversation?._id && !guest && <SessionDaemonChip conversationId={String(conversation._id)} />}
                {/* Kept in simple view (dimmed, copy sub-button hidden inside
                    the pill): the live tmux badge is how you reach the
                    terminal split, which simple view users still want. */}
                <span data-simple-dim className="contents [.simple-view_&]:inline-flex [.simple-view_&]:items-center">
                  <TmuxAttachPill tmuxSession={managedSession?.tmux_session} agentType={conversation?.agent_type} isLive={isSessionLive} conversationKey={conversation?._id.toString()} />
                </span>
                </span>

                {/* Who has this session open right now: teammates' faces off
                    the roster's viewing field. A solo session shows nothing. */}
                {conversation?._id && !guest && <ConversationViewers conversationId={String(conversation._id)} />}

                {/* Huddle about this session: a live chip when occupied, a
                    quiet start affordance otherwise (hidden when calling is
                    unconfigured — SessionHuddleButton gates itself). */}
                {conversation._id && !guest && callsAvailable && (
                  <span data-cc-keep="live" className="contents">
                    <Suspense fallback={null}>
                      <SessionHuddleButton conversationId={String(conversation._id)} />
                    </Suspense>
                  </span>
                )}

                {/* Hairline between the live pills and the plain icon
                    actions — the two families read as one soup without it. */}
                <span aria-hidden className="w-px h-3.5 bg-sol-border/60 mx-0.5 flex-shrink-0" />

                {(highlightQuery || isLocalSearchOpen) && (
                  <div data-cc-keep className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-amber-200/50 dark:bg-amber-800/30 text-amber-800 dark:text-amber-200">
                    <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    {isLocalSearchOpen ? (
                      <input
                        ref={localSearchInputRef}
                        type="text"
                        value={localSearchQuery}
                        onChange={(e) => setLocalSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") onClearHighlight();
                          if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? goToPrevMatch() : goToNextMatch(); }
                        }}
                        placeholder="Search messages..."
                        className="bg-transparent border-none outline-none text-xs w-24 sm:w-32 placeholder:text-amber-600/50 dark:placeholder:text-amber-400/50"
                        autoFocus
                      />
                    ) : (
                      <span className="max-w-[100px] truncate">{highlightQuery}</span>
                    )}
                    {searchStatus === "searching" && <Loader2 className="w-3 h-3 shrink-0 animate-spin opacity-70" />}
                    {matchInstances.length > 0 && (
                      <>
                        <span className="text-[10px] opacity-70 ml-1 tabular-nums whitespace-nowrap">
                          {currentMatchIndex + 1}/{matchInstances.length}
                        </span>
                        <button
                          onClick={goToPrevMatch}
                          className="p-0.5 hover:bg-amber-300/50 dark:hover:bg-amber-700/40 rounded transition-colors"
                          title="Previous match (Shift+Enter)"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                          </svg>
                        </button>
                        <button
                          onClick={goToNextMatch}
                          className="p-0.5 hover:bg-amber-300/50 dark:hover:bg-amber-700/40 rounded transition-colors"
                          title="Next match (Enter)"
                        >
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>
                      </>
                    )}
                    {matchInstances.length === 0 && highlightQuery && searchStatus === "done" && (
                      <span className="text-[10px] opacity-70 ml-1 whitespace-nowrap">No matches</span>
                    )}
                    {searchStatus === "error" && (
                      <span className="text-[10px] ml-1 whitespace-nowrap text-sol-red">Search failed</span>
                    )}
                    <button
                      onClick={onClearHighlight}
                      className="p-0.5 hover:bg-amber-300/50 dark:hover:bg-amber-700/40 rounded transition-colors ml-1"
                      title="Clear search"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                )}

                {sessionGalleryImages.length > 0 && <SessionGalleryButton images={sessionGalleryImages} />}

                <ShortcutTooltip label="Search in conversation" side="bottom">
                  <button
                    onClick={() => {
                      if (isLocalSearchOpen) {
                        onClearHighlight();
                      } else {
                        if (propHighlightQuery) propClearHighlight?.();
                        setIsLocalSearchOpen(true);
                        setLocalSearchQuery("");
                        setTimeout(() => localSearchInputRef.current?.focus(), 0);
                      }
                    }}
                    className={`p-1 rounded hover:bg-sol-bg-alt transition-colors ${isLocalSearchOpen ? "text-sol-cyan" : "cq-sq4 text-sol-text-dim hover:text-sol-text-secondary"}`}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </button>
                </ShortcutTooltip>

                {/* Copy link, send to chat, density, images and the project's
                    files live in the share popover (headerExtra) and in the
                    menu below, not as bare icons: search, share and the menu
                    are the row's only plain actions. */}
                {headerExtra}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    {/* data-cc-keep: the Minimal style rests the header on the
                        title, the live status and this menu; the rest of the
                        cluster fades in on hover or keyboard focus. */}
                    <button data-cc-keep aria-label="Session menu" className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                      </svg>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {/* The icon actions the squeeze folded away (level 4 in
                        globals.css) come back here as menu rows. Mounted on
                        open, so it reads the row's current level. */}
                    <SqueezedHeaderActions rowRef={squeezeRowRef}>
                      <DropdownMenuItem onSelect={() => setTimeout(() => { if (propHighlightQuery) propClearHighlight?.(); setIsLocalSearchOpen(true); setLocalSearchQuery(""); setTimeout(() => localSearchInputRef.current?.focus(), 0); })}>
                        <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                        Search in conversation
                      </DropdownMenuItem>
                    </SqueezedHeaderActions>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        {(() => { const Icon = DENSITY_OPTIONS.find(o => o.value === density)!.icon; return <Icon className="w-3 h-3 mr-1.5" />; })()}
                        View density
                        <MenuKeyCaps action="conv.cycleDensity" />
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-72">
                        <DensityMenuOptions density={density} setDensity={setDensity} guest={guest} />
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    {filePathBase && !guest && (
                      <DropdownMenuItem onSelect={() => setTimeout(() => openFiles(filesHref({ localPath: filePathBase })))}>
                        <FolderTree className="w-3 h-3 mr-1.5" />
                        Browse project files
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => { copyToClipboard(`${shareOrigin()}/conversation/${conversation?._id}`).then(() => toast.success("Link copied")).catch(() => toast.error("Failed to copy")); }}>
                      <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                      </svg>
                      Copy link
                      <MenuKeyCaps action="conv.copyLink" />
                    </DropdownMenuItem>
                    {chatOn && (
                      <DropdownMenuItem onSelect={() => setTimeout(() => openForwardToChat({ url: `${shareOrigin()}/conversation/${conversation?._id}`, label: "session" }))}>
                        <Forward className="w-3 h-3 mr-1.5" />
                        Send to chat
                      </DropdownMenuItem>
                    )}
                    {effectiveIsOwner && conversation?.session_id && (
                      <DropdownMenuItem disabled={isHeaderRestarting} onSelect={() => { setTimeout(() => handleRestartSession()); }}>
                        <svg className={`w-3 h-3 mr-1.5 text-orange-400 ${isHeaderRestarting ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        {isHeaderRestarting ? "Restarting…" : "Restart session"}
                      </DropdownMenuItem>
                    )}
                    {conversation?.short_id && (
                      <DropdownMenuItem onSelect={() => { setTimeout(() => { copyToClipboard(conversation.short_id!).then(() => toast.success("ID copied")).catch(() => toast.error("Failed to copy")); }); }}>
                        <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
                        </svg>
                        Copy ID ({conversation.short_id})
                      </DropdownMenuItem>
                    )}
                    {/* Simple view strips the header's branch chip — resurface
                        its copy here so the hamburger stays the full command
                        surface in that mode. The tmux pill keeps its own copy
                        button in both modes. */}
                    {simpleViewPref && conversation?.git_branch && (
                      <DropdownMenuItem onSelect={() => { setTimeout(() => { copyToClipboard(conversation.git_branch!).then(() => toast.success("Branch copied")).catch(() => toast.error("Failed to copy")); }); }}>
                        <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M7 7a2 2 0 100-4 2 2 0 000 4zm0 0v6m0 0a2 2 0 100 4 2 2 0 000-4zm10-6a2 2 0 100-4 2 2 0 000 4zm0 0a5 5 0 01-5 5h-2" />
                        </svg>
                        Copy branch ({conversation.git_branch})
                      </DropdownMenuItem>
                    )}
                    {/* Run synchronously (no setTimeout) so handleCopyAll's
                        navigator.clipboard.write() fires inside the click's
                        transient user activation — deferring it loses activation
                        and the clipboard write hangs forever. */}
                    <DropdownMenuItem onSelect={() => handleCopyAll()}>
                      <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy all messages
                    </DropdownMenuItem>
                    {isOwner && (
                      <DropdownMenuItem onSelect={() => setTimeout(() => useInboxStore.setState({ renamingSessionId: conversation._id }))}>
                        <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                        Rename
                        <MenuKeyCaps action="session.rename" />
                      </DropdownMenuItem>
                    )}
                    {conversation?.session_id && (
                      <>
                        <DropdownMenuItem onSelect={() => setTimeout(() => handleCopyResumeCommand("claude"))}>
                          <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          Copy Claude resume
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setTimeout(() => handleCopyResumeCommand("codex"))}>
                          <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                          Copy Codex resume
                        </DropdownMenuItem>
                      </>
                    )}
                    {isOwner && (
                      <DropdownMenuItem onSelect={() => {
                        toggleFavoriteMutation(conversation._id);
                        toast.success(conversation.is_favorite ? "Removed from favorites" : "Added to favorites");
                      }}>
                        <svg className={`w-3 h-3 mr-1.5 ${conversation.is_favorite ? "text-amber-400" : ""}`} fill={conversation.is_favorite ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                        </svg>
                        {conversation.is_favorite ? "Remove from favorites" : "Add to favorites"}
                        <MenuKeyCaps action="conv.favorite" />
                      </DropdownMenuItem>
                    )}
                    {isOwner && (
                      <DropdownMenuItem onSelect={togglePublicProfilePin}>
                        <svg className={`w-3 h-3 mr-1.5 ${conversation.profile_pinned_at ? "text-sol-cyan" : ""}`} fill={conversation.profile_pinned_at ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16 4v6l3 3v2H5v-2l3-3V4M9 19h6m-3 0v3" />
                        </svg>
                        {conversation.profile_pinned_at ? "Unpin from public profile" : "Pin to public profile"}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    {hasAnyThinking && (
                      <DropdownMenuItem onClick={() => setShowThinking((s) => !s)}>
                        {showThinking ? "Hide thinking" : "Show thinking"}
                        <MenuKeyCaps action="conv.toggleThinking" />
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => {
                      const next = !stickyDisabled;
                      updateUI({ sticky_headers_disabled: next });
                      if (next) { setStickyMsgVisible(false); setActiveStickyMsg(null); }
                    }}>
                      {stickyDisabled ? "Enable sticky headers" : "Disable sticky headers"}
                    </DropdownMenuItem>
                    {minimalStyle && (
                      <DropdownMenuItem onClick={() => updateUI({ show_session_context: !showSessionContext })}>
                        {showSessionContext ? "Hide schedule and plan" : "Show schedule and plan"}
                      </DropdownMenuItem>
                    )}
                    {conversation.git_branch && (
                      <DropdownMenuItem onClick={() => setDiffExpanded(!diffExpanded)}>
                        {diffExpanded ? "Hide git diff" : "Show git diff"}
                        <MenuKeyCaps action="conv.toggleDiff" />
                      </DropdownMenuItem>
                    )}
                    {parentLinkId && (
                      <DropdownMenuItem asChild>
                        <Link href={convLink(parentLinkId)}>
                          View parent conversation
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {handedOffFrom && (
                      <DropdownMenuItem asChild>
                        <HandoffSessionLink details={handedOffFrom} compact convLink={convLink} navigateToSession={navigateToSession} className="flex items-center gap-1.5">
                          <ArrowRightLeft className="w-3 h-3 shrink-0 text-sol-cyan" />
                          <span className="shrink-0">Handed off from</span>
                        </HandoffSessionLink>
                      </DropdownMenuItem>
                    )}
                    {handedOffTo && (
                      <DropdownMenuItem asChild>
                        <HandoffSessionLink details={handedOffTo} compact convLink={convLink} navigateToSession={navigateToSession} className="flex items-center gap-1.5">
                          <ArrowRightLeft className="w-3 h-3 shrink-0 text-sol-cyan" />
                          <span className="shrink-0">Continued in</span>
                        </HandoffSessionLink>
                      </DropdownMenuItem>
                    )}
                    {conversation.forked_from_details && (
                      <DropdownMenuItem asChild>
                        <Link href={conversation.forked_from_details.share_token ? `/share/${conversation.forked_from_details.share_token}` : convLink(conversation.forked_from_details.conversation_id)}>
                          <svg className="w-3 h-3 mr-1.5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                          </svg>
                          Forked from @{conversation.forked_from_details.username}
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {isOwner && (
                      <>
                        <DropdownMenuSeparator />
                        {/* One row for the whole session control panel (model,
                            effort, switch agent, fork as, hand off) — the
                            header badge opens the same panel, so the menu
                            never grows a second copy of its rails. The menu
                            closes first; the panel opens on the next tick so
                            the two Radix layers don't fight over focus. */}
                        <DropdownMenuItem
                          className="hidden sm:flex"
                          onSelect={() => { setTimeout(() => setSessionControlOpen(true), 0); }}
                        >
                          <Cpu className="w-3 h-3 mr-1.5 text-sol-violet" />
                          Model, agent, fork, hand off…
                        </DropdownMenuItem>
                      </>
                    )}
                    {((conversation.fork_children && conversation.fork_children.length > 0) || conversation.forked_from) && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => toggleMap()}>
                          <Split className="w-3 h-3 mr-1.5 text-sol-cyan" />
                          Branch map
                          <MenuKeyCaps action="conv.toggleTree" />
                        </DropdownMenuItem>
                      </>
                    )}
                    {((conversation.fork_count ?? 0) > 0 || (conversation.fork_children?.length ?? 0) > 0) && (
                      <DropdownMenuItem disabled>
                        <Split className="w-3 h-3 mr-1.5 text-sol-cyan" />
                        {conversation.fork_count || conversation.fork_children?.length || 0} fork{(conversation.fork_count || conversation.fork_children?.length || 0) === 1 ? '' : 's'}
                      </DropdownMenuItem>
                    )}
                    {(conversation.compaction_count ?? 0) > 0 && (
                      <DropdownMenuItem disabled>
                        <svg className="w-3 h-3 mr-1.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                        </svg>
                        {conversation.compaction_count} compaction{conversation.compaction_count === 1 ? '' : 's'}
                      </DropdownMenuItem>
                    )}
                    {subagentMenuItems}
                    {conversation?._id && <ConversationTaskStatsMenuItem conversationId={conversation._id} />}
                    {latestUsage && (
                      <>
                        <DropdownMenuSeparator />
                        <div className="px-2 py-1.5">
                          <UsageDisplay usage={latestUsage} />
                        </div>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              </TooltipProvider>
            )}
            </div>
            {headerEnd && <div className="flex-shrink-0">{headerEnd}</div>}
          </div>
          {conversation?._id && <ConversationTaskProgress conversationId={conversation._id} />}
          <RestartStatusStrip
            phase={restartPhase}
            stage={restartStripStage}
            failure={restartFailure}
            startedAt={restartStartedAt}
            onRetry={handleRestartSession}
          />
          {conversation?._id && <DeviceMoveStatusStrip conversationId={conversation._id} />}
        </div>
        {conversation && (
          <div className="absolute top-full right-3 mt-24 z-30">
            <MessageNavButton
              conversationId={conversation._id}
              currentMessageId={navigatorCurrentId ?? activeStickyMsg?.id ?? null}
              loadedMessages={messages}
              scrollProgress={navScrollProgress}
              onScrollToMessage={(messageId) => {
                setNavigatorCurrentId(messageId);
                scrollToMessageById(messageId);
              }}
            />
          </div>
        )}
        {subHeaderContent}
        {/* Unacked handoff strip. Lives INSIDE the header so headerHeight's
            ResizeObserver counts it and the sticky-message overlay (anchored at
            top: headerHeight) lands below instead of covering it. */}
        {conversation && <AssignedToYouBanner conversationId={conversation._id.toString()} />}
        {/* Live tmux view (opened from the tmux pill), docked across the top.
            INSIDE the header on purpose: headerHeight's ResizeObserver counts
            it, so the sticky prompt card, files-changed pill and jump toast
            all anchor below the terminal — including live during a resize
            drag. */}
        {conversation && (
          <ErrorBoundary name="ConversationTerminal" level="inline" fallback={null}>
            <Suspense fallback={null}>
              <ConversationTerminalSplit convKey={conversation._id.toString()} tmuxSession={managedSession?.tmux_session} />
            </Suspense>
            <BrowserWatchSplit convKey={conversation._id.toString()} sessionUuid={managedSession?.session_id} tmuxSession={managedSession?.tmux_session} lastPage={lastBrowserPage} />
          </ErrorBoundary>
        )}
      </header>

      {stickyMsgVisible && activeStickyMsg && (
        <div
          ref={stickyElRef}
          className="absolute left-0 right-0 z-[15] px-2 sm:px-3 md:px-4 pt-1 cursor-pointer"
          style={{ top: headerHeight }}
          onClick={() => {
            if (activeStickyMsg.index >= 0) {
              virtualizer.scrollToIndex(activeStickyMsg.index, { align: 'start' });
            } else if (activeStickyMsg.id && activeStickyMsg.id !== '__fallback__' && conversation?._id) {
              useInboxStore.getState().requestNavigate(conversation._id, { scrollToMessageId: activeStickyMsg.id });
            } else if (onJumpToStart) {
              jumpDirectionRef.current = 'start';
              setJumpPending('start');
              onJumpToStart();
            }
          }}
        >
          <div className="conv-col mx-auto">
            <div data-sv-sticky className="bg-sol-blue/10 px-4 py-3 rounded-b-lg border border-sol-blue/30 backdrop-blur-md shadow-lg relative group">
              <div data-sv-sticky-tools className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
                {(stickyClamped || stickyExpanded) && (
                  <button
                    className="p-0.5 rounded hover:bg-sol-blue/20 text-sol-text-dim hover:text-sol-text opacity-0 group-hover:opacity-100 transition-opacity"
                    title={stickyExpanded ? "Collapse" : "Show full message"}
                    onClick={(e) => {
                      e.stopPropagation();
                      setStickyExpanded(v => !v);
                    }}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={stickyExpanded ? "M5 15l7-7 7 7" : "M19 9l-7 7-7-7"} />
                    </svg>
                  </button>
                )}
                <button
                  className="p-0.5 rounded hover:bg-sol-blue/20 text-sol-text-dim hover:text-sol-text opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Dismiss"
                  onClick={(e) => {
                    e.stopPropagation();
                    dismissedStickyIdsRef.current.add(activeStickyMsg!.id);
                    setStickyMsgVisible(false);
                    setActiveStickyMsg(null);
                  }}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div data-sv-sticky-who className="flex items-center gap-2 mb-1">
                {(() => {
                  const kind = userMsgKindMap.get(activeStickyMsg.id);
                  if (kind?.kind === "session_message") {
                    // A subagent's report names an agent, not a session — a pill would
                    // resolve nothing, so it keeps the badge the card gives it.
                    if (kind.variant === "agent") {
                      return <><Bot className="w-4 h-4 text-sol-violet" /><span className="text-sol-violet text-xs">Report from</span><span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${agentColorMap.purple}`}>{kind.from}</span></>;
                    }
                    return <><CornerDownRight className="w-4 h-4 text-sol-cyan" /><span className="text-sol-cyan text-xs">Message from</span><EntityIdPill shortId={kind.from} /></>;
                  }
                  const stickySender = activeStickyMsg.fromUserId ? senderById.get(String(activeStickyMsg.fromUserId)) : undefined;
                  const stickyDirectFrom = kind?.kind === "direct_user" ? kind.from : undefined;
                  return (
                    <>
                      <UserIcon avatarUrl={stickySender ? stickySender.avatar_url : stickyDirectFrom ? null : conversation?.user?.avatar_url} />
                      <span className="text-sol-blue text-xs font-medium">{stickySender?.name || stickyDirectFrom || conversation?.user?.name || conversation?.user?.email?.split("@")[0] || "You"}</span>
                    </>
                  );
                })()}
              </div>
              <div data-sv-sticky-body className="pl-8 pr-4">
                <MessagePromptPreview
                  content={cleanStickyContent(activeStickyMsg.content)}
                  images={stickyImages}
                  messageId={activeStickyMsg.id && activeStickyMsg.id !== '__fallback__' ? activeStickyMsg.id : undefined}
                  variant="sticky"
                  textRef={stickyTextRef}
                  textClassName={`text-sm text-sol-text whitespace-pre-wrap ${stickyExpanded ? "max-h-[50vh] overflow-y-auto cursor-auto select-text" : "line-clamp-3"}`}
                  onTextClick={stickyExpanded ? (e) => e.stopPropagation() : undefined}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {diffExpanded && gitDiffData && (gitDiffData.git_diff?.trim() || gitDiffData.git_diff_staged?.trim()) && (
        <GitDiffPanel
          gitDiff={gitDiffData.git_diff}
          gitDiffStaged={gitDiffData.git_diff_staged}
        />
      )}

      {/* A pinned lead (the scope page's introduction) sits above the feed, in
          view however far the feed is scrolled; the chronological lead (the
          proposal letter) stays inside it at the transcript's start. */}
      {leadNode && leadPinned && <div className="shrink-0 border-b" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }} data-lead-pinned>{leadNode}</div>}
      <div className={`flex-1 min-h-0 relative flex ${isImageLightboxActive ? "invisible" : ""}`}>
      {(isJumpingToTarget || (targetMessageId && timeline.length === 0)) && (
        <div
          className="absolute inset-x-0 z-20 flex justify-center pt-3 sm:pt-4 pointer-events-none"
          style={{
            top: stickyMsgVisible && activeStickyMsg ? (stickyElRef.current?.offsetHeight ?? 0) + 4 : 0,
            animation: "fadeIn 150ms ease-out",
          }}
        >
          <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30 backdrop-blur-md text-xs font-medium shadow-md">
            <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            Jumping to message...
          </div>
        </div>
      )}
      {conversation && density !== "story" && density !== "summary" && (
        <ReviewScrollIndicators
          conversationId={conversation._id}
          scrollRef={containerRef}
          messageIds={timelineMessageIds}
          virtualizer={virtualizer}
          topInset={stickyMsgVisible && activeStickyMsg ? stickyElRef.current?.offsetHeight ?? 0 : 0}
        />
      )}
      <div ref={containerRef} data-sv-feed data-cc-density={feedDensity} className="flex-1 min-h-0 overflow-y-auto" style={{ overflowAnchor: "none" }}>
        <div className="flex flex-col min-h-full">
        {conversation && timeline.length === 0 && leadNode && !leadPinned ? (
          <div className="flex-1">{leadNode}</div>
        ) : (!conversation || timeline.length === 0) ? (
          <div className={`flex-1 flex flex-col items-center gap-3 ${hideHeader ? "justify-start pt-6" : "justify-start pt-16"}`}>
            {conversation && (
              (conversation.fork_status === "copying" || (conversation.message_count ?? 0) > 0) ? (
                <MessagesUnavailableState
                  messageCount={conversation.message_count ?? 0}
                  forkStatus={conversation.fork_status}
                  forkCopied={conversation.fork_copied}
                  forkTotal={conversation.fork_copy_total}
                />
              ) : isOwner ? (
                <NewSessionView
                  conversation={conversation}
                  agentControls={{
                    showWorkflow,
                    onToggleWorkflow: () => setShowWorkflow((v) => !v),
                    selectedWorkflowId,
                    onSelectWorkflow: setSelectedWorkflowId,
                    workflows: workflows as any,
                  }}
                />
              ) : (
                <ErrorBoundary name="ProjectSwitcher" level="inline">
                  <ProjectSwitcher conversation={conversation} />
                </ErrorBoundary>
              )
            )}
          </div>
        ) : (
          <>
          {/* Where the session came from and what it was briefed with are
              machine context: fold mode (foldWorkingTurns) renders none of it. */}
          {conversation?.parent_conversation_id && !hasMoreAbove && !foldWorkingTurns && (
            <div className="conv-col mx-auto px-2 sm:px-3 md:px-4 pt-2 pb-1">
              <Link
                href={convLink(conversation.parent_conversation_id)}
                className="inline-flex items-center gap-1.5 text-xs text-sol-cyan/70 hover:text-sol-cyan transition-colors"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
                Spawned from parent session
              </Link>
            </div>
          )}
          {conversation?.fork_status === "copying" && (
            <div className="conv-col mx-auto px-2 sm:px-3 md:px-4 pt-2 pb-1">
              <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-sol-cyan/10 border border-sol-cyan/30 text-sol-cyan text-[11px]">
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span className="tabular-nums">
                  Copying messages from parent
                  {conversation.fork_copy_total
                    ? ` · ${(conversation.fork_copied ?? 0).toLocaleString()} / ${conversation.fork_copy_total.toLocaleString()}`
                    : ` · ${(conversation.fork_copied ?? 0).toLocaleString()} copied`}
                </span>
              </div>
            </div>
          )}
          {/* Context the session was started with — anchored to the transcript
              start, so only when the whole top is loaded (never floating above a
              mid-conversation window). */}
          {conversation?.stable_context && !hasMoreAbove && !isLoadingOlder && !foldWorkingTurns && (
            <StableContextCards stableContext={conversation.stable_context} />
          )}
          {leadNode && !leadPinned && !hasMoreAbove && !isLoadingOlder && leadNode}
          {(density === "story" || density === "summary") ? (
            <div className="conv-col mx-auto px-4 sm:px-5 md:px-6">
              {density === "story" ? (
                <StoryTimelineView
                  conversationId={convexConvId}
                  userName={conversation?.user?.name || conversation?.user?.email?.split("@")[0]}
                  avatarUrl={conversation?.user?.avatar_url}
                  onJump={jumpToStoryMessage}
                />
              ) : (
                <ThreadSummaryView
                  conversationId={convexConvId}
                  userName={conversation?.user?.name || conversation?.user?.email?.split("@")[0]}
                  avatarUrl={conversation?.user?.avatar_url}
                  onJump={jumpToStoryMessage}
                />
              )}
            </div>
          ) : (
          <div
            ref={virtualizer.containerRef}
            style={{
              width: "100%",
              position: "relative",
            }}
          >
            {/* Earlier messages indicator at top (chevron, or spinner while loading) */}
            {(hasMoreAbove || isLoadingOlder) && (
              <EdgeMessagesIndicator dir="up" loading={!!isLoadingOlder}>
                {conversation?.message_count && messages.length < conversation.message_count
                  ? `${conversation.message_count - messages.length} earlier messages`
                  : "Scroll up to load more"}
              </EdgeMessagesIndicator>
            )}
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = timeline[virtualItem.index];
              const content = renderItem(item, virtualItem.index);
              // Only once the scan is complete: pages land oldest first, so dimming
              // earlier would grey out recent rows whose hits are not counted yet.
              const isSearchDimmed = searchStatus === "done" && matchRowIds.size > 0 && item.type === 'message' && !matchRowIds.has((item.data as Message)._id);
              const itemId = item.type === 'message' ? (item.data as Message)._id : item.type === 'commit' ? `commit-${(item.data as any).sha || (item.data as any)._id}` : item.type === 'external_event' ? `event-${(item.data as any)._id}` : `pr-${(item.data as any)._id}`;
              const isNew = newItemIdsRef.current.has(itemId);
              const isToolRow = item.type === 'message' && isToolReceiptRow(item.data as Message, showThinking);
              const isForkSelected = forkSelectionIdx !== null && forkSelectionIdx === virtualItem.index;
              const isBelowForkSelection = forkSelectionIdx !== null && virtualItem.index > forkSelectionIdx;
              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  data-vkey={String(virtualItem.key)}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    ...(content ? {} : { height: 0, overflow: "hidden" }),
                  }}
                >
                  {content && (
                    <div className={`conv-col mx-auto px-4 sm:px-5 md:px-6 ${condensedFeed || isToolRow ? "py-px" : "py-0.5 sm:py-1"} ${isNew ? "animate-message-in" : ""} ${isForkSelected ? "ring-2 ring-sol-cyan/60 bg-sol-cyan/5 rounded-lg" : ""} ${isBelowForkSelection ? "opacity-30 pointer-events-none" : ""} ${isSearchDimmed ? "search-dimmed" : ""} transition-opacity`}>
                      {virtualItem.index === firstUnseenIndex && (
                        <TimelineRule color="var(--sol-orange)" label="New messages">
                          <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-sol-orange">New</span>
                        </TimelineRule>
                      )}
                      {handoffRulesAt(virtualItem.index)}
                      <GalleryMessageScope messageId={item.type === 'message' ? (item.data as Message)._id : undefined}>{content}</GalleryMessageScope>
                      {virtualItem.index === timeline.length - 1 && shouldShowIdleGap({ lastActivityAt, now, hasMoreBelow: !!hasMoreBelow, agentStatus: managedSession?.agent_status }) && (
                        <TimelineRule color="var(--sol-border)" className="mt-5 mb-1" faint>
                          <span className="text-[11px] text-sol-text-dim/60">{formatRelativeTime(lastActivityAt)}</span>
                        </TimelineRule>
                      )}
                      {virtualItem.index === timeline.length - 1 && !hasMoreBelow && handoffRulesAt(timeline.length)}
                    </div>
                  )}
                </div>
              );
            })}
            {/* Later messages indicator at bottom (chevron, or spinner while loading);
                hide the idle state when near top to avoid confusing placement.
                Gated on hasMoreBelow so it only appears in target mode (a deep-linked
                window with content below). In normal mode hasMoreBelow is always
                false, so the initial-page LoadingFirstPage that lights isLoadingNewer
                no longer flashes a spurious "loading" pill on a fresh open. */}
            {(hasMoreBelow && (!isNearTop || isLoadingNewer)) && (
              <EdgeMessagesIndicator dir="down" loading={!!isLoadingNewer}>
                Scroll down to load more
              </EdgeMessagesIndicator>
            )}
          </div>
          )}
          {handedOffTo && !hasMoreBelow && (
            <div className="conv-col mx-auto px-4 sm:px-5 md:px-6">
              <SessionHandoffNotice details={handedOffTo} convLink={convLink} navigateToSession={navigateToSession} />
            </div>
          )}
          {continuationChildren.length > 0 && !hasMoreBelow && (() => {
            return (
              <div className="conv-col mx-auto px-2 sm:px-3 md:px-4 pt-3 pb-8">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-sol-text-secondary uppercase tracking-wider font-medium">Continued in</span>
                  {continuationChildren.map((child) => (
                    <Link
                      key={child._id}
                      href={convLink(child._id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs bg-sol-cyan/15 text-sol-text-secondary border border-sol-cyan/30 hover:bg-sol-cyan/25 hover:text-sol-text transition-colors max-w-[400px]"
                    >
                      <svg className="w-2.5 h-2.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                      </svg>
                      <span className="truncate min-w-0">{child.title}</span>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })()}
          </>
        )}

        </div>
      </div>

      {/* The branch map renders in-flow above the message input (see the
          composer block below) so it matches the input's width and reads as one
          piece. This fixed fallback only covers the rare case where there is no
          composer to anchor to (owner with a permission prompt instead). */}
      {conversation && treePopoverOpen && !(showMessageInput && !(pendingPermissions && pendingPermissions.length > 0)) && (
        <ForkMapFallback
          conversation={conversation}
          conversationId={conversation._id.toString()}
          currentBranchId={conversation._id.toString()}
          open={treePopoverOpen}
          initialDrillId={mapDrill}
          onClose={() => setTreePopoverOpen(false)}
          onSwitchToConversation={handleTreeSwitchConversation}
          onForkFromBranch={handleForkFromBranch}
          forkAnyMessage={forkAnyMessage}
          onRewindCurrent={handleRewindCurrent}
        />
      )}

      </div>

      {/* The pinned thread state belongs under the composer's status line
          (threadStateNode on MessageInput below). When the owner composer is
          not mounted — a permission prompt owns the input, or a non-owner is
          reading — it sits here between the feed and whatever replaces the
          composer, outside data-sv-feed so it can't perturb the virtualizer.
          It renders nothing when the agent has not pinned a state. */}
      {!ownerComposerMounted && !onSendOverride && threadStatePanel}

      {decisionItem && conversation && !onSendOverride && (
        <SessionDecisionCard key={decisionItem.key} item={decisionItem} stepper={decisionStepper} />
      )}

      {showMessageInput && conversation && !(pendingPermissions && pendingPermissions.length > 0) && (
        <div ref={messageInputRef} className="relative">
          {/* The branch map is melded INTO the owner composer box (see the
              branchMapNode prop on MessageInput below), the same way the quote
              ReviewBar tray is — so it reads as one piece with the input rather
              than a floating overlay. treePopoverOpen is owner-only, so only the
              owner branch needs it; the no-composer case is the fixed fallback
              above. */}
          {!effectiveIsOwner ? (
            <NonOwnerMessageInput
              conversation={conversation}
              onForkReply={handleForkReply}
              autoFocusInput={autoFocusInput}
            />
          ) : (
            <>
              {/* Who else is in this box: a teammate's live draft above the
                  composer on every real conversation, and "is here" for a
                  share link guest with no face on the roster. */}
              {composerPresenceEnabled(conversation) && (
                <OwnerComposerPresence conversationId={conversation._id.toString()} showHere={!!conversation.share_token} />
              )}
              <CollabRequestBanner conversationId={conversation._id.toString()} />
              {workflowRun?.status === "paused" && workflowRun.gate_prompt ? (
                <div className="absolute left-0 right-0 bottom-full flex items-center gap-2 px-4 py-1.5 bg-sol-bg border-t border-sol-magenta/20 text-xs">
                  <span className="text-sol-magenta font-semibold shrink-0">Gate</span>
                  <span className="text-sol-text-muted truncate flex-1">{workflowRun.gate_prompt}</span>
                  {workflowRun.gate_choices?.map(choice => (
                    <button
                      key={choice.key}
                      onClick={() => handleGateRespond(choice.key)}
                      disabled={gateResponding}
                      className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-medium text-sol-magenta border border-sol-magenta/30 rounded hover:bg-sol-magenta/10 transition-colors disabled:opacity-40"
                    >
                      [{choice.key}] {choice.label.replace(/^\[.\]\s*/, "")}
                    </button>
                  ))}
                </div>
              ) : null}
              <MessageInput key={conversation.session_id || conversation._id} conversationId={conversation._id} status={conversation.status} embedded={embedded} onSendAndAdvance={onSendAndAdvance} onSendAndDismiss={onSendAndDismiss ?? sendAndStashFallback} autoFocusInput={autoFocusInput} initialDraft={conversation.draft_message} isWaitingForResponse={isWaitingForResponse} isThinking={isThinking} isConversationLive={isConversationLive} workingSinceTs={workingSinceForClock(latestMessageTimestamp, now)} workingPhrase={workingPhrase} isSessionDisconnected={conversation.is_workflow_primary ? false : isSessionDisconnected} isSessionStarting={isSessionStarting} isSessionReady={isSessionReady} sessionId={conversation.session_id} agentType={conversation.agent_type} agentStatus={managedSession?.agent_status === "hibernated" ? "hibernated" : isSessionDisconnected || conversation.status !== "active" ? undefined : managedSession?.agent_status as any} deliveryStatus={managedSession?.agent_status as any} pendingPermissionsCount={pendingPermissions?.length ?? 0} hasAskUserQuestion={hasAskUserQuestion} selectedMessageContent={selectedMessageContent} selectedMessageUuid={selectedMessageUuid} onClearSelection={handleClearSelection} onForkFromMessage={forkHandler} onForkSend={forkSendHandler} onSendEscape={handleSendEscape} onOpenNavigator={handleOpenNavigator} onPopulateInput={populateInputRef} permissionMode={effectiveMode} permissionModePending={modeSwitching} onCycleMode={handleCycleMode} onMessageSent={handleMessageSent} onLightboxChange={setIsImageLightboxActive} onDropFiles={dropFilesRef} onWorkflowLaunch={showWorkflow && selectedWorkflowId ? handleWorkflowLaunch : undefined} onGateSend={onSendOverride ?? (workflowRun?.status === "paused" ? handleGateRespond : undefined)} composerNode={composerNode} composerPlaceholder={composerPlaceholder} skills={sessionSkills} filePaths={sessionFilePaths} mentionItemsRef={mentionItemsRef} onMentionQuery={handleMentionQuery} onSubmitWithIntent={onSubmitWithIntent} threadStateNode={onSendOverride ? undefined : threadStatePanel} branchMapNode={treePopoverOpen ? (
                <ForkMapBox
                  tray
                  open
                  className="max-h-[55vh]"
                  getIgnore={() => treeChipRef.current}
                  conversation={conversation}
                  conversationId={conversation._id.toString()}
                  currentBranchId={conversation._id.toString()}
                  initialDrillId={mapDrill}
                  onClose={() => setTreePopoverOpen(false)}
                  onSwitchToConversation={handleTreeSwitchConversation}
                  onForkFromBranch={handleForkFromBranch}
                  forkAnyMessage={forkAnyMessage}
                  onRewindCurrent={handleRewindCurrent}
                />
              ) : null} />
            </>
          )}
        </div>
      )}

      {timeline.length > 0 && (
        <div data-cc-scroll-tools className="absolute right-3 sm:right-8 z-30 flex items-stretch gap-2.5" style={{ bottom: Math.max(messageInputHeight + 16, 115), transform: commentRailW ? `translateX(-${commentRailW}px)` : undefined, transition: "transform 160ms ease" }}>
          <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  if (jumpPending === 'start') {
                    handleCancelJump();
                  } else if (hasMoreAbove && onJumpToStart) {
                    jumpDirectionRef.current = 'start';
                    setJumpPending('start');
                    onJumpToStart();
                  } else {
                    setUserScrolled(true);
                    paginationCooldownRef.current = Date.now() + 1000;
                    scrollToEdgeRef.current('top');
                  }
                }}
                className={`group p-1.5 sm:p-2 rounded-full bg-sol-bg-alt border border-sol-border shadow-lg hover:bg-sol-cyan hover:text-white transition-all ${((!isNearTop && isScrollable) || hasMoreAbove || jumpPending === 'start') ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                aria-label={jumpPending === 'start' ? "Cancel jump to top" : "Scroll to top"}
                title={jumpPending === 'start' ? "Cancel" : undefined}
              >
                {(isLoadingOlder || jumpPending === 'start') ? (
                  <>
                    {/* Spinner by default; reveal a cancel (×) on hover so the
                        in-flight jump can be aborted by clicking it. */}
                    <svg className="w-4 h-4 sm:w-5 sm:h-5 animate-spin group-hover:hidden" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <svg className="w-4 h-4 sm:w-5 sm:h-5 hidden group-hover:block" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </>
                ) : (
                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => {
                  if (jumpPending === 'end') {
                    handleCancelJump();
                  } else if (hasMoreBelow && onJumpToEnd) {
                    jumpDirectionRef.current = 'end';
                    setJumpPending('end');
                    setGuestStayAtTop(false);
                    onJumpToEnd();
                  } else {
                    setGuestStayAtTop(false);
                    setUserScrolled(false);
                    paginationCooldownRef.current = Date.now() + 1000;
                    scrollToEdgeRef.current('bottom');
                  }
                }}
                className={`group p-1.5 sm:p-2 rounded-full bg-sol-bg-alt border border-sol-border shadow-lg hover:bg-sol-cyan hover:text-white transition-all ${(((userScrolled || guestStayAtTop) && !isNearBottom && isScrollable) || hasMoreBelow || jumpPending === 'end') ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                aria-label={jumpPending === 'end' ? "Cancel jump to bottom" : "Scroll to bottom"}
                title={jumpPending === 'end' ? "Cancel" : undefined}
              >
                {((isLoadingNewer && hasMoreBelow) || jumpPending === 'end') ? (
                  <>
                    {/* Spinner ONLY for a genuine in-flight load of more content
                        below (target mode: isLoadingNewer && hasMoreBelow) or an
                        explicit jump-to-end. In normal mode hasMoreBelow is always
                        false, so the initial-page LoadingFirstPage (which drives
                        isLoadingNewer) can no longer surface a spurious spinner on
                        a fresh open — the button shows the static down-chevron.
                        Reveal a cancel (×) on hover so an in-flight jump can be
                        aborted by clicking it. */}
                    <svg className="w-4 h-4 sm:w-5 sm:h-5 animate-spin group-hover:hidden" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    <svg className="w-4 h-4 sm:w-5 sm:h-5 hidden group-hover:block" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </>
                ) : (
                  <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                  </svg>
                )}
              </button>
          </div>
          {(isScrollable || hasMoreAbove || hasMoreBelow) && (
            <div className="hidden sm:block w-2 self-stretch bg-sol-base02 rounded-full overflow-hidden">
              <div
                data-cc-scroll-progress
                ref={scrollProgressRef}
                className="w-full bg-sol-green/80 rounded-full"
                style={{ height: '0%', transition: 'height 0.15s ease-out' }}
              />
            </div>
          )}
        </div>
      )}

      {pendingPermissions && pendingPermissions.length > 0 && (
        <div className={`border-t border-sol-border/40 shrink-0 ${embedded ? "-mx-[9999px] px-[9999px]" : ""}`}>
          <div className="conv-col mx-auto px-2 sm:px-3 md:px-4 py-1.5">
            <PermissionStack
              permissions={pendingPermissions as any}
              onAllowAll={
                (conversation?.agent_type ?? "claude_code") === "claude_code" &&
                effectiveIsOwner &&
                conversation?.status === "active" &&
                effectiveMode !== "bypassPermissions"
                  ? handleEnableBypass
                  : undefined
              }
            />
          </div>
        </div>
      )}

      {shareSelectionMode && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-sol-bg-alt border border-sol-border rounded-lg shadow-xl px-4 py-3">
          <span className="text-sm text-sol-text-secondary">
            {selectedMessageIds.size} message{selectedMessageIds.size !== 1 ? "s" : ""} selected
          </span>
          <label
            className="flex items-center gap-1.5 text-sm text-sol-text-secondary cursor-pointer select-none"
            title="Add a link to the full conversation on the shared page. This makes the conversation viewable by anyone with that link."
          >
            <input
              type="checkbox"
              checked={shareIncludeConversation}
              onChange={(e) => setShareIncludeConversation(e.target.checked)}
              className="accent-[var(--sol-cyan)]"
            />
            Link full conversation
            {shareIncludeConversation && <span className="text-xs text-sol-text-dim">(becomes public)</span>}
          </label>
          <button
            onClick={handleCancelShareSelection}
            className="px-3 py-1.5 text-sm text-sol-text-dim hover:text-sol-text-secondary transition-colors"
          >
            Cancel
          </button>
          {chatOn && (
            <button
              onClick={() => handleConfirmShare("chat")}
              disabled={selectedMessageIds.size === 0 || isCreatingShareLink}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-sol-bg hover:bg-sol-border text-sol-text-secondary rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Forward className="w-4 h-4" />
              Send to chat
            </button>
          )}
          <button
            onClick={() => handleConfirmShare()}
            disabled={selectedMessageIds.size === 0 || isCreatingShareLink}
            className="px-4 py-1.5 text-sm bg-sol-cyan hover:bg-sol-cyan/80 text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreatingShareLink ? "Creating..." : "Copy share link"}
          </button>
        </div>
      )}
      {/* The header face's picker (session-characters.md S2), one instance. */}
      <CursorPopover state={headerCharacterPicker}>
        {(rows) => <CharacterPicker rows={rows as any} onDone={headerCharacterPicker.close} />}
      </CursorPopover>
      <SelectionQuoteToolbar conversationId={conversation?._id ?? ""} />
      {conversation && (
        <Suspense fallback={null}>
          <CommentDock conversationId={conversation._id.toString()} />
        </Suspense>
      )}
    </main>
    </ReviewComposerContext.Provider>
    </ImageGalleryProvider>
    </ChatWakeContext.Provider>
    </RevealAncestryCtx.Provider>
    </BrowserSessionContext.Provider>
    </CastBrowserRowContext.Provider>
    </WorktreesProvider>
    </FilePathContext.Provider>
    </HighlightContext.Provider>
  );
  devCountElements("ConversationView2", el, performance.now() - renderStart);
  return el;
}
);

// memo: the parents (InboxConversation, ConversationDiffLayout) re-run several
// times per session switch on their own hooks; without memo every one of those
// passes re-ran this 5k-line body (measured 44 body executions per switch).
export const ConversationView = memo(forwardRef<ConversationViewHandle, ConversationViewProps>(ConversationViewInner));
