import Link from "next/link";
import { dragCarriesPane } from "../lib/stage";
import { LogoIcon } from "./Logo";
import { AppLoader } from "./AppLoader";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, useMemo, useImperativeHandle, forwardRef, useCallback, memo, createContext, useContext, Fragment, ComponentProps, type ReactElement, type ReactNode, type ForwardedRef } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useEventListener } from "../hooks/useEventListener";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useTeamRosterIdentity } from "../hooks/useTeamRoster";
import { useShortcutContext, useShortcutAction, isMac, getShortcutsForAction, formatShortcutParts, formatAcceleratorParts, hasOpenModal, altChordDirection, type ShortcutAction } from "../shortcuts";
import { useConvexSync } from "../hooks/useConvexSync";
import { useChatMessageRow, useEnsureChatMessage } from "../hooks/useChatSync";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useShallow } from "zustand/react/shallow";
import { createPortal } from "react-dom";
import ReactMarkdownBase from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { rehypeSearchHighlight } from "../lib/rehypeSearchHighlight";
import { compressImage } from "../lib/compressImage";
import { textareaCaretRect } from "../lib/textareaCaret";
import { useStorageImageSrc, useStorageImageUrls, hasDecodedSrc, markSrcDecoded } from "../hooks/useStorageImageUrl";
import { AvatarImg } from "../lib/avatarCache";
import { extractSessionImages, mergeSessionImages, type SessionImageEntry } from "../lib/sessionImages";
import { isRemoteImageSrc } from "../lib/trustedImageOrigins";
import { shareTokenArg } from "../lib/shareTokenScope";
import { extractBrowserTabId, focusBrowserTab, prefetchBrowserFocusEndpoint } from "../lib/browserFocus";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isCommandMessage, getCommandType, cleanContent, cleanTitle, isSkillExpansion, extractSkillInfo, extractFilePaths, isSystemMessage, isHiddenSystemNotice, isWarningSystemNotice, isImportNotice, formatModel, isBackgroundAgentStoppedNotice, backgroundAgentStoppedName, parseBashInput, parseBashOutput, commandExpansionName } from "../lib/conversationProcessor";
import { splitMarkdownBlocks } from "../lib/markdownBlocks";
import { classifyApiErrorBanner, agentSupportsFork, ACTIVE_AGENT_STATUSES, CLIENT_ERROR_BANNER_PREFIX, PROVIDER_KEYS, getProviderKeySpec, AGENT_LAUNCH_OPTIONS, parseThreadStateStatus, parseDecisionAnswer, isAgentSwitchNotice, parseAgentSwitchNotice, isModelSwitchCommandName, isModelSwitchStdout, modelSwitchStdoutLabel, type ConvexAgentType, type AgentStatus, type ThreadStateFields, type DecisionAnswerMessage } from "@codecast/shared/contracts";
import { DecisionAnswerFooter } from "./DecisionAnswerFooter";
import { useCoarseNow, useNowWhen } from "../hooks/useCoarseNow";
import { parseLimitResetAt } from "../lib/limitReset";
import {
  describeSmallToolGroup,
  describeToolGroup,
  extractNestedActions,
  formatToolName,
  isAgentTool,
  isAskTool,
  isEditTool,
  isGlobTool,
  isGrepTool,
  isPlanModeTool,
  isPlanWriteToolCall,
  isReadTool,
  isShellTool,
  isTodoTool,
  isWriteTool,
  shortenUrl,
  splitBrowserBatchResult,
  stripLineNumbers,
  structuredPayloadSummary,
  summarizeNestedActions,
  toolPathFromInput,
  toolSummary as sharedToolSummary,
  toolVisual,
  BROWSER_BATCH_TOOL,
  type NestedStepOutcome,
  type ToolColorToken,
  truncateStr,
  getRelativePath,
} from "@codecast/shared/render";
import { getBuiltinCommands } from "../lib/builtinCommands";
import { resolveSessionSkills } from "../lib/sessionSkills";
import { entityRoute } from "../lib/entityLinks";
import { pendingImageUploads, persistDraftImages, restoreDraftImages, settleDraftImageUpload } from "../lib/draftImages";
import { isResentCopyOfSentMessage } from "../lib/staleDraft";
import type { SkillItem } from "../lib/conversationProcessor";
import { latestUsageOf } from "../lib/messageReducer";
import { UsageDisplay } from "./UsageDisplay";
import { StableContextCards, StableContextPicker } from "./StableContextCards";
import { ErrorBoundary } from "./ErrorBoundary";
import { KeyCap, MenuKeyCaps, ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { animatedHideSession } from "../store/undoActions";
import { toast } from "sonner";
import { CodeBlock } from "./CodeBlock";
import { tryRenderCastDiff, MessageIdentityProvider } from "./InlineDiff";
import { useFullWidthExpand } from "../hooks/useFullWidthExpand";
import { tryRenderCanvas, tryRenderHtmlMessage } from "./HtmlSnippet";
import { useDiffViewerStore } from "../store/diffViewerStore";
import { isJumpReadyToScroll, shouldFollowStreaming, shouldLoadOlder, shouldLoadNewer } from "./conversationScroll";
import { parseInsightBlocks } from "./insightBlocks";
import { formatElapsedClock, shouldShowElapsed, deriveRunningTool } from "./workingStatus";
import { appendToDraft, formatPlanFeedback } from "../lib/quoteFormat";
import { imagePlaceholderToken, insertImagePlaceholder, dropImagePlaceholder } from "../lib/imagePlaceholder";
import { quoteToComposer, submitReview, attachReviewToMessage, takeReviewBatch } from "../lib/reviewActions";
import { quoteSelectionIntoReply } from "../lib/quoteSelection";
import { MessageReview } from "./MessageReview";
import { SelectionQuoteToolbar } from "./SelectionQuoteToolbar";
import { ReviewBar } from "./ReviewBar";
import { SuggestionPills, SuggestionPillsHandle } from "./SuggestionPills";
import { ReviewComposerContext } from "./reviewContext";
import { CommentDock } from "./comments/CommentDock";
import { useConversationCommentsSync } from "../hooks/useConversationComments";
import { parseTriggerCadence, fmtDuration, fmtClock } from "./triggerCadence";
import { TriggerPromptView } from "./TriggerPromptView";
import { CollapsibleBody, ExpandableLine } from "./CollapsibleBody";
import { monitorRowsFor, effectiveMonitorStatus, isWatchHostDead, reportSaysDead, isBackgroundBashToolCall, parseTaskNotificationBlock, isMonitorEventNotification, isMonitorEndedNotification, isOrphanSummaryNotification, monitorNotificationDescription, parseNotificationSummary, decodeEntities, type MonitorStatus } from "./monitorRows";

function messageLink(conversationId: string | undefined, messageId: string) {
  return `${shareOrigin()}/conversation/${conversationId}#msg-${messageId}`;
}

function copyMessageLink(conversationId: string | undefined, messageId: string) {
  const url = messageLink(conversationId, messageId);
  setTimeout(() => { copyToClipboard(url).then(() => toast.success("Link copied!")).catch(() => toast.error("Failed to copy link")); });
}

function forwardMessageToChat(conversationId: string | undefined, messageId: string) {
  openForwardToChat({ url: messageLink(conversationId, messageId), label: "message" });
}

function extractTextFromHast(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  if (node.children) return node.children.map(extractTextFromHast).join('');
  return '';
}
import { extractFileChanges } from "../lib/fileChangeExtractor";
import { parseWorkflowScriptMeta, parseWorkflowLaunch } from "../lib/workflowLaunch";
import { CommitCard } from "./CommitCard";
import { PRCard } from "./PRCard";
import { DiffView } from "./DiffView";
import { AgentTypeIcon, formatAgentType } from "./AgentTypeIcon";
import { GrokIcon as GrokMark } from "./BrandIcons";
import { AnchorHeaderPill } from "./anchor/AnchorHeaderPill";
import { HeaderModelControl, LaunchModelPill } from "./ModelEffortPicker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./ui/dropdown-menu";
import { TooltipProvider } from "./ui/tooltip";
import { useMutation, useQuery, useConvex, useConvexAuth, useAction } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { DynamicRunView, wfStatusMeta, wfFmtTokens } from "./DynamicRunView";
const api = _typedApi as any;
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { AssignmentBadge } from "./AssignmentBadge";
import { AssignedToYouBanner, useOwnersFromStore } from "./OwnersBadge";
import { TmuxAttachPill, useAttachCopy } from "./TmuxAttachPill";
import { SessionDaemonChip } from "./DaemonStatusChip";
import { SessionFilesButton } from "./SessionFilesButton";
import { ConversationTerminalSplit } from "./terminal/ConversationTerminal";
import { BrowserWatchSplit, toggleBrowserWatch, useBrowserWatchOpen } from "./browser/BrowserWatchSplit";
import { PermissionStack, PERMISSION_SKIP_TOOLS } from "./PermissionCard";
import { SessionDecisionCard } from "./SessionDecisionCard";
import { DecisionStepperContext, usePendingDecisionItem } from "../hooks/useDecisionQueue";
import { copyToClipboard, shareOrigin, buildProjectPathOptions, inferHomeDir, resolveCustomPath, displayPath, inferProjectBase } from "../lib/utils";
import { findEntityInStore } from "../lib/liveEntities";
import { useWorkflowRun, useWorkflows } from "../hooks/useSyncWorkflows";
import { usePendingMessageStatus, usePendingPermissions } from "../hooks/useSyncPendingPermissions";
import { inActiveWorkspace } from "../lib/workspaceScope";
import { MarkdownRenderer, isMarkdownFile, isPlanFile, CollapsibleImage, ImageRowParagraph } from "./tools/MarkdownRenderer";
import { OptionPreview } from "./tools/AskUserQuestionToolView";
import { buildPollPayload, pollKeyForOption, SYNTHETIC_POLL_OPTION } from "../lib/pollPayload";
import { dropScrapedProseTwins } from "../lib/proseTwins";
import { useImageGallery, ImageGalleryProvider } from "./ImageGallery";
import { MessageSharePopover } from "./MessageSharePopover";
import { PlanBadge, TaskBadge } from "./PlanTaskHoverCard";
import { EntityIdPill, EntityAwareCode, EntityAwareLink, renderWithMentions } from "./EntityIdPill";
import { SessionHuddleButton } from "./calls/OccupancyChip";
import { FormattedSummary } from "./FormattedSummary";
import { ThreadStatePanel } from "./ThreadStatePanel";
import { THREAD_STATE_STATUS_META } from "../lib/threadState";
import { entityRemarkPlugins } from "../lib/remarkEntityIds";
import remarkBreaks from "remark-breaks";
import { MESSAGE_MD_REHYPE, MESSAGE_MD_COMPONENTS, USER_MD_REMARK, renderMarkdownPre } from "./messageMarkdown";
import { FilePathLink } from "./FilePathLink";
import { FilePathContext } from "../lib/filePathLinks";
import { isStickyEligible, pickStickyFallbackFromLoaded } from "../lib/messageNavigator";
import { parseInboundSessionMessage, isTeammateFramingOnly, isSpawnedTaskPrompt, parseSpawnedTaskPrompt, stickyPromptContent, parseChatWakePrompt, parseHuddleSummaryTag, type ChatWakePrompt, type HuddleSummaryTag } from "./sessionMessage";
import { CallTranscriptDisclosure } from "./calls/TranscriptTurns";
import { CollabComposer, CollabRequestBanner, OwnerComposerPresence } from "./CollabComposer";
import { parseCastCommandString, stripCdPrefix, unwrapShellCommand, extractSendBody, extractChatSendArgs, normalizeCastCategory, extractCastBodyParts, extractStateArgs, extractBrowserPageUrl, buildBrowserRowMap, sameBrowserRowMap, extractBrowserDoSteps, splitBrowserDoOutput, extractDecideArgs, type BrowserRowInput, type BrowserRowState, type CastBodyPart, type ChatSendArgs, type ParsedCastCommand, type DecideArgs } from "./castCommand";
import { ConversationTree } from "./ConversationTree";
import { useInboxStore, useTrackedStore, isConvexId, computeNewDividerIndex, convBucketMap, pendingRowSendArgs, type BucketItem, type ForkChild, type InboxSession, type OptimisticImage, type SessionDecisionItem } from "../store/inboxStore";
import { DispatchNotWiredError, isParkedDispatchError } from "../store/mutativeMiddleware";


// restartSession can answer with a DIFFERENT conversation: the ghost's live
// twin, or a freshly recreated row. Follow it there, and clear the ghost from
// the cache once we've left it (pruneGhostSessions skips the open session, so
// the delayed call runs after navigation lands; both calls are no-op safe).
// Returns true when it redirected.
function followRestoredConversation(res: any, ghostId: string): boolean {
  const targetId = res?.conversation_id;
  if (!res?.restored || !targetId || targetId === ghostId) return false;
  toast.success("This conversation was deleted on the server — restored its live session");
  // Same logical conversation reborn under a new id — rekey-class, not a jump.
  useInboxStore.getState().requestNavigate(targetId, { source: "rekey" });
  useInboxStore.getState().pruneGhostSessions([ghostId]);
  setTimeout(() => useInboxStore.getState().pruneGhostSessions([ghostId]), 3000);
  return true;
}
import { getLabelColor } from "../lib/labelColors";
import { useCurrentUser } from "../hooks/useCurrentUser";
import {
  browseProjectOrder,
  frequentProjectChips,
  mergeRecentProjectPaths,
  recentProjectPathsFromSessionKeys,
  recentProjectSessionKey,
} from "../lib/recentProjectPaths";
import { soundSend } from "../lib/sounds";
import { useForkNavigationStore } from "../store/forkNavigationStore";
import { buildCompositeTimeline } from "../lib/compositeTimeline";
import { useMessageSelection } from "../hooks/useMessageSelection";
import { useMessageBookmark } from "../hooks/useMessageBookmark";
import { BranchSelector } from "./BranchSelector";
import { ForkMapBox, ForkMapFallback } from "./ForkTreePanel";
import { getApplyPatchInput, parseApplyPatchSections } from "../lib/applyPatchParser";
import { parseFileChangeSummary, parseUnifiedDiffSections } from "../lib/unifiedDiffParser";
import { setupDesktopDrag, desktopHeaderClass, isDetachedTabWindow } from "../lib/desktop";
import { useTitlebarHead } from "../hooks/useTitlebarHead";
import { MessageNavButton } from "./MessageBrowserPopover";
import type { MentionItem } from "./editor/MentionList";
import { CheckSquare, FileText, MessageSquare, Map as MapIcon, User, Users, Hash, FolderOpen, Keyboard, ListChecks, Target, Maximize2, Minimize2, Circle, CircleDot, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Clock, CornerDownRight, CornerUpRight, BookOpen, Check, Split, Workflow, Tag, MoveHorizontal, AlignJustify, ListCollapse, GalleryVerticalEnd, GitCommitVertical, BookOpenText, Wrench, Zap, Radar, Terminal, KeyRound, ExternalLink, Loader2, Search, Bot, Copy as CopyIcon, Link2, Bookmark as BookmarkIcon, Share2, Pin, Forward, PhoneCall, Archive } from "lucide-react";
import { openForwardToChat } from "../lib/forwardToChat";
import { useTeamFeature } from "../lib/teamFeatures";
import { ContextMenu, useContextMenu, CtxItem, CtxSeparator } from "./ui/context-menu";
import { useDevices, useDeviceMoveStatus, DeviceDot, DeviceIcon, deviceAccentClasses, deviceDisplayName, type Device } from "./DeviceBadge";
import { defaultMachineId, dedupeProjectsByRepoName, pathOnMyMachines, repoName, resolveMachineSelection, resolveScopedProjects } from "../lib/machinePicker";
import { useProviderKeyCommand, deviceManagedKeys } from "../lib/useProviderKeyCommand";
import { ComposeEditor, type ComposeEditorHandle } from "./editor/ComposeEditor";
import { useMentionQuery, useMentionServerSearch, SERVER_MENTION_TYPES, labelMentionItems, matchScore, mentionItemMatches } from "../hooks/useMentionQuery";
import { pendingBannerState, isActiveAgentStatus, isBootingAgentStatus, isAliveIdleStatus, type LiveAgentStatus } from "../lib/pendingBanner";
import { PendingDeliveryNote } from "./PendingDeliveryNote";
import { sessionStartupState, SESSION_STARTING_GRACE_MS } from "../lib/sessionLifecycle";
import { messageRowKey, uniqueRowKeys } from "../lib/messageRowKey";
import { expandEntityMentions } from "../lib/mentionExpansion";
import { useSessionRestart, ghostRestartContextFor, deriveRestartStage, type RestartProgressRow, type RestartPhase, type RestartStage } from "../hooks/useSessionRestart";
import { devRenderCount, devCountElements } from "../lib/devRenderCount";

// An @-mention query may contain spaces so multi-word titles are searchable: a
// first token (possibly empty, so a bare "@" still opens recents) plus up to 4
// more space-separated words, with an optional trailing space so the popup stays
// open while you pause mid-phrase. Only an ASCII space extends it — a tab or
// newline still terminates the mention. The 4-word cap stops it eating a whole
// sentence, and once a phrase settles on zero matches the trigger latches shut
// (mentionDeadEndRef below), so a stray "@foo bar baz" quietly falls back to
// prose instead of re-searching on every keystroke.
// MENTION_TRIGGER_RE matches at the cursor (text before the caret, $-anchored);
// MENTION_QUERY_RE re-extracts the same body from the text after the "@".
// Native textarea autosize (Chromium 123+ / the Electron desktop app): the
// browser grows the field with content, replacing the JS write→measure→write
// autosize that forced two full-page reflows per keystroke. Safari falls back
// to the JS path in resetTextareaHeight.
// Chat's caret-anchored @ popup. Wide enough that a session row's title, its
// message count and its age fit on one line — 340px truncated most of them.
const CHAT_AC_WIDTH = 480;

const FIELD_SIZING_SUPPORTED =
  typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");
const FIELD_SIZING_STYLE: React.CSSProperties = FIELD_SIZING_SUPPORTED
  ? ({ fieldSizing: "content" } as React.CSSProperties)
  : {};

const MENTION_TRIGGER_RE = /@([\w./\\-]*(?: [\w./\\-]+){0,4} ?)$/;
const MENTION_QUERY_RE = /^[\w./\\-]*(?: [\w./\\-]+){0,4} ?/;

// How long a sent message may sit in the optimistic/pending state before the
// message row surfaces a status hint. Normal delivery confirms in a few seconds.
// Past this we show "queued · agent busy" while the agent is actively working
// (the daemon defers injection until the turn ends — the message WILL land), and
// only escalate to "hasn't reached / kill & restart" when the agent is idle.
const PENDING_RETRY_AFTER_MS = 20_000;

// Extra grace after the agent flips busy→idle before the kill & restart
// escalation may appear: the daemon injects deferred messages within its next
// poll once the turn ends, so a message that's been pending behind a long turn
// shouldn't flash "hasn't reached the agent" the instant the agent goes idle.
const PENDING_IDLE_GRACE_MS = 8_000;

// A booting / resuming / freshly-connected session legitimately takes far longer
// than a turn to begin processing the first message, so the per-message banner
// stays calm ("queued") this long before escalating to the alarming kill & restart.
// Mirrors the composer banner's startup/resume thresholds so the two agree.
const PENDING_BOOT_GRACE_MS = 60_000;     // starting / connected: session launch budget
const PENDING_RESUME_GRACE_MS = 120_000;  // resuming is the slowest path


// deriveRestartStage (the live label for a kill+restart in flight) lives in
// hooks/useSessionRestart so the composer footer ladder, the on-message retry
// bar, and the header restart strip all report the same real progress.

const sacredInputs = new Map<string, { text: string; images?: any[] }>();

// True when a persisted draft is just a copy of a message already sent in this
// conversation (see lib/staleDraft.ts) — refuse it at restore time. Reads the
// loaded message window; on a cold first visit it may be empty, in which case
// the draft shows once more and heals on the next mount.
function isStaleSentDraft(conversationId: string, text: string | null | undefined): boolean {
  return isResentCopyOfSentMessage(useInboxStore.getState().messages[conversationId], text);
}

const EMPTY_PENDING: any[] = [];
const EMPTY_MESSAGES: any[] = [];
const EMPTY_MATCH_IDS: string[] = [];
const EMPTY_MATCH_INSTANCES: { messageId: string; localIndex: number; timestamp: number }[] = [];
const EMPTY_QUEUE: string[] = [];

// Skips a Convex query for the first paint after the keyed value (e.g. conversation id)
// changes, then enables it on the next macrotask. Lets the message list paint before the
// non-critical query cascade fires.
function useDeferUntilSettled(key: string | null | undefined): boolean {
  const [enabledKey, setEnabledKey] = useState<string | null | undefined>(key);
  useEffect(() => {
    if (!key || enabledKey === key) return;
    const id = setTimeout(() => setEnabledKey(key), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return enabledKey === key;
}

/** Ensure a value is a string before rendering as a React child.
 *  Guards against intermittent race conditions where content fields
 *  are briefly non-string during store hydration or subscription updates. */
function safeString(value: any): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function parseSearchTerms(query: string): string[] {
  const terms: string[] = [];
  const regex = /"([^"]+)"|(\S+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    const term = match[1] || match[2];
    if (term) terms.push(term.toLowerCase());
  }
  return terms;
}

const HighlightContext = createContext<string | undefined>(undefined);

// toolCallId → the page URL and driven tab a `cast browser` row was on,
// carried forward from earlier rows when the row's own output doesn't restate
// them (most action verbs don't — see buildBrowserRowMap). CastCommandBlock
// falls back to this for its "open tab" link. Provided by the message feed
// with a content-stable identity so an unrelated message sync doesn't
// re-render every cast row.
const CastBrowserRowContext = createContext<Record<string, BrowserRowState>>({});

// placeholder message id → the team-chat wake that asked for it. A `cast chat
// reply` names only the placeholder, so the reply card reads the channel and
// thread off the wake in the same transcript — no lookup, and it still works
// after the chat thread is deleted. Keyed by placeholder id, so identity is
// stable across syncs that added no wake.
const ChatWakeContext = createContext<Record<string, ChatWakePrompt>>({});

type ReactMarkdownProps = ComponentProps<typeof ReactMarkdownBase>;

/**
 * ReactMarkdown wrapper that appends `rehypeSearchHighlight` to the plugin list
 * whenever a `highlightQuery` is active in the HighlightContext. Because the plugin
 * transforms the HAST before React renders, highlights are part of the VDOM and
 * survive re-renders — avoiding the MutationObserver/TreeWalker race we used before.
 *
 * memo: react-markdown re-runs its full parse pipeline on every render, so a
 * parent re-render (streaming tick, heartbeat) must bail out here whenever the
 * props are unchanged. Only works when call sites pass module-stable plugin
 * arrays and component maps — never inline literals. Context updates (search
 * query) bypass memo, so highlights still repaint.
 */
const ReactMarkdown = memo(function ReactMarkdown(props: ReactMarkdownProps) {
  const query = useContext(HighlightContext);
  const userPlugins = props.rehypePlugins;
  const plugins = useMemo(() => {
    const base = userPlugins ? [...userPlugins] : [];
    if (!query) return base;
    const terms = parseSearchTerms(query);
    if (terms.length === 0) return base;
    base.push([rehypeSearchHighlight, { terms }]);
    return base;
  }, [query, userPlugins]);
  return <ReactMarkdownBase {...props} rehypePlugins={plugins} />;
});

// Stable variants for non-message-body call sites (tool results, sent-message
// cards, command markdown, summaries). Same identity rule as above: the memo'd
// ReactMarkdown wrapper only bails out of a re-parse when these are module consts.
const MD_COMPONENTS_CODE_LINK = { code: MESSAGE_MD_COMPONENTS.code, a: MESSAGE_MD_COMPONENTS.a };
// "No images" must be enforced, not implied: with no `img` override react-markdown
// emits a raw <img>, which auto-fetches — full-bleed layout AND the third-party
// beacon channel CollapsibleImage's click gate exists to close.
const MD_COMPONENTS_NO_IMG = { ...MD_COMPONENTS_CODE_LINK, pre: MESSAGE_MD_COMPONENTS.pre, img: () => null };
const MD_COMPONENTS_NO_PRE = { ...MD_COMPONENTS_CODE_LINK, img: MESSAGE_MD_COMPONENTS.img };


// Cross-mount markdown render cache. React.memo only helps while a component
// stays MOUNTED — but the message virtualizer constantly unmounts and remounts
// rows (conversation switch, bottom-anchor correction walk, scroll-back), and
// each remount re-ran the full remark/rehype parse: 70-300ms per block for
// table/code-dense messages, ~350 block mounts in one switch = multi-second
// main-thread freeze (ct-36614). react-markdown's default export is a plain
// hook-free function (parse → hast → toJsxRuntime), so its element output is
// pure data keyed entirely by content — cache it module-wide and a remount
// costs only element instantiation. Map insertion order doubles as LRU.
const MD_RENDER_CACHE = new Map<string, ReactElement>();
const MD_RENDER_CACHE_MAX = 500;

// Above this size an assistant body is parsed per block (split at blank lines
// outside code fences) with each block cached separately. A streaming message
// grows at its END, so every prefix block hits the cache and only the last
// block reparses per push — without this, each streaming push reparsed the
// whole growing body (70-300ms for giant code/table bodies). Only giant
// bodies take this path: splitting can change loose-list grouping
// cosmetically, so ordinary messages keep exact single-parse semantics.
const MD_BLOCK_SPLIT_THRESHOLD = 8000;

function mdCachePut(key: string, el: ReactElement): ReactElement {
  MD_RENDER_CACHE.set(key, el);
  if (MD_RENDER_CACHE.size > MD_RENDER_CACHE_MAX) {
    MD_RENDER_CACHE.delete(MD_RENDER_CACHE.keys().next().value!);
  }
  return el;
}

function renderMessageMarkdownCached(content: string, userText?: boolean): ReactElement {
  const key = userText ? "\u0000u" + content : content;
  const hit = MD_RENDER_CACHE.get(key);
  if (hit) {
    MD_RENDER_CACHE.delete(key);
    MD_RENDER_CACHE.set(key, hit);
    return hit;
  }
  if (!userText && content.length > MD_BLOCK_SPLIT_THRESHOLD) {
    const blocks = splitMarkdownBlocks(content);
    // Recurse only when the split made progress: a body with no blank lines
    // outside fences returns itself as one block, and recursing on the
    // identical string overflows the stack (the cache write happens after
    // the recursive calls, so it can't break the loop).
    if (blocks.length > 1) {
      const el = (
        <>
          {blocks.map((b, i) => (
            <Fragment key={i}>{renderMessageMarkdownCached(b)}</Fragment>
          ))}
        </>
      );
      return mdCachePut(key, el);
    }
  }
  const el = ReactMarkdownBase({
    children: content,
    remarkPlugins: userText ? USER_MD_REMARK : entityRemarkPlugins,
    rehypePlugins: MESSAGE_MD_REHYPE,
    components: MESSAGE_MD_COMPONENTS,
  });
  return mdCachePut(key, el);
}

// Memoized message-body renderer. With no active search, render through the
// cross-mount cache above. An active search query changes the rendered output
// (rehypeSearchHighlight), so that rare path bypasses the cache and goes
// through the context-aware ReactMarkdown wrapper instead.
// Above this size a pasted user body renders as plain text: the remark parse
// costs 70-300ms on giant pastes (logs, stack traces) and markdown semantics
// add nothing to them — pre-wrap even keeps their line breaks exact where
// markdown would collapse them. Assistant bodies keep markdown at any size.
const USER_PLAIN_TEXT_THRESHOLD = 4000;

const MessageMarkdown = memo(function MessageMarkdown({ content, userText }: { content: string; userText?: boolean }) {
  const query = useContext(HighlightContext);
  // An all-HTML body renders as a sanitized canvas — the markdown pipeline
  // escapes raw tags into garbled source.
  const html = tryRenderHtmlMessage(content);
  if (html) return html;
  if (userText && !query && content.length > USER_PLAIN_TEXT_THRESHOLD) {
    return <div className="whitespace-pre-wrap break-words">{content}</div>;
  }
  if (query) {
    return (
      <ReactMarkdown remarkPlugins={userText ? USER_MD_REMARK : entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MESSAGE_MD_COMPONENTS}>
        {content}
      </ReactMarkdown>
    );
  }
  return renderMessageMarkdownCached(content, userText);
});

// Renders an assistant message body as a flat run of block elements: ★ Insight
// fences become InsightCards, everything else is markdown, emitted as a FRAGMENT
// (no wrapper) so each block stays a DIRECT child of MessageReview's .cc-content
// and remains independently hover-quotable — a wrapper div would collapse the
// whole message into one un-quotable block. Module-level const so MessageReview's
// memo holds (a fresh inline arrow at the call site would defeat it).
const renderAssistantBody = (content: string) => {
  const parts = parseInsightBlocks(content);
  if (!parts.some((p) => p.type === "insight")) return <MessageMarkdown content={content} />;
  return (
    <>
      {parts.map((part, i) =>
        part.type === "insight" ? (
          <InsightCard key={i} label={part.label} content={part.content} />
        ) : (
          <MessageMarkdown key={i} content={part.content} />
        ),
      )}
    </>
  );
};

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

// The in-app zoom (DashboardLayout's zoom.in/out shortcuts) sets CSS zoom on
// <html>. Under CSS zoom, getBoundingClientRect() returns screen px (layout px
// × zoom) while everything the virtualizer and scroll math work in — scrollTop,
// scrollHeight, offsetHeight, translateY row offsets — stays layout px. Any
// rect-derived length must be divided by this factor before mixing with layout
// px. Feeding raw rect heights into resizeItem at 50% zoom halved every
// believed row height, overlapping all rows into settled garble.
const cssZoomOf = (el: Element): number =>
  (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;
function virtHeightKey(itemKey: string | number, densityKey: string): string {
  return `${itemKey}|${densityKey}`;
}

// View density for the conversation. The first three render the message feed
// with progressively less chrome; "story" and "summary" replace the feed with
// LLM-condensed views backed by storyMode.ts.
export type ConversationDensity = "full" | "condensed" | "compact" | "story" | "summary";
type MessageFeedDensity = "full" | "condensed" | "compact";
const FEED_DENSITY_CYCLE: MessageFeedDensity[] = ["full", "condensed", "compact"];
// Last-chosen density per conversation, app-session scoped.
const DENSITY_BY_CONVERSATION = new Map<string, ConversationDensity>();
// Simple view reads calmer by default: tool activity as one-line receipts.
// An explicit per-conversation choice (the map above) still wins.
function defaultDensity(): ConversationDensity {
  return useInboxStore.getState().clientState.ui?.simple_view ? "condensed" : "full";
}
const DENSITY_OPTIONS: Array<{ value: ConversationDensity; label: string; description: string; icon: React.ComponentType<{ className?: string }>; ai?: boolean }> = [
  { value: "full", label: "Full", description: "Everything as it happened", icon: AlignJustify },
  { value: "condensed", label: "Condensed", description: "Tool activity as one-line receipts", icon: ListCollapse },
  { value: "compact", label: "Compact", description: "Condensed, plus long replies clipped to their ending", icon: GalleryVerticalEnd },
  { value: "story", label: "Story", description: "A timeline retelling, each reply condensed in its own voice", icon: GitCommitVertical, ai: true },
  { value: "summary", label: "Summary", description: "One short narrative of the whole session", icon: BookOpenText, ai: true },
];

// The density dropdown's option list. Guests (unauthenticated share-link
// viewers) get the local render densities only — the AI retellings need an
// account to read or generate (storyMode auth-gates both).
function DensityMenuOptions({ density, setDensity, guest }: { density: ConversationDensity; setDensity: (d: ConversationDensity) => void; guest: boolean }) {
  const options = guest ? DENSITY_OPTIONS.filter((o) => !o.ai) : DENSITY_OPTIONS;
  return (
    <>
      {options.map((opt, i) => (
        <Fragment key={opt.value}>
          {opt.ai && !options[i - 1]?.ai && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => setDensity(opt.value)} className="items-start gap-2.5 py-2">
            <opt.icon className={`w-4 h-4 mt-0.5 shrink-0 ${density === opt.value ? "text-sol-cyan" : "text-sol-text-dim"}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px]">
                <span className={density === opt.value ? "text-sol-cyan font-medium" : ""}>{opt.label}</span>
                {opt.ai && <span className="text-[9px] uppercase tracking-wider px-1 py-px rounded bg-sol-violet/15 text-sol-violet">AI</span>}
              </div>
              <div className="text-[11px] text-sol-text-dim leading-snug">{opt.description}</div>
            </div>
            {density === opt.value && <Check className="w-3.5 h-3.5 shrink-0 mt-0.5 text-sol-cyan" />}
          </DropdownMenuItem>
        </Fragment>
      ))}
    </>
  );
}
function recordVirtHeight(key: string, size: number) {
  if (size <= 0) return; // 0-height rows are already exact via the heuristic; don't cache
  if (VIRT_HEIGHT_CACHE.size >= VIRT_HEIGHT_CACHE_MAX && !VIRT_HEIGHT_CACHE.has(key)) {
    const oldest = VIRT_HEIGHT_CACHE.keys().next().value;
    if (oldest !== undefined) VIRT_HEIGHT_CACHE.delete(oldest);
  }
  VIRT_HEIGHT_CACHE.set(key, size);
}

type ToolCall = {
  id: string;
  name: string;
  input: string;
};

type ToolResult = {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

type ImageData = {
  media_type: string;
  data?: string;
  storage_id?: string;
  tool_use_id?: string;
  // Set on an optimistic message whose image is still uploading: a local blob:
  // URL for the thumbnail, plus a flag to overlay an upload spinner. Cleared
  // (swapped for storage_id) once the background upload completes.
  preview_url?: string;
  uploading?: boolean;
};

// Header entry to the session gallery: every image in the transcript, opened
// over the lightbox's explicit-list channel (openList) — the register() channel
// only knows images the virtualized feed has actually mounted. Rendered inside
// ImageGalleryProvider (a child, not the ConversationView body, which sits
// outside the provider).
function SessionGalleryButton({ srcs }: { srcs: string[] }) {
  const gallery = useImageGallery();
  if (srcs.length === 0) return null;
  return (
    <ShortcutTooltip label={`View ${srcs.length === 1 ? "image" : `${srcs.length} images`}`} side="bottom">
      <button
        onClick={() => gallery?.openList(srcs, srcs.length - 1)}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 bg-sol-magenta/10 text-sol-magenta border border-sol-magenta/30 hover:bg-sol-magenta/20 transition-colors"
      >
        <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
        <span className="tabular-nums">{srcs.length}</span>
      </button>
    </ShortcutTooltip>
  );
}

function formatMessagePartsForCopy(
  content: string | undefined,
  toolCalls: ToolCall[] | undefined,
  toolResults: ToolResult[] | undefined,
): string {
  const parts: string[] = [];
  if (content?.trim()) {
    parts.push(content);
  }
  if (toolCalls?.length) {
    for (const tc of toolCalls) {
      let input = tc.input;
      try { input = JSON.stringify(JSON.parse(tc.input), null, 2); } catch {}
      parts.push(`[Tool: ${tc.name}]\n${input}`);
    }
  }
  if (toolResults?.length) {
    for (const tr of toolResults) {
      const errPrefix = tr.is_error ? " (error)" : "";
      parts.push(`[Result${errPrefix}]\n${tr.content}`);
    }
  }
  return parts.join("\n\n");
}

type Message = {
  _id: string;
  message_uuid?: string;
  // Sender of a user message when it differs from the conversation owner
  // (team sends, cast send, fork replies). Absent = the owner typed it.
  from_user_id?: string;
  role: string;
  content?: string;
  timestamp: number;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_results?: ToolResult[];
  images?: ImageData[];
  subtype?: string;
  model?: string;
  _isOptimistic?: true;
  _isQueued?: true;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export type ConversationData = {
  _id: Id<"conversations">;
  user_id?: string;
  is_own?: boolean;
  title?: string;
  session_id?: string;
  agent_type?: string;
  model?: string;
  started_at?: number;
  updated_at?: number;
  share_token?: string;
  message_count?: number;
  messages: Message[];
  user?: { name?: string; email?: string; avatar_url?: string | null } | null;
  parent_conversation_id?: string | null;
  child_conversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>;
  child_conversation_map?: Record<string, string>;
  git_branch?: string | null;
  git_status?: string | null;
  git_remote_url?: string | null;
  project_path?: string | null;
  git_root?: string | null;
  short_id?: string;
  status?: "active" | "completed";
  fork_count?: number;
  forked_from?: string;
  fork_status?: "copying" | "complete" | "failed";
  fork_copied?: number;
  fork_copy_total?: number;
  forked_from_details?: {
    conversation_id: string;
    title?: string;
    share_token?: string;
    username: string;
    // Triage stamps for the parent-preload seed (see inboxVisibilityFields).
    inbox_dismissed_at?: number | null;
    inbox_stashed_at?: number | null;
    inbox_killed_at?: number | null;
    inbox_pinned_at?: number | null;
  } | null;
  is_favorite?: boolean;
  profile_pinned_at?: number;
  workflow_run_id?: string | null;
  is_workflow_primary?: boolean;
  draft_message?: string;
  subtitle?: string | null;
  stable_context?: string | null;
  compaction_count?: number;
  loaded_start_index?: number;
  agent_name_map?: Record<string, string>;
  agent_name_entries?: Array<[string, string]>;
  fork_children?: Array<{
    _id: string;
    title: string;
    short_id?: string;
    started_at: number;
    username: string;
    parent_message_uuid?: string;
    message_count?: number;
    agent_type?: string;
    first_divergent_preview?: string;
  }>;
  fork_siblings?: Array<{
    _id: string;
    title: string;
    short_id?: string;
    started_at: number;
    username: string;
    parent_message_uuid?: string;
    message_count?: number;
    agent_type?: string;
    first_divergent_preview?: string;
  }>;
  main_message_counts_by_fork?: Record<string, number>;
  main_divergent_previews_by_fork?: Record<string, string>;
  // Pinned thread state (`cast state`) — the four fields the ThreadStatePanel
  // reads. Typed via the shared contract so this can never drift from the
  // reader in lib/threadState.ts.
} & ThreadStateFields;

type CommitFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

type Commit = {
  _id: string;
  sha: string;
  message: string;
  timestamp: number;
  files_changed: number;
  insertions: number;
  deletions: number;
  author_name: string;
  author_email: string;
  repository?: string;
  files?: CommitFile[];
};

type PRFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};

type PullRequest = {
  _id: Id<"pull_requests">;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  repository: string;
  author_github_username: string;
  head_ref?: string;
  base_ref?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits_count?: number;
  files?: PRFile[];
  created_at: number;
  updated_at: number;
  merged_at?: number;
};

type ConversationViewProps = {
  conversation: ConversationData | null | undefined;
  commits?: Commit[];
  pullRequests?: PullRequest[];
  backHref: string;
  backLabel?: string;
  headerExtra?: React.ReactNode;
  hasMoreAbove?: boolean;
  hasMoreBelow?: boolean;
  isLoadingOlder?: boolean;
  isLoadingNewer?: boolean;
  onLoadOlder?: () => void;
  onLoadNewer?: () => void;
  onJumpToStart?: () => void;
  onJumpToEnd?: () => void;
  onJumpToTimestamp?: (ts: number) => void;
  highlightQuery?: string;
  onClearHighlight?: () => void;
  embedded?: boolean;
  showMessageInput?: boolean;
  targetMessageId?: string;
  /** Distinguishes a NEW jump request to the same message: the reset below
   *  compares ids, so without this a second "jump to the ask" click on the
   *  same decision would be a silent no-op. */
  targetNonce?: number;
  /** True while a targetMessageId jump is still fetching its message window
   * (from useConversationMessages.isJumpingToTarget). Drives the
   * "Jumping to message..." indicator so mid-conversation jumps aren't silent. */
  isJumpingToTarget?: boolean;
  isOwner?: boolean;
  // Anonymous share-link viewer: simplified defaults (condensed density, no AI
  // density modes). Distinct from !isOwner, which also covers signed-in teammates.
  guest?: boolean;
  onSendAndAdvance?: () => void;
  onSendAndDismiss?: () => void;
  autoFocusInput?: boolean;
  // Raw last user message of the session (server preview slice). The view
  // decides whether it may serve as the sticky fallback via stickyPromptContent.
  fallbackStickyContent?: string | null;
  onBack?: () => void;
  subHeaderContent?: React.ReactNode;
  headerLeft?: React.ReactNode;
  headerEnd?: React.ReactNode;
  hideHeader?: boolean;
  /**
   * Compose-popup hook. When set, the message input sends on Enter / Cmd+Enter
   * and then calls this with `navigate` = whether the user held Cmd/Ctrl
   * (Enter → fire-and-forget, Cmd+Enter → send & open). Used by ComposeView in
   * the floating new-session window; undefined everywhere else.
   */
  onSubmitWithIntent?: (navigate: boolean) => void;
};

export interface ConversationViewHandle {
  scrollToMessage: (messageId: string) => void;
}

function ForkCopyingState({ copied, total }: { copied: number; total?: number }) {
  const pct = total && total > 0 ? Math.min(100, Math.round((copied / total) * 100)) : null;
  return (
    <div className="flex flex-col items-center gap-3 max-w-md text-center px-6">
      <div className="flex items-center gap-2 text-sm font-medium text-sol-text">
        <svg className="w-4 h-4 animate-spin text-sol-cyan" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        Copying messages from parent…
      </div>
      <div className="text-xs text-sol-text-dim tabular-nums">
        {total
          ? `${copied.toLocaleString()} / ${total.toLocaleString()} messages${pct !== null ? ` · ${pct}%` : ""}`
          : `${copied.toLocaleString()} messages copied so far`}
      </div>
      {total && total > 0 && (
        <div className="w-full max-w-xs h-1.5 rounded-full bg-sol-bg-alt overflow-hidden">
          <div
            className="h-full bg-sol-cyan transition-all duration-500"
            style={{ width: `${pct ?? 0}%` }}
          />
        </div>
      )}
      <div className="text-[11px] text-sol-text-dim/60">
        Large forks copy in batches. Messages will appear automatically as they arrive.
      </div>
    </div>
  );
}

// A captioned rule across the timeline: two gradient lines meeting the caption
// in the middle. One shape for every anchor the feed draws — the "New" unread
// line, the "assigned to you" handoff line, the idle-gap stamp at the tail.
function TimelineRule({
  color,
  className = "mt-1 mb-3",
  faint,
  label,
  children,
}: {
  color: string;
  className?: string;
  faint?: boolean;
  label?: string;
  children: ReactNode;
}) {
  const line = `flex-1 h-px${faint ? " opacity-40" : ""}`;
  return (
    <div className={`flex items-center gap-3 select-none ${className}`} aria-label={label}>
      <div className={line} style={{ background: `linear-gradient(to right, transparent, ${color})` }} />
      {children}
      <div className={line} style={{ background: `linear-gradient(to left, transparent, ${color})` }} />
    </div>
  );
}

// Single sticky pill at the top/bottom edge of the message list. The leading
// icon is a directional chevron when idle and a spinner while a page is
// loading — same pill, glyph swaps in place (no second stacked pill).
function EdgeMessagesIndicator({
  dir,
  loading,
  children,
}: {
  dir: "up" | "down";
  loading: boolean;
  children: React.ReactNode;
}) {
  const isUp = dir === "up";
  return (
    <div className={`sticky ${isUp ? "top-0" : "bottom-0"} z-10 flex justify-center py-1 sm:py-2 pointer-events-none`}>
      <div className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-0.5 sm:py-1 rounded-full bg-sol-bg border border-sol-border text-sol-text-muted0 text-[10px] sm:text-xs shadow-sm pointer-events-auto">
        {loading ? (
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        ) : (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isUp ? "M5 15l7-7 7 7" : "M19 9l-7 7-7-7"} />
          </svg>
        )}
        {children}
      </div>
    </div>
  );
}

function MessagesUnavailableState({
  forkStatus,
  forkCopied,
  forkTotal,
}: {
  messageCount: number;
  forkStatus?: "copying" | "complete" | "failed";
  forkCopied?: number;
  forkTotal?: number;
}) {
  if (forkStatus === "copying") {
    return <ForkCopyingState copied={forkCopied ?? 0} total={forkTotal} />;
  }

  // No "couldn't be loaded" panic — the recovery loop in useConversationMessages
  // keeps trying every second. Just show the loader; if it never lands the user
  // will see this indicator rather than a misleading error.
  return <AppLoader className="min-h-0 bg-transparent py-10" size={32} />;
}

// The folder glyph is shown on the picker header and on every project chip.
// Factored out so the path data lives once instead of being copy-pasted.
function FolderGlyph({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
    </svg>
  );
}

// "Open this exact folder" chip glyph — a folder with a plus, distinct from the
// plain FolderGlyph the recent-project chips use.
function FolderPlusGlyph({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v6m3-3H9m-6.75 2.25V6A2.25 2.25 0 014.5 3.75h4.629a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H19.5A2.25 2.25 0 0121.75 9v9.75A2.25 2.25 0 0119.5 21h-15a2.25 2.25 0 01-2.25-2.25z" />
    </svg>
  );
}

// Project-path helpers (inferHomeDir / resolveCustomPath / displayPath /
// inferProjectBase / buildProjectPathOptions) live in lib/utils so they're unit-tested.

// Picker hint rows render key names as <KeyCap> caps (the keyboard-shortcuts
// panel component) — never as plain text in the surrounding font.
function HintKeys({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex items-center gap-[2px]">
        {keys.map((k, i) => <KeyCap key={i} size="xs">{k}</KeyCap>)}
      </span>
      <span className="text-sol-text-dim/70">{label}</span>
    </span>
  );
}

const ALT_CAP = isMac ? "⌥" : "Alt";

// Imperative surface each null-state picker hands up to NewSessionView's
// ⌥-chord router (⌥↑ → project picker, ⌥↓ → agent row).
type PickerHandle = {
  focus: () => boolean;
  isOpen: () => boolean;
  move?: (delta: -1 | 1) => boolean;
  // Commit the highlighted item and close WITHOUT restoring focus — the router
  // is about to move focus to the next picker.
  commitAndClose?: () => void;
};

// "Back to the input" after a picker exits: whatever was focused when it
// opened, else the composer textarea (the only textarea on the null-state
// surface) — so Enter lands you typing even if the picker was opened while
// focus sat on body.
function restorePickerFocus(prev: HTMLElement | null) {
  if (prev && prev !== document.body && document.contains(prev)) {
    prev.focus();
    return;
  }
  document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
}

// A recent-project row. `suggested` marks a padding entry — a root the picked
// machine has but has no session history in, so it reads dimmer than a real recent.
type RecentProject = { path: string; count: number; lastActive: number; suggested?: boolean };

function ProjectSwitcher({ conversation, handleRef, machineSlot }: {
  conversation: ConversationData;
  handleRef?: React.MutableRefObject<PickerHandle | null>;
  // Where the machine picker renders. Omitted → inline above the folder chips
  // (the standalone non-owner surface). Provided → portaled into the host's
  // slot (NewSessionView puts it on the Context line); null while the slot
  // element hasn't mounted yet, during which nothing renders.
  machineSlot?: HTMLElement | null;
}) {
  const freshProjects = useQuery(api.users.getRecentProjectPaths, { limit: 50 });
  const cachedProjects = useInboxStore((s) => s.recentProjects);
  const setRecentProjects = useInboxStore((s) => s.setRecentProjects);
  const { user: currentUser } = useCurrentUser();
  // Select stable primitive keys—not session objects, which are replaced on
  // heartbeats. This avoids both the useSyncExternalStore allocation loop and
  // restoring the old ~1×/s ProjectSwitcher re-render regression.
  const loadedSessionProjectKeys = useInboxStore(useShallow((s) =>
    Object.values(s.sessions).map(recentProjectSessionKey),
  ));
  const ownSessionProjects = useMemo(
    () => recentProjectPathsFromSessionKeys(loadedSessionProjectKeys, currentUser?._id ? String(currentUser._id) : null),
    [loadedSessionProjectKeys, currentUser?._id],
  );
  // Narrowed: only _id/project_path/git_root/owner_device_id/target_device_id are
  // read here, none of which change on a heartbeat — so the always-rendered
  // ProjectSwitcher no longer re-renders ~1×/s. Anything the machine row needs
  // must be listed HERE: a field left out reads back undefined, and reading it
  // through an `as any` cast silently defeats that (which is how the empty-roster
  // fallback below shipped broken once already). Keep the reads typed.
  // resolveLiveSessionId follows the row across the compose popup's stub→real rekey
  // (which deletes sessions[stub]); without it a folder click after the create lands
  // updates the backend but never moves the highlight, since storeSession goes stale.
  const storeSession = useInboxStore(useShallow((s) => {
    const sess = s.sessions[s.resolveLiveSessionId(conversation._id)];
    if (!sess) return undefined;
    return { _id: sess._id, project_path: sess.project_path, git_root: sess.git_root, owner_device_id: sess.owner_device_id, target_device_id: sess.target_device_id };
  }));
  const isolated = useInboxStore((s) => s.isolatedWorktreeMode);
  const convCommand = useInboxStore((s) => s.convCommand);

  // --- machine row --------------------------------------------------------
  // Devices heartbeat every ~30s, so this subscription re-renders the switcher a
  // couple of times a minute — cheap next to the per-second churn the narrowed
  // store selector above avoids, and the row can't be drawn without it.
  const { devices } = useDevices();
  // listDevices comes back sorted by last_seen, so the row would reshuffle every
  // time a machine heartbeats. Chips hold still instead: locals first, then name.
  const machineChips = useMemo(
    () => [...devices].sort((a, b) =>
      Number(a.is_remote) - Number(b.is_remote) || deviceDisplayName(a).localeCompare(deviceDisplayName(b))),
    [devices],
  );
  const [pickedDeviceId, setPickedDeviceId] = useState<string | null>(null);
  // Machine picker rests as a single pill showing where the session will run;
  // clicking it unfolds the full chip row for an explicit pick.
  const [machinesOpen, setMachinesOpen] = useState(false);
  const currentConvContext = useInboxStore((s) => s.currentConversation);
  // The context fallback can point at a TEAMMATE's session (team inbox) whose
  // checkout no machine of ours has — never present that as the current project.
  // Gate on the LIVE roster only: a persisted roster draws the chips at boot,
  // but a stale copy must not veto a freshly cloned checkout.
  const rosterLive = useInboxStore((s) => s.machineRosterLive);
  const ctxPath = [currentConvContext?.projectPath, currentConvContext?.gitRoot].find((p) => pathOnMyMachines(rosterLive ? devices : [], p));
  const currentPath = storeSession?.project_path || storeSession?.git_root || conversation.git_root || conversation.project_path || ctxPath;
  const currentName = currentPath?.split("/").filter(Boolean).pop() || "unknown";

  // Where the picker opens. Deterministic (owner → your standing pick → the
  // machine holding this checkout → stable tiebreak), so it can't change under
  // the user between the render that shows a chip and the send that acts on it.
  const lastPickedDeviceId = useInboxStore((s) => s.clientState.ui?.last_picked_device_id ?? null);
  const machineOpts = {
    ownerDeviceId: storeSession?.owner_device_id ?? (conversation as any).owner_device_id ?? null,
    projectPath: currentPath,
    lastPicked: lastPickedDeviceId,
  };
  // The machine this session WILL run on, plus the two things that must agree
  // with it: what gets stamped, and which machine's folders we offer. The stamp
  // already on the row is the last-resort rung — `devices` reads empty on mount
  // and on any Convex reconnect, and without it that gap would drop the folder
  // list back to the cross-machine union while the stamp survived.
  const existingStamp = storeSession?.target_device_id ?? null;
  const { selectedDeviceId, scopeProjectsToDeviceId } = resolveMachineSelection(devices, {
    ...machineOpts,
    picked: pickedDeviceId,
    existingStamp,
  });

  // The folder list is scoped to the machine we're about to stamp, ALWAYS. The
  // unscoped query is `getOnlineLocalRoots` — a union across every online local —
  // so leaving it unscoped while the selection is forced would offer folders the
  // target machine doesn't have, and the stamp wins rung 1 outright: the session
  // would land on a machine that can't cd into its own project path. (Previously
  // the same list was safe because an unstamped session could be re-routed to
  // whichever machine actually held the checkout.)
  const scopedDeviceId = scopeProjectsToDeviceId;
  // The unscoped query stays mounted regardless — it's the shared subscription
  // that keeps the store's recentProjects cache (which the other pickers read)
  // warm. The scoped one deliberately never feeds that cache.
  const scopedProjects = useQuery(
    api.users.getRecentProjectPaths,
    scopedDeviceId ? { limit: 50, device_id: scopedDeviceId } : "skip",
  );
  // Per-device cache so the picker paints instantly on every open instead of
  // waiting out the scoped round-trip. The cached list is that same machine's
  // prior answer, so — unlike the union — it can never offer a path the target
  // machine lacks; only cache-vs-cache staleness, which the live echo corrects.
  const cachedScopedProjects = useInboxStore((s) => s.recentProjectsByDevice);
  const setRecentProjectsForDevice = useInboxStore((s) => s.setRecentProjectsForDevice);
  const syncScopedProjects = useCallback(
    (projects: RecentProject[]) => {
      if (scopedDeviceId) setRecentProjectsForDevice(scopedDeviceId, projects);
    },
    [scopedDeviceId, setRecentProjectsForDevice],
  );
  useConvexSync(scopedProjects, syncScopedProjects);

  // One chip per repo name: the same project checked out on several machines
  // collapses to the routed machine's variant, and "other" means a different
  // PROJECT — the current one's foreign checkout is the machine row's job.
  const routedDevice = useMemo(
    () => devices.find((d) => d.device_id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );

  // Memoized because five downstream useMemos take it as a dep — an identity
  // that churned every render would defeat all of them.
  //
  // While the scoped query is in flight we must NOT fall back to the raw union
  // (it offers folders the target machine lacks), but we must also not paint an
  // empty row: the chips popped in a beat late on every open — a visible
  // flicker. The union filtered by the routed machine's OWN local_project_roots
  // is the same predicate the server applies (deviceSeesPath mirrors
  // pathUnderRoot), computed from the device roster already in memory. So the
  // ladder is: live scoped answer → that machine's cached answer → the union
  // narrowed to that machine → nothing (roster not loaded yet).
  const unionProjects = useMemo<RecentProject[]>(
    () => mergeRecentProjectPaths(freshProjects ?? cachedProjects, ownSessionProjects),
    [freshProjects, cachedProjects, ownSessionProjects],
  );
  const recentProjects = useMemo<RecentProject[]>(
    () => resolveScopedProjects({
      scopedDeviceId,
      scoped: scopedProjects,
      cached: scopedDeviceId ? cachedScopedProjects[scopedDeviceId] : undefined,
      union: unionProjects,
      routedDevice,
    }),
    [scopedDeviceId, scopedProjects, cachedScopedProjects, unionProjects, routedDevice],
  );
  const suggestedPaths = useMemo(
    () => new Set(recentProjects.filter((p) => p.suggested).map((p) => p.path)),
    [recentProjects],
  );

  useConvexSync(freshProjects, setRecentProjects);

  const dedupedRecents = useMemo(
    () => dedupeProjectsByRepoName(recentProjects, routedDevice, currentPath),
    [recentProjects, routedDevice, currentPath],
  );
  const otherProjects = useMemo(() => {
    const currentName = currentPath ? repoName(currentPath) : null;
    return dedupedRecents.filter((p) => p.path !== currentPath && (!currentName || repoName(p.path) !== currentName));
  }, [dedupedRecents, currentPath]);

  // Resting row: the current project plus at most 4 you actually use most.
  // Machine-root suggestions (never-used folders, shown grayed) stay out of
  // this row entirely — they're reachable through "other".
  const visibleProjects = useMemo(() => frequentProjectChips(otherProjects), [otherProjects]);

  // --- keyboard picker ---------------------------------------------------
  // The chip row doubles as a keyboard listbox. It is dormant for mouse users
  // (renders exactly as before); ⌥↑ anywhere in the new-session view
  // activates it (NewSessionView's chord router).
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");
  const [hi, setHi] = useState(0);
  // Machine-root suggestions start collapsed on every picker open; one click
  // on the "N more folders" row reveals them for that open only.
  const [showSuggested, setShowSuggested] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // Home dir inferred from real local roots, so "~/…" resolves to the same place
  // the daemon would cd to.
  const homeDir = useMemo(
    () => inferHomeDir([currentPath, ...recentProjects.map((p: { path: string }) => p.path)]),
    [currentPath, recentProjects],
  );

  // The base a bare folder name resolves under — a sibling of the current
  // project (its parent dir), so typing "weekend-hack" means the folder next to
  // the one you're in, not a dead end.
  const projectBase = useMemo(
    () => inferProjectBase(currentPath, recentProjects.map((p: { path: string }) => p.path), homeDir),
    [currentPath, recentProjects, homeDir],
  );

  // While navigating with the keyboard: ALL recent projects (current first —
  // the full fetched list, not just the 6 default chips), or — once the user
  // types — a live filter across them. Reuses the modal's match rule. When
  // the text instead NAMES a directory, a synthetic "open this folder" entry
  // rides at the end so ANY folder is reachable, not just previously-used ones:
  // an explicit path (absolute or ~/…) always offers it; a bare name resolves
  // against the project base and offers it only when nothing in recents matches
  // (so plain filtering — "co" → codecast — stays clean). The daemon's
  // start_session takes the cwd verbatim, so the fully-resolved path is all it
  // needs, and the chip shows that path so a wrong base guess is visible first.
  const pickList = useMemo<{ path: string; custom?: boolean; extra?: boolean }[]>(() => {
    if (filter.trim()) {
      return buildProjectPathOptions({
        query: filter,
        recentPaths: dedupedRecents.map((p: { path: string }) => p.path),
        home: homeDir,
        base: projectBase,
        currentPath,
      });
    }
    // Unfiltered browse opens on EXACTLY the resting row — same chips, same
    // order (visibleProjects). Opening the picker must not silently grow the
    // list; everything else (rarely-used folders and the machine's never-used
    // roots) sits behind the one "N more folders" row until expanded. Typing
    // still searches all of them regardless.
    const base: { path: string; extra?: boolean }[] = currentPath ? [{ path: currentPath }] : [];
    const head = visibleProjects.map((p) => ({ path: p.path }));
    if (!showSuggested) return base.concat(head);
    const shown = new Set(head.map((p) => p.path));
    const rest = browseProjectOrder(otherProjects)
      .filter((p) => !shown.has(p.path))
      .map((p) => ({ path: p.path, extra: true }));
    return base.concat(head, rest);
  }, [filter, dedupedRecents, currentPath, otherProjects, visibleProjects, homeDir, projectBase, showSuggested]);

  // How many folders the collapsed picker is holding back (rarely-used ones
  // plus the machine's never-used roots) — the expander's count.
  const hiddenCount = Math.max(0, otherProjects.length - visibleProjects.length);

  // Where the "more folders on this machine" divider renders once expanded
  // (-1 → no divider).
  const firstExtraIdx = useMemo(() => pickList.findIndex((p) => (p as { extra?: boolean }).extra), [pickList]);

  // Distinguish "you typed the folder you're already in" from a real miss.
  const filterIsCurrent = !!currentPath && resolveCustomPath(filter, homeDir, projectBase) === currentPath;

  const clampedHi = Math.min(hi, Math.max(0, pickList.length - 1));

  const exitPicker = useCallback((restoreFocus = true) => {
    setPicking(false);
    setFilter("");
    if (restoreFocus) restorePickerFocus(prevFocusRef.current);
  }, []);

  const focusPicker = useCallback(() => {
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    setFilter("");
    setHi(0);
    setShowSuggested(false);
    setPicking(true);
    return true;
  }, []);

  // Focus the filter input AFTER the commit that mounts it. focusPicker is
  // called from a native window listener (the ⌥-chord router), where React 18
  // batches the state update past any rAF — an immediate/rAF focus() races the
  // mount and silently leaves focus where it was.
  useEffect(() => {
    if (picking) pickerRef.current?.focus();
  }, [picking]);

  // `forceDeviceId` is how a machine chip re-routes a session whose folder isn't
  // changing (undefined = "whatever the machine row has selected"; null = clear
  // back to auto-routing), so passing it also defeats the same-path no-op guard.
  const handleSwitch = useCallback(async (projectPath: string, forceIsolated?: boolean, forceDeviceId?: string | null) => {
    const trimmed = projectPath.trim();
    if (!trimmed) return;
    const targetDeviceId = forceDeviceId !== undefined ? forceDeviceId : scopedDeviceId;
    if (trimmed === currentPath && !forceIsolated && forceDeviceId === undefined) return;
    const store = useInboxStore.getState();
    const id = storeSession?._id || conversation._id;
    const prevPath = currentPath;
    store.updateSessionProject(id, trimmed);
    // Always push the switch to the daemon so it kills + recreates the tmux at
    // the new cwd. A freshly-created stub has no Convex id yet — its id arrives
    // via the in-flight create promise, so wait for that rather than dropping
    // the switch on the floor (which left the label and the tmux diverged).
    let convexId = isConvexId(id) ? id : store.getConvexId(id);
    if (!convexId) {
      const pending = store.awaitSessionCreate(id);
      if (pending) convexId = await pending.catch(() => undefined);
    }
    if (!convexId) return;
    convCommand(convexId, "reconfigureSession", {
      project_path: trimmed,
      git_root: trimmed,
      isolated: (forceIsolated ?? isolated) || undefined,
      ...(targetDeviceId ? { target_device_id: targetDeviceId } : {}),
    }).catch((err) => {
      if (isParkedDispatchError(err)) return;
      if (prevPath) useInboxStore.getState().updateSessionProject(convexId!, prevPath);
      toast.error(err instanceof Error ? err.message : "Failed to switch project");
    });
  }, [storeSession, conversation._id, convCommand, currentPath, isolated, scopedDeviceId]);

  // Picking a machine moves the (still blank) session there right away rather
  // than waiting on a folder pick the user may never make. That reconfigure only
  // bites when the conversation already exists server-side; every new-session
  // surface defers its create, so the stamp below is what usually carries the
  // choice — see createSessionFromStub.
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  const handleMachinePick = useCallback((d: Device) => {
    setPickedDeviceId(d.device_id);
    // Remember the choice: it becomes the picker's default for subsequent NEW
    // sessions, which is what makes "explicit every time" cost one click total
    // rather than one click per session.
    updateClientUI({ last_picked_device_id: d.device_id });
    if (!currentPath) return;
    // Same project, THAT machine's checkout: keep the stored path truthful for
    // where the session now routes (the daemon would remap by repo name anyway,
    // but the label/tooltip shouldn't show a path the machine doesn't have).
    const remapped = d.local_project_roots?.find((r) => repoName(r) === repoName(currentPath)) ?? currentPath;
    handleSwitch(remapped, undefined, d.device_id);
  }, [currentPath, handleSwitch, updateClientUI]);

  // Stamp the selection on the stub row so it rides the deferred create — the
  // machine shown in the row is the machine it runs on, whether or not the user
  // touched the picker. Previously only a move OFF the default was stamped, and
  // an unstamped session was re-decided server-side at send time by a
  // `last_seen` tiebreak that flips between idle machines on its own.
  const setSessionTargetDevice = useInboxStore((s) => s.setSessionTargetDevice);
  useWatchEffect(() => {
    // Never clear on a null. Null now means only "the device roster hasn't
    // loaded yet" — `useDevices()` starts empty, so defaultMachineId returns null
    // on the first render(s). Writing that through would wipe a stamp an earlier
    // mount already made, silently returning the session to server-side routing.
    // There is no longer any path that intentionally clears the selection: every
    // chip click names a machine.
    if (!selectedDeviceId) return;
    setSessionTargetDevice(storeSession?._id || conversation._id, selectedDeviceId);
  }, [storeSession?._id, conversation._id, selectedDeviceId, setSessionTargetDevice]);

  // Hand the imperative surface up to NewSessionView's ⌥-chord router.
  // Re-assigned every render so isOpen/commitAndClose read fresh state.
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      focus: focusPicker,
      isOpen: () => picking,
      move: (delta) => {
        setHi((i) => (pickList.length ? (i + delta + pickList.length) % pickList.length : 0));
        return pickList.length > 0;
      },
      commitAndClose: () => {
        const sel = pickList[clampedHi];
        if (sel) handleSwitch(sel.path);
        exitPicker(false);
      },
    };
  });
  useEffect(() => () => { if (handleRef) handleRef.current = null; }, [handleRef]);

  // Focus lives in a real <input> (below) so the global capture-phase shortcut
  // dispatcher treats us as "typing" and suppresses single-letter hotkeys
  // (f/t/d/…). Letters + Backspace are handled natively by the input (onChange);
  // we only intercept the keys that drive chip selection. Option+H/L mirror
  // Left/Right while the arrow-key path remains available.
  const handlePickerKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowRight" || (e.altKey && e.code === "KeyL")) {
      e.preventDefault();
      setHi((i) => (pickList.length ? (i + 1) % pickList.length : 0));
      return;
    }
    if (e.key === "ArrowLeft" || (e.altKey && e.code === "KeyH")) {
      e.preventDefault();
      setHi((i) => (pickList.length ? (i - 1 + pickList.length) % pickList.length : 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const sel = pickList[Math.min(hi, Math.max(0, pickList.length - 1))];
      if (sel) handleSwitch(sel.path);
      exitPicker();
      return;
    }
    // ↓/Esc/Tab drop back to the message box (⌥↓ — handled by the chord
    // router before we see it — commits and moves on to the agent row).
    if (e.key === "ArrowDown" || e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      exitPicker();
    }
  }, [pickList, hi, handleSwitch, exitPicker]);

  // Mouse-first, and hidden entirely for the single-machine case so that
  // experience is untouched. Offline machines stay pickable: routing falls
  // back server-side to an online machine that has the repo. Rests collapsed
  // as one pill (the machine the session will run on); a click unfolds the
  // full chip row.
  const routedMachine = machineChips.find((d) => d.device_id === selectedDeviceId) ?? machineChips[0];
  const machineUi = machineChips.length > 1 && routedMachine ? (
    machinesOpen ? (
      <div className="flex flex-wrap justify-end gap-1.5 max-w-[26rem]">
        {machineChips.map((d) => {
          const selected = d.device_id === selectedDeviceId;
          return (
            <button
              key={d.device_id}
              onClick={() => { handleMachinePick(d); setMachinesOpen(false); }}
              title={d.online
                ? `Run this session on ${deviceDisplayName(d)}`
                : `${deviceDisplayName(d)} is offline — will fall back to an online machine with this repo`}
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded-md border transition-all ${
                selected
                  ? `${deviceAccentClasses(d)} font-medium`
                  : "border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border/70"
              } ${d.online ? "" : "opacity-50"}`}
            >
              <DeviceIcon d={d} className="w-3 h-3 shrink-0" />
              <span className="truncate max-w-[10rem]">{deviceDisplayName(d)}</span>
              <DeviceDot online={d.online} />
            </button>
          );
        })}
      </div>
    ) : (
      <button
        onClick={() => setMachinesOpen(true)}
        title={`Runs on ${deviceDisplayName(routedMachine)} — click to choose a machine`}
        className="group/machine inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] rounded-md border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border/70 hover:bg-sol-bg-alt/50 transition-all"
      >
        <DeviceIcon d={routedMachine} className="w-3 h-3 shrink-0" />
        <span className="truncate max-w-[10rem]">{deviceDisplayName(routedMachine)}</span>
        <DeviceDot online={routedMachine.online} />
        <ChevronDown className="w-3 h-3 shrink-0 opacity-50 group-hover/machine:opacity-100 transition-opacity" />
      </button>
    )
  ) : null;

  return (
    <div className="flex flex-col items-center gap-3">
      {machineSlot === undefined
        ? machineUi
        : machineUi && machineSlot
          ? createPortal(machineUi, machineSlot)
          : null}

      {!currentPath && recentProjects.length > 0 && (
        <div className="text-sol-text-dim text-xs">select a project</div>
      )}

      <div
        className={`rounded-lg transition-all ${picking ? "w-full max-w-3xl ring-1 ring-sol-cyan/40 bg-sol-cyan/[0.03] p-2" : ""}`}
      >
        {picking && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pb-2 mb-2 border-b border-sol-cyan/20">
            <Search className="w-3.5 h-3.5 shrink-0 text-sol-cyan/70" />
            <input
              ref={pickerRef}
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setHi(0); }}
              onKeyDown={handlePickerKeyDown}
              onBlur={() => exitPicker(false)}
              placeholder="search or paste a path"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 min-w-[12rem] bg-transparent text-xs font-mono text-sol-cyan placeholder:text-sol-text-dim outline-none border-0 p-0"
            />
            <span className="inline-flex items-center gap-2 text-[11px] font-mono">
              <HintKeys keys={["←", "→"]} label="move" />
              <HintKeys keys={["↵"]} label={pickList[clampedHi]?.custom ? "open" : "select"} />
              <HintKeys keys={[ALT_CAP, "↓"]} label="agent" />
              <HintKeys keys={["Esc"]} label="back" />
            </span>
          </div>
        )}
        <div className="flex flex-wrap justify-center gap-1.5">
        {picking ? (
          <>
          {pickList.length === 0 ? (
            <span className="text-xs text-sol-text-dim px-2.5 py-1">
              {filterIsCurrent ? "already in this folder" : <>no match for &ldquo;{filter}&rdquo;</>}
            </span>
          ) : (
            pickList.map((p, i) => {
              const isHi = i === clampedHi;
              const isCurrent = p.path === currentPath;
              return (
                <Fragment key={p.path}>
                  {i === firstExtraIdx && (
                    <span className="w-full mt-1.5 mb-0.5 flex items-center gap-2 text-[10px] text-sol-text-dim/80">
                      <span className="flex-1 border-t border-sol-border/40" />
                      more folders on {routedDevice ? deviceDisplayName(routedDevice) : "this machine"}
                      <span className="flex-1 border-t border-sol-border/40" />
                    </span>
                  )}
                  <button
                    // onMouseDown (not onClick) + preventDefault keeps the filter
                    // input focused so the click isn't lost to an onBlur teardown.
                    onMouseDown={(e) => { e.preventDefault(); handleSwitch(p.path); exitPicker(); }}
                    onMouseEnter={() => setHi(i)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-all max-w-[min(100%,22rem)] ${
                      isHi
                        ? "border-sol-cyan/70 bg-sol-cyan/15 text-sol-cyan ring-1 ring-sol-cyan/50"
                        : p.custom
                          ? "border-dashed border-sol-cyan/40 text-sol-cyan/80"
                          : isCurrent
                            ? "border-sol-cyan/60 bg-sol-cyan/15 text-sol-cyan font-medium"
                            : "border-sol-border/40 text-sol-text-dim"
                    } ${!isHi && suggestedPaths.has(p.path) ? "opacity-60" : ""}`}
                    title={p.path}
                  >
                    {p.custom ? <FolderPlusGlyph className="w-3 h-3 shrink-0" /> : <FolderGlyph />}
                    {p.custom ? (
                      <span className="truncate">
                        <span className="opacity-60">open </span>
                        <span className="font-mono">{displayPath(p.path, homeDir)}</span>
                      </span>
                    ) : (
                      <span>{p.path.split("/").filter(Boolean).pop()}</span>
                    )}
                  </button>
                </Fragment>
              );
            })
          )}
          {!filter.trim() && !showSuggested && hiddenCount > 0 && (
            <button
              // onMouseDown + preventDefault, same as the chips: keep the
              // filter input focused so expanding doesn't blur-close the picker.
              onMouseDown={(e) => { e.preventDefault(); setShowSuggested(true); }}
              className="w-full mt-1.5 mb-0.5 flex items-center gap-2 text-[10px] text-sol-text-dim/70 hover:text-sol-text transition-colors"
            >
              <span className="flex-1 border-t border-sol-border/40" />
              <span className="inline-flex items-center gap-1">
                {hiddenCount} more folders on {routedDevice ? deviceDisplayName(routedDevice) : "this machine"}
                <ChevronDown className="w-3 h-3" />
              </span>
              <span className="flex-1 border-t border-sol-border/40" />
            </button>
          )}
          </>
        ) : (
          <>
            {currentPath && (
              <button
                onClick={() => handleSwitch(currentPath)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-sol-cyan/60 bg-sol-cyan/15 text-sol-cyan font-medium transition-all"
                title={currentPath}
              >
                <FolderGlyph />
                <span>{currentName}</span>
              </button>
            )}
            {visibleProjects.map((p: { path: string }) => {
              const name = p.path.split("/").filter(Boolean).pop();
              return (
                <button
                  key={p.path}
                  onClick={() => handleSwitch(p.path)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-cyan/40 hover:bg-sol-cyan/5 transition-all"
                  title={p.path}
                >
                  <FolderGlyph />
                  <span>{name}</span>
                </button>
              );
            })}
            <button
              onClick={focusPicker}
              title="Search projects or paste any folder path"
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-dashed border-sol-border/50 text-sol-text-dim hover:text-sol-cyan hover:border-sol-cyan/40 hover:bg-sol-cyan/5 transition-all"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM12.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM18.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
              </svg>
              <span>other</span>
            </button>
          </>
        )}
        </div>
      </div>

      {/* One quiet meta row instead of three stacked ones: label, worktree
          toggle, keyboard hints. While picking, the search input rides the top
          of the picker box and these hints hide. */}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
        <NewSessionBucketPill conversation={conversation} />

        <button
          onClick={() => {
            const turningOn = !isolated;
            useInboxStore.getState().setIsolatedWorktreeMode(turningOn);
            if (turningOn && currentPath) {
              handleSwitch(currentPath, true);
            }
          }}
          className="flex items-center gap-2 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors"
          title="Create session in an isolated git worktree"
        >
          <span className={`w-7 h-4 rounded-full transition-colors relative flex-shrink-0 ${isolated ? "bg-sol-cyan/30" : "bg-sol-bg-alt"}`}>
            <span className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${isolated ? "left-3.5 bg-sol-cyan" : "left-0.5 bg-sol-text-dim"}`} />
          </span>
          <span className={isolated ? "text-sol-cyan" : ""}>isolated worktree</span>
        </button>

        {!picking && recentProjects.length > 0 && (
          <button
            onClick={focusPicker}
            className="inline-flex items-center gap-2.5 text-[10px] opacity-40 hover:opacity-90 transition-opacity"
          >
            <HintKeys keys={[ALT_CAP, "K"]} label="pick folder" />
            <HintKeys keys={[ALT_CAP, "J"]} label="pick agent" />
          </button>
        )}
      </div>

    </div>
  );
}

// Registry-derived (shared with the mobile sheet): adding a client descriptor
// is all it takes to appear here. This surface keys by the convex spelling.
const AGENT_OPTIONS = AGENT_LAUNCH_OPTIONS.map((a) => ({ type: a.convexType, label: a.label }));

function AgentSwitcher({ conversation, showWorkflow, onToggleWorkflow, selectedWorkflowId, onSelectWorkflow, workflows, handleRef }: {
  conversation: ConversationData;
  showWorkflow: boolean;
  onToggleWorkflow: () => void;
  selectedWorkflowId: string;
  onSelectWorkflow: (id: string) => void;
  workflows: Array<{ _id: string; name: string }> | undefined;
  handleRef?: React.MutableRefObject<PickerHandle | null>;
}) {
  const convCommand = useInboxStore((s) => s.convCommand);
  // Narrowed: only _id/agent_type are read here — neither churns on a heartbeat.
  // resolveLiveSessionId follows the row across the compose popup's stub→real rekey
  // (see ProjectSwitcher) so an agent click after the create lands isn't lost.
  const storeSession = useInboxStore(useShallow((s) => {
    const sess = s.sessions[s.resolveLiveSessionId(conversation._id)];
    if (!sess) return undefined;
    return { _id: sess._id, agent_type: sess.agent_type };
  }));
  const currentAgent = storeSession?.agent_type || conversation.agent_type || "claude_code";

  const handleAgentSwitch = useCallback(async (agentType: ConvexAgentType) => {
    if (agentType === currentAgent) return;
    try {
      const id = storeSession?._id || conversation._id;
      useInboxStore.getState().setConversationAgent(id, agentType);

      if (isConvexId(id)) {
        convCommand(id, "reconfigureSession", {
          agent_type: agentType,
        }).catch((err) => {
          if (isParkedDispatchError(err)) return;
          toast.error(err instanceof Error ? err.message : "Failed to switch agent");
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to switch agent");
    }
  }, [storeSession, conversation._id, convCommand, currentAgent]);

  // --- keyboard mode (mirrors the project picker's) -----------------------
  // Entered via ⌥↓ from NewSessionView's chord router. Focus is held in a
  // real (1px, read-only) <input> so the capture-phase shortcut dispatcher
  // treats this as typing and single letters can't fire global hotkeys.
  const [picking, setPicking] = useState(false);
  const [hi, setHi] = useState(0);
  const holderRef = useRef<HTMLInputElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  const exitAgentPicker = useCallback((restoreFocus = true) => {
    setPicking(false);
    if (restoreFocus) restorePickerFocus(prevFocusRef.current);
  }, []);

  const focusAgentPicker = useCallback(() => {
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    setHi(Math.max(0, AGENT_OPTIONS.findIndex((a) => a.type === currentAgent)));
    setPicking(true);
    return true;
  }, [currentAgent]);

  const moveAgentPicker = useCallback((delta: -1 | 1) => {
    if (!picking) prevFocusRef.current = document.activeElement as HTMLElement | null;
    setHi((i) => {
      const currentIndex = Math.max(0, AGENT_OPTIONS.findIndex((a) => a.type === currentAgent));
      const base = picking ? i : currentIndex;
      return (base + delta + AGENT_OPTIONS.length) % AGENT_OPTIONS.length;
    });
    setPicking(true);
    return true;
  }, [currentAgent, picking]);

  // Post-commit focus — same race as the project picker's (see note there).
  useEffect(() => {
    if (picking) holderRef.current?.focus();
  }, [picking]);

  const handleAgentKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowRight" || (e.altKey && e.code === "KeyL")) {
      e.preventDefault();
      setHi((i) => (i + 1) % AGENT_OPTIONS.length);
      return;
    }
    if (e.key === "ArrowLeft" || (e.altKey && e.code === "KeyH")) {
      e.preventDefault();
      setHi((i) => (i - 1 + AGENT_OPTIONS.length) % AGENT_OPTIONS.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const sel = AGENT_OPTIONS[Math.min(hi, AGENT_OPTIONS.length - 1)];
      if (sel) {
        handleAgentSwitch(sel.type);
        if (showWorkflow) onToggleWorkflow();
      }
      exitAgentPicker();
      return;
    }
    // ↓/Esc/Tab drop back to the message box. ⌥↑ (chord router) climbs to
    // the project picker; our holder input exits via onBlur when focus moves.
    if (e.key === "ArrowDown" || e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      exitAgentPicker();
    }
  }, [hi, handleAgentSwitch, exitAgentPicker, showWorkflow, onToggleWorkflow]);

  // Hand the imperative surface up to NewSessionView's ⌥-chord router.
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      focus: focusAgentPicker,
      isOpen: () => picking,
      move: moveAgentPicker,
    };
  });
  useEffect(() => () => { if (handleRef) handleRef.current = null; }, [handleRef]);

  return (
    <div className="flex flex-col items-center gap-2 px-4 pb-7">
      <div className={`flex flex-wrap items-center justify-center gap-1.5 rounded-lg transition-all ${picking ? "ring-1 ring-sol-cyan/40 bg-sol-cyan/[0.03] p-1.5" : ""}`}>
        {AGENT_OPTIONS.map((a, i) => {
          const isActive = currentAgent === a.type && !showWorkflow;
          const isHi = picking && i === hi;
          return (
            <button
              key={a.type}
              onClick={() => { handleAgentSwitch(a.type); if (showWorkflow) onToggleWorkflow(); }}
              onMouseEnter={() => { if (picking) setHi(i); }}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border whitespace-nowrap transition-all ${
                isHi
                  ? "border-sol-cyan/70 bg-sol-cyan/15 text-sol-cyan ring-1 ring-sol-cyan/50"
                  : isActive
                    ? a.type === "claude_code"
                      ? "bg-sol-yellow/15 text-sol-yellow border-sol-yellow/40"
                      : a.type === "codex"
                        ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/40"
                        : a.type === "cursor"
                          ? "bg-purple-500/15 text-purple-400 border-purple-500/40"
                          : "bg-blue-500/15 text-blue-400 border-blue-500/40"
                    : "border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border/60"
              }`}
            >
              <AgentTypeIcon agentType={a.type} />
              {a.label}
            </button>
          );
        })}
        <span className="text-sol-border/50 text-xs">|</span>
        <LaunchModelPill conversationId={storeSession?._id || conversation._id} />
      </div>

      {picking && (
        <div className="flex items-center gap-2 text-[11px] font-mono">
          <input
            ref={holderRef}
            readOnly
            value=""
            onKeyDown={handleAgentKeyDown}
            onBlur={() => exitAgentPicker(false)}
            aria-label="choose agent"
            className="w-px bg-transparent outline-none border-0 p-0 caret-transparent"
          />
          <span className="inline-flex items-center gap-2">
            <HintKeys keys={["←", "→"]} label="move" />
            <HintKeys keys={["↵"]} label="select" />
            <HintKeys keys={[ALT_CAP, "↑"]} label="folder" />
            <HintKeys keys={["Esc"]} label="back" />
          </span>
        </div>
      )}

      {showWorkflow && (
        <select
          value={selectedWorkflowId}
          onChange={(e) => onSelectWorkflow(e.target.value)}
          className="w-full max-w-sm px-3 py-1.5 text-xs bg-sol-bg-alt border border-sol-violet/40 rounded-lg text-sol-text focus:outline-none focus:border-sol-violet/70"
        >
          <option value="">Select a workflow...</option>
          {(workflows || []).map((wf) => (
            <option key={wf._id} value={wf._id}>{wf.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}

export interface NewSessionAgentControls {
  showWorkflow: boolean;
  onToggleWorkflow: () => void;
  selectedWorkflowId: string;
  onSelectWorkflow: (id: string) => void;
  workflows: Array<{ _id: string; name: string }> | undefined;
}

/**
 * The new-session "null state" pickers — project picker (tabs + isolated-worktree
 * toggle) + agent picker — for a conversation with no messages yet. This is the
 * ONE definition used both by the in-app empty conversation (ConversationView's
 * empty state) and the floating compose popup (ComposeView). The message input
 * stays with each host (the in-app rich MessageInput pinned at the bottom; the
 * popup's lightweight one) since they need very different wiring. Pass
 * `agentControls` to drive workflow selection from the host; omitted, it manages
 * its own local state (the popup case).
 */
// Subtle bucket affordance on the new-session surface: invisible when the user
// has no buckets; otherwise a small pill showing where this session will be
// filed (defaults to the focused bucket chip). Click opens the same palette
// picker the Ctrl+Shift+M chord uses.
function NewSessionBucketPill({ conversation }: { conversation: ConversationData }) {
  const buckets = useInboxStore((st) => st.buckets);
  const bucketAssignments = useInboxStore((st) => st.bucketAssignments);
  // Auto-filing applies only to an INCLUDE label chip — an excluded label must
  // never claim new blanks.
  const activeBucketFilter = useInboxStore((st) => (st.chipFilterExclude ? null : st.activeBucketFilter));
  const convId = conversation._id;

  const visibleBuckets = useMemo(
    () => (Object.values(buckets) as BucketItem[]).filter((b) => !b.archived_at),
    [buckets],
  );
  const assigned = useMemo(() => {
    const bucketId = convBucketMap(bucketAssignments)[convId];
    return bucketId ? (buckets[bucketId] ?? null) : null;
  }, [bucketAssignments, buckets, convId]);

  // A pre-warmed blank opened while a bucket chip is focused files itself there
  // (the create-time stamp in beginOptimisticSession covers fresh creates; this
  // covers blanks that existed before the filter was set).
  useEffect(() => {
    if (!activeBucketFilter || assigned) return;
    const store = useInboxStore.getState();
    const real = store.getConvexId(convId) ?? convId;
    if (!isConvexId(real)) return;
    if (convBucketMap(store.bucketAssignments)[real]) return;
    store.assignSessionToBucket(real, activeBucketFilter);
  }, [convId, activeBucketFilter, assigned]);

  if (visibleBuckets.length === 0) return null;

  const openPicker = () => {
    const store = useInboxStore.getState();
    const session = store.sessions[convId];
    if (session) store.openPalette({ targets: [session], targetType: "session", mode: "bucket" });
  };
  const color = assigned ? getLabelColor(assigned.name) : null;
  return (
    <button
      onClick={openPicker}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] leading-4 transition-colors ${
        assigned && color
          ? "border-sol-border/40 bg-sol-bg-alt/40 hover:border-sol-border/70"
          : "border-dashed border-sol-border/50 text-sol-text-dim/60 hover:text-sol-cyan hover:border-sol-cyan/40 hover:bg-sol-cyan/5"
      }`}
      title="Choose a label for this session"
    >
      {assigned && color ? (
        <>
          <span className={`w-1.5 h-1.5 rounded-[2px] ${color.dot}`} />
          <span className={color.text}>{assigned.name}</span>
        </>
      ) : (
        <span>+ label</span>
      )}
    </button>
  );
}

export function NewSessionView({ conversation, agentControls }: { conversation: ConversationData; agentControls?: NewSessionAgentControls }) {
  const [localShowWorkflow, setLocalShowWorkflow] = useState(false);
  const [localWorkflowId, setLocalWorkflowId] = useState("");
  const ac: NewSessionAgentControls = agentControls ?? {
    showWorkflow: localShowWorkflow,
    onToggleWorkflow: () => setLocalShowWorkflow((v) => !v),
    selectedWorkflowId: localWorkflowId,
    onSelectWorkflow: setLocalWorkflowId,
    workflows: undefined,
  };
  // Spatial ⌥-chords for the whole new-session surface, capture-phase on
  // window so they work no matter what holds focus (textarea, toggle, body):
  // ⌥↑ climbs to the project picker; ⌥↓ drops to the agent row,
  // committing the picker's highlighted project on the way through. Enter
  // inside either picker returns focus to the input. Self-gating: the listener
  // exists only while this null-state surface is mounted. Chord resolution
  // (including releasing ⌥←/⌥→ word jump to a text caret) lives in
  // altChordDirection.
  const projectsRef = useRef<PickerHandle | null>(null);
  const agentsRef = useRef<PickerHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The machine picker's logic lives in ProjectSwitcher (a machine pick scopes
  // the folder list), but it renders down on the Context line — this slot is
  // the portal target StableContextPicker mounts at the end of that line.
  const [machineSlot, setMachineSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const onChord = (e: KeyboardEvent) => {
      // altChordDirection also releases ⌥←/⌥→ from a text caret (word jump).
      const dir = altChordDirection(e);
      if (!dir) return;
      // The compose dialog hosts this surface inside an aria-modal container —
      // a modal that CONTAINS us doesn't block the chords, only one stacked
      // above (draft confirm, settings) does.
      if (hasOpenModal(rootRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      if (dir === "left" || dir === "right") {
        const delta: -1 | 1 = dir === "left" ? -1 : 1;
        if (projectsRef.current?.isOpen()) projectsRef.current.move?.(delta);
        else agentsRef.current?.move?.(delta);
      } else if (dir === "up") {
        if (!projectsRef.current?.isOpen()) projectsRef.current?.focus();
      } else {
        if (projectsRef.current?.isOpen()) projectsRef.current.commitAndClose?.();
        if (!agentsRef.current?.isOpen()) agentsRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onChord, true);
    return () => window.removeEventListener("keydown", onChord, true);
  }, []);

  // Project picker sits up top; a flex spacer pushes the agent picker down so it
  // pins to the bottom, directly above the message input (the host renders the
  // input right after this view). Needs a full-height parent.
  return (
    <div ref={rootRef} className="flex flex-col items-center w-full flex-1 min-h-0">
      <ErrorBoundary name="ProjectSwitcher" level="inline">
        <ProjectSwitcher conversation={conversation} handleRef={projectsRef} machineSlot={machineSlot} />
      </ErrorBoundary>
      <div className="flex-1" />
      <ErrorBoundary name="StableContextPicker" level="inline">
        <div className="w-full px-4 mb-4">
          <StableContextPicker
            conversationId={conversation._id}
            trailing={<div ref={setMachineSlot} className="flex-shrink-0 min-w-0" />}
          />
        </div>
      </ErrorBoundary>
      <AgentSwitcher
        conversation={conversation}
        showWorkflow={ac.showWorkflow}
        onToggleWorkflow={ac.onToggleWorkflow}
        selectedWorkflowId={ac.selectedWorkflowId}
        onSelectWorkflow={ac.onSelectWorkflow}
        workflows={ac.workflows}
        handleRef={agentsRef}
      />
    </div>
  );
}

function ConversationSkeleton() {
  return (
    <div className="conv-col mx-auto px-4 py-4 space-y-6 animate-pulse motion-reduce:animate-none">
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
  );
}

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(startTs: number): string {
  const diff = Date.now() - startTs;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return remainMin ? `${hours}h ${remainMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function stripAnsiCodes(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const ANSI_COLORS: Record<number, string> = {
  30: '#073642', 31: '#dc322f', 32: '#859900', 33: '#b58900',
  34: '#268bd2', 35: '#d33682', 36: '#2aa198', 37: '#eee8d5',
  90: '#586e75', 91: '#cb4b16', 92: '#859900', 93: '#b58900',
  94: '#268bd2', 95: '#6c71c4', 96: '#2aa198', 97: '#fdf6e3',
};

function renderAnsi(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let currentColor: string | null = null;
  let bold = false;

  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const segment = text.slice(lastIndex, match.index);
      if (currentColor || bold) {
        parts.push(<span key={parts.length} style={{ color: currentColor || undefined, fontWeight: bold ? 700 : undefined }}>{segment}</span>);
      } else {
        parts.push(segment);
      }
    }
    lastIndex = regex.lastIndex;

    const codes = match[1].split(';').map(Number);
    for (const code of codes) {
      if (code === 0) { currentColor = null; bold = false; }
      else if (code === 1) { bold = true; }
      else if (ANSI_COLORS[code]) { currentColor = ANSI_COLORS[code]; }
    }
  }

  if (lastIndex < text.length) {
    const segment = text.slice(lastIndex);
    if (currentColor || bold) {
      parts.push(<span key={parts.length} style={{ color: currentColor || undefined, fontWeight: bold ? 700 : undefined }}>{segment}</span>);
    } else {
      parts.push(segment);
    }
  }

  return parts.length > 0 ? parts : text;
}

// Cached: this runs seven regex passes over the full message body and is called
// from renderItem/first-in-sequence logic for every visible row on every feed
// render. Message content strings are identity-stable in the store, so a small
// insertion-order LRU keyed by the string dedupes the work; a streaming row's
// growing content just misses once per tick.
const STRIP_SYSTEM_TAGS_CACHE = new Map<string, string>();
function stripSystemTags(content: string): string {
  const hit = STRIP_SYSTEM_TAGS_CACHE.get(content);
  if (hit !== undefined) return hit;
  const out = content
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<\/?(?:command-(?:name|message|args)|antml:[a-z_]+)[^>]*>/g, '')
    .replace(/^\s*Caveat:.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  if (STRIP_SYSTEM_TAGS_CACHE.size > 2000) {
    STRIP_SYSTEM_TAGS_CACHE.delete(STRIP_SYSTEM_TAGS_CACHE.keys().next().value!);
  }
  STRIP_SYSTEM_TAGS_CACHE.set(content, out);
  return out;
}

// Assistant stub the timeline renders as nothing (see renderTimelineItem).
// Fork-point selection and branch-chip anchoring must treat it as invisible:
// a fork recorded against it would have no message to render its chips under.
function isHiddenStubMessage(msg: { role?: string; content?: string }): boolean {
  return msg.role === "assistant" && stripSystemTags(msg.content || "").trim() === "No response requested.";
}

// Can this message host branch chips? Only user/assistant blocks render a
// BranchSelector, and hidden stubs render nothing at all. Both picking a fork
// point and placing the chips must agree on this, or a fork lands on a message
// with no UI to show it.
function canAnchorForkChips(msg: { role?: string; content?: string; message_uuid?: string }): boolean {
  if (!msg.message_uuid || isHiddenStubMessage(msg)) return false;
  return msg.role === "assistant" || (msg.role === "user" && !!msg.content?.trim());
}

function cleanStickyContent(content: string): string {
  const stMatch = content.match(/<scheduled-task\s+title="([^"]*)"[^>]*>([\s\S]*?)<\/scheduled-task>/);
  if (stMatch) {
    const title = stMatch[1].replace(/&quot;/g, '"');
    const prompt = stMatch[2].trim();
    return prompt ? `${title} — ${prompt}` : title;
  }
  const spawned = parseSpawnedTaskPrompt(content);
  if (spawned) {
    // A spawn task's title is usually the prompt's first ~60 chars — showing
    // "title — prompt" would stutter, so prefer the prompt alone when it
    // subsumes the title.
    if (!spawned.prompt) return spawned.title;
    return spawned.prompt.startsWith(spawned.title) ? spawned.prompt : `${spawned.title} — ${spawned.prompt}`;
  }
  return stripSystemTags(content)
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/<teammate-message\s+[^>]*>[\s\S]*?<\/teammate-message>/g, "")
    .replace(/<scheduled-task[^>]*>[\s\S]*?<\/scheduled-task>/g, "")
    .replace(/\[Image[:\s][^\]]*\]/gi, "")
    .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

type ParsedApiError = {
  statusCode?: number;
  message: string;
  errorType?: string;
  requestId?: string;
  // True for the auth subset (expired login / bad key / no credit / OAuth) — the
  // part the user can act on by re-running /login. Rendered as a distinct
  // "re-authenticate" card instead of the generic provider-error card.
  isAuth?: boolean;
  // True for usage/session-limit banners ("You've hit your session limit ·
  // resets 11:30pm (America/New_York)") — the session is parked until the
  // limit resets. Rendered as a distinct "usage limit" card.
  isLimit?: boolean;
  // True for statusless connection-drop banners ("API Error: Connection
  // closed mid-response. The response above may be incomplete.") — the turn
  // died mid-transmission; a plain "continue" resumes it. Rendered as a
  // distinct "connection dropped" card.
  isConnection?: boolean;
  // True for a statusful failure the CLI won't retry (400 invalid request,
  // 404, 413…) — the turn died at the prompt and stays dead until nudged.
  // Rendered as the generic error card, but the footer hint says "send
  // continue" instead of the self-retry copy.
  isFatal?: boolean;
  // True for a marked opencode/pi provider error that is NOT auth (a provider 5xx
  // or other non-actionable failure). Rendered as the generic error card with the
  // provider's own message, so a failed turn is never a silently blank session.
  isClientError?: boolean;
};

// The remedy for an "auth" card, per client. opencode authenticates via its own
// CLI (`opencode auth login`) in a separate terminal; pi and Claude/Codex re-auth
// with `/login` typed into the running session. Naming the exact fix — and letting
// the user copy it — is what turns a dead session into a one-step recovery.
function authRemedy(agentType?: string): { command: string; where: string; inPane: boolean } {
  if (agentType === "opencode") {
    return { command: "opencode auth login", where: "in a terminal", inPane: false };
  }
  // pi, claude_code, codex, and anything else re-auth with /login in the session.
  return { command: "/login", where: "in its terminal", inPane: true };
}

function parseApiErrorContent(content?: string | null): ParsedApiError | null {
  if (!content) return null;
  const trimmed = content.trim();
  if (!trimmed) return null;

  // Marked opencode/pi provider error: strip the marker, classify (auth vs
  // generic), and show the provider's own text. classifyApiErrorBanner keys on the
  // marker, so isAuth/isClientError below reflect its verdict.
  if (trimmed.startsWith(CLIENT_ERROR_BANNER_PREFIX)) {
    const body = trimmed.slice(CLIENT_ERROR_BANNER_PREFIX.length).trim();
    const kind = classifyApiErrorBanner(trimmed);
    if (kind === "auth") {
      return { message: body || "This session needs authentication.", isAuth: true };
    }
    return { message: body || "The model could not complete this turn.", isClientError: true };
  }

  // Banner detection (auth / limit / connection / fatal) shares the backend's
  // classifier in @codecast/shared/contracts: anchored prefixes + a length cap
  // keep a long prose reply that merely opens like a banner from rendering as
  // a card. The generic "API Error:"-prefixed form keeps its original anchored
  // match (no cap) so a long JSON error payload still renders as the error card.
  const bannerKind = classifyApiErrorBanner(trimmed);
  const isAuth = bannerKind === "auth";
  const isLimit = bannerKind === "limit";
  const isConnection = bannerKind === "connection";
  const isFatal = bannerKind === "fatal";
  const match = trimmed.match(/^API Error:\s*(\d{3})\s*([\s\S]*)$/i);
  if (!isAuth && !isLimit && !isConnection && !isFatal && !match) return null;

  // The status code may be the leading "API Error: NNN" (generic form) or
  // embedded in an auth banner ("Please run /login · API Error: 401 …").
  const statusStr = match?.[1] ?? trimmed.match(/API Error:\s*(\d{3})/i)?.[1];
  const statusCode = statusStr ? Number(statusStr) : undefined;
  const payloadText = (match?.[2] || "").trim();
  let message = "";
  let errorType: string | undefined;
  let requestId: string | undefined;

  if (payloadText.startsWith("{")) {
    try {
      const parsed = JSON.parse(payloadText) as Record<string, unknown>;
      if (typeof parsed.request_id === "string") {
        requestId = parsed.request_id;
      }

      const parsedError = parsed.error;
      if (parsedError && typeof parsedError === "object" && !Array.isArray(parsedError)) {
        const errorRecord = parsedError as Record<string, unknown>;
        if (typeof errorRecord.type === "string") {
          errorType = errorRecord.type;
        }
        if (typeof errorRecord.message === "string") {
          message = errorRecord.message;
        }
      }
    } catch {
      // Keep fallback values for non-JSON payloads.
    }
  }

  if (!requestId) {
    requestId = trimmed.match(/\b(req_[A-Za-z0-9]+)\b/)?.[1];
  }
  if (!message) {
    if (isAuth) {
      // The card states the /login remedy itself, so drop the "Please run
      // /login" instruction (leading or trailing — "Login expired · Please run
      // /login") and the status prefix and keep just the descriptive detail
      // (e.g. "Login expired", "The socket connection was closed unexpectedly").
      message =
        trimmed
          .replace(/^please run \/login\s*[·.\-:]*\s*/i, "")
          .replace(/\s*[·.\-:]*\s*please run \/login\s*$/i, "")
          .replace(/^api error:\s*\d{3}\s*/i, "")
          .trim() || "This session was signed out.";
    } else if (isLimit) {
      // The card heading already says "limit", so drop the redundant
      // "You've hit/reached your" lead-in and keep the informative tail
      // ("Session limit · resets 11:30pm (America/New_York)").
      const detail = trimmed.replace(/^you['’]ve (?:hit|reached) your\s*/i, "");
      message = detail.charAt(0).toUpperCase() + detail.slice(1);
    } else if (isConnection) {
      // The card heading already says the error part, so keep just the detail
      // ("Connection closed mid-response. The response above may be incomplete.").
      message = trimmed.replace(/^api error:?\s*/i, "").trim() || "The connection to the provider dropped.";
    } else {
      message = statusCode === 500 ? "Internal server error" : "API request failed";
    }
  }

  return { statusCode, message, errorType, requestId, isAuth, isLimit, isConnection, isFatal };
}

// A copyable command chip — the command in a mono pill with a copy affordance, so
// the fix for a stopped session is one click away.
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        copyToClipboard(command)
          .then(() => { setCopied(true); toast.success("Command copied"); setTimeout(() => setCopied(false), 1500); })
          .catch(() => toast.error("Couldn't copy"));
      }}
      title="Copy command"
      className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-sol-bg-alt/60 hover:bg-sol-bg-alt text-sol-text-secondary font-mono text-xs transition-colors"
    >
      <span>{command}</span>
      <svg className="w-3 h-3 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        {copied
          ? <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          : <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h10" strokeLinecap="round" /></>}
      </svg>
    </button>
  );
}

// Is the block this banner describes still in force? The conversation row's
// pending_api_error is server-derived and clears the moment anything supersedes
// the banner: a later turn, a message send, an account switch (accountSwitch
// clears it on revive). Reading it live keeps a card honest after the fact —
// an hours-old "Usage limit reached" must not still read as the current state
// once the session moved on. A row missing from the store (not in this viewer's
// inbox window) is treated as still live: the banner is the newest thing we
// know about, so the neutral guess is "unresolved".
function useApiErrorLive(conversationId?: string): boolean {
  return useInboxStore((s) => {
    if (!conversationId) return true;
    const row = s.sessions[conversationId];
    if (!row) return true;
    return row.pending_api_error === true;
  });
}

function ApiErrorCard({ error, agentType, conversationId, timestamp, compact = false }: { error: ParsedApiError; agentType?: string; conversationId?: string; timestamp?: number; compact?: boolean }) {
  const live = useApiErrorLive(conversationId);
  // Relative "when" ticks so the card stays true as time passes.
  const now = useCoarseNow(30_000);
  const resetAt = error.isLimit ? parseLimitResetAt(error.message, timestamp) : undefined;
  const resetPassed = resetAt != null && now >= resetAt;
  const isServerError = !error.isAuth && !error.isLimit && !error.isConnection && (error.statusCode ?? 0) >= 500;

  // Tone: amber (or red for a provider 5xx) while the block is in force;
  // muted once the session moved past it, so a stale banner reads as history.
  const tone = !live
    ? { border: "border-sol-border/40 bg-sol-bg-alt/30", fg: "text-sol-text-muted", badge: "border-sol-border/40 bg-sol-bg-alt/50 text-sol-text-muted", icon: "bg-sol-bg-alt text-sol-text-muted" }
    : isServerError
      ? { border: "border-sol-red/40 bg-sol-red/10", fg: "text-sol-red", badge: "border-sol-red/40 bg-sol-red/10 text-sol-red", icon: "bg-sol-red/20 text-sol-red" }
      : { border: "border-amber-500/40 bg-amber-500/10", fg: "text-amber-500", badge: "border-amber-500/40 bg-amber-500/10 text-amber-500", icon: "bg-amber-500/20 text-amber-500" };

  let heading: string;
  let icon: ReactNode;
  let hint: ReactNode;
  const remedy = authRemedy(agentType);
  if (error.isAuth) {
    heading = "Authentication required";
    icon = (
      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <circle cx="7.5" cy="15.5" r="3.5" />
        <path d="M10 13L20 3M17 6l2 2M14 9l2 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
    hint = (
      <>
        <div className="mt-2 flex items-center gap-1.5 flex-wrap text-xs text-sol-text-dim">
          <span>Run</span>
          <CopyCommand command={remedy.command} />
          <span>{remedy.where} to {remedy.inPane ? "re-authenticate" : "set up an account"}, then retry.</span>
        </div>
        {agentType === "opencode" && (
          <ProviderKeyInlineEntry errorMessage={error.message} conversationId={conversationId} />
        )}
      </>
    );
  } else if (error.isLimit) {
    heading = "Usage limit reached";
    icon = (
      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path d="M6 3h12M6 21h12M8 3v3.5c0 2 4 4 4 5.5s-4 3.5-4 5.5V21M16 3v3.5c0 2-4 4-4 5.5s4 3.5 4 5.5V21" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
    hint = (
      <p className="mt-1.5 text-xs text-sol-text-dim">
        {resetPassed
          ? <>The limit window reset {formatRelativeTime(resetAt!)} — send a message to pick up where it left off.</>
          : "The session is paused until the limit resets — send a message after that to pick up where it left off."}
      </p>
    );
  } else if (error.isConnection) {
    heading = "Connection dropped";
    icon = (
      <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
    hint = (
      <p className="mt-1.5 text-xs text-sol-text-dim">
        The turn was cut off mid-response — send{" "}
        <code className="px-1 py-0.5 rounded bg-sol-bg-alt/60 text-sol-text-secondary font-mono">continue</code>{" "}
        (or any message) and the session picks up where it left off.
      </p>
    );
  } else {
    heading = "API Error";
    icon = <span className="text-[10px] font-semibold">!</span>;
    hint = (
      <p className="mt-1 text-xs text-sol-text-dim">
        {error.isFatal ? (
          <>
            The agent won&apos;t retry this on its own — send{" "}
            <code className="px-1 py-0.5 rounded bg-sol-bg-alt/60 text-sol-text-secondary font-mono">continue</code>{" "}
            (or any message) to retry the turn.
          </>
        ) : (
          "Provider-side failure. Retry the request; if it repeats, include the request ID."
        )}
      </p>
    );
  }

  return (
    <div className={`rounded-lg border ${tone.border} ${compact ? "px-2.5 py-2" : "px-3 py-2.5"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full ${tone.icon}`}>
          {icon}
        </span>
        <span className={`text-xs font-semibold uppercase tracking-wide ${tone.fg}`}>
          {heading}
        </span>
        {error.statusCode && !error.isLimit && !error.isConnection && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${tone.badge}`}>
            {error.statusCode}
          </span>
        )}
        {error.errorType && !error.isAuth && !error.isLimit && !error.isConnection && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-border/40 bg-sol-bg-alt/50 text-sol-text-dim font-mono">
            {error.errorType}
          </span>
        )}
        {!live && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-sol-green/40 bg-sol-green/10 text-sol-green uppercase tracking-wide">
            resolved
          </span>
        )}
        {timestamp != null && (
          <span className="ml-auto text-[10px] text-sol-text-dim shrink-0 whitespace-nowrap" title={formatFullTimestamp(timestamp)}>
            {formatRelativeTime(timestamp)}
          </span>
        )}
      </div>
      <p className={`mt-1 text-sm ${tone.fg}`}>{error.message}</p>
      {error.requestId && !error.isAuth && !error.isLimit && !error.isConnection && (
        <p className="mt-1 text-[11px] text-sol-text-muted font-mono">
          request_id: <span className="text-sol-text-secondary">{error.requestId}</span>
        </p>
      )}
      {!live ? (
        <p className="mt-1.5 text-xs text-sol-text-dim">
          The session continued after this — nothing to do here.
        </p>
      ) : (!compact || resetPassed) && hint}
    </div>
  );
}

// Guess which provider an opencode auth failure is about, from its message text.
// opencode surfaces the provider by name ("OpenRouter", "no Anthropic API key") or
// its short code ("OR"); when nothing matches we let the user pick from the list.
function detectProviderFromError(message: string): string | undefined {
  const m = message.toLowerCase();
  if (/openrouter/.test(m) || /\bOR\b/.test(message)) return "openrouter";
  if (/anthropic|claude/.test(m)) return "anthropic";
  if (/openai|\bgpt\b/.test(m)) return "openai";
  if (/vertex|gemini|google/.test(m)) return "google";
  return undefined;
}

// Inline key entry on an opencode auth-error card. opencode fails a turn when the
// chosen provider has no key on the machine; rather than send the user to a terminal,
// let them drop the key right here — sealed to the session's owner device and applied
// by its daemon. The key leaves the browser only as ciphertext (encryptProviderKey).
// Collapsed behind an "Add a key" toggle so the amber card stays uncluttered; falls
// back to the `cast keys set` command when the device's daemon predates managed keys.
function ProviderKeyInlineEntry({
  errorMessage,
  conversationId,
}: {
  errorMessage: string;
  conversationId?: string;
}) {
  const [open, setOpen] = useState(false);
  const detected = useMemo(() => detectProviderFromError(errorMessage), [errorMessage]);
  const [provider, setProvider] = useState<string>(detected ?? PROVIDER_KEYS[0].id);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const { byId, mostRecentOnlineLocal } = useDevices();
  const ownerDeviceId = useInboxStore((s) =>
    conversationId ? s.sessions[conversationId]?.owner_device_id : undefined,
  );
  const { setKey } = useProviderKeyCommand();

  // The device running this session, else the primary online machine.
  const device = (ownerDeviceId ? byId.get(ownerDeviceId) : undefined) ?? mostRecentOnlineLocal ?? null;
  const pubkey = device ? deviceManagedKeys(device).pubkey : undefined;
  const spec = getProviderKeySpec(provider);

  const save = async () => {
    const key = value.trim();
    if (!key || !pubkey || !device) return;
    setBusy(true);
    try {
      await setKey(device.device_id, pubkey, provider, key);
      toast.success("Key saved — resend to retry");
      setValue("");
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save that key");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex items-center gap-1 text-xs text-amber-500 hover:text-amber-400 transition-colors"
      >
        <KeyRound className="w-3 h-3" />
        Add a key
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 space-y-2">
      {!device ? (
        <p className="text-xs text-sol-text-dim">
          No online machine to store a key on. Start your daemon, then try again.
        </p>
      ) : !pubkey ? (
        <div className="flex items-center gap-1.5 flex-wrap text-xs text-sol-text-dim">
          <span>This machine&apos;s daemon predates managed keys — set it from a terminal:</span>
          <CopyCommand command={`cast keys set ${provider}`} />
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="rounded border border-sol-border bg-sol-bg px-2 py-1 text-xs text-sol-text focus:border-sol-cyan focus:outline-none"
            >
              {PROVIDER_KEYS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            {spec && (
              <a
                href={spec.consoleUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-cyan"
              >
                get a key
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="password"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") { setOpen(false); setValue(""); }
              }}
              placeholder={spec?.keyPrefix ? `${spec.keyPrefix}…` : "API key"}
              className="flex-1 min-w-0 rounded border border-sol-border bg-sol-bg px-2 py-1 text-xs text-sol-text font-mono placeholder:text-sol-base01 focus:border-sol-cyan focus:outline-none"
            />
            <button
              onClick={save}
              disabled={busy || !value.trim()}
              className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-500 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Save &amp; retry
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The steps of a batched tool call, one row each: label, what the step asked
 * for, and — once the result is in — what it reported. Shared by the
 * extension's browser_batch, Codex's exec program and `cast browser do`, so a
 * batch reads the same whichever client ran it. A failed step goes red; steps
 * after a failure never ran and stay dim with no outcome.
 */
function NestedStepList({ steps, outcomes, labelClass }: {
  steps: Array<{ label: string; summary?: string }>;
  outcomes?: NestedStepOutcome[];
  labelClass?: string;
}) {
  return (
    <div className="divide-y divide-sol-border/20 border-b border-sol-border/20 bg-sol-bg-highlight/20">
      {steps.map((step, index) => {
        const outcome = outcomes?.[index];
        const failed = outcome?.ok === false;
        const skipped = !!outcomes && outcome?.ok === undefined && !outcome?.output;
        return (
          <div key={`${step.label}-${index}`} className={`px-2 py-1.5 text-xs font-mono ${skipped ? "opacity-50" : ""}`}>
            <div className="flex items-start gap-2">
              <span className="shrink-0 w-4 text-right tabular-nums text-sol-text-dim">{index + 1}</span>
              <span className={`shrink-0 ${failed ? "text-sol-red" : labelClass ?? "text-sol-cyan/80"}`}>{step.label}</span>
              {step.summary && <span className="min-w-0 break-words text-sol-text-muted">{step.summary}</span>}
            </div>
            {outcome?.output && (
              <pre className={`mt-0.5 pl-6 whitespace-pre-wrap break-words ${failed ? "text-sol-red" : "text-sol-text-secondary/80"}`}>
                {renderAnsi(outcome.output)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function summarizeBashCommand(cmd: string): string {
  let c = stripCdPrefix(cmd);
  c = c.replace(/\/Users\/\w+\//g, '~/');
  c = c.replace(/\/home\/\w+\//g, '~/');
  const rgMatch = c.match(/^(rg|grep|ripgrep)\s+([\s\S]*)$/);
  if (rgMatch) {
    const args = rgMatch[2];
    const patternMatch = args.match(/(?:^|\s)(?:-e\s+)?['"]([^'"]+)['"]/);
    const bareMatch = patternMatch ? null : args.match(/(?:^|\s)(?:-[a-zA-Z]+\s+)*([^\s-]\S*)/);
    const pattern = patternMatch?.[1] || bareMatch?.[1] || "";
    if (pattern) return `rg "${pattern.length > 40 ? pattern.slice(0, 40) + "..." : pattern}"`;
  }
  const sedMatch = c.match(/^sed\s+.*?\s+(\S+)\s*$/);
  if (sedMatch) {
    const file = sedMatch[1].split('/').pop() || sedMatch[1];
    return `sed ${file}`;
  }
  if (c.startsWith('git ')) {
    const parts = c.split(/\s+/);
    const meaningful = parts.filter(p => !p.startsWith('-') || p === '--staged' || p === '--cached' || p === '--stat' || p === '--short').slice(0, 4);
    return meaningful.join(' ');
  }
  return c.length > 80 ? c.slice(0, 80) + '...' : c;
}

// Cached by tool-call object (identity-stable in the store): the JSON.parse of
// a Bash tool's input showed up as a per-render scroll cost.
const PARSE_CAST_COMMAND_CACHE = new WeakMap<ToolCall, ParsedCastCommand | null>();
function parseCastCommand(tool: ToolCall): ParsedCastCommand | null {
  if (!isShellTool(tool.name)) return null;
  if (PARSE_CAST_COMMAND_CACHE.has(tool)) return PARSE_CAST_COMMAND_CACHE.get(tool)!;
  let out: ParsedCastCommand | null = null;
  try {
    const input = JSON.parse(tool.input);
    out = parseCastCommandString(String(input.command || input.cmd || ""));
  } catch { out = null; }
  PARSE_CAST_COMMAND_CACHE.set(tool, out);
  return out;
}

function hasRichMarkdown(text: string): boolean {
  if (/\b(ct|pl)-[a-z0-9]+\b/i.test(text)) return true;
  const markers = [
    /^#{1,3}\s+\S/m,           // headers
    /\|.+\|.+\|/,              // tables
    /^```\w*/m,                 // fenced code blocks
    /^\d+\.\s+\*\*[^*]+\*\*/m, // numbered list with bold
    /^-\s+\[[ x]\]/im,         // task lists
  ];
  let hits = 0;
  for (const m of markers) {
    if (m.test(text)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

const PLAN_PREFIXES = [
  /^implement\s+the\s+following\s+plan\s*:\s*/i,
  /^implement\s+this\s+plan\s*:\s*/i,
  /^here(?:'s| is)\s+the\s+plan\s*:\s*/i,
  /^plan\s*:\s*\n/i,
];

function extractPlanContent(text: string): string | null {
  const trimmed = text.trim();
  for (const prefix of PLAN_PREFIXES) {
    const match = trimmed.match(prefix);
    if (match) {
      const rest = trimmed.slice(match[0].length).trim();
      if (rest.length > 200 && hasRichMarkdown(rest)) {
        return rest;
      }
    }
  }
  return null;
}

type UserMessageKind =
  | { kind: 'normal' }
  | { kind: 'command' }
  | { kind: 'bash_input'; command: string }
  | { kind: 'bash_output'; stdout: string; stderr: string }
  | { kind: 'interrupt'; tone: 'sky' | 'amber' }
  | { kind: 'background_agent_stopped'; agentName?: string }
  | { kind: 'skill_expansion'; cmdName?: string }
  | { kind: 'task_notification' }
  | { kind: 'task_prompt' }
  | { kind: 'compaction_prompt' }
  | { kind: 'compaction_summary' }
  | { kind: 'plan'; planContent: string }
  | { kind: 'noise' }
  | { kind: 'tool_results_only' }
  | { kind: 'empty' }
  | { kind: 'teammate_events' }
  | { kind: 'continuation' }
  | { kind: 'poll_response' }
  | { kind: 'scheduled_task' }
  | { kind: 'machine_move'; destination?: string; machineChanged: boolean }
  | { kind: 'agent_switch'; toLabel: string; fromLabel?: string }
  | { kind: 'session_message'; from: string; body: string; name?: string }
  | { kind: 'huddle_summary'; huddle: HuddleSummaryTag }
  | { kind: 'chat_wake'; wake: ChatWakePrompt }
  // The human's answer to a `cast decide` question (store answerDecision).
  | { kind: 'decision_answer'; decision: DecisionAnswerMessage };

const STICKY_NOISE_PREFIXES = ["[Request interrupted", "<task-notification>", "Your task is to create a detailed summary", "Full transcript available at:", "[Codecast import]"];

// Dedup key for matching a still-pending message against its eventual JSONL echo.
// The daemon collapses newlines to spaces on inject (injectViaTmux) and a few control
// chars can leak in, so we strip reminders + control chars and flatten all whitespace —
// the multi-line stored pending content and the single-line echoed copy normalize equal.
function normalizePendingContent(s: string): string {
  // Slash commands: the pending row holds what the user typed ("/cmd args") but the JSONL
  // echo holds the expanded tag form ("<command-name>/cmd</command-name><command-args>args
  // </command-args>"). Canonicalize both to "/cmd args" so they match and the pending bubble
  // drops once the echo lands (otherwise the command renders twice).
  const cmd = parseCommandInvocation(s || "");
  if (cmd.cmdName) return `/${cmd.cmdName}${cmd.args ? " " + cmd.args.replace(/\s+/g, " ").trim() : ""}`;
  return (s || "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyUserMessage(
  msg: Message,
  agentType?: string,
  immediatePrev?: Message | null,
  contextPrev?: Message | null,
): UserMessageKind {
  const hasUserImages = msg.images?.some(img => !img.tool_use_id);
  if (msg.tool_results && msg.tool_results.length > 0 && (!msg.content || !msg.content.trim()) && !hasUserImages) {
    return { kind: 'tool_results_only' };
  }
  const content = msg.content;
  if (!content || !content.trim()) {
    return hasUserImages ? { kind: 'normal' } : { kind: 'empty' };
  }
  const t = content.trim();
  const tNoReminders = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, '').trim();
  const tStripped = stripSystemTags(t).trim();
  if (tNoReminders.startsWith('<scheduled-task')) return { kind: 'scheduled_task' };
  // A spawned schedule run's opening prompt (plain-text wire format from
  // taskScheduler.buildPrompt) gets the same rich block as injected schedules.
  if (isSpawnedTaskPrompt(tNoReminders)) return { kind: 'scheduled_task' };
  const sessionMsg = parseInboundSessionMessage(t);
  if (sessionMsg) {
    // A huddle that ended in this session's room: the digest rides the
    // session-message rail, but it is a call artifact, not a teammate's words.
    const huddle = parseHuddleSummaryTag(sessionMsg.body);
    if (huddle) return { kind: 'huddle_summary', huddle };
    return { kind: 'session_message', from: sessionMsg.from, body: sessionMsg.body, name: sessionMsg.name };
  }
  {
    const huddle = parseHuddleSummaryTag(tNoReminders);
    if (huddle) return { kind: 'huddle_summary', huddle };
  }
  const chatWake = parseChatWakePrompt(t);
  if (chatWake) return { kind: 'chat_wake', wake: chatWake };
  const decisionAnswer = parseDecisionAnswer(tNoReminders);
  if (decisionAnswer) return { kind: 'decision_answer', decision: decisionAnswer };
  if (t.startsWith('{') && t.includes('__cc_poll')) {
    try { if (JSON.parse(t).__cc_poll) return { kind: 'poll_response' }; } catch {}
  }
  if (immediatePrev?.role === 'assistant' && immediatePrev?.tool_calls?.some(tc => isAskTool(tc.name))) {
    return { kind: 'poll_response' };
  }
  if (!tStripped) return { kind: 'noise' };
  // `!` bash mode: the typed command and its output arrive as two consecutive
  // user messages; they pair up into one terminal block at render time.
  const bashCmd = parseBashInput(tNoReminders);
  if (bashCmd !== null) return { kind: 'bash_input', command: bashCmd };
  const bashOut = parseBashOutput(tNoReminders);
  if (bashOut) return { kind: 'bash_output', stdout: bashOut.stdout, stderr: bashOut.stderr };
  if (isCommandMessage(tNoReminders)) {
    if (isModelSwitchStdout(tNoReminders)) {
      return { kind: "agent_switch", toLabel: modelSwitchStdoutLabel(tNoReminders) || "new model" };
    }
    if (isSkillExpansion(t)) {
      const cmdMatch = t.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
      return { kind: 'skill_expansion', cmdName: cmdMatch?.[1]?.replace(/^\//, "") };
    }
    if (immediatePrev?.role === 'user' && immediatePrev?.content && isCommandMessage(immediatePrev.content)) {
      const cmdMatch = t.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/) ||
                       immediatePrev.content.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
      return { kind: 'skill_expansion', cmdName: cmdMatch?.[1]?.replace(/^\//, "") };
    }
    // Hide /compact commands — the compact_boundary system message handles the visual separator
    const cmdName = t.match(/<command-(?:name|message)>\/?compact<\/command-(?:name|message)>/);
    if (cmdName || t === '/compact') return { kind: 'compaction_prompt' };
    const parsedCmd = parseCommandInvocation(tNoReminders);
    if (isModelSwitchCommandName(parsedCmd.cmdName)) {
      const label = parsedCmd.cmdName === "effort"
        ? `${parsedCmd.args || "effort"} effort`
        : (parsedCmd.args || "new model");
      return { kind: "agent_switch", toLabel: label };
    }
    return { kind: 'command' };
  }
  // Legacy stored form: command tags were stripped at sync time, leaving "name\n/name\nargs".
  // isCommandMessage misses it (no leading tag/slash), so catch it explicitly.
  if (isStrippedCommand(tNoReminders)) return { kind: 'command' };
  if (agentType === "codex" && isCodexTurnAbortedMessage(t)) return { kind: 'interrupt', tone: 'amber' };
  if (isInterruptMessage(t)) return { kind: 'interrupt', tone: 'sky' };
  if (isAgentSwitchNotice(tNoReminders) || msg.subtype === "agent_switch") {
    const parsed = parseAgentSwitchNotice(tNoReminders);
    return { kind: "agent_switch", toLabel: parsed?.toLabel || "new agent", fromLabel: parsed?.fromLabel };
  }
  if (isModelSwitchStdout(tNoReminders)) {
    return { kind: "agent_switch", toLabel: modelSwitchStdoutLabel(tNoReminders) || "new model" };
  }
  if (isMachineMoveNotice(tNoReminders)) return { kind: 'machine_move', ...parseMachineMoveNotice(tNoReminders) };
  if (isBackgroundAgentStoppedNotice(t)) return { kind: 'background_agent_stopped', agentName: backgroundAgentStoppedName(t) ?? undefined };
  if (isSkillExpansion(t)) return { kind: 'skill_expansion' };
  if (isTaskNotification(t)) {
    const stripped = t.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '').trim();
    if (!stripped || stripped.length < 4 || stripped.startsWith('Read the output file to retrieve the result:') || stripped.startsWith('Full transcript available at:')) return { kind: 'task_notification' };
  }
  if (immediatePrev?.role === 'assistant' && immediatePrev?.tool_calls?.some(tc => tc.name === 'Task' || tc.name === 'Agent')) {
    if (!tStripped) return { kind: 'task_prompt' };
  }
  if (isCompactionPromptMessage(t)) return { kind: 'compaction_prompt' };
  if (t.startsWith('Read the output file to retrieve the result:') || t.startsWith('Full transcript available at:')) return { kind: 'noise' };
  if (immediatePrev?.role === 'user') {
    const echoCmd = commandExpansionName(immediatePrev, msg);
    if (echoCmd !== null) return { kind: 'skill_expansion', cmdName: echoCmd };
  }
  if (contextPrev?.role === 'system' && contextPrev?.subtype === 'compact_boundary') {
    if (!tStripped) return { kind: 'noise' };
    return { kind: 'compaction_summary' };
  }
  if (t.includes('<teammate-message')) {
    const leftover = t
      .replace(/<teammate-message\s+[^>]*>[\s\S]*?<\/teammate-message>/g, '')
      .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
      .trim();
    // Pure teammate tags, or tags wrapped only in the harness's framing boilerplate, are
    // a teammate broadcast — render as a teammate event (no human avatar), not a user turn.
    if (!leftover || isTeammateFramingOnly(leftover)) {
      return { kind: 'teammate_events' };
    }
  }
  const planContent = extractPlanContent(t);
  if (planContent) return { kind: 'plan', planContent };
  const displayable = t
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<teammate-message\s+[^>]*>[\s\S]*?<\/teammate-message>/g, '')
    .replace(/\[Image[:\s][^\]]*\]/gi, '')
    .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, '')
    .trim();
  if (!displayable) {
    if (!immediatePrev && !contextPrev) return { kind: 'normal' };
    return hasUserImages ? { kind: 'normal' } : { kind: 'noise' };
  }
  if (displayable.startsWith("This session is being continued") || displayable.startsWith("Please continue the conversation")) {
    return { kind: 'continuation' };
  }
  if (STICKY_NOISE_PREFIXES.some(p => displayable.startsWith(p))) {
    return { kind: 'noise' };
  }
  return { kind: 'normal' };
}

function isStickyWorthy(kind: UserMessageKind): boolean {
  // The sticky pill surfaces what the human said. Machine-delivered kinds
  // (session messages, teammate broadcasts, trigger runs) never qualify.
  return kind.kind === 'normal' || kind.kind === 'plan' || kind.kind === 'decision_answer';
}

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatFullTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ClaudeIcon() {
  return (
    <span className="w-6 h-6 rounded bg-sol-orange flex items-center justify-center shrink-0">
      <svg className="w-3.5 h-3.5 text-sol-bg" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
      </svg>
    </span>
  );
}

function CodexIcon() {
  return (
    <div className="w-6 h-6 rounded bg-[#0f0f0f] flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729z" fill="white"/>
      </svg>
    </div>
  );
}

function CursorIcon() {
  return (
    <div className="w-6 h-6 rounded bg-[#1a1a2e] flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 4l16 6-8 2-2 8z"/>
      </svg>
    </div>
  );
}

function GeminiIcon() {
  return (
    <div className="w-6 h-6 rounded bg-[#1a73e8] flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 28 28" fill="white" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 0C12 0 12 6.268 8.134 10.134C4.268 14 0 14 0 14C0 14 6.268 14 10.134 17.866C14 21.732 14 28 14 28C14 28 14 21.732 17.866 17.866C21.732 14 28 14 28 14C28 14 21.732 14 17.866 10.134C14 6.268 14 0 14 0" />
      </svg>
    </div>
  );
}

function OpencodeIcon() {
  return (
    <div className="w-6 h-6 rounded bg-orange-500 flex items-center justify-center shrink-0">
      <svg className="w-3.5 h-3.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="8 6 3 12 8 18" />
        <polyline points="16 6 21 12 16 18" />
      </svg>
    </div>
  );
}

function PiIcon() {
  return (
    <div className="w-6 h-6 rounded bg-teal-500 flex items-center justify-center shrink-0">
      <span className="text-white text-sm font-semibold leading-none">π</span>
    </div>
  );
}

function GrokIcon() {
  return (
    <div className="w-6 h-6 rounded bg-sol-text flex items-center justify-center shrink-0">
      <GrokMark className="w-3.5 h-3.5 text-sol-bg" />
    </div>
  );
}

function AssistantIcon({ agentType }: { agentType?: string }) {
  if (agentType === "codex") return <CodexIcon />;
  if (agentType === "cursor") return <CursorIcon />;
  if (agentType === "gemini") return <GeminiIcon />;
  if (agentType === "opencode") return <OpencodeIcon />;
  if (agentType === "pi") return <PiIcon />;
  if (agentType === "grok") return <GrokIcon />;
  return <ClaudeIcon />;
}

function assistantLabel(agentType?: string): string {
  if (agentType === "codex") return "Codex";
  if (agentType === "cursor") return "Cursor";
  if (agentType === "gemini") return "Gemini";
  if (agentType === "opencode") return "OpenCode";
  if (agentType === "pi") return "pi";
  if (agentType === "grok") return "Grok";
  return "Claude";
}


function ConversationMetadata({
  agentType,
  model,
  effort,
  startedAt,
  messageCount,
  shortId,
  conversationId,
  canEditModel,
}: {
  agentType?: string;
  model?: string;
  effort?: string;
  startedAt?: number;
  messageCount?: number;
  shortId?: string;
  conversationId?: string;
  canEditModel?: boolean;
}) {
  if (!agentType && !model && !startedAt && !messageCount) return null;

  return (
    <div className="flex items-center gap-1 text-[10px] sm:text-xs text-sol-text-dim min-w-0 overflow-hidden">
      {agentType && (
        <div
          className="flex items-center flex-shrink-0 cursor-default"
          title={formatAgentType(agentType)}
        >
          <AgentTypeIcon agentType={agentType} />
        </div>
      )}
      <HeaderModelControl
        conversationId={conversationId}
        agentType={agentType}
        model={model}
        effort={effort}
        messageCount={messageCount}
        canEdit={!!canEditModel}
      />
      {startedAt && (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-sol-text-dim">&middot;</span>
          <span title={formatFullTimestamp(startedAt)}>{formatRelativeTime(startedAt)}</span>
        </div>
      )}
      {messageCount !== undefined && messageCount > 0 && (
        <button
          className="hidden sm:flex items-center gap-1.5 flex-shrink-0 hover:text-sol-text-muted transition-colors cursor-pointer"
          title="Copy conversation ID"
          onClick={() => { if (conversationId) setTimeout(() => { copyToClipboard(conversationId).then(() => toast.success("ID copied")); }); }}
        >
          <span className="text-sol-text-dim">&middot;</span>
          <span>{messageCount} {messageCount === 1 ? "msg" : "msgs"}</span>
        </button>
      )}
      {startedAt && (
        <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
          <span className="text-sol-text-dim">&middot;</span>
          <span>{formatDuration(startedAt)}</span>
        </div>
      )}
    </div>
  );
}

const INLINE_TASK_STATUS: Record<string, { icon: typeof Circle; color: string }> = {
  open: { icon: Circle, color: "text-sol-blue" },
  in_progress: { icon: CircleDot, color: "text-sol-yellow" },
  done: { icon: CheckCircle2, color: "text-sol-green" },
};

function TaskProgressRow({ taskStats }: { taskStats: { total: number; done: number; in_progress: number; open: number; items: { id: string; content: string; status: string }[] } }) {
  const [expanded, setExpanded] = useState(false);
  const { total, done, in_progress } = taskStats;
  const donePct = (done / total) * 100;
  const ipPct = (in_progress / total) * 100;
  const isComplete = done === total;

  return (
    <div className="mt-0.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-1 py-0.5 rounded hover:bg-sol-bg-alt/60 transition-colors group cursor-pointer"
      >
        {expanded ? <ChevronDown className="w-3 h-3 text-sol-text-dim flex-shrink-0" /> : <ChevronRight className="w-3 h-3 text-sol-text-dim flex-shrink-0" />}
        {isComplete ? (
          <CheckCircle2 className="w-3 h-3 text-sol-green flex-shrink-0" />
        ) : in_progress > 0 ? (
          <CircleDot className="w-3 h-3 text-sol-yellow animate-pulse flex-shrink-0" />
        ) : (
          <Circle className="w-3 h-3 text-sol-text-dim flex-shrink-0" />
        )}
        <div className="flex-1 h-1.5 bg-sol-border/30 rounded-full overflow-hidden min-w-[60px] max-w-[120px]">
          <div className="h-full flex">
            <div
              className={`h-full ${isComplete ? "bg-sol-green" : "bg-sol-green/80"}`}
              style={{ width: `${donePct}%` }}
            />
            {ipPct > 0 && (
              <div className="h-full bg-sol-yellow/60" style={{ width: `${ipPct}%` }} />
            )}
          </div>
        </div>
        <span className={`text-[10px] tabular-nums flex-shrink-0 ${isComplete ? "text-sol-green" : "text-sol-text-dim"}`}>
          {done}/{total} tasks
        </span>
      </button>
      {expanded && (
        <div className="ml-4 mt-0.5 border-l border-sol-border/20 pl-2">
          {taskStats.items.map((item) => {
            const cfg = INLINE_TASK_STATUS[item.status] || INLINE_TASK_STATUS.open;
            const Icon = cfg.icon;
            return (
              <div key={item.id} className="flex items-center gap-1.5 py-0.5">
                <Icon className={`w-3 h-3 flex-shrink-0 ${cfg.color}`} />
                <span className={`text-[11px] truncate ${item.status === "done" ? "text-sol-text-dim line-through" : "text-sol-text-muted"}`}>
                  {item.content}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Tool/task stats live in their own leaves so getConversationToolStats — which
// re-scans ALL messages and updates continuously as a live session streams — re-renders
// only these tiny consumers instead of the 11k-line ConversationView. Both leaves share
// one Convex subscription (identical query+args are deduped); the header menu item only
// mounts (and subscribes) while the dropdown is open.
function useConversationTaskStats(conversationId: string | undefined) {
  const enabled = useDeferUntilSettled(conversationId);
  const toolStats = useQuery(
    api.conversations.getConversationToolStats,
    enabled && conversationId && isConvexId(conversationId)
      ? { conversation_id: conversationId, ...shareTokenArg(conversationId) }
      : "skip"
  );
  return toolStats?.taskStats ?? null;
}

// Full-width strip at the header's bottom edge narrating a kill+restart the
// moment it's requested — before any server ack — through the daemon's
// kill→resume ladder, to a green "back live" confirmation or a red give-up.
// Driven entirely by useSessionRestart's phase/stage; mounted only while a
// restart is in some visible state, so the 1s elapsed tick costs nothing
// otherwise.
function RestartStatusStrip({ phase, stage, failure, startedAt, onRetry, restoredLabel }: {
  phase: RestartPhase;
  stage: RestartStage | null;
  failure: string | null;
  startedAt: number | null;
  onRetry: () => void;
  /** "Back live" confirmation text — device moves say where the session landed. */
  restoredLabel?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase !== "restarting") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);
  if (phase === "idle") return null;
  const tone = phase === "restored" ? "ok" : phase === "failed" ? "error" : (stage?.tone ?? "active");
  const label =
    phase === "restored" ? (restoredLabel ?? "Session is back live")
    : phase === "failed" ? (failure ?? "Restart failed")
    : (stage?.label ?? "Restarting session — contacting daemon…");
  const toneClass = {
    active: { wrap: "bg-sol-orange/10 text-sol-orange", dot: "bg-sol-orange" },
    warn: { wrap: "bg-sol-yellow/10 text-sol-yellow", dot: "bg-sol-yellow" },
    error: { wrap: "bg-sol-red/10 text-sol-red", dot: "bg-sol-red" },
    ok: { wrap: "bg-sol-green/10 text-sol-green", dot: "bg-sol-green" },
  }[tone];
  const elapsed = phase === "restarting" && startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : null;
  return (
    <div className={`flex items-center gap-2 px-4 py-1.5 text-[12px] ${toneClass.wrap}`}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${toneClass.dot} ${tone === "error" ? "" : "animate-pulse"}`} />
      <span className="min-w-0 truncate">{label}</span>
      {elapsed !== null && elapsed >= 3 && (
        <span className="shrink-0 tabular-nums opacity-60">{elapsed}s</span>
      )}
      {phase === "failed" && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 ml-auto font-medium hover:underline"
        >
          Try again
        </button>
      )}
    </div>
  );
}

// Same strip for a device move ("Run here" / "Move to remote Mac"): the move
// pipeline — worktree transfer, resume on the destination — narrated live from
// the same daemon command rows. useDeviceMoveStatus owns the lifecycle
// (movingSessions in the store), so this stays mounted-cheap when idle.
function DeviceMoveStatusStrip({ conversationId }: { conversationId: string }) {
  const { phase, stage, failure, startedAt, restoredLabel, retry } = useDeviceMoveStatus(conversationId);
  return (
    <RestartStatusStrip
      phase={phase}
      stage={stage}
      failure={failure}
      startedAt={startedAt}
      onRetry={retry}
      restoredLabel={restoredLabel}
    />
  );
}

const ConversationTaskProgress = memo(function ConversationTaskProgress({ conversationId }: { conversationId: string }) {
  const taskStats = useConversationTaskStats(conversationId);
  if (!taskStats) return null;
  return <TaskProgressRow taskStats={taskStats} />;
});

const ConversationTaskStatsMenuItem = memo(function ConversationTaskStatsMenuItem({ conversationId }: { conversationId: string }) {
  const taskStats = useConversationTaskStats(conversationId);
  if (!taskStats) return null;
  return (
    <DropdownMenuItem disabled>
      Tasks: {taskStats.done}/{taskStats.total}
    </DropdownMenuItem>
  );
});

function findMatchingChild(
  prompt: string,
  childConversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>,
): string | undefined {
  if (!childConversations || !prompt) return undefined;
  const subagents = childConversations.filter(c => c.is_subagent && c.first_message_preview);
  if (subagents.length === 0) return undefined;

  const promptStart = prompt.slice(0, 100).toLowerCase().trim();

  for (const child of subagents) {
    const preview = child.first_message_preview!.slice(0, 100).toLowerCase().trim();
    if (promptStart === preview || promptStart.startsWith(preview) || preview.startsWith(promptStart)) {
      return child._id;
    }
  }
  return undefined;
}

function parseSpawnResult(content: string): { agentName?: string; teamName?: string; agentId?: string } | null {
  if (!content.startsWith("Spawned successfully")) return null;
  const lines = content.split("\n");
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) fields[m[1]] = m[2].trim();
  }
  return { agentName: fields.name, teamName: fields.team_name, agentId: fields.agent_id };
}

function TaskToolBlock({ tool, result, childConversationId, childConversations }: { tool: ToolCall; result?: ToolResult; childConversationId?: string; childConversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }> }) {
  const isCompleted = !!result;
  const [expanded, setExpanded] = useState(false);

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const subagentType = String(parsedInput.subagent_type || "unknown");
  const description = String(parsedInput.description || "");
  const prompt = String(parsedInput.prompt || "");
  const model = parsedInput.model ? String(parsedInput.model) : null;
  const name = parsedInput.name ? String(parsedInput.name) : null;
  const runInBackground = Boolean(parsedInput.run_in_background || parsedInput.background);

  const resolvedChildId = childConversationId || findMatchingChild(prompt, childConversations);
  const router = useRouter();

  const subagentColors: Record<string, { bg: string; border: string; text: string }> = {
    Explore: { bg: "bg-sol-green/20", border: "border-sol-green/50", text: "text-sol-green" },
    Plan: { bg: "bg-sol-cyan/20", border: "border-sol-cyan/50", text: "text-sol-cyan" },
    implementor: { bg: "bg-sol-yellow/20", border: "border-sol-yellow/50", text: "text-sol-yellow" },
    "general-purpose": { bg: "bg-sol-bg-alt/60", border: "border-sol-border/50", text: "text-sol-text-secondary" },
    "claude-code-guide": { bg: "bg-sol-violet/20", border: "border-sol-violet/50", text: "text-sol-violet" },
    "code-reviewer": { bg: "bg-sol-red/20", border: "border-sol-red/50", text: "text-sol-red" },
    "code-explorer": { bg: "bg-sol-cyan/20", border: "border-sol-cyan/50", text: "text-sol-cyan" },
    "code-architect": { bg: "bg-sol-magenta/20", border: "border-sol-magenta/50", text: "text-sol-magenta" },
    "code-simplifier": { bg: "bg-sol-cyan/20", border: "border-sol-cyan/50", text: "text-sol-cyan" },
  };

  const colors = subagentColors[subagentType] || { bg: "bg-sol-bg-alt/60", border: "border-sol-border/50", text: "text-sol-text-muted" };

  const spawnInfo = result?.content ? parseSpawnResult(result.content) : null;

  const resultSummary = result?.content && !spawnInfo
    ? result.content.length > 200 ? result.content.slice(0, 200) + "..." : result.content
    : null;

  if (isCompleted && spawnInfo) {
    return (
      <div className="my-0.5">
        <div
          className={`flex items-center gap-1.5 text-xs${resolvedChildId ? " cursor-pointer rounded px-1.5 py-1 -mx-1 hover:bg-sol-bg-highlight/50 transition-colors" : ""}`}
          onClick={resolvedChildId ? () => router.push(`/conversation/${resolvedChildId}`) : undefined}
        >
          <span className="text-emerald-400 text-[10px]">{"\u2713"}</span>
          <span className={`font-mono text-xs ${colors.text}`}>Task</span>
          <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${colors.bg} border ${colors.border} ${colors.text}`}>
            {subagentType}
          </span>
          {(spawnInfo.agentName || name) && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 font-mono">
              @{spawnInfo.agentName || name}
            </span>
          )}
          {description && <span className="text-sol-text-dim truncate flex-1">{description}</span>}
        </div>
      </div>
    );
  }

  if (isCompleted) {
    return (
      <div className={`my-3 rounded-lg ${result?.is_error ? "bg-sol-red/10 border-sol-red/30" : `${colors.bg} ${colors.border}`} border`}>
        <div
          className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-sol-bg-highlight/50 transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          <span className={`text-[10px] ${result?.is_error ? "text-sol-red" : "text-emerald-400"}`}>
            {result?.is_error ? "\u2717" : "\u2713"}
          </span>
          <span className={`font-mono text-xs font-medium ${result?.is_error ? "text-sol-red" : colors.text}`}>
            Task
          </span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors.bg} border ${colors.border} ${colors.text}`}>
            {subagentType}
          </span>
          {description && (
            <span className="text-sol-text-muted text-xs truncate flex-1">
              {description}
            </span>
          )}
          <span className="text-sol-text-dim text-[10px] ml-auto">
            {expanded ? "collapse" : "expand"}
          </span>
        </div>

        {expanded && (
          <>
            {prompt && (
              <div className="border-t border-sol-border/30 px-3 py-2">
                <div className="text-[10px] text-sol-text-dim mb-1">Prompt</div>
                <div className="text-sol-text-dim text-xs font-mono whitespace-pre-wrap break-words leading-relaxed max-h-40 overflow-y-auto">
                  {prompt}
                </div>
              </div>
            )}
            {result && (
              <div className="border-t border-sol-border/30 px-3 py-2">
                <div className="text-[10px] text-sol-text-dim mb-1">Result</div>
                <div className={`text-xs max-h-96 overflow-y-auto ${
                  result.is_error ? "text-sol-red font-mono whitespace-pre-wrap" : "text-sol-text-secondary prose prose-sm prose-invert max-w-none [&_pre]:bg-sol-bg/50 [&_pre]:border [&_pre]:border-sol-border/30 [&_pre]:rounded [&_pre]:text-[11px] [&_code]:text-[11px] [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-1"
                }`}>
                  {result.is_error ? safeString(result.content) : (
                    <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MD_COMPONENTS_CODE_LINK}>
                      {safeString(result.content)}
                    </ReactMarkdown>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {resolvedChildId && (
          <div className="border-t border-sol-border/30 px-2 py-1.5 flex justify-end">
            <span
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium cursor-pointer hover:brightness-125 transition ${colors.text} ${colors.bg} border ${colors.border}`}
              onClick={(e) => { e.stopPropagation(); router.push(`/conversation/${resolvedChildId}`); }}
            >
              open
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </span>
          </div>
        )}
      </div>
    );
  }

  const truncatedPrompt = prompt.length > 300 && !expanded ? prompt.slice(0, 300) + "..." : prompt;

  return (
    <div className={`my-3 rounded-lg ${colors.bg} border ${colors.border}`}>
      <div
        className="px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-sol-bg-highlight/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin ${colors.text} opacity-60`} />
        <span className={`font-mono text-xs font-semibold ${colors.text}`}>
          Task
        </span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors.bg} border ${colors.border} ${colors.text}`}>
          {subagentType}
        </span>
        {description && (
          <span className="text-sol-text-muted text-xs truncate flex-1">
            {description}
          </span>
        )}
        {model && (
          <span className="text-sol-text-dim text-[10px] font-mono">
            {formatModel(model)}
          </span>
        )}
        {name && (
          <span className="text-sol-text-dim text-[10px] font-mono">
            {name}
          </span>
        )}
        {runInBackground && (
          <span className="text-sol-text-dim text-[10px]">background</span>
        )}
        <span className="text-sol-text-dim text-[10px] ml-auto">
          {expanded ? "collapse" : "expand"}
        </span>
      </div>

      <div className="px-3 pb-2">
        <div className="text-sol-text-secondary text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
          {truncatedPrompt}
        </div>
        {prompt.length > 300 && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="text-[10px] text-sol-text-dim hover:text-sol-text-muted mt-1"
          >
            show more
          </button>
        )}
      </div>

      {resolvedChildId && (
        <div className="border-t border-sol-border/30 px-2 py-1.5 flex justify-end">
          <span
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium cursor-pointer hover:brightness-125 transition ${colors.text} ${colors.bg} border ${colors.border}`}
            onClick={(e) => { e.stopPropagation(); router.push(`/conversation/${resolvedChildId}`); }}
          >
            open
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </span>
        </div>
      )}
    </div>
  );
}

// ── Workflow tool (dynamic-workflow launcher) ───────────────────────────────
// The Workflow tool's result is a plain-text launch receipt ("Workflow launched in
// background. Task ID: … Run ID: wf_…"). Parse it plus the script's meta literal into
// the same card language as DynamicRunCard, and resolve the live run by its wf_ id so
// the card shows real status/progress instead of the raw blob.

function WorkflowToolBlock({ tool, result }: { tool: ToolCall; result?: ToolResult }) {
  const [expanded, setExpanded] = useState(false);

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const script = typeof parsedInput.script === "string" ? parsedInput.script : "";
  const scriptPath = typeof parsedInput.scriptPath === "string" ? parsedInput.scriptPath : "";
  const resumeFromRunId = typeof parsedInput.resumeFromRunId === "string" ? parsedInput.resumeFromRunId : "";
  const namedWorkflow = typeof parsedInput.name === "string" ? parsedInput.name : "";

  const meta = script ? parseWorkflowScriptMeta(script) : {};
  const isError = !!result?.is_error;
  const launch = result && !isError ? parseWorkflowLaunch(safeString(result.content)) : {};

  const scriptBase = (launch.scriptFile || scriptPath).split("/").pop() || "";
  const name = meta.name || namedWorkflow || scriptBase.replace(/(-wf_[\w-]+)?\.[cm]?js$/, "") || "workflow";
  const summary = meta.description || launch.summary || "";
  const externalRunId = launch.runId || resumeFromRunId;

  const run = useQuery(
    api.workflow_runs.getByExternalRunForUser,
    externalRunId ? { external_run_id: externalRunId } : "skip"
  );
  const sm = wfStatusMeta(run?.status);

  const frame = isError
    ? { border: "border-sol-red/30", bg: "bg-sol-red/10", divider: "border-sol-red/20" }
    : { border: "border-sol-cyan/25", bg: "bg-sol-cyan/[0.06]", divider: "border-sol-cyan/15" };

  return (
    <div className={`my-2 rounded-lg border ${frame.border} ${frame.bg} overflow-hidden`}>
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-sol-bg-highlight/40 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Workflow className={`w-3.5 h-3.5 flex-shrink-0 ${isError ? "text-sol-red" : "text-sol-cyan"}`} />
        <span className={`text-[10px] uppercase tracking-wider font-semibold ${isError ? "text-sol-red" : "text-sol-cyan"}`}>
          Workflow
        </span>
        <span className="text-xs text-sol-text-muted truncate">{name}</span>
        {resumeFromRunId && (
          <span className="px-1 py-0.5 rounded text-[10px] font-medium bg-sol-cyan/15 border border-sol-cyan/25 text-sol-cyan flex-shrink-0">
            resume
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          {run?.agent_count != null && <span className="text-[10px] text-sol-text-dim">{run.agent_count} agents</span>}
          {run?.total_tokens ? <span className="text-[10px] text-sol-text-dim/70">{wfFmtTokens(run.total_tokens)} tok</span> : null}
          {launch.taskId && <span className="text-[10px] text-sol-text-dim/70 font-mono">{launch.taskId}</span>}
          {isError ? (
            <span className="text-[10px] flex items-center gap-1 text-sol-red">{"✗"} failed</span>
          ) : run ? (
            <span className={`text-[10px] flex items-center gap-1 ${sm.cls}`}>
              {sm.dot ? <span className={`w-1.5 h-1.5 rounded-full ${sm.dot}`} /> : sm.icon}
              {run.status}
            </span>
          ) : result ? (
            <span className="text-[10px] flex items-center gap-1 text-sol-cyan/80">
              <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan/60" />
              launched
            </span>
          ) : (
            <span className="text-[10px] flex items-center gap-1 text-sol-text-dim">
              <span className="w-2.5 h-2.5 rounded-full border border-current border-t-transparent animate-spin text-sol-cyan opacity-60" />
              launching
            </span>
          )}
          <span className="text-sol-text-dim text-[10px]">{expanded ? "collapse" : "expand"}</span>
        </div>
      </div>

      {summary && (
        <div className="px-3 pb-2 -mt-0.5">
          <div className={`text-xs text-sol-text-dim ${expanded ? "" : "line-clamp-2"}`}>{summary}</div>
        </div>
      )}

      {/* Live agent tree only on expand — the daemon's anchor message (DynamicRunCard)
          already carries it inline, so the default state stays a compact receipt. */}
      {run && expanded && (
        <div className={`border-t ${frame.divider} px-3 py-2`}>
          <DynamicRunView run={run} compact />
        </div>
      )}

      {expanded && (
        <>
          {script && (
            <div className={`border-t ${frame.divider} px-3 py-2`}>
              <div className="text-[10px] text-sol-text-dim mb-1">Script</div>
              <div className="text-sol-text-secondary text-[11px] font-mono whitespace-pre-wrap break-words leading-relaxed max-h-80 overflow-y-auto">
                {script}
              </div>
            </div>
          )}
          {(launch.scriptFile || scriptPath) && (
            <div className={`border-t ${frame.divider} px-3 py-2`}>
              <div className="text-[10px] text-sol-text-dim mb-1">Script file</div>
              <div className="text-sol-text-dim text-[11px] font-mono break-all">{launch.scriptFile || scriptPath}</div>
            </div>
          )}
          {parsedInput.args !== undefined && (
            <div className={`border-t ${frame.divider} px-3 py-2`}>
              <div className="text-[10px] text-sol-text-dim mb-1">Args</div>
              <div className="text-sol-text-dim text-[11px] font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
                {JSON.stringify(parsedInput.args, null, 2)}
              </div>
            </div>
          )}
          {result && (
            <div className={`border-t ${frame.divider} px-3 py-2`}>
              <div className="text-[10px] text-sol-text-dim mb-1">{isError ? "Error" : "Result"}</div>
              <div className={`text-[11px] font-mono whitespace-pre-wrap break-words leading-relaxed max-h-60 overflow-y-auto ${isError ? "text-sol-red" : "text-sol-text-dim"}`}>
                {safeString(result.content)}
              </div>
            </div>
          )}
          <div className={`border-t ${frame.divider} px-3 py-1.5 flex justify-end`}>
            <Link
              href="/workflows"
              onClick={(e) => e.stopPropagation()}
              className="text-[10px] text-sol-cyan hover:underline underline-offset-2"
            >
              all workflows {"→"}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function getFileExtension(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    cpp: "cpp", c: "c", h: "c", hpp: "cpp", cs: "csharp",
    json: "json", yaml: "yaml", yml: "yaml", md: "markdown",
    html: "html", css: "css", scss: "scss", sql: "sql",
    sh: "bash", bash: "bash", zsh: "bash", swift: "swift", kt: "kotlin",
  };
  return ext ? langMap[ext] : undefined;
}

function isAlwaysVisibleToolCall(tc: ToolCall): boolean {
  // Monitor, background Bash, Workflow, and ScheduleWakeup stay visible in
  // condensed feeds: all are standing state the reader needs to know is armed
  // (a watch, a detached command, a running multi-agent fleet, a loop's next
  // fire), not a transient tool step.
  return isPlanWriteToolCall(tc) || isAskTool(tc.name) || tc.name === "Monitor" || tc.name === "monitor" || tc.name === "Workflow" || tc.name === "workflow" || tc.name === "ScheduleWakeup" || isBackgroundBashToolCall(tc);
}

interface ToolChangeRange {
  start: number;
  end: number;
}

interface ToolCallChangeSelection {
  index: number;
  range: ToolChangeRange;
}

// Shared footer action style for expanded blocks (code/markdown/plan): muted
// icon + small label, cyan on hover — mirrors the long-message footer.
function FooterIconButton({ onClick, title, label, children }: { onClick: (e: React.MouseEvent) => void; title: string; label?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-cyan transition-colors flex items-center gap-1"
      title={title}
    >
      {children}
      {label && <span className="hidden sm:inline text-xs text-sol-text-dim">{label}</span>}
    </button>
  );
}

function FullscreenIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
    </svg>
  );
}

const TOOL_COLOR_CLASS: Record<ToolColorToken, string> = {
  green: "text-sol-green/80",
  blue: "text-sol-blue/80",
  violet: "text-sol-violet/80",
  orange: "text-sol-orange/80",
  cyan: "text-sol-cyan/80",
  magenta: "text-sol-magenta/80",
  red: "text-sol-red/80",
  textDim: "text-sol-text-dim",
  emerald: "text-emerald-500/80",
  amber: "text-amber-500/80",
};

function toolColorClass(name: string): string {
  return TOOL_COLOR_CLASS[toolVisual(name).color];
}

function ToolBlock({ tool, result, changeIndex, changeRange, shareSelectionMode, messageId, conversationId, onStartShareSelection, onOpenComments, collapsed, timestamp, images, globalImageMap }: { tool: ToolCall; result?: ToolResult; changeIndex?: number; changeRange?: ToolChangeRange; shareSelectionMode?: boolean; messageId?: string; conversationId?: Id<"conversations">; onStartShareSelection?: (messageId: string) => void; onOpenComments?: () => void; collapsed?: boolean; timestamp?: number; images?: ImageData[]; globalImageMap?: Record<string, ImageData[]> }) {
  // opencode + pi name their built-in tools in lowercase (`edit`/`read`/`bash`/…);
  // gemini's glob matches too. Included alongside Claude's capitalized names and
  // codex's synonyms so every client's file/shell/search tools hit the same
  // specialized cards (DiffView, syntax read, bash styling) instead of the generic
  // fallback. Lowercase ids don't collide with claude/codex spellings.
  const isApplyPatch = tool.name === "apply_patch";
  const isStandardEdit = isEditTool(tool.name) || isWriteTool(tool.name);
  const isFileChange = tool.name === "fileChange";
  const isEdit = isStandardEdit || isApplyPatch || isFileChange;
  const [expanded, setExpanded] = useState(isEdit);
  const isRead = isReadTool(tool.name);
  const isBash = isShellTool(tool.name);
  const isGlob = isGlobTool(tool.name);
  const isGrep = isGrepTool(tool.name);
  const isCodeSearch = tool.name === "code_search" || tool.name === "code_analysis";
  // Workflow subagents return their typed result by CALLING StructuredOutput:
  // the input is the whole payload and the result is boilerplate, so rendering
  // inverts — show the input, hide the result unless it's a validation error.
  const isStructuredOutput = tool.name === "StructuredOutput";

  const { selectedChangeIndex, rangeStart, rangeEnd, selectChange, selectRange } = useDiffViewerStore();

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}
  const rawToolInput = tool.input || "";
  // A wrapper tool call (Codex `exec`, the extension's `browser_batch`) renders
  // as its inner steps: the row is named after the one step when there is one,
  // summarised by the steps otherwise, and expands to a per-step list.
  const nestedActions = useMemo(
    () => extractNestedActions(tool),
    [tool.name, rawToolInput],
  );
  const isCodexExec = tool.name === "exec";
  const isBrowserBatch = tool.name === BROWSER_BATCH_TOOL;
  const isNested = isCodexExec || isBrowserBatch;

  // claude uses file_path, codex uses path, opencode/pi use filePath (camelCase),
  // grok read_file uses target_file and list_dir uses target_directory.
  const filePath = toolPathFromInput(parsedInput);
  const relativePath = getRelativePath(filePath);
  // Enables inline line comments on the agent's edits (see DiffView). Scoped to a
  // live conversation; comments land in the shared review batch keyed by the
  // conversation and ride out on the user's next reply. Per-file anchor so a
  // multi-file patch keeps each file's comments separate.
  const lineCommentCtx = (path: string) =>
    conversationId ? { conversationId: String(conversationId), anchorKey: `diff:${tool.id}:${path}`, filePath: getRelativePath(path) } : undefined;
  const language = getFileExtension(filePath);
  const applyPatchInput = tool.name === "apply_patch" ? getApplyPatchInput(rawToolInput) : "";
  const applyPatchDiffs = useMemo(
    () => (tool.name === "apply_patch" ? parseApplyPatchSections(applyPatchInput) : []),
    [tool.name, applyPatchInput],
  );
  const fileChangePaths = useMemo(
    () => (tool.name === "fileChange" ? parseFileChangeSummary(String(parsedInput.changes || "")) : []),
    [tool.name, parsedInput.changes],
  );
  const fileChangeDiffs = useMemo(
    () => (tool.name === "fileChange" ? parseUnifiedDiffSections(result?.content || "", fileChangePaths) : []),
    [tool.name, result?.content, fileChangePaths],
  );
  // Empty while the call is still streaming in (partial JSON fails to parse).
  const structuredJson = useMemo(
    () => (isStructuredOutput && Object.keys(parsedInput).length > 0 ? JSON.stringify(parsedInput, null, 2) : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isStructuredOutput, rawToolInput],
  );

  // Markdown file detection
  const isMarkdown = isMarkdownFile(filePath);
  const content = isRead ? (result?.content || "") : String(parsedInput.content || "");
  const isPlan = isMarkdown && isPlanFile(filePath, content);
  const isPlanWrite = isWriteTool(tool.name) && filePath.includes('.claude/plans/');
  const [viewMode, setViewMode] = useState<'raw' | 'rendered'>(isMarkdown ? 'rendered' : 'raw');
  const [mdExpanded, setMdExpanded] = useState(false);
  const [mdFullscreen, setMdFullscreen] = useState(false);
  const [codeFullscreen, setCodeFullscreen] = useState(false);
  const fullWidth = useFullWidthExpand(`tool-${tool.id}`);
  const mdContainerRef = useRef<HTMLDivElement>(null);
  const [mdOverflowing, setMdOverflowing] = useState(false);
  const MD_COLLAPSED_HEIGHT = 600;

  useWatchEffect(() => {
    if (!mdContainerRef.current || mdExpanded || viewMode !== 'rendered') return;
    // Measure synchronously (layout is committed by effect time) — rAF never
    // fires in occluded/background tabs, which left the clamp + footer missing.
    // The rAF pass re-checks after fonts/images settle.
    const measure = () => {
      if (mdContainerRef.current) {
        setMdOverflowing(mdContainerRef.current.scrollHeight > MD_COLLAPSED_HEIGHT);
      }
    };
    measure();
    requestAnimationFrame(measure);
  }, [content, mdExpanded, viewMode, expanded]);

  useWatchEffect(() => {
    if (!mdFullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMdFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [mdFullscreen]);

  useWatchEffect(() => {
    if (!codeFullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCodeFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [codeFullscreen]);

  const getToolSummary = () => {
    if (isNested) {
      if (nestedActions.length === 1) {
        const inner = nestedActions[0];
        if (isShellTool(inner.name)) {
          let innerInput: Record<string, unknown> = {};
          try { innerInput = JSON.parse(inner.input); } catch {}
          const cmd = unwrapShellCommand(String(innerInput.command || innerInput.cmd || ""));
          if (cmd) return summarizeBashCommand(cmd);
        }
        return sharedToolSummary(inner);
      }
      return summarizeNestedActions(nestedActions);
    }
    if (isStandardEdit || isRead) return relativePath;
    if (isBash) {
      const cmd = unwrapShellCommand(String(parsedInput.command || parsedInput.cmd || ""));
      if (cmd) return summarizeBashCommand(cmd);
    }
    if (isGlob) return parsedInput.pattern ? String(parsedInput.pattern) : relativePath;
    if (isGrep && parsedInput.pattern) return String(parsedInput.pattern);
    if (isCodeSearch && parsedInput.query) return truncateStr(String(parsedInput.query), 40);
    if (isStructuredOutput) return structuredPayloadSummary(parsedInput) || null;

    if (tool.name === "apply_patch") {
      if (applyPatchDiffs.length > 0) {
        const firstPath = getRelativePath(applyPatchDiffs[0].filePath);
        return applyPatchDiffs.length > 1 ? `${firstPath} (+${applyPatchDiffs.length - 1})` : firstPath;
      }
      const fileMatch = applyPatchInput.match(/\*\*\* (?:Update|Add|Delete) File:\s+(.+)/);
      if (fileMatch) return getRelativePath(fileMatch[1].trim());
      return "Apply patch";
    }
    if (tool.name === "file_read" || tool.name === "file_write" || tool.name === "file_edit") {
      return getRelativePath(String(parsedInput.file_path || parsedInput.path || ""));
    }
    if (tool.name === "fileChange") {
      if (fileChangeDiffs.length > 0) {
        const firstPath = getRelativePath(fileChangeDiffs[0].filePath);
        return fileChangeDiffs.length > 1 ? `${firstPath} (+${fileChangeDiffs.length - 1})` : firstPath;
      }
      if (fileChangePaths.length > 0) {
        const rel = getRelativePath(fileChangePaths[0]);
        return fileChangePaths.length > 1 ? `${rel} (+${fileChangePaths.length - 1})` : rel;
      }
      return "File changes";
    }

    if (tool.name === "mcp__claude-in-chrome__computer") {
      const action = String(parsedInput.action || "");
      if (action === "screenshot") return "Screenshot";
      if (action === "left_click") {
        const coord = parsedInput.coordinate as number[] | undefined;
        return coord ? `Click (${coord[0]}, ${coord[1]})` : "Click";
      }
      if (action === "type") return `Type "${truncateStr(String(parsedInput.text || ""), 20)}"`;
      if (action === "key") return `Key: ${String(parsedInput.text || "")}`;
      if (action === "scroll") return `Scroll ${String(parsedInput.scroll_direction || "")}`;
      if (action === "wait") return `Wait ${String(parsedInput.duration || "")}s`;
      return action || "Browser";
    }
    if (tool.name === "mcp__claude-in-chrome__navigate") {
      const url = String(parsedInput.url || "");
      if (url === "back") return "Back";
      if (url === "forward") return "Forward";
      return url ? shortenUrl(url) : "Navigate";
    }
    if (tool.name === "mcp__claude-in-chrome__read_page") {
      if (parsedInput.ref_id) return `Element ${String(parsedInput.ref_id)}`;
      if (parsedInput.filter === "interactive") return "Interactive elements";
      return "Page content";
    }
    if (tool.name === "mcp__claude-in-chrome__find") {
      return parsedInput.query ? `"${truncateStr(String(parsedInput.query), 30)}"` : "Find";
    }
    if (tool.name === "mcp__claude-in-chrome__form_input") {
      const ref = parsedInput.ref ? String(parsedInput.ref) : "";
      const val = parsedInput.value;
      if (ref && val !== undefined) return `${ref} = "${truncateStr(String(val), 20)}"`;
      return "Set form";
    }
    if (tool.name === "mcp__claude-in-chrome__javascript_tool") {
      return parsedInput.text ? truncateStr(String(parsedInput.text), 40) : "Execute JS";
    }
    if (tool.name === "mcp__claude-in-chrome__tabs_context_mcp") return "Get tabs";
    if (tool.name === "mcp__claude-in-chrome__tabs_create_mcp") return "Create tab";
    if (tool.name === "mcp__claude-in-chrome__update_plan") {
      const domains = parsedInput.domains as string[] | undefined;
      if (Array.isArray(domains) && domains.length) {
        return domains.slice(0, 2).join(", ") + (domains.length > 2 ? "..." : "");
      }
      return "Plan";
    }
    if (tool.name === "mcp__claude-in-chrome__gif_creator") return String(parsedInput.action || "Record");
    if (tool.name === "mcp__claude-in-chrome__read_console_messages") {
      return parsedInput.pattern ? `Filter: ${String(parsedInput.pattern)}` : "Console";
    }
    if (tool.name === "mcp__claude-in-chrome__read_network_requests") {
      return parsedInput.urlPattern ? `Filter: ${String(parsedInput.urlPattern)}` : "Network";
    }
    if (tool.name === "mcp__claude-in-chrome__get_page_text") return "Extract text";
    if (tool.name === "mcp__claude-in-chrome__upload_image") return parsedInput.filename ? String(parsedInput.filename) : "Upload";
    if (tool.name === "mcp__claude-in-chrome__resize_window") return parsedInput.width && parsedInput.height ? `${parsedInput.width}x${parsedInput.height}` : "Resize";
    if (tool.name === "mcp__claude-in-chrome__shortcuts_list") return "List shortcuts";
    if (tool.name === "mcp__claude-in-chrome__shortcuts_execute") return parsedInput.command ? `/${String(parsedInput.command)}` : "Shortcut";

    if (tool.name === "TaskCreate") return parsedInput.subject ? truncateStr(String(parsedInput.subject), 50) : "New task";
    if (tool.name === "TaskUpdate") {
      const id = parsedInput.taskId ? `#${parsedInput.taskId}` : "";
      const status = parsedInput.status ? String(parsedInput.status) : "";
      if (id && status) return `${id} \u2192 ${status}`;
      return id || "Update task";
    }
    if (tool.name === "TaskList") {
      if (result) {
        const lines = result.content.split("\n").filter((l: string) => l.match(/#\d+\s+\[/));
        if (lines.length > 0) return `${lines.length} tasks`;
      }
      return "Tasks";
    }
    if (tool.name === "TaskGet") return parsedInput.taskId ? `#${parsedInput.taskId}` : "Get task";
    if (tool.name === "TeamCreate") return parsedInput.team_name ? String(parsedInput.team_name) : "New team";
    if (tool.name === "TeamDelete") return "Cleanup";
    if (tool.name === "SendMessage") {
      if (parsedInput.summary) return truncateStr(String(parsedInput.summary), 40);
      if (parsedInput.recipient) return `to ${String(parsedInput.recipient)}`;
      if (parsedInput.type === "broadcast") return "broadcast";
      return "Message";
    }

    if (tool.name === "WebSearch" || tool.name === "web_search") return parsedInput.query ? truncateStr(String(parsedInput.query), 40) : "Search";
    if (tool.name === "WebFetch" || tool.name === "web_fetch") return parsedInput.url ? shortenUrl(String(parsedInput.url)) : "Fetch";
    if (tool.name === "NotebookEdit") return parsedInput.notebook_path ? getRelativePath(String(parsedInput.notebook_path)) : "Notebook";
    if (tool.name === "Skill") return parsedInput.skill ? `/${String(parsedInput.skill)}` : "Skill";
    if (tool.name === "EnterPlanMode" || tool.name === "enter_plan_mode") return "Plan mode";
    if (tool.name === "ExitPlanMode" || tool.name === "exit_plan_mode") return "Exit plan";
    if (tool.name === "TaskOutput") return parsedInput.task_id ? `task ${String(parsedInput.task_id).slice(0, 8)}` : "Output";
    if (tool.name === "TaskStop") return parsedInput.task_id ? `stop ${String(parsedInput.task_id).slice(0, 8)}` : "Stop";
    if (isTodoTool(tool.name)) {
      const todos = parsedInput.todos as any[];
      return `${todos?.length || 0} tasks`;
    }
    if (isAskTool(tool.name)) {
      const questions = parsedInput.questions as any[];
      return questions?.[0]?.question ? truncateStr(String(questions[0].question), 50) : "Question";
    }

    if (tool.name.startsWith("mcp__")) {
      const parts = tool.name.split("__");
      const method = parts[2] || "";
      const displayMethod = method.replace(/_/g, " ");
      if (parsedInput.url) return shortenUrl(String(parsedInput.url));
      if (parsedInput.query) return truncateStr(String(parsedInput.query), 30);
      return displayMethod || parts[1] || "MCP";
    }

    return null;
  };

  const getResultSummary = () => {
    if (!result) return null;
    if (result.is_error) return "(error)";
    if (isEdit) {
      const match = result.content.match(/with (\d+) additions? and (\d+) removals?/);
      if (match) return `(+${match[1]} -${match[2]})`;
      return result.content.includes("has been updated") ? "(ok)" : "";
    }
    if (isRead) {
      const lines = result.content.split("\n").length;
      return `(${lines} lines)`;
    }
    if (isGlob || isGrep || isCodeSearch) {
      const lines = result.content.trim().split("\n").filter(l => l.trim()).length;
      return `(${lines} matches)`;
    }
    if (isBash && result.content) {
      const lines = result.content.trim().split("\n").length;
      if (lines > 1) return `(${lines} lines)`;
    }
    if (tool.name === "TaskList") {
      const taskLines = result.content.split("\n").filter((l: string) => l.match(/#\d+\s+\[/));
      if (taskLines.length > 0) return `(${taskLines.length} tasks)`;
    }
    return null;
  };

  const summary = getToolSummary();
  const resultSummary = getResultSummary();
  const displayToolName = isNested && nestedActions.length === 1
    ? formatToolName(nestedActions[0].name)
    : formatToolName(tool.name);

  const executedTabId = useMemo(() => {
    if (!tool.name.startsWith("mcp__claude-in-chrome__")) return null;
    const tabId = parsedInput.tabId;
    if (tabId != null) return String(tabId);
    if (result?.content) {
      const tabIdMatch = result.content.match(/Executed on tabId:\s*(\d+)/);
      if (tabIdMatch) return tabIdMatch[1];
    }
    return null;
  }, [parsedInput.tabId, result?.content, tool.name]);

  // Process result content - strip line numbers for Read tool, strip Tab Context from MCP chrome results
  const rawResultContent = result ? safeString(result.content) : "";
  const processedContent = result ? (isRead ? stripLineNumbers(rawResultContent) : tool.name.startsWith("mcp__claude-in-chrome__") ? rawResultContent.replace(/\n?\n?Tab Context:[\s\S]*$/, "").trim() : rawResultContent) : "";

  const isCodeTool = isBash || isEdit || isRead || isGlob || isGrep || isCodeSearch;
  const isMarkdownResult = result && !isCodeTool && typeof processedContent === 'string' && (
    processedContent.includes('###') || processedContent.includes('**') || processedContent.includes('```')
  );

  // Extract starting line number from Edit result (format: "   42→content")
  const getStartLine = () => {
    if (isRead) {
      const offset = parsedInput.offset;
      if (offset && typeof offset === 'number') return offset;
      if (result?.content) {
        const match = result.content.match(/^\s*(\d+)\t/m);
        if (match) return parseInt(match[1], 10);
      }
      return 1;
    }
    if (!isStandardEdit || !result) return 1;
    const match = result.content.match(/^\s*(\d+)→/m);
    return match ? parseInt(match[1], 10) : 1;
  };
  const startLine = getStartLine();

  const toolColor = toolColorClass(tool.name);

  const targetStart = changeRange?.start ?? changeIndex;
  const targetEnd = changeRange?.end ?? changeIndex;
  const hasTargetRange = targetStart !== undefined && targetEnd !== undefined;
  const isClickable = isEdit && hasTargetRange;
  const isSelected = isClickable && (
    (selectedChangeIndex !== null &&
      targetStart !== undefined &&
      targetEnd !== undefined &&
      selectedChangeIndex >= targetStart &&
      selectedChangeIndex <= targetEnd) ||
    (rangeStart !== null &&
      rangeEnd !== null &&
      targetStart !== undefined &&
      targetEnd !== undefined &&
      Math.max(rangeStart, targetStart) <= Math.min(rangeEnd, targetEnd))
  );

  const handleClick = (e: React.MouseEvent) => {
    if (shareSelectionMode) {
      return;
    }
    if (isClickable && targetStart !== undefined && targetEnd !== undefined) {
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey) {
        if (selectedChangeIndex !== null) {
          selectRange(selectedChangeIndex, targetEnd);
        } else {
          selectRange(targetStart, targetEnd);
        }
      } else {
        if (targetStart !== targetEnd) {
          selectRange(targetStart, targetEnd);
        } else {
          selectChange(targetStart);
        }
      }
    } else {
      setExpanded(!expanded);
    }
  };

  if (isPlanWrite && content) {
    return <PlanBlock content={content} timestamp={timestamp || Date.now()} collapsed={collapsed} messageId={messageId} conversationId={conversationId} onOpenComments={onOpenComments} onStartShareSelection={onStartShareSelection} />;
  }

  const isCodecastImageRead = isRead && /codecast\/images\//.test(filePath);
  if (isCodecastImageRead) {
    return (
      <div className="my-0.5 flex items-center gap-1.5 text-xs">
        <svg className="w-3.5 h-3.5 text-sol-blue/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.64 0 8.577 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.64 0-8.577-3.007-9.963-7.178z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span className="text-sol-text-dim italic">Viewing your image</span>
      </div>
    );
  }

  return (
    <div className="my-0.5">
      <div
        className={`flex items-center gap-1.5 group text-xs ${
          isClickable
            ? 'cursor-pointer hover:bg-sol-bg-highlight/30 rounded px-1 -mx-1 transition-colors'
            : 'cursor-pointer'
        } ${
          isSelected
            ? 'bg-sol-blue/10 border border-sol-blue/30 rounded px-1 -mx-1'
            : ''
        }`}
        onClick={handleClick}
      >
        <span className={`font-mono flex-shrink-0 group-hover:underline ${toolColor}`}>{displayToolName}</span>
        {summary && (
          <span className="text-sol-text-muted font-mono truncate min-w-0">
            {(isStandardEdit || isRead) && filePath ? (
              // The file a Read/Edit touched, linked into Files. Stop the click
              // so it opens the file rather than toggling the row.
              <FilePathLink path={filePath} onClick={(e) => e.stopPropagation()}>{summary}</FilePathLink>
            ) : summary}
          </span>
        )}
        {executedTabId && (
          <a
            href={`https://clau.de/chrome/tab/${executedTabId}`}
            target="_blank"
            rel="noopener noreferrer"
            className={BROWSER_ROW_PILL}
            onClick={(e) => e.stopPropagation()}
            title={`View tab ${executedTabId}`}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            <span>open tab</span>
          </a>
        )}
        {resultSummary && (
          <span className={`font-mono flex-shrink-0 whitespace-nowrap ${result?.is_error ? "text-sol-red/80" : "text-sol-text-dim"}`}>
            {resultSummary}
          </span>
        )}
      </div>

      {(() => {
        // A command can hand back several images at once (`cast browser shot
        // --viewports`); side by side they read as the comparison they are,
        // stacked they read as a sequence. Each keeps its own lightbox click.
        let toolImages = images?.filter(img => img.tool_use_id === tool.id) ?? [];
        if (!toolImages.length) toolImages = globalImageMap?.[tool.id] ?? [];
        if (!toolImages.length) return null;
        if (toolImages.length === 1) return <ImageBlock image={toolImages[0]} />;
        return (
          <div className="flex gap-2 items-start">
            {toolImages.map((img, i) => (
              <div key={i} className="flex-1 min-w-0 max-w-md">
                <ImageBlock image={img} />
              </div>
            ))}
          </div>
        );
      })()}

      {expanded && (
        <div
          ref={fullWidth.containerRef}
          style={fullWidth.style}
          className="mt-1 rounded border border-sol-border/30 bg-sol-bg-inset transition-all duration-200"
        >
          {/* Markdown toggle header */}
          {isMarkdown && (isRead || (isWriteTool(tool.name) && Boolean(parsedInput.content))) && (
            <div className="flex items-center justify-between px-2 py-1 border-b border-sol-border/20 bg-sol-bg-highlight/30">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-sol-text-dim">{language}</span>
                {isPlan && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-sol-bg-highlight text-sol-text-muted font-medium">
                    PLAN
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 text-[10px]">
                <button
                  onClick={(e) => { e.stopPropagation(); setViewMode('raw'); }}
                  className={`px-1.5 py-0.5 rounded transition-colors ${
                    viewMode === 'raw'
                      ? 'bg-sol-bg-highlight text-sol-text'
                      : 'text-sol-text-dim hover:text-sol-text-muted'
                  }`}
                >
                  Raw
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setViewMode('rendered'); }}
                  className={`px-1.5 py-0.5 rounded transition-colors ${
                    viewMode === 'rendered'
                      ? 'bg-sol-bg-highlight text-sol-text'
                      : 'text-sol-text-dim hover:text-sol-text-muted'
                  }`}
                >
                  Rendered
                </button>
              </div>
            </div>
          )}
          {isNested ? (
            <div className="max-h-80 overflow-auto">
              {nestedActions.length > 0 ? (
                <NestedStepList
                  steps={nestedActions.map((action) => ({ label: formatToolName(action.name), summary: sharedToolSummary(action) }))}
                  outcomes={isBrowserBatch ? splitBrowserBatchResult(rawResultContent, nestedActions.length) : undefined}
                  labelClass="text-sol-cyan/80"
                />
              ) : (
                <pre className="border-b border-sol-border/20 bg-sol-bg-highlight/20 p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-sol-text-muted">
                  {String(parsedInput.input || parsedInput.code || parsedInput.script || "Codex action")}
                </pre>
              )}
              {/* A batch's result is already spread across its steps; only the
                  Codex program keeps its result as one block underneath. */}
              {isBrowserBatch && nestedActions.length > 0 ? (
                !result && <div className="p-2 text-xs text-sol-text-dim">Running</div>
              ) : processedContent && processedContent.trim() ? (
                <pre className={`p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap ${result?.is_error ? "text-sol-red" : "text-sol-text-secondary"}`}>
                  {renderAnsi(processedContent)}
                </pre>
              ) : (
                <div className="p-2 text-xs text-sol-text-dim">No output</div>
              )}
            </div>
          ) : isEdit && !!parsedInput.old_string && !!parsedInput.new_string ? (
            <DiffView
              oldStr={String(parsedInput.old_string)}
              newStr={String(parsedInput.new_string)}
              startLine={startLine}
              language={language}
              commentContext={lineCommentCtx(filePath)}
            />
          ) : isWriteTool(tool.name) && !!parsedInput.content ? (
            isMarkdown && viewMode === 'rendered' ? (
              <>
                <div
                  ref={mdContainerRef}
                  className="relative p-3"
                  style={!mdExpanded && mdOverflowing ? { maxHeight: MD_COLLAPSED_HEIGHT, overflowY: 'hidden' } : undefined}
                >
                  <MarkdownRenderer content={String(parsedInput.content)} filePath={filePath} />
                  {!mdExpanded && mdOverflowing && (
                    <div className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none bg-gradient-to-b from-transparent to-[var(--sol-bg-inset)]" />
                  )}
                </div>
                {(mdOverflowing || mdExpanded) && (
                  <div className="flex items-center gap-1 px-2 py-1 border-t border-sol-border/20">
                    <FooterIconButton
                      onClick={(e) => { e.stopPropagation(); setMdFullscreen(true); }}
                      title="Fullscreen"
                      label="Full Screen"
                    >
                      <FullscreenIcon />
                    </FooterIconButton>
                    <FooterIconButton
                      onClick={(e) => { e.stopPropagation(); setMdExpanded(v => !v); }}
                      title={mdExpanded ? "Collapse" : "Expand"}
                    >
                      {mdExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </FooterIconButton>
                  </div>
                )}
                {mdFullscreen && createPortal(
                  <div className="fixed inset-0 z-[10001] bg-sol-bg overflow-auto" onClick={() => setMdFullscreen(false)}>
                    <div className="conv-col mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-between mb-6">
                        <span className="text-sol-text-secondary text-sm font-medium">{filePath.split('/').pop()}</span>
                        <button
                          onClick={() => setMdFullscreen(false)}
                          className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                          title="Close (Esc)"
                        >
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                      <MarkdownRenderer content={String(parsedInput.content)} filePath={filePath} />
                    </div>
                  </div>,
                  document.body
                )}
              </>
            ) : (
              <DiffView
                oldStr=""
                newStr={String(parsedInput.content)}
                startLine={1}
                language={language}
                commentContext={lineCommentCtx(filePath)}
              />
            )
          ) : tool.name === "apply_patch" || tool.name === "fileChange" ? (
            (tool.name === "apply_patch" ? applyPatchDiffs : fileChangeDiffs).length > 0 ? (
              <div className="max-h-80 overflow-auto">
                {(tool.name === "apply_patch" ? applyPatchDiffs : fileChangeDiffs).map((diff, idx) => {
                  const diffLanguage = getFileExtension(diff.filePath);
                  const diffStartLine = diff.hunks[0]?.oldStart || diff.hunks[0]?.newStart || 1;
                  return (
                    <div key={`${diff.filePath}-${idx}`} className={idx > 0 ? "border-t border-sol-border/20" : ""}>
                      <div className="px-2 py-1 border-b border-sol-border/20 bg-sol-bg-highlight/20">
                        <span className="text-xs font-mono text-sol-text-dim truncate">{getRelativePath(diff.filePath)}</span>
                      </div>
                      <DiffView
                        oldStr={diff.oldContent}
                        newStr={diff.newContent}
                        startLine={diffStartLine}
                        language={diffLanguage}
                        commentContext={lineCommentCtx(diff.filePath)}
                      />
                    </div>
                  );
                })}
              </div>
            ) : tool.name === "apply_patch" && applyPatchInput.trim() ? (
              <div className="max-h-80 overflow-auto">
                <pre className="p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-sol-text-secondary">
                  {applyPatchInput}
                </pre>
              </div>
            ) : tool.name === "fileChange" && processedContent && processedContent.trim() ? (
              <div className="max-h-80 overflow-auto">
                <pre className="p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-sol-text-secondary">
                  {processedContent}
                </pre>
              </div>
            ) : (
              <div className="p-2 text-xs text-sol-text-dim">
                {tool.name === "fileChange" ? "Patch diff unavailable" : "Patch input unavailable"}
              </div>
            )
          ) : isBash && (parsedInput.command || parsedInput.cmd) ? (
            <div className="max-h-80 overflow-auto">
              <div className="px-1.5 sm:px-2 py-1 sm:py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
                <pre className="text-[11px] sm:text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
                  $ {unwrapShellCommand(String(parsedInput.command || parsedInput.cmd || ""))}
                </pre>
              </div>
              {processedContent && processedContent.trim() ? (
                <pre className={`p-1.5 sm:p-2 text-[11px] sm:text-xs font-mono overflow-x-auto whitespace-pre-wrap ${result?.is_error ? "text-sol-red" : "text-sol-text-secondary"}`}>
                  {renderAnsi(processedContent)}
                </pre>
              ) : (
                <div className="p-2 text-xs text-sol-text-dim">No output</div>
              )}
            </div>
          ) : isRead && language && processedContent && processedContent.trim() ? (
            <>
              <DiffView
                oldStr={processedContent}
                newStr={processedContent}
                startLine={startLine}
                language={language}
                showLineNumbers
                commentContext={lineCommentCtx(filePath)}
              />
              <div className="flex items-center gap-1 px-2 py-1 border-t border-sol-border/20">
                <FooterIconButton
                  onClick={(e) => { e.stopPropagation(); setCodeFullscreen(true); }}
                  title="Fullscreen"
                  label="Full Screen"
                >
                  <FullscreenIcon />
                </FooterIconButton>
                <FooterIconButton
                  onClick={(e) => { e.stopPropagation(); fullWidth.toggle(); }}
                  title={fullWidth.expanded ? "Normal width" : "Full width"}
                  label={fullWidth.expanded ? "Normal Width" : "Full Width"}
                >
                  <MoveHorizontal className="w-4 h-4" />
                </FooterIconButton>
                <FooterIconButton
                  onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
                  title="Collapse"
                >
                  <ChevronUp className="w-4 h-4" />
                </FooterIconButton>
              </div>
              {codeFullscreen && createPortal(
                <div className="fixed inset-0 z-[10001] bg-sol-bg overflow-auto" onClick={() => setCodeFullscreen(false)}>
                  <div className="max-w-6xl mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-sol-text-secondary text-sm font-mono">{relativePath}</span>
                      <button
                        onClick={() => setCodeFullscreen(false)}
                        className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                        title="Close (Esc)"
                      >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    <div className="rounded border border-sol-border/30 bg-sol-bg-inset">
                      <DiffView
                        oldStr={processedContent}
                        newStr={processedContent}
                        startLine={startLine}
                        maxLines={99999}
                        language={language}
                        showLineNumbers
                      />
                    </div>
                  </div>
                </div>,
                document.body
              )}
            </>
          ) : isStructuredOutput ? (
            <div className="max-h-80 overflow-auto">
              {structuredJson ? (
                <DiffView oldStr={structuredJson} newStr={structuredJson} language="json" />
              ) : rawToolInput ? (
                <pre className="p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-sol-text-secondary">{rawToolInput}</pre>
              ) : (
                <div className="p-2 text-xs text-sol-text-dim">No output</div>
              )}
              {result?.is_error && processedContent && (
                <pre className="p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap text-sol-red border-t border-sol-border/20">
                  {renderAnsi(processedContent)}
                </pre>
              )}
            </div>
          ) : processedContent && processedContent.trim() ? (
            <div className="max-h-80 overflow-auto">
              {isMarkdown && viewMode === 'rendered' ? (
                <div className="p-3">
                  <MarkdownRenderer content={processedContent} filePath={filePath} />
                </div>
              ) : isMarkdownResult ? (
                <div className="p-2 prose prose-invert prose-sm max-w-none text-xs">
                  <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={MD_COMPONENTS_NO_PRE}>{processedContent}</ReactMarkdown>
                </div>
              ) : (
                <>
                  {!isMarkdown && language && (
                    <div className="text-[10px] px-2 py-1 border-b border-sol-border/20 text-sol-text-dim">
                      {language}
                    </div>
                  )}
                  <pre className={`p-2 text-xs font-mono overflow-x-auto whitespace-pre-wrap ${result?.is_error ? "text-sol-red" : "text-sol-text-secondary"}`}>
                    {renderAnsi(processedContent)}
                  </pre>
                </>
              )}
            </div>
          ) : (
            <div className="p-2 text-xs text-sol-text-dim">No output</div>
          )}
        </div>
      )}
    </div>
  );
}

function TodoWriteBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: { todos?: Array<{ content: string; status: string; activeForm?: string }> } = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const todos = parsedInput.todos || [];
  if (todos.length === 0) return null;

  const completed = todos.filter(t => t.status === 'completed').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;

  return (
    <div className="my-2">
      <div className="flex items-center gap-2 py-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-pink-500 flex-shrink-0" />
        <span className="font-mono text-sm font-medium text-pink-600 dark:text-sol-magenta">
          {formatToolName(tool.name)}
        </span>
        <span className="text-sol-text-dim text-sm font-mono">
          {completed}/{todos.length} done
          {inProgress > 0 && `, ${inProgress} in progress`}
        </span>
      </div>
      <div className="ml-3.5 mt-1 space-y-0.5">
        {todos.map((todo, i) => (
          <div key={i} className="flex items-start gap-2 text-sm">
            {todo.status === 'completed' ? (
              <svg className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : todo.status === 'in_progress' ? (
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <circle cx="12" cy="12" r="9" strokeWidth={2} />
              </svg>
            )}
            <span className={`${
              todo.status === 'completed' ? 'text-sol-text-dim line-through' :
              todo.status === 'in_progress' ? 'text-sol-text-secondary' :
              'text-sol-text-muted'
            }`}>
              {todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskListBlock({ tool, result, taskRecordMap }: { tool: ToolCall; result?: ToolResult; taskRecordMap?: TaskRecordMaps }) {
  const router = useRouter();
  if (!result) return null;
  const lines = result.content.split("\n");
  const items: Array<{ id: string; status: string; subject: string; owner?: string; blockedBy?: string[] }> = [];
  for (const line of lines) {
    const match = line.match(/#(\d+)\s+\[(\w+)]\s+(.+?)(?:\s+\(([^)]+)\))?(?:\s+\[blocked by ([^\]]+)])?$/);
    if (match) {
      items.push({
        id: match[1], status: match[2], subject: match[3].trim(),
        owner: match[4]?.trim(),
        blockedBy: match[5]?.split(",").map(s => s.trim().replace("#", "")),
      });
    }
  }
  if (items.length === 0) return null;

  const completed = items.filter(t => t.status === "completed").length;
  const inProgress = items.filter(t => t.status === "in_progress").length;

  return (
    <div className="my-2">
      <div className="flex items-center gap-2 py-0.5">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
        <span className="font-mono text-sm font-medium text-emerald-600 dark:text-emerald-400">TaskList</span>
        <span className="text-sol-text-dim text-sm font-mono">
          {completed}/{items.length} done{inProgress > 0 && `, ${inProgress} active`}
        </span>
      </div>
      <div className="ml-3.5 mt-1 space-y-0.5">
        {items.map(task => {
          const isBlocked = task.blockedBy && task.blockedBy.length > 0;
          const matched = taskRecordMap?.byTitle[task.subject] || taskRecordMap?.byLocalId[task.id];
          const clickable = !!matched;
          return (
            <div
              key={task.id}
              className={`flex items-start gap-2 text-sm ${isBlocked ? "opacity-50" : ""}${clickable ? " cursor-pointer rounded px-1.5 py-0.5 -mx-1 hover:bg-sol-bg-highlight/50 transition-colors" : ""}`}
              onClick={clickable ? () => router.push(`/tasks/${matched._id}`) : undefined}
            >
              {task.status === "completed" ? (
                <svg className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : task.status === "in_progress" ? (
                <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : isBlocked ? (
                <svg className="w-4 h-4 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-sol-text-dim flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <circle cx="12" cy="12" r="9" strokeWidth={2} />
                </svg>
              )}
              <span className="text-sol-text-dim text-xs font-mono mt-0.5">#{task.id}</span>
              <span className={
                task.status === "completed" ? "text-sol-text-dim line-through" :
                task.status === "in_progress" ? "text-sol-text-secondary" :
                "text-sol-text-muted"
              }>
                {task.subject}
              </span>
              {task.owner && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 font-mono">
                  @{task.owner}
                </span>
              )}
              {isBlocked && (
                <span className="text-[10px] text-sol-text-dim mt-0.5">
                  blocked by {task.blockedBy!.map(id => `#${id}`).join(", ")}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type TaskRecord = { _id: string; short_id: string; title: string; status: string };
type TaskRecordMaps = { byTitle: Record<string, TaskRecord>; byLocalId: Record<string, TaskRecord> };

function TaskCreateUpdateBlock({ tool, result, taskSubjectMap, taskRecordMap }: { tool: ToolCall; result?: ToolResult; taskSubjectMap?: Record<string, string>; taskRecordMap?: TaskRecordMaps }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}
  const router = useRouter();

  const isCreate = tool.name === "TaskCreate";
  const subject = parsedInput.subject;
  const taskId = parsedInput.taskId;
  const status = parsedInput.status;
  const owner = parsedInput.owner;
  const activeForm = parsedInput.activeForm;

  let resultId = "";
  if (result) {
    const idMatch = result.content.match(/Task #(\d+)/);
    if (idMatch) resultId = idMatch[1];
  }

  const resolvedSubject = subject || (taskId && taskSubjectMap?.[taskId]);
  const matchedTask = resolvedSubject
    ? taskRecordMap?.byTitle[String(resolvedSubject)]
    : taskId
    ? taskRecordMap?.byLocalId[String(taskId)]
    : undefined;
  const isClickable = !!matchedTask;

  const handleClick = () => {
    if (matchedTask) router.push(`/tasks/${matchedTask._id}`);
  };

  const displaySubject = resolvedSubject || matchedTask?.title;

  if (!isCreate && displaySubject) {
    return (
      <div className="my-0.5">
        <div
          className={`flex items-center gap-1.5 text-xs${isClickable ? " cursor-pointer rounded px-1.5 py-0.5 -mx-1 hover:bg-sol-bg-highlight/50 transition-colors" : ""}`}
          onClick={isClickable ? handleClick : undefined}
        >
          <span className="text-sol-text-muted">{String(displaySubject).slice(0, 60)}</span>
          {status && (
            <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${
              status === "completed" ? "bg-emerald-500/15 text-emerald-400" :
              status === "in_progress" ? "bg-amber-500/15 text-amber-400" :
              status === "deleted" ? "bg-red-500/15 text-red-400" :
              "bg-gray-500/15 text-gray-400"
            }`}>
              {status}
            </span>
          )}
          {owner && <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 font-mono">@{owner}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="my-0.5">
      <div
        className={`flex items-center gap-1.5 text-xs${isClickable ? " cursor-pointer rounded px-1.5 py-0.5 -mx-1 hover:bg-sol-bg-highlight/50 transition-colors" : ""}`}
        onClick={isClickable ? handleClick : undefined}
      >
        <span className="font-mono text-emerald-500/80">{tool.name}</span>
        {isCreate ? (
          <>
            {resultId && <span className="text-sol-text-dim font-mono">#{resultId}</span>}
            {subject && <span className="text-sol-text-muted">{String(subject).slice(0, 60)}</span>}
            {activeForm && <span className="text-sol-text-dim italic">({activeForm})</span>}
          </>
        ) : (
          <>
            {taskId && <span className="text-sol-text-dim font-mono">#{taskId}</span>}
            {status && (
              <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${
                status === "completed" ? "bg-emerald-500/15 text-emerald-400" :
                status === "in_progress" ? "bg-amber-500/15 text-amber-400" :
                status === "deleted" ? "bg-red-500/15 text-red-400" :
                "bg-gray-500/15 text-gray-400"
              }`}>
                {status}
              </span>
            )}
            {owner && <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/20 font-mono">@{owner}</span>}
          </>
        )}
      </div>
    </div>
  );
}

const CAST_STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  draft: { bg: "bg-gray-500/10", text: "text-gray-400" },
  open: { bg: "bg-sol-blue/10", text: "text-sol-blue" },
  backlog: { bg: "bg-gray-500/10", text: "text-gray-400" },
  in_progress: { bg: "bg-sol-yellow/10", text: "text-sol-yellow" },
  in_review: { bg: "bg-sol-violet/10", text: "text-sol-violet" },
  done: { bg: "bg-emerald-500/10", text: "text-emerald-400" },
  dropped: { bg: "bg-gray-500/10", text: "text-gray-400" },
  active: { bg: "bg-emerald-500/10", text: "text-emerald-400" },
  paused: { bg: "bg-gray-500/10", text: "text-gray-400" },
  abandoned: { bg: "bg-red-500/10", text: "text-red-400" },
};

function DocTitleLink({ convexId }: { convexId: string }) {
  const router = useRouter();
  // Local-first seed (same pattern as EntityIdPill): the store usually holds
  // the doc row already — paint the title on the first frame instead of
  // flashing a truncated raw id. Non-reactive read; the query keeps it fresh.
  const seed = useMemo(() => findEntityInStore(useInboxStore.getState(), "doc", convexId), [convexId]);
  const queryDoc = useQuery(api.docs.webGet, { id: convexId });
  const doc = queryDoc ?? seed;
  if (!doc) return <span className="text-sol-text-dim font-mono">{convexId.slice(0, 12)}...</span>;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); router.push(`/docs/${doc._id}`); }}
      className="text-sol-blue hover:underline truncate max-w-[250px] text-left"
    >
      {(doc as any).display_title || doc.title}
    </button>
  );
}

// Resolved title of a task/plan, rendered inline after its id pill in a cast
// command row. `struck` crosses it out — a `task done` row reads as the task
// being checked off. Enrichment only: the row is honest without it, so the
// queries go through useQueryNoThrow and an unresolved title renders nothing.
function InlineEntityTitle({ shortId, struck }: { shortId: string; struck?: boolean }) {
  const isPlan = shortId.startsWith("pl-");
  // Local-first seed: paint the resolved title on the first frame when the
  // store already holds the row (it usually does — same rule as EntityIdPill).
  const seed = useMemo(
    () => findEntityInStore(useInboxStore.getState(), isPlan ? "plan" : "task", shortId),
    [isPlan, shortId],
  );
  const { data: task } = useQueryNoThrow(api.tasks.webGet, !isPlan ? { short_id: shortId } : "skip");
  const { data: plan } = useQueryNoThrow(api.plans.webGet, isPlan ? { short_id: shortId } : "skip");
  const entity: any = (isPlan ? plan : task) ?? seed;
  const title = entity?.display_title || entity?.title;
  if (!title) return null;
  return (
    <span className={`truncate max-w-[280px] ${struck ? "line-through text-sol-text-dim" : "text-sol-text-muted"}`}>
      {title}
    </span>
  );
}

function CastEntityCard({ type, shortId, convexId }: { type: "task" | "plan" | "doc"; shortId?: string; convexId?: string }) {
  const router = useRouter();
  // Local-first seed: the card paints from the store's row on the first
  // frame; the query refreshes it. Every `cast task/plan/doc` row in a
  // transcript renders this, so the flash was everywhere.
  const rawId = convexId ?? shortId ?? "";
  const seed = useMemo(
    () => (rawId ? findEntityInStore(useInboxStore.getState(), type, rawId) : undefined),
    [type, rawId],
  );
  const task = useQuery(api.tasks.webGet, type === "task" && shortId ? { short_id: shortId } : "skip");
  const plan = useQuery(api.plans.webGet, type === "plan" && shortId ? { short_id: shortId } : "skip");
  const doc = useQuery(api.docs.webGet, type === "doc" && convexId ? { id: convexId } : "skip");
  const entity = (type === "task" ? task : type === "plan" ? plan : doc) ?? seed;

  if (!entity) {
    if (shortId) return <EntityIdPill shortId={shortId} />;
    return null;
  }

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const route = entityRoute(type, entity._id);
    if (route) router.push(route);
  };

  const status = entity.status || (type === "doc" ? null : "open");
  const sc = status ? (CAST_STATUS_COLORS[status] || CAST_STATUS_COLORS.open) : null;
  const age = Date.now() - (entity.updated_at || (entity as any)._creationTime || Date.now());
  const ageStr = age < 3600000 ? `${Math.max(1, Math.round(age / 60000))}m`
    : age < 86400000 ? `${Math.round(age / 3600000)}h`
    : `${Math.round(age / 86400000)}d`;

  const borderColor = type === "plan" ? "border-sol-cyan/20 bg-sol-cyan/5 hover:bg-sol-cyan/10"
    : type === "task" ? "border-sol-violet/20 bg-sol-violet/5 hover:bg-sol-violet/10"
    : "border-sol-blue/20 bg-sol-blue/5 hover:bg-sol-blue/10";

  const DOC_TYPE_LABELS: Record<string, { label: string; color: string }> = {
    plan: { label: "Plan", color: "text-sol-cyan" },
    design: { label: "Design", color: "text-sol-violet" },
    spec: { label: "Spec", color: "text-sol-blue" },
    investigation: { label: "Investigation", color: "text-sol-orange" },
    handoff: { label: "Handoff", color: "text-sol-magenta" },
    note: { label: "Note", color: "text-sol-text-dim" },
  };

  const docPreview = type === "doc" && (entity as any).content
    ? (entity as any).content.replace(/^#[^\n]*\n*/m, "").replace(/\\n/g, " ").replace(/[#*_`>\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120)
    : "";

  return (
    <button onClick={handleClick} className={`mt-1 w-full max-w-md text-left rounded-lg border transition-colors cursor-pointer ${borderColor}`}>
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {sc && (
            <span className={`px-1.5 py-0 rounded text-[10px] font-mono ${sc.bg} ${sc.text}`}>
              {status!.replace(/_/g, " ")}
            </span>
          )}
          {type === "doc" && (entity as any).doc_type && (
            <span className={`text-[10px] font-medium ${DOC_TYPE_LABELS[(entity as any).doc_type]?.color || "text-sol-text-dim"}`}>
              {DOC_TYPE_LABELS[(entity as any).doc_type]?.label || (entity as any).doc_type}
            </span>
          )}
          {shortId && <span className="text-[10px] font-mono text-sol-text-dim">{shortId}</span>}
          <span className="flex-1 text-sm text-sol-text truncate">
            {(entity as any).display_title || entity.title}
          </span>
          <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{ageStr}</span>
        </div>
        {type === "plan" && (entity as any).progress && (
          <div className="flex items-center gap-2 mt-1.5">
            <div className="flex-1 h-1 rounded-full bg-sol-bg-highlight overflow-hidden max-w-[200px]">
              <div
                className="h-full rounded-full bg-emerald-500/70 transition-all"
                style={{ width: `${(entity as any).progress.total > 0 ? Math.round(((entity as any).progress.done / (entity as any).progress.total) * 100) : 0}%` }}
              />
            </div>
            <span className="text-[10px] text-sol-text-dim font-mono">
              {(entity as any).progress.done}/{(entity as any).progress.total}
            </span>
          </div>
        )}
        {type === "task" && (
          <div className="flex items-center gap-1.5 mt-1">
            {(entity as any).priority && (entity as any).priority !== "medium" && (
              <span className={`text-[10px] px-1 py-0 rounded font-mono ${
                (entity as any).priority === "high" || (entity as any).priority === "critical"
                  ? "bg-red-500/10 text-red-400"
                  : "bg-gray-500/10 text-gray-400"
              }`}>{(entity as any).priority}</span>
            )}
            {(entity as any).labels?.map((l: string) => (
              <span key={l} className="text-[10px] px-1.5 py-0 rounded-full bg-sol-bg-highlight text-sol-text-dim">{l}</span>
            ))}
          </div>
        )}
        {type === "doc" && docPreview && (
          <p className="text-[11px] text-sol-text-muted/70 mt-1 truncate">{docPreview}</p>
        )}
      </div>
    </button>
  );
}

// Dedicated rendering for the two session-addressed cast commands:
//   cast send <id> "<body>"   → outgoing twin of the incoming SessionMessageBlock
//   cast read <id> <range>    → compact "read" row with a clickable target pill
// Both render the target session as an EntityIdPill (clickable card), so they read
// as conversations between sessions rather than opaque shell invocations.
function CastSessionRefBlock({ cat, target, args, fullCmd, output, isError }: {
  cat: string; target: string; args: string; fullCmd: string; output: string; isError: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (cat === "send") {
    const { body, kind } = extractSendBody(args);
    return (
      <div className="my-2 mx-1 rounded border-l-2 border-sol-blue/60 bg-sol-blue/5">
        <div className="flex items-center gap-2 px-3 pt-2 pb-1">
          <CornerUpRight className="w-3.5 h-3.5 text-sol-blue/70 shrink-0" />
          <span className="text-[11px] font-medium tracking-wide uppercase text-sol-blue/70 shrink-0">Message to</span>
          <EntityIdPill shortId={target} />
          {isError ? (
            <span className="text-sol-red/80 text-[10px] ml-auto shrink-0">failed</span>
          ) : (
            <span className="text-sol-green/70 text-[10px] ml-auto shrink-0 inline-flex items-center gap-0.5"><Check className="w-3 h-3" />sent</span>
          )}
        </div>
        {kind === "dynamic" ? (
          // The shell computed the real payload ($(…), $VAR, or stdin) before cast
          // ran — the transcript only holds the recipe. Don't dress it up as the
          // delivered message; that misled a sender into resending a 16KB briefing.
          <div className="px-3 pb-2">
            <code className="text-xs font-mono text-sol-text-secondary break-all">{body}</code>
            <div className="text-[10px] text-sol-text-dim mt-1">shown as typed — the shell filled in the actual message; open the target session to read what arrived</div>
          </div>
        ) : (
          <div className="px-3 pb-2 text-sm text-sol-text prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE}
              components={MESSAGE_MD_COMPONENTS}
            >{body}</ReactMarkdown>
          </div>
        )}
      </div>
    );
  }

  // cast read <id> <range>
  const range = args.trim();
  return (
    <div className="my-0.5">
      <div
        className="flex items-baseline gap-1.5 text-xs cursor-pointer group flex-wrap"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="flex items-center gap-1 font-mono flex-shrink-0 text-sol-violet/80">
          <BookOpen className="w-3 h-3" />
          <span className="group-hover:underline">read</span>
        </span>
        <EntityIdPill shortId={target} />
        {range && <span className="text-sol-text-dim font-mono">{range}</span>}
        {isError && <span className="text-sol-red/80 text-[10px]">(error)</span>}
      </div>
      {expanded && (
        <div className="mt-1 rounded border border-sol-border/30 bg-sol-bg-inset max-h-80 overflow-auto">
          <div className="px-1.5 sm:px-2 py-1 sm:py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
            <pre className="text-[11px] sm:text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
              $ {fullCmd}
            </pre>
          </div>
          {output && output.trim() ? (
            <pre className={`p-1.5 sm:p-2 text-[11px] sm:text-xs font-mono overflow-x-auto whitespace-pre-wrap ${isError ? "text-sol-red" : "text-sol-text-secondary"}`}>
              {renderAnsi(output)}
            </pre>
          ) : (
            <div className="p-2 text-xs text-sol-text-dim">No output</div>
          )}
        </div>
      )}
    </div>
  );
}

// The prose a cast mutation carried — a comment, a done note, a plan goal, a
// trigger prompt. It is the content of the action, so it renders the way a
// message body does (markdown, entity pills, code) instead of as one clipped
// italic line: these are often written reports, and the sentence that survived a
// 90-character cut was rarely the one worth reading. Long bodies start clipped
// with an Expand toggle, so a row still costs a few lines in the transcript.
// A collapsed body shows about four lines whatever its length, and a cast
// comment can be a 20KB report — parsing all of it to paint four lines is the
// kind of per-row cost that adds up to a frozen transcript. Slice to a few
// screens' worth while clipped; the full text renders when the reader expands.
const CAST_BODY_CLIP = 2000;
function clipBody(text: string): string {
  return text.length > CAST_BODY_CLIP ? text.slice(0, CAST_BODY_CLIP) : text;
}

function CastMutationBody({ parts, accent }: { parts: CastBodyPart[]; accent: string }) {
  return (
    <div className={`mt-1 ml-1 border-l-2 pl-2.5 space-y-1.5 ${accent}`}>
      {parts.map((part, i) => (
        <div key={i}>
          {part.label && (
            <div className="text-[10px] uppercase tracking-wide text-sol-text-dim mb-0.5">{part.label}</div>
          )}
          <CollapsibleBody collapsedHeight={96} toggleClassName="mt-1">
            {(expanded) => (
              <div className="text-[13px] text-sol-text prose prose-invert prose-sm max-w-none
                prose-code:text-sol-cyan prose-code:bg-sol-bg-highlight prose-code:px-1 prose-code:rounded prose-code:text-xs
                prose-code:before:content-none prose-code:after:content-none
                [&_pre]:overflow-x-auto [&_pre]:max-w-full">
                <MessageMarkdown content={expanded ? part.text : clipBody(part.text)} userText />
              </div>
            )}
          </CollapsibleBody>
        </div>
      ))}
    </div>
  );
}

// `cast state …` pins the thread state that already renders expanded above the
// composer (ThreadStatePanel), so the row stays one line: the declared status
// as a chip in the panel's own colors, plus the state's first line. The full
// body would be the same text twice — click still expands the raw command.
function CastStateBlock({ subcommand, args, fullCmd, output, isError }: { subcommand: string; args: string; fullCmd: string; output: string; isError: boolean }) {
  const [expanded, setExpanded] = useState(false);
  // `clear`/`show` parse into the subcommand slot; the pinning form's args
  // start with `--status` or a quoted body, so its subcommand is usually empty.
  // A bare first word of an unquoted state text also lands there — fold it back.
  const verb = subcommand === "clear" || subcommand === "show" ? subcommand : null;
  const { status, headline } = useMemo(
    () => (verb ? { status: null, headline: null } : extractStateArgs(subcommand ? `${subcommand} ${args}`.trim() : args)),
    [verb, subcommand, args],
  );
  const statusMeta = (() => {
    const parsed = parseThreadStateStatus(status);
    return parsed ? THREAD_STATE_STATUS_META[parsed] : null;
  })();

  return (
    <div className="my-0.5">
      <div
        className="flex items-baseline gap-1.5 text-xs cursor-pointer group flex-wrap"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="flex items-center gap-1 font-mono flex-shrink-0 text-sol-cyan/80">
          <Pin className="w-3 h-3" strokeWidth={2.2} />
          <span className="group-hover:underline">state{verb ? ` ${verb}` : ""}</span>
        </span>
        {statusMeta && (
          <span className={`self-center shrink-0 inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full border text-[9px] font-semibold uppercase tracking-wide ${statusMeta.chip}`}>
            <span className="w-1.5 h-1.5 rounded-full bg-current" />
            {statusMeta.label}
          </span>
        )}
        {headline && <span className="text-sol-text-muted truncate min-w-0">{headline}</span>}
        {verb === "show" && args && <span className="text-sol-text-dim font-mono">{args.split(/\s+/)[0]}</span>}
        {isError && <span className="text-sol-red/80 text-[10px]">(error)</span>}
      </div>
      {expanded && (
        <div className="mt-1 rounded border border-sol-border/30 bg-sol-bg-inset max-h-80 overflow-auto">
          <div className="px-1.5 sm:px-2 py-1 sm:py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
            <pre className="text-[11px] sm:text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
              $ {fullCmd}
            </pre>
          </div>
          {output && output.trim() ? (
            <pre className={`p-1.5 sm:p-2 text-[11px] sm:text-xs font-mono overflow-x-auto whitespace-pre-wrap ${isError ? "text-sol-red" : "text-sol-text-secondary"}`}>
              {renderAnsi(output)}
            </pre>
          ) : (
            <div className="p-2 text-xs text-sol-text-dim">No output</div>
          )}
        </div>
      )}
    </div>
  );
}

// `cast decide` — the agent handing its human a decision. The queue and the
// docked SessionDecisionCard are where it gets ANSWERED; this row is the
// record of it in the transcript, rendered as the same card so the agent never
// has to restate the question in prose. The live row (store, fed by
// listForUser) is the truth when present: an edit changes the text here, an
// answer shows up as the chosen option, a withdrawal greys it out. Rows older
// than the subscription window fall back to the recorded argv.
const DECIDE_STATUS_META: Record<string, { label: string; chip: string; accent: string }> = {
  waiting: { label: "waiting on you", chip: "border-sol-yellow/40 text-sol-yellow", accent: "border-sol-yellow/50" },
  advisory: { label: "advisory", chip: "border-sol-blue/40 text-sol-blue", accent: "border-sol-blue/40" },
  answered: { label: "answered", chip: "border-sol-green/40 text-sol-green", accent: "border-sol-green/40" },
  dismissed: { label: "dismissed", chip: "border-sol-border text-sol-text-dim", accent: "border-sol-border" },
  withdrawn: { label: "withdrawn", chip: "border-sol-border text-sol-text-dim", accent: "border-sol-border" },
  posted: { label: "posted", chip: "border-sol-border text-sol-text-dim", accent: "border-sol-yellow/30" },
};

// The id this row's own CLI output named. Verb-specific: a compound command
// (`cast decide cancel; cast decide "…"`) prints several ids, and the ask's
// `id:` line must not be read as the cancel's target.
function decideOutputId(output: string, verb: DecideArgs["verb"]): string | null {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const pattern = verb === "cancel"
    ? /Decision withdrawn:\s*([a-z0-9]{20,})\b/
    : verb === "edit"
      ? /Decision updated:\s*([a-z0-9]{20,})\b/
      : /^\s*id:\s*([a-z0-9]{20,})\b/m;
  return clean.match(pattern)?.[1] ?? null;
}

function CastDecideBlock({ decide, fullCmd, output, isError, conversationId }: { decide: DecideArgs; fullCmd: string; output: string; isError: boolean; conversationId?: Id<"conversations"> }) {
  const [expanded, setExpanded] = useState(false);
  const convKey = conversationId?.toString();
  const targetId = decide.decisionId ?? (output ? decideOutputId(output, decide.verb) : null);

  // Wake on this conversation's decision rows only — they change on ask,
  // edit and answer, never on heartbeat.
  const s = useTrackedStore([
    (st) => {
      if (!convKey) return "";
      let sig = "";
      for (const d of Object.values(st.sessionDecisions)) {
        if (d.conversation_id === convKey) sig += `${d._id}:${d.status}:${d.updated_at ?? 0}:${d.answer_index ?? ""}:${d.answer_text ?? ""}|`;
      }
      return sig;
    },
  ]);
  const row = useMemo((): SessionDecisionItem | null => {
    if (targetId) return s.sessionDecisions[targetId] ?? null;
    if (!convKey) return null;
    const mine = Object.values(s.sessionDecisions)
      .filter((d) => d.conversation_id === convKey)
      .sort((a, b) => b.created_at - a.created_at);
    if (decide.verb === "ask") return mine.find((d) => d.question === decide.question) ?? null;
    // edit/cancel with no id acted on the session's open decision at the time.
    // A cancel left a withdrawn row behind; an edit most likely touched the row
    // that is still open. Newest of that kind, else newest overall.
    const wanted = decide.verb === "cancel" ? "withdrawn" : "pending";
    return mine.find((d) => d.status === wanted) ?? mine[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.sessionDecisions, targetId, convKey, decide.verb, decide.question]);

  // An edit row is a diff, not a second copy of the card: it shows the fields
  // the command changed (from the recorded argv; the live row fills in a field
  // whose argv was a recipe). The ask row is the card itself.
  const isEdit = decide.verb === "edit";
  const question = isEdit ? decide.question : row?.question ?? decide.question;
  const options: Array<{ label: string; description?: string }> = isEdit ? decide.options : row?.options ?? decide.options;
  const context = isEdit ? decide.context : row?.context_md ?? decide.context;
  const editChanges = isEdit
    ? [decide.question && "question", decide.options.length > 0 && "options", decide.context !== null && "context", decide.report && "report", decide.blocking && "now blocking", decide.advisory && "now advisory"].filter(Boolean).join(", ")
    : "";
  const blocking = row ? row.blocking : !decide.advisory;
  const defaultOption = row ? row.default_option : decide.defaultOption;
  const reportSlug = row?.report_slug;
  const withdrawnHere = decide.verb === "cancel";

  const statusKey = row
    ? row.status === "pending" ? (blocking ? "waiting" : "advisory") : row.status
    : withdrawnHere ? "withdrawn" : "posted";
  const meta = DECIDE_STATUS_META[statusKey];
  const answerLabel = row?.status === "answered"
    ? row.answer_text ?? (row.answer_index !== undefined ? row.options[row.answer_index]?.label : undefined)
    : undefined;
  const muted = statusKey === "dismissed" || statusKey === "withdrawn";
  const verbLabel = decide.verb === "edit" ? "decision edited" : decide.verb === "cancel" ? "decision withdrawn" : "decision";


  return (
    <div className="my-1">
      <div
        className="flex items-center gap-1.5 text-xs cursor-pointer group flex-wrap"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="flex items-center gap-1 font-mono flex-shrink-0 text-sol-yellow/80">
          <Split className="w-3 h-3" strokeWidth={2.2} />
          <span className="group-hover:underline">{verbLabel}</span>
        </span>
        {isEdit && <span className="text-sol-text-dim">{editChanges || "no readable change"}</span>}
        {!isError && row && (
          <span className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full border text-[9px] font-semibold uppercase tracking-wide ${meta.chip}`}>
            {statusKey === "waiting" && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
            {meta.label}
          </span>
        )}
        {!isEdit && answerLabel && <span className="text-sol-green truncate min-w-0">{answerLabel}</span>}
        {isError && <span className="text-sol-red/80 text-[10px]">(error)</span>}
      </div>

      {!isError && (question || context || options.length > 0 || reportSlug || decide.report) && (
        <div className={`mt-1 ml-1 border-l-2 pl-2.5 space-y-1.5 ${meta.accent} ${muted ? "opacity-60" : ""}`}>
          {question && (
            <div className={`text-[13px] text-sol-text leading-snug ${withdrawnHere || statusKey === "withdrawn" ? "line-through" : ""}`}>
              {question}
            </div>
          )}
          {!withdrawnHere && context && (
            <CollapsibleBody collapsedHeight={96} toggleClassName="mt-1">
              {(isOpen) => (
                <div className="text-[13px] text-sol-text-muted prose prose-invert prose-sm max-w-none
                  prose-code:text-sol-cyan prose-code:bg-sol-bg-highlight prose-code:px-1 prose-code:rounded prose-code:text-xs
                  prose-code:before:content-none prose-code:after:content-none
                  [&_pre]:overflow-x-auto [&_pre]:max-w-full">
                  <MessageMarkdown content={isOpen ? context : clipBody(context)} userText />
                </div>
              )}
            </CollapsibleBody>
          )}
          {!withdrawnHere && options.length > 0 && (
            <div className="flex flex-col gap-1">
              {options.map((o, i) => {
                const chosen = row?.status === "answered" && row.answer_index === i;
                const isDefault = statusKey === "advisory" && defaultOption === i;
                return (
                  <div key={i} className={`flex items-baseline gap-2 text-[12px] ${chosen ? "text-sol-green" : "text-sol-text-muted"}`}>
                    <span className={`shrink-0 inline-flex items-center justify-center w-4 h-4 rounded border text-[10px] font-mono ${chosen ? "border-sol-green/60 text-sol-green" : "border-sol-border text-sol-text-dim"}`}>
                      {chosen ? <Check className="w-3 h-3" strokeWidth={2.5} /> : i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className={chosen ? "text-sol-green" : "text-sol-text"}>{o.label}</span>
                      {o.description && <span className="text-sol-text-dim"> — {o.description}</span>}
                      {isDefault && <span className="ml-1.5 text-[10px] text-sol-blue">proceeding with this</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {!isEdit && row?.status === "answered" && row.answer_text && (
            <div className="text-[12px] text-sol-green">answered in their own words: {row.answer_text}</div>
          )}
          {!withdrawnHere && (decide.report || (!isEdit && reportSlug)) && (
            <div className="text-[11px]">
              {reportSlug ? (
                <a href={`/a/${reportSlug}`} target="_blank" rel="noopener noreferrer" className="text-sol-blue hover:underline inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <FileText className="w-3 h-3" /> report
                </a>
              ) : (
                <span className="text-sol-text-dim inline-flex items-center gap-1"><FileText className="w-3 h-3" /> {decide.report}</span>
              )}
            </div>
          )}
        </div>
      )}

      {expanded && (
        <div className="mt-1 rounded border border-sol-border/30 bg-sol-bg-inset max-h-80 overflow-auto">
          <div className="px-1.5 sm:px-2 py-1 sm:py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
            <pre className="text-[11px] sm:text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
              $ {fullCmd}
            </pre>
          </div>
          {output && output.trim() ? (
            <pre className={`p-1.5 sm:p-2 text-[11px] sm:text-xs font-mono overflow-x-auto whitespace-pre-wrap ${isError ? "text-sol-red" : "text-sol-text-secondary"}`}>
              {renderAnsi(output)}
            </pre>
          ) : (
            <div className="p-2 text-xs text-sol-text-dim">No output</div>
          )}
        </div>
      )}
    </div>
  );
}

function CastCommandBlock({ tool, result, images, globalImageMap, conversationId }: { tool: ToolCall; result?: ToolResult; images?: ImageData[]; globalImageMap?: Record<string, ImageData[]>; conversationId?: Id<"conversations"> }) {
  const [expanded, setExpanded] = useState(false);
  const convex = useConvex();
  const cast = parseCastCommand(tool)!;
  const { category, subcommand, args } = cast;
  const output = result?.content || "";
  const isError = result?.is_error;

  const cat = normalizeCastCategory(category);
  const isCreate = subcommand === "create" || subcommand === "add";
  const bodyParts = useMemo(
    () => extractCastBodyParts(category, subcommand, args),
    [category, subcommand, args]
  );

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const entityIds = useMemo(() => {
    const ids: string[] = [];
    const patterns = [/\b(ct-[a-z0-9]+)\b/gi, /\b(pl-[a-z0-9]+)\b/gi];
    const sources = [args, stripAnsi(output)];
    for (const src of sources) {
      for (const pattern of patterns) {
        let m;
        while ((m = pattern.exec(src)) !== null) {
          if (!ids.includes(m[1].toLowerCase())) ids.push(m[1].toLowerCase());
        }
      }
    }
    return ids;
  }, [args, output]);

  const scheduleCadence = useMemo(
    () => (cat === "trigger" && isCreate ? parseTriggerCadence(args) : null),
    [cat, isCreate, args]
  );

  // `cast browser do …` is the CLI's batch: the row lists its steps with what
  // each reported, the same shape a browser_batch tool call renders in.
  const doSteps = useMemo(
    () => (cat === "browser" && subcommand === "do" ? extractBrowserDoSteps(args) : []),
    [cat, subcommand, args],
  );
  const doOutcomes = useMemo(
    () => (doSteps.length > 0 && output ? splitBrowserDoOutput(output, doSteps.length) : undefined),
    [doSteps.length, output],
  );
  const doFooter = useMemo(
    () => (doSteps.length > 0 ? (stripAnsi(output).match(/^\d+\/\d+ steps in .*$/m)?.[0] ?? null) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doSteps.length, output],
  );

  const docConvexId = useMemo(() => {
    if (cat !== "doc") return null;
    const fa = args?.match(/^"([^"]*)"/) || args?.match(/^'([^']*)'/) || args?.match(/^(\S+)/);
    const firstA = fa ? fa[1] : "";
    if (!isCreate && firstA && /^[a-z0-9]{20,}$/i.test(firstA)) return firstA;
    if (isCreate && output) {
      const clean = stripAnsi(output);
      const m = clean.match(/Created\s+\w+\s+([a-z0-9]{20,})/i) || clean.match(/\b([a-z0-9]{20,})\b/i);
      return m ? m[1] : null;
    }
    return null;
  }, [cat, isCreate, output, args]);

  const isEntityCommand = ((cat === "task" || cat === "plan") && isCreate && entityIds.length > 0) || (cat === "doc" && !!docConvexId);

  // `accent` tints the left rule of the body block, so a comment reads as
  // belonging to the object kind named in the row above it.
  const getCategoryConfig = () => {
    switch (cat) {
      case "task": return {
        color: "text-sol-yellow/80",
        accent: "border-sol-yellow/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
      };
      case "plan": return {
        color: "text-sol-cyan/80",
        accent: "border-sol-cyan/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></svg>
      };
      case "doc": return {
        color: "text-sol-blue/80",
        accent: "border-sol-blue/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
      };
      case "search": return {
        color: "text-sol-violet/80",
        accent: "border-sol-violet/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
      };
      case "feed": return {
        color: "text-sol-green/80",
        accent: "border-sol-green/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" /></svg>
      };
      case "trigger": return {
        color: "text-sol-orange/80",
        accent: "border-sol-orange/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
      };
      case "browser": return {
        color: "text-sol-cyan/80",
        accent: "border-sol-cyan/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" strokeLinejoin="round" d="M3.6 9h16.8M3.6 15h16.8M12 3a15 15 0 010 18M12 3a15 15 0 000 18" /></svg>
      };
      case "diff": case "summary": case "handoff": case "context": case "ask": return {
        color: "text-sol-magenta/80",
        accent: "border-sol-magenta/25",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
      };
      default: return {
        color: "text-sol-text-dim",
        accent: "border-sol-border/60",
        icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
      };
    }
  };

  const config = getCategoryConfig();

  const firstArg = useMemo(() => {
    if (!args) return "";
    const m = args.match(/^"([^"]*)"/) || args.match(/^'([^']*)'/) || args.match(/^(\S+)/);
    // A lone `-` is the stdin marker, not a title — the body it stands for
    // renders below the row.
    return m && m[1] !== "-" ? m[1] : "";
  }, [args]);

  // `cast browser …` drives a page in the cloned Chrome. The CLI prints the
  // page URL and the tab id ("tab 4A2CDC7E") only after some verbs, so the
  // row's own output wins when it has them, and otherwise the
  // conversation-level carry-forward map supplies the page and tab the browser
  // was already on (see CastBrowserRowContext).
  const carriedBrowserRows = useContext(CastBrowserRowContext);
  const browserUrl = useMemo(() => {
    if (cat !== "browser") return null;
    return extractBrowserPageUrl(subcommand, args, output) ?? carriedBrowserRows[tool.id]?.url ?? null;
  }, [cat, subcommand, args, output, carriedBrowserRows, tool.id]);

  // "open tab" raises that real tab in the driven Chrome (lib/browserFocus.ts)
  // and does nothing else: if the tab is gone, the browser stopped, or the
  // viewer is on another machine, the click is a no-op — never a fresh copy
  // of the page.
  const browserTabId = useMemo(() => {
    if (cat !== "browser") return null;
    return extractBrowserTabId(output) ?? carriedBrowserRows[tool.id]?.tabId ?? null;
  }, [cat, output, carriedBrowserRows, tool.id]);
  // Discovery of the daemon's loopback endpoint can outlast a click's
  // activation window, so start it as soon as a row that can focus a tab
  // renders — by the time the human clicks, the endpoint is cached.
  useEffect(() => {
    if (browserTabId) prefetchBrowserFocusEndpoint(convex);
  }, [browserTabId, convex]);

  const renderSummary = () => {
    const isShow = subcommand === "show" || subcommand === "status" || subcommand === "context";
    const isGet = subcommand === "get";
    const isList = subcommand === "ls" || subcommand === "list";
    const isSearch = subcommand === "search" || cat === "search";
    const isStatusChange = ["start", "done", "drop", "pause", "activate", "bind", "unbind"].includes(subcommand);
    const isIdCommand = ["edit", "get", "show", "status", "context", "comment", "start", "done", "drop", "pause", "activate", "bind", "unbind", "update", "decide", "discover", "pointer", "decompose", "orchestrate", "autopilot", "wave", "progress", "agents", "kill", "retry"].includes(subcommand);
    // A done/drop row reads as the task being crossed out: resolved title struck
    // through, no redundant status badge (the row label already says "task done").
    const isDoneLike = subcommand === "done" || subcommand === "drop";
    const argEntityId = /^(ct|pl)-[a-z0-9]+$/i.test(firstArg) ? firstArg.toLowerCase() : null;

    const statusColors: Record<string, string> = {
      start: "bg-amber-500/15 text-amber-400",
      done: "bg-emerald-500/15 text-emerald-400",
      drop: "bg-red-500/15 text-red-400",
      pause: "bg-gray-500/15 text-gray-400",
      activate: "bg-emerald-500/15 text-emerald-400",
      bind: "bg-sol-cyan/15 text-sol-cyan",
      unbind: "bg-gray-500/15 text-gray-400",
    };

    const outputLines = output.trim().split("\n").filter(l => l.trim()).length;

    if (isEntityCommand && entityIds.length > 0 && cat !== "doc") return null;

    if (cat === "doc" && docConvexId) {
      return (
        <>
          <DocTitleLink convexId={docConvexId} />
          {isError && <span className="text-sol-red/80 text-[10px]">(error)</span>}
        </>
      );
    }

    return (
      <>
        {scheduleCadence && (
          <span className="px-1 py-0.5 rounded text-[10px] font-mono bg-sol-orange/15 text-sol-orange/90 flex-shrink-0">
            {scheduleCadence}
          </span>
        )}

        {entityIds.length > 0 && entityIds.map(id => (
          <EntityIdPill key={id} shortId={id} />
        ))}

        {argEntityId && (isStatusChange || subcommand === "comment") && (
          <InlineEntityTitle shortId={argEntityId} struck={isDoneLike} />
        )}

        {isCreate && !entityIds.length && firstArg && (
          <span className="text-sol-text-muted truncate">{truncateStr(firstArg, 50)}</span>
        )}

        {(isShow || isGet) && !entityIds.length && firstArg && (
          <span className="text-sol-text-dim font-mono">{firstArg}</span>
        )}

        {isIdCommand && !isShow && !isGet && !isStatusChange && !entityIds.length && firstArg && (
          <span className="text-sol-text-dim font-mono">{firstArg}</span>
        )}

        {isStatusChange && !isDoneLike && (
          <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${statusColors[subcommand] || "bg-gray-500/15 text-gray-400"}`}>
            {subcommand}
          </span>
        )}

        {isList && output && (
          <span className="text-sol-text-dim font-mono">({outputLines} items)</span>
        )}

        {isSearch && firstArg && (
          <span className="text-sol-text-muted italic truncate">"{truncateStr(firstArg, 40)}"</span>
        )}

        {doSteps.length > 0 && (
          <span className="text-sol-text-muted font-mono truncate">
            {truncateStr(`${doSteps.length} steps · ${doSteps.map(st => `${st.verb}${st.args ? ` ${st.args}` : ""}`).join(" · ")}`, 100)}
          </span>
        )}

        {isError && <span className="text-sol-red/80 text-[10px]">(error)</span>}

        {!isList && !isError && !isEntityCommand && !doSteps.length && output && outputLines > 1 && (
          <span className="text-sol-text-dim font-mono">({outputLines} lines)</span>
        )}
      </>
    );
  };

  const subLabel = subcommand ? subcommand.replace(/-/g, " ") : "";

  // `cast send <id> "…"` / `cast read <id> <range>` address another session — the
  // subcommand slot holds the session short ID. Render those as their own block
  // (clickable target pill + body/range) instead of a generic shell-command row.
  const sessionTarget = (cat === "send" || cat === "read") && /^jx[a-z0-9]{5,}$/i.test(subcommand) ? subcommand : null;
  if (sessionTarget) {
    return <CastSessionRefBlock cat={cat} target={sessionTarget} args={args} fullCmd={cast.fullCmd} output={output} isError={!!isError} />;
  }
  // `cast chat reply <id> "…"` / `cast chat send "…" --channel <id>` — the
  // agent's side of a team-chat exchange, rendered as the outgoing twin of the
  // ChatWakeBlock that asked.
  const chatSend = cat === "chat" ? extractChatSendArgs(subcommand, args) : null;
  if (chatSend) {
    return <CastChatSendBlock send={chatSend} isReply={subcommand === "reply"} isError={!!isError} />;
  }
  // `cast decide` — the decision card, live from the store row when it exists.
  // `ls` is a plain read and keeps the generic row.
  const decide = cat === "decide" ? extractDecideArgs(subcommand, args) : null;
  if (decide && decide.verb !== "ls") {
    return <CastDecideBlock decide={decide} fullCmd={cast.fullCmd} output={output} isError={!!isError} conversationId={conversationId} />;
  }
  // `cast state` — the pinned panel already shows the full text, so the row is
  // a one-line status + headline instead of the generic body render.
  if (cat === "state") {
    return <CastStateBlock subcommand={subcommand} args={args} fullCmd={cast.fullCmd} output={output} isError={!!isError} />;
  }

  return (
    <div className="my-0.5">
      <div
        className="flex items-baseline gap-1.5 text-xs cursor-pointer group flex-wrap"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`flex items-center gap-1 font-mono flex-shrink-0 ${config.color}`}>
          {config.icon}
          <span className="group-hover:underline">{cat}{subLabel ? ` ${subLabel}` : ""}</span>
        </span>
        {renderSummary()}
        {browserTabId && (
          <a
            href={browserUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            className={BROWSER_ROW_PILL}
            onMouseEnter={() => prefetchBrowserFocusEndpoint(convex)}
            onClick={(e) => {
              e.stopPropagation();
              // Modified clicks keep their native open-the-URL behavior.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              void focusBrowserTab(convex, browserTabId);
            }}
            title={`focus tab ${browserTabId} in the agent's browser${browserUrl ? `\n${browserUrl}` : ""}`}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            <span>open tab</span>
          </a>
        )}
        {cat === "browser" && conversationId && (
          <BrowserWatchButton conversationId={conversationId} />
        )}
      </div>

      {(() => {
        // A `cast browser shot` declares the file it wrote via an inline-image
        // marker; the parser lifts it onto the message keyed by this tool call
        // (see cli inlineImage.ts). Bind it here the same way ToolBlock does,
        // so the screenshot renders under the row like an extension shot —
        // several at once (`--viewports`) read side by side as a comparison.
        let toolImages = images?.filter(img => img.tool_use_id === tool.id) ?? [];
        if (!toolImages.length) toolImages = globalImageMap?.[tool.id] ?? [];
        if (!toolImages.length) return null;
        if (toolImages.length === 1) return <ImageBlock image={toolImages[0]} />;
        return (
          <div className="flex gap-2 items-start">
            {toolImages.map((img, i) => (
              <div key={i} className="flex-1 min-w-0 max-w-md">
                <ImageBlock image={img} />
              </div>
            ))}
          </div>
        );
      })()}

      {bodyParts.length > 0 && <CastMutationBody parts={bodyParts} accent={config.accent} />}

      {isEntityCommand && entityIds.length > 0 && cat !== "doc" && entityIds.map(id => (
        <CastEntityCard
          key={id}
          type={id.startsWith("pl-") ? "plan" : "task"}
          shortId={id}
        />
      ))}

      {cat === "doc" && docConvexId && (
        <CastEntityCard type="doc" convexId={docConvexId} />
      )}

      {expanded && (
        <div className="mt-1 rounded border border-sol-border/30 bg-sol-bg-inset max-h-80 overflow-auto">
          <div className="px-1.5 sm:px-2 py-1 sm:py-1.5 border-b border-sol-border/20 bg-sol-bg-highlight/30">
            <pre className="text-[11px] sm:text-xs font-mono text-sol-green whitespace-pre-wrap break-all">
              $ {cast.fullCmd}
            </pre>
          </div>
          {doSteps.length > 0 ? (
            <>
              <NestedStepList
                steps={doSteps.map(st => ({ label: st.verb, summary: st.args }))}
                outcomes={doOutcomes}
                labelClass={config.color}
              />
              {doFooter && <div className="px-2 py-1 text-[11px] font-mono text-sol-text-dim">{doFooter}</div>}
              {!output && <div className="p-2 text-xs text-sol-text-dim">Running</div>}
            </>
          ) : output && output.trim() ? (
            <pre className={`p-1.5 sm:p-2 text-[11px] sm:text-xs font-mono overflow-x-auto whitespace-pre-wrap ${isError ? "text-sol-red" : "text-sol-text-secondary"}`}>
              {renderAnsi(output)}
            </pre>
          ) : (
            <div className="p-2 text-xs text-sol-text-dim">No output</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The two affordances on a `cast browser` row — "open tab" and "watch live" —
 * as small pills, so they read as controls beside the command rather than as
 * more of its text.
 */
const BROWSER_ROW_PILL =
  "flex-shrink-0 inline-flex items-center gap-1 rounded-full border border-sol-border/60 bg-sol-bg-highlight/40 " +
  "px-1.5 py-px text-[10px] leading-4 font-mono text-sol-text-muted hover:text-sol-cyan hover:border-sol-cyan/40 transition-colors";

/**
 * "watch live" on a `cast browser` row: opens the read-only stream of the tab
 * this agent is driving (BrowserWatchSplit), docked above the conversation.
 * Rendered on every browser row — whether a stream actually exists is the
 * daemon's call, and the split reports it honestly on connect.
 */
function BrowserWatchButton({ conversationId }: { conversationId: Id<"conversations"> }) {
  const convKey = conversationId.toString();
  const open = useBrowserWatchOpen(convKey);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        toggleBrowserWatch(convKey);
      }}
      className={`${BROWSER_ROW_PILL} ${open ? "text-sol-red border-sol-red/40 hover:text-sol-red/80" : ""}`}
      title={open ? "Close the live browser view" : "Watch what this agent's browser shows, live — take control to sign in for it"}
    >
      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
      <span>{open ? "watching" : "watch live"}</span>
    </button>
  );
}

function SendMessageBlock({ tool, agentNameToChildMap }: { tool: ToolCall; agentNameToChildMap?: Record<string, string> }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const type = parsedInput.type || "message";
  const recipient = parsedInput.recipient;
  const summary = parsedInput.summary;
  const content = parsedInput.content;
  const childId = recipient && agentNameToChildMap?.[recipient];

  const isShutdown = type === "shutdown_request";
  const isBroadcast = type === "broadcast";

  const typeConfig = isShutdown
    ? { icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" /></svg>, color: "text-red-400/80", bg: "bg-red-500/8 border-red-500/15", label: "shutdown" }
    : isBroadcast
    ? { icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" /></svg>, color: "text-orange-400/80", bg: "bg-orange-500/8 border-orange-500/15", label: "broadcast" }
    : { icon: <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>, color: "text-amber-400/80", bg: "bg-amber-500/8 border-amber-500/15", label: "message" };

  const displayText = summary || (content && String(content).slice(0, 80)) || "";

  return (
    <div className="my-0.5">
      <div className={`flex items-center gap-1.5 text-xs py-1.5 px-2.5 rounded-md border ${typeConfig.bg}`}>
        <span className={typeConfig.color}>{typeConfig.icon}</span>
        {isShutdown ? (
          <>
            {recipient && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20 font-mono">@{recipient}</span>}
            <span className="text-red-400/80 font-medium text-xs">shutdown request</span>
          </>
        ) : (
          <>
            {recipient && (
              childId ? (
                <Link href={`/conversation/${childId}`} className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 font-mono hover:bg-amber-500/25 hover:text-amber-300 transition-colors" onClick={e => e.stopPropagation()}>@{recipient}</Link>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20 font-mono">@{recipient}</span>
              )
            )}
            {isBroadcast && <span className="text-[10px] px-1 py-0.5 rounded bg-orange-500/15 text-orange-400 font-mono">all</span>}
            {displayText && <span className="text-sol-text-muted truncate">{displayText}</span>}
          </>
        )}
      </div>
    </div>
  );
}

function TeamCreateBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const isDelete = tool.name === "TeamDelete";

  return (
    <div className="my-0.5">
      <div className={`flex items-center gap-1.5 text-xs py-1.5 px-2.5 rounded-md border ${isDelete ? "bg-red-500/5 border-red-500/15" : "bg-cyan-500/8 border-cyan-500/15"}`}>
        <svg className={`w-3 h-3 shrink-0 ${isDelete ? "text-red-400/70" : "text-cyan-400/70"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
        <span className={`font-mono text-xs font-medium ${isDelete ? "text-red-400/80" : "text-cyan-400/80"}`}>
          {isDelete ? "Team dissolved" : "Team created"}
        </span>
        {parsedInput.team_name && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-cyan-500/15 text-cyan-400 border border-cyan-500/20">
            {parsedInput.team_name}
          </span>
        )}
        {parsedInput.description && <span className="text-sol-text-dim truncate">{String(parsedInput.description).slice(0, 60)}</span>}
      </div>
    </div>
  );
}

function SkillBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: { skill?: string; args?: string } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}
  const skillName = parsedInput.skill || "skill";
  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-mono text-sol-cyan/80">/{skillName}</span>
        {parsedInput.args && <span className="text-sol-text-dim">{parsedInput.args}</span>}
      </div>
    </div>
  );
}

// Live status badge + latest event for a Monitor or background-Bash block,
// derived from the conversation's message window (monitorRowsFor — one
// memoized scan shared by all blocks). Same anatomy as the trigger block
// above: identity accent + uppercase eyebrow + one-line gist, so standing
// machinery reads as one family.
const MONITOR_BADGE: Record<MonitorStatus, { label: string; cls: string }> = {
  watching: { label: "watching", cls: "bg-sol-green/10 text-sol-green border-sol-green/30" },
  ended: { label: "ended", cls: "bg-sol-bg-alt text-sol-text-dim border-sol-border/50" },
  timed_out: { label: "timed out", cls: "bg-sol-orange/10 text-sol-orange border-sol-orange/30" },
  stopped: { label: "stopped", cls: "bg-sol-bg-alt text-sol-text-dim border-sol-border/50" },
};
// A detached command "runs" rather than "watches", and finishing is its
// purpose ("done"), not a stream folding ("ended"). Workflow runs share the
// same voice.
const BACKGROUND_BADGE_LABEL: Record<MonitorStatus, string> = {
  watching: "running", ended: "done", timed_out: "timed out", stopped: "stopped",
};

function MonitorBlock({ tool, conversationId }: { tool: ToolCall; conversationId?: string }) {
  const isBackground = tool.name !== "Monitor";
  let input: { command?: string; description?: string; timeout_ms?: number; persistent?: boolean } = {};
  try { input = JSON.parse(tool.input); } catch {}
  const [showCommand, setShowCommand] = useState(false);
  const messages = useInboxStore((s) => (conversationId ? s.messages[conversationId] : undefined));
  const row = useMemo(() => monitorRowsFor(messages).find((r) => r.toolUseId === tool.id), [messages, tool.id]);
  const now = useCoarseNow(30_000);
  // Background rows carry no timeout, so the scanner's defensive expiry never
  // fires for them — without this gate a dead session's block would claim
  // "running" forever. Narrow boolean subscription: re-renders only when the
  // verdict flips, never on heartbeat churn (see store/wakeSig.ts rules).
  const sessionDead = useInboxStore((s) => {
    if (!conversationId) return false;
    const sess = s.sessions[conversationId];
    return !!sess && isWatchHostDead(sess, now);
  });
  // The daemon's verdict on THIS watch: armed before its last verified report
  // and not in it means the shell is gone (a lost completion notice, a died
  // process) — the block must not claim "running". Narrow boolean subscription.
  const reportedDead = useInboxStore((s) => {
    if (!conversationId || !row) return false;
    const sess = s.sessions[conversationId];
    return !!sess && reportSaysDead(sess, row);
  });
  // Start of the process currently behind this session. A watch armed before it
  // died with the process that armed it — the session being alive says nothing
  // about a shell owned by its predecessor. Narrow numeric subscription.
  const agentStartedAt = useInboxStore((s) =>
    (conversationId ? s.sessions[conversationId]?.agent_started_at : undefined) ?? undefined,
  );
  const rawStatus: MonitorStatus = row ? effectiveMonitorStatus(row, now, agentStartedAt) : "watching";
  const status: MonitorStatus = rawStatus === "watching" && (sessionDead || reportedDead) ? "stopped" : rawStatus;
  const failed = isBackground && status === "ended" && (row?.exitCode ?? 0) > 0;
  const badge = failed
    ? { label: `exit ${row!.exitCode}`, cls: "bg-sol-red/10 text-sol-red border-sol-red/30" }
    : { cls: MONITOR_BADGE[status].cls, label: isBackground ? BACKGROUND_BADGE_LABEL[status] : MONITOR_BADGE[status].label };
  const watching = status === "watching";
  const commandFirstLine = (input.command || "").split("\n").find((l) => l.trim()) || "";
  const Icon = isBackground ? Terminal : Radar;

  return (
    <div className={`my-1 rounded border-l-2 ${watching ? "border-sol-blue/60 bg-sol-blue/5" : "border-sol-border/60 bg-sol-bg-alt/30"}`}>
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 min-w-0">
        <Icon className={`w-3.5 h-3.5 shrink-0 ${watching ? "text-sol-blue/70" : "text-sol-text-dim"}`} />
        <span className={`text-[11px] font-medium tracking-wide uppercase shrink-0 ${watching ? "text-sol-blue/70" : "text-sol-text-dim"}`}>{isBackground ? "Background" : "Monitor"}</span>
        {input.persistent && (
          <ShortcutTooltip label="Runs until TaskStop or session end — not a one-shot watch">
            <span className="px-1 py-0 rounded border text-[9px] font-semibold shrink-0 border-sol-blue/40 text-sol-blue/90 bg-sol-blue/10">persistent</span>
          </ShortcutTooltip>
        )}
        <span className="text-xs text-sol-text truncate min-w-0">{input.description || (isBackground ? "background command" : "background watch")}</span>
        {(row?.eventCount ?? 0) > 0 && (
          <span className="ml-auto shrink-0 text-[10px] text-sol-text-dim tabular-nums">
            {row!.eventCount} event{row!.eventCount === 1 ? "" : "s"}
          </span>
        )}
        <span
          className={`${(row?.eventCount ?? 0) > 0 ? "" : "ml-auto "}shrink-0 inline-flex items-center gap-1 px-1.5 py-0 rounded text-[9px] font-semibold border ${badge.cls}`}
          title={input.timeout_ms !== undefined ? `Timeout: ${fmtDuration(input.timeout_ms)}` : undefined}
        >
          {watching && <span className="w-1 h-1 rounded-full bg-sol-green animate-pulse motion-reduce:animate-none" />}
          {badge.label}
        </span>
      </div>
      {input.command && (
        <button
          onClick={() => setShowCommand((v) => !v)}
          className="w-full text-left px-3 pb-1.5 font-mono text-[11px] text-sol-text-dim hover:text-sol-text-muted transition-colors"
          title={showCommand ? "Collapse the watch command" : "Show the full watch command"}
        >
          {showCommand ? (
            <pre className="whitespace-pre-wrap break-words">{input.command}</pre>
          ) : (
            <span className="block truncate">{commandFirstLine}</span>
          )}
        </button>
      )}
      {row?.lastEvent && (
        <div className="mx-3 mb-2 flex items-baseline gap-1.5 min-w-0 text-[11px] leading-snug">
          <span className={`truncate min-w-0 font-medium ${watching ? "text-sol-text-muted" : "text-sol-text-dim"}`}>
            <span className="mr-0.5 text-sol-blue/50">&gt;</span>
            {row.lastEvent}
          </span>
          {row.lastEventAt !== undefined && (
            <span className="ml-auto shrink-0 text-[10px] text-sol-text-dim whitespace-nowrap" title={formatFullTimestamp(row.lastEventAt)}>
              {formatRelativeTime(row.lastEventAt)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function PlanModeBlock({ tool, result, conversationId, messageId, onSendMessage }: { tool: ToolCall; result?: ToolResult; conversationId?: string; messageId?: string; onSendMessage?: (content: string) => void }) {
  const isEnter = tool.name === "EnterPlanMode" || tool.name === "enter_plan_mode";
  const isExit = tool.name === "ExitPlanMode" || tool.name === "exit_plan_mode";
  const isWaitingForApproval = isExit && !result && !!onSendMessage;
  const [sent, setSent] = useState(false);

  // The plan markdown the agent submitted. Rendered as an annotatable document
  // while it's awaiting approval so the user can quote/comment specific sections
  // (reusing MessageReview) and send those notes back as the rejection feedback.
  let plan = "";
  try { plan = JSON.parse(tool.input)?.plan ?? ""; } catch {}

  // Namespace the plan's review batch under its own key so its comments never
  // collide with comments on this message's prose body (both render their own
  // MessageReview with the same messageId otherwise).
  const reviewKey = conversationId && messageId ? `${messageId}#plan` : undefined;
  const canReview = isWaitingForApproval && !sent && !!plan && !!conversationId && !!reviewKey;
  const pendingCount = useInboxStore((s) =>
    reviewKey ? (s.reviewComments[conversationId!] ?? []).filter((c) => c.messageId === reviewKey).length : 0,
  );

  const requestChanges = () => {
    const batch = reviewKey ? takeReviewBatch(conversationId!, reviewKey) : "";
    setSent(true);
    onSendMessage!(JSON.stringify({ __cc_poll: true, keys: ["4"], text: formatPlanFeedback(batch), display: "Requested changes" }));
  };

  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <svg className="w-3 h-3 text-sol-violet/80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
        </svg>
        <span className="font-mono text-sol-violet font-semibold text-[11px]">Plan Mode</span>
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-sol-violet/15 text-sol-violet border border-sol-violet/30">
          {isEnter ? "enter" : "exit"}
        </span>
      </div>
      {canReview && (
        <div className="mt-2 rounded-lg border border-sol-violet/25 bg-sol-violet/[0.04] px-3.5 py-3 text-sol-text prose prose-invert prose-sm max-w-none">
          <MessageReview
            conversationId={conversationId!}
            messageId={reviewKey!}
            content={plan}
            renderBlock={renderAssistantBody}
          />
        </div>
      )}
      {isWaitingForApproval && !sent && (
        <>
          <div className="flex items-center gap-1.5 mt-2 ml-0.5 flex-wrap">
            <button
              onClick={() => { setSent(true); onSendMessage(JSON.stringify({ __cc_poll: true, keys: ["1"], display: "Start (clear context)" })); }}
              className="text-[11px] px-2.5 py-1 rounded border border-sol-border/40 bg-sol-bg-alt text-sol-text hover:border-sol-green/40 hover:bg-sol-green/10 hover:text-sol-green transition-colors cursor-pointer"
            >
              Start (clear context)
            </button>
            <button
              onClick={() => { setSent(true); onSendMessage(JSON.stringify({ __cc_poll: true, keys: ["3"], display: "Start (keep context)" })); }}
              className="text-[11px] px-2.5 py-1 rounded border border-sol-border/40 bg-sol-bg-alt text-sol-text hover:border-sol-green/40 hover:bg-sol-green/10 hover:text-sol-green transition-colors cursor-pointer"
            >
              Start (keep context)
            </button>
            <button
              onClick={requestChanges}
              disabled={canReview && pendingCount === 0}
              title={canReview && pendingCount === 0 ? "Quote a section of the plan first" : undefined}
              className="text-[11px] px-2.5 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed enabled:cursor-pointer border-sol-yellow/40 bg-sol-yellow/5 text-sol-yellow enabled:hover:bg-sol-yellow/15 enabled:hover:border-sol-yellow/60"
            >
              Request changes{pendingCount > 0 ? ` (${pendingCount})` : ""}
            </button>
          </div>
          {canReview && (
            <div className="text-[10px] text-sol-text-dim mt-1.5 ml-0.5 italic">
              {pendingCount > 0
                ? `${pendingCount} note${pendingCount === 1 ? "" : "s"} will be sent to the agent.`
                : "Hover any part of the plan to quote it, then request changes."}
            </div>
          )}
        </>
      )}
      {sent && (
        <div className="text-[10px] text-sol-text-dim mt-1 ml-0.5 italic">Message sent</div>
      )}
    </div>
  );
}

const _askUserSentState = new Map<string, Record<number, Array<{ key: string; label: string; text?: string }>>>();

// The poll wire format (option keys, free-text decline, submit chords) lives in
// lib/pollPayload so the decision queue answers polls the exact same way.

// The check glyph shown in a selected poll option's index slot / pill.
function PollCheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}

function AskUserQuestionBlock({ tool, result, onSendMessage }: { tool: ToolCall; result?: ToolResult; onSendMessage?: (content: string) => void }) {
  let parsedInput: { questions?: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect?: boolean; multi_select?: boolean; isConfirmation?: boolean }>; answers?: Record<string, string> } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}
  const [sent, setSent] = useState(() => _askUserSentState.has(tool.id));
  // Per-question selections. multiSelect questions hold several entries (checkbox
  // semantics); single-select questions hold at most one.
  const [selections, setSelections] = useState<Record<number, Array<{ key: string; label: string; text?: string }>>>(() => _askUserSentState.get(tool.id) ?? {});
  const [otherOpen, setOtherOpen] = useState<Record<number, boolean>>({});
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});

  const questions = (parsedInput.questions || []).map((q) => ({
    ...q,
    multiSelect: q.multiSelect ?? q.multi_select,
  }));
  if (questions.length === 0) return null;

  const isMultiQuestion = questions.length > 1;
  const isConfirmation = questions[0]?.isConfirmation;
  const anyMultiSelect = questions.some(q => q.multiSelect);
  // multiSelect answers can't auto-submit on first click, so they share the
  // multi-question "pick everything, then submit" flow.
  const needsSubmit = isMultiQuestion || anyMultiSelect;

  let answers: Record<string, string> = {};
  if (parsedInput.answers && typeof parsedInput.answers === "object") {
    answers = parsedInput.answers;
  } else if (result?.content) {
    const regex = /"([^"]+)"="([^"]+)"/g;
    let match;
    while ((match = regex.exec(result.content)) !== null) {
      answers[match[1]] = match[2];
    }
  }

  const isInteractive = !result && !!onSendMessage && !sent;
  const allAnswered = needsSubmit && questions.every((_, i) => (selections[i]?.length ?? 0) > 0);

  const buildPayload = (sels: typeof selections) => buildPollPayload(questions, sels);

  const handleSubmitAll = () => {
    if (!onSendMessage || !allAnswered) return;
    _askUserSentState.set(tool.id, selections);
    setSent(true);
    onSendMessage(buildPayload(selections));
  };

  const commitOther = (qIdx: number, text: string, optionsCount: number) => {
    const otherKey = String(optionsCount + 1);
    const sel = { key: otherKey, label: text, text };
    if (questions[qIdx]?.multiSelect) {
      // Joins the toggled options (replacing any previous custom entry); sent on Submit.
      setSelections(prev => ({ ...prev, [qIdx]: [...(prev[qIdx] ?? []).filter(s => s.text === undefined), sel] }));
    } else if (isMultiQuestion) {
      setSelections(prev => ({ ...prev, [qIdx]: [sel] }));
    } else {
      const newSels = { 0: [sel] };
      _askUserSentState.set(tool.id, newSels);
      setSelections(newSels);
      setSent(true);
      onSendMessage!(buildPayload(newSels));
    }
  };

  return (
    <div className="my-1.5 ml-1 border-l-2 border-sol-violet/30 pl-3 space-y-2.5">
      {questions.map((q, i) => {
        const answer = answers[q.question];
        // A multiSelect answer arrives as the chosen labels joined with ", " (the CLI's
        // own join) — split it back so each chosen option lights up individually.
        const answerParts = answer === undefined ? [] : q.multiSelect ? answer.split(", ") : [answer];
        const matchesOption = (part: string) => q.options.some(
          o => o.label === part || o.label.replace(" (Recommended)", "") === part
        );
        const customAnswer = answerParts.filter(p => !matchesOption(p)).join(", ");
        const isCustom = customAnswer !== "";
        const sels = selections[i] ?? [];
        const otherSel = sels.find(s => s.text !== undefined);
        const isOtherSelected = otherSel !== undefined;
        // Rich layout (numbered rows with stacked descriptions) when any option carries a
        // description or preview; otherwise compact borderless pills.
        const hasRich = q.options.some(o => o.description || o.preview);
        return (
          <div key={i} className="space-y-2">
            {q.header && (
              <div>
                <span className="inline-block text-[9px] uppercase tracking-[0.09em] font-semibold px-1.5 py-0.5 rounded bg-sol-violet/15 text-sol-violet">
                  {q.header}
                </span>
              </div>
            )}
            <div className="text-[13px] leading-snug font-medium text-sol-text-secondary">
              {q.question}
              {q.multiSelect && isInteractive && (
                <span className="ml-2 text-[10px] font-normal uppercase tracking-[0.07em] text-sol-text-dim">select all that apply</span>
              )}
            </div>
            <div className={hasRich ? "flex flex-col gap-0.5" : "flex flex-wrap gap-1.5"}>
              {q.options.map((opt, j) => {
                // Synthetic CLI menu chrome scraped as bare options — drop it. Keep the
                // index `j` so the surviving options retain their positional poll keys.
                if (SYNTHETIC_POLL_OPTION.test(opt.label.trim())) return null;
                const cleanLabel = opt.label.replace(" (Recommended)", "");
                const isSelected = answerParts.some(p => opt.label === p || cleanLabel === p);
                const isLocalSelected = sels.some(s => s.text === undefined && s.label === cleanLabel);
                const on = isSelected || isLocalSelected;
                const choose = () => {
                  setOtherOpen(prev => ({ ...prev, [i]: false }));
                  const pollKey = pollKeyForOption(j, isConfirmation);
                  const sel = { key: pollKey, label: cleanLabel };
                  if (q.multiSelect) {
                    // Checkbox semantics: clicking toggles; Submit sends.
                    setSelections(prev => {
                      const cur = prev[i] ?? [];
                      const has = cur.some(s => s.text === undefined && s.key === pollKey);
                      return { ...prev, [i]: has ? cur.filter(s => s.text !== undefined || s.key !== pollKey) : [...cur, sel] };
                    });
                  } else if (isMultiQuestion) {
                    setSelections(prev => ({ ...prev, [i]: [sel] }));
                  } else {
                    const newSels = { ...selections, [i]: [sel] };
                    _askUserSentState.set(tool.id, newSels);
                    setSelections(newSels);
                    setSent(true);
                    onSendMessage!(JSON.stringify({ __cc_poll: true, keys: [pollKey], display: cleanLabel }));
                  }
                };
                // Rich row: a numbered index slot (becomes a check when chosen) plus the
                // label stacked above its description — no per-option border, just a soft
                // hover/selected fill.
                // multiSelect renders the index slot as an empty checkbox outline so the
                // rows read as toggles, not a pick-one menu.
                const marker = (
                  <span className={`mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-[10px] font-semibold tabular-nums leading-none transition-colors ${
                    on
                      ? isInteractive ? "bg-sol-violet text-white" : "bg-sol-green text-white"
                      : q.multiSelect && isInteractive ? "border border-sol-violet/40 text-sol-violet/80 group-hover/opt:bg-sol-violet/15"
                      : isInteractive ? "bg-sol-violet/15 text-sol-violet/80 group-hover/opt:bg-sol-violet/25" : "bg-sol-border/15 text-sol-text-dim"
                  }`}>
                    {on ? <PollCheckIcon className="w-2.5 h-2.5" /> : j + 1}
                  </span>
                );
                const body = (
                  <span className="min-w-0 flex-1 leading-snug">
                    <span className={`text-xs font-medium ${
                      on ? (isInteractive ? "text-sol-violet" : "text-sol-green") : isInteractive ? "text-sol-violet/90" : "text-sol-text-dim"
                    }`}>{opt.label}</span>
                    {opt.description && (
                      <span className="mt-0.5 block text-xs leading-relaxed text-sol-text-dim">{opt.description}</span>
                    )}
                  </span>
                );
                const rowCls = `group/opt flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors ${
                  isInteractive ? "cursor-pointer " : ""
                }${on ? (isInteractive ? "bg-sol-violet/12" : "bg-sol-green/10") : (isInteractive ? "hover:bg-sol-violet/10" : "")}`;
                const node = hasRich ? (
                  isInteractive
                    ? <button type="button" onClick={choose} className={rowCls}>{marker}{body}</button>
                    : <div className={rowCls}>{marker}{body}</div>
                ) : isInteractive ? (
                  <button
                    type="button"
                    onClick={choose}
                    className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full transition-colors cursor-pointer ${
                      on ? "bg-sol-violet text-white" : "bg-sol-violet/12 text-sol-violet hover:bg-sol-violet/25"
                    }`}
                  >
                    {on && <PollCheckIcon className="w-3 h-3" />}
                    {opt.label}
                  </button>
                ) : (
                  <span className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full ${
                    on ? "bg-sol-green text-white" : "bg-sol-border/12 text-sol-text-dim"
                  }`}>
                    {on && <PollCheckIcon className="w-3 h-3" />}
                    {opt.label}
                  </span>
                );
                // An option's `preview` is the ASCII/mockup the terminal shows in a side
                // box — surface it so the web user sees the same detail. Show it while
                // interactive (read before clicking, since one click submits) and on the
                // chosen option once answered. In rich mode it sits indented under the label.
                const showPreview = !!opt.preview && (isInteractive || on);
                return showPreview ? (
                  <div key={j} className={hasRich ? "" : "w-full"}>
                    {node}
                    <div className={hasRich ? "pl-9 pr-2 pt-0.5" : "mt-1"}>
                      <OptionPreview preview={opt.preview!} />
                    </div>
                  </div>
                ) : (
                  <Fragment key={j}>{node}</Fragment>
                );
              })}
              {isInteractive && !otherOpen[i] && (
                hasRich ? (
                  <button
                    type="button"
                    onClick={() => {
                      setOtherOpen(prev => ({ ...prev, [i]: true }));
                      setSelections(prev => ({ ...prev, [i]: q.multiSelect ? (prev[i] ?? []).filter(s => s.text === undefined) : [] }));
                    }}
                    className={`group/opt flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer ${
                      isOtherSelected ? "bg-sol-blue/12" : "hover:bg-sol-blue/10"
                    }`}
                  >
                    <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md text-[12px] leading-none transition-colors ${
                      isOtherSelected ? "bg-sol-blue text-white" : "bg-sol-border/15 text-sol-text-dim group-hover/opt:bg-sol-blue/25 group-hover/opt:text-sol-blue"
                    }`}>
                      {isOtherSelected ? <PollCheckIcon className="w-2.5 h-2.5" /> : "+"}
                    </span>
                    <span className={`text-xs ${isOtherSelected ? "font-medium text-sol-blue" : "text-sol-text-dim group-hover/opt:text-sol-blue/90"}`}>
                      {isOtherSelected ? otherSel!.label : "Other"}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setOtherOpen(prev => ({ ...prev, [i]: true }));
                      setSelections(prev => ({ ...prev, [i]: q.multiSelect ? (prev[i] ?? []).filter(s => s.text === undefined) : [] }));
                    }}
                    className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full transition-colors cursor-pointer ${
                      isOtherSelected ? "bg-sol-blue text-white font-medium" : "bg-sol-border/12 text-sol-text-dim hover:bg-sol-blue/18 hover:text-sol-blue"
                    }`}
                  >
                    {isOtherSelected ? <PollCheckIcon className="w-3 h-3" /> : <span className="text-[13px] leading-none">+</span>}
                    {isOtherSelected ? otherSel!.label : "Other"}
                  </button>
                )
              )}
              {!isInteractive && (isCustom || isOtherSelected) && (
                hasRich ? (
                  <div className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 bg-sol-blue/10">
                    <span className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md bg-sol-blue text-white">
                      <PollCheckIcon className="w-2.5 h-2.5" />
                    </span>
                    <span className="min-w-0 flex-1 text-xs font-medium text-sol-blue leading-snug">{isOtherSelected ? otherSel!.label : customAnswer}</span>
                  </div>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full bg-sol-blue text-white">
                    <PollCheckIcon className="w-3 h-3" />
                    {isOtherSelected ? otherSel!.label : customAnswer}
                  </span>
                )
              )}
            </div>
            {isInteractive && otherOpen[i] && (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  type="text"
                  value={otherTexts[i] || ""}
                  onChange={e => setOtherTexts(prev => ({ ...prev, [i]: e.target.value }))}
                  onKeyDown={e => {
                    if (e.key === "Enter" && otherTexts[i]?.trim()) {
                      commitOther(i, otherTexts[i].trim(), q.options.length);
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                    } else if (e.key === "Escape") {
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                    }
                  }}
                  placeholder="Type your answer..."
                  className="flex-1 text-xs px-2.5 py-1.5 rounded-md bg-sol-bg-alt text-sol-text placeholder:text-sol-text-dim/60 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-sol-blue/50"
                />
                <button
                  onClick={() => {
                    if (otherTexts[i]?.trim()) {
                      commitOther(i, otherTexts[i].trim(), q.options.length);
                      setOtherOpen(prev => ({ ...prev, [i]: false }));
                    }
                  }}
                  disabled={!otherTexts[i]?.trim()}
                  className="text-[11px] font-medium px-2.5 py-1.5 rounded-md bg-sol-blue text-white hover:bg-sol-blue/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  OK
                </button>
                <button
                  onClick={() => setOtherOpen(prev => ({ ...prev, [i]: false }))}
                  className="text-[11px] px-1.5 py-1.5 text-sol-text-dim hover:text-sol-text transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        );
      })}
      {isInteractive && needsSubmit && (
        <div className="pt-0.5">
          <button
            onClick={handleSubmitAll}
            disabled={!allAnswered}
            className={`text-[11px] font-medium px-3 py-1.5 rounded-md transition-colors ${
              allAnswered
                ? "bg-sol-green text-white hover:bg-sol-green/90 cursor-pointer"
                : "bg-sol-border/15 text-sol-text-dim cursor-not-allowed"
            }`}
          >
            {isMultiQuestion
              ? `Submit answers (${questions.filter((_, qi) => (selections[qi]?.length ?? 0) > 0).length}/${questions.length})`
              : `Submit (${selections[0]?.length ?? 0} selected)`}
          </button>
        </div>
      )}
    </div>
  );
}

// Reasoning text, only mounted by the caller when the conversation's global
// "Show thinking" toggle is on (off by default — see showThinking in
// ConversationView). claude/codex redact thinking server-side (empty →
// nothing renders, unchanged), but opencode/pi carry real reasoning that
// would otherwise vanish — and a reasoning-ONLY turn would disappear from
// the timeline entirely. Faded, collapsed to a 2-line preview by default,
// click to expand.
function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const isLong = lines.length > 2 || content.length > 200;
  const preview = isLong && !expanded ? lines.slice(0, 2).join("\n") : content;
  return (
    <div className="my-0.5 opacity-50">
      <div
        className={`flex items-start gap-1 ${isLong ? "cursor-pointer" : ""}`}
        onClick={() => isLong && setExpanded(!expanded)}
      >
        {isLong && (
          <svg
            className={`w-3 h-3 mt-0.5 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        )}
        <div className="flex-1 text-sol-text-muted font-mono whitespace-pre-wrap break-words text-xs">
          {preview}
          {isLong && !expanded && "…"}
        </div>
      </div>
    </div>
  );
}

const IMAGE_COLLAPSED_HEIGHT = 100;

function useSwipeToDismiss(onDismiss: () => void) {
  const [swipeY, setSwipeY] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const startY = useRef(0);

  const handlers = useMemo(() => ({
    onTouchStart: (e: React.TouchEvent) => {
      startY.current = e.touches[0].clientY;
      setSwiping(true);
      setSwipeY(0);
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (!swiping) return;
      const dy = e.touches[0].clientY - startY.current;
      setSwipeY(Math.max(0, dy));
    },
    onTouchEnd: () => {
      if (swipeY > 120) {
        onDismiss();
      }
      setSwipeY(0);
      setSwiping(false);
    },
  }), [swiping, swipeY, onDismiss]);

  const style = useMemo(() => swipeY > 0 ? {
    transform: `translateY(${swipeY}px)`,
    transition: swiping ? 'none' : 'transform 0.2s ease-out',
  } : undefined, [swipeY, swiping]);

  const backdropOpacity = swipeY > 0 ? Math.max(0.2, 1 - swipeY / 300) : 1;

  return { handlers, style, backdropOpacity, swipeY };
}

// Batched + cross-mount-cached URL resolution: one query for all visible
// images, and a remount (virtualized scroll) reuses the cached URL instead of
// re-subscribing and re-flashing "Loading…". Bytes are cache-first too
// (useStorageImageSrc): a seen image paints from the local byte cache, and the
// history prefetch warms it before the block ever mounts.
function useImageSrc(image: ImageData): { src: string | undefined; storageResolved: boolean; storageMissing: boolean } {
  // storageSrc: undefined = still resolving, null = not found, string = src
  const storageSrc = useStorageImageSrc(image.storage_id);
  const storageResolved = image.storage_id ? storageSrc !== undefined : true;
  const storageMissing = Boolean(image.storage_id) && storageSrc === null;

  // While uploading we only have the local blob: preview. After the upload
  // resolves we prefer the real storage src but fall back to the preview until
  // it resolves, so the thumbnail never flickers to "Loading…".
  const src = image.uploading && image.preview_url
    ? image.preview_url
    : image.storage_id
      ? (typeof storageSrc === "string" ? storageSrc : image.preview_url || undefined)
      : image.data
        ? `data:${image.media_type};base64,${image.data}`
        : image.preview_url || undefined;
  return { src, storageResolved, storageMissing };
}

function ImageBlock({ image }: { image: ImageData }) {
  const { src, storageResolved, storageMissing } = useImageSrc(image);
  const gallery = useImageGallery();

  // Seed "loaded" from the module cache so an already-decoded image skips the
  // overlay on remount instead of flashing it while the HTTP-cached bytes decode.
  const [loaded, setLoaded] = useState(() => hasDecodedSrc(src));
  const [errored, setErrored] = useState(false);

  useWatchEffect(() => {
    setLoaded(hasDecodedSrc(src));
    setErrored(false);
  }, [src]);

  useWatchEffect(() => {
    if (src && gallery) gallery.register(src);
  }, [src, gallery]);

  // Keep the same reserved height when a stored image is missing or undecodable.
  // Returning null here used to collapse image-heavy transcript rows after load,
  // moving the virtualizer's scroll anchor by thousands of pixels.
  if (storageMissing || errored || (!src && storageResolved)) {
    return (
      <div
        className="my-2 max-w-md rounded border border-sol-border bg-sol-bg-alt flex flex-col items-center justify-center gap-1"
        style={{ height: IMAGE_COLLAPSED_HEIGHT }}
        role="status"
      >
        <span className="text-sol-text-muted text-xs">Image unavailable</span>
        <span className="text-sol-text-dim text-[10px]">
          {errored ? "The stored image could not be decoded." : "The stored image could not be found."}
        </span>
      </div>
    );
  }

  if (!src) {
    return (
      <div className="my-2 max-w-md rounded-t border-x border-t border-sol-border bg-sol-bg-alt flex items-center justify-center" style={{ height: IMAGE_COLLAPSED_HEIGHT }}>
        <span className="text-sol-text-dim text-xs">Loading image...</span>
      </div>
    );
  }

  return (
    <div
      className="my-2 cursor-pointer relative max-w-md"
      style={{ minHeight: IMAGE_COLLAPSED_HEIGHT }}
      onClick={() => gallery?.open(src)}
    >
      {!loaded && (
        <div className="absolute inset-0 rounded-t border-x border-t border-sol-border bg-sol-bg-alt flex items-center justify-center z-10" style={{ height: IMAGE_COLLAPSED_HEIGHT }}>
          <span className="text-sol-text-dim text-xs">Loading image...</span>
        </div>
      )}
      <div
        className="overflow-hidden rounded-t border-x border-t border-sol-border hover:border-sol-blue/50 transition-all"
        style={{ height: IMAGE_COLLAPSED_HEIGHT }}
      >
        <img
          src={src}
          alt="User provided image"
          className="w-full"
          style={loaded ? undefined : { width: 0, height: 0, overflow: 'hidden', position: 'absolute' }}
          onLoad={() => { markSrcDecoded(src); setLoaded(true); }}
          onError={() => setErrored(true)}
        />
      </div>
      {loaded && !image.uploading && (
        <div
          className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none"
          style={{ background: 'linear-gradient(to bottom, transparent, var(--image-fade-bg, var(--sol-bg, #0a0a0a)))' }}
        />
      )}
      {image.uploading && (
        <div className="absolute inset-0 rounded-t bg-black/40 flex items-center justify-center z-20" style={{ height: IMAGE_COLLAPSED_HEIGHT }}>
          <svg className="w-6 h-6 animate-spin text-white" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
      )}
    </div>
  );
}

function UserIcon({ avatarUrl }: { avatarUrl?: string | null }) {
  return (
    <AvatarImg
      src={avatarUrl}
      alt=""
      className="w-6 h-6 rounded shrink-0 object-cover shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.06)]"
      fallback={
        <div className="w-6 h-6 rounded bg-sol-blue flex items-center justify-center shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </div>
      }
    />
  );
}

function CommandStatusLine({ content: rawContent, timestamp }: { content: string; timestamp: number }) {
  const content = rawContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, '').trim();
  const cmdType = getCommandType(content);
  const cmdNameMatch = content.match(/<command-name>([^<]*)<\/command-name>/) || content.match(/<command-message>([^<]*)<\/command-message>/) || content.trim().match(/^\/([\w-]+)/);
  const cmdName = cmdNameMatch?.[1]?.replace(/^\//, "");
  const cleaned = cleanContent(content);
  const rawDisplay = cleaned.slice(0, 100) || content.replace(/<[^>]+>/g, "").slice(0, 100);
  const displayText = cmdName ? rawDisplay.replace(new RegExp(`(/?${cmdName}\\s*)+`), "").trim() : rawDisplay;

  if (cmdName) {
    return (
      <div className="mb-2 px-3 py-1.5 flex items-center gap-2 text-xs">
        <svg className="w-3 h-3 text-sol-cyan/70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
        <span className="font-mono text-sol-cyan/80 font-medium">/{cmdName}</span>
        {displayText && <span className="text-[11px] text-sol-text-dim truncate">{displayText}</span>}
        <span className="text-sol-text-dim text-[10px] ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
    );
  }

  return (
    <div className="mb-2 px-3 py-1.5 flex items-center gap-2 text-xs text-sol-text-dim">
      <span className="text-sol-text-dim" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      <span className="px-1.5 py-0.5 rounded bg-sol-bg-alt/50 text-sol-text-muted font-mono text-[10px]">
        {cmdType || "status"}
      </span>
      <span className="font-mono truncate">{displayText}</span>
    </div>
  );
}

// A slash command shows up in the transcript as two consecutive user messages: the
// invocation (<command-name> + <command-args>) and its expansion (the body of the
// command's .md file). parseCommandInvocation pulls the name + the args the user
// actually typed out of the first; cleanCommandExpansion strips the wrapper tags and
// skill preamble off the second so it renders as clean markdown.
//
// Three stored forms are handled:
//   tagged    "<command-message>x</command-message>\n<command-name>/x</command-name>\n<command-args>a</command-args>"
//   slash     "/x a"                                   (user-typed, single line)
//   stripped  "x\n/x\na"                               (legacy: tags removed, values kept on lines)
// The stripped form is what older sync versions persisted; isStrippedCommand below
// recognizes it (line 2 is "/" + line 1) so it still classifies + renders as a command.
function isStrippedCommand(content: string): { cmdName: string; rest: string } | null {
  const lines = content.split("\n");
  const first = lines[0]?.trim() ?? "";
  if (lines.length >= 2 && /^[A-Za-z][\w-]*$/.test(first) && lines[1].trim() === "/" + first) {
    return { cmdName: first, rest: lines.slice(2).join("\n") };
  }
  return null;
}

function parseCommandInvocation(raw: string): { cmdName: string; args: string } {
  const stripImages = (s: string) =>
    s.replace(/\[Image[:\s][^\]]*\]/gi, "").replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "").trim();
  const content = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .trim();
  const nameMatch =
    content.match(/<command-name>([^<]*)<\/command-name>/) ||
    content.match(/<command-message>([^<]*)<\/command-message>/);
  if (nameMatch) {
    const argsMatch = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return { cmdName: nameMatch[1].replace(/^\//, "").trim(), args: stripImages(argsMatch?.[1] ?? "") };
  }
  const stripped = isStrippedCommand(content);
  if (stripped) return { cmdName: stripped.cmdName, args: stripImages(stripped.rest) };
  const slash = content.match(/^\/([\w-]+)([\s\S]*)$/);
  if (slash) return { cmdName: slash[1], args: stripImages(slash[2] ?? "") };
  return { cmdName: "", args: stripImages(content) };
}

function cleanCommandExpansion(raw: string): string {
  return raw
    .replace(/<command-name>[^<]*<\/command-name>\s*/g, "")
    .replace(/<command-message>[^<]*<\/command-message>\s*/g, "")
    .replace(/<command-args>[\s\S]*?<\/command-args>\s*/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .replace(/^Base directory for this skill:[^\n]*\n?/, "")
    .trim();
}

const CMD_MD_COMPONENTS = {
  code: EntityAwareCode,
  a: EntityAwareLink,
  img: ({ src, alt }: { src?: string; alt?: string }) => <CollapsibleImage src={src} alt={alt} />,
  p: ImageRowParagraph,
  pre: ({ node, children, ...props }: any) => renderMarkdownPre(node, children, props),
};

// Renders a slash command as a single user-message-styled block: the command chip +
// the args the user typed (in full), with the command's .md body tucked behind a
// disclosure. Replaces the old two-pill rendering (invocation status line + a separate
// skill-expansion block). Falls back to the lightweight CommandStatusLine for command
// *output* (local-command-stdout/stderr, caveats), which carries no command name.
function CommandMessageBlock({
  content, expansion, timestamp, userName, avatarUrl, agentType, messageId,
}: {
  content: string;
  expansion?: string;
  timestamp: number;
  userName?: string;
  avatarUrl?: string | null;
  agentType?: string;
  messageId?: string;
}) {
  const [showSource, setShowSource] = useState(false);
  const { cmdName, args } = parseCommandInvocation(content);

  if (!cmdName) return <CommandStatusLine content={content} timestamp={timestamp} />;

  const source = expansion ? cleanCommandExpansion(expansion) : "";
  const argsNorm = args.replace(/\s+/g, " ").trim();
  const sourceNorm = source.replace(/\s+/g, " ").trim();
  // Skip the disclosure when the expansion is empty or just re-echoes the args
  // (some commands expand to "/cmd <args>" with no body of their own).
  const hasSource =
    sourceNorm.length > 0 &&
    sourceNorm !== argsNorm &&
    !(argsNorm.length > 0 && sourceNorm.endsWith(argsNorm) && sourceNorm.length <= argsNorm.length + cmdName.length + 4);

  const builtinDesc = getBuiltinCommands(agentType).find(c => c.name === cmdName)?.description;
  const argsIsMarkdown = hasRichMarkdown(args);

  const handleCopy = () => {
    const full = `/${cmdName}${args ? " " + args : ""}`;
    setTimeout(() => { copyToClipboard(full).then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  // Chip contents: sparkle + /name, plus a disclosure chevron when an instruction body exists.
  const chipInner = (
    <>
      <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>
      /{cmdName}
      {hasSource && <svg className={`w-3 h-3 shrink-0 text-sol-cyan/60 transition-transform ${showSource ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>}
    </>
  );

  return (
    <div id={messageId ? `msg-${messageId}` : undefined} className="group relative scroll-mt-20 bg-sol-blue/10 -mx-4 px-4 py-4 rounded-lg border border-sol-blue/30 mb-6">
      <div className="absolute -top-2 right-0 opacity-0 group-hover:opacity-100 transition-opacity bg-sol-bg rounded shadow-md px-0.5 z-10">
        <button onClick={handleCopy} className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary" title="Copy command" aria-label="Copy command">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
        </button>
      </div>

      <div className="flex items-center gap-2 mb-2">
        <UserIcon avatarUrl={avatarUrl} />
        <span className="text-sol-blue text-xs font-medium">{userName || "You"}</span>
        <span className="text-sol-text-dim text-xs" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>

      <div className="pl-8">
        <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
          {hasSource ? (
            <button
              onClick={() => setShowSource(s => !s)}
              className="inline-flex items-center gap-1 font-mono text-xs text-sol-cyan bg-sol-cyan/10 border border-sol-cyan/25 rounded px-1.5 py-0.5 hover:bg-sol-cyan/20 hover:border-sol-cyan/40 transition-colors cursor-pointer"
              title={showSource ? "Hide command instructions" : "Show command instructions"}
            >
              {chipInner}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 font-mono text-xs text-sol-cyan bg-sol-cyan/10 border border-sol-cyan/25 rounded px-1.5 py-0.5">
              {chipInner}
            </span>
          )}
          {builtinDesc && <span className="text-[11px] text-sol-text-dim">{builtinDesc}</span>}
        </div>

        {args && (
          <div className={`text-sol-text text-sm break-words ${argsIsMarkdown ? "prose prose-invert prose-sm max-w-none" : "whitespace-pre-wrap"}`}>
            {argsIsMarkdown
              ? <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={CMD_MD_COMPONENTS}>{args}</ReactMarkdown>
              : renderWithMentions(args)}
          </div>
        )}

        {hasSource && showSource && (
          <div className="mt-2 rounded-md bg-sol-bg-alt/30 border border-sol-border/20 p-3 text-xs text-sol-text-muted leading-relaxed prose prose-invert prose-sm max-w-none overflow-x-auto">
            <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={CMD_MD_COMPONENTS}>{source}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

// `!` bash mode: the user ran a shell command straight from the Claude Code
// composer. The transcript records it as two user messages (<bash-input>, then
// <bash-stdout>/<bash-stderr>); commandExpansionMap pairs them so they render
// as ONE terminal-style card. Either half can appear alone at a page boundary.
export function BashCommandBlock({ command, stdout, stderr, timestamp, userName, avatarUrl, messageId }: {
  command?: string;
  stdout?: string;
  stderr?: string;
  timestamp: number;
  userName?: string;
  avatarUrl?: string | null;
  messageId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const out = stripAnsiCodes(stdout || "").trimEnd();
  const err = stripAnsiCodes(stderr || "").trimEnd();
  const hasOutput = stdout !== undefined || stderr !== undefined;
  const lineCount = (out ? out.split("\n").length : 0) + (err ? err.split("\n").length : 0);
  const isLong = lineCount > 12 || out.length + err.length > 1500;

  const handleCopy = () => {
    const text = command ? `!${command}` : out || err;
    setTimeout(() => { copyToClipboard(text).then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  return (
    <div id={messageId ? `msg-${messageId}` : undefined} className="group relative scroll-mt-20 bg-sol-blue/10 -mx-4 px-4 py-4 rounded-lg border border-sol-blue/30 mb-6">
      <div className="absolute -top-2 right-0 opacity-0 group-hover:opacity-100 transition-opacity bg-sol-bg rounded shadow-md px-0.5 z-10">
        <button onClick={handleCopy} className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary" title="Copy command" aria-label="Copy command">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
        </button>
      </div>

      <div className="flex items-center gap-2 mb-2">
        <UserIcon avatarUrl={avatarUrl} />
        <span className="text-sol-blue text-xs font-medium">{userName || "You"}</span>
        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-sol-magenta/80 bg-sol-magenta/10 border border-sol-magenta/25 rounded px-1.5 py-px" title="Shell command run from the composer">bash</span>
        <span className="text-sol-text-dim text-xs" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>

      <div className="pl-8">
        <div className="rounded-md bg-sol-bg-alt/50 border border-sol-border/40 font-mono text-xs overflow-hidden">
          {command !== undefined && (
            <div className="flex items-start gap-2 px-3 py-2">
              <span className="text-sol-magenta font-semibold select-none shrink-0">!</span>
              <span className="text-sol-text whitespace-pre-wrap break-all min-w-0">{command}</span>
            </div>
          )}
          {hasOutput && (
            <div className={`px-3 py-2 ${command !== undefined ? "border-t border-sol-border/30" : ""}`}>
              {out || err ? (
                <>
                  <pre className={`whitespace-pre-wrap break-all text-sol-text-muted leading-relaxed ${isLong && !expanded ? "max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]" : ""}`}>
                    {out}
                    {err && <span className="text-sol-red/90">{out ? "\n" : ""}{err}</span>}
                  </pre>
                  {isLong && (
                    <button onClick={() => setExpanded(e => !e)} className="mt-1 text-[11px] text-sol-text-dim hover:text-sol-text-secondary transition-colors">
                      {expanded ? "show less" : `show all ${lineCount} lines`}
                    </button>
                  )}
                </>
              ) : (
                <span className="text-sol-text-dim italic">no output</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SkillExpansionBlock({ content, timestamp, cmdName, collapsed }: { content: string; timestamp: number; cmdName?: string; collapsed?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const info = extractSkillInfo(content);
  const skillName = cmdName || info?.name || "skill";

  if (collapsed) {
    return (
      <div className="px-3 py-1.5 flex items-center gap-2 text-xs">
        <svg className="w-3 h-3 text-sol-cyan/70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
        <span className="font-mono text-sol-cyan/80 font-medium">/{skillName}</span>
        <span className="text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
    );
  }

  return (
    <div className="mb-2">
      <button
        onClick={() => setExpanded(e => !e)}
        className="group flex items-center gap-2 px-3 py-2 rounded-md bg-sol-bg-alt/40 border border-sol-border/30 hover:border-sol-cyan/30 transition-colors w-full text-left"
      >
        <svg className="w-3.5 h-3.5 text-sol-cyan/70 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
        </svg>
        <span className="font-mono text-xs text-sol-cyan/80 font-medium">/{skillName}</span>
        {info?.preview && !expanded && (
          <span className="text-[11px] text-sol-text-dim truncate">{info.preview}</span>
        )}
        <span className="ml-auto text-sol-text-dim text-[10px] shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        <svg className={`w-3 h-3 text-sol-text-dim transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-1 rounded-md bg-sol-bg-alt/25 border border-sol-border/20 p-3 text-xs text-sol-text-muted overflow-y-auto leading-relaxed prose prose-invert prose-sm max-w-none">
          <ReactMarkdown
            remarkPlugins={entityRemarkPlugins}
            rehypePlugins={MESSAGE_MD_REHYPE}
            components={MESSAGE_MD_COMPONENTS}
          >{content
            .replace(/<command-name>[^<]*<\/command-name>\s*/g, "")
            .replace(/<command-message>[^<]*<\/command-message>\s*/g, "")
            .replace(/^Base directory for this skill:[^\n]*\n?/, "")
            .replace(/<[^>]+>/g, "")
            .trim()}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function isInterruptMessage(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("[Request interrupted") || trimmed.startsWith("[Request cancelled");
}

function isCodexTurnAbortedMessage(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith("<turn_aborted>") && trimmed.includes("</turn_aborted>");
}

function isInterruptLikeMessage(content: string, agentType?: string): boolean {
  if (isInterruptMessage(content)) return true;
  return agentType === "codex" && isCodexTurnAbortedMessage(content);
}

function InterruptStatusLine({ label = "user interrupted", tone = "sky" }: { label?: string; tone?: "sky" | "amber" }) {
  const lineClass = tone === "amber"
    ? "flex-1 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent"
    : "flex-1 h-px bg-gradient-to-r from-transparent via-sky-400/40 to-transparent";
  const textClass = tone === "amber" ? "text-xs text-amber-500 font-medium" : "text-xs text-sky-400 font-medium";
  return (
    <div className="my-6 flex items-center gap-3">
      <div className={lineClass} />
      <span className={textClass}>{label}</span>
      <div className={lineClass} />
    </div>
  );
}

// The reorientation notice a moved session's agent receives as its first turn on
// the destination machine (cli/src/sessionMoveNotice.ts). Detected by its composed
// prefix: the notice rides the pending-message rail into the agent's pane and syncs
// back from the agent's own transcript as a plain user message, so no subtype
// survives the round-trip — the content itself is the only durable marker. Prefix
// detection also picks up every historical move already in transcripts.
function isMachineMoveNotice(content: string): boolean {
  return content.trim().startsWith("[codecast] This session just moved");
}

function parseMachineMoveNotice(content: string): { destination?: string; machineChanged: boolean } {
  const firstLine = content.trim().split("\n", 1)[0];
  const machine = firstLine.match(/moved to a different machine\. It now runs on (.+?) in \S/);
  if (machine) return { destination: machine[1], machineChanged: true };
  return { machineChanged: false };
}

// Quiet switch divider for a session that changed machines (or directories)
// mid-conversation. The gesture it reflects is "the session moved", not "someone
// typed this", so it renders as a boundary rather than a user bubble; clicking
// discloses the full notice text the agent was given.
function MachineMoveDivider({ content, destination, machineChanged, timestamp }: { content: string; destination?: string; machineChanged: boolean; timestamp: number }) {
  const [open, setOpen] = useState(false);
  const label = machineChanged ? `switched to ${destination ?? "another machine"}` : "moved to another directory";
  return (
    <div className="my-5">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 group cursor-pointer"
        title={`${formatFullTimestamp(timestamp)} — click for details`}
      >
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-sol-border to-transparent" />
        <span className="flex items-center gap-1.5 text-[11px] text-sol-text-dim group-hover:text-sol-text-muted transition-colors">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
          </svg>
          {label}
        </span>
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-sol-border to-transparent" />
      </button>
      {open && (
        <div className="mt-2 mx-auto max-w-2xl px-4 py-3 rounded-md border border-sol-border bg-sol-card text-xs text-sol-text-muted whitespace-pre-wrap leading-relaxed">
          {content.trim()}
        </div>
      )}
    </div>
  );
}

function AgentSwitchDivider({
  toLabel, fromLabel, content, timestamp,
}: {
  toLabel: string;
  fromLabel?: string;
  content: string;
  timestamp: number;
}) {
  const [open, setOpen] = useState(false);
  const caption = `now using ${toLabel}`;
  const details = content.trim();
  const hasDetails = details.includes("\n");
  return (
    <div className="my-5">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((o) => !o)}
        className={`w-full ${hasDetails ? "cursor-pointer group" : "cursor-default"}`}
        title={`${formatFullTimestamp(timestamp)}${hasDetails ? " — click for details" : ""}`}
      >
        <TimelineRule color="var(--sol-violet)" label={caption}>
          <span className="flex items-center gap-1.5 text-[11px] text-sol-text-dim group-hover:text-sol-text-muted transition-colors">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
            </svg>
            {caption}
            {fromLabel && <span className="text-sol-text-dim/70">was {fromLabel}</span>}
          </span>
        </TimelineRule>
      </button>
      {open && hasDetails && (
        <div className="mt-2 mx-auto max-w-2xl px-4 py-3 rounded-md border border-sol-border bg-sol-card text-xs text-sol-text-muted whitespace-pre-wrap leading-relaxed">
          {details}
        </div>
      )}
    </div>
  );
}

function isTaskNotification(content: string): boolean {
  return content.trim().startsWith('<task-notification>');
}

function parseTaskNotification(content: string) {
  const match = content.match(/<task-notification>[\s\S]*?<\/task-notification>/);
  return match ? parseTaskNotificationBlock(match[0]) : null;
}

function isCompactionPromptMessage(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return (
    trimmed.includes("Your task is to create a detailed summary of the conversation so far") ||
    (trimmed.startsWith("Your task is to create a detailed summary") && trimmed.includes("<summary>"))
  );
}

function extractCompactionSummaryContent(content: string): string {
  if (!content) return "";
  const summaryMatch = content.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i);
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim();
  }
  return content.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();
}

// Alarm colour is reserved for outcomes the reader has to act on. A command
// that FAILED is red; one somebody KILLED mid-flight is orange, because the
// work it was doing stopped early. "stopped" is neither: it is the harness
// tidying its books — background watches from a previous process that left no
// completion record, marked closed on the way in. Nothing is wrong and nothing
// is owed, so it wears the same quiet grey as the "monitor ended" line, and the
// unknown-status fallback lands there too rather than crying wolf.
const taskStatusConfig: Record<string, { icon: string; color: string; bg: string; accent: string; eyebrow: string; chip: string }> = {
  completed: { icon: '\u2713', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', accent: 'border-emerald-500/60 bg-emerald-500/5', eyebrow: 'text-emerald-400/70', chip: 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10' },
  killed: { icon: '\u25A0', color: 'text-sol-orange', bg: 'bg-sol-orange/10 border-sol-orange/20', accent: 'border-sol-orange/60 bg-sol-orange/5', eyebrow: 'text-sol-orange/70', chip: 'border-sol-orange/40 text-sol-orange bg-sol-orange/10' },
  failed: { icon: '\u2717', color: 'text-sol-red', bg: 'bg-sol-red/10 border-sol-red/20', accent: 'border-sol-red/60 bg-sol-red/5', eyebrow: 'text-sol-red/70', chip: 'border-sol-red/40 text-sol-red bg-sol-red/10' },
  running: { icon: '\u25B6', color: 'text-sol-blue', bg: 'bg-sol-blue/10 border-sol-blue/20', accent: 'border-sol-blue/60 bg-sol-blue/5', eyebrow: 'text-sol-blue/70', chip: 'border-sol-blue/40 text-sol-blue bg-sol-blue/10' },
  stopped: { icon: '\u25A0', color: 'text-sol-text-dim', bg: 'bg-sol-bg-alt/30 border-sol-border/40', accent: 'border-sol-border/60 bg-sol-bg-alt/30', eyebrow: 'text-sol-text-dim', chip: 'border-sol-border/60 text-sol-text-dim bg-sol-bg-alt/40' },
};

// The statuses whose notification the harness injects as a NEW user turn \u2014 the
// message the reader is looking at is what pulled the agent back to work, and
// the turn below it is the response. Those rows grow the elbow arrow pointing
// at that turn. "stopped" is excluded: those notices are resume-time
// bookkeeping riding a turn that was starting anyway.
const WAKE_STATUSES = new Set(['completed', 'failed', 'killed']);

function TaskNotificationLine({ content, timestamp, agentNameToChildMap }: { content: string; timestamp: number; agentNameToChildMap?: Record<string, string> }) {
  const parsed = parseTaskNotification(content);
  const router = useRouter();
  if (!parsed) return null;

  // Monitor traffic wears the monitor identity (radar, blue), not the generic
  // task line: an event shows WHAT the watch saw, the stream end reads as the
  // watch quietly folding — both tie back to their MonitorBlock by description.
  if (isMonitorEventNotification(parsed) && parsed.event) {
    const desc = monitorNotificationDescription(parsed);
    return (
      <div className="mb-2 px-3 py-1.5 flex items-start gap-2 text-xs border rounded border-sol-blue/20 bg-sol-blue/5">
        <Radar className="w-3.5 h-3.5 shrink-0 mt-0.5 text-sol-blue/70" />
        <span className="text-[10px] font-medium tracking-wide uppercase text-sol-blue/70 shrink-0 mt-px">monitor</span>
        <ExpandableLine
          text={decodeEntities(parsed.event)}
          className="text-sol-text-muted"
          title={desc ? `Monitor: ${desc}` : undefined}
        />
        <span className="text-sol-text-dim shrink-0 whitespace-nowrap" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
    );
  }
  if (isMonitorEndedNotification(parsed)) {
    const desc = monitorNotificationDescription(parsed);
    return (
      <div className="mb-2 px-3 py-1.5 flex items-start gap-2 text-xs border rounded border-sol-border/40 bg-sol-bg-alt/30">
        <Radar className="w-3.5 h-3.5 shrink-0 mt-0.5 text-sol-text-dim" />
        <span className="text-[10px] font-medium tracking-wide uppercase text-sol-text-dim shrink-0 mt-px">monitor ended</span>
        {desc && <ExpandableLine text={desc} className="text-sol-text-dim" />}
        <span className="text-sol-text-dim shrink-0 whitespace-nowrap ml-auto" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
    );
  }

  const cfg = taskStatusConfig[parsed.status] || taskStatusConfig.stopped;

  let childId: string | undefined;
  const nameMatch = parsed.summary.match(/['\u201c\u201d"](.*?)['\u201c\u201d"]/);
  const agentName = nameMatch?.[1];
  if (agentName && agentNameToChildMap?.[agentName]) {
    childId = agentNameToChildMap[agentName];
  }

  // The machine sentence split into visual parts (kind eyebrow, prominent
  // description, status chip) \u2014 the unquoted prose notices (orphan cleanup)
  // have no parts and keep the sentence. The wake cue marks the rows whose
  // injection is what pulled the agent back to work.
  const parts = parseNotificationSummary(parsed.summary);
  const woke = WAKE_STATUSES.has(parsed.status);

  if (parts) {
    const chipText = `${parsed.status}${parts.exitCode ? ` \u00b7 exit ${parts.exitCode}` : ''}`;
    return (
      /* Same anatomy as a session-message card (left accent, header line) \u2014
         both are machine deliveries into this thread, so they share one
         visual language. */
      <div
        className={`mb-1.5 mx-1 rounded border-l-2 ${cfg.accent}${childId ? " cursor-pointer hover:brightness-125 transition-all" : ""}`}
        onClick={childId ? () => router.push(`/conversation/${childId}`) : undefined}
      >
        <div className="flex items-start gap-2 px-3 py-2 text-xs">
          {woke ? (
            /* The wake cue takes the status glyph's slot: a corner arrow
               pointing down and into the row below \u2014 the turn this
               notification pulled the agent back for. The status itself still
               reads from the chip on the right. */
            <CornerDownRight
              className={`w-3.5 h-3.5 shrink-0 mt-px ${cfg.color}`}
              strokeWidth={2.25}
              aria-label="Woke the agent"
            />
          ) : (
            <span className={`font-mono text-sm leading-none shrink-0 mt-0.5 ${cfg.color}`}>{cfg.icon}</span>
          )}
          <span className={`text-[10px] font-medium tracking-wide uppercase shrink-0 mt-px ${cfg.eyebrow}`}>{parts.kind}</span>
          <ExpandableLine text={parts.description} className="text-sol-text font-medium" title={parsed.summary} />
          <span className={`px-1 py-0 rounded border text-[9px] font-semibold shrink-0 mt-px ${cfg.chip}`}>{chipText}</span>
          {childId && (
            <svg className={`w-3 h-3 shrink-0 mt-0.5 ${cfg.color}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          )}
          <span className="text-sol-text-dim font-mono text-[10px] shrink-0">{parsed.taskId}</span>
          <span className="text-sol-text-dim shrink-0 whitespace-nowrap" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`mb-2 px-3 py-2 flex items-start gap-2.5 text-xs border rounded ${cfg.bg}${childId ? " cursor-pointer hover:brightness-125 transition-all" : ""}`}
      onClick={childId ? () => router.push(`/conversation/${childId}`) : undefined}
    >
      <span className={`font-mono text-sm leading-none shrink-0 mt-0.5 ${cfg.color}`}>{cfg.icon}</span>
      <ExpandableLine text={parsed.summary} className="text-sol-text-muted" />
      {childId && (
        <svg className={`w-3 h-3 shrink-0 mt-0.5 ${cfg.color}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      )}
      {/* A batch notice names its tasks inside the summary itself, so pinning
          one id on the row would read as if the rest weren't there. */}
      {!isOrphanSummaryNotification(parsed) && (
        <span className="text-sol-text-dim font-mono text-[10px] shrink-0">{parsed.taskId}</span>
      )}
      <span className="text-sol-text-dim shrink-0 whitespace-nowrap" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
    </div>
  );
}

// Renders BOTH scheduled-run delivery formats: the `<scheduled-task>` wrapper an
// inject-type schedule drops into an existing conversation, and the plain-text
// prompt header (taskScheduler.buildPrompt) that opens a spawned run's transcript.
// Same block so the two paths read identically; the spawned format additionally
// carries mode, prior-run outcome, and completion-protocol boilerplate (collapsed —
// it's machine plumbing, not something the user should wade through).
function ScheduledTaskBlock({ content: rawContent, timestamp }: { content: string; timestamp: number }) {
  const [showPlumbing, setShowPlumbing] = useState(false);
  const content = rawContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const spawned = parseSpawnedTaskPrompt(content);
  const match = spawned ? null : content.match(/<scheduled-task\s+title="([^"]*)"(?:\s+task-id="([^"]*)")?[^>]*>([\s\S]*?)<\/scheduled-task>/);
  const title = spawned?.title || match?.[1]?.replace(/&quot;/g, '"') || "Trigger Run";
  const prompt = spawned?.prompt ?? (match?.[3]?.trim() || cleanStickyContent(content));
  const prevFailed = !!spawned?.previousRun && /^Failed/i.test(spawned.previousRun.summary);

  return (
    <div className="mb-2 mx-1 rounded border-l-2 border-sol-violet/60 bg-sol-violet/5">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <Zap className="w-3.5 h-3.5 text-sol-violet/70 shrink-0" />
        <span className="text-[11px] font-medium tracking-wide uppercase text-sol-violet/70 shrink-0">{spawned ? "Trigger run" : "Trigger"}</span>
        {/* Apply is the norm and unmarked; read-only runs get the chip. */}
        {spawned && spawned.mode !== "apply" && (
          <ShortcutTooltip label="Read-only run — investigates and reports, changes nothing" hint="file-editing tools are disabled">
            <span className="px-1 py-0 rounded border text-[9px] font-semibold shrink-0 border-sol-cyan/40 text-sol-cyan/90 bg-sol-cyan/10">
              read-only
            </span>
          </ShortcutTooltip>
        )}
        <span className="text-xs text-sol-text-muted truncate">{title}</span>
        <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
      {/* The prompt is authored markdown in both wire formats (spawn header
          and <scheduled-task> inject) — render it as prose either way. A trigger
          briefing is often long, so it starts clipped behind an Expand. */}
      <CollapsibleBody className="px-3 pb-2" toggleClassName="mt-1">
        <div className="text-sm text-sol-text prose prose-invert prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MD_COMPONENTS_NO_IMG}>{prompt}</ReactMarkdown>
        </div>
      </CollapsibleBody>
      {spawned?.contextSummary && (
        <div className="mx-3 mb-2 rounded border border-sol-border/30 bg-sol-bg/40 px-2 py-1.5 text-[11px] leading-relaxed text-sol-text-muted">
          <span className="font-medium text-sol-text-dim">Context from originating session: </span>
          {spawned.contextSummary}
        </div>
      )}
      {spawned?.previousRun && (
        <div className={`mx-3 mb-2 rounded border px-2 py-1.5 text-[11px] leading-relaxed ${prevFailed ? "border-sol-red/30 bg-sol-red/5 text-sol-red/90" : "border-sol-border/30 bg-sol-bg/40 text-sol-text-muted"}`}>
          <span className={`font-medium ${prevFailed ? "text-sol-red" : "text-sol-text-dim"}`}>Previous run ({spawned.previousRun.ago}): </span>
          {spawned.previousRun.summary}
        </div>
      )}
      {spawned?.instructions && (
        <div className="px-3 pb-2">
          <button
            onClick={() => setShowPlumbing(!showPlumbing)}
            className="flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text-muted transition-colors"
          >
            {showPlumbing ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
            run instructions
          </button>
          {showPlumbing && (
            <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-sol-border/30 bg-sol-bg/60 p-2 text-[10px] leading-relaxed text-sol-text-dim font-mono">{spawned.instructions}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// The /loop heartbeat, in the trigger family's visual language. A
// ScheduleWakeup call is the agent arming its own next fire — standing intent,
// same anatomy as the trigger blocks above (violet accent, Zap identity) so a
// self-pacing loop reads as what it is instead of a raw tool row. stop:true is
// the loop's deliberate end. The tool result adds nothing the input doesn't
// already say (the fire time), so it only surfaces on error.
function ScheduleWakeupBlock({ tool, result, timestamp }: { tool: ToolCall; result?: ToolResult; timestamp: number }) {
  const [showPrompt, setShowPrompt] = useState(false);
  let input: { delaySeconds?: number; reason?: string; prompt?: string; stop?: boolean } = {};
  try {
    input = JSON.parse(tool.input || "{}");
  } catch { /* malformed input renders as an empty arm */ }

  if (input.stop) {
    return (
      <div className="mb-2 mx-1 rounded border-l-2 border-sol-violet/40 bg-sol-violet/5">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <Zap className="w-3.5 h-3.5 text-sol-violet/50 shrink-0" />
          <span className="text-[11px] font-medium tracking-wide uppercase text-sol-violet/60 shrink-0">Loop ended</span>
          <span className="text-xs text-sol-text-muted truncate">the agent stopped scheduling wakeups</span>
          <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        </div>
      </div>
    );
  }

  const delayMs = Math.max(0, (input.delaySeconds ?? 0) * 1000);
  const wakeAt = timestamp + delayMs;
  return (
    <div className="mb-2 mx-1 rounded border-l-2 border-sol-violet/60 bg-sol-violet/5">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <Zap className="w-3.5 h-3.5 text-sol-violet/70 shrink-0" />
        <span className="text-[11px] font-medium tracking-wide uppercase text-sol-violet/70 shrink-0">Wakeup</span>
        {delayMs > 0 && (
          <ShortcutTooltip label={`Fires at ${fmtClock(wakeAt)}`}>
            <span className="px-1 py-0 rounded border text-[9px] font-semibold shrink-0 tabular-nums border-sol-violet/40 text-sol-violet/90 bg-sol-violet/10">
              in {fmtDuration(delayMs)}
            </span>
          </ShortcutTooltip>
        )}
        {input.reason && <span className="text-xs text-sol-text-muted truncate">{input.reason}</span>}
        <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
      </div>
      {result?.is_error && (
        <div className="mx-3 mb-2 rounded border border-sol-red/30 bg-sol-red/5 px-2 py-1.5 text-[11px] leading-relaxed text-sol-red/90">
          {result.content.slice(0, 300)}
        </div>
      )}
      {input.prompt && (
        <div className="px-3 pb-2">
          <button
            onClick={() => setShowPrompt(!showPrompt)}
            className="flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text-muted transition-colors"
          >
            {showPrompt ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
            wakeup prompt
          </button>
          {showPrompt && <TriggerPromptView prompt={input.prompt} className="mt-1" />}
        </div>
      )}
    </div>
  );
}

function SessionMessageBlock({ from, name, body, timestamp, pendingStatus, recipientActive, variant = "session", color, summary, linkToConversationId }: { from: string; name?: string; body: string; timestamp?: number; pendingStatus?: string; recipientActive?: boolean; variant?: "session" | "teammate"; color?: string; summary?: string; linkToConversationId?: string }) {
  // pendingStatus set ⇒ this is a server-side pending_messages row that hasn't reached the
  // recipient's transcript yet (queued — typically because the recipient is mid-turn).
  const isPending = !!pendingStatus;
  const queueLabel = !isPending
    ? null
    : pendingStatus === "failed" || pendingStatus === "undeliverable"
    ? "queued · retrying"
    : recipientActive === false
    ? "queued · recipient offline"
    : "queued · recipient busy";
  // The SAME card renders an inter-agent teammate broadcast — only slightly distinct: a Users
  // icon + "From teammate" + the sender's own color, vs. cast send's CornerDownRight +
  // "Message from" + fixed cyan. A teammate's id isn't a real session, so it's a plain badge
  // (not an EntityIdPill), and its summary attribute rides in the header as a secondary label.
  const isTeammate = variant === "teammate";
  const HeaderIcon = isTeammate ? Users : CornerDownRight;
  const accent = isPending
    ? "border-amber-500/50 bg-amber-500/5"
    : isTeammate
    ? `${agentBorderMap[color || "blue"] || agentBorderMap.blue} bg-sol-bg-alt/30`
    : "border-sol-cyan/60 bg-sol-cyan/5";
  const labelText = isPending ? "text-amber-400/80" : isTeammate ? "text-sol-text-dim/70" : "text-sol-cyan/70";
  const iconText = isPending ? "text-amber-400/70" : isTeammate ? "text-sol-text-dim/60" : "text-sol-cyan/70";
  return (
    <div className={`mb-2 mx-1 rounded border-l-2 ${accent}`}>
      <div className="flex items-center gap-2 px-3 pt-2 pb-1">
        <HeaderIcon className={`w-3.5 h-3.5 shrink-0 ${iconText}`} />
        <span className={`text-[11px] font-medium tracking-wide uppercase shrink-0 ${labelText}`}>{isTeammate ? "From teammate" : "Message from"}</span>
        {isTeammate ? (
          // A teammate's name isn't a session id, so it can't be an EntityIdPill —
          // but when the sender is resolvable (team-lead → this conversation's
          // spawned_by parent) the badge clicks through to that session.
          linkToConversationId ? (
            <button
              onClick={() => useInboxStore.getState().navigateToSession(linkToConversationId)}
              className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 cursor-pointer hover:underline underline-offset-2 ${agentColorMap[color || "blue"] || agentColorMap.blue}`}
              title="View the sender's session"
            >
              {from}
            </button>
          ) : (
            <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 ${agentColorMap[color || "blue"] || agentColorMap.blue}`}>{from}</span>
          )
        ) : from && from !== "unknown" ? (
          <EntityIdPill shortId={from} />
        ) : name ? (
          <span className="text-xs font-medium text-sol-cyan/90">{name}</span>
        ) : (
          <span className="text-xs text-sol-text-muted">another session</span>
        )}
        {isTeammate && summary && (
          <span className="text-[10px] uppercase tracking-wider font-medium text-sol-text-dim/50 truncate">{summary}</span>
        )}
        {queueLabel && (
          <span className="inline-flex items-center gap-1 text-[10px] font-mono text-amber-400 bg-amber-500/15 border border-amber-500/25 rounded px-1.5 py-0.5 shrink-0">
            <Clock className="w-2.5 h-2.5" />{queueLabel}
          </span>
        )}
        {timestamp != null && timestamp > 0 && (
          <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        )}
      </div>
      {/* A message from another session is someone else's context, not this
          thread's — it starts clipped so a long handoff doesn't bury the reply. */}
      <CollapsibleBody className="px-3 pb-2" toggleClassName="mt-1">
        <div className={`text-sm text-sol-text prose prose-invert prose-sm max-w-none ${isPending ? "opacity-70" : ""}`}>
          <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE}
            components={MESSAGE_MD_COMPONENTS}
          >{body}</ReactMarkdown>
        </div>
      </CollapsibleBody>
    </div>
  );
}

// ── Team chat: the anchor's inbound wake and its outbound reply ─────────────
// A mention in team chat wakes the anchor session with a plain-text prompt
// (convex/chat.ts buildAnchorWake): the channel, who asked, the quoted thread,
// and the `cast chat reply` it should run. The transcript shows the exchange
// the way chat does — a channel pill, the thread's lines by speaker — and hides
// the framing that exists only to brief the agent.

// Where a chat card clicks through: the channel, positioned on a message when
// one is known. Mirrors convex/chatText.ts chatPermalink.
function chatHref(channelId?: string, messageId?: string): string | null {
  if (!channelId) return null;
  return messageId ? `/chat/${channelId}?m=${messageId}` : `/chat/${channelId}`;
}

function ChatChannelPill({ name, href }: { name: string; href: string | null }) {
  const cls = "inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-sol-magenta/30 bg-sol-magenta/10 text-sol-magenta text-[11px] font-mono shrink-0";
  const inner = <><Hash className="w-3 h-3" />{name}</>;
  return href ? (
    <Link href={href} className={`${cls} hover:bg-sol-magenta/20 hover:underline underline-offset-2`} title="Open in team chat">{inner}</Link>
  ) : (
    <span className={cls}>{inner}</span>
  );
}

// A huddle that ended in this session's room. The same turn woke the agent
// with the summary and the `cast call` pointer; this renders it the way the
// human should read it — the digest, and the transcript unfoldable under it.
function HuddleSummaryBlock({ huddle, timestamp }: { huddle: HuddleSummaryTag; timestamp?: number }) {
  // The header already names the call and who was on it; drop the digest's own
  // lead line so the card doesn't say it twice.
  const body = huddle.body.replace(/^\*\*[^\n]*\n+/, "");
  return (
    <div className="mb-2 mx-1 rounded border-l-2 border-sol-green/60 bg-sol-green/5">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 flex-wrap">
        <PhoneCall className="w-3.5 h-3.5 shrink-0 text-sol-green/70" />
        <span className="text-[11px] font-medium tracking-wide uppercase shrink-0 text-sol-green/70">Huddle</span>
        <span className="text-xs font-medium text-sol-text truncate">{huddle.title}</span>
        <span className="text-[11px] text-sol-text-dim truncate">
          {huddle.minutes > 0 ? `${huddle.minutes} min` : ""}
          {huddle.minutes > 0 && huddle.speakers.length > 0 ? " · " : ""}
          {huddle.speakers.join(", ")}
        </span>
        {timestamp != null && timestamp > 0 && (
          <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        )}
      </div>
      <CollapsibleBody className="px-3" toggleClassName="mt-1">
        <div className="text-sm text-sol-text prose prose-invert prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE}
            components={MESSAGE_MD_COMPONENTS}
          >{body}</ReactMarkdown>
        </div>
      </CollapsibleBody>
      <CallTranscriptDisclosure transcriptId={huddle.transcriptId} className="px-3 pb-2 pt-1" />
    </div>
  );
}

function ChatWakeBlock({ wake, timestamp }: { wake: ChatWakePrompt; timestamp?: number }) {
  // Land on the thread. A permalink to a REPLY opens the thread panel; the root
  // alone would only scroll the channel — so prefer the anchor's placeholder,
  // which is always a reply, and fall back to the root.
  const href = chatHref(wake.channelId, wake.placeholderId ?? wake.threadRootId);
  return (
    <div className="mb-2 mx-1 rounded border-l-2 border-sol-magenta/60 bg-sol-magenta/5">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 flex-wrap">
        <MessageSquare className="w-3.5 h-3.5 shrink-0 text-sol-magenta/70" />
        <span className="text-[11px] font-medium tracking-wide uppercase shrink-0 text-sol-magenta/70">Team chat</span>
        <ChatChannelPill name={wake.channelName} href={href} />
        <span className="text-xs text-sol-text-muted truncate">
          <span className="text-sol-text font-medium">{wake.askerName}</span>
          {wake.addressed ? " mentioned you" : " replied in a thread"}
        </span>
        {timestamp != null && timestamp > 0 && (
          <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
        )}
      </div>
      <CollapsibleBody className="px-3 pb-2" toggleClassName="mt-1">
        <div className="space-y-1.5">
          {wake.entries.map((entry, i) => (
            <div key={i} className="flex gap-2 text-sm">
              <span className={`shrink-0 font-medium ${entry.self ? "text-sol-magenta/80" : "text-sol-text"}`}>
                {entry.self ? "You" : entry.name}
              </span>
              <div className="min-w-0 text-sol-text prose prose-invert prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE}
                  components={MESSAGE_MD_COMPONENTS}
                >{entry.content}</ReactMarkdown>
              </div>
            </div>
          ))}
          {wake.entries.length === 0 && (
            <span className="text-xs text-sol-text-dim italic">thread excerpt not available</span>
          )}
        </div>
      </CollapsibleBody>
    </div>
  );
}

// The outgoing half. A reply names only the placeholder id, so the channel and
// the thread come from the chat store (fetched on demand when this client has
// not paged to that message) — the header stays honest when they are unknown.
function CastChatSendBlock({ send, isReply, isError }: { send: ChatSendArgs; isReply: boolean; isError: boolean }) {
  const wake = useContext(ChatWakeContext)[send.messageId ?? ""];
  // The wake that asked is the first source; the chat store (fetched on demand)
  // covers a reply whose wake was compacted away or a `cast chat send`.
  const lookupId = isReply && !wake ? send.messageId : undefined;
  useEnsureChatMessage(lookupId);
  const row = useChatMessageRow(lookupId);
  const channelId = send.channelId ?? wake?.channelId ?? row?.channel_id;
  const storeName = useInboxStore((s) => (channelId ? s.chatChannels[channelId]?.name : undefined));
  const channelName = wake?.channelName ?? storeName;
  const href = chatHref(channelId, isReply ? send.messageId : send.threadRootId);
  const declinedByFlag = send.status === "error";
  // The server's own verdict on the reply outranks the command's flag.
  const declined = row?.agent_status === "error" || (row?.agent_status == null && declinedByFlag);
  // A reply always lands in the thread it was asked in; only a send needs the label.
  const inThread = !isReply && !!send.threadRootId;
  return (
    <div className="my-2 mx-1 rounded border-l-2 border-sol-magenta/60 bg-sol-magenta/5">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 flex-wrap">
        <CornerUpRight className="w-3.5 h-3.5 text-sol-magenta/70 shrink-0" />
        <span className="text-[11px] font-medium tracking-wide uppercase text-sol-magenta/70 shrink-0">{isReply ? "Reply in chat" : "Message to chat"}</span>
        {channelName ? (
          <ChatChannelPill name={channelName} href={href} />
        ) : href ? (
          <Link href={href} className="text-[11px] font-mono text-sol-magenta hover:underline underline-offset-2">open thread</Link>
        ) : null}
        {inThread && <span className="text-[10px] text-sol-text-dim">in thread</span>}
        {isError ? (
          <span className="text-sol-red/80 text-[10px] ml-auto shrink-0">failed</span>
        ) : declined ? (
          <span className="text-sol-red/80 text-[10px] ml-auto shrink-0">could not answer</span>
        ) : (
          <span className="text-sol-green/70 text-[10px] ml-auto shrink-0 inline-flex items-center gap-0.5"><Check className="w-3 h-3" />sent</span>
        )}
      </div>
      {send.kind === "dynamic" ? (
        <div className="px-3 pb-2">
          <code className="text-xs font-mono text-sol-text-secondary break-all">{send.body}</code>
          <div className="text-[10px] text-sol-text-dim mt-1">shown as typed — the shell filled in the actual message; open the thread to read what arrived</div>
        </div>
      ) : (
        <div className="px-3 pb-2 text-sm text-sol-text prose prose-invert prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE}
            components={MESSAGE_MD_COMPONENTS}
          >{send.body}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

const USER_CONTENT_MAX_HEIGHT = 1800;

function parseSkillBlocks(text: string): { parts: Array<{ type: 'text' | 'skill'; content: string; skillName?: string; skillDesc?: string; skillPath?: string }>} {
  if (!text || typeof text !== 'string') {
    return { parts: [{ type: 'text', content: String(text || '') }] };
  }
  const parts: Array<{ type: 'text' | 'skill'; content: string; skillName?: string; skillDesc?: string; skillPath?: string }> = [];
  const skillRegex = /<skill>([\s\S]*?)<\/skill>/g;
  let lastIndex = 0;
  let match;
  while ((match = skillRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) parts.push({ type: 'text', content: before });
    }
    const inner = match[1];
    const nameMatch = inner.match(/<name>(.*?)<\/name>/);
    const pathMatch = inner.match(/<path>(.*?)<\/path>/);
    const descMatch = inner.match(/description:\s*(.+)/);
    parts.push({
      type: 'skill',
      content: match[0],
      skillName: nameMatch?.[1],
      skillDesc: descMatch?.[1]?.trim(),
      skillPath: pathMatch?.[1],
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) parts.push({ type: 'text', content: remaining });
  }
  if (parts.length === 0) parts.push({ type: 'text', content: text });
  return { parts };
}

interface ParsedContextBlock {
  type: string;
  title: string;
  id?: string;
  status?: string;
  priority?: string;
}

function parseContextBlocks(text: string): { contexts: ParsedContextBlock[]; remaining: string } {
  const contexts: ParsedContextBlock[] = [];
  const remaining = text.replace(
    /<context\s+type="([^"]+)"\s+title="([^"]+)"(?:\s+id="([^"]+)")?\s*>\s*([\s\S]*?)\s*<\/context>\s*/g,
    (_, type, title, tagId, inner) => {
      const ctx: ParsedContextBlock = { type, title };
      if (tagId) ctx.id = tagId;
      const idMatch = inner.match(/ID:\s*(\S+)/);
      const statusMatch = inner.match(/Status:\s*(\S+)/);
      const priorityMatch = inner.match(/Priority:\s*(\S+)/);
      if (!ctx.id && idMatch) ctx.id = idMatch[1];
      if (statusMatch) ctx.status = statusMatch[1];
      if (priorityMatch) ctx.priority = priorityMatch[1];
      contexts.push(ctx);
      return "";
    }
  ).trim();
  return { contexts, remaining };
}

const CONTEXT_TYPE_CONFIG: Record<string, { icon: typeof ListChecks; colorClass: string }> = {
  task: { icon: ListChecks, colorClass: "bg-sol-violet/10 text-sol-violet border-sol-violet/20 hover:bg-sol-violet/20" },
  plan: { icon: Target, colorClass: "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/20 hover:bg-sol-cyan/20" },
  doc: { icon: FileText, colorClass: "bg-sol-violet/10 text-sol-violet border-sol-violet/20 hover:bg-sol-violet/20" },
};

function ContextBlockPill({ ctx }: { ctx: ParsedContextBlock }) {
  const router = useRouter();
  const config = CONTEXT_TYPE_CONFIG[ctx.type] || CONTEXT_TYPE_CONFIG.task;
  const Icon = config.icon;

  const route = ctx.id ? entityRoute(ctx.type, ctx.id) : null;
  const handleClick = route ? (e: React.MouseEvent) => {
    e.stopPropagation();
    router.push(route);
  } : undefined;

  return (
    <button
      onClick={handleClick}
      disabled={!handleClick}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs ${config.colorClass} ${handleClick ? "cursor-pointer" : ""}`}
    >
      <Icon className="w-3 h-3 flex-shrink-0" />
      <span className="font-medium capitalize">{ctx.type}</span>
      <span className="text-sol-text-muted truncate max-w-[250px]">{ctx.title}</span>
      {ctx.id && <EntityIdPill shortId={ctx.id} />}
    </button>
  );
}

function InsightCard({ label, content }: { label: string; content: string }) {
  return (
    <div className="my-3 rounded-lg overflow-hidden border border-sol-violet/30 bg-gradient-to-br from-sol-bg-alt via-sol-bg-alt to-sol-violet/5">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-violet/20 bg-sol-violet/8">
        <svg className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z" />
        </svg>
        <span className="text-xs font-semibold tracking-wide uppercase text-sol-violet">{label}</span>
      </div>
      <div className="px-4 py-3 text-sm text-sol-text-secondary leading-relaxed prose prose-invert prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE}
          components={MD_COMPONENTS_NO_IMG}
        >{content}</ReactMarkdown>
      </div>
    </div>
  );
}

function SkillCard({ name, description, path }: { name?: string; description?: string; path?: string }) {
  const shortPath = path ? path.replace(/^\/Users\/[^/]+\//, "~/") : undefined;
  return (
    <div className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-sol-bg-alt border border-sol-border/40 text-xs font-mono">
      <span className="text-sol-violet font-semibold">/{name || "skill"}</span>
      {description && <span className="text-sol-text-muted">{description}</span>}
      {shortPath && <span className="text-sol-text-dim text-[10px] hidden sm:inline">{shortPath}</span>}
    </div>
  );
}

// SUMMARY_LABELS and FormattedSummary live in ./FormattedSummary so EntityIdPill can reuse
// them without an import cycle; FormattedSummary is imported above.

type TeammateMessagePart = { type: 'text'; content: string } | { type: 'teammate'; teammateId: string; color?: string; summary?: string; content: string; };

function parseTeammateMessages(text: string): TeammateMessagePart[] {
  if (!text || typeof text !== 'string') {
    return [{ type: 'text', content: String(text || '') }];
  }
  const parts: TeammateMessagePart[] = [];
  const regex = /<teammate-message\s+([^>]*)>([\s\S]*?)<\/teammate-message>/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) parts.push({ type: 'text', content: before });
    }
    const attrs = match[1];
    const inner = match[2].trim();
    const idMatch = attrs.match(/teammate_id="([^"]+)"/);
    const colorMatch = attrs.match(/color="([^"]+)"/);
    const summaryMatch = attrs.match(/summary="([^"]+)"/);
    parts.push({
      type: 'teammate',
      teammateId: idMatch?.[1] || 'agent',
      color: colorMatch?.[1],
      summary: summaryMatch?.[1],
      content: inner,
    });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) parts.push({ type: 'text', content: remaining });
  }
  return parts;
}

const agentColorMap: Record<string, string> = {
  blue: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  red: "bg-red-500/20 text-red-400 border-red-500/30",
  green: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  yellow: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  purple: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  cyan: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  orange: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  pink: "bg-pink-500/20 text-pink-400 border-pink-500/30",
};

const agentBorderMap: Record<string, string> = {
  blue: "border-blue-500/30",
  red: "border-red-500/30",
  green: "border-emerald-500/30",
  yellow: "border-amber-500/30",
  purple: "border-violet-500/30",
  cyan: "border-cyan-500/30",
  orange: "border-orange-500/30",
  pink: "border-pink-500/30",
};

function TeammateEventsBlock({ content, timestamp, spawnedByConversationId }: { content: string; timestamp: number; spawnedByConversationId?: string }) {
  const parts = parseTeammateMessages(content);
  return (
    <div className="my-1 space-y-1">
      {parts.map((part, i) => {
        if (part.type === 'teammate') {
          return <TeammateMessageCard key={i} teammateId={part.teammateId} color={part.color} summary={part.summary} content={part.content} timestamp={timestamp} spawnedByConversationId={spawnedByConversationId} />;
        }
        // Drop the harness's framing boilerplate ("Another Claude session sent a
        // message:" / the "permission laundering" disclaimer) — it's machine instruction
        // to the receiving agent, not content. Keep any genuinely incidental prose.
        const text = part.content.trim();
        if (!text || isTeammateFramingOnly(text)) return null;
        return <span key={i} className="text-xs text-sol-text-dim whitespace-pre-wrap">{part.content}</span>;
      })}
    </div>
  );
}

function TeammateMessageCard({ teammateId, color, summary, content, timestamp, spawnedByConversationId }: { teammateId: string; color?: string; summary?: string; content: string; timestamp?: number; spawnedByConversationId?: string }) {
  const safeContent = content || '';
  let parsed: any = null;
  try { if (safeContent) parsed = JSON.parse(safeContent); } catch {}

  if (parsed?.type === "idle_notification") {
    const idleSummary = parsed.summary;
    if (idleSummary) {
      return (
        <div className="py-1.5 px-2.5 text-xs rounded bg-sol-bg-alt/30 border border-sol-border/10">
          <div className="flex items-center gap-2 mb-1">
            <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${agentColorMap[color || "blue"] || agentColorMap.blue}`}>
              {teammateId}
            </span>
            <svg className="w-2.5 h-2.5 text-sol-text-dim/40 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-[10px] uppercase tracking-wider text-sol-text-dim/60 font-medium">idle</span>
          </div>
          <div className="text-sol-text-dim leading-relaxed whitespace-pre-line">
            <FormattedSummary text={idleSummary} />
          </div>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2 py-0.5 px-2 text-xs text-sol-text-dim opacity-40">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono ${agentColorMap[color || "blue"] || agentColorMap.blue}`}>
          {teammateId}
        </span>
        <span className="italic">idle</span>
      </div>
    );
  }

  if (parsed?.type === "task_assignment") {
    const badgeColor = agentColorMap[color || "blue"] || agentColorMap.blue;
    return (
      <div className="flex items-center gap-2 py-1.5 px-2.5 rounded-md bg-sol-bg-alt/50 border border-sol-border/20">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 ${badgeColor}`}>
          {parsed.assignedBy || teammateId}
        </span>
        <svg className="w-3 h-3 text-sol-text-dim/40 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
        </svg>
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-sol-bg-highlight border border-sol-border/30 text-sol-text-secondary shrink-0">
          #{parsed.taskId}
        </span>
        <span className="text-xs text-sol-text-secondary truncate">{parsed.subject}</span>
      </div>
    );
  }

  if (parsed?.type === "shutdown_request" || parsed?.type === "shutdown_approved") {
    const isApproved = parsed.type === "shutdown_approved";
    return (
      <div className="flex items-center gap-2 py-1.5 px-2.5 rounded-md bg-red-500/5 border border-red-500/15">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 ${agentColorMap[color || "red"] || agentColorMap.red}`}>
          {parsed.from || teammateId}
        </span>
        <svg className="w-3 h-3 text-red-400/60 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" />
        </svg>
        <span className="text-xs text-red-400/80 font-medium">{isApproved ? "shutdown approved" : "shutdown request"}</span>
      </div>
    );
  }

  if (parsed?.type === "teammate_terminated") {
    return (
      <div className="flex items-center gap-2 py-1.5 px-2.5 rounded-md bg-sol-bg-alt/30 border border-sol-border/15">
        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 ${agentColorMap[color || "blue"] || agentColorMap.blue}`}>
          {teammateId}
        </span>
        <svg className="w-3 h-3 text-sol-text-dim/40 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
        </svg>
        <span className="text-xs text-sol-text-dim">{parsed.message || "terminated"}</span>
      </div>
    );
  }

  // A substantive teammate broadcast reuses the cast-send card (SessionMessageBlock) via its
  // teammate variant — the same format and code, only slightly distinct.
  return (
    <SessionMessageBlock variant="teammate" from={teammateId} color={color} summary={summary} body={content} timestamp={timestamp} linkToConversationId={teammateId === "team-lead" ? spawnedByConversationId : undefined} />
  );
}

function UserPromptImpl({ content, timestamp, messageId, conversationId, collapsed, userName, avatarUrl, onOpenComments, isHighlighted, shareSelectionMode, isSelectedForShare, onToggleShareSelection, onStartShareSelection, onForkFromMessage, forkChildren, messageUuid, images, onBranchSwitch, activeBranchId, loadingBranchId, isPending, isQueued, agentStatus, mainMessageCount, mainDivergentPreview, decision }: { content: string; decision?: DecisionAnswerMessage; timestamp: number; messageId: string; conversationId?: Id<"conversations">; collapsed?: boolean; userName?: string; avatarUrl?: string | null; onOpenComments?: (messageId: string) => void; isHighlighted?: boolean; shareSelectionMode?: boolean; isSelectedForShare?: boolean; onToggleShareSelection?: (messageId: string) => void; onStartShareSelection?: (messageId: string) => void; onForkFromMessage?: (messageUuid: string) => void; forkChildren?: ForkChild[]; messageUuid?: string; images?: ImageData[]; onBranchSwitch?: (messageUuid: string, convId: string | null) => void; activeBranchId?: string | null; loadingBranchId?: string | null; isPending?: boolean; isQueued?: boolean; agentStatus?: LiveAgentStatus; mainMessageCount?: number; mainDivergentPreview?: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [contentExpanded, setContentExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const rawContent = content
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/\[Image[:\s][^\]]*\]/gi, "")
    .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
    .replace(/\[image\]/gi, "")
    .trim();
  const { contexts: contextBlocks, remaining: displayContent } = parseContextBlocks(rawContent);

  const effectivelyCollapsed = collapsed && !isExpanded;

  useWatchEffect(() => {
    if (effectivelyCollapsed && contentRef.current) {
      const el = contentRef.current;
      setIsTruncated(el.scrollHeight > el.clientHeight);
    } else {
      setIsTruncated(false);
    }
  }, [effectivelyCollapsed, content]);

  useWatchEffect(() => {
    if (!effectivelyCollapsed && contentRef.current && !contentExpanded) {
      setIsOverflowing(contentRef.current.scrollHeight > USER_CONTENT_MAX_HEIGHT);
    }
  }, [content, effectivelyCollapsed, contentExpanded]);

  useWatchEffect(() => {
    if (!fullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [fullscreen]);

  // Retry affordance for a message stuck in the optimistic/pending state: if
  // the agent never echoes it back (born-dead session, dropped delivery), the
  // row renders pending-striped forever with no way out. After a grace period
  // surface "Retry" right on the message — it fires the same kill & restart as
  // the header dropdown, and restartSession re-pends this conversation's
  // failed/injected messages so the daemon re-delivers this exact message into
  // the revived session. Optimistic rows only exist for the local sender, so
  // visibility here implies the viewer owns the conversation.
  const [retryVisible, setRetryVisible] = useState(false);
  const [retryState, setRetryState] = useState<"idle" | "inflight" | "sent">("idle");
  // Set on click; drives the live progress subscription below. Never cleared
  // while the bar is mounted — delivery removes the optimistic row and the
  // whole bar (and its subscription) with it.
  const [retryClickedAt, setRetryClickedAt] = useState<number | null>(null);
  useWatchEffect(() => {
    if (!isPending || !conversationId || !isConvexId(conversationId)) { setRetryVisible(false); return; }
    const remaining = PENDING_RETRY_AFTER_MS - (Date.now() - timestamp);
    if (remaining <= 0) { setRetryVisible(true); return; }
    const t = setTimeout(() => setRetryVisible(true), remaining);
    return () => clearTimeout(t);
  }, [isPending, conversationId, timestamp]);
  // The agent being alive and processing proves a queued message will be delivered
  // when the current turn ends — the daemon defers injection until the pane is idle
  // (ensureTmuxReady), so a long thinking turn legitimately holds the message. Don't
  // offer "kill & restart" there: it would interrupt and discard live work.
  const agentActive = isActiveAgentStatus(agentStatus);
  const agentBooting = isBootingAgentStatus(agentStatus);
  // Alive-but-parked (dormant/waiting/done) sessions share the booting budget:
  // the pane heartbeats, so a pending message is one daemon pass from landing.
  const agentAliveIdle = isAliveIdleStatus(agentStatus);
  // Short grace after the agent flips busy→idle before escalating: the daemon
  // injects the deferred message within its next poll, so we avoid a false
  // "hasn't reached the agent" flash in the gap between idle and that inject.
  const [idleGraceElapsed, setIdleGraceElapsed] = useState(false);
  useWatchEffect(() => {
    if (!isPending || agentActive) { setIdleGraceElapsed(false); return; }
    const t = setTimeout(() => setIdleGraceElapsed(true), PENDING_IDLE_GRACE_MS);
    return () => clearTimeout(t);
  }, [isPending, agentActive]);
  // While the session is still booting/resuming/connecting, hold off the kill &
  // restart escalation for a much longer budget (measured from when the message was
  // sent): a cold launch — and especially a resume — routinely runs past the short
  // idle grace before the agent flips to "working". Premature escalation here is the
  // "Message hasn't reached the agent" false alarm that flashes during a normal boot.
  const [bootGraceElapsed, setBootGraceElapsed] = useState(false);
  useWatchEffect(() => {
    if (!isPending || !(agentBooting || agentAliveIdle)) { setBootGraceElapsed(false); return; }
    const budget = agentStatus === "resuming" ? PENDING_RESUME_GRACE_MS : PENDING_BOOT_GRACE_MS;
    const remaining = budget - (Date.now() - timestamp);
    if (remaining <= 0) { setBootGraceElapsed(true); return; }
    const t = setTimeout(() => setBootGraceElapsed(true), remaining);
    return () => clearTimeout(t);
  }, [isPending, agentBooting, agentAliveIdle, agentStatus, timestamp]);
  // Durable, server-persisted delivery proof for this conversation's pending message —
  // the same signal the composer banner trusts (messageReachedSession). The daemon marks
  // the row "injected" the instant it lands in the tmux pane and resets it to "pending" if
  // the session dies, so "injected" is only set while a live session genuinely holds the
  // message. (This query intentionally hides "delivered"/"cancelled" rows; by the time a
  // message fully delivers, its JSONL echo has cleared the optimistic row and this banner
  // is gone anyway — "injected" is the state that covers the not-yet-echoed gap.) This is
  // authoritative even when agentStatus is undefined (disconnected / non-"active"
  // conversation / older CLI that doesn't report status) — exactly the case where the
  // per-message banner used to fire a false "hasn't reached the agent" + kill & restart
  // while the message had, in fact, arrived. Only query while this message is optimistic;
  // an optimistic row only exists for the local sender.
  const conversationPending = usePendingMessageStatus(
    conversationId && isConvexId(conversationId) ? conversationId : null,
    !!isPending,
  );
  const messageReachedSession = conversationPending?.status === "injected" || conversationPending?.status === "delivered";
  const bannerState = pendingBannerState(agentStatus, {
    retryEligible: retryVisible,
    restartInFlight: !!retryClickedAt,
    idleGraceElapsed,
    bootGraceElapsed,
    messageReachedSession,
  });
  // Live restart progress, scoped to THIS click: getRestartProgress returns the
  // last few kill/resume commands for the conversation, which can include rows
  // from an earlier restart — filter to ones stamped at/after the click (10s
  // tolerance covers client/server clock skew; the rows are inserted by the
  // very mutation the click awaits).
  const retryProgressRaw = useQuery(
    api.conversations.getRestartProgress,
    retryClickedAt && conversationId && isConvexId(conversationId) ? { conversation_id: conversationId } : "skip",
  );
  const retryProgress = useMemo(
    () => (retryClickedAt ? retryProgressRaw?.filter((c: RestartProgressRow) => c.created_at >= retryClickedAt - 10_000) : undefined),
    [retryProgressRaw, retryClickedAt],
  );
  const [retryWaitingLong, setRetryWaitingLong] = useState(false);
  useWatchEffect(() => {
    if (!retryClickedAt) { setRetryWaitingLong(false); return; }
    if (retryProgress?.some((c: RestartProgressRow) => c.executed_at)) { setRetryWaitingLong(false); return; }
    const t = setTimeout(() => setRetryWaitingLong(true), 20_000);
    return () => clearTimeout(t);
  }, [retryClickedAt, retryProgress]);
  const retryStage = useMemo(
    () => deriveRestartStage(retryProgress, retryWaitingLong),
    [retryProgress, retryWaitingLong],
  );
  // A failed restart re-arms the button so the user can try again.
  useWatchEffect(() => {
    if (retryStage?.tone === "error" && retryState === "sent") setRetryState("idle");
  }, [retryStage?.tone, retryState]);
  const handleRetryRestart = async () => {
    if (!conversationId || retryState === "inflight") return;
    setRetryState("inflight");
    setRetryClickedAt(Date.now());
    setRetryWaitingLong(false);
    try {
      // A still-pending optimistic message may have stranded client-side before
      // its durable send ever reached the server (e.g. a pre-send enrichment
      // stalled). Re-issue the send first — it's idempotent on client_id
      // (messageId IS the optimistic clientId), so it creates the missing
      // pending row or no-ops against an existing one.
      if (isPending && isConvexId(conversationId) && content.trim()) {
        // Replay the row's own send args (dispatched bytes + image ids): the
        // server fingerprints this client id's args, and a rebuilt payload is
        // refused as COMMAND_ID_REUSED instead of deduping. While an image is
        // still uploading the upload task owns the send; a re-send now would
        // land the message without its image.
        const pendingRow = (useInboxStore.getState().pendingMessages[conversationId] || [])
          .find((m) => m._clientId === messageId || m._id === messageId);
        const send = pendingRow ? pendingRowSendArgs(pendingRow) : { content, imageIds: undefined, uploading: false };
        if (!send.uploading) {
          useInboxStore.getState().sendMessage(conversationId, send.content || content, send.imageIds, messageId);
        }
      }
      // If the session is alive (any heartbeating agent_status — idle, working,
      // blocked, booting), the re-sent message delivers through the normal
      // pending rail and the cron healer; there's nothing to restart, and killing
      // a live session (especially one holding a large context) would needlessly
      // tear down good work. Only escalate to kill & restart when the session
      // looks genuinely gone (no live agent_status at all).
      if (isPending && !!agentStatus) {
        setRetryState("sent");
        toast.success("Resending your message…");
        setTimeout(() => setRetryState("idle"), 30_000);
        return;
      }
      const res = await useInboxStore.getState().convCommand(conversationId, "restartSession", ghostRestartContextFor(conversationId));
      if (!followRestoredConversation(res, conversationId)) {
        toast.success("Restarting session — this message will be retried");
      }
      setRetryState("sent");
      // Re-arm after a while so a restart that goes nowhere can be retried;
      // the progress label keeps reporting the actual daemon status either way.
      setTimeout(() => setRetryState("idle"), 30_000);
    } catch (err) {
      setRetryState("idle");
      toast.error(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const { isBookmarked, toggleBookmark: handleToggleBookmark } = useMessageBookmark(conversationId, messageId);

  const handleCopy = () => {
    setTimeout(() => { copyToClipboard(content).then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  const handleCopyLink = () => copyMessageLink(conversationId, messageId);
  const chatOn = useTeamFeature("chat");
  const handleForwardToChat = () => forwardMessageToChat(conversationId, messageId);

  const handleToggleExpand = () => {
    setIsExpanded(!isExpanded);
  };

  // Right-click mirrors the corner toolbar (meta actions only); the hook's
  // guards keep native menus on links and text selections.
  const ctxMenu = useContextMenu<void>();

  return (
    <div id={`msg-${messageId}`} className={`group relative scroll-mt-20 -mx-4 px-4 py-4 rounded-lg ${effectivelyCollapsed ? "mb-2" : "mb-6"} transition-all ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg rounded-lg message-highlight" : ""} ${shareSelectionMode ? "cursor-pointer" : ""} ${isSelectedForShare ? "bg-sol-cyan/15 border-2 border-sol-cyan ring-2 ring-sol-cyan/30" : "bg-sol-blue/10 border border-sol-blue/30"} ${isPending ? "opacity-80 pending-stripes" : isQueued ? "opacity-90 queued-pulse" : ""}`} style={{ '--image-fade-bg': 'color-mix(in srgb, var(--sol-blue) 10%, var(--sol-bg))' } as React.CSSProperties} onClick={shareSelectionMode ? (() => onToggleShareSelection?.(messageId)) : undefined} onContextMenu={shareSelectionMode ? undefined : (e) => ctxMenu.open(e, undefined)}>
      <ContextMenu state={ctxMenu}>
        {() => (
          <>
            <CtxItem icon={CopyIcon} onSelect={handleCopy}>Copy message</CtxItem>
            <CtxItem icon={Link2} onSelect={handleCopyLink}>Copy link to message</CtxItem>
            {chatOn && <CtxItem icon={Forward} onSelect={handleForwardToChat}>Send to chat…</CtxItem>}
            <CtxItem icon={BookmarkIcon} onSelect={handleToggleBookmark}>
              {isBookmarked ? "Remove bookmark" : "Bookmark message"}
            </CtxItem>
            {(onForkFromMessage && messageUuid) || onStartShareSelection ? <CtxSeparator /> : null}
            {onForkFromMessage && messageUuid && (
              <CtxItem icon={Split} onSelect={() => onForkFromMessage(messageUuid)}>Fork from here</CtxItem>
            )}
            {onStartShareSelection && (
              <CtxItem icon={Share2} onSelect={() => onStartShareSelection(messageId)}>Share messages…</CtxItem>
            )}
            <CtxSeparator />
            <CtxItem icon={Maximize2} onSelect={() => setFullscreen(true)}>Fullscreen</CtxItem>
          </>
        )}
      </ContextMenu>
      <div className={`absolute -top-2 right-0 transition-opacity flex gap-0.5 z-10 bg-sol-bg rounded shadow-md px-0.5 ${shareSelectionMode ? "opacity-0 pointer-events-none" : "opacity-100"}`}>
        {onStartShareSelection && (
          <button
            onClick={() => onStartShareSelection(messageId)}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
            title="Share message"
            aria-label="Share message"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
          </button>
        )}
        <button
          onClick={handleCopyLink}
          className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
          title="Copy link to message"
          aria-label="Copy link to message"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        </button>
        {chatOn && (
          <button
            onClick={handleForwardToChat}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
            title="Send to chat"
            aria-label="Send to chat"
          >
            <Forward className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={handleToggleBookmark}
          className={`p-1.5 rounded hover:bg-sol-bg-alt ${isBookmarked ? "text-amber-400" : "text-sol-text-dim hover:text-sol-text-secondary"}`}
          title={isBookmarked ? "Remove bookmark" : "Bookmark message"}
          aria-label={isBookmarked ? "Remove bookmark" : "Bookmark message"}
        >
          <svg className="w-4 h-4" fill={isBookmarked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
        </button>
        {onForkFromMessage && messageUuid && (
          <button
            onClick={() => onForkFromMessage(messageUuid)}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
            title="Fork from this message"
            aria-label="Fork from this message"
          >
            <Split className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={handleCopy}
          className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
          title="Copy message"
          aria-label="Copy message"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <UserIcon avatarUrl={avatarUrl} />
        <span className="text-sol-blue text-xs font-medium">{userName || "You"}</span>
        <a
          href={`#msg-${messageId}`}
          className="text-sol-text-dim hover:text-sol-text-muted text-xs transition-colors"
          title={`${formatFullTimestamp(timestamp)} (click to copy)`}
          onClick={(e) => { e.preventDefault(); setTimeout(() => { copyToClipboard(formatFullTimestamp(timestamp)).then(() => toast.success("Timestamp copied")); }); }}
        >
          {formatRelativeTime(timestamp)}
        </a>
        {isBookmarked && (
          <svg className="w-3 h-3 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
          </svg>
        )}
      </div>
      {contextBlocks.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pl-8 mb-1.5">
          {contextBlocks.map((ctx, i) => (
            <ContextBlockPill key={i} ctx={ctx} />
          ))}
        </div>
      )}
      {displayContent ? <div
        ref={contentRef}
        className={`text-sol-text text-sm pl-8 break-words relative ${effectivelyCollapsed ? "line-clamp-2 whitespace-pre-wrap" : "prose prose-invert prose-sm max-w-none"}`}
        style={!effectivelyCollapsed && !contentExpanded && isOverflowing ? { maxHeight: USER_CONTENT_MAX_HEIGHT, overflowY: 'hidden' } : undefined}
      >
        {(() => {
          const hasTeammate = displayContent.includes('<teammate-message');
          if (effectivelyCollapsed && !hasTeammate) return <>{renderWithMentions(displayContent)}</>;
          if (effectivelyCollapsed && hasTeammate) {
            const tmParts = parseTeammateMessages(displayContent);
            return (
              <div className="space-y-1">
                {tmParts.map((part, i) => part.type === 'teammate' ? (
                  <TeammateMessageCard key={i} teammateId={part.teammateId} color={part.color} summary={part.summary} content={part.content} />
                ) : <span key={i} className="whitespace-pre-wrap">{renderWithMentions(part.content)}</span>)}
              </div>
            );
          }
          if (hasTeammate) {
            const tmParts = parseTeammateMessages(displayContent);
            return (
              <div className="space-y-1">
                {tmParts.map((part, i) => part.type === 'teammate' ? (
                  <TeammateMessageCard key={i} teammateId={part.teammateId} color={part.color} summary={part.summary} content={part.content} />
                ) : <MessageMarkdown key={i} content={part.content} userText />)}
              </div>
            );
          }
          const hasSkill = displayContent.includes('<skill>');
          if (hasSkill) {
            const { parts } = parseSkillBlocks(displayContent);
            return (
              <div className="space-y-2">
                {parts.map((part, i) => part.type === 'skill' ? (
                  <SkillCard key={i} name={part.skillName} description={part.skillDesc} path={part.skillPath} />
                ) : <MessageMarkdown key={i} content={part.content} userText />)}
              </div>
            );
          }
          return <MessageMarkdown content={displayContent} userText />;
        })()}
        {!effectivelyCollapsed && !contentExpanded && isOverflowing && (
          <div className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none bg-gradient-to-b from-transparent to-[color-mix(in_srgb,var(--sol-blue)_10%,var(--sol-bg))]" />
        )}
      </div> : null}
      {!effectivelyCollapsed && images && images.filter(img => !img.tool_use_id).length > 0 && (
        <div className="pl-8 mt-2">
          {images.filter(img => !img.tool_use_id).map((img, i) => <ImageBlock key={i} image={img} />)}
        </div>
      )}
      {decision && !effectivelyCollapsed && <DecisionAnswerFooter decision={decision} conversationId={conversationId} timestamp={timestamp} />}
      {isTruncated && (
        <button
          onClick={handleToggleExpand}
          className="text-xs text-sol-text-dim hover:text-sol-blue mt-2 ml-8 transition-colors"
        >
          Expand
        </button>
      )}
      {isExpanded && collapsed && (
        <button
          onClick={handleToggleExpand}
          className="text-xs text-sol-text-dim hover:text-sol-blue mt-2 ml-8 transition-colors"
        >
          Collapse
        </button>
      )}
      {!effectivelyCollapsed && (isOverflowing || contentExpanded) && (
        <div className="flex items-center gap-3 mt-2 ml-8">
          <button
            onClick={() => setContentExpanded(e => !e)}
            className="text-xs font-medium text-sol-blue hover:text-sol-blue/80 transition-colors"
          >
            {contentExpanded ? "Collapse" : "Expand"}
          </button>
          <button
            onClick={() => setFullscreen(true)}
            className="text-xs font-medium text-sol-blue hover:text-sol-blue/80 transition-colors"
          >
            Fullscreen
          </button>
        </div>
      )}

      {forkChildren && forkChildren.length > 0 && onBranchSwitch && messageUuid && (
        <BranchSelector
          forkChildren={forkChildren}
          activeBranchId={activeBranchId ?? null}
          onSwitchBranch={(convId) => onBranchSwitch(messageUuid, convId)}
          loadingBranchId={loadingBranchId}
          mainMessageCount={mainMessageCount}
          mainDivergentPreview={mainDivergentPreview}
          onFork={onForkFromMessage ? () => onForkFromMessage(messageUuid) : undefined}
        />
      )}

      {/* Session still coming up (cold boot / resume): the daemon injects the message
          and flips to "working" once the pane is ready, so reassure rather than alarm.
          While the agent is actively processing we show nothing — the message is already
          sitting in its native input queue (see pendingBannerState). */}
      {isPending && bannerState !== "none" && (
      <PendingDeliveryNote state={bannerState} restartInFlight={!!retryClickedAt} conversationId={conversationId}>
      {bannerState === "queued" && (
        <div className="flex items-center gap-2 mt-2 pl-8 text-xs text-sol-text-muted" data-testid="pending-message-queued">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400/70 animate-pulse flex-shrink-0" />
          {/* Cold launch/resume genuinely "starts up"; an alive-but-parked session
              (or one the daemon has claimed: "connected") is just being delivered to. */}
          <span>{agentStatus === "starting" || agentStatus === "resuming"
            ? "Starting up — your message will send once the session is ready"
            : "Queued — delivering your message to the agent"}</span>
        </div>
      )}
      {bannerState === "stuck" && (
        <div className="flex items-center flex-wrap gap-2 mt-2 pl-8" data-testid="pending-message-retry">
          {!retryStage && (
            <span className="text-xs text-sol-orange/90">
              {retryState === "idle"
                ? "Message hasn't reached the agent"
                : agentStatus ? "Resending…" : "Restart requested…"}
            </span>
          )}
          {retryStage && (
            <span className={`flex items-center gap-1.5 text-xs ${retryStage.tone === "error" ? "text-sol-red" : retryStage.tone === "warn" ? "text-sol-yellow" : "text-sol-orange/90"}`}>
              {retryStage.tone !== "error" && <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse flex-shrink-0" />}
              {retryStage.label}
            </span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); handleRetryRestart(); }}
            disabled={retryState !== "idle"}
            className="flex items-center gap-1 px-2 py-0.5 rounded border border-sol-orange/40 text-xs text-sol-orange hover:bg-sol-orange/10 transition-colors disabled:opacity-60"
          >
            <svg className={`w-3 h-3 ${retryState !== "idle" ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {retryState === "inflight" || retryState === "sent"
              ? (agentStatus ? "Resending…" : "Restarting…")
              : retryClickedAt ? "Retry again" : (agentStatus ? "Resend message" : "Retry (kill & restart)")}
          </button>
        </div>
      )}
      </PendingDeliveryNote>
      )}

      {fullscreen && createPortal(
        <div className="fixed inset-0 z-[10001] bg-sol-bg overflow-auto" onClick={() => setFullscreen(false)}>
          <div className="conv-col mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <span className="text-sol-text-secondary text-sm font-medium">{userName || "You"}</span>
              <button
                onClick={() => setFullscreen(false)}
                className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                title="Close (Esc)"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="prose prose-invert prose-sm max-w-none text-sol-text">
              <ReactMarkdown
                remarkPlugins={USER_MD_REMARK}
                rehypePlugins={MESSAGE_MD_REHYPE}
                components={MESSAGE_MD_COMPONENTS}
              >
                {content}
              </ReactMarkdown>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
const UserPrompt = memo(UserPromptImpl);

function linkifyMentions(text: string, map: Record<string, string>): string {
  if (!text || Object.keys(map).length === 0) return text;
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    return part.replace(/@([\w][\w-]*)/g, (match, name) => {
      const childId = map[name];
      if (childId) return `[@${name}](/conversation/${childId})`;
      return match;
    });
  }).join('');
}

// ── Story & Summary densities ───────────────────────────────────────────────
// Both render storyMode.ts's chunked retelling of the WHOLE thread (not the
// paginated window). Story is a timeline of BEATS — each beat spans several
// turns: the user's request at that point, then a first-person narrative of
// what I did. Summary is the same shape one level up: a few high-level PHASES
// grouped from the beats. Each item anchors to a real message so you can jump in.

type StoryBeat = { heading: string; body: string; anchor_prompt: string; anchor_message_id: string; anchor_timestamp: number };

function StorySpinner() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
    </svg>
  );
}

// Subscribe to a cached narrative level and auto-(re)generate when missing or
// stale — once per (conversation, message_count) so a still-stale-mid-run query
// doesn't re-fire. Refresh button covers later regenerations.
function useNarrativeLevel(
  conversationId: Id<"conversations"> | undefined,
  level: "story" | "summary",
) {
  const query = level === "story" ? api.storyMode.getStory : api.storyMode.getSummary;
  const genAction = level === "story" ? api.storyMode.generateStory : api.storyMode.generateSummary;
  const data = useQuery(query, conversationId ? { conversation_id: conversationId } : "skip");
  const generate = useAction(genAction);
  const [generating, setGenerating] = useState(false);
  const firedRef = useRef<string | null>(null);
  const run = useCallback(() => {
    if (!conversationId) return;
    setGenerating(true);
    generate({ conversation_id: conversationId }).catch(() => {}).finally(() => setGenerating(false));
  }, [conversationId, generate]);
  useWatchEffect(() => {
    if (!conversationId || !data || !data.stale) return;
    const key = `${conversationId}:${data.message_count}`;
    if (firedRef.current === key) return;
    firedRef.current = key;
    run();
  }, [conversationId, data?.stale, data?.message_count, run]);
  const items = (data?.items ?? []) as StoryBeat[];
  return { items, data, generating, run, loading: data === undefined };
}

function NarrativeSkeleton({ rows }: { rows: number }) {
  return (
    <div className="relative pl-8 animate-pulse">
      <div className="absolute left-[9px] top-2 bottom-2 w-px bg-sol-border/40" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="relative pb-8">
          <div className="absolute -left-[26px] top-1 w-[18px] h-[18px] rounded-full bg-sol-bg ring-2 ring-sol-border/50" />
          <div className="h-3.5 w-40 rounded bg-sol-border/50 mb-3" />
          <div className="space-y-1.5">
            <div className="h-2.5 rounded bg-sol-border/40 w-full" />
            <div className="h-2.5 rounded bg-sol-border/40 w-5/6" />
            <div className="h-2.5 rounded bg-sol-border/40 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

const BeatRow = memo(function BeatRow({ beat, userName, avatarUrl, showPrompt, accent, onJump }: {
  beat: StoryBeat;
  userName?: string;
  avatarUrl?: string | null;
  showPrompt: boolean;
  accent: "blue" | "violet";
  onJump?: (messageId: string, timestamp: number) => void;
}) {
  const prompt = stripSystemTags(beat.anchor_prompt || "").trim();
  const dotColor = accent === "violet" ? "bg-sol-violet" : "bg-sol-cyan";
  return (
    <div className="relative pl-8 pb-8 last:pb-2 group/beat">
      <button
        onClick={onJump ? () => onJump(beat.anchor_message_id, beat.anchor_timestamp) : undefined}
        className={`absolute left-0 top-0.5 w-[18px] h-[18px] rounded-full flex items-center justify-center bg-sol-bg ring-2 ring-sol-border transition-all group-hover/beat:ring-sol-cyan hover:!ring-sol-cyan hover:scale-110`}
        title="Jump to this point in the conversation"
      >
        <span className={`block w-2 h-2 rounded-full ${dotColor}`} />
      </button>
      {beat.heading && (
        <h3 className="text-[15px] font-semibold text-sol-text leading-snug mb-2 mt-px tracking-tight">{beat.heading}</h3>
      )}
      {showPrompt && prompt && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border-l-2 border-sol-blue/70 bg-sol-blue/[0.07] pl-3 pr-3 py-2">
          <AvatarImg
            src={avatarUrl}
            alt=""
            className="w-4 h-4 rounded-full shrink-0 mt-px"
            fallback={<span className="text-[10px] font-bold uppercase tracking-wider text-sol-blue shrink-0 mt-0.5">{(userName || "You").slice(0, 1)}</span>}
          />
          <span className="text-[12.5px] text-sol-text-secondary whitespace-pre-wrap break-words leading-snug">{prompt}</span>
        </div>
      )}
      <div className="prose prose-invert prose-sm max-w-none text-sol-text/95 leading-relaxed">
        <MessageMarkdown content={beat.body} />
      </div>
    </div>
  );
});

function NarrativeFooter({ data, generating, run, unit }: { data: any; generating: boolean; run: () => void; unit: string }) {
  return (
    <div className="mt-2 pt-3 border-t border-sol-border/40 flex items-center gap-3 text-[11px] text-sol-text-dim">
      <span>
        {data?.message_count ? `Through ${data.message_count} messages` : unit}
        {data?.generated_at ? ` · ${formatRelativeTime(data.generated_at)}` : ""}
      </span>
      {generating ? (
        <span className="flex items-center gap-1.5"><StorySpinner /> updating…</span>
      ) : data?.stale ? (
        <button onClick={run} className="text-sol-cyan/80 hover:text-sol-cyan transition-colors font-medium">Update</button>
      ) : null}
    </div>
  );
}

function StoryTimelineView({ conversationId, userName, avatarUrl, onJump }: { conversationId?: Id<"conversations">; userName?: string; avatarUrl?: string | null; onJump?: (messageId: string, timestamp: number) => void }) {
  const { items, data, generating, run, loading } = useNarrativeLevel(conversationId, "story");
  if (loading || (items.length === 0 && (generating || data?.stale)))
    return <div className="py-8"><div className="mb-5 flex items-center gap-2 text-[12px] text-sol-text-dim"><StorySpinner /> Composing the story of this session…</div><NarrativeSkeleton rows={4} /></div>;
  if (items.length === 0) return <div className="py-12 text-center text-sm text-sol-text-dim">Nothing to retell yet.</div>;
  return (
    <div className="py-7">
      <div className="relative">
        <div className="absolute left-[9px] top-2 bottom-6 w-px bg-gradient-to-b from-sol-border via-[color-mix(in_srgb,var(--sol-border)_60%,transparent)] to-transparent" />
        {items.map((b) => (
          <BeatRow key={b.anchor_message_id} beat={b} userName={userName} avatarUrl={avatarUrl} showPrompt accent="blue" onJump={onJump} />
        ))}
      </div>
      <NarrativeFooter data={data} generating={generating} run={run} unit="Story" />
    </div>
  );
}

function ThreadSummaryView({ conversationId, userName, avatarUrl, onJump }: { conversationId?: Id<"conversations">; userName?: string; avatarUrl?: string | null; onJump?: (messageId: string, timestamp: number) => void }) {
  const { items, data, generating, run, loading } = useNarrativeLevel(conversationId, "summary");
  if (loading || (items.length === 0 && (generating || data?.stale)))
    return <div className="py-8"><div className="mb-5 flex items-center gap-2 text-[12px] text-sol-text-dim"><StorySpinner /> Distilling the session…</div><NarrativeSkeleton rows={3} /></div>;
  if (items.length === 0) return <div className="py-12 text-center text-sm text-sol-text-dim">Nothing to summarize yet.</div>;
  return (
    <div className="py-7">
      <div className="relative">
        <div className="absolute left-[9px] top-2 bottom-6 w-px bg-gradient-to-b from-sol-violet/50 via-[color-mix(in_srgb,var(--sol-border)_60%,transparent)] to-transparent" />
        {items.map((b) => (
          <BeatRow key={b.anchor_message_id} beat={b} userName={userName} avatarUrl={avatarUrl} showPrompt accent="violet" onJump={onJump} />
        ))}
      </div>
      <NarrativeFooter data={data} generating={generating} run={run} unit="Summary" />
    </div>
  );
}

// A screenshot captured inside a collapsed tool group, surfaced on the receipt
// chip as a small thumbnail. Clicking opens the shared lightbox (with arrow-key
// browsing across every registered image) WITHOUT expanding the tool group.
function CondensedImageThumb({ image }: { image: ImageData }) {
  const { src, storageMissing } = useImageSrc(image);
  const gallery = useImageGallery();
  useWatchEffect(() => {
    if (src && gallery) gallery.register(src);
  }, [src, gallery]);
  if (storageMissing) return null;
  if (!src) {
    return <span className="h-7 w-10 shrink-0 rounded-sm border border-sol-border/50 bg-sol-bg-alt animate-pulse" aria-hidden />;
  }
  return (
    <img
      src={src}
      alt="Screenshot"
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); gallery?.open(src); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); gallery?.open(src); } }}
      className="h-7 w-10 shrink-0 rounded-sm border border-sol-border/60 object-cover object-top cursor-zoom-in hover:border-sol-cyan/60 hover:brightness-110 transition-all"
      title="View screenshot"
    />
  );
}

// One source message's share of a condensed receipt: the hideable tools it
// ran, under its own identity (results, comments and share selection stay
// attributed to the message that ran them when the group opens).
type ReceiptEntry = { messageId: string; messageUuid?: string; timestamp: number; tools: ToolCall[] };
type CondensedReceipt = { entries: ReceiptEntry[]; expanded: boolean; onToggle: () => void };

// One distinct receipt standing in for a segment's tool activity in the
// condensed feed. Closed, it is a faint inset chip, clearly NOT prose: a busy
// segment counts ("read 3 files · ran 2 commands · 1 search"); one or two
// tools fit their real subject in the same space, so they say it ("ran npm
// test"). Screenshots taken by the folded tools ride along as clickable
// thumbnails, so images stay reachable without opening the group — which is
// why the root is a div, not a button (thumbnails are interactive, and
// buttons can't nest).
//
// Open, the chip becomes the HEADER of a group marked by one left rule, and
// the real tool blocks nest under it, in this same row: a disclosure, not a
// second copy. The header switches to the counting phrase (the blocks below
// carry each tool's subject, so restating them would read as duplication);
// thumbnails step aside since the blocks show their images inline.
// The disclosure triangle leads in both states so the open/closed change is
// unmistakable, and the header keeps its position and size across the toggle
// so the click target never moves under the pointer.
const CondensedToolsGroup = memo(function CondensedToolsGroup({ entries, expanded, onToggle, images, globalImageMap, renderTool }: {
  entries: ReceiptEntry[];
  expanded: boolean;
  onToggle: () => void;
  images?: ImageData[];
  globalImageMap?: Record<string, ImageData[]>;
  renderTool: (tc: ToolCall, entry: ReceiptEntry) => React.ReactNode;
}) {
  const { summary, counted, screenshots } = useMemo(() => {
    const counts = new Map<string, number>();
    const actions: { name: string; input: string }[] = [];
    const shots: { id: string; image: ImageData }[] = [];
    for (const entry of entries) {
      for (const tc of entry.tools) {
        const nested = extractNestedActions(tc);
        const represented = nested.length > 0 ? nested : [tc];
        for (const action of represented) {
          counts.set(action.name, (counts.get(action.name) ?? 0) + 1);
          actions.push(action);
        }
        let toolImages = images?.filter(img => img.tool_use_id === tc.id) ?? [];
        if (!toolImages.length) toolImages = globalImageMap?.[tc.id] ?? [];
        toolImages.forEach((image, i) => shots.push({ id: `${tc.id}:${i}`, image }));
      }
    }
    const counted = [...counts.entries()].map(([name, count]) => describeToolGroup(name, count)).join(" · ");
    return {
      summary: (actions.length <= 2 && describeSmallToolGroup(actions)) || counted,
      counted,
      screenshots: shots,
    };
  }, [entries, images, globalImageMap]);
  const header = (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
      className={`flex items-center flex-wrap gap-x-2 gap-y-1 max-w-full cursor-pointer pl-2 pr-2.5 py-0.5 text-[11px] transition-colors ${
        expanded
          ? "w-fit rounded-md text-sol-text-secondary hover:bg-sol-bg-alt/70"
          : "w-fit rounded-md border border-dashed border-sol-border/60 bg-sol-bg-alt/40 text-sol-text-dim hover:border-sol-cyan/40 hover:text-sol-text-secondary hover:bg-sol-bg-alt/70"
      }`}
      title={expanded ? "Hide tool activity" : "Show tool activity"}
    >
      <ChevronRight className={`w-3 h-3 shrink-0 opacity-70 transition-transform ${expanded ? "rotate-90 text-sol-cyan" : ""}`} />
      <Wrench className="w-3 h-3 shrink-0 opacity-70" />
      <span className="truncate font-medium tracking-tight">{expanded ? counted : summary}</span>
      {!expanded && screenshots.map(({ id, image }) => <CondensedImageThumb key={id} image={image} />)}
    </div>
  );
  if (!expanded) return <div className="not-prose mt-1 flex">{header}</div>;
  return (
    <div className="not-prose mt-1 border-l-2 border-sol-cyan/50 pl-2">
      {header}
      <div className="pt-0.5 pb-1">
        {entries.map((entry) => entry.tools.map((tc) => renderTool(tc, entry)))}
      </div>
    </div>
  );
});

// Compact feed: a whole collapsed assistant turn shown as one line — Claude
// glyph, the first sentence of the reply, and a count of what's inside. Click
// anywhere to expand the turn to full.
const CompactTurnCard = memo(function CompactTurnCard({ preview, messageCount, toolCount, onExpand }: { preview: string; messageCount: number; toolCount: number; onExpand: () => void }) {
  const bits: string[] = [];
  if (messageCount > 1) bits.push(`${messageCount} messages`);
  if (toolCount > 0) bits.push(`${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
  return (
    <button
      onClick={onExpand}
      className="group/turn not-prose w-full flex items-center gap-2.5 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 hover:bg-sol-bg-alt/70 hover:border-sol-cyan/40 pl-2.5 pr-3 py-2 text-left transition-colors"
      title="Expand this turn"
    >
      <LogoIcon size={15} className="shrink-0 opacity-80" />
      <span className="flex-1 min-w-0 truncate text-[13px] text-sol-text-secondary">{preview || "Worked on the task"}</span>
      {bits.length > 0 && <span className="shrink-0 text-[10.5px] text-sol-text-dim/70 tabular-nums">{bits.join(" · ")}</span>}
      <ChevronDown className="w-3.5 h-3.5 shrink-0 text-sol-text-dim/60 group-hover/turn:text-sol-cyan transition-colors" />
    </button>
  );
});

// Compact feed: a collapsed assistant turn shows the BOTTOM ~500px of its final
// reply (the conclusion) with the top faded out behind a "Show full turn"
// control. The clipped column is anchored to its bottom so the end stays in
// view; expanding renders the whole turn at full density.
const COMPACT_TAIL_HEIGHT = 500;
const CompactCollapsedTurn = memo(function CompactCollapsedTurn({ content, onExpand }: { content: string; onExpand: () => void }) {
  const body = stripSystemTags(content || "").trim();
  return (
    <div className="relative group/ct pl-8">
      <div
        className="relative overflow-hidden flex flex-col justify-end"
        style={{ maxHeight: COMPACT_TAIL_HEIGHT }}
      >
        <div className="prose prose-invert prose-sm max-w-none text-sol-text/90">
          <MessageMarkdown content={body} />
        </div>
      </div>
      <div className="absolute -top-px left-0 right-0 h-24 pointer-events-none bg-gradient-to-b from-[var(--sol-bg)] via-[var(--sol-bg)] to-transparent" />
      <button
        onClick={onExpand}
        className="not-prose absolute top-1 left-8 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-sol-border/70 bg-sol-bg-alt text-[11px] font-medium text-sol-text-dim hover:text-sol-cyan hover:border-sol-cyan/50 shadow-sm transition-colors"
        title="Expand this turn"
      >
        <ChevronUp className="w-3 h-3" /> Show full turn
      </button>
    </div>
  );
});

const EMPTY_RECEIPT_ENTRIES: ReceiptEntry[] = [];
const EMPTY_CHILD_CONVERSATIONS: any[] = [];

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function AssistantBlockImpl({
  content,
  timestamp,
  thinking,
  showThinking,
  toolCalls,
  toolResults,
  images,
  messageId,
  messageUuid,
  conversationId,
  density = "full",
  condensedReceipt,
  globalToolResultMap,
  onCollapseTurn,
  childConversationMap,
  childConversations,
  agentNameToChildMap,
  showHeader = true,
  onOpenComments,
  toolCallChangeSelectionMap,
  isHighlighted,
  runMessageIds,
  shareSelectionMode,
  isSelectedForShare,
  onToggleShareSelection,
  onStartShareSelection,
  agentType,
  taskSubjectMap,
  taskRecordMap,
  onForkFromMessage,
  forkChildren,
  onBranchSwitch,
  activeBranchId,
  loadingBranchId,
  mainMessageCount,
  mainDivergentPreview,
  model,
  onSendInlineMessage,
  isConversationActive,
  globalImageMap,
}: {
  content?: string;
  timestamp: number;
  thinking?: string;
  showThinking?: boolean;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  images?: ImageData[];
  messageId: string;
  messageUuid?: string;
  conversationId?: Id<"conversations">;
  density?: MessageFeedDensity;
  condensedReceipt?: CondensedReceipt;
  /** Results for tools folded into this row's receipt from OTHER messages (the owner's own come via toolResults). */
  globalToolResultMap?: Record<string, ToolResult>;
  onCollapseTurn?: () => void;
  childConversationMap?: Record<string, string>;
  childConversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>;
  agentNameToChildMap?: Record<string, string>;
  showHeader?: boolean;
  onOpenComments?: (messageId: string) => void;
  toolCallChangeSelectionMap?: Record<string, ToolCallChangeSelection>;
  isHighlighted?: boolean;
  runMessageIds?: string[];
  shareSelectionMode?: boolean;
  isSelectedForShare?: boolean;
  onToggleShareSelection?: (messageId: string) => void;
  onStartShareSelection?: (messageId: string) => void;
  agentType?: string;
  taskSubjectMap?: Record<string, string>;
  taskRecordMap?: TaskRecordMaps;
  onForkFromMessage?: (messageUuid: string) => void;
  forkChildren?: ForkChild[];
  onBranchSwitch?: (messageUuid: string, convId: string | null) => void;
  activeBranchId?: string | null;
  loadingBranchId?: string | null;
  mainMessageCount?: number;
  mainDivergentPreview?: string;
  model?: string;
  onSendInlineMessage?: (content: string) => void;
  isConversationActive?: boolean;
  globalImageMap?: Record<string, ImageData[]>;
}) {
  const CONTENT_MAX_HEIGHT = 800;

  // Condensed feed: this message's segment tools fold into one receipt row
  // (condensedReceipt), rendered inline right after the content where the
  // activity happened. Opening it reveals the real tool blocks nested under
  // the chip, inside this row. Compact-expanded turns arrive as density "full".
  const condensed = density === "condensed";
  const [contentExpanded, setContentExpanded] = useState(true);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const safeContent = content ? safeString(content) : content;
  const strippedContent = safeContent ? stripSystemTags(safeContent) : safeContent;
  const displayContent = strippedContent && agentNameToChildMap
    ? linkifyMentions(strippedContent, agentNameToChildMap)
    : strippedContent;
  const parsedApiError = useMemo(() => parseApiErrorContent(displayContent), [displayContent]);
  const onlyAskUser = toolCalls && toolCalls.length > 0 && toolCalls.every(tc => isAskTool(tc.name));
  const hasContent = displayContent && displayContent.trim().length > 0 && !onlyAskUser;
  const hasThinking = !!thinking && thinking.trim().length > 0;
  const visibleThinking = hasThinking && !!showThinking;
  const hasToolCalls = toolCalls && toolCalls.length > 0;
  const hasImages = images?.some(img => !img.tool_use_id) ?? false;

  const { isBookmarked, toggleBookmark: handleToggleBookmark } = useMessageBookmark(conversationId, messageId);

  const toolResultMap = useMemo(() => {
    const map: Record<string, ToolResult> = {};
    if (toolResults) {
      for (const r of toolResults) {
        map[r.tool_use_id] = r;
      }
    }
    return map;
  }, [toolResults]);

  // One switch for every tool block this row can render, whether the tool is
  // this message's own or folded into this row's condensed receipt from a
  // later tool-only message. `src` is the message that actually ran it, so
  // comments, share selection and subagent links attribute correctly.
  const renderToolBlock = (tc: ToolCall, result: ToolResult | undefined, src: { messageId: string; messageUuid?: string; timestamp: number }) => (
    isAgentTool(tc.name) ? (
      <TaskToolBlock
        key={tc.id}
        tool={tc}
        result={result}
        childConversationId={src.messageUuid && childConversationMap ? childConversationMap[src.messageUuid] : undefined}
        childConversations={childConversations}
      />
    ) : isTodoTool(tc.name) ? (
      <TodoWriteBlock key={tc.id} tool={tc} />
    ) : isAskTool(tc.name) ? (
      <AskUserQuestionBlock key={tc.id} tool={tc} result={result} onSendMessage={onSendInlineMessage} />
    ) : tc.name === "TaskList" ? (
      <TaskListBlock key={tc.id} tool={tc} result={result} taskRecordMap={taskRecordMap} />
    ) : tc.name === "TaskCreate" || tc.name === "TaskUpdate" || tc.name === "TaskGet" ? (
      <TaskCreateUpdateBlock key={tc.id} tool={tc} result={result} taskSubjectMap={taskSubjectMap} taskRecordMap={taskRecordMap} />
    ) : tc.name === "SendMessage" ? (
      <SendMessageBlock key={tc.id} tool={tc} agentNameToChildMap={agentNameToChildMap} />
    ) : tc.name === "TeamCreate" || tc.name === "TeamDelete" ? (
      <TeamCreateBlock key={tc.id} tool={tc} />
    ) : tc.name === "Workflow" || tc.name === "workflow" ? (
      <WorkflowToolBlock key={tc.id} tool={tc} result={result} />
    ) : tc.name === "Skill" ? (
      <SkillBlock key={tc.id} tool={tc} />
    ) : tc.name === "Monitor" || tc.name === "monitor" || isBackgroundBashToolCall(tc) ? (
      <MonitorBlock key={tc.id} tool={tc} conversationId={conversationId} />
    ) : tc.name === "ScheduleWakeup" ? (
      <ScheduleWakeupBlock key={tc.id} tool={tc} result={result} timestamp={src.timestamp} />
    ) : isPlanModeTool(tc.name) ? (
      <PlanModeBlock key={tc.id} tool={tc} result={result} conversationId={conversationId} messageId={src.messageId} onSendMessage={onSendInlineMessage} />
    ) : parseCastCommand(tc) ? (
      <CastCommandBlock key={tc.id} tool={tc} result={result} images={images} globalImageMap={globalImageMap} conversationId={conversationId} />
    ) : (
      <ToolBlock
        key={tc.id}
        tool={tc}
        result={result}
        changeIndex={toolCallChangeSelectionMap?.[tc.id]?.index}
        changeRange={toolCallChangeSelectionMap?.[tc.id]?.range}
        shareSelectionMode={shareSelectionMode}
        messageId={src.messageId}
        conversationId={conversationId}
        onStartShareSelection={onStartShareSelection}
        onOpenComments={onOpenComments ? () => onOpenComments(src.messageId) : undefined}
        collapsed={density === "compact"}
        timestamp={src.timestamp}
        images={images}
        globalImageMap={globalImageMap}
      />
    )
  );

  useWatchEffect(() => {
    if (!contentRef.current) return;
    const el = contentRef.current;
    const check = () => {
      setIsOverflowing(el.scrollHeight > CONTENT_MAX_HEIGHT);
    };
    check();
    const obs = new ResizeObserver(check);
    obs.observe(el);
    return () => obs.disconnect();
  }, [content]);

  useWatchEffect(() => {
    if (!fullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [fullscreen]);

  if (!hasContent && !hasThinking && !hasToolCalls && !hasImages) {
    return null;
  }

  const handleCopy = () => {
    const text = formatMessagePartsForCopy(displayContent, toolCalls, toolResults);
    if (!text) return;
    setTimeout(() => { copyToClipboard(text).then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  const handleCopyLink = () => copyMessageLink(conversationId, messageId);
  const chatOn = useTeamFeature("chat");
  const handleForwardToChat = () => forwardMessageToChat(conversationId, messageId);

  // Show Claude header for first message in sequence (regardless of content type)
  const shouldShowHeader = showHeader;
  const onlyToolCalls = hasToolCalls && !hasContent && !visibleThinking;
  const hasVisibleContent = hasContent || visibleThinking || hasToolCalls || hasImages;

  // Right-click mirrors the corner toolbar (meta actions only). Declared
  // before the visibility early-return — hooks can't be conditional.
  const ctxMenu = useContextMenu<void>();

  // When nothing visible, hide completely
  if (!hasVisibleContent) {
    return null;
  }

  const hasPlanWrite = hasToolCalls && toolCalls?.some(isPlanWriteToolCall);

  // Corner toolbar placement. With the agent header row the toolbar rides its
  // empty right side. Without it, content starts at the very top of the
  // message, and a block card there (published page, doc, canvas, PR) keeps
  // its own controls in that corner — so the toolbar hangs fully above the
  // content instead of covering them. Tool-only rows stack tightly and keep
  // the toolbar inside the row (a plan card lifts it, like a block card).
  const toolbarTop = onlyToolCalls
    ? (hasPlanWrite ? "-top-6" : "top-1")
    : shouldShowHeader ? "-top-2" : "-top-7";

  return (
    <div id={`msg-${messageId}`} className={`group relative scroll-mt-20 ${onlyToolCalls ? "mb-0.5" : condensed ? "mb-1.5" : "mb-6"} transition-all ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg rounded-lg p-2 -m-2 message-highlight" : ""} ${shareSelectionMode ? "cursor-pointer" : ""} ${isSelectedForShare ? "bg-sol-cyan/10 rounded-lg p-2 -m-2 border-2 border-sol-cyan ring-2 ring-sol-cyan/30" : ""}`} onClick={shareSelectionMode ? (() => onToggleShareSelection?.(messageId)) : undefined} onContextMenu={shareSelectionMode ? undefined : (e) => ctxMenu.open(e, undefined)} title={!shouldShowHeader ? formatRelativeTime(timestamp) : undefined}>
      <ContextMenu state={ctxMenu}>
        {() => (
          <>
            <CtxItem icon={CopyIcon} onSelect={handleCopy}>Copy message</CtxItem>
            <CtxItem icon={Link2} onSelect={handleCopyLink}>Copy link to message</CtxItem>
            {chatOn && <CtxItem icon={Forward} onSelect={handleForwardToChat}>Send to chat…</CtxItem>}
            <CtxItem icon={BookmarkIcon} onSelect={handleToggleBookmark}>
              {isBookmarked ? "Remove bookmark" : "Bookmark message"}
            </CtxItem>
            {((onForkFromMessage && messageUuid && !onlyToolCalls) || onStartShareSelection) && <CtxSeparator />}
            {onForkFromMessage && messageUuid && !onlyToolCalls && (
              <CtxItem icon={Split} onSelect={() => onForkFromMessage(messageUuid)}>Fork from here</CtxItem>
            )}
            {onStartShareSelection && (
              <CtxItem icon={Share2} onSelect={() => onStartShareSelection(messageId)}>Share messages…</CtxItem>
            )}
            {onCollapseTurn && (
              <CtxItem icon={ChevronUp} onSelect={onCollapseTurn}>Collapse turn</CtxItem>
            )}
            <CtxSeparator />
            <CtxItem icon={Maximize2} onSelect={() => setFullscreen(true)}>Fullscreen</CtxItem>
          </>
        )}
      </ContextMenu>
      {onCollapseTurn && (
        <button
          onClick={onCollapseTurn}
          className="mb-2 inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-cyan transition-colors not-prose"
          title="Collapse this turn"
        >
          <ChevronUp className="w-3 h-3" /> Collapse turn
        </button>
      )}
      {(hasContent || visibleThinking || hasToolCalls) && (
        <div className={`absolute ${toolbarTop} right-0 transition-opacity duration-150 flex gap-0.5 z-10 bg-sol-bg rounded shadow-md px-0.5 ${shareSelectionMode ? "opacity-0 pointer-events-none" : "opacity-0 group-hover:opacity-100"}`}>
          {/* Respond actions (quote into your reply) live on each block's left
              gutter — see MessageReview. This corner is META only: a plain row
              of icon buttons, distinct icons + tooltips so link vs share read clearly. */}
          <button
            onClick={handleCopy}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
            title="Copy message"
            aria-label="Copy message"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
          <button
            onClick={handleCopyLink}
            className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
            title="Copy link to this message"
            aria-label="Copy link to this message"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
          </button>
          {chatOn && (
            <button
              onClick={handleForwardToChat}
              className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
              title="Send to chat"
              aria-label="Send to chat"
            >
              <Forward className="w-4 h-4" />
            </button>
          )}
          {onStartShareSelection && (
            <button
              onClick={() => onStartShareSelection(messageId)}
              className="p-1.5 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary"
              title="Share selected messages…"
              aria-label="Share selected messages"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            </button>
          )}
          <button
            onClick={handleToggleBookmark}
            className={`p-1.5 rounded hover:bg-sol-bg-alt ${isBookmarked ? "text-amber-400" : "text-sol-text-dim hover:text-sol-text-secondary"}`}
            title={isBookmarked ? "Remove bookmark" : "Bookmark message"}
            aria-label={isBookmarked ? "Remove bookmark" : "Bookmark message"}
          >
            <svg className="w-4 h-4" fill={isBookmarked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          </button>
        </div>
      )}

      {shouldShowHeader && (
        <div className="flex items-center gap-2 mb-2 mt-4">
          {/* Model rides as a hover tooltip on the agent identity — per-message
              when the transcript carried it, conversation-level otherwise. */}
          <span className="flex items-center gap-2 cursor-default" title={model ? `Model: ${model}` : undefined}>
            <AssistantIcon agentType={agentType} />
            <span className="text-sol-text-secondary text-xs font-medium">{assistantLabel(agentType)}</span>
          </span>
          <a
            href={`#msg-${messageId}`}
            className="text-sol-text-dim hover:text-sol-text-muted text-xs transition-colors"
            title={`${formatFullTimestamp(timestamp)} (click to copy)`}
            onClick={(e) => { e.preventDefault(); setTimeout(() => { copyToClipboard(formatFullTimestamp(timestamp)).then(() => toast.success("Timestamp copied")); }); }}
          >
            {formatRelativeTime(timestamp)}
          </a>
          {isBookmarked && (
            <svg className="w-3 h-3 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
              <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
          )}
        </div>
      )}

      <div className={shouldShowHeader || !showHeader ? "pl-8" : "pl-0"}>
        {hasImages && images?.filter(img => !img.tool_use_id).map((img, i) => <ImageBlock key={i} image={img} />)}

        {/* Hidden entirely unless the global "Show thinking" toggle is on
            (off by default) — opencode/pi carry real reasoning that's noisy
            otherwise. Condensed feed hides it too, EXCEPT a pure-reasoning
            turn, where thinking is the only content and hiding it leaves an
            empty bubble. */}
        {visibleThinking && (!condensed || (!hasContent && !hasToolCalls && !hasImages)) && <ThinkingBlock content={thinking!} />}

        {/* Condensed hides every hideable tool here: they render inside the
            receipt group below the content instead (own tools and the folded
            tools of absorbed messages alike). Always-visible blocks stay. */}
        {hasToolCalls && toolCalls?.map((tc) => {
          if (condensed && !isAlwaysVisibleToolCall(tc)) return null;
          return renderToolBlock(tc, toolResultMap[tc.id], { messageId, messageUuid, timestamp });
        })}

        {hasContent && (
          <>
            <div className={parsedApiError ? "" : "text-sol-text prose prose-invert prose-sm max-w-none"}>
              {parsedApiError ? (
                <ApiErrorCard error={parsedApiError} agentType={agentType} conversationId={conversationId} timestamp={timestamp} compact={condensed} />
              ) : (
                <div
                  ref={contentRef}
                  className="relative"
                  style={!contentExpanded && isOverflowing ? { maxHeight: CONTENT_MAX_HEIGHT, overflowY: 'hidden' } : undefined}
                >
                  {conversationId ? (
                    <MessageIdentityProvider conversationId={String(conversationId)} messageId={messageId}>
                      <MessageReview
                        conversationId={conversationId}
                        messageId={messageId}
                        content={displayContent}
                        renderBlock={renderAssistantBody}
                      />
                    </MessageIdentityProvider>
                  ) : (
                    renderAssistantBody(displayContent)
                  )}
                  {!contentExpanded && isOverflowing && (
                    <div className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none bg-gradient-to-b from-transparent to-[var(--sol-bg)]" />
                  )}
                </div>
              )}
            </div>
            {!parsedApiError && (isOverflowing || !contentExpanded) && (
              <div className="flex items-center gap-1 mt-2">
                <button
                  onClick={() => setFullscreen(true)}
                  className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-cyan transition-colors flex items-center gap-1"
                  title="Fullscreen"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                  </svg>
                  <span className="hidden sm:inline text-xs text-sol-text-dim">Full Screen</span>
                </button>
                <button
                  onClick={() => setContentExpanded(e => !e)}
                  className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-cyan transition-colors"
                  title={contentExpanded ? "Collapse" : "Expand"}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    {contentExpanded ? (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                    )}
                  </svg>
                </button>
              </div>
            )}
          </>
        )}

        {condensedReceipt && (
          <CondensedToolsGroup
            entries={condensedReceipt.entries}
            expanded={condensedReceipt.expanded}
            onToggle={condensedReceipt.onToggle}
            images={images}
            globalImageMap={globalImageMap}
            renderTool={(tc, entry) => renderToolBlock(tc, toolResultMap[tc.id] ?? globalToolResultMap?.[tc.id], entry)}
          />
        )}

        {fullscreen && createPortal(
          <div className="fixed inset-0 z-[10001] bg-sol-bg overflow-auto" onClick={() => setFullscreen(false)}>
            <div className="conv-col mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-6">
                <span className="text-sol-text-secondary text-sm font-medium">Message</span>
                <button
                  onClick={() => setFullscreen(false)}
                  className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                  title="Close"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="prose prose-invert prose-sm max-w-none text-sol-text">
                {parsedApiError ? (
                  <ApiErrorCard error={parsedApiError} agentType={agentType} conversationId={conversationId} timestamp={timestamp} />
                ) : (
                  <ReactMarkdown
                    remarkPlugins={entityRemarkPlugins}
                    rehypePlugins={MESSAGE_MD_REHYPE}
                    components={MESSAGE_MD_COMPONENTS}
                  >
                    {displayContent}
                  </ReactMarkdown>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}

      </div>

      {onForkFromMessage && messageUuid && !onlyToolCalls && !shareSelectionMode && !(forkChildren && forkChildren.length) && (
        <button
          onClick={() => onForkFromMessage(messageUuid)}
          className="absolute right-2 -bottom-3 z-10 inline-flex items-center gap-1.5 text-[11px] font-medium pl-1.5 pr-2.5 py-1 rounded-md border border-dashed border-sol-border/60 bg-sol-bg text-sol-text-dim shadow-sm opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto hover:text-sol-cyan hover:border-sol-cyan/50 hover:bg-sol-cyan/10 transition-all duration-150"
          title="Fork the conversation from this message"
          aria-label="Fork from this message"
        >
          <Split className="w-3.5 h-3.5" />
          <span>Fork here</span>
        </button>
      )}

      {forkChildren && forkChildren.length > 0 && onBranchSwitch && messageUuid && (
        <BranchSelector
          forkChildren={forkChildren}
          activeBranchId={activeBranchId ?? null}
          onSwitchBranch={(convId) => onBranchSwitch(messageUuid, convId)}
          loadingBranchId={loadingBranchId}
          mainMessageCount={mainMessageCount}
          mainDivergentPreview={mainDivergentPreview}
          onFork={onForkFromMessage ? () => onForkFromMessage(messageUuid) : undefined}
        />
      )}
    </div>
  );
}
const AssistantBlock = memo(AssistantBlockImpl);

function ToolResultMessage({ toolResults, toolName }: { toolResults: ToolResult[]; toolName?: string }) {
  // Don't render separate result messages - results are shown inline with tool calls
  // This component was showing duplicate content with the 1→ line number format
  return null;
}

function SystemBlockImpl({ content, subtype, timestamp, messageUuid, messageId, conversationId, onOpenComments, onStartShareSelection }: { content: string; subtype?: string; timestamp?: number; messageUuid?: string; messageId?: string; conversationId?: Id<"conversations">; onOpenComments?: (messageId: string) => void; onStartShareSelection?: (messageId: string) => void }) {
  if (isHiddenSystemNotice(content, subtype)) return null;

  if (subtype === "compact_boundary") {
    return (
      <div className="my-6 flex items-center gap-3">
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent" />
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/30">
          <svg className="w-3.5 h-3.5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <span className="text-xs text-amber-500 font-medium">Context compacted</span>
        </div>
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent" />
      </div>
    );
  }

  if (subtype === "scheduled_task_prompt" && content) {
    return <ScheduledTaskBlock content={content} timestamp={timestamp || Date.now()} />;
  }

  // A /loop wakeup firing ("Claude resuming /loop wakeup (Jul 29 5:07pm)") —
  // the harness-side twin of a trigger injection, so it wears the same violet
  // trigger anatomy as ScheduledTaskBlock/ScheduleWakeupBlock instead of the
  // generic gray system row.
  if (subtype === "scheduled_task_fire" && content) {
    return (
      <div className="mb-2 mx-1 rounded border-l-2 border-sol-violet/60 bg-sol-violet/5">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <Zap className="w-3.5 h-3.5 text-sol-violet/70 shrink-0" />
          <span className="text-[11px] font-medium tracking-wide uppercase text-sol-violet/70 shrink-0">Wakeup fired</span>
          <span className="text-xs text-sol-text-muted truncate">{stripAnsiCodes(content)}</span>
          {timestamp && (
            <span className="text-[10px] text-sol-text-dim ml-auto shrink-0" title={formatFullTimestamp(timestamp)}>{formatRelativeTime(timestamp)}</span>
          )}
        </div>
      </div>
    );
  }

  if (subtype === "compaction_summary" && content) {
    return <CompactionSummaryBlock content={content} />;
  }

  if (subtype === "plan" && content) {
    return <PlanBlock content={content} timestamp={timestamp || Date.now()} messageId={messageId} conversationId={conversationId} onOpenComments={onOpenComments} onStartShareSelection={onStartShareSelection} />;
  }

  if (subtype === "pull_request" && content) {
    const prMatch = content.match(/^#(\d+)\s+(.*)/);
    const prNum = prMatch ? prMatch[1] : "";
    const prTitle = prMatch ? prMatch[2] : content;
    return (
      <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-sol-violet/5 border border-sol-violet/20 rounded text-xs">
        <svg className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
        {prNum && <span className="text-sol-violet font-mono font-medium">#{prNum}</span>}
        <span className="text-sol-text-secondary truncate">{prTitle}</span>
        {timestamp && <span className="text-sol-text-dim ml-auto flex-shrink-0">{formatRelativeTime(timestamp)}</span>}
      </div>
    );
  }

  if (subtype === "commit" && content) {
    const sha = messageUuid?.slice(0, 7) || "";
    return (
      <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-emerald-500/5 border border-emerald-500/20 rounded text-xs">
        <svg className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m0 0l4-4m6 0v12m0 0l4-4m-4 4l-4-4" />
        </svg>
        {sha && <span className="text-emerald-500 font-mono font-medium">{sha}</span>}
        <span className="text-sol-text-secondary truncate">{content}</span>
        {timestamp && <span className="text-sol-text-dim ml-auto flex-shrink-0">{formatRelativeTime(timestamp)}</span>}
      </div>
    );
  }

  if ((subtype === "stop_hook_summary" || subtype === "local_command") && content) {
    if (subtype === "local_command") {
      const cmdName = content.match(/<command-name>([^<]*)<\/command-name>/)?.[1]?.replace(/^\//, "")
        || content.match(/<command-message>([^<]*)<\/command-message>/)?.[1]?.replace(/^\//, "");
      const stdout = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1]?.trim();
      const stderr = content.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/)?.[1]?.trim();
      const output = stripAnsiCodes(stdout || stderr || "");
      return (
        <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-sol-bg-alt/30 border-l-2 border-sol-cyan/30 text-xs">
          <svg className="w-3 h-3 text-sol-cyan/60 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <polyline points="4 17 10 11 4 5" />
          </svg>
          {cmdName && <span className="font-mono text-sol-cyan/80 font-medium">/{cmdName}</span>}
          {output && <span className="text-sol-text-muted font-mono truncate">{output.slice(0, 150)}</span>}
          {!cmdName && !output && <span className="text-sol-text-dim font-mono truncate">{stripAnsiCodes(content.replace(/<[^>]+>/g, "")).slice(0, 150)}</span>}
        </div>
      );
    }
    const trimmed = stripAnsiCodes(content).slice(0, 200);
    return (
      <div className="mb-3 flex items-center gap-2 px-3 py-2 bg-sol-bg-alt/30 border-l-2 border-sol-border text-xs">
        <span className="text-[10px] text-sol-text-dim bg-sol-bg-highlight px-1.5 py-0.5 rounded font-mono">hook</span>
        <span className="text-sol-text-muted font-mono truncate">{trimmed}</span>
      </div>
    );
  }

  if (subtype === "away_summary" && content) {
    const text = stripAnsiCodes(content).trim();
    return (
      <div className="my-2 rounded-lg bg-sol-bg-alt/40 border border-sol-border/40 px-4 py-3">
        <div className="flex items-center gap-1.5 mb-2">
          <svg className="w-3 h-3 text-sol-text-dim/50 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
          <span className="text-[10px] uppercase tracking-wider font-medium text-sol-text-dim/60">away summary</span>
        </div>
        <div className="text-[13px] text-sol-text-secondary break-words leading-relaxed whitespace-pre-line">
          <FormattedSummary text={text} />
        </div>
      </div>
    );
  }

  const cleanText = stripAnsiCodes(content.replace(/<[^>]+>/g, "")).slice(0, 200);
  if (!cleanText) return null;

  // Usage-limit notices share the amber warning tone of ApiErrorCard's limit
  // banner; every other status line keeps the neutral system gray.
  const warning = isWarningSystemNotice(content, subtype);
  return (
    <div className={`mb-4 px-3 py-2 border-l-2 text-xs ${warning ? "bg-amber-500/10 border-amber-500/40" : "bg-sol-bg-alt/20 border-sol-border"}`}>
      {subtype && (
        <span className={`text-[10px] mr-2 ${warning ? "text-amber-500" : "text-sol-text-dim"}`}>
          {warning ? "warning" : subtype.replace(/_/g, " ")}
        </span>
      )}
      <span className={`font-mono ${warning ? "text-amber-500" : "text-sol-text-muted"}`}>
        {cleanText}
        {content.length > 200 && "..."}
      </span>
    </div>
  );
}

// Inline conversation card for a dynamic-workflow run. Reads live run state by id
// (posted once as an anchor message), so it updates as the run progresses.
function DynamicRunCard({ runId, name }: { runId?: string; name?: string }) {
  const run = useWorkflowRun(runId);
  const status = run?.status as string | undefined;
  const sm = wfStatusMeta(status);
  return (
    <div className="my-2 rounded-lg border border-sol-cyan/25 bg-sol-cyan/[0.06] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-sol-cyan/15">
        <Workflow className="w-3.5 h-3.5 text-sol-cyan flex-shrink-0" />
        <span className="text-[10px] text-sol-cyan uppercase tracking-wider font-semibold">Workflow</span>
        <span className="text-xs text-sol-text-muted truncate">{run?.workflow_name || name || "workflow"}</span>
        <div className="ml-auto flex items-center gap-2 flex-shrink-0">
          {run?.agent_count != null && <span className="text-[10px] text-sol-text-dim">{run.agent_count} agents</span>}
          {run?.total_tokens ? <span className="text-[10px] text-sol-text-dim/70">{wfFmtTokens(run.total_tokens)} tok</span> : null}
          {status && (
            <span className={`text-[10px] flex items-center gap-1 ${sm.cls}`}>
              {sm.dot ? <span className={`w-1.5 h-1.5 rounded-full ${sm.dot}`} /> : sm.icon}
              {status}
            </span>
          )}
        </div>
      </div>
      <div className="px-3 py-2">
        {run ? <DynamicRunView run={run} compact /> : <span className="text-[11px] text-sol-text-dim">loading run…</span>}
      </div>
    </div>
  );
}

// A workflow anchor's content is the exact JSON the server posts
// (convex/workflow_runs.ts). Fork/resume can round-trip that anchor through a
// synthetic transcript, producing an assistant copy WITHOUT the
// "workflow_event" subtype — detect by content so those copies still render
// as the card instead of raw JSON.
function parseWorkflowEventContent(content: string | undefined): Record<string, any> | null {
  if (!content || !content.startsWith('{"__wf"')) return null;
  try { return JSON.parse(content); } catch { return null; }
}

function WorkflowEventBlock({ content, workflowRun, onGateChoice, gateResponding }: {
  content: string;
  workflowRun?: { _id: string; status: string; gate_response?: string | null } | null;
  onGateChoice?: (key: string) => void;
  gateResponding?: boolean;
}) {
  let event: Record<string, any> = {};
  try { event = JSON.parse(content); } catch { return null; }

  const wf = event.__wf as string;

  if (wf === "started") {
    return (
      <div className="my-2 flex items-center gap-2.5 px-3 py-2 rounded-lg bg-sol-violet/10 border border-sol-violet/25 text-xs">
        <svg className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span className="text-sol-text-muted">Workflow started</span>
        {event.goal && <span className="text-sol-text-dim truncate">— {event.goal}</span>}
      </div>
    );
  }

  if (wf === "node_start" || wf === "node_done" || wf === "node_failed") {
    const label = event.node_label || event.node_id;
    const nodeType = event.node_type || "agent";
    const isDone = wf === "node_done";
    const isFailed = wf === "node_failed";
    const isRunning = wf === "node_start";

    const typeColors: Record<string, { bg: string; border: string; text: string }> = {
      agent:   { bg: "bg-sol-green/20", border: "border-sol-green/50", text: "text-sol-green" },
      command: { bg: "bg-sol-yellow/20", border: "border-sol-yellow/50", text: "text-sol-yellow" },
      human:   { bg: "bg-sol-magenta/20", border: "border-sol-magenta/50", text: "text-sol-magenta" },
      prompt:  { bg: "bg-sol-violet/20", border: "border-sol-violet/50", text: "text-sol-violet" },
    };
    const tc = typeColors[nodeType] || typeColors.agent;

    return (
      <div className="my-0.5">
        <div className="flex items-center gap-1.5 text-xs">
          {isDone && <span className="text-emerald-400 text-[10px]">{"\u2713"}</span>}
          {isFailed && <span className="text-sol-red text-[10px]">{"\u2717"}</span>}
          {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow animate-pulse flex-shrink-0" />}
          <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${tc.bg} border ${tc.border} ${tc.text}`}>
            {nodeType}
          </span>
          <span className={`text-xs ${isFailed ? "text-sol-red/80" : "text-sol-text-muted"}`}>{label}</span>
          {isRunning && <span className="text-sol-text-dim/50 text-[10px]">running…</span>}
          {event.session_id && isDone && (
            <Link
              href={`/conversation/${event.session_id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-sol-cyan hover:text-sol-cyan text-[10px] font-medium underline underline-offset-2"
            >
              view
            </Link>
          )}
        </div>
      </div>
    );
  }

  if (wf === "workflow_run") {
    return <DynamicRunCard runId={event.run_id} name={event.name} />;
  }

  if (wf === "gate") {
    const choices = event.choices as Array<{ key: string; label: string; target: string }> | undefined;
    const isResolved = !workflowRun || workflowRun.status !== "paused";
    return (
      <div className="my-3 rounded-lg border border-sol-magenta/40 bg-sol-magenta/8 overflow-hidden">
        <div className="px-3 py-2 border-b border-sol-magenta/20 flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-sol-magenta flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-[10px] text-sol-magenta uppercase tracking-wider font-semibold">Human Gate</span>
          {isResolved
            ? <span className="ml-auto text-[10px] text-sol-green">responded</span>
            : <span className="ml-auto text-[10px] text-sol-magenta/70 animate-pulse">waiting…</span>
          }
        </div>
        <div className="px-3 py-2.5">
          <p className="text-sm text-sol-text">{event.prompt}</p>
          {!isResolved && choices && choices.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {choices.map(choice => (
                <button
                  key={choice.key}
                  onClick={() => onGateChoice?.(choice.key)}
                  disabled={gateResponding}
                  className="px-2 py-0.5 text-xs font-medium text-sol-text border border-sol-border/30 rounded hover:bg-sol-bg-highlight hover:border-sol-magenta/40 transition-colors disabled:opacity-40"
                >
                  <span className="font-mono text-sol-magenta mr-1">[{choice.key}]</span>
                  {choice.label.replace(/^\[.\]\s*/, "")}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
const SystemBlock = memo(SystemBlockImpl);

const CompactionSummaryBlock = memo(function CompactionSummaryBlock({ content }: { content: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="mb-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-2 text-xs text-sol-text-dim hover:text-sol-text-muted transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-amber-500/70">Previous context summary</span>
      </button>
      {isExpanded && (
        <div className="mt-2 px-3 py-2 bg-sol-bg-alt/20 border-l-2 border-amber-500/30 text-xs prose prose-invert prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={entityRemarkPlugins} components={MD_COMPONENTS_NO_PRE}>
            {content}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
});

const PLAN_MAX_HEIGHT = 1800;

function PlanBlockImpl({ content, timestamp, collapsed, messageId, conversationId, onOpenComments, onStartShareSelection }: { content: string; timestamp: number; collapsed?: boolean; messageId?: string; conversationId?: Id<"conversations">; onOpenComments?: (messageId: string) => void; onStartShareSelection?: (messageId: string) => void }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  const isRealMessageId = !!messageId && isConvexId(messageId);
  const { isBookmarked, toggleBookmark: handleToggleBookmark } = useMessageBookmark(conversationId, messageId);

  useWatchEffect(() => {
    if (contentRef.current && !isExpanded) {
      setIsOverflowing(contentRef.current.scrollHeight > PLAN_MAX_HEIGHT);
    }
  }, [content, isExpanded]);

  useWatchEffect(() => {
    if (!fullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [fullscreen]);

  const handleCopy = () => {
    setTimeout(() => { copyToClipboard(content || "").then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  const handleCopyLink = () => messageId && copyMessageLink(conversationId, messageId);
  const chatOn = useTeamFeature("chat");
  const handleForwardToChat = () => messageId && forwardMessageToChat(conversationId, messageId);

  const title = content.match(/^#\s+(.+)$/m)?.[1] || "Plan";

  if (collapsed) {
    return (
      <div className="mb-2 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-sol-text-muted">
          <svg className="w-3.5 h-3.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          <span className="font-medium">{title}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="group/plan relative mb-6 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-sol-border/40">
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          <span className="text-xs font-medium text-sol-text-muted">Plan</span>
          <span className="text-xs text-sol-text-dim">{formatRelativeTime(timestamp)}</span>
        </div>
        <div className="flex items-center gap-0.5">
          {onStartShareSelection && messageId && (
            <button onClick={() => onStartShareSelection(messageId)} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Share">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            </button>
          )}
          {messageId && (
            <button onClick={handleCopyLink} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Copy link">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
            </button>
          )}
          {chatOn && messageId && (
            <button onClick={handleForwardToChat} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Send to chat">
              <Forward className="w-3.5 h-3.5" />
            </button>
          )}
          {isRealMessageId && conversationId && (
            <button onClick={handleToggleBookmark} className={`p-1 rounded hover:bg-sol-bg-highlight ${isBookmarked ? "text-amber-400" : "text-sol-text-dim hover:text-sol-text-muted"} transition-colors`} title={isBookmarked ? "Remove bookmark" : "Bookmark"}>
              <svg className="w-3.5 h-3.5" fill={isBookmarked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
            </button>
          )}
          <button onClick={handleCopy} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Copy">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
          <button onClick={() => setFullscreen(true)} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Fullscreen">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
        </div>
      </div>
      <div className="px-4 py-3">
        <div
          ref={contentRef}
          className="relative prose prose-invert prose-sm max-w-none"
          style={!isExpanded && isOverflowing ? { maxHeight: PLAN_MAX_HEIGHT, overflowY: 'hidden' } : undefined}
        >
          <ReactMarkdown
            remarkPlugins={entityRemarkPlugins}
            rehypePlugins={MESSAGE_MD_REHYPE}
            components={MESSAGE_MD_COMPONENTS}
          >
            {content}
          </ReactMarkdown>
          {!isExpanded && isOverflowing && (
            <div className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none bg-gradient-to-b from-transparent to-[var(--sol-bg)]" />
          )}
        </div>
        {(isOverflowing || isExpanded) && (
          <div className="flex items-center gap-1 mt-2 pt-1 border-t border-sol-border/30">
            <FooterIconButton onClick={() => setFullscreen(true)} title="Fullscreen" label="Full Screen">
              <FullscreenIcon />
            </FooterIconButton>
            <FooterIconButton onClick={() => setIsExpanded(e => !e)} title={isExpanded ? "Collapse" : "Expand"}>
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </FooterIconButton>
          </div>
        )}
      </div>

      {fullscreen && createPortal(
        <div className="fixed inset-0 z-[10001] bg-sol-bg overflow-auto" onClick={() => setFullscreen(false)}>
          <div className="conv-col mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
                <span className="text-sol-text-secondary text-sm font-medium">Plan</span>
              </div>
              <button
                onClick={() => setFullscreen(false)}
                className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                title="Close"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="prose prose-invert prose-sm max-w-none text-sol-text">
              <ReactMarkdown
                remarkPlugins={entityRemarkPlugins}
                rehypePlugins={MESSAGE_MD_REHYPE}
                components={MESSAGE_MD_COMPONENTS}
              >
                {content}
              </ReactMarkdown>
            </div>
          </div>
        </div>,
        document.body
      )}

    </div>
  );
}
const PlanBlock = memo(PlanBlockImpl);

function GitBranchBadge({
  gitBranch,
  gitStatus,
  gitRemoteUrl,
  hasDiff,
  diffExpanded,
  onToggleDiff,
}: {
  gitBranch: string;
  gitStatus?: string | null;
  gitRemoteUrl?: string | null;
  hasDiff: boolean;
  diffExpanded: boolean;
  onToggleDiff: () => void;
}) {
  const isClean = gitStatus === "(clean)" || gitStatus === "clean" || !gitStatus;

  const githubUrl = gitRemoteUrl
    ? (() => {
        const match = gitRemoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
        if (match) {
          return `https://github.com/${match[1]}/tree/${gitBranch}`;
        }
        return null;
      })()
    : null;

  return (
    <button
      onClick={() => hasDiff && onToggleDiff()}
      className={`font-mono text-[11px] text-sol-text-muted flex-shrink-0 ${hasDiff ? "cursor-pointer hover:text-sol-text-secondary" : "cursor-default"}`}
      title={hasDiff ? (diffExpanded ? "hide diff" : "show diff") : undefined}
    >
      (
      {githubUrl ? (
        <a
          href={githubUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sol-green hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {gitBranch}
        </a>
      ) : (
        <span className="text-sol-green">{gitBranch}</span>
      )}
      {!isClean && <span className="text-sol-orange ml-0.5">*</span>})
    </button>
  );
}

function GitDiffPanel({
  gitDiff,
  gitDiffStaged,
}: {
  gitDiff?: string | null;
  gitDiffStaged?: string | null;
}) {
  return (
    <div className="border-t border-sol-border bg-sol-bg-alt/30">
      <div className="conv-col mx-auto px-4 py-2 max-h-96 overflow-y-auto">
        {gitDiffStaged && gitDiffStaged.trim().length > 0 && (
          <div className="mb-2">
            <div className="text-sol-green text-[10px] font-semibold mb-1">Staged</div>
            <div className="rounded overflow-hidden bg-sol-bg-inset border border-sol-border/30">
              <GitDiffView diff={gitDiffStaged} />
            </div>
          </div>
        )}
        {gitDiff && gitDiff.trim().length > 0 && (
          <div>
            {gitDiffStaged && gitDiffStaged.trim().length > 0 && (
              <div className="text-sol-orange text-[10px] font-semibold mb-1">Unstaged</div>
            )}
            <div className="rounded overflow-hidden bg-sol-bg-inset border border-sol-border/30">
              <GitDiffView diff={gitDiff} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function GitDiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');

  return (
    <div className="font-mono text-xs p-2 overflow-x-auto scrollbar-auto">
      <div className="min-w-fit">
      {lines.map((line, i) => {
        let className = 'whitespace-pre text-sol-text-muted';

        if (line.startsWith('+') && !line.startsWith('+++')) {
          className = 'whitespace-pre bg-sol-green/10 text-sol-green';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          className = 'whitespace-pre bg-sol-red/10 text-sol-red';
        } else if (line.startsWith('@@')) {
          className = 'whitespace-pre text-sol-blue';
        } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
          className = 'whitespace-pre text-sol-text-secondary font-medium';
        }

        return (
          <div key={i} className={className}>
            {line}
          </div>
        );
      })}
      </div>
    </div>
  );
}

// The composer's own send chords. They are handled inline in handleKeyDown
// (they must run from a focused textarea, which the global registry never
// does), so this table is their one source of truth for the "?" popover;
// every other binding lives in the registry and shows in the shortcuts panel.
const SEND_CHORDS: ReadonlyArray<{ accel: string; label: string }> = [
  { accel: "enter", label: "Send" },
  { accel: "shift+enter", label: "New line" },
  { accel: "ctrl+enter", label: "Queue for later" },
  { accel: "alt+enter", label: "Send and advance" },
  { accel: "alt+shift+enter", label: "Send and stash" },
  { accel: "meta+shift+enter", label: "Fork and send" },
  { accel: "meta+shift+e", label: "Rich editor" },
];

function ShortcutHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sol-text/70">{label}</span>
      <span className="flex items-center gap-[2px]">
        {keys.map((k, i) => (
          <KeyCap key={i} size="xs">{k}</KeyCap>
        ))}
      </span>
    </div>
  );
}

function GuestJoinCTA() {
  return (
    <div className="bg-sol-bg border-t border-sol-border/30">
      <div className="mx-auto conv-col px-2 sm:px-4 py-3 flex items-center justify-between gap-4">
        <a href="/" className="flex items-center gap-2 text-sol-text-dim text-xs hover:text-sol-text transition-colors">
          <LogoIcon size={20} />
          <span className="font-mono font-bold text-sol-text-muted tracking-tight">codecast</span>
          <span className="opacity-50">|</span>
          <span>AI session sharing</span>
        </a>
        <a
          href="/signup"
          className="text-xs font-medium px-4 py-1.5 rounded-full bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/25 transition-colors whitespace-nowrap"
        >
          Join to message
        </a>
      </div>
    </div>
  );
}

// Isolated component: keeps useConvexAuth() out of ConversationView's render
// scope so auth-context re-renders don't cascade through the tooltip ref chain.
function NonOwnerMessageInput({ conversation, onForkReply, autoFocusInput }: {
  conversation: ConversationData;
  onForkReply: (content: string) => void;
  autoFocusInput?: boolean;
}) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  if (!isAuthenticated && !isLoading) return <GuestJoinCTA />;
  // Signed-in non-owner: a grant-aware composer that can co-write, request send
  // access, send into the live session once granted, or fork as a fallback.
  return (
    <CollabComposer
      conversation={conversation}
      onForkReply={onForkReply}
      autoFocusInput={autoFocusInput}
    />
  );
}

const ForkReplyInput = memo(function ForkReplyInput({ userName, userAvatar, onForkReply, autoFocusInput }: { userName: string; userAvatar?: string | null; onForkReply: (content: string) => void; autoFocusInput?: boolean }) {
  const [message, setMessage] = useState("");
  const [isForking, setIsForking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useMountEffect(() => { if (autoFocusInput && !hasOpenModal() && textareaRef.current) textareaRef.current.focus(); });
  useWatchEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  }, [message]);
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim() || isForking) return;
    setIsForking(true);
    onForkReply(message.trim());
    setMessage("");
  };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };
  return (
    <div className="bg-sol-bg">
      <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] text-sol-violet border-t border-sol-violet/15 bg-sol-violet/5">
        <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" />
        </svg>
        <span>
          Viewing <span className="font-medium">{userName}</span>'s session
          <span className="text-sol-text-dim ml-1">-- reply to fork as your own</span>
        </span>
      </div>
      <form onSubmit={handleSubmit} className="mx-auto conv-col px-2 sm:px-4 pb-3 pt-1.5">
        <div className="flex items-end gap-2 border px-4 py-2 rounded-2xl bg-sol-bg-alt border-sol-violet/30 shadow-lg">
          <textarea
            ref={textareaRef}
            data-chat-input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isForking}
            placeholder="Reply to fork this session..."
            rows={1}
            className="flex-1 bg-transparent text-sm placeholder:text-sol-text-dim focus:outline-none disabled:opacity-50 resize-none overflow-hidden leading-relaxed py-1 text-sol-text"
          />
          <button
            type="submit"
            disabled={!message.trim() || isForking}
            className={`shrink-0 h-8 px-3 rounded-full transition-colors flex items-center gap-1.5 text-xs font-medium border ${
              !message.trim() || isForking
                ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed"
                : "border-sol-violet/50 bg-sol-violet/20 text-sol-violet hover:bg-sol-violet/30 hover:border-sol-violet"
            }`}
          >
            {isForking ? (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            )}
            Fork & reply
          </button>
        </div>
      </form>
    </div>
  );
});

// The composer-footer "working" status line. A working turn can go quiet for
// minutes — one long generation, or a long-running tool whose result hasn't
// landed yet — and a static "Working" reads as frozen. Past a short grace, surface
// a live-ticking elapsed clock (and the tool in flight, if any) so a long turn
// visibly reads as progressing. startedAt = last rendered message timestamp (how
// long the view has been static); toolLabel = the tool currently in flight, if the
// tail is an unanswered tool call. Owns its own 1s ticker so only this tiny node
// re-renders each second, not the whole composer.
function WorkingStatusLine({ startedAt, toolLabel }: { startedAt?: number; toolLabel?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsedMs = startedAt ? now - startedAt : 0;
  const showElapsed = shouldShowElapsed(startedAt, now);
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
      Working
      {showElapsed && <span className="text-sol-text-dim/60 tabular-nums">· {formatElapsedClock(elapsedMs)}</span>}
      {showElapsed && toolLabel && <span className="text-sol-text-dim/60">· {formatToolName(toolLabel)}</span>}
    </span>
  );
}

export const MessageInput = memo(function MessageInput({ conversationId, status, embedded, onSendAndAdvance, onSendAndDismiss, autoFocusInput, initialDraft, isWaitingForResponse, isThinking, isConversationLive, isSessionDisconnected, isSessionStarting, isSessionReady, sessionId, agentType, agentStatus, deliveryStatus, pendingPermissionsCount, hasAskUserQuestion, selectedMessageContent, selectedMessageUuid, onClearSelection, onForkFromMessage, onForkSend, onSendEscape, onOpenNavigator, onPopulateInput, permissionMode, onCycleMode, onMessageSent, onLightboxChange, onDropFiles, onWorkflowLaunch, onGateSend, skills, filePaths, mentionItemsRef, onMentionQuery, onSubmitWithIntent, onDidSend, branchMapNode, bareComposer, chatMentionMode, mentionTeamId, composerPlaceholder, workingSinceTs, workingTool, escapeOwnedRef }: { conversationId: string; status?: string; embedded?: boolean; onSendAndAdvance?: () => void; onSendAndDismiss?: () => void; autoFocusInput?: boolean; initialDraft?: string; isWaitingForResponse?: boolean; isThinking?: boolean; isConversationLive?: boolean; isSessionDisconnected?: boolean; isSessionStarting?: boolean; isSessionReady?: boolean; sessionId?: string; agentType?: string; agentStatus?: AgentStatus; deliveryStatus?: string; pendingPermissionsCount?: number; hasAskUserQuestion?: boolean; selectedMessageContent?: string | null; selectedMessageUuid?: string | null; onClearSelection?: () => void; onForkFromMessage?: (uuid: string) => void; onForkSend?: (content: string) => void; onSendEscape?: () => void; onOpenNavigator?: () => void; onPopulateInput?: React.MutableRefObject<((text: string, opts?: { append?: boolean }) => void) | null>; permissionMode?: string; onCycleMode?: () => void; onMessageSent?: () => void; onLightboxChange?: (active: boolean) => void; onDropFiles?: React.MutableRefObject<((files: File[]) => void) | null>; onWorkflowLaunch?: (goal: string) => Promise<void>; onGateSend?: (content: string, images?: Array<{ storageId?: string; previewUrl: string; mime: string; uploading: boolean }>) => Promise<void>; skills?: SkillItem[]; filePaths?: string[]; mentionItemsRef?: React.MutableRefObject<MentionItem[]>; onMentionQuery?: (q: string) => void; onSubmitWithIntent?: (navigate: boolean) => void; onDidSend?: (info: { conversationId: string; content: string; clientId: string }) => void; branchMapNode?: React.ReactNode; bareComposer?: boolean; chatMentionMode?: boolean; mentionTeamId?: string; composerPlaceholder?: string; workingSinceTs?: number; workingTool?: string; escapeOwnedRef?: React.MutableRefObject<boolean> }) {
  const sacredKey = sessionId || conversationId;
  const sacredKeyRef = useRef(sacredKey);
  const convIdRef = useRef(conversationId);
  const cached = useInboxStore.getState().getDraft(conversationId);
  // The exact text last seeded from a PERSISTED source (store draft or the
  // conversation row's draft_message), still untouched by the user. While set,
  // the delayed stale re-check may heal it against the message window once
  // messages load (the mount-time check often runs before they have), and the
  // leave-time snapshot refuses to re-create a draft another surface cleared —
  // untouched seeded text is display state, not input. Any setMessage —
  // typing, send, populate — voids it.
  const seededDraftRef = useRef<string | null>(null);
  // Fallback to the conversation-keyed entry: when a new session gets its
  // session_id stamped the key flips (conv id → session id) and this component
  // remounts — the freshest text lives under the conversation id.
  const [message, _setMessage] = useState(() => {
    const sacred = sacredInputs.get(sacredKey)?.text ?? sacredInputs.get(conversationId)?.text;
    if (sacred != null) return sacred;
    const persisted = cached?.draft_message ?? initialDraft ?? "";
    // Sacred text is live user input and always restores; the persisted
    // sources go through the stale-sent-draft check (a draft with images
    // attached is kept — the images make it more than a resent copy).
    if (!cached?.draft_image_storage_ids?.length) {
      if (isStaleSentDraft(conversationId, persisted)) return "";
      if (persisted) seededDraftRef.current = persisted;
    }
    return persisted;
  });
  // Whether the composer held text at any point while showing this conversation.
  // Gates the durable clear on leave: an emptied composer that once had text is
  // an explicit clear gesture; one that was never filled must not eat a draft
  // another surface (second tab, compose popup) wrote meanwhile.
  const hadTextRef = useRef(!!message);
  const setMessage = useCallback((val: string) => {
    if (val) hadTextRef.current = true;
    seededDraftRef.current = null;
    sacredInputs.set(sacredKeyRef.current, { text: val });
    // Mirror under the conversation id so the text survives the key flip above.
    if (convIdRef.current !== sacredKeyRef.current) sacredInputs.set(convIdRef.current, { text: val });
    _setMessage(val);
  }, []);
  const messageRef = useRef(message);
  messageRef.current = message;
  const sendingRef = useRef(false);
  const [isFocused, setIsFocused] = useState(false);
  const [composeMode, setComposeMode] = useState(false);
  const [composeHasContent, setComposeHasContent] = useState(false);
  const composeRef = useRef<ComposeEditorHandle>(null);
  const { user: mentionUser } = useCurrentUser();
  // Narrowed: MessageInput only needs the session's team_id (for mention scope), which
  // never changes on a heartbeat. Subscribing to the whole row re-rendered the input
  // (and its draft textarea) ~1×/s for a live session.
  const composeTeamId = useInboxStore((s) => s.sessions[conversationId]?.team_id);
  // Suggestion pills pref — off by default; the strip mounts only when on.
  const suggestionsEnabled = useInboxStore((s) => s.clientState?.ui?.composer_suggestions === true);
  // The mention picker is team-scoped, so it surfaces sessions from sibling repos.
  // We show a row's project only when it differs from this one — same-repo rows
  // would just repeat it. This is the current conversation's project basename.
  const composeProject = useInboxStore((s) => {
    const sess = s.sessions[conversationId];
    const p = sess?.project_path || sess?.git_root;
    return p ? (p.split("/").filter(Boolean).pop() || null) : null;
  });
  const memberTeams = useInboxStore((s) => s.teams);
  const mentionScope = useMemo(() => {
    const teamId = mentionTeamId
      ? String(mentionTeamId)
      : composeTeamId ? String(composeTeamId) : null;
    const isMember = teamId
      ? (memberTeams || []).some((t: any) => String(t._id) === teamId)
      : false;
    if (teamId && isMember) return { kind: "team" as const, teamId };
    const uid = mentionUser?._id ? String(mentionUser._id) : "";
    return uid ? { kind: "personal" as const, userId: uid } : { kind: "any" as const };
  }, [mentionTeamId, composeTeamId, memberTeams, mentionUser?._id]);
  const composeMentionQuery = useMentionQuery(mentionScope);
  const [shortcutTooltip, setShortcutTooltip] = useState<{ x: number; y: number } | null>(null);
  const [pendingMessageId, setPendingMessageId] = useState<Id<"pending_messages"> | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [showStuckBanner, setShowStuckBanner] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  // Distinct from isResuming: true only while a destructive kill+restart is in flight, so the
  // footer can say "Killing & restarting" instead of the gentler "Waiting for connection".
  const [isRestarting, setIsRestarting] = useState(false);
  const [optimisticSending, setOptimisticSending] = useState(false);
  const [showModeLabel, setShowModeLabel] = useState(false);
  const [modeTooltip, setModeTooltip] = useState(false);
  const modeLabelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoResumeTriggeredRef = useRef(false);
  // Guards the one allowed automatic kill+restart: fires once when the daemon has declared a
  // sent message undeliverable (delivery genuinely failed over many minutes), reset per message.
  const autoRestartTriggeredRef = useRef(false);
  const resumeSessionMutation = useMutation(api.users.resumeSession);
  const convCommand = useInboxStore((s) => s.convCommand);
  // Live kill→resume ladder while a recovery is in flight: the daemon stamps
  // each command row (executed_at + result/error), so the footer can show what
  // is actually happening instead of an indefinite spinner. Skip-gated so the
  // query costs nothing outside recovery.
  const restartProgress = useQuery(
    api.conversations.getRestartProgress,
    (isRestarting || isResuming) && isConvexId(conversationId)
      ? { conversation_id: conversationId }
      : "skip",
  ) as { command: string; created_at: number; executed_at: number | null; result: string | null; error: string | null }[] | null | undefined;
  // Flips on when a restart request has sat unclaimed long enough that the
  // owning daemon is probably offline — the one failure the command rows can't
  // report themselves.
  const [restartWaitingLong, setRestartWaitingLong] = useState(false);
  const restartStage = useMemo(
    () => deriveRestartStage(restartProgress, restartWaitingLong),
    [restartProgress, restartWaitingLong],
  );
  useWatchEffect(() => {
    if (!isRestarting && !isResuming) { setRestartWaitingLong(false); return; }
    if (restartProgress?.some((c) => c.executed_at)) { setRestartWaitingLong(false); return; }
    const t = setTimeout(() => setRestartWaitingLong(true), 20_000);
    return () => clearTimeout(t);
  }, [isRestarting, isResuming, restartProgress]);
  const cancelMessageMutation = useMutation(api.pendingMessages.cancelPendingMessage);
  const addOptimistic = useInboxStore((s) => s.addOptimisticMessage);
  const markAsQueued = useInboxStore((s) => s.markOptimisticAsQueued);
  const sentContentRef = useRef<string | null>(null);

  type AutocompleteTrigger = { type: "/" | "@"; startPos: number } | null;
  type AcItem = {
    label: string;
    description?: string;
    type: string;
    id?: string;
    shortId?: string;
    status?: string;
    priority?: string;
    docType?: string;
    messageCount?: number;
    projectPath?: string;
    updatedAt?: number;
    idleSummary?: string;
    goal?: string;
    model?: string;
    image?: string;
    handle?: string;
    isBot?: boolean;
  };
  const [acTrigger, setAcTrigger] = useState<AutocompleteTrigger>(null);
  const [acIndex, setAcIndex] = useState(0);
  const acRef = useRef<HTMLDivElement>(null);
  // Chat mode anchors the popup at the @ itself. The zero-height div right
  // above the form is the positioning context; this is the popup's left within
  // it, measured from the @'s pixel position inside the textarea.
  const acAnchorRef = useRef<HTMLDivElement>(null);
  const [acCaretLeft, setAcCaretLeft] = useState(0);
  useLayoutEffect(() => {
    if (!chatMentionMode || !acTrigger || acTrigger.type !== "@") return;
    const ta = textareaRef.current;
    const host = acAnchorRef.current;
    if (!ta || !host) return;
    const caret = textareaCaretRect(ta, acTrigger.startPos);
    const taRect = ta.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const raw = taRect.left - hostRect.left + caret.left - ta.scrollLeft;
    setAcCaretLeft(Math.max(0, Math.min(raw, Math.max(0, hostRect.width - CHAT_AC_WIDTH))));
  }, [chatMentionMode, acTrigger]);
  const filePathsRef = useRef(filePaths);
  filePathsRef.current = filePaths;

  // Embedded composers (the new-session popup) have no ConversationView parent
  // to build mention items, so @ would only surface the server-searched types.
  // Fall back to the team-scoped mention query (mentionScope above) so people,
  // tasks, docs, and plans resolve there too — people stay bounded to the team.
  const localMentionItemsRef = useRef<MentionItem[]>([]);
  const [localMentionTick, setLocalMentionTick] = useState(0);
  const effectiveMentionItemsRef = mentionItemsRef ?? localMentionItemsRef;
  const queryMentions = useCallback((q: string) => {
    if (mentionItemsRef) { onMentionQuery?.(q); return; }
    void composeMentionQuery(q).then((items) => {
      localMentionItemsRef.current = items;
      setLocalMentionTick((t) => t + 1);
    });
  }, [mentionItemsRef, onMentionQuery, composeMentionQuery]);

  const acQuery = useMemo(() => {
    if (!acTrigger) return "";
    const rawQuery = message.slice(acTrigger.startPos + 1);
    return (acTrigger.type === "@" ? (rawQuery.match(MENTION_QUERY_RE)?.[0] ?? "").trim() : rawQuery).toLowerCase();
  }, [acTrigger, message]);

  // While an @-mention is being typed, also search the server — it reaches
  // sessions/entities outside the local cache window. People are fully cached
  // locally, so only the windowed types go over the wire.
  const { items: acServerItems, loading: acServerLoading } = useMentionServerSearch(
    acTrigger?.type === "@" ? acQuery : null,
    // mentionScope, not raw composeTeamId: the scope is membership-checked, so
    // a conversation routed to a team the viewer isn't in searches personal
    // instead of tripping the server's membership guard.
    { teamId: mentionScope.kind === "team" ? mentionScope.teamId : undefined, types: SERVER_MENTION_TYPES },
  );

  const acItems: AcItem[] = useMemo(() => {
    if (!acTrigger) return [];
    if (acTrigger.type === "/") {
      return (skills || [])
        .filter(s => s.name.toLowerCase().includes(acQuery))
        .slice(0, 30)
        .map(s => ({ label: s.name, description: s.description, type: "skill" as string }));
    }
    if (acTrigger.type === "@") {
      const items: AcItem[] = [];
      const currentMentionItems = effectiveMentionItemsRef.current;

      // Cap per type so a flood of sessions doesn't push tasks/docs out.
      const perTypeCap = acQuery ? 5 : 6;
      const perType: Record<string, number> = {};
      const entityMatches: AcItem[] = [];
      if (currentMentionItems?.length) {
        for (const m of currentMentionItems) {
          // Chat: a label tags nothing here, and a person with no resolvable
          // handle cannot be notified — offering either is a lie the composer
          // tells about what the send will do.
          if (chatMentionMode && m.type === "label") continue;
          if (chatMentionMode && m.type === "person" && !m.handle) continue;
          if (!mentionItemMatches(m, acQuery)) continue;
          const c = perType[m.type] || 0;
          if (c >= perTypeCap) continue;
          perType[m.type] = c + 1;
          entityMatches.push({
            label: m.label,
            description: m.sublabel,
            type: m.type,
            id: m.id,
            shortId: m.shortId,
            image: m.image,
            messageCount: m.messageCount,
            projectPath: m.projectPath,
            updatedAt: m.updatedAt,
            idleSummary: m.idleSummary,
            handle: m.handle,
            isBot: m.isBot,
          });
        }
      }

      // Server results fill in below the cache hits, deduped by id, sharing the
      // same per-type budget so the dropdown stays scannable.
      const localIds = new Set(entityMatches.map(m => m.id));
      for (const m of acServerItems) {
        if (!m.id || localIds.has(m.id)) continue;
        const c = perType[m.type] || 0;
        if (c >= perTypeCap + 3) continue;
        perType[m.type] = c + 1;
        entityMatches.push({
          label: m.label,
          description: m.sublabel,
          type: m.type,
          id: m.id,
          shortId: m.shortId,
          image: m.image,
          messageCount: m.messageCount,
          projectPath: m.projectPath,
          updatedAt: m.updatedAt,
          idleSummary: m.idleSummary,
        });
      }

      // Regroup same-type items contiguously (first-appearance type order): the
      // dropdown renders grouped-by-type and its selection index math assumes
      // each type occupies one contiguous run of acItems.
      const typeOrder: string[] = [];
      for (const it of entityMatches) if (!typeOrder.includes(it.type)) typeOrder.push(it.type);
      for (const t of typeOrder) items.push(...entityMatches.filter(it => it.type === t));

      const fileMatches = (filePathsRef.current || [])
        .filter(p => {
          const name = p.split("/").pop() || p;
          return matchScore(name, acQuery) !== Infinity || matchScore(p, acQuery) !== Infinity;
        })
        .slice(0, 8)
        .map(p => ({ label: p, description: undefined, type: "file" as string }));
      items.push(...fileMatches);

      return items;
    }
    return [];
    // localMentionTick re-runs this when the fallback query resolves into the ref.
  }, [acTrigger, acQuery, skills, acServerItems, localMentionTick, chatMentionMode]);

  const clampedAcIndex = acItems.length > 0 ? Math.min(acIndex, acItems.length - 1) : 0;

  // A multi-word @ query that has settled on zero matches is prose, not a
  // mention: every word must hit, so typing more can never bring matches back.
  // Close the trigger and remember where it died; handleMessageChange keeps it
  // closed while the query only grows, and lets it reopen once the user
  // deletes back past that point. Without this every further keystroke would
  // reopen the popup on a spinner and fire another server search.
  const mentionDeadEndRef = useRef<{ startPos: number; len: number } | null>(null);
  useEffect(() => {
    if (!acTrigger || acTrigger.type !== "@" || acServerLoading) return;
    if (acItems.length > 0 || !acQuery.includes(" ")) return;
    mentionDeadEndRef.current = { startPos: acTrigger.startPos, len: acQuery.length };
    setAcTrigger(null);
  }, [acTrigger, acItems, acServerLoading, acQuery]);

  const applyAutocomplete = useCallback((item: AcItem) => {
    if (!acTrigger) return;
    if (acTrigger.type === "/") {
      const newVal = `/${item.label} `;
      setMessage(newVal);
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = newVal.length;
        }
      }, 0);
    } else {
      const before = message.slice(0, acTrigger.startPos);
      const cursorPos = textareaRef.current?.selectionStart ?? message.length;
      const after = message.slice(cursorPos);

      let inserted: string;
      if (chatMentionMode && item.type === "person" && item.handle) {
        // The handle the server resolves, at the @ the user typed. The ref form
        // (`@[Name id]`) is the session vocabulary; for people in chat it only
        // notified when the label happened to contain the handle — and the
        // anchor's label never did, which is how "@[Anchor] hi" woke nothing.
        inserted = `@${item.handle} `;
      } else if (item.type === "file" || item.type === "skill") {
        inserted = `@${item.label} `;
      } else {
        const truncTitle = item.label.length > 30 ? item.label.slice(0, 30) + "..." : item.label;
        const id = item.shortId || (item.type === "doc" ? `doc:${item.id}` : "");
        const ref = id ? `@[${truncTitle} ${id}]` : `@[${truncTitle}]`;
        inserted = `${ref} `;
      }

      const newVal = before + inserted + after;
      setMessage(newVal);
      const newCursor = before.length + inserted.length;
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = newCursor;
        }
      }, 0);
    }
    setAcTrigger(null);
    setAcIndex(0);
    textareaRef.current?.focus();
  }, [acTrigger, message, chatMentionMode]);

  // Enrichment only (banner + kill guard); the composer renders without it, so a
  // server error must degrade the feature, not unmount the composer.
  const { data: messageStatus } = useQueryNoThrow(
    api.pendingMessages.getMessageStatus,
    pendingMessageId ? { message_id: pendingMessageId } : "skip"
  );

  const canQueryServer = isConvexId(conversationId);
  const existingPending = usePendingMessageStatus(canQueryServer ? conversationId : null);

  // The send is fire-and-forget through the store sync, so we no longer get the
  // message id back. Recover precise per-message status tracking from the
  // conversation-scoped pending row once the server has it — keeps the stuck
  // banner and the live-session kill-protection (messageReachedSession) intact.
  // The row's `_id` is the CONVERSATION id (it is the store key of a
  // per-conversation singleton); the pending_messages id lives in `message_id`.
  useWatchEffect(() => {
    if (pendingMessageId || !sentAt || !existingPending?.message_id) return;
    if (existingPending.status === "delivered") return;
    setPendingMessageId(existingPending.message_id);
  }, [pendingMessageId, sentAt, existingPending]);

  const isAgentStarting = agentStatus === "starting" || agentStatus === "resuming" || deliveryStatus === "starting";
  const isAgentDelivering = agentStatus === "connected" || deliveryStatus === "connected";
  const isAgentResuming = agentStatus === "resuming";
  // Alive-but-parked (dormant/waiting/done): the pane heartbeats and the daemon
  // delivers on its next pass. These — and "connected", which means the daemon
  // has CLAIMED the message and is mid-delivery — get the same 60s budget as a
  // cold start. The old 15-30s threshold fired the stuck banner (and its
  // auto-resume) while a delivery was already in flight, which is exactly what
  // made slow deliveries look like lost messages.
  const isAgentAliveIdle = isAliveIdleStatus(agentStatus as LiveAgentStatus | undefined);
  const stuckThresholdMs = isAgentResuming ? 120_000 : isSessionStarting || isAgentStarting || isAgentDelivering || isAgentAliveIdle ? 60_000 : isSessionReady ? 30_000 : 15_000;

  const isExistingMessageDead = existingPending?.status === "failed" || existingPending?.status === "undeliverable";

  // Daemon-reported agent_status is the authoritative "session is alive and processing"
  // signal: it propagates via heartbeat seconds ahead of an assistant message reaching the
  // timeline (which is what isConversationLive/isThinking rely on). Trust it as proof the
  // message reached the session so we never resume — or worse, kill+restart — a live agent.
  const isAgentActive = agentStatus === "thinking" || agentStatus === "working" || agentStatus === "compacting" || agentStatus === "permission_blocked";
  // Durable, persisted proof of delivery: the daemon marks a message "injected" the moment
  // it lands in tmux and "delivered" once acked. (It resets "injected"→"pending" if the
  // session dies, so this is only set while the message genuinely sits in a live session.)
  // Unlike the transient heartbeat this doesn't race propagation — once set, a kill+restart
  // would only destroy a session that already has the message.
  const messageReachedSession = messageStatus?.status === "injected" || messageStatus?.status === "delivered";

  useWatchEffect(() => {
    if (pendingMessageId) return;
    if (!existingPending) {
      if (!isWaitingForResponse) setShowStuckBanner(false);
      autoResumeTriggeredRef.current = false;
      autoRestartTriggeredRef.current = false;
      return;
    }
    const age = Date.now() - existingPending.created_at;
    // Stale pendings from old sessions are noise — only banner for recent messages
    if (age > 10 * 60_000) return;
    if (isExistingMessageDead) {
      setShowStuckBanner(true);
      return;
    }
    // "injected" means the daemon already typed the message into the live session — it
    // reached the agent (which may be mid-turn). The ack→"delivered" promotion can race or
    // never fire (boot-time inject, resume/rekey divergence), but that's no reason to claim
    // "Message not reaching session." Treat injected as delivered for the banner; the benign
    // "Working/Processing" line covers it, and a genuinely dead session is still caught by the
    // heartbeat-driven resume/restart guards below.
    if (existingPending.status === "injected") {
      setShowStuckBanner(false);
      return;
    }
    if (age > stuckThresholdMs) {
      setShowStuckBanner(true);
    } else {
      const timer = setTimeout(() => setShowStuckBanner(true), stuckThresholdMs - age);
      return () => clearTimeout(timer);
    }
  }, [existingPending, pendingMessageId, isWaitingForResponse, stuckThresholdMs, isExistingMessageDead]);

  // Agent actively working — or durable proof the message was injected/delivered — proves it
  // reached the session, so clear any stale stuck banner. messageReachedSession is the same
  // signal the resume guards trust to NOT kill the session; keep the banner consistent with it.
  useWatchEffect(() => {
    if (showStuckBanner && (isAgentActive || messageReachedSession)) {
      setShowStuckBanner(false);
      setIsRestarting(false);
    }
  }, [showStuckBanner, isAgentActive, messageReachedSession]);

  useWatchEffect(() => {
    if (!sentAt || !pendingMessageId) return;
    // Both delivered (success) and cancelled (user stopped it) are terminal — tear down the
    // tracker and banner either way so the composer returns to its resting state.
    if (messageStatus?.status === "delivered" || messageStatus?.status === "cancelled") {
      if (messageStatus?.status === "delivered" && sentContentRef.current) {
        markAsQueued(conversationId, sentContentRef.current);
      }
      sentContentRef.current = null;
      setPendingMessageId(null);
      setSentAt(null);
      setShowStuckBanner(false);
      return;
    }
    const timer = setTimeout(() => {
      if (messageStatus?.status === "pending") {
        setShowStuckBanner(true);
      }
    }, stuckThresholdMs);
    return () => clearTimeout(timer);
  }, [sentAt, pendingMessageId, messageStatus?.status, conversationId, markAsQueued, stuckThresholdMs]);

  // Removed: generic 60s timeout was showing "not responding" even when no message was sent.
  // The banner should only show when we sent a message and it wasn't delivered (handled by the effects above).

  const sendRef = useRef<HTMLDivElement>(null);
  const pastedImagesRef = useRef<Array<{ file: File; previewUrl: string; storageId?: Id<"_storage">; uploading: boolean }>>([]);
  const [pastedImages, setPastedImages] = useState<Array<{ file: File; previewUrl: string; storageId?: Id<"_storage">; uploading: boolean }>>(
    () => restoreDraftImages(cached) as Array<{ file: File; previewUrl: string; storageId?: Id<"_storage">; uploading: boolean }>
  );
  const staleImageIds = useMemo(() => {
    const ids = pastedImages
      .filter(img => img.storageId && (!img.previewUrl || img.previewUrl.startsWith("blob:")))
      .map(img => img.storageId!);
    return ids.length > 0 ? ids : null;
  }, [pastedImages]);
  const resolvedImageUrls = useQuery(
    api.images.getImageUrls,
    staleImageIds ? { storageIds: staleImageIds as Id<"_storage">[] } : "skip"
  );
  useWatchEffect(() => {
    if (!resolvedImageUrls) return;
    setPastedImages(prev => {
      const updated = prev.map(img => {
        if (img.storageId && resolvedImageUrls[img.storageId as string]) {
          return { ...img, previewUrl: resolvedImageUrls[img.storageId as string]! };
        }
        return img;
      });
      if (updated.length > 0) {
        persistDraftImages(conversationId, messageRef.current, updated);
      }
      return updated;
    });
  }, [resolvedImageUrls, conversationId]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Root of the composer, used to find the stacking context the image lightbox
  // must portal into. In the regular conversation the lightbox goes to
  // document.body (z-10001) and the composer raises itself above it (z-10002).
  // Inside a dialog host (the new-session compose popup) the composer is capped
  // by the dialog overlay's stacking context, so a body-level lightbox would
  // cover the whole dialog and block typing — portal into the dialog instead,
  // where the same z ordering keeps the input on top.
  const composerRootRef = useRef<HTMLDivElement>(null);
  const escapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedImageIndex, setSelectedImageIndex] = useState<number | null>(null);
  const [lightboxImageIndex, setLightboxImageIndex] = useState<number | null>(null);
  const dismissLightbox = useCallback(() => { setLightboxImageIndex(null); textareaRef.current?.focus(); }, []);
  useWatchEffect(() => { onLightboxChange?.(lightboxImageIndex !== null); }, [lightboxImageIndex, onLightboxChange]);
  const lightboxSwipe = useSwipeToDismiss(dismissLightbox);
  // Durable send: routes through the store's dispatch outbox so a reload
  // mid-send survives and is redriven on next load (idempotent on client_id).
  const sendMessage = useInboxStore((s) => s.sendMessage);
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);
  const convex = useConvex();

  // Best-effort enrichment, hard-bounded so it can NEVER block the durable send:
  // a stalled convex.query (reconnecting socket / auth refresh) falls back to the
  // raw text within the timeout instead of stranding the whole message. See
  // lib/mentionExpansion.ts for why the cardinal "never drop a send" rule lives here.
  const expandMentionsInMessage = useCallback((text: string): Promise<string> => {
    return expandEntityMentions(text, (mentions) =>
      convex.query(api.docs.expandMentions, { mentions }),
    );
  }, [convex]);
  pastedImagesRef.current = pastedImages;

  // Re-attach to uploads a previous composer instance started: this component
  // remounts whenever its key flips (a new session gets its session_id stamped,
  // a stub conversation rekeys to its real id), and any image still uploading
  // at that moment must not be lost — adopt its pending promise from the
  // module-level registry. If the promise is gone (a reload killed the upload),
  // drop the orphan row from state and draft.
  useMountEffect(() => {
    pastedImagesRef.current.forEach(img => {
      if (!img.uploading || img.storageId) return;
      const pending = pendingImageUploads.get(img.previewUrl);
      if (pending) {
        void pending.then(storageId => {
          if (storageId) {
            setPastedImages(prev => prev.map(i => i.previewUrl === img.previewUrl ? { ...i, storageId: storageId as Id<"_storage">, uploading: false } : i));
          } else {
            clearImageByPreview(img.previewUrl);
          }
        });
      } else {
        settleDraftImageUpload(img.previewUrl, null);
        clearImageByPreview(img.previewUrl);
      }
    });
  });

  const waitForConvexId = useCallback((id: string): Promise<string> => {
    return useInboxStore.getState().awaitConvexId(id);
  }, []);

  useMountEffect(() => {
    return () => { if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current); };
  });

  useWatchEffect(() => {
    if (onPopulateInput) {
      onPopulateInput.current = (text: string, opts?: { append?: boolean }) => {
        if (opts?.append) {
          const current = textareaRef.current?.value ?? messageRef.current ?? "";
          setMessage(appendToDraft(current, text));
          setTimeout(() => {
            const el = textareaRef.current;
            if (el) { el.focus(); const end = el.value.length; el.setSelectionRange(end, end); }
          }, 0);
        } else {
          setMessage(text);
          setTimeout(() => textareaRef.current?.select(), 0);
        }
      };
      return () => { if (onPopulateInput) onPopulateInput.current = null; };
    }
  }, [onPopulateInput]);

  // A `?prefill=` deep link (phone notification → back into this session) seeds
  // the composer with the draft it asked about, already quoted, cursor on the
  // line beneath it. Only into a genuinely empty composer: text the user typed,
  // a persisted draft, or an attached image all outrank the link, which is then
  // dropped rather than queued behind them. Consumed once either way.
  const prefillReq = useInboxStore((s) => s.composerPrefill);
  useWatchEffect(() => {
    if (!prefillReq || prefillReq.convId !== conversationId) return;
    const store = useInboxStore.getState();
    store.setComposerPrefill(null);
    const row = store.getDraft(conversationId);
    if (messageRef.current.trim() || row?.draft_message?.trim() || row?.draft_image_storage_ids?.length) return;
    setMessage(prefillReq.text);
    setTimeout(() => {
      const el = textareaRef.current;
      if (el) { el.focus(); const end = el.value.length; el.setSelectionRange(end, end); }
    }, 0);
  }, [prefillReq, conversationId, setMessage]);

  // Set when a dispatch/restart learned the server row no longer exists: the
  // cached copy renders fine but every conversation-scoped mutation will fail.
  const serverDeleted = useInboxStore((s) =>
    Boolean((s.sessions[conversationId] as any)?.server_deleted || (s.conversations[conversationId] as any)?.server_deleted));

  const ghostRestartContext = useCallback(() => ghostRestartContextFor(conversationId), [conversationId]);
  const handleRestartResult = useCallback((res: any) => followRestoredConversation(res, conversationId), [conversationId]);

  const handleForceResume = useCallback(async (opts?: { auto?: boolean }) => {
    if (isResuming) return;
    setIsResuming(true);
    // Automatic recovery here is always the gentle, non-destructive resume (re-attach + redeliver).
    // The only automatic kill+restart lives in the confirmed-undeliverable effect below; this
    // path kills only on an explicit human click of a dead-message control — never on idleness.
    // A known-deleted server row skips the gentle attempt: it can only fail, the
    // restore lives behind restartSession.
    const shouldRestart = serverDeleted ||
      (!opts?.auto && (isExistingMessageDead || messageStatus?.status === "failed" || messageStatus?.status === "undeliverable"));
    try {
      if (shouldRestart) {
        setIsRestarting(true);
        handleRestartResult(await convCommand(conversationId, "restartSession", ghostRestartContext()));
      } else {
        await resumeSessionMutation({ conversation_id: conversationId as Id<"conversations"> });
      }
    } catch (err) {
      // A parked request is durable but has no response from which to infer a
      // ghost-restore redirect. Leave the recovery indicators active.
      if (isParkedDispatchError(err)) return;
      const msg = err instanceof Error ? err.message : String(err);
      // The server row is gone (cached ghost) — escalate to the restore path,
      // which targets the live twin / recreates the row before resuming.
      if (/conversation_deleted|Conversation not found/i.test(msg)) {
        try {
          setIsRestarting(true);
          handleRestartResult(await convCommand(conversationId, "restartSession", ghostRestartContext()));
          return;
        } catch (err2) {
          if (isParkedDispatchError(err2)) return;
          useInboxStore.getState().markServerDeleted(conversationId);
          toast.error("This conversation no longer exists on the server and couldn't be restored automatically");
          setIsResuming(false);
          setIsRestarting(false);
          return;
        }
      }
      toast.error(msg || "Failed to resume session");
      setIsResuming(false);
      setIsRestarting(false);
    }
  }, [conversationId, resumeSessionMutation, convCommand, isResuming, isExistingMessageDead, messageStatus?.status, ghostRestartContext, handleRestartResult, serverDeleted]);

  // Stop the (otherwise indefinite) retry loop for a message that genuinely can't land. Resolve
  // the id from either the precise tracker or the conversation-scoped pending row, since a reload
  // mid-send leaves us with only the latter.
  const handleCancelMessage = useCallback(async () => {
    const id = pendingMessageId ?? (existingPending?.message_id as Id<"pending_messages"> | undefined);
    if (!id) return;
    try {
      await cancelMessageMutation({ message_id: id });
      setPendingMessageId(null);
      setSentAt(null);
      setShowStuckBanner(false);
      setIsResuming(false);
      setIsRestarting(false);
      sentContentRef.current = null;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel message");
    }
  }, [pendingMessageId, existingPending, cancelMessageMutation]);

  useWatchEffect(() => {
    // Clear the spinner/banner the moment the session shows life. isAgentActive (daemon
    // heartbeat) is the fast, authoritative signal that the agent is alive — working,
    // thinking, compacting, or waiting on input — so there's nothing to recover.
    if (isResuming && (isConversationLive || isThinking || isAgentActive || messageReachedSession)) {
      setIsResuming(false);
      setIsRestarting(false);
      setShowStuckBanner(false);
      return;
    }
    if (!isResuming) return;
    // No auto-kill: if the gentle resume hasn't revived the session in time, just stop the
    // spinner so the manual "Force resume / Restart & retry" controls surface. We never
    // escalate to a destructive kill on our own — that's a human decision.
    const timeout = setTimeout(() => setIsResuming(false), 90_000);
    return () => clearTimeout(timeout);
  }, [isResuming, isConversationLive, isThinking, isAgentActive, messageReachedSession]);

  useWatchEffect(() => {
    if (!showStuckBanner || !sessionId || isResuming || autoResumeTriggeredRef.current) return;
    // Agent already processing, or the message already reached tmux — nothing to resume.
    if (isAgentActive || messageReachedSession) return;
    // The daemon is already on it: booting the session ("starting"/"resuming") or
    // holding the claimed message mid-delivery ("connected"). Firing a resume here
    // interrupts that delivery (resume clears the conversation's delivery state and
    // re-pends its messages) and made slow deliveries slower. When the daemon
    // genuinely stalls, the status goes stale/idle and this effect re-runs then.
    if (isAgentStarting || isAgentDelivering) return;
    // Confirmed-undeliverable is the restart effect's job, not a gentle resume's.
    if (messageStatus?.status === "undeliverable") return;
    // User cancelled this message — don't fight the cancellation by resuming.
    if (messageStatus?.status === "cancelled") return;
    if (!existingPending && !pendingMessageId) return;
    autoResumeTriggeredRef.current = true;
    handleForceResume({ auto: true });
  }, [showStuckBanner, sessionId, isResuming, isAgentActive, isAgentStarting, isAgentDelivering, messageReachedSession, messageStatus?.status, existingPending, pendingMessageId, handleForceResume]);

  // The one allowed automatic kill+restart. Trigger is a CONFIRMED delivery failure, never
  // idleness: the daemon marks a message "undeliverable" only after ~10 failed injects over
  // many minutes — i.e. the message never made it back through sync. We additionally require
  // the agent to be inactive, because a long-running/busy agent can trip "undeliverable" purely
  // from being busy past the retry budget, and must never be killed mid-task. Fires once.
  useWatchEffect(() => {
    if (autoRestartTriggeredRef.current) return;
    if (messageStatus?.status !== "undeliverable") return;
    if (isAgentActive || messageReachedSession) return;
    if (!conversationId || !isConvexId(conversationId)) return;
    autoRestartTriggeredRef.current = true;
    setIsRestarting(true);
    toast("Message couldn't be delivered — restarting session…");
    convCommand(conversationId, "restartSession", ghostRestartContext())
      .then((res) => { handleRestartResult(res); setIsResuming(true); })
      .catch((err) => {
        if (isParkedDispatchError(err)) return;
        setIsRestarting(false);
        const msg = err instanceof Error ? err.message : String(err);
        if (/conversation_deleted/i.test(msg)) {
          useInboxStore.getState().markServerDeleted(conversationId);
          toast.error("This conversation no longer exists on the server — use Restore to bring its session back");
        } else {
          toast.error(`Session restart failed: ${msg}`);
        }
      });
  }, [messageStatus?.status, isAgentActive, messageReachedSession, conversationId, convCommand, ghostRestartContext, handleRestartResult]);

  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The text that counts as the user's draft right now. While an UNEDITED
  // fork-rewrite preview is active (Alt+J/K message selection), the composer
  // displays an already-sent message — display state, not input. Persisting it
  // is how old messages used to resurrect as drafts; the real draft is what
  // the user had typed before selecting. The moment they edit the preview it
  // becomes typed input and persists like any other draft.
  const draftTextForPersist = useCallback(() => (
    prevSelectionRef.current !== null && !isSelectionEditedRef.current
      ? (savedDraftRef.current ?? "")
      : messageRef.current
  ), []);

  const saveDraftSnapshot = useCallback((targetId: string) => {
    if (sendingRef.current) return;
    const msg = draftTextForPersist();
    // Uploading rows are kept: their pending upload lives in the module-level
    // registry, so a successor composer instance can restore and re-attach.
    const imgs = pastedImagesRef.current.filter(i => i.storageId || i.uploading);
    // An untouched seeded draft is display state — persisting it adds nothing
    // (its source already holds it) and, if another surface cleared the draft
    // while this composer sat mounted, re-persisting is exactly how a deleted
    // draft resurrects. Only user-edited text earns a snapshot.
    if (msg && seededDraftRef.current !== null && msg === seededDraftRef.current) return;
    if (!msg && imgs.length === 0) {
      // A composer that held text and leaves empty is an explicit clear —
      // commit it durably. Without this, delete-then-navigate loses the race
      // against the 300ms draft debounce (cancelled on key flip below) and the
      // persisted draft resurrects on the next app launch. hadTextRef keeps a
      // never-filled composer (second tab on the same conversation) from
      // eating a draft another surface wrote meanwhile.
      if (hadTextRef.current && useInboxStore.getState().getDraft(targetId)) {
        useInboxStore.getState().clearDraftFinal(targetId);
      }
      return;
    }
    persistDraftImages(targetId, msg, imgs);
  }, [draftTextForPersist]);

  // Re-check a seeded persisted draft against the message window after it has
  // had time to load. The seed-time stale check often runs before any messages
  // are in the store (cold visit), so a resent-copy draft shows once — this
  // catches it, empties the composer, and retires the draft for good. Skipped
  // the moment the user edits (seededDraftRef voids) or a fork preview is up.
  const staleRecheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleStaleRecheck = useCallback(() => {
    if (staleRecheckTimerRef.current) clearTimeout(staleRecheckTimerRef.current);
    if (!seededDraftRef.current) return;
    staleRecheckTimerRef.current = setTimeout(() => {
      const seed = seededDraftRef.current;
      if (!seed || messageRef.current !== seed || prevSelectionRef.current !== null) return;
      if (!isStaleSentDraft(convIdRef.current, seed)) return;
      setMessage("");
      useInboxStore.getState().clearDraftFinal(convIdRef.current);
    }, 3000);
  }, [setMessage]);

  useWatchEffect(() => {
    const keyChanged = sacredKeyRef.current !== sacredKey;
    if (keyChanged) {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      // Untouched seeded text stays out of the sacred cache: sacred entries
      // outrank the store on the flip back and no heal ever looks there, so a
      // stashed seed would pin a since-cleared draft for the page's lifetime.
      // The store still holds it if it's real; the successor re-seeds from
      // there with the heals applied.
      const flipText = draftTextForPersist();
      if (flipText && seededDraftRef.current !== null && flipText === seededDraftRef.current) {
        sacredInputs.delete(sacredKeyRef.current);
      } else {
        sacredInputs.set(sacredKeyRef.current, { text: flipText });
      }
      saveDraftSnapshot(convIdRef.current);
      sacredKeyRef.current = sacredKey;
      convIdRef.current = conversationId;
      const sacred = sacredInputs.get(sacredKey);
      const row = useInboxStore.getState().getDraft(conversationId);
      let storeDraft = row?.draft_message;
      // Same stale-sent check the mount seed applies — without it, a resent-copy
      // draft that the mount heal missed re-enters the composer (and from there
      // the sacred cache, where no heal ever looks) on every key flip.
      if (storeDraft && !row?.draft_image_storage_ids?.length && isStaleSentDraft(conversationId, storeDraft)) {
        useInboxStore.getState().clearDraftFinal(conversationId);
        storeDraft = undefined;
      }
      const newDraft = sacred?.text ?? storeDraft ?? "";
      sacredInputs.set(sacredKey, { text: newDraft });
      _setMessage(newDraft);
      hadTextRef.current = !!newDraft;
      seededDraftRef.current = sacred == null && storeDraft ? newDraft : null;
      scheduleStaleRecheck();
    } else if (convIdRef.current !== conversationId) {
      convIdRef.current = conversationId;
    }
  }, [sacredKey, conversationId, saveDraftSnapshot, draftTextForPersist, scheduleStaleRecheck]);

  useMountEffect(() => {
    // One-shot heal for drafts poisoned before draftTextForPersist existed: a
    // persisted draft that duplicates a sent message would otherwise resurface
    // on every surface that reads the draft store.
    const d = useInboxStore.getState().getDraft(conversationId);
    if (d?.draft_message && !d.draft_image_storage_ids?.length && isStaleSentDraft(conversationId, d.draft_message)) {
      useInboxStore.getState().clearDraftFinal(conversationId);
    }
    scheduleStaleRecheck();
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      if (staleRecheckTimerRef.current) clearTimeout(staleRecheckTimerRef.current);
      saveDraftSnapshot(convIdRef.current);
    };
  });

  const handleMessageChange = useCallback((val: string) => {
    setMessage(val);
    if (savedDraftRef.current !== null) {
      isSelectionEditedRef.current = true;
    }
    if (val.startsWith("/") && (skills?.length ?? 0) > 0) {
      const query = val.slice(1);
      if (!query.includes(" ")) {
        setAcTrigger({ type: "/", startPos: 0 });
        setAcIndex(0);
      } else {
        setAcTrigger(null);
      }
    } else {
      const cursorPos = textareaRef.current?.selectionStart ?? val.length;
      const textBefore = val.slice(0, cursorPos);
      const atMatch = textBefore.match(MENTION_TRIGGER_RE);
      const startPos = atMatch ? cursorPos - atMatch[0].length : -1;
      const dead = mentionDeadEndRef.current;
      if (atMatch && dead && dead.startPos === startPos && (atMatch[1] || "").trim().length > dead.len) {
        // Still extending a mention that already settled on nothing.
        setAcTrigger(null);
      } else if (atMatch) {
        mentionDeadEndRef.current = null;
        setAcTrigger({ type: "@", startPos });
        setAcIndex(0);
        queryMentions(atMatch[1] || "");
      } else {
        // No active @-mention: don't rebuild the mention index. buildMentionItems
        // (in the parent) sorts/maps every session/task/doc/plan, and it only
        // matters once the @ dropdown is open — doing it on every normal keystroke
        // was pure waste on the typing hot path.
        setAcTrigger(null);
      }
    }
    if (!sendingRef.current) {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
      draftTimerRef.current = setTimeout(() => {
        if (sendingRef.current) return;
        const existing = useInboxStore.getState().getDraft(conversationId);
        if (!val && !existing?.draft_image_storage_ids?.length) {
          // Final (server-tombstoned) clear: the user explicitly emptied the
          // box, so the draft must die everywhere, not just in this device's
          // local store — a copy on the server would resurrect on next boot.
          useInboxStore.getState().clearDraftFinal(conversationId);
        } else {
          useInboxStore.getState().setDraft(conversationId, { ...existing, draft_message: val || null });
        }
      }, 300);
    }
  }, [conversationId, skills, queryMentions]);

  const isSelectionActive = !!(selectedMessageContent && selectedMessageUuid);
  const savedDraftRef = useRef<string | null>(null);
  const isSelectionEditedRef = useRef(false);
  const prevSelectionRef = useRef<string | null>(null);

  useWatchEffect(() => {
    const wasActive = prevSelectionRef.current !== null;
    const isActive = !!(selectedMessageContent && selectedMessageUuid);
    prevSelectionRef.current = selectedMessageUuid || null;

    if (isActive && !wasActive) {
      savedDraftRef.current = message;
      isSelectionEditedRef.current = false;
      // _setMessage, not setMessage: the preview must never enter sacredInputs
      // — that cache seeds successor composer instances, and a preview that
      // leaks there comes back as a phantom draft of an already-sent message.
      _setMessage(selectedMessageContent);
    } else if (isActive && wasActive) {
      // Switching to another message discards edits to the previous preview
      // (as Escape would) — scrub them from sacredInputs too, so they can't
      // reseed a successor composer as a phantom draft.
      if (isSelectionEditedRef.current) {
        const real = savedDraftRef.current ?? "";
        sacredInputs.set(sacredKeyRef.current, { text: real });
        if (convIdRef.current !== sacredKeyRef.current) sacredInputs.set(convIdRef.current, { text: real });
        isSelectionEditedRef.current = false;
      }
      _setMessage(selectedMessageContent);
    } else if (!isActive && wasActive) {
      const restored = savedDraftRef.current ?? "";
      savedDraftRef.current = null;
      isSelectionEditedRef.current = false;
      setMessage(restored);
    }
  }, [selectedMessageContent, selectedMessageUuid]);

  const isInactive = status && status !== "active" && !pendingMessageId;
  // Queued messages live in the inbox store (persisted to IDB like drafts) so
  // they survive navigating away and reloads — a queued user message must never
  // be lost. Read reactively here; write through the store. The wrapper keeps the
  // prior useState call signature (a new array or a functional updater) so every
  // existing call site stays unchanged.
  const queuedMessages = useInboxStore((s) => s.queuedMessages[conversationId]) ?? EMPTY_QUEUE;
  const setQueuedMessages = useCallback((updater: string[] | ((prev: string[]) => string[])) => {
    const store = useInboxStore.getState();
    const prev = store.getQueuedMessages(conversationId);
    const next = typeof updater === "function" ? updater(prev) : updater;
    store.setQueuedMessagesFor(conversationId, next);
  }, [conversationId]);
  const [selectedQueueIndex, setSelectedQueueIndex] = useState<number | null>(null);
  // Keyboard selection for the suggestion pill row lives inside the component
  // (the pill list is its server subscription); the composer drives it through
  // this handle as the top rung of the ↑ ladder: pills over queue over images.
  const suggestionPillsRef = useRef<SuggestionPillsHandle | null>(null);
  // Mirror of the pill row's selection, reported up so Escape ownership (the
  // effect below) can stand the compose popup down while a pill is selected.
  const [pillSelectionActive, setPillSelectionActive] = useState(false);
  // Tell the host (compose popup) when Escape is spoken for by inner UI — the
  // lightbox, an image/queue chip selection, or the slash-command menu — so its
  // document-capture Escape listener stands down and the textarea handler above
  // gets to unwind that state instead of the whole dialog closing.
  useWatchEffect(() => {
    if (escapeOwnedRef) {
      escapeOwnedRef.current = acTrigger !== null || selectedImageIndex !== null || selectedQueueIndex !== null || lightboxImageIndex !== null || pillSelectionActive;
    }
  }, [escapeOwnedRef, acTrigger, selectedImageIndex, selectedQueueIndex, lightboxImageIndex, pillSelectionActive]);
  const setSessionHasQueuedMessages = useInboxStore((s) => s.setSessionHasQueuedMessages);
  useWatchEffect(() => {
    setSessionHasQueuedMessages(conversationId, queuedMessages.length > 0);
    return () => setSessionHasQueuedMessages(conversationId, false);
  }, [conversationId, queuedMessages.length, setSessionHasQueuedMessages]);
  // Pending review quotes count as sendable content: handleSubmit auto-attaches
  // them (attachReviewToMessage), so a bare Enter with an empty input is a valid send.
  const reviewCount = useInboxStore((s) => (s.reviewComments[conversationId] ?? []).length);
  const hasContent = (composeMode ? composeHasContent : message.trim().length > 0) || pastedImages.length > 0 || queuedMessages.length > 0;
  const isExpanded = composeMode || !!onSendAndAdvance || isFocused || message.length > 0 || pastedImages.length > 0 || queuedMessages.length > 0 || reviewCount > 0 || !!branchMapNode;

  const toggleCompose = useCallback(() => {
    if (composeMode) {
      const md = composeRef.current?.getMarkdown() || "";
      setMessage(md);
      setComposeMode(false);
      setComposeHasContent(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    } else {
      // Seed from the text carried in: TipTap's onUpdate only fires on edits, so
      // without this the send/fork controls stay disabled until the first keystroke.
      setComposeHasContent(messageRef.current.trim().length > 0);
      setComposeMode(true);
    }
  }, [composeMode, setMessage]);

  const [isMultiline, setIsMultiline] = useState(false);
  const resetTextareaHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    if (FIELD_SIZING_SUPPORTED) {
      // The browser autosizes via `field-sizing: content` — no JS writes, no
      // forced reflow. clientHeight is already-laid-out most of the time here.
      setIsMultiline(el.clientHeight > 36);
      return;
    }
    // Fallback (Safari): the write→measure→write dance forces two synchronous
    // reflows of the whole page per keystroke — it was the single largest
    // app-code frame in typing CPU profiles, so it only runs where the CSS
    // property doesn't exist.
    el.style.height = "auto";
    const sh = el.scrollHeight;
    el.style.height = sh + "px";
    setIsMultiline(sh > 36);
  };

  // useLayoutEffect so the height adjusts before paint — useEffect would
  // cause a visible flicker when text wraps to a new line.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(resetTextareaHeight, [message]);

  const mountConvIdRef = useRef(conversationId);
  useWatchEffect(() => {
    // An open dialog owns focus — never yank it down to the composer behind it.
    if (hasOpenModal()) return;
    if (textareaRef.current) {
      const isIdTransition = mountConvIdRef.current !== conversationId;
      mountConvIdRef.current = conversationId;
      if (isIdTransition) {
        if (autoFocusInput) textareaRef.current.focus();
        return;
      }
      const len = textareaRef.current.value.length;
      if (len > 0) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(len, len);
      } else if (autoFocusInput) {
        textareaRef.current.focus();
      }
    }
  }, [autoFocusInput, conversationId]);

  // Where the next token in a same-tick batch goes; null once the DOM catches up.
  const batchCaretRef = useRef<number | null>(null);

  // Drop a numbered token into the draft text for each attached image so the
  // user can refer to attachments in prose ("crop it like [Image 2]"). Numbers
  // follow attach order, which is the order the agent receives the images in.
  const addImagePlaceholder = useCallback((n: number) => {
    // Gate mode (chat): attachments render as their own grid under the message,
    // so the draft never carries an [Image N] token to point at them.
    if (onGateSend) return;
    if (composeMode && composeRef.current) {
      composeRef.current.insertText(`${imagePlaceholderToken(n)} `);
      return;
    }
    const current = messageRef.current;
    const el = textareaRef.current;
    // Dropping or pasting several images fires this once per file in a single
    // tick, so for files 2..N the textarea is still a render behind and its
    // caret points before the tokens we just added — reading it would stack
    // every token at the same spot, in reverse. Carry the caret forward
    // ourselves for the batch and trust the DOM only once it has caught up.
    const domCaret = el && el.value === current && document.activeElement === el
      ? (el.selectionEnd ?? current.length)
      : current.length;
    const next = insertImagePlaceholder(current, batchCaretRef.current ?? domCaret, n);
    batchCaretRef.current = next.caret;
    setMessage(next.text);
    // Sync so a draft snapshot taken later this tick carries the placeholder.
    messageRef.current = next.text;
    setTimeout(() => {
      batchCaretRef.current = null;
      if (textareaRef.current) {
        textareaRef.current.selectionStart = textareaRef.current.selectionEnd = next.caret;
      }
    }, 0);
  }, [composeMode, setMessage, onGateSend]);

  // The nth image is gone: drop its token and renumber the rest, so what's left
  // still points at the attachments the agent will actually receive.
  const removeImagePlaceholder = useCallback((n: number) => {
    if (onGateSend) return;
    if (composeMode && composeRef.current) {
      const md = composeRef.current.getMarkdown();
      const next = dropImagePlaceholder(md, n);
      if (next !== md) composeRef.current.setMarkdown(next);
      return;
    }
    const next = dropImagePlaceholder(messageRef.current, n);
    if (next === messageRef.current) return;
    setMessage(next);
    messageRef.current = next;
  }, [composeMode, setMessage, onGateSend]);

  const clearImage = useCallback((index: number) => {
    // Renumber first: persistDraftImages below snapshots messageRef, so the
    // draft must already carry the corrected text.
    removeImagePlaceholder(index + 1);
    pastedImagesRef.current = pastedImagesRef.current.filter((_, i) => i !== index);
    setPastedImages(prev => {
      const img = prev[index];
      if (img) {
        pendingImageUploads.delete(img.previewUrl);
        URL.revokeObjectURL(img.previewUrl);
      }
      const next = prev.filter((_, i) => i !== index);
      persistDraftImages(conversationId, messageRef.current, next);
      return next;
    });
  }, [conversationId, removeImagePlaceholder]);

  // Same drop, addressed by blob url — for the paths that lose an image without
  // the user asking (upload failed, or a reload orphaned an in-flight upload).
  // They must renumber too, or the draft keeps a token for an image that will
  // never be sent.
  const clearImageByPreview = useCallback((previewUrl: string) => {
    const index = pastedImagesRef.current.findIndex(i => i.previewUrl === previewUrl);
    if (index < 0) return;
    clearImage(index);
  }, [clearImage]);

  // revoke=false transfers blob ownership to the pending bubble (so its
  // thumbnail keeps rendering after the composer clears on send).
  const clearAllImages = useCallback((revoke = true) => {
    if (revoke) pastedImages.forEach(img => {
      pendingImageUploads.delete(img.previewUrl);
      URL.revokeObjectURL(img.previewUrl);
    });
    setPastedImages([]);
    // Clear the ref synchronously too, exactly as the send clears
    // `messageRef.current` alongside `setMessage("")`. saveDraftSnapshot reads
    // this ref (not state) and runs on unmount / key-flip with sendingRef
    // already reset to false — the compose popup unmounts the same tick it
    // sends, before any re-render updates the ref, so a stale ref here would
    // re-persist the just-sent images into the draft, which then rides rekeyId
    // onto the new conversation and reappears attached in "send & open".
    pastedImagesRef.current = [];
    setSelectedImageIndex(null);
    setLightboxImageIndex(null);
  }, [pastedImages]);

  const uploadImage = useCallback((file: File) => {
    const previewUrl = URL.createObjectURL(file);
    const entry = { file, previewUrl, uploading: true };
    // Ref-first so several images attached in one tick number sequentially —
    // the render-time ref sync hasn't happened yet.
    pastedImagesRef.current = [...pastedImagesRef.current, entry];
    addImagePlaceholder(pastedImagesRef.current.length);
    setPastedImages(prev => {
      const next = [...prev, entry];
      // Sacred from the moment of paste: the draft row (uploading, blob
      // preview) is what survives the composer remount that follows session
      // registration, before the upload has produced a storageId.
      persistDraftImages(conversationId, messageRef.current, next);
      return next;
    });
    const promise = (async (): Promise<string | null> => {
      try {
        // Shrink large pastes before they hit the wire (preview above already
        // rendered from the original blob, so this stays invisible to the user).
        const uploaded = await compressImage(file);
        const uploadUrl = await generateUploadUrl({});
        const result = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": uploaded.type },
          body: uploaded,
        });
        if (!result.ok) throw new Error(`Upload failed: ${result.status} ${result.statusText}`);
        const { storageId } = await result.json();
        // Draft first — it lands even if this composer instance has unmounted
        // (a state updater on a dead instance is a silent no-op).
        settleDraftImageUpload(previewUrl, storageId as string);
        setPastedImages(prev => prev.map(img => img.previewUrl === previewUrl ? { ...img, storageId, uploading: false } : img));
        return storageId as string;
      } catch (err: any) {
        console.error("[uploadImage] failed:", err);
        toast.error(err?.message?.includes("Authentication") ? "Upload failed: not authenticated" : `Failed to upload image: ${err?.message || "unknown error"}`);
        settleDraftImageUpload(previewUrl, null);
        clearImageByPreview(previewUrl);
        return null;
      }
    })();
    pendingImageUploads.set(previewUrl, promise);
    return previewUrl;
  }, [generateUploadUrl, conversationId, addImagePlaceholder, clearImageByPreview]);

  useWatchEffect(() => {
    if (onDropFiles) {
      onDropFiles.current = (files: File[]) => {
        files.forEach(f => { if (f.type.startsWith("image/")) uploadImage(f); });
      };
      return () => { if (onDropFiles) onDropFiles.current = null; };
    }
  }, [onDropFiles, uploadImage]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let hasImage = false;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        if (!hasImage) { e.preventDefault(); hasImage = true; }
        const file = items[i].getAsFile();
        if (file) uploadImage(file);
      }
    }
  }, [uploadImage]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAcTrigger(null);
    // In compose mode, read content from the TipTap editor
    let message = composeMode && composeRef.current
      ? composeRef.current.getMarkdown()
      : messageRef.current;
    if (onGateSend) {
      const text = message.trim();
      // Same reconcile as the main path: the durable draft is the record of
      // pasted images, memory can lose rows across a remount (jx7byyk).
      const gateDraftRows = restoreDraftImages(useInboxStore.getState().drafts[conversationId] ?? undefined);
      const gateMemory = pastedImagesRef.current.filter(img => img.storageId || img.uploading);
      const gateDraftOnly = gateDraftRows.filter(
        row => row.storageId && !gateMemory.some(img => img.storageId === row.storageId)
      ) as typeof gateMemory;
      const gateImages = [...gateMemory, ...gateDraftOnly].map(img => ({
        storageId: img.storageId as string | undefined,
        previewUrl: img.previewUrl,
        mime: img.file?.type ?? "image/png",
        uploading: !!img.uploading,
      }));
      if (!text && gateImages.length === 0) return;
      sendingRef.current = true;
      if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
      setMessage("");
      messageRef.current = "";
      // In-flight uploads keep their blobs alive in pendingImageUploads; the
      // settled ones are done with theirs.
      clearAllImages(true);
      useInboxStore.getState().clearDraftFinal(conversationId);
      sendingRef.current = false;
      await onGateSend(text, gateImages);
      return;
    }
    if (onWorkflowLaunch) {
      const goal = message.trim();
      sendingRef.current = true;
      if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
      setMessage("");
      messageRef.current = "";
      useInboxStore.getState().clearDraftFinal(conversationId);
      sendingRef.current = false;
      await onWorkflowLaunch(goal);
      return;
    }
    // Auto-attach any pending review quotes/comments so a plain send carries them —
    // no separate "add to message" step. They prepend the typed reply and the batch
    // is cleared. (Gate/workflow above return early, so they're unaffected.)
    message = attachReviewToMessage(conversationId, message);
    // Snapshot the composer's images. Ready ones already carry a storageId;
    // still-uploading ones are handed to the pending bubble (preview + spinner)
    // and finished in the background — either way the input unblocks instantly.
    // The store draft is the durable record of pasted images (sacred from the
    // moment of paste) — in-memory state can lose rows across a remount, rekey,
    // or cross-tab handoff while the draft keeps them, and a send that trusts
    // only memory then silently drops the user's images (jx7byyk, 2026-07-31).
    // Reconcile: any settled draft row missing from memory rides along.
    const draftRows = restoreDraftImages(useInboxStore.getState().drafts[conversationId] ?? undefined);
    const memoryImages = pastedImagesRef.current.filter(img => img.storageId || img.uploading);
    const draftOnlyImages = draftRows.filter(
      row => row.storageId && !memoryImages.some(img => img.storageId === row.storageId)
    ) as typeof memoryImages;
    const submitImages = [...memoryImages, ...draftOnlyImages];
    const hasUploadingImages = submitImages.some(img => img.uploading);
    const canSend = message.trim() || submitImages.length > 0;
    if (!canSend) return;

    // If a message is selected, fork from it then send the new content
    if (isSelectionActive && selectedMessageUuid && onForkFromMessage) {
      sendingRef.current = true;
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      isSelectionEditedRef.current = true;
      savedDraftRef.current = null;
      const content = message.trim();
      setMessage("");
      messageRef.current = "";
      useInboxStore.getState().clearDraftFinal(conversationId);
      sendingRef.current = false;
      onClearSelection?.();
      const savedPopulateFn = onPopulateInput?.current ?? null;
      if (onPopulateInput) onPopulateInput.current = null;
      await onForkFromMessage(selectedMessageUuid);
      setTimeout(() => { if (onPopulateInput) onPopulateInput.current = savedPopulateFn; }, 200);
      // After fork: navigateToSession has been called, so currentSessionId is the new fork.
      const forkId = useInboxStore.getState().currentSessionId;
      if (!forkId || forkId === conversationId) {
        addOptimistic(conversationId, content);
        toast.error("Fork not ready — message saved locally");
        return;
      }
      const clientId = addOptimistic(forkId, content);
      onMessageSent?.();
      try {
        const resolvedId = await waitForConvexId(forkId);
        sendMessage(resolvedId, content, undefined, clientId);
        setSentAt(Date.now());
        sentContentRef.current = content;
      } catch (error) {
        // The fork/create and this optimistic rewrite are still durable. Live
        // session-id reconciliation will rekey the stub and redrive the pending
        // message; reporting failure here would lie and invite a duplicate retry.
        if (isParkedDispatchError(error)) return;
        toast.error(error instanceof Error ? error.message : "Failed to send rewrite");
      }
      return;
    }

    const targetConvId = conversationId;
    const targetCanQuery = canQueryServer;
    const trimmed = message.trim() || (submitImages.length > 0 ? "[image]" : "");
    // The optimistic bubble shows ready images via storage_id, and still-
    // uploading ones via their local preview + a spinner (dropped on resolve).
    const optimisticImages: OptimisticImage[] = submitImages.map(img =>
      img.storageId
        ? { media_type: img.file.type, storage_id: img.storageId as string }
        : { media_type: img.file.type, preview_url: img.previewUrl, uploading: true }
    );
    sendingRef.current = true;
    if (isInactive) setOptimisticSending(true);
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    const clientId = addOptimistic(targetConvId, trimmed, optimisticImages.length > 0 ? optimisticImages : undefined);
    soundSend();
    setMessage("");
    messageRef.current = "";
    setSelectedQueueIndex(null);
    // When images are still uploading their blobs now belong to the pending
    // bubble; the background task revokes them once the upload resolves.
    clearAllImages(!hasUploadingImages);
    useInboxStore.getState().clearDraftFinal(targetConvId);
    if (composeMode) { composeRef.current?.clear(); setComposeMode(false); setComposeHasContent(false); }
    sendingRef.current = false;
    requestAnimationFrame(() => textareaRef.current?.focus());
    onMessageSent?.();

    // Common send tail: expand mentions, resolve the (possibly still-creating)
    // conversation id, then durably send. Reused by the immediate and the
    // upload-deferred paths. Store calls go through getState() so this is safe
    // to run after the component unmounts (user switched sessions).
    const finishSend = async (ids: string[]) => {
      try {
        const expandedContent = await expandMentionsInMessage(trimmed);
        const resolvedId = targetCanQuery ? targetConvId : await useInboxStore.getState().awaitConvexId(targetConvId);
        // Record the exact dispatched bytes on the pending row BEFORE sending:
        // the server fingerprints this client id's args, so any later redrive
        // must replay them verbatim or be refused as COMMAND_ID_REUSED. The row
        // may sit under the stub key or the rekeyed real id — stamp both.
        if (expandedContent !== trimmed) {
          useInboxStore.getState().stampPendingDispatchContent(targetConvId, clientId, expandedContent);
          if (resolvedId !== targetConvId) {
            useInboxStore.getState().stampPendingDispatchContent(resolvedId, clientId, expandedContent);
          }
        }
        sendMessage(resolvedId, expandedContent, ids.length > 0 ? ids : undefined, clientId);
        // Hand the resolved id + the send's clientId to the popup so it can paint
        // this same message optimistically in the MAIN window (send & open) without
        // a second send — same clientId means it dedupes against the server echo.
        onDidSend?.({ conversationId: resolvedId, content: expandedContent, clientId });
        setOptimisticSending(false);
        setSentAt(Date.now());
        sentContentRef.current = trimmed;
        setShowStuckBanner(false);
      } catch (error) {
        // `parked` means createSession is already in the durable outbox. Keep
        // the optimistic bubble pending; the rekey continuation sends it with
        // the same clientId once the real conversation row arrives.
        if (isParkedDispatchError(error)) {
          setOptimisticSending(false);
          return;
        }
        toast.error(error instanceof Error ? error.message : "Failed to send message");
        useInboxStore.getState().markOptimisticAsFailed(targetConvId, clientId);
        setOptimisticSending(false);
      }
    };

    if (hasUploadingImages) {
      // Detached: finish the in-flight uploads, swap the bubble's previews for
      // real storage records (drops the spinner), then send. Awaits the upload
      // promises from the module-level registry, not component state, so it
      // survives a session switch or composer remount. The user can already
      // type/send the next message.
      void (async () => {
        const tasks = submitImages.map(img => ({
          previewUrl: img.previewUrl,
          mediaType: img.file.type,
          promise: img.storageId
            ? Promise.resolve<string | null>(img.storageId as string)
            : (pendingImageUploads.get(img.previewUrl) ?? Promise.resolve<string | null>(null)),
        }));
        const settled = await Promise.all(tasks.map(t => t.promise.then(storageId => ({ ...t, storageId }))));
        const resolvedImages: OptimisticImage[] = settled
          .filter(t => t.storageId)
          .map(t => ({ media_type: t.mediaType, storage_id: t.storageId as string }));
        // Every upload failed and there was no text — nothing real to send.
        // uploadImage already toasted each failure; just fail the bubble.
        if (resolvedImages.length === 0 && !message.trim()) {
          useInboxStore.getState().markOptimisticAsFailed(targetConvId, clientId);
          tasks.forEach(t => pendingImageUploads.delete(t.previewUrl));
          return;
        }
        useInboxStore.getState().resolvePendingUploads(targetConvId, clientId, resolvedImages);
        // Free the handed-off blobs after the bubble has re-rendered without
        // its preview_url (resolvePendingUploads stripped it), so a still-
        // mounted ImageBlock never loads a revoked URL and gets stuck errored.
        tasks.forEach(t => {
          pendingImageUploads.delete(t.previewUrl);
          setTimeout(() => URL.revokeObjectURL(t.previewUrl), 1000);
        });
        await finishSend(resolvedImages.map(i => i.storage_id as string));
      })();
    } else {
      await finishSend(submitImages.map(img => img.storageId as string));
    }
  };

  const queueDrainingRef = useRef(false);
  useWatchEffect(() => {
    if (queuedMessages.length === 0 || queueDrainingRef.current) return;
    const isIdle = agentStatus === "idle" || (!agentStatus && !isWaitingForResponse && !isThinking && !isConversationLive && !isSessionStarting);
    if (!isIdle) return;
    queueDrainingRef.current = true;
    const queueTargetConvId = conversationId;
    const queueCanQuery = canQueryServer;
    const next = queuedMessages[0];
    setQueuedMessages(prev => prev.slice(1));
    setSelectedQueueIndex(null);
    const clientId = addOptimistic(queueTargetConvId, next);
    soundSend();
    onMessageSent?.();
    (async () => {
      try {
        const expanded = await expandMentionsInMessage(next);
        const resolvedId = queueCanQuery ? queueTargetConvId : await waitForConvexId(queueTargetConvId);
        // Same dispatch-bytes stamp as finishSend: redrives must replay exactly.
        if (expanded !== next) {
          useInboxStore.getState().stampPendingDispatchContent(queueTargetConvId, clientId, expanded);
          if (resolvedId !== queueTargetConvId) {
            useInboxStore.getState().stampPendingDispatchContent(resolvedId, clientId, expanded);
          }
        }
        sendMessage(resolvedId, expanded, undefined, clientId);
        setSentAt(Date.now());
        sentContentRef.current = next;
        setShowStuckBanner(false);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to send queued message");
        useInboxStore.getState().markOptimisticAsFailed(queueTargetConvId, clientId);
      } finally {
        queueDrainingRef.current = false;
      }
    })();
  }, [queuedMessages, agentStatus, isWaitingForResponse, isThinking, isConversationLive, isSessionStarting, conversationId, canQueryServer]);

  const flashModeLabel = useCallback(() => {
    setShowModeLabel(true);
    if (modeLabelTimerRef.current) clearTimeout(modeLabelTimerRef.current);
    modeLabelTimerRef.current = setTimeout(() => setShowModeLabel(false), 1500);
  }, []);

  // Fork-and-send: branch the session from its latest message and deliver the
  // composed text into the fork, leaving the parent thread untouched. Shared by
  // the Cmd/Ctrl+Shift+Enter combo and the fork button beside the send arrow.
  // "Send and stash": deliver, then set the session aside with the agent
  // still running. Same handler the Alt+Shift+Enter chord fires.
  const handleSendAndStash = () => {
    if (!onSendAndDismiss) return;
    void handleSubmit({ preventDefault: () => {} } as unknown as React.FormEvent).then(() => onSendAndDismiss());
  };

  const handleForkSend = () => {
    if (!onForkSend) return;
    // With a message selected, plain submit already forks from the selection —
    // delegate so the gesture honors the selection anchor instead of the tail.
    if (isSelectionActive && selectedMessageUuid && onForkFromMessage) {
      void handleSubmit({ preventDefault: () => {} } as unknown as React.FormEvent);
      return;
    }
    const raw = composeMode && composeRef.current ? composeRef.current.getMarkdown() : message;
    const text = attachReviewToMessage(conversationId, raw).trim();
    if (!text) return;
    sendingRef.current = true;
    if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
    composeRef.current?.clear();
    setMessage("");
    messageRef.current = "";
    useInboxStore.getState().clearDraftFinal(conversationId);
    sendingRef.current = false;
    onForkSend(text);
    onMessageSent?.();
  };

  const acScrollRef = useRef(false);
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (acTrigger && acItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        acScrollRef.current = true;
        setAcIndex(i => Math.min(i + 1, acItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        acScrollRef.current = true;
        setAcIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        applyAutocomplete(acItems[clampedAcIndex]);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        applyAutocomplete(acItems[clampedAcIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setAcTrigger(null);
        return;
      }
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      onCycleMode?.();
      flashModeLabel();
      return;
    }

    // Top rung of the ↑ ladder: a selected suggestion pill. Enter sends it
    // as-is (the pill contract), Tab drops it into the composer for editing.
    const pills = suggestionPillsRef.current;
    if (pills?.active()) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        pills.move(-1);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        pills.move(1); // past the last pill exits back to the composer
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        pills.clear();
        if (queuedMessages.length > 0) setSelectedQueueIndex(0);
        else if (pastedImages.length > 0) setSelectedImageIndex(0);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        pills.send();
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        pills.edit();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        pills.clear();
        return;
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        pills.clear();
      }
    }

    if (selectedImageIndex !== null && pastedImages.length > 0) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const next = Math.max(0, selectedImageIndex - 1);
        setSelectedImageIndex(next);
        if (lightboxImageIndex !== null) setLightboxImageIndex(next);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (selectedImageIndex < pastedImages.length - 1) {
          const next = selectedImageIndex + 1;
          setSelectedImageIndex(next);
          if (lightboxImageIndex !== null) setLightboxImageIndex(next);
        } else {
          setSelectedImageIndex(null);
          setLightboxImageIndex(null);
        }
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        const nextIdx = pastedImages.length <= 1 ? null : Math.min(selectedImageIndex, pastedImages.length - 2);
        clearImage(selectedImageIndex);
        setSelectedImageIndex(nextIdx);
        if (lightboxImageIndex === selectedImageIndex) setLightboxImageIndex(nextIdx);
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setLightboxImageIndex(lightboxImageIndex === selectedImageIndex ? null : selectedImageIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (lightboxImageIndex !== null) {
          setLightboxImageIndex(null);
        } else {
          setSelectedImageIndex(null);
        }
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        // ↑ from the image strip climbs to the queue row above it.
        if (queuedMessages.length > 0) {
          setSelectedImageIndex(null);
          setLightboxImageIndex(null);
          setSelectedQueueIndex(queuedMessages.length - 1);
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedImageIndex(null);
        setLightboxImageIndex(null);
        return;
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        setSelectedImageIndex(null);
      }
    }

    if (selectedQueueIndex !== null && queuedMessages.length > 0) {
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        // ↑ off the top of the queue climbs to the suggestion pill row.
        if (e.key === "ArrowUp" && selectedQueueIndex === 0 && pills?.enter()) {
          setSelectedQueueIndex(null);
          return;
        }
        setSelectedQueueIndex(Math.max(0, selectedQueueIndex - 1));
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        if (selectedQueueIndex < queuedMessages.length - 1) {
          setSelectedQueueIndex(selectedQueueIndex + 1);
        } else {
          setSelectedQueueIndex(null);
          textareaRef.current?.focus();
        }
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        setQueuedMessages(prev => prev.filter((_, i) => i !== selectedQueueIndex));
        const newLen = queuedMessages.length - 1;
        if (newLen === 0) {
          setSelectedQueueIndex(null);
          textareaRef.current?.focus();
        } else {
          setSelectedQueueIndex(Math.min(selectedQueueIndex, newLen - 1));
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSelectedQueueIndex(null);
        textareaRef.current?.focus();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const text = queuedMessages[selectedQueueIndex];
        setQueuedMessages(prev => prev.filter((_, i) => i !== selectedQueueIndex));
        setSelectedQueueIndex(null);
        setMessage(text);
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        setSelectedQueueIndex(null);
      }
    }

    if (e.key === "ArrowUp" && pastedImages.length > 0) {
      const textarea = textareaRef.current;
      if (textarea && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        e.preventDefault();
        setSelectedImageIndex(pastedImages.length - 1);
        return;
      }
    }

    if (e.key === "ArrowUp" && queuedMessages.length > 0 && selectedImageIndex === null) {
      const textarea = textareaRef.current;
      if (textarea && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        e.preventDefault();
        setSelectedQueueIndex(queuedMessages.length - 1);
        return;
      }
    }

    // Last rung: nothing else to select above the caret, climb to the pills.
    if (e.key === "ArrowUp" && pills?.visible() && selectedImageIndex === null && selectedQueueIndex === null) {
      const textarea = textareaRef.current;
      if (textarea && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        e.preventDefault();
        pills.enter();
        return;
      }
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const hasText = messageRef.current.trim().length > 0;
      if (escapeTimerRef.current) {
        clearTimeout(escapeTimerRef.current);
        escapeTimerRef.current = null;
        if (hasText) { setMessage(""); } else if (queuedMessages.length > 0) { setQueuedMessages([]); setSelectedQueueIndex(null); } else { onOpenNavigator?.(); }
      } else {
        if (hasText) {
          escapeTimerRef.current = setTimeout(() => { escapeTimerRef.current = null; }, 250);
        } else if (queuedMessages.length > 0) {
          escapeTimerRef.current = setTimeout(() => { escapeTimerRef.current = null; }, 250);
        } else {
          escapeTimerRef.current = setTimeout(() => { escapeTimerRef.current = null; onSendEscape?.(); }, 250);
        }
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      toggleCompose();
      return;
    }
    // Compose-popup intent: Enter fires-and-forgets, Cmd/Ctrl+Enter sends & opens.
    // Only active when onSubmitWithIntent is provided (the new-session window);
    // normal inputs fall through to the queue/send behavior below.
    if (onSubmitWithIntent && e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const navigate = e.metaKey || e.ctrlKey;
      // Kick off the durable first-message send — the optimistic insert and the
      // outbox enqueue run synchronously at the top of handleSubmit, so the send
      // is already committed by the time this returns. DON'T await it: dismiss the
      // popup on the same tick so it never lingers behind a slow create/send.
      void handleSubmit(e);
      onSubmitWithIntent(navigate);
      return;
    }
    // Fork-and-send: branch the session from its latest message and deliver the
    // composed text into the fork, leaving the parent thread untouched.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && onForkSend) {
      e.preventDefault();
      handleForkSend();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const text = message.trim();
      if (text) {
        sendingRef.current = true;
        if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
        setQueuedMessages(prev => [...prev, text]);
        setMessage("");
        messageRef.current = "";
        useInboxStore.getState().clearDraftFinal(conversationId);
        sendingRef.current = false;
        setSelectedQueueIndex(null);
      }
      return;
    }
    if (e.key === "Enter" && e.altKey && e.shiftKey && onSendAndDismiss) {
      e.preventDefault();
      handleSubmit(e).then(() => onSendAndDismiss());
      return;
    }
    if (e.key === "Enter" && e.altKey && !e.shiftKey && onSendAndAdvance) {
      e.preventDefault();
      handleSubmit(e).then(() => onSendAndAdvance());
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // Form submission — the arrow send button, and the expanded editor's Cmd+Enter —
  // must honor the compose-popup contract the same way plain Enter does in
  // handleKeyDown: send, then dismiss the popup with fire-and-forget intent.
  // Outside the popup (no onSubmitWithIntent) this is exactly handleSubmit.
  const handleFormSubmit = (e: React.FormEvent) => {
    void handleSubmit(e);
    onSubmitWithIntent?.(false);
  };

  const canSubmit = hasContent || reviewCount > 0;
  // When the send is carried entirely by attached quotes, tint the button cyan to
  // match the tray so it reads as "this sends the quotes".
  const quotesOnlySend = !hasContent && reviewCount > 0;
  const sendBtnClass = bareComposer
    ? `w-6 h-6 rounded-md transition-colors flex items-center justify-center ${
        !canSubmit ? "text-sol-text-dim/30 cursor-not-allowed" : "text-sol-cyan hover:bg-sol-cyan/10"
      }`
    : `w-8 h-8 rounded-full transition-colors flex items-center justify-center border ${
        !canSubmit
          ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed"
          : quotesOnlySend
            ? "border-sol-cyan/50 bg-sol-cyan/20 text-sol-cyan hover:bg-sol-cyan/30 hover:border-sol-cyan"
            : "border-sol-blue/50 bg-sol-blue/20 text-sol-blue hover:bg-sol-blue/30 hover:border-sol-blue hover:text-sol-blue"
      }`;

  return (
    <div ref={composerRootRef} data-sv-composer className={`shrink-0 pointer-events-none sticky bottom-0 ${lightboxImageIndex !== null ? "z-[10002]" : "z-10"}`}>
      {lightboxImageIndex === null && <div className="h-16 bg-gradient-to-t from-sol-bg via-[color-mix(in_srgb,var(--sol-bg)_80%,transparent)] to-transparent -mt-16 relative" />}
      <div className={`${bareComposer ? "pb-4" : "pb-3"} pointer-events-auto ${lightboxImageIndex === null ? "bg-sol-bg" : ""}`}>
        <div className="relative">
          {serverDeleted && !isRestarting && (
            <div className={`mx-auto px-4 mb-2 ${isExpanded ? "conv-col" : "max-w-md"} ${lightboxImageIndex !== null ? "hidden" : ""}`}>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-sol-orange/40 bg-sol-orange/10 px-3 py-2">
                <p className="text-[12px] text-sol-text">
                  This conversation was deleted on the server — you&apos;re viewing a cached copy.
                </p>
                <button
                  type="button"
                  onClick={() => handleForceResume()}
                  className="shrink-0 text-[12px] font-medium text-sol-orange hover:underline"
                >
                  Restore session
                </button>
              </div>
            </div>
          )}
          {!bareComposer && (isFocused || reviewCount > 0 || shortcutTooltip || showStuckBanner || isSessionStarting || isSessionReady || isInactive || optimisticSending || isSessionDisconnected || (pendingMessageId || existingPending) || (agentStatus && agentStatus !== "idle") || (!agentStatus && (isWaitingForResponse || isThinking || isConversationLive))) && (
            <div className={`mx-auto px-4 mb-1 flex justify-between items-center ${isExpanded ? "conv-col" : "max-w-md"} ${lightboxImageIndex !== null ? "hidden" : ""}`}>
              <p className="text-[11px] text-sol-text-dim/70 pl-1">
                {((isSessionStarting && !agentStatus) || isAgentStarting) && !showStuckBanner ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Starting session...
                  </span>
                ) : (pendingMessageId || existingPending) && !showStuckBanner && (isAgentStarting || isAgentDelivering) ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    {agentStatus === "resuming" ? "Resuming session..." : isAgentStarting ? "Starting session..." : "Delivering..."}
                  </span>
                ) : (pendingMessageId || existingPending) && !showStuckBanner && !agentStatus ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Processing...
                  </span>
                ) : isSessionReady && !showStuckBanner && (!agentStatus || agentStatus === "idle" || agentStatus === "connected") ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    Ready
                  </span>
                ) : showStuckBanner && sessionId ? (
                  <span className="flex items-center gap-2">
                    {isRestarting ? (
                      <span className={`flex items-center gap-1.5 ${restartStage?.tone === "error" ? "text-sol-red" : restartStage?.tone === "warn" ? "text-sol-yellow" : "text-sol-orange"}`}>
                        <span className={`w-2 h-2 rounded-full ${restartStage?.tone === "error" ? "bg-sol-red" : restartStage?.tone === "warn" ? "bg-sol-yellow" : "bg-sol-orange"} ${restartStage?.tone === "error" ? "" : "animate-pulse"}`} />
                        {restartStage?.label ?? "Killing & restarting session…"}
                      </span>
                    ) : isResuming ? (
                      isSessionStarting ? (
                        <span className="flex items-center gap-1.5 text-sol-cyan">
                          <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                          Starting session — waiting for agent to connect...
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-sol-yellow">
                          <span className="w-2 h-2 rounded-full bg-sol-yellow animate-pulse" />
                          {restartStage?.label ?? "Waiting for connection…"}
                        </span>
                      )
                    ) : (
                      <span className="flex items-center gap-1.5 text-sol-orange">
                        <span className="w-2 h-2 rounded-full bg-sol-orange" />
                        Disconnected
                      </span>
                    )}
                    {(pendingMessageId || existingPending) && (
                      <button
                        type="button"
                        onClick={handleCancelMessage}
                        className="text-[11px] text-sol-text-dim/60 hover:text-sol-orange underline underline-offset-2 transition-colors"
                        title="Stop retrying and discard this message"
                      >
                        Cancel
                      </button>
                    )}
                  </span>
                ) : agentStatus === "thinking" ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-violet/50 animate-pulse" />
                    Thinking...
                  </span>
                ) : agentStatus === "compacting" ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-400/60 animate-pulse" />
                    Compacting...
                  </span>
                ) : agentStatus === "permission_blocked" ? (
                  <span className="flex items-center gap-1.5 text-sol-orange">
                    <span className="w-2 h-2 rounded-full bg-sol-orange animate-pulse" />
                    {(pendingPermissionsCount ?? 0) > 0 ? "Permission needed" : hasAskUserQuestion ? "Answer needed" : "Needs input"}
                  </span>
                ) : agentStatus === "connected" ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Connected
                  </span>
                ) : agentStatus === "working" ? (
                  <WorkingStatusLine startedAt={workingSinceTs} toolLabel={workingTool} />
                ) : agentStatus === "idle" && queuedMessages.length > 0 ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Sending queued ({queuedMessages.length})...
                  </span>
                ) : agentStatus === "idle" ? (
                  "\u00A0"
                ) : isThinking ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-violet/50 animate-pulse" />
                    Thinking...
                  </span>
                ) : isWaitingForResponse ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Connecting...
                  </span>
                ) : isConversationLive ? (
                  <WorkingStatusLine startedAt={workingSinceTs} toolLabel={workingTool} />
                ) : isSessionDisconnected ? (
                  isResuming ? (
                    <span className="flex items-center gap-1.5 text-sol-text-dim">
                      <span className="w-2 h-2 rounded-full bg-sol-text-dim animate-pulse" />
                      Restarting...
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-sol-text-dim/50">
                      <span className="w-2 h-2 rounded-full bg-sol-text-dim/30" />
                      Session idle
                    </span>
                  )
                ) : optimisticSending ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Resuming session...
                  </span>
                ) : isInactive ? "Session idle — message to resume" : "\u00A0"}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const rect = sendRef.current?.getBoundingClientRect();
                    if (rect) setShortcutTooltip(prev => prev ? null : { x: rect.right, y: rect.top });
                  }}
                  onMouseEnter={() => {
                    clearTimeout((window as any).__shortcutTooltipTimer);
                    const rect = sendRef.current?.getBoundingClientRect();
                    if (rect) setShortcutTooltip({ x: rect.right, y: rect.top });
                  }}
                  onMouseLeave={() => {
                    (window as any).__shortcutTooltipTimer = setTimeout(() => {
                      if (!document.querySelector('[data-shortcut-tooltip]:hover')) setShortcutTooltip(null);
                    }, 150);
                  }}
                  className="text-[9px] text-sol-text-dim hover:text-sol-text transition-colors w-4 h-4 flex items-center justify-center rounded-full border border-sol-text-dim/50 hover:border-sol-text-dim bg-sol-bg-alt font-semibold"
                >
                  ?
                </button>
                {permissionMode && (
                  <div className="relative">
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { onCycleMode?.(); flashModeLabel(); }}
                      onMouseEnter={() => setModeTooltip(true)}
                      onMouseLeave={() => setModeTooltip(false)}
                      className="flex items-center gap-1.5"
                    >
                      <div className={`w-2 h-2 rounded-full transition-colors ${
                        permissionMode === "plan" ? "bg-sol-blue" :
                        permissionMode === "acceptEdits" ? "bg-emerald-400" :
                        permissionMode === "bypassPermissions" ? "bg-orange-500" :
                        permissionMode === "dontAsk" ? "bg-sol-yellow" :
                        "bg-sol-base00/50"
                      }`} />
                      {permissionMode !== "default" && (
                        <span
                          className={`text-[10px] font-mono transition-all duration-300 ease-out overflow-hidden whitespace-nowrap ${
                            showModeLabel ? "max-w-[80px] opacity-100 translate-x-0" : "max-w-0 opacity-0 -translate-x-1"
                          } ${
                            permissionMode === "plan" ? "text-sol-blue" :
                            permissionMode === "acceptEdits" ? "text-emerald-400" :
                            permissionMode === "bypassPermissions" ? "text-orange-500" :
                            "text-sol-yellow"
                          }`}
                        >
                          {permissionMode === "plan" ? "plan" :
                           permissionMode === "acceptEdits" ? "auto-edit" :
                           permissionMode === "bypassPermissions" ? "bypass" :
                           permissionMode === "dontAsk" ? "don't ask" :
                           permissionMode}
                        </span>
                      )}
                    </button>
                    {modeTooltip && (
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 rounded bg-sol-bg border border-sol-border/60 shadow-lg whitespace-nowrap text-[10px] pointer-events-none flex items-center gap-1.5">
                        <span className={
                          permissionMode === "plan" ? "text-sol-blue" :
                          permissionMode === "acceptEdits" ? "text-emerald-400" :
                          permissionMode === "bypassPermissions" ? "text-orange-500" :
                          permissionMode === "dontAsk" ? "text-sol-yellow" :
                          "text-sol-text-dim"
                        }>
                          {permissionMode === "default" ? "default" :
                           permissionMode === "plan" ? "plan mode" :
                           permissionMode === "acceptEdits" ? "accept edits" :
                           permissionMode === "bypassPermissions" ? "bypass permissions" :
                           permissionMode === "dontAsk" ? "don't ask" :
                           permissionMode}
                        </span>
                        <span className="flex items-center gap-1 text-sol-text-dim/50">
                          <KeyCap size="xs">{isMac ? "⇧" : "Shift"}</KeyCap>
                          <KeyCap size="xs">Tab</KeyCap>
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          {acTrigger && (acItems.length > 0 || (acTrigger.type === "@" && acServerLoading && !acQuery.includes(" "))) && (() => {
            const typeConfig: Record<string, { icon: typeof User; color: string; label: string }> = {
              person: { icon: User, color: "text-sol-green", label: "People" },
              task: { icon: CheckSquare, color: "text-sol-violet", label: "Tasks" },
              doc: { icon: FileText, color: "text-sol-cyan", label: "Docs" },
              session: { icon: MessageSquare, color: "text-sol-blue", label: "Sessions" },
              plan: { icon: MapIcon, color: "text-sol-violet", label: "Plans" },
              label: { icon: Tag, color: "text-sol-magenta", label: "Labels" },
              file: { icon: FolderOpen, color: "text-sol-base01", label: "Files" },
              skill: { icon: Hash, color: "text-sol-orange", label: "Commands" },
            };
            const grouped: Array<{ type: string; items: typeof acItems; startIdx: number }> = [];
            let idx = 0;
            for (const item of acItems) {
              let group = grouped.find(g => g.type === item.type);
              if (!group) { group = { type: item.type, items: [], startIdx: idx }; grouped.push(group); }
              group.items.push(item);
              idx++;
            }
            const dropdown = (
              <div
                ref={acRef}
                className={chatMentionMode
                  ? "absolute bottom-0 mb-1 z-30"
                  : `mx-auto px-2 sm:px-4 mb-1 ${isExpanded ? "conv-col" : "max-w-md"}`}
                style={chatMentionMode ? { left: acCaretLeft, width: CHAT_AC_WIDTH } : undefined}
              >
                <div className="bg-sol-bg border border-sol-border/50 rounded-lg shadow-xl py-1.5 max-h-[320px] overflow-y-auto">
                  {grouped.map(group => {
                    const config = typeConfig[group.type] || typeConfig.doc;
                    const GIcon = config.icon;
                    return (
                      <div key={group.type}>
                        <div className="px-3 py-1.5 flex items-center gap-1.5">
                          <GIcon className={`w-3 h-3 ${config.color}`} />
                          <span className="text-[10px] font-medium uppercase tracking-wider text-sol-text-dim">{config.label}</span>
                        </div>
                        {group.items.map((item, i) => {
                          const globalIdx = group.startIdx + i;
                          const isSelected = globalIdx === clampedAcIndex;
                          // Session rows: prefer what it's about (idle summary); else show the
                          // project only when it's a different repo than the current conversation.
                          const itemProject = item.projectPath?.split("/").filter(Boolean).pop() || null;
                          const sessionLeft = item.idleSummary || (itemProject && itemProject !== composeProject ? itemProject : null);
                          return (
                            <button
                              key={item.id || item.label}
                              type="button"
                              ref={isSelected ? (el) => { if (el && acScrollRef.current) { el.scrollIntoView({ block: "nearest" }); acScrollRef.current = false; } } : undefined}
                              onMouseEnter={() => setAcIndex(globalIdx)}
                              onMouseDown={(e) => { e.preventDefault(); applyAutocomplete(item); }}
                              className={`w-full text-left px-3 py-1.5 flex items-center gap-2.5 transition-colors ${isSelected ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"}`}
                            >
                              {item.image ? (
                                <AvatarImg src={item.image} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0" />
                              ) : item.isBot ? (
                                <Bot className="w-3.5 h-3.5 flex-shrink-0 text-sol-violet" />
                              ) : (
                                <Hash className={`w-3.5 h-3.5 flex-shrink-0 ${config.color} opacity-60`} />
                              )}
                              <span className="text-sm flex-shrink-0">
                                {item.type === "file" ? (item.label.split("/").pop() || item.label) : item.type === "skill" ? `/${item.label}` : item.label}
                              </span>
                              {item.type === "file" && (
                                <span className="text-[11px] text-sol-text-dim font-mono flex-shrink-0 truncate max-w-[50%]">{item.label.replace(/\/[^/]+$/, "")}</span>
                              )}
                              {item.type === "session" ? (
                                // Sessions show real metadata, never an id: what it's about
                                // (idle summary) or a cross-repo project on the left, msgs · age on the right.
                                <span className="flex items-center gap-1.5 min-w-0 flex-1 text-[11px] text-sol-text-dim">
                                  {sessionLeft && (
                                    <span className="truncate">{sessionLeft}</span>
                                  )}
                                  {(item.messageCount || item.updatedAt) && (
                                    <span className="ml-auto flex-shrink-0 flex items-center gap-1 whitespace-nowrap">
                                      {item.messageCount ? <span>{item.messageCount} msg{item.messageCount === 1 ? "" : "s"}</span> : null}
                                      {item.messageCount && item.updatedAt ? <span className="opacity-40">·</span> : null}
                                      {item.updatedAt ? <span>{formatRelativeTime(item.updatedAt)}</span> : null}
                                    </span>
                                  )}
                                </span>
                              ) : item.type !== "file" && item.description ? (
                                <span className="text-[11px] text-sol-text-dim font-mono truncate">{item.description}</span>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                  {acTrigger.type === "@" && acServerLoading && (
                    <div className="px-3 py-2 flex items-center gap-2 text-[11px] text-sol-text-dim border-t border-sol-border/30">
                      <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z" />
                      </svg>
                      <span>Searching everything&hellip;</span>
                    </div>
                  )}
                </div>
              </div>
            );
            if (!chatMentionMode) return dropdown;
            // Zero height on purpose: it contributes no layout, only the
            // positioning context the caret-anchored popup hangs from.
            return <div ref={acAnchorRef} className="relative h-0">{dropdown}</div>;
          })()}
          {!bareComposer && suggestionsEnabled && !onGateSend && !onWorkflowLaunch && !hasAskUserQuestion && (
            <div className={`mx-auto px-2 sm:px-4 ${isExpanded ? "conv-col" : "max-w-md"}`}>
              <SuggestionPills
                ref={suggestionPillsRef}
                conversationId={conversationId}
                idle={!isWaitingForResponse && !isThinking && !(agentStatus && ACTIVE_AGENT_STATUSES.has(agentStatus))}
                hidden={!!message || pastedImages.length > 0 || composeMode}
                // handleSubmit reads messageRef, not React state, so stamping
                // both and submitting on the same tick is race-free (the same
                // contract ComposeEditor's onSubmit relies on).
                onSend={(t) => { setMessage(t); messageRef.current = t; void handleSubmit({ preventDefault: () => {} } as any); }}
                onEdit={(t) => { setMessage(t); textareaRef.current?.focus(); }}
                onActiveChange={setPillSelectionActive}
              />
            </div>
          )}
          <form onSubmit={handleFormSubmit} className={bareComposer ? "w-full" : `mx-auto px-2 sm:px-4 transition-all duration-200 ease-out ${isExpanded ? "conv-col" : "max-w-md"}`}>
            <div className={`flex flex-col ${bareComposer ? "" : "border"} transition-colors duration-150 ${bareComposer ? "px-2.5 py-0.5 rounded-lg bg-sol-text/[0.04] focus-within:bg-sol-text/[0.07]" : `border px-4 py-2 shadow-lg bg-sol-bg-alt ${isExpanded ? "rounded-2xl" : "rounded-full"}`} ${composeMode ? "min-h-[40vh]" : ""} ${isSelectionActive ? "border-sol-cyan/40 ring-1 ring-sol-cyan/20" : composeMode ? "border-sol-cyan/20" : bareComposer ? "" : "border-sol-border"}`}>
              {isSelectionActive && (
                <div className="flex items-center gap-2 pb-1.5 mb-1.5 border-b border-sol-cyan/20 text-[10px] text-sol-cyan">
                  <span className="font-medium">Rewriting message</span>
                  <span className="text-sol-text-dim">Enter to fork &amp; send</span>
                  <span className="text-sol-text-dim">Esc to cancel</span>
                </div>
              )}
              {branchMapNode}
              {!bareComposer && <ReviewBar conversationId={conversationId} />}
              {!bareComposer && queuedMessages.length > 0 && (
                <div className="flex flex-col gap-1 pb-2 mb-2 border-b border-sol-border/50">
                  {queuedMessages.map((qMsg, idx) => (
                    <div
                      key={idx}
                      className={`group flex items-center gap-1.5 px-2 py-1 rounded text-[11px] cursor-pointer transition-colors ${
                        selectedQueueIndex === idx
                          ? "bg-sol-blue/15 border border-sol-blue/40 text-sol-text"
                          : "bg-sol-bg/50 border border-sol-border/30 text-sol-text-secondary hover:border-sol-border/60"
                      }`}
                      onClick={() => {
                        setSelectedQueueIndex(selectedQueueIndex === idx ? null : idx);
                        textareaRef.current?.focus();
                      }}
                    >
                      <span className="text-sol-text-dim text-[9px] font-mono shrink-0">{idx + 1}</span>
                      <span className="truncate flex-1 font-mono">{qMsg}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setQueuedMessages(prev => prev.filter((_, i) => i !== idx));
                          if (selectedQueueIndex === idx) setSelectedQueueIndex(null);
                          else if (selectedQueueIndex !== null && selectedQueueIndex > idx) setSelectedQueueIndex(selectedQueueIndex - 1);
                        }}
                        className="shrink-0 w-4 h-4 flex items-center justify-center rounded text-sol-text-dim hover:text-sol-text opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                  {selectedQueueIndex !== null && (
                    <span className="text-[9px] text-sol-text-dim flex items-center gap-2 pl-1">
                      <span className="inline-flex items-center gap-1"><KeyCap size="xs">↑</KeyCap><KeyCap size="xs">↓</KeyCap> navigate</span>
                      <span className="inline-flex items-center gap-1"><KeyCap size="xs">Del</KeyCap> remove</span>
                      <span className="inline-flex items-center gap-1"><KeyCap size="xs">Enter</KeyCap> edit</span>
                      <span className="inline-flex items-center gap-1"><KeyCap size="xs">Esc</KeyCap> deselect</span>
                    </span>
                  )}
                </div>
              )}
              {pastedImages.length > 0 && (
                <div className="flex items-center gap-2 pb-2 mb-2 border-b border-sol-border/50 flex-wrap">
                  {pastedImages.map((img, idx) => (
                    <div
                      key={idx}
                      className="relative group cursor-pointer"
                      onClick={() => {
                        setSelectedImageIndex(idx);
                        setLightboxImageIndex(idx);
                        textareaRef.current?.focus();
                      }}
                    >
                      <div className={`relative h-16 w-16 rounded-lg overflow-hidden bg-sol-bg shrink-0 transition-all ${selectedImageIndex === idx ? "ring-2 ring-sol-blue ring-offset-1 ring-offset-sol-bg" : ""}`}>
                        <img src={img.previewUrl} alt="Pasted" className="h-full w-full object-cover" />
                        {img.uploading && (
                          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                            <svg className="w-5 h-5 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                          </div>
                        )}
                      </div>
                      <button type="button" onClick={(e) => { e.stopPropagation(); clearImage(idx); if (selectedImageIndex === idx) { setSelectedImageIndex(null); setLightboxImageIndex(null); } }} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-sol-bg-alt border border-sol-border flex items-center justify-center text-sol-text-secondary hover:text-sol-text transition-colors opacity-0 group-hover:opacity-100">
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                  {selectedImageIndex !== null && (
                    <span className="text-[10px] text-sol-text-dim ml-1 flex items-center gap-2">
                      <span className="inline-flex items-center gap-1"><KeyCap size="xs">←</KeyCap><KeyCap size="xs">→</KeyCap> navigate</span>
                      <span className="inline-flex items-center gap-1"><KeyCap size="xs">Space</KeyCap> preview</span>
                      <span className="inline-flex items-center gap-1"><KeyCap size="xs">Del</KeyCap> remove</span>
                      <span className="inline-flex items-center gap-1"><KeyCap size="xs">Esc</KeyCap> exit</span>
                    </span>
                  )}
                </div>
              )}
              {composeMode ? (
                <div className="flex flex-col flex-1 min-h-0">
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <ComposeEditor
                      ref={composeRef}
                      initialContent={message}
                      onMentionQuery={composeMentionQuery}
                      onImagePaste={uploadImage}
                      onSubmit={() => handleFormSubmit({ preventDefault: () => {} } as any)}
                      onExit={toggleCompose}
                      onContentChange={setComposeHasContent}
                      placeholder="Compose your message... / for commands, @ to mention"
                    />
                  </div>
                  <div className="flex items-center justify-between pt-2 mt-1 border-t border-sol-border/20">
                    <span className="text-[10px] text-sol-text-dim/50 select-none">
                      {navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+Enter send &middot; Esc collapse
                    </span>
                    <div ref={sendRef} className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={toggleCompose}
                        className="w-7 h-7 rounded-full transition-colors flex items-center justify-center text-sol-text-dim hover:text-sol-text hover:bg-sol-bg/50"
                        title="Collapse editor (Cmd+Shift+E)"
                      >
                        <Minimize2 className="w-3.5 h-3.5" />
                      </button>
                      {onSendAndDismiss && canSubmit && !onGateSend && !onWorkflowLaunch && (
                        <ShortcutTooltip label="Send and stash" action="msg.sendDismiss" hint="the agent keeps running out of the inbox" side="top">
                          <button
                            type="button"
                            onClick={handleSendAndStash}
                            className="w-7 h-7 rounded-full transition-all flex items-center justify-center text-[color-mix(in_srgb,var(--sol-text-dim)_40%,transparent)] hover:text-sol-yellow hover:bg-sol-yellow/10"
                            aria-label="Send and stash"
                          >
                            <Archive className="w-3.5 h-3.5" />
                          </button>
                        </ShortcutTooltip>
                      )}
                      {onForkSend && canSubmit && !onGateSend && !onWorkflowLaunch && (
                        <button
                          type="button"
                          onClick={handleForkSend}
                          className="w-7 h-7 rounded-full transition-all flex items-center justify-center text-[color-mix(in_srgb,var(--sol-text-dim)_40%,transparent)] hover:text-sol-cyan hover:bg-sol-cyan/10"
                          title={`Fork and send (${navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+Shift+Enter)`}
                        >
                          <Split className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        type="submit"
                        disabled={!canSubmit}
                        className={sendBtnClass}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-end gap-2">
                  <textarea
                    ref={textareaRef}
                    data-chat-input
                    data-draft-conv={conversationId}
                    value={message}
                    onChange={(e) => handleMessageChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => { setIsFocused(false); setAcTrigger(null); }}
                    placeholder={bareComposer ? (composerPlaceholder ?? "Comment…") : onGateSend ? "Send a message to continue the workflow..." : onWorkflowLaunch ? "Goal override (optional) — press send to run workflow..." : reviewCount > 0 ? `Send ${reviewCount} quote${reviewCount !== 1 ? "s" : ""} as-is, or add a reply first...` : agentStatus === "permission_blocked" ? ((pendingPermissionsCount ?? 0) > 0 ? "Approve or deny permission to continue..." : hasAskUserQuestion ? "Answer the question to continue..." : "Send a message...") : "Send a message..."}
                    rows={1}
                    style={FIELD_SIZING_STYLE}
                    className={`flex-1 bg-transparent text-sm placeholder:text-sol-text-dim focus:outline-none disabled:opacity-50 resize-none overflow-hidden leading-relaxed py-1 ${isSelectionActive && !isSelectionEditedRef.current ? "text-sol-text-dim italic" : "text-sol-text"}`}
                  />
                  <div ref={sendRef} className="shrink-0 flex items-end gap-1">
                    {isMultiline && (
                      <button
                        type="button"
                        onClick={toggleCompose}
                        className="w-7 h-7 mb-0.5 rounded-full transition-all flex items-center justify-center text-sol-text-dim/30 hover:text-sol-text-dim hover:bg-sol-bg/50"
                        title="Expand editor (Cmd+Shift+E)"
                      >
                        <Maximize2 className="w-3 h-3" />
                      </button>
                    )}
                    {onSendAndDismiss && canSubmit && !onGateSend && !onWorkflowLaunch && (
                      <ShortcutTooltip label="Send and stash" action="msg.sendDismiss" hint="the agent keeps running out of the inbox" side="top">
                        <button
                          type="button"
                          onClick={handleSendAndStash}
                          className="w-7 h-7 mb-0.5 rounded-full transition-all flex items-center justify-center text-[color-mix(in_srgb,var(--sol-text-dim)_40%,transparent)] hover:text-sol-yellow hover:bg-sol-yellow/10"
                          aria-label="Send and stash"
                        >
                          <Archive className="w-3.5 h-3.5" />
                        </button>
                      </ShortcutTooltip>
                    )}
                    {onForkSend && canSubmit && !onGateSend && !onWorkflowLaunch && (
                      <button
                        type="button"
                        onClick={handleForkSend}
                        className="w-7 h-7 mb-0.5 rounded-full transition-all flex items-center justify-center text-[color-mix(in_srgb,var(--sol-text-dim)_40%,transparent)] hover:text-sol-cyan hover:bg-sol-cyan/10"
                        title={`Fork and send (${navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+Shift+Enter)`}
                      >
                        <Split className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={!canSubmit}
                      className={sendBtnClass}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M5 12l7-7 7 7" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </form>
        </div>
      </div>
      {shortcutTooltip && createPortal(
        <div
          data-shortcut-tooltip
          className="fixed z-[10000] bg-sol-bg border border-sol-border/60 rounded-lg shadow-lg p-3 w-56"
          style={{ top: shortcutTooltip.y - 30, left: shortcutTooltip.x, transform: 'translate(-100%, -100%)' }}
          onMouseEnter={() => clearTimeout((window as any).__shortcutTooltipTimer)}
          onMouseLeave={() => {
            (window as any).__shortcutTooltipTimer = setTimeout(() => setShortcutTooltip(null), 150);
          }}
        >
          <div className="text-[10px] font-medium text-sol-text/80 mb-2">Sending</div>
          <div className="space-y-1.5 text-[9px] text-sol-text-dim/70">
            {SEND_CHORDS.map(({ accel, label }) => (
              <ShortcutHint key={accel} keys={formatAcceleratorParts(accel)} label={label} />
            ))}
            <div className="border-t border-sol-border/20 mt-1.5 pt-1.5">
              <button
                onClick={() => { setShortcutTooltip(null); useInboxStore.getState().toggleShortcutsPanel(); }}
                className="text-sol-cyan/80 hover:text-sol-cyan transition-colors flex items-center gap-1"
              >
                <Keyboard className="w-3 h-3" /> View all shortcuts
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {lightboxImageIndex !== null && pastedImages[lightboxImageIndex] && createPortal(
        // Center the preview in the space ABOVE the composer, not the whole
        // viewport: the composer stays visible over the lightbox (so you can
        // keep typing), and a viewport-centered tall image would run behind and
        // past it — worst in the compose dialog, where the composer sits
        // mid-screen. paddingBottom pushes the centering box up to the
        // composer's top edge; the img maxHeight clamps to that space so a
        // vertical image fits it instead of 70vh of viewport.
        (() => {
          const composerTop = composerRootRef.current?.getBoundingClientRect().top;
          const reserved = composerTop != null ? Math.max(0, window.innerHeight - composerTop) : 0;
          const available = composerTop != null ? Math.max(120, composerTop - 24) : undefined;
          return (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center" style={{ backgroundColor: `rgba(0,0,0,${0.8 * lightboxSwipe.backdropOpacity})`, paddingBottom: reserved, paddingTop: 12 }}>
          <div className="absolute inset-0" onClick={dismissLightbox} />
          <div className="relative" onClick={(e) => e.stopPropagation()} style={lightboxSwipe.style} {...lightboxSwipe.handlers}>
            <img
              src={pastedImages[lightboxImageIndex].previewUrl}
              alt="Image preview"
              className="max-w-[85vw] max-h-[70vh] object-contain rounded-lg shadow-2xl"
              style={available != null ? { maxHeight: available } : undefined}
            />
            {pastedImages.length > 1 && (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
                {pastedImages.map((_, i) => (
                  <div key={i} className={`w-1.5 h-1.5 rounded-full transition-colors ${i === lightboxImageIndex ? "bg-white" : "bg-white/30"}`} />
                ))}
              </div>
            )}
          </div>
        </div>
          );
        })(),
        composerRootRef.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body
      )}
    </div>
  );
});

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

const CC_MODE_ORDER = ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"];

// The body is a plain function (not the forwardRef callback itself) so the dev
// wrapper below can size the element tree each pass returns.
const ConversationViewInner = (
  function ConversationView({ conversation, commits = [], pullRequests = [], backHref, backLabel = "Back", headerExtra, headerLeft, headerEnd, hasMoreAbove, hasMoreBelow, isLoadingOlder, isLoadingNewer, onLoadOlder, onLoadNewer, onJumpToStart, onJumpToEnd, onJumpToTimestamp, highlightQuery: propHighlightQuery, onClearHighlight: propClearHighlight, embedded, showMessageInput = true, targetMessageId, targetNonce, isJumpingToTarget, isOwner = true, guest = false, onSendAndAdvance, onSendAndDismiss, autoFocusInput, fallbackStickyContent: rawFallbackStickyContent, onBack, subHeaderContent, hideHeader, onSubmitWithIntent }: ConversationViewProps, ref: ForwardedRef<ConversationViewHandle>) {
  devRenderCount("ConversationView2");
  const fallbackStickyContent = useMemo(() => stickyPromptContent(rawFallbackStickyContent), [rawFallbackStickyContent]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolled, _setUserScrolled] = useState(false);
  const userScrolledRef = useRef(false);
  const setUserScrolled = useCallback((v: boolean) => { userScrolledRef.current = v; _setUserScrolled(v); }, []);
  const [isNearTop, setIsNearTop] = useState(true);
  // Position twin of isNearTop for the bottom edge (200px band). The jump
  // buttons hide inside these bands — the userScrolled gesture latch alone
  // showed the down arrow on a 2px nudge while still parked at the bottom.
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [isScrollable, setIsScrollable] = useState(false);
  // Guests read in simple view (DashboardLayout's guest branch), so they get
  // its calmer condensed default too — without owning a simple_view pref.
  const resolveDefaultDensity = useCallback(
    (): ConversationDensity => (guest ? "condensed" : defaultDensity()),
    [guest]
  );
  const [density, setDensityState] = useState<ConversationDensity>(resolveDefaultDensity);
  const setDensity = useCallback((d: ConversationDensity) => {
    setDensityState(d);
    if (conversation?._id) DENSITY_BY_CONVERSATION.set(conversation._id, d);
  }, [conversation?._id]);
  // Toggling Simple view retunes the open conversation immediately — but only
  // when the user hasn't explicitly picked a density for it (that choice wins).
  const simpleViewPref = useInboxStore((st) => st.clientState.ui?.simple_view === true);
  useWatchEffect(() => {
    if (conversation?._id && DENSITY_BY_CONVERSATION.has(conversation._id)) return;
    setDensityState(resolveDefaultDensity());
  }, [simpleViewPref]);
  // Feed-rendering density: story/summary swap the feed out entirely, so the
  // virtualizer (and its height cache keys) only ever sees the first three.
  const feedDensity: MessageFeedDensity = density === "condensed" || density === "compact" ? density : "full";
  const condensedFeed = feedDensity !== "full";
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
  const [allMatchingMessageIds, setAllMatchingMessageIds] = useState<string[]>([]);
  const [matchInstances, setMatchInstances] = useState<{ messageId: string; localIndex: number; timestamp: number }[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [isLocalSearchOpen, setIsLocalSearchOpen] = useState(false);
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [navTrigger, setNavTrigger] = useState(0);
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
  const [navScrollProgress, setNavScrollProgress] = useState(1);
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
  const stickyDisabled = useInboxStore(s => s.clientState.ui?.sticky_headers_disabled ?? false);
  const updateUI = useInboxStore(s => s.updateClientUI);
  const headerRef = useRef<HTMLElement>(null);
  // Zen mode on desktop: the head ROW is the window titlebar (drag +
  // traffic-light inset). The ref goes on the inner cc-panel__head — the
  // element that paints the head background and bottom border — so the inset
  // padding shares its surface; on the outer wrapper the padding area showed
  // the wrapper's own darker background as a 78px block with a hard seam.
  const titlebarHeadRef = useTitlebarHead<HTMLDivElement>();
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
    setIsNearTop(true);
    setIsNearBottom(true);
    setDensityState((conversation?._id && DENSITY_BY_CONVERSATION.get(conversation._id)) || resolveDefaultDensity());
    setExpandedGroups(new Set());
    setDiffExpanded(false);
    setShowThinking(false);
    setHighlightedMessageId(null);
    setAllMatchingMessageIds([]);
    setMatchInstances([]);
    setCurrentMatchIndex(0);
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
  const effectiveConversationId = conversation?._id;

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
  const isSessionLive = !!managedSession?.is_connected;
  // The simple-view menu's "Copy tmux attach" — the same gesture as the header
  // pill's copy button, so it copies the same command for the same machine.
  const { copyAttach: copyTmuxAttach } = useAttachCopy(managedSession?.tmux_session, conversation?._id?.toString());

  // Store-fed (hooks/useSyncWorkflows): the gate banner paints from the cached
  // run on the first frame; the feeder keeps it live.
  const workflowRun = useWorkflowRun(
    deferredQueriesEnabled && conversation?.workflow_run_id ? conversation.workflow_run_id : null,
  ) as { _id: string; status: string; gate_prompt?: string; gate_choices?: Array<{ key: string; label: string; target: string }>; gate_response?: string | null } | null | undefined;
  const respondToGate = useMutation(api.workflow_runs.respondToGate);
  const [gateResponding, setGateResponding] = useState(false);
  const handleGateRespond = useCallback(async (text: string) => {
    if (!workflowRun || !text.trim()) return;
    setGateResponding(true);
    try { await respondToGate({ id: workflowRun._id as any, response: text.trim() }); } finally { setGateResponding(false); }
  }, [workflowRun, respondToGate]);
  const handleGateChoice = handleGateRespond;

  const [showWorkflow, setShowWorkflow] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const { workflows } = useWorkflows();
  const createWorkflowRun = useMutation(api.workflow_runs.create);
  const handleWorkflowLaunch = useCallback(async (goal: string) => {
    if (!selectedWorkflowId) return;
    try {
      await createWorkflowRun({
        workflow_id: selectedWorkflowId,
        goal_override: goal || undefined,
        project_path: conversation?.project_path || undefined,
        existing_conversation_id: conversation?._id as any,
      });
      toast.success("Workflow started");
      setShowWorkflow(false);
      setSelectedWorkflowId("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start workflow");
    }
  }, [selectedWorkflowId, createWorkflowRun, conversation?.project_path, conversation?._id]);

  const [optimisticMode, setOptimisticMode] = useState<string | null>(null);
  const optimisticTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleCycleMode = useCallback(() => {
    // convexConvId is undefined until the session exists server-side; a not-yet-started
    // draft carries a stub id and has no live process to receive keystrokes.
    if (!conversation || !effectiveIsOwner || conversation.status !== "active" || !convexConvId) return;
    void convCommand(convexConvId, "sendKeysToSession", { keys: "BTab" }).catch((err) => {
      if (isParkedDispatchError(err)) return;
      toast.error(err instanceof Error ? err.message : "Failed to change permission mode");
    });
    const currentMode = optimisticMode || managedSession?.permission_mode || "default";
    const nextIdx = (CC_MODE_ORDER.indexOf(currentMode) + 1) % CC_MODE_ORDER.length;
    setOptimisticMode(CC_MODE_ORDER[nextIdx]);
    clearTimeout(optimisticTimerRef.current);
    optimisticTimerRef.current = setTimeout(() => setOptimisticMode(null), 8000);
  }, [conversation, effectiveIsOwner, convCommand, optimisticMode, managedSession?.permission_mode, convexConvId]);

  const handleEnableBypass = useCallback(() => {
    if (!conversation || !effectiveIsOwner || conversation.status !== "active" || !convexConvId) return;
    const currentMode = optimisticMode || managedSession?.permission_mode || "default";
    const currentIdx = CC_MODE_ORDER.indexOf(currentMode);
    const targetIdx = CC_MODE_ORDER.indexOf("bypassPermissions");
    if (currentIdx === -1 || targetIdx === -1 || currentIdx === targetIdx) return;
    const steps = (targetIdx - currentIdx + CC_MODE_ORDER.length) % CC_MODE_ORDER.length;
    if (steps === 0) return;
    const keys = Array(steps).fill("BTab").join(" ");
    void convCommand(convexConvId, "sendKeysToSession", { keys }).catch((err) => {
      if (isParkedDispatchError(err)) return;
      toast.error(err instanceof Error ? err.message : "Failed to enable bypass permissions");
    });
    setOptimisticMode("bypassPermissions");
    clearTimeout(optimisticTimerRef.current);
    optimisticTimerRef.current = setTimeout(() => setOptimisticMode(null), 8000);
  }, [conversation, effectiveIsOwner, convCommand, optimisticMode, managedSession?.permission_mode, convexConvId]);
  useWatchEffect(() => {
    if (optimisticMode && managedSession?.permission_mode === optimisticMode) {
      setOptimisticMode(null);
      clearTimeout(optimisticTimerRef.current);
    }
  }, [managedSession?.permission_mode, optimisticMode]);
  const effectiveMode = optimisticMode || managedSession?.permission_mode || "default";

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
    const base = messagesFromConv.some(m => m.role === "user" && isImportNotice(m.content))
      ? messagesFromConv.filter(m => !(m.role === "user" && isImportNotice(m.content)))
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
    const allForks = [...(conversation?.fork_children || []), ...(conversation?.fork_siblings || []), ...optimisticForkChildren];
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
  }, [conversation?.fork_children, conversation?.fork_siblings, conversation?.messages, optimisticForkChildren]);

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
        openForwardToChat({ url, label: selectedMessageIds.size > 1 ? "messages" : "message" });
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
  }, [selectedMessageIds, messages, generateShareLink, shareIncludeConversation]);

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

  // Fork UI state (panels). Forks themselves are first-class conversations
  // (we navigate to them); no overlay state to keep in sync.
  const forkSetMessages = useInboxStore((s) => s.setMessages);
  const resolveForkSessionId = useInboxStore((s) => s.resolveForkSessionId);
  const forkSetSelectedIndex = useForkNavigationStore((s) => s.setSelectedIndex);
  // Branch map open-state. One surface: a command-palette-style popover anchored
  // above the message input. Ctrl+B / the header icon open it at the branch
  // tree (mapDrill = null); double-Esc opens it drilled into the current
  // branch's messages (mapDrill = current conversation id).
  const [treePopoverOpen, setTreePopoverOpen] = useState(false);
  const [mapDrill, setMapDrill] = useState<string | null>(null);
  const treeChipRef = useRef<HTMLButtonElement>(null);

  const timelineRef = useRef<any[]>([]);

  // Switch to a freshly created fork instantly from local state. injectSession seeds
  // sessions[id] AND sets currentSessionId in one action, so the inbox renders the
  // fork immediately — no server round-trip, no skeleton. Its real metadata/messages
  // reconcile in the background via getConversationWithMeta + listMessages as the
  // server-side copy advances. Deliberately NOT router.push('/conversation/{id}'): that
  // routes through the redirector page (resolveConversation + loading skeleton +
  // redirect to /inbox), reloading the conversation. QueuePageClient syncs the URL via
  // history.replaceState. Server-derived fields (title prefix, exact message_count) are
  // approximate here and get corrected by the meta subscription within a tick.
  const seedForkSession = useCallback((convId: string, fields: Partial<InboxSession>) => {
    injectSession({
      _id: convId,
      session_id: convId,
      title: conversation?.title,
      updated_at: Date.now(),
      project_path: conversation?.project_path ?? undefined,
      git_root: conversation?.git_root ?? undefined,
      agent_type: conversation?.agent_type || "claude_code",
      message_count: 0,
      is_idle: true,
      has_pending: false,
      ...fields,
    });
  }, [conversation?.title, conversation?.project_path, conversation?.git_root, conversation?.agent_type, injectSession]);

  // Local-first fork: seed the stub conversation WITH the parent's loaded
  // message window sliced at the fork point and navigate to it synchronously —
  // the fork renders fully populated in the same frame as the click. The
  // server mutation, message copy, and daemon tmux spawn all happen behind it;
  // the only visible artifact is the session status line above the input
  // ("Starting session…" → "Ready"). resolveForkSessionId rekeys stub → real id
  // when the mutation lands, and useConversationMessages freezes the server
  // message sync while fork_status === "copying" so the half-copied server
  // window can never clobber the seeded one.
  const doFork = useCallback(async (messageUuid: string): Promise<{ forkSessionId: string; conversationId: string; ready: Promise<string> } | null> => {
    if (!conversation?._id) return null;
    // Honest degradation: a client with no fork mechanism (cursor/gemini/pi) would
    // copy the transcript server-side but leave the live agent context-less. The UI
    // hides the fork controls for these; this guards any programmatic path too.
    if (!agentSupportsFork(conversation.agent_type)) return null;
    const parentId = conversation._id.toString();
    // Must be a valid UUID so the daemon can resume without ID remapping
    const forkSessionId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    const now = Date.now();
    const forkTitle = conversation.title ? `Fork: ${conversation.title}` : "Fork";
    // Parent's server rows up to and including the fork point. Optimistic/queued
    // rows are excluded — they aren't in the messages table yet, so the server
    // copy won't include them either.
    const parentMsgs = (conversation.messages || []).filter((m: any) => !m._isOptimistic && !m._isQueued);
    const forkIdx = parentMsgs.findIndex((m: any) => m.message_uuid === messageUuid);
    const seededMsgs = forkIdx >= 0 ? parentMsgs.slice(0, forkIdx + 1) : parentMsgs;
    // Count as the user saw it on the parent: messages above the loaded window
    // plus the seeded slice. Keeps the "N older messages" indicator stable.
    const seededCount = (conversation.loaded_start_index ?? 0) + seededMsgs.length;
    addOptimisticFork({
      _id: forkSessionId,
      user_id: currentUser?._id?.toString(),
      title: forkTitle,
      started_at: now,
      username: conversation.user?.name || conversation.user?.email?.split("@")[0],
      parent_message_uuid: messageUuid,
      message_count: seededCount,
      agent_type: conversation.agent_type,
    });
    // conversations[stub] carries the fork metadata (storeMeta merge prefers it
    // over the session row); fork_status "copying" arms the message-sync freeze
    // from the first frame, before the server confirms it.
    useInboxStore.getState().syncRecord("conversations", forkSessionId, {
      _id: forkSessionId,
      session_id: forkSessionId,
      user_id: currentUser?._id?.toString() ?? "",
      title: forkTitle,
      agent_type: conversation.agent_type,
      project_path: conversation.project_path ?? undefined,
      git_root: conversation.git_root ?? undefined,
      started_at: now,
      updated_at: now,
      status: "active",
      message_count: seededCount,
      forked_from: parentId,
      parent_message_uuid: messageUuid,
      fork_status: "copying",
    });
    forkSetMessages(forkSessionId, seededMsgs, { hasMoreAbove: !!hasMoreAbove || (conversation.loaded_start_index ?? 0) > 0, initialized: true });
    // Seeds sessions[stub] and navigates in one action — instant switch.
    seedForkSession(forkSessionId, {
      session_id: forkSessionId,
      title: forkTitle,
      started_at: now,
      message_count: seededCount,
      forked_from: parentId,
      parent_message_uuid: messageUuid,
    } as any);
    // Local-first label inheritance: mirror the server's inheritLabelAssignment
    // so the fork lands in its parent's label group on the first frame instead
    // of jumping there when the server's inherited row syncs. The dispatch
    // no-ops server-side on the stub id; rekeyId carries the local row to the
    // real id, where the server row supersedes it via altKey.
    const forkStore = useInboxStore.getState();
    const parentBucketId = convBucketMap(forkStore.bucketAssignments)[parentId];
    const parentBucket = parentBucketId ? (forkStore.buckets as Record<string, BucketItem>)[parentBucketId] : undefined;
    if (parentBucket && !parentBucket.archived_at) {
      forkStore.assignSessionToBucket(forkSessionId, parentBucket._id);
    }
    const ready = convCommand(parentId, "forkFromMessage", {
      message_uuid: messageUuid,
      session_id: forkSessionId,
    }).then((result) => {
      resolveForkSessionId(forkSessionId, result.conversation_id);
      return result.conversation_id as string;
    });
    // Same contract as beginOptimisticSession: a message sent against the stub
    // resolves through awaitConvexId → pendingSessionCreates and waits here.
    useInboxStore.getState().trackSessionCreate(forkSessionId, ready);
    ready.catch((err) => {
      // Parked-unwired is "pending", not "failed": the outbox delivers the fork
      // create on the next drain (must-deliver) and the server row rekeys the
      // stub via altKey sync. Discarding here would tell the user the fork
      // failed while an agent for it spawns minutes later.
      if (err instanceof DispatchNotWiredError && err.parked) return;
      useInboxStore.getState().discardForkStub(forkSessionId, parentId);
      toast.error(err instanceof Error ? err.message : "Failed to fork");
    });
    return { forkSessionId, conversationId: forkSessionId, ready };
  }, [conversation?._id, conversation?.title, conversation?.messages, conversation?.loaded_start_index, conversation?.project_path, conversation?.git_root, conversation?.agent_type, hasMoreAbove, convCommand, forkSetMessages, addOptimisticFork, resolveForkSessionId, seedForkSession, currentUser?._id, conversation?.user]);

  const handleForkFromMessage = useCallback(async (messageUuid: string) => {
    const tl = timelineRef.current;
    const idx = tl.findIndex((item: any) => item.type === "message" && item.data?.message_uuid === messageUuid);
    if (idx !== -1) {
      const msg = tl[idx].data;
      if (msg.role === "user") {
        for (let i = idx - 1; i >= 0; i--) {
          if (tl[i].type === "message" && canAnchorForkChips(tl[i].data)) {
            await doFork(tl[i].data.message_uuid);
            if (msg.content && populateInputRef.current) {
              setTimeout(() => populateInputRef.current?.(msg.content), 100);
            }
            return;
          }
        }
      }
    }
    await doFork(messageUuid);
  }, [doFork]);

  // Gate every fork affordance on the client's fork capability: claude/codex/opencode
  // can branch into a live session carrying the copied history; cursor/gemini/pi can't,
  // so the control is HIDDEN (undefined handler) rather than shown as a false success.
  const forkHandler = agentSupportsFork(conversation?.agent_type) ? handleForkFromMessage : undefined;

  // Fork from an ARBITRARY branch — the branch map's "fork higher" drill lets you
  // pick a message in the current branch OR any ancestor/sibling. For the current
  // conversation we reuse the rich, edit-the-prompt path (handleForkFromMessage);
  // for another branch the server copies that branch's history up to the chosen
  // message and the stub fills in as the copy lands.
  const doForkFrom = useCallback(async (branchId: string, messageUuid: string) => {
    if (branchId === conversation?._id?.toString()) return doFork(messageUuid);
    const store = useInboxStore.getState();
    const src = store.sessions[branchId];
    const forkSessionId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
        });
    const now = Date.now();
    const forkTitle = src?.title ? `Fork: ${src.title}` : "Fork";
    store.syncRecord("conversations", forkSessionId, {
      _id: forkSessionId,
      session_id: forkSessionId,
      user_id: currentUser?._id?.toString() ?? "",
      title: forkTitle,
      agent_type: src?.agent_type,
      project_path: src?.project_path ?? undefined,
      git_root: src?.git_root ?? undefined,
      started_at: now,
      updated_at: now,
      status: "active",
      forked_from: branchId,
      parent_message_uuid: messageUuid,
      fork_status: "copying",
    });
    seedForkSession(forkSessionId, {
      session_id: forkSessionId,
      title: forkTitle,
      started_at: now,
      forked_from: branchId,
      parent_message_uuid: messageUuid,
      agent_type: src?.agent_type,
    } as any);
    const ready = convCommand(branchId, "forkFromMessage", { message_uuid: messageUuid, session_id: forkSessionId })
      .then((result: any) => { resolveForkSessionId(forkSessionId, result.conversation_id); return result.conversation_id as string; });
    store.trackSessionCreate(forkSessionId, ready);
    ready.catch((err: any) => {
      // Parked-unwired keeps the stub — see doFork's catch.
      if (err instanceof DispatchNotWiredError && err.parked) return;
      useInboxStore.getState().discardForkStub(forkSessionId, branchId);
      toast.error(err instanceof Error ? err.message : "Failed to fork");
    });
    return { forkSessionId, conversationId: forkSessionId, ready };
  }, [conversation?._id, doFork, currentUser?._id, seedForkSession, convCommand, resolveForkSessionId]);

  const handleForkFromBranch = useCallback((branchId: string, messageUuid: string, _content: string) => {
    if (branchId === conversation?._id?.toString()) { handleForkFromMessage(messageUuid); return; }
    doForkFrom(branchId, messageUuid);
  }, [conversation?._id, handleForkFromMessage, doForkFrom]);

  const handleForkReply = useCallback(async (content: string) => {
    if (!conversation) return;
    const msgs = conversation.messages || [];
    const lastMsg = [...msgs].reverse().find((m: any) => canAnchorForkChips(m));
    if (!lastMsg?.message_uuid) {
      toast.error("No messages to fork from");
      return;
    }
    const forkResult = await doFork(lastMsg.message_uuid);
    if (!forkResult) return;
    // Optimistic bubble lands on the stub instantly (rekeyId carries pending
    // messages to the real id); the durable send waits for the real Convex id
    // since the dispatch pipeline can't address a stub.
    const clientId = addOptimisticMsg(forkResult.conversationId, content);
    forkResult.ready
      .then((realId) => sendInlineMessage(realId, content, undefined, clientId))
      .catch(() => {}); // fork failure already surfaced by doFork
  }, [conversation, doFork, addOptimisticMsg, sendInlineMessage]);

  // Same capability gate as forkHandler: hide fork-and-send where forks can't run.
  const forkSendHandler = agentSupportsFork(conversation?.agent_type) ? handleForkReply : undefined;
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

  // Merge messages, commits, and PRs into a single timeline.
  type TimelineItem =
    | { type: 'message'; data: Message; timestamp: number }
    | { type: 'commit'; data: Commit; timestamp: number }
    | { type: 'pull_request'; data: PullRequest; timestamp: number };

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
  // Upper bound for the "New" divider — the moment you last focused this
  // session (re-stamped on every entry, including window-focus). Messages newer
  // than this arrived while you were here watching and must not be split off.
  const enteredAt = useInboxStore((s) => s._lastViewedAt[pendingConvId] ?? 0);

  const timeline: TimelineItem[] = useMemo(() => {
    const base = buildCompositeTimeline(
      messages,
      commits,
      pullRequests,
    ) as TimelineItem[];
    // Guaranteed render: append any pending messages not already in the timeline.
    // This is the ONLY merge point — the store never mixes pending into messages[].
    const seen = new Set<string>();
    const seenContent = new Set<string>();
    for (const item of base) {
      if (item.type === 'message') {
        const m = item.data as any;
        seen.add(m._id);
        if (m.client_id) seen.add(m.client_id);
        if (m.role === 'user' && m.content) seenContent.add(normalizePendingContent(m.content));
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
    if (serverPending && serverPending.status !== 'delivered' && serverPending.status !== 'cancelled') {
      const norm = normalizePendingContent(serverPending.content);
      if (norm && !seenContent.has(norm)) {
        toAdd.push({
          _id: `serverpending_${pendingConvId}`,
          role: 'user',
          content: serverPending.content,
          timestamp: serverPending.created_at,
          _isOptimistic: true,
          _serverPendingStatus: serverPending.status,
        });
      }
    }
    if (toAdd.length === 0) return base;
    return [...base, ...toAdd.map((m: any) => ({ type: 'message' as const, data: m, timestamp: m.timestamp }))];
  }, [messages, commits, pullRequests, pendingMsgs, serverPending, pendingConvId]);
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
  // The handoff anchor, drawn the same way: the "assigned to you" line sits
  // above the first row at or after the moment a teammate made you an owner.
  // A session handed over after its last message (the usual case: a finished
  // thread passed on) anchors below the final row instead. -1 = no handoff.
  const handoff = useOwnersFromStore(pendingConvId).handoff;
  const handoffAt = handoff?.added_at ?? 0;
  const handoffIndex = useMemo(() => {
    if (!handoffAt || timeline.length === 0) return -1;
    const idx = timeline.findIndex((it) => it.timestamp >= handoffAt);
    return idx === -1 ? timeline.length : idx;
  }, [timeline, handoffAt]);
  const handoffRule = handoff && handoffIndex >= 0 && (
    <TimelineRule color="var(--sol-violet)" label="Assigned to you">
      <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-sol-violet" title={formatFullTimestamp(handoffAt)}>
        {handoff.added_by_name || "A teammate"} assigned this to you · {formatRelativeTime(handoffAt)}
      </span>
    </TimelineRule>
  );


  const populateInputRef = useRef<((text: string, opts?: { append?: boolean }) => void) | null>(null);
  // Bridge for the quote/comment review UI: lets MessageReview, the selection
  // toolbar, and the review bar push text into the composer without prop-drilling.
  const reviewComposer = useMemo(() => {
    const populate = (t: string, o?: { append?: boolean }) => populateInputRef.current?.(t, o);
    return {
      quote: (text: string) => quoteToComposer(text, populate),
      submit: () => submitReview(conversation?._id ?? "", populate),
    };
  }, [conversation?._id]);
  const dropFilesRef = useRef<((files: File[]) => void) | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  // These handlers exist for IMAGE drops. A pane-shaped drag (a session card,
  // a tab, a pane strip — lib/stage) must fall through untouched so it can
  // bubble to the stage's drop layer and offer a split; swallowing every drag
  // here is what made dropping a session onto a conversation a dead gesture.
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (dragCarriesPane(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (dragCarriesPane(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (dragCarriesPane(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (dragCarriesPane(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    if (files.length > 0 && dropFilesRef.current) {
      dropFilesRef.current(files);
    } else if (files.length === 0 && e.dataTransfer.files.length > 0) {
      toast.error("Only image files are supported");
    }
  }, []);

  // Rewind/fork navigator reads the same cached list (populated by
  // useConversationMessages), gated to owners of an active session since
  // rewinding only applies there.
  const cachedUserMessages = useInboxStore(
    (s) => (conversation?._id ? s.userMessages[conversation._id] : undefined)
  );
  // Escape in an empty composer interrupts the agent. Only forward it while the
  // agent is provably mid-turn: an idle session has nothing to interrupt, and a
  // message still pending delivery is the dangerous case. On 2026-08-28 an
  // Escape pressed seconds after send reached the daemon 400ms after it had
  // injected that message and cancelled the turn the message had just started.
  const liveAgentStatus = managedSession?.agent_status as LiveAgentStatus | undefined;
  const handleSendEscape = useCallback(() => {
    if (!conversation || !effectiveIsOwner || conversation.status !== "active" || !convexConvId) return;
    if (!isActiveAgentStatus(liveAgentStatus)) return;
    void convCommand(convexConvId, "sendEscapeToSession").then(
      () => toast.info("Escape sent to session"),
      (err) => {
        if (isParkedDispatchError(err)) {
          toast.info("Escape queued — it will send when the connection recovers");
          return;
        }
        toast.error(err instanceof Error ? err.message : "Failed to send Escape");
      },
    );
  }, [conversation, effectiveIsOwner, convCommand, convexConvId, liveAgentStatus]);

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

  const userMsgKindMap = useMemo(() => {
    const map = new Map<string, UserMessageKind>();
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const msg = item.data as Message;
      if (msg.role !== 'user') continue;
      let immediatePrev: Message | null = null;
      for (let j = i - 1; j >= 0; j--) {
        if (timeline[j].type === 'message') { immediatePrev = timeline[j].data as Message; break; }
      }
      let contextPrev: Message | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const p = timeline[j];
        if (p.type !== 'message') continue;
        const pm = p.data as Message;
        if (pm.role === 'user' && pm.tool_results?.length && (!pm.content || !pm.content.trim())) continue;
        if (pm.role === 'user' && pm.content && isCommandMessage(pm.content)) continue;
        contextPrev = pm;
        break;
      }
      map.set(msg._id, classifyUserMessage(msg, conversation?.agent_type, immediatePrev, contextPrev));
    }
    return map;
  }, [timeline, conversation?.agent_type]);

  // Aggregation for the condensed/compact feeds. Built once per timeline; O(n).
  //
  // A "turn" is one assistant response. Its boundary is a REAL user prompt — NOT
  // every user-role message: in agentic transcripts assistant messages are
  // separated by user-role tool-result carriers, so resetting on those would
  // split one turn into one-per-message (the stacked-cards bug). We reset only on
  // the user-message kinds that actually start a new exchange.
  //
  // CONDENSED works at SEGMENT granularity: a contiguous run of tool activity
  // between two pieces of assistant text folds into ONE receipt rendered inline
  // where it happened. The run's tools attach to its "owner" (the text message
  // that opens the run, or the first tool-only message); the rest are "absorbed".
  // A receipt keeps one entry per source message (owner first) so an opened
  // group can render each tool under its real message identity — results,
  // comments and share selection stay attributed to the message that ran it.
  //
  // COMPACT works at TURN granularity (one collapsed card per assistant run), so
  // we also track each message's turn key, first/last message, and stats.
  const turnAggregates = useMemo(() => {
    const TURN_BOUNDARY_KINDS = new Set(['normal', 'command', 'plan', 'session_message', 'chat_wake']);
    const turnKeyOf = new Map<string, string>();      // msgId -> turn key
    const firstAssistOf = new Map<string, string>();  // turn key -> first assistant msgId
    const lastTextOf = new Map<string, string>();     // turn key -> last text-bearing msgId
    const statsOf = new Map<string, { messages: number; tools: number; preview: string }>();
    const receiptOf = new Map<string, ReceiptEntry[]>(); // owner msgId -> folded hideable tools, per source message
    const absorbed = new Set<string>();                // msgId folded into an earlier receipt
    let curKey: string | null = null;
    let ownerId: string | null = null;                 // current segment's receipt owner
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const msg = item.data as Message;
      if (msg.role === 'user') {
        // Only a genuine new prompt ends the current turn; tool-result carriers,
        // interrupts, notifications, etc. are part of the ongoing response.
        if (TURN_BOUNDARY_KINDS.has(userMsgKindMap.get(msg._id)?.kind ?? 'normal')) {
          curKey = null;
          ownerId = null;
        }
        continue;
      }
      if (msg.role !== 'assistant') continue;
      if (isHiddenStubMessage(msg)) continue;
      const hasText = !!(msg.content && stripSystemTags(msg.content).trim().length > 0);
      const tools = msg.tool_calls ?? [];
      const hasVisible = hasText || tools.length > 0 || (!!msg.images?.length);
      if (!hasVisible) continue;
      if (curKey === null) {
        curKey = msg._id;
        firstAssistOf.set(curKey, msg._id);
        statsOf.set(curKey, { messages: 0, tools: 0, preview: "" });
      }
      turnKeyOf.set(msg._id, curKey);
      const stats = statsOf.get(curKey)!;
      if (hasText) { stats.messages += 1; lastTextOf.set(curKey, msg._id); }
      stats.tools += tools.length;
      if (!stats.preview && hasText) {
        stats.preview = stripSystemTags(msg.content || "").trim().split("\n")[0].slice(0, 140);
      }
      const hideable = tools.filter(tc => !isAlwaysVisibleToolCall(tc));
      const entry: ReceiptEntry = { messageId: msg._id, messageUuid: msg.message_uuid, timestamp: msg.timestamp, tools: hideable };
      // Segment ownership: a text message opens a new segment and owns its own
      // tools; a tool-only message folds into the current owner (or becomes one).
      if (hasText) {
        ownerId = msg._id;
        receiptOf.set(msg._id, hideable.length ? [entry] : []);
      } else if (ownerId) {
        if (hideable.length) receiptOf.get(ownerId)!.push(entry);
        // A message carrying an always-visible block (poll, plan write) must
        // still render that block — fold its hideable tools into the receipt but
        // don't absorb the message itself.
        if (!tools.some(isAlwaysVisibleToolCall)) absorbed.add(msg._id);
      } else {
        ownerId = msg._id;
        receiptOf.set(msg._id, hideable.length ? [entry] : []);
      }
    }
    return { turnKeyOf, firstAssistOf, lastTextOf, statsOf, receiptOf, absorbed };
  }, [timeline, userMsgKindMap]);

  // Pair each slash-command invocation with its expansion (the body of the command's
  // .md file, emitted by Claude Code as the next user message). They render as one
  // command block, so the expansion message is suppressed. Applied only in the full
  // (non-collapsed) view; collapsed keeps its compact one-pill behavior.
  const commandExpansionMap = useMemo(() => {
    const byCommand = new Map<string, string>(); // command msg _id -> expansion content
    const consumed = new Set<string>();          // expansion msg _ids
    // Same pairing for `!` bash mode: input msg _id -> the output msg's parsed streams.
    const bashByInput = new Map<string, { stdout: string; stderr: string }>();
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const msg = item.data as Message;
      if (msg.role !== 'user') continue;
      const kind = userMsgKindMap.get(msg._id)?.kind;
      if (kind !== 'command' && kind !== 'bash_input' && kind !== 'agent_switch') continue;
      let next: Message | null = null;
      for (let j = i + 1; j < timeline.length; j++) {
        if (timeline[j].type === 'message') { next = timeline[j].data as Message; break; }
      }
      if (!next || next.role !== 'user' || !next.content) continue;
      const nextKind = userMsgKindMap.get(next._id);
      if (kind === 'command' && nextKind?.kind === 'skill_expansion') {
        byCommand.set(msg._id, next.content);
        consumed.add(next._id);
      } else if (kind === 'agent_switch' && nextKind?.kind === 'agent_switch' && isModelSwitchStdout(next.content)) {
        // /model command + "Set model to …" stdout: keep the prettier stdout divider.
        consumed.add(msg._id);
      } else if (kind === 'bash_input' && nextKind?.kind === 'bash_output') {
        bashByInput.set(msg._id, { stdout: nextKind.stdout, stderr: nextKind.stderr });
        consumed.add(next._id);
      }
    }
    return { byCommand, consumed, bashByInput };
  }, [timeline, userMsgKindMap]);

  const sessionSkills = useMemo(() => resolveSessionSkills({
    availableSkills: (currentUser as any)?.available_skills,
    projectPath: conversation?.project_path,
    agentType: conversation?.agent_type,
    messages: conversation?.messages,
  }), [currentUser, conversation?.project_path, conversation?.messages, conversation?.agent_type]);

  const sessionFilePaths = useMemo(() => {
    if (!conversation?.messages) return [];
    return extractFilePaths(conversation.messages);
  }, [conversation?.messages]);

  const mentionItemsRef = useRef<MentionItem[]>([]);
  const convTeamId = managedSession?.team_id ? String(managedSession.team_id) : null;
  // Mention items are computed lazily (on dropdown open) to avoid subscribing
  // ConversationView to s.sessions, mentionIndex, and teamMembers — those
  // change on every heartbeat and would re-render this 10K-line component.
  const buildMentionItems = useCallback(() => {
    const state = useInboxStore.getState();
    const byRecency = (a: { updatedAt?: number }, b: { updatedAt?: number }) => (b.updatedAt || 0) - (a.updatedAt || 0);
    const inScope = (rec: any): boolean => inActiveWorkspace(rec, convTeamId);
    const persons: MentionItem[] = (state.teamMembers || []).map((m: any) => ({ id: String(m._id || m.id), type: "person", label: m.name || m.github_username || "Unknown", sublabel: m.github_username ? `@${m.github_username}` : m.email, image: m.image || m.github_avatar_url }));
    const tasks: MentionItem[] = Object.values(state.mentionIndex?.tasks ?? {})
      .filter(inScope)
      .sort((a: any, b: any) => (b.updated_at || 0) - (a.updated_at || 0))
      .map((t: any) => ({ id: t._id, type: "task", label: t.title, sublabel: t.short_id, shortId: t.short_id, status: t.status, priority: t.priority, updatedAt: t.updated_at }));
    const docs: MentionItem[] = Object.values(state.mentionIndex?.docs ?? {})
      .filter((d: any) => d.doc_type !== "plan" && inScope(d))
      .sort((a: any, b: any) => (b.updated_at || 0) - (a.updated_at || 0))
      .map((d: any) => ({ id: d._id, type: "doc", label: d.title, sublabel: d.doc_type, docType: d.doc_type, updatedAt: d.updated_at }));
    const plans: MentionItem[] = Object.values(state.mentionIndex?.plans ?? {})
      .filter(inScope)
      .sort((a: any, b: any) => (b.updated_at || 0) - (a.updated_at || 0))
      .map((p: any) => ({ id: p._id, type: "plan", label: p.title, sublabel: p.short_id, shortId: p.short_id, status: p.status, goal: p.goal, updatedAt: p.updated_at }));
    const sessions: MentionItem[] = Object.values(state.sessions)
      .filter(s => !s.is_subagent && inScope(s))
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
      // shortId must be the cc id (`jx…`, the 7-char prefix of _id) — not session_id
      // (the Claude JSONL UUID), which the mention parser can't match and cast can't resolve.
      // No id rides in sublabel: the picker shows real metadata (project · msgs · time) instead.
      .map(s => ({ id: s._id, type: "session", label: s.title || "Untitled Session", sublabel: s.idle_summary?.slice(0, 80) || undefined, shortId: s._id.slice(0, 7).toLowerCase(), messageCount: s.message_count, projectPath: s.project_path, agentType: s.agent_type, updatedAt: s.updated_at, idleSummary: s.idle_summary }));
    // Labels are personal filing, not team entities — never team-filtered.
    const labels: MentionItem[] = labelMentionItems(state);
    const all = [...persons, ...labels, ...tasks, ...docs, ...plans, ...sessions];
    all.sort(byRecency);
    mentionItemsRef.current = all;
  }, [convTeamId]);
  useEffect(() => { buildMentionItems(); }, [buildMentionItems]);
  const handleMentionQuery = useCallback((_q: string) => { buildMentionItems(); }, [buildMentionItems]);

  const isWaitingForResponse = useMemo(() => {
    if (!conversation || conversation.status !== "active" || timeline.length === 0 || hasMoreBelow) return false;
    const last = timeline[timeline.length - 1];
    if (last.type !== 'message') return false;
    const msg = last.data as Message;
    if (msg.role !== 'user') return false;
    const kind = userMsgKindMap.get(msg._id);
    if (kind?.kind === 'interrupt') return false;
    return true;
  }, [conversation, timeline, hasMoreBelow, userMsgKindMap]);

  const isThinking = useMemo(() => {
    if (!conversation || conversation.status !== "active" || timeline.length === 0 || hasMoreBelow) return false;
    const last = timeline[timeline.length - 1];
    if (last.type !== 'message') return false;
    const msg = last.data as Message;
    if (msg.role !== 'assistant') return false;
    const hasThinkingContent = msg.thinking && msg.thinking.trim().length > 0;
    const hasVisibleContent = (msg.content && stripSystemTags(msg.content).trim().length > 0) || (msg.tool_calls && msg.tool_calls.length > 0);
    return !!(hasThinkingContent && !hasVisibleContent);
  }, [conversation, timeline, hasMoreBelow]);

  // Full navigable-message list from the store cache (populated once by
  // useConversationMessages). Always complete regardless of pagination window,
  // so the sticky header resolves the right prompt even deep in long threads.
  const serverUserMessages = cachedUserMessages;

  const processedServerMsgIds = useMemo(() => {
    if (!serverUserMessages) return new Set<string>();
    const ids = new Set<string>();
    for (const m of serverUserMessages) {
      if (isStickyEligible(m.content)) ids.add(m._id);
    }
    return ids;
  }, [serverUserMessages]);

  const stickyUserMsgIndices = useMemo(() => {
    const useServer = processedServerMsgIds.size > 0;
    const indices: number[] = [];
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const msg = item.data as Message;
      if (msg.role !== 'user') continue;
      if (useServer) {
        if (processedServerMsgIds.has(msg._id)) indices.push(i);
      } else {
        const kind = userMsgKindMap.get(msg._id);
        if (kind && isStickyWorthy(kind) && stickyPromptContent(msg.content) !== null) indices.push(i);
      }
    }
    return indices;
  }, [timeline, processedServerMsgIds, userMsgKindMap]);

  const serverStickyFallback = useMemo(() => {
    if (!hasMoreAbove) return null;
    const loaded: Message[] = [];
    for (const item of timeline) {
      if (item.type === 'message') loaded.push(item.data as Message);
    }
    return pickStickyFallbackFromLoaded(serverUserMessages, loaded);
  }, [serverUserMessages, timeline, hasMoreAbove]);

  const [activeStickyMsg, setActiveStickyMsgRaw] = useState<{ index: number; content: string; id: string; fromUserId?: string } | null>(null);
  const setActiveStickyMsg = useCallback((val: { index: number; content: string; id: string; fromUserId?: string } | null) => {
    setActiveStickyMsgRaw(prev => {
      if (prev === val) return prev;
      if (prev === null || val === null) return val;
      if (prev.index === val.index && prev.id === val.id && prev.content === val.content) return prev;
      return val;
    });
  }, []);

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
  useEffect(() => {
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

  // Track if we've already scrolled for this highlight query
  const hasScrolledToHighlight = useRef(false);

  // Fetch ALL matches across the whole conversation (not just loaded messages).
  // Without this, a match in a message outside the current pagination window is invisible.
  const cleanedHighlight = highlightQuery?.trim();
  const globalMatches = useQuery(
    api.messages.findAllMessagesByContent,
    convexConvId && cleanedHighlight
      ? { conversation_id: convexConvId, search_term: cleanedHighlight, ...shareTokenArg(convexConvId) }
      : "skip"
  );

  // Build match instances from the global list so the counter and next/prev
  // work across unloaded messages too.
  useWatchEffect(() => {
    if (!highlightQuery) {
      setHighlightedMessageId(null);
      setAllMatchingMessageIds(EMPTY_MATCH_IDS);
      setMatchInstances(EMPTY_MATCH_INSTANCES);
      setCurrentMatchIndex(0);
      hasScrolledToHighlight.current = false;
      return;
    }
    if (!globalMatches) return;

    const matchingIds: string[] = [];
    const instances: { messageId: string; localIndex: number; timestamp: number }[] = [];
    for (const m of globalMatches) {
      matchingIds.push(m.message_id);
      for (let i = 0; i < m.match_count; i++) {
        instances.push({ messageId: m.message_id, localIndex: i, timestamp: m.timestamp });
      }
    }

    setAllMatchingMessageIds(matchingIds);
    setMatchInstances(instances);
    if (instances.length > 0) {
      setHighlightedMessageId(instances[0].messageId);
      setCurrentMatchIndex(prev => (prev < instances.length ? prev : 0));
    } else {
      setHighlightedMessageId(null);
      setCurrentMatchIndex(0);
    }
  }, [highlightQuery, globalMatches]);

  // Ref of loaded message IDs for fast membership checks during navigation.
  const loadedIdsRef = useRef<Set<string>>(new Set());
  loadedIdsRef.current = useMemo(() => new Set(messages.map((m: Message) => m._id)), [messages]);

  const navigateToMatch = useCallback((index: number) => {
    if (matchInstances.length === 0) return;
    const target = matchInstances[index];
    setCurrentMatchIndex(index);
    setHighlightedMessageId(target.messageId);
    hasScrolledToHighlight.current = false;
    setNavTrigger(t => t + 1);
  }, [matchInstances]);

  const goToNextMatch = useCallback(() => {
    if (matchInstances.length === 0) return;
    navigateToMatch((currentMatchIndex + 1) % matchInstances.length);
  }, [matchInstances, currentMatchIndex, navigateToMatch]);

  const goToPrevMatch = useCallback(() => {
    if (matchInstances.length === 0) return;
    navigateToMatch(currentMatchIndex === 0 ? matchInstances.length - 1 : currentMatchIndex - 1);
  }, [matchInstances, currentMatchIndex, navigateToMatch]);

  // Activate the specific mark in the DOM after navigation
  // Track pending scroll target; survives until the target message renders so that
  // navigating to an unloaded match still scrolls once the jump loads the messages.
  const pendingScrollRef = useRef<{ messageId: string; localIndex: number } | null>(null);

  useWatchEffect(() => {
    void navTrigger;
    if (matchInstances.length === 0 || !containerRef.current) return;
    const instance = matchInstances[currentMatchIndex];
    if (!instance) return;
    pendingScrollRef.current = { messageId: instance.messageId, localIndex: instance.localIndex };
    const isLoaded = loadedIdsRef.current.has(instance.messageId);
    // If the target message is outside the current pagination window, trigger
    // a server jump so the activation effect can scroll to it once it loads.
    if (!isLoaded && onJumpToTimestamp) {
      onJumpToTimestamp(instance.timestamp);
    }
  }, [currentMatchIndex, matchInstances, navTrigger, onJumpToTimestamp]);

  // Activate the pending mark whenever the DOM for the target message is ready.
  // Messages are virtualized: the wrapper may render before its text/marks do.
  // Scroll the wrapper in first (triggers virtualizer to render content), then
  // retry finding marks. Runs on navigation AND when `messages` changes (post-jump).
  useWatchEffect(() => {
    const pending = pendingScrollRef.current;
    if (!pending || !containerRef.current) return;
    if (!loadedIdsRef.current.has(pending.messageId)) return;
    let scrolledWrapper = false;
    const activate = () => {
      if (!containerRef.current || !pendingScrollRef.current) return;
      const p = pendingScrollRef.current;
      containerRef.current.querySelectorAll('mark[data-search-active]').forEach(m => {
        m.removeAttribute('data-search-active');
        (m as HTMLElement).style.cssText = '';
      });
      const msgEl = containerRef.current.querySelector(`#msg-${CSS.escape(p.messageId)}`);
      if (!msgEl) return;
      const marks = Array.from(msgEl.querySelectorAll('mark[data-search-highlight]'));
      if (marks.length === 0) {
        // Virtualizer hasn't rendered the message content yet — scroll the wrapper
        // so it mounts; a later retry (50/200/500/1000ms) will find the marks.
        if (!scrolledWrapper) {
          msgEl.scrollIntoView({ block: 'center', behavior: 'auto' });
          scrolledWrapper = true;
        }
        return;
      }
      const target = marks[p.localIndex] ?? marks[0];
      if (target) {
        target.setAttribute('data-search-active', 'true');
        (target as HTMLElement).style.backgroundColor = 'rgb(245 158 11)';
        (target as HTMLElement).style.borderRadius = '2px';
        (target as HTMLElement).style.boxShadow = '0 0 0 1px rgb(245 158 11)';
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        pendingScrollRef.current = null;
      }
    };
    const t1 = setTimeout(activate, 50);
    const t2 = setTimeout(activate, 200);
    const t3 = setTimeout(activate, 500);
    const t4 = setTimeout(activate, 1000);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
  }, [navTrigger, messages, highlightedMessageId]);

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

  // Tool/task stats moved into the ConversationTaskProgress / ...MenuItem leaves so this
  // monolith no longer re-renders every time getConversationToolStats re-scans a streaming
  // conversation. (See useConversationTaskStats.)

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
    return `pr-${(item.data as any)._id}`;
  })), [timeline]);
  const getItemKey = useCallback((index: number) => rowKeys[index] ?? index, [rowKeys]);

  // Height-cache discriminator. In compact and condensed a row's height depends
  // on its disclosure state (compact: card vs full turn; condensed: the owner
  // row grows by its opened tool group), so the key must flip with that —
  // otherwise a toggled row reads a stale cached height and the virtualizer
  // mis-lays the list.
  const rowDensityKey = useCallback((index: number): string => {
    if (feedDensity === "full") return feedDensity;
    const item = timeline[index];
    if (item?.type !== "message") return feedDensity;
    const msg = item.data as Message;
    const groupKey = feedDensity === "compact" ? turnAggregates.turnKeyOf.get(msg._id) : msg._id;
    const expanded = groupKey ? expandedGroups.has(groupKey) : false;
    return `${feedDensity}:${expanded ? "e" : "c"}`;
  }, [feedDensity, timeline, turnAggregates, expandedGroups]);

  const estimateSize = useCallback((index: number) => {
    const item = timeline[index];
    if (!item) return 100;

    // A real measured height from this or a prior mount beats every heuristic
    // below — accurate estimates are what stop the measure-driven reflow cascade
    // on a switch. measureElement keeps this fresh; streaming/visible rows are
    // measured live so a stale entry only ever affects an off-screen row briefly.
    const cachedHeight = VIRT_HEIGHT_CACHE.get(virtHeightKey(getItemKey(index), rowDensityKey(index)));
    if (cachedHeight !== undefined) return cachedHeight;

    if (item.type === 'commit') return 80;

    const msg = item.data as Message;
    // Compact: a collapsed turn is one card on the first assistant message; the
    // rest of the turn is height 0 until expanded.
    if (feedDensity === "compact" && msg.role === "assistant") {
      const turnKey = turnAggregates.turnKeyOf.get(msg._id);
      if (turnKey && !expandedGroups.has(turnKey)) {
        const lastText = turnAggregates.lastTextOf.get(turnKey);
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
      switch (kind?.kind) {
        case 'command': return 120;
        case 'bash_input': return 130;
        case 'bash_output': return commandExpansionMap.consumed.has(msg._id) ? 0 : 110;
        case 'interrupt': return 30;
        case 'machine_move': return 34;
        case 'agent_switch': return commandExpansionMap.consumed.has(msg._id) ? 0 : 40;
        case 'continuation': return 30;
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
      if (!hasTextContent && toolCount > 0) return Math.min(toolCount * 30, 200);
      return 200;
    }
    return 40;
  }, [timeline, feedDensity, condensedFeed, userMsgKindMap, commandExpansionMap, getItemKey, rowDensityKey, turnAggregates, expandedGroups]);

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

  const virtualizer = useVirtualizer({
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
    anchorTo: shouldFollowStreaming(userScrolled) ? "end" : undefined,
    followOnAppend: shouldFollowStreaming(userScrolled) ? "auto" : false,
    scrollEndThreshold: 8,
  });

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
  // resize leaves scrollTop alone. Every other row keeps the default rule.
  const scrollHoldRef = useRef<{ key: string | number; until: number } | null>(null);
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const hold = scrollHoldRef.current;
    if (hold && item.key === hold.key && Date.now() < hold.until) return false;
    // The library default, restated (getScrollOffset/scrollAdjustments are not on the public type).
    const v = instance as unknown as { getScrollOffset: () => number; scrollAdjustments: number };
    return item.start < v.getScrollOffset() + (v.scrollAdjustments ?? 0) && instance.scrollDirection !== "backward";
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
      let corrected = false;
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
          virtualizer.resizeItem(v.index, real);
          corrected = true;
        }
      }
      // A correction while the reader sits at the tail must keep them there
      // (same contract as followOnAppend) — without this, healing the sizes
      // under a bottom-pinned view leaves the last message's tail cut off.
      if (corrected && nearBottom && !userScrolledRef.current) virtualizer.scrollToEnd({ behavior: "auto" });
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
      sc.dispatchEvent(new Event('scroll', { bubbles: true }));
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
    const regions = Array.from(document.querySelectorAll<HTMLElement>('.cc-msg-review'));
    const center = window.innerHeight / 2;
    let best: { id: string; dist: number } | null = null;
    for (const region of regions) {
      const id = (region.closest('[id^="msg-"]') as HTMLElement | null)?.id?.slice(4);
      if (!id) continue;
      const rect = region.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const dist = Math.abs(rect.top + rect.height / 2 - center);
      if (!best || dist < best.dist) best = { id, dist };
    }
    if (best) useInboxStore.getState().setReviewTarget(best.id, 0);
  }, [conversation]));

  useShortcutAction('conv.toggleDiff', useCallback(() => {
    if (!conversation?.git_branch) return;
    setDiffExpanded((s) => !s);
  }, [conversation?.git_branch]));

  useShortcutAction('conv.toggleThinking', useCallback(() => {
    if (!hasAnyThinking) return;
    setShowThinking((s) => !s);
  }, [hasAnyThinking]));

  useMountEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeaderHeight(el.offsetHeight));
    setHeaderHeight(el.offsetHeight);
    ro.observe(el);
    return () => ro.disconnect();
  });

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
      if (scrollTop <= headerHeight + 40) {
        prevStickyMsgIdRef.current = null;
        prevStickyIdxRef.current = null;
        stickyGapRef.current = null;
        setActiveStickyMsg(null);
        setStickyMsgVisible(false);
        return;
      }
      if (stickyDisabled && localStorage.getItem('__STICKY_FORCE') !== '1') {
        setActiveStickyMsg(null);
        setStickyMsgVisible(false);
        return;
      }
      const virtualItems = virtualizer.getVirtualItems();
      let bestIdx: number | null = null;
      let bestArrayIdx: number | null = null;
      for (let i = stickyUserMsgIndices.length - 1; i >= 0; i--) {
        const tlIdx = stickyUserMsgIndices[i];
        const item = timeline[tlIdx];
        if (item?.type === 'message') {
          const msgId = (item.data as Message)._id;
          if (dismissedStickyIdsRef.current.has(msgId)) continue;
        }
        const vItem = virtualItems.find(v => v.index === tlIdx);
        if (vItem) {
          const domEl = el.querySelector(`[data-index="${tlIdx}"]`);
          if (!domEl) continue;
          const msgBottom = domEl.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
          if (msgBottom <= 0) {
            bestIdx = tlIdx;
            bestArrayIdx = i;
            break;
          }
        } else {
          if (tlIdx < (virtualItems[0]?.index ?? 0) && scrollTop > el.clientHeight) {
            bestIdx = tlIdx;
            bestArrayIdx = i;
            break;
          }
        }
      }
      if ((window as any).__STICKY_DEBUG) { (((window as any).__STICKY_LOG) ??= []).push({ scrollTop, headerHeight, stickyDisabled, idxCount: stickyUserMsgIndices.length, bestIdx, serverFb: serverStickyFallback?.id ?? null, fb: !!fallbackStickyContent, clientHeight: el.clientHeight, hasMoreAbove: paginationPropsRef.current.hasMoreAbove, svrLen: (serverUserMessages?.length ?? -1) }); }
      if (bestIdx !== null) {
        let hideForNextMsg = false;
        const stickyBottom = headerHeight + (stickyElRef.current?.offsetHeight ?? 0);
        if (bestArrayIdx !== null) {
          const nextArrayIdx = bestArrayIdx + 1;
          if (nextArrayIdx < stickyUserMsgIndices.length) {
            const nextTlIdx = stickyUserMsgIndices[nextArrayIdx];
            const nextVItem = virtualItems.find(v => v.index === nextTlIdx);
            if (nextVItem) {
              const nextMsgTop = nextVItem.start - scrollTop;
              if (nextMsgTop < stickyBottom) {
                hideForNextMsg = true;
              }
            }
          }
        }
        const item = timeline[bestIdx];
        const msg = item.data as Message;
        const msgId = msg._id;
        const prevId = prevStickyMsgIdRef.current;
        if (msgId !== prevId) {
          if (prevId !== null && prevId !== '__fallback__' && prevStickyIdxRef.current !== null) {
            stickyGapRef.current = { prevIdx: prevStickyIdxRef.current };
          }
          prevStickyMsgIdRef.current = msgId;
          prevStickyIdxRef.current = bestIdx;
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
        setActiveStickyMsg({ index: bestIdx, content: msg.content!, id: msgId, fromUserId: msg.from_user_id });
        setStickyMsgVisible(!inGap && !hideForNextMsg);
      } else if (serverStickyFallback && scrollTop > headerHeight + 40) {
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
  }, [stickyUserMsgIndices, virtualizer, timeline, fallbackStickyContent, serverStickyFallback, headerHeight, stickyDisabled]);

  const scrollToMessageById = useCallback((messageId: string) => {
    const itemIndex = timeline.findIndex(item =>
      item.type === 'message' && item.data._id === messageId
    );

    if (itemIndex >= 0) {
      setUserScrolled(true);
      virtualizer.scrollToIndex(itemIndex, { align: "center", behavior: "smooth" });
      setHighlightedMessageId(messageId);
      setTimeout(() => setHighlightedMessageId(null), 2000);
    } else if (conversation?._id) {
      useInboxStore.getState().requestNavigate(conversation._id, { scrollToMessageId: messageId });
    }
  }, [timeline, virtualizer, conversation?._id]);

  useImperativeHandle(ref, () => ({
    scrollToMessage: scrollToMessageById,
  }), [scrollToMessageById]);

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
    // Frozen while a jump is pending: the progress bar must not move until the
    // single post-load scroll lands (the completion effect sets it explicitly).
    if (!scrollProgressRef.current || jumpPendingRef.current) return;
    const totalMessages = conversation?.message_count || messages.length;
    const isPaginated = totalMessages > 150;
    let progress: number;
    if (isPaginated) {
      const items = virtualizer.getVirtualItems();
      if (items.length === 0) return;
      const centerIdx = items[Math.floor(items.length / 2)].index;
      const loadedMessages = messages.length;
      const startOffset = conversation?.loaded_start_index ?? 0;
      const tLen = Math.max(timeline.length, 1);
      progress = totalMessages > 0 ? Math.max(0, Math.min(1, (startOffset + (centerIdx / tLen) * loadedMessages) / totalMessages)) : 1;
    } else {
      const scrollEl = containerRef.current;
      if (!scrollEl) return;
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      progress = maxScroll > 0 ? scrollEl.scrollTop / maxScroll : 1;
    }
    scrollProgressRef.current.style.height = `${progress * 100}%`;
    setNavScrollProgress(progress);
  }, [conversation?.message_count, messages.length, timeline.length, conversation?.loaded_start_index, totalSize]);

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

  // Initial scroll: snap to bottom using virtualizer (not raw scrollHeight which desyncs with estimates)
  useLayoutEffect(() => {
    if (timeline.length === 0 || initialScrollDone) return;
    if (window.location.hash || highlightQuery) {
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
  }, [timeline.length, highlightQuery, initialScrollDone, virtualizer]);

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

  // Scroll to highlighted message from search
  useWatchEffect(() => {
    if (highlightedMessageId && timeline.length > 0 && !hasScrolledToHighlight.current) {
      const itemIndex = timeline.findIndex(item => {
        if (item.type === 'message') {
          return item.data._id === highlightedMessageId;
        }
        return false;
      });
      if (itemIndex >= 0) {
        hasScrolledToHighlight.current = true;
        setUserScrolled(true);
        // react-virtual's scrollToIndex assigns scrollTop but relies on the
        // scroll event to recompute its visible range. Programmatic scrollTop
        // writes don't always emit that event reliably (same-value writes,
        // batching), so we nudge the range ourselves. Retries handle the case
        // where item-size estimates for unmeasured items above shift the
        // target offset — once those items render and measure, the next
        // scrollToIndex corrects onto the real position.
        const align = { align: "center" as const, behavior: "auto" as const };
        const retry = () => {
          virtualizer.scrollToIndex(itemIndex, align);
          containerRef.current?.dispatchEvent(new Event('scroll', { bubbles: true }));
        };
        setTimeout(retry, 150);
        setTimeout(retry, 300);
        setTimeout(retry, 500);
        setTimeout(retry, 900);
      }
    }
  }, [highlightedMessageId, timeline, virtualizer]);

  useWatchEffect(() => {
    if (!targetMessageId || timeline.length === 0 || hasScrolledToTarget.current) {
      return;
    }

    const itemIndex = timeline.findIndex(item => {
      if (item.type === 'message') {
        return item.data._id === targetMessageId;
      }
      return false;
    });

    if (itemIndex >= 0) {
      hasScrolledToTarget.current = true;
      setUserScrolled(true);
      const container = containerRef.current;
      if (!container) return;

      const targetItem = timeline[itemIndex];
      settleTimelineItemAtOffset(container, virtualizer, itemIndex, 50, {
        // A same-session jump starts on the tail timeline and the target-mode
        // window then replaces it — identity + re-resolution keep the settle
        // on the target row across that swap.
        itemKey: targetItem?.type === "message" ? messageRowKey(targetItem.data as Message) : undefined,
        resolveIndex: () =>
          timelineRef.current.findIndex(
            (item: any) => item.type === "message" && item.data._id === targetMessageId,
          ),
        onSettled: () => {
          setHighlightedMessageId(targetMessageId);
          setTimeout(() => setHighlightedMessageId(null), 3000);
          if (window.location.hash) {
            history.replaceState(null, "", window.location.pathname + window.location.search);
          }
        },
      });
    }
  }, [targetMessageId, targetNonce, timeline, virtualizer]);

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
  const lastActivityAt = latestMessageTimestamp ?? conversation?.updated_at ?? conversation?.started_at ?? 0;
  const lastMessageRole = useMemo(() => {
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item.type === 'message' && (item.data as Message).role !== 'system') {
        return (item.data as Message).role;
      }
    }
    return undefined;
  }, [timeline]);
  // The tool currently in flight, surfaced in the "working" status line — e.g. a
  // multi-minute deploy reads as "Working · 3:14 · Bash". See deriveRunningTool.
  const workingTool = useMemo(() => deriveRunningTool(timeline), [timeline]);
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

  useWatchEffect(() => {
    // A detached tab window's OS title is owned by DashboardLayout
    // (useDetachedWindowTitle) — writing here would clobber its surface prefix.
    if (isDetachedTabWindow()) return;
    if (conversation) {
      document.title = `codecast | ${truncatedTitle}`;
    }
    return () => {
      document.title = "codecast";
    };
  }, [truncatedTitle, conversation]);

  const toolCallMap = useMemo(() => {
    const map: Record<string, string> = {};
    const sources = [conversation?.messages].filter(Boolean) as Message[][];
    for (const msgs of sources) {
      for (const msg of msgs) {
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            map[tc.id] = tc.name;
          }
        }
      }
    }
    return map;
  }, [conversation?.messages]);

  const globalToolResultMap = useMemo(() => {
    const map: Record<string, ToolResult> = {};
    const sources = [conversation?.messages].filter(Boolean) as Message[][];
    for (const msgs of sources) {
      for (const msg of msgs) {
        if (msg.tool_results) {
          for (const tr of msg.tool_results) {
            map[tr.tool_use_id] = tr;
          }
        }
      }
    }
    return map;
  }, [conversation?.messages]);

  // Tool images live on the tool_result message, not the assistant message
  // that made the call, so the ToolBlock finds them by tool id here. A list,
  // not a single image: one command can hand back several (`cast browser
  // shot --viewports`), and keeping only the last would silently drop the rest.
  const globalImageMap = useMemo(() => {
    const map: Record<string, ImageData[]> = {};
    const sources = [conversation?.messages].filter(Boolean) as Message[][];
    for (const msgs of sources) {
      for (const msg of msgs) {
        if (msg.images) {
          for (const img of msg.images) {
            if (img.tool_use_id) {
              (map[img.tool_use_id] ??= []).push(img);
            }
          }
        }
      }
    }
    return map;
  }, [conversation?.messages]);

  // toolCallId → page URL + tab id for every `cast browser` row, carrying the
  // last known ones across rows whose output doesn't restate them. Identity is
  // kept stable across recomputes with identical content (the common case: a
  // message sync that added no browser rows), so the CastBrowserRowContext
  // consumers — every cast row — don't re-render on unrelated syncs.
  // Where relative file mentions in this conversation resolve (FilePathLink):
  // the session's working directory, and the home it implies for `~/…`.
  const filePathBase = conversation?.project_path || conversation?.git_root || undefined;
  const filePathCtx = useMemo(() => ({ base: filePathBase, home: inferHomeDir([filePathBase]) }), [filePathBase]);
  const browserRowMapRef = useRef<Record<string, BrowserRowState>>({});
  const browserRowMap = useMemo(() => {
    const rows: BrowserRowInput[] = [];
    for (const msg of conversation?.messages ?? []) {
      for (const tc of msg.tool_calls ?? []) {
        const cast = parseCastCommand(tc);
        if (!cast || normalizeCastCategory(cast.category) !== "browser") continue;
        const result = msg.tool_results?.find((tr) => tr.tool_use_id === tc.id) || globalToolResultMap[tc.id];
        rows.push({ toolCallId: tc.id, subcommand: cast.subcommand, args: cast.args, output: result?.content || "" });
      }
    }
    const next = buildBrowserRowMap(rows);
    if (!sameBrowserRowMap(browserRowMapRef.current, next)) browserRowMapRef.current = next;
    return browserRowMapRef.current;
  }, [conversation?.messages, globalToolResultMap]);

  const chatWakeMapRef = useRef<Record<string, ChatWakePrompt>>({});
  const chatWakeMap = useMemo(() => {
    const next: Record<string, ChatWakePrompt> = {};
    for (const kind of userMsgKindMap.values()) {
      if (kind.kind === 'chat_wake' && kind.wake.placeholderId) next[kind.wake.placeholderId] = kind.wake;
    }
    const prev = chatWakeMapRef.current;
    const prevKeys = Object.keys(prev);
    const same = prevKeys.length === Object.keys(next).length && prevKeys.every((k) => k in next);
    if (!same) chatWakeMapRef.current = next;
    return chatWakeMapRef.current;
  }, [userMsgKindMap]);

  // Every image in the session, in transcript order — the header gallery's
  // source list (attachments, tool screenshots, trusted markdown images).
  //
  // The server list is the whole thread, materialized at ingest and independent
  // of how many message pages are loaded; scanning the window alone counted the
  // tail only, so a long session showed a fraction of its images. The window
  // extraction still runs and merges in: it covers inline base64 images (never
  // materialized) and any history the one-time sweep hasn't reached yet.
  const { data: serverSessionImages } = useQueryNoThrow(
    api.messages.getConversationImages,
    deferredQueriesEnabled && conversation?._id && isConvexId(conversation._id)
      ? { conversation_id: conversation._id as Id<"conversations">, ...shareTokenArg(conversation._id) }
      : "skip"
  );
  const windowImageEntries = useMemo(
    () => extractSessionImages(conversation?.messages ?? [], (src) => !isRemoteImageSrc(src)),
    [conversation?.messages]
  );
  const sessionImageEntries = useMemo(
    () => mergeSessionImages(serverSessionImages ?? [], windowImageEntries),
    [serverSessionImages, windowImageEntries]
  );
  const sessionImageStorageIds = useMemo(
    () => sessionImageEntries.map((e) => e.storage_id),
    [sessionImageEntries]
  );
  const sessionImageUrls = useStorageImageUrls(sessionImageStorageIds);
  const sessionGallerySrcs = useMemo(() => {
    const srcs: string[] = [];
    for (const e of sessionImageEntries) {
      const src = e.src ?? (e.storage_id ? sessionImageUrls[e.storage_id] : undefined);
      if (src) srcs.push(src);
    }
    return srcs;
    // sessionImageUrls is rebuilt per render; its content only grows as the
    // batched resolution fills in, so keying on its size is exact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionImageEntries, Object.keys(sessionImageUrls).length]);

  // Older sessions predate the image_preview_url denormalization (the inbox
  // row thumbnail): when the loaded transcript visibly has images but the row
  // doesn't know it, ask the server to recompute — server-side, idempotent,
  // owner-only, once per opened conversation.
  const backfillImagePreview = useMutation(api.conversations.backfillImagePreview);
  const imagePreviewBackfilledRef = useRef<string | null>(null);
  useEffect(() => {
    const cid = conversation?._id?.toString();
    if (!cid || !isConvexId(cid) || sessionImageEntries.length === 0) return;
    if (conversation?.is_own === false) return;
    if (useInboxStore.getState().sessions[cid]?.image_preview_url) return;
    if (imagePreviewBackfilledRef.current === cid) return;
    imagePreviewBackfilledRef.current = cid;
    backfillImagePreview({ conversation_id: cid as Id<"conversations"> }).catch(() => {});
  }, [conversation?._id, conversation?.is_own, sessionImageEntries.length, backfillImagePreview]);

  // Sessions whose images predate conversation_images have nothing to read back,
  // so ask the server to sweep the history once per opened conversation. The
  // server owns the decision — it stamps images_backfilled_at and no-ops on
  // every later call — so this only has to fire when the thread PLAUSIBLY has
  // images the sweep hasn't seen.
  //
  // The evidence is the row's own image_preview_url, not the loaded window. A
  // long thread keeps its images in the history, not the last 200 messages, so
  // "the window shows an image the server list lacks" never fires on exactly
  // the sessions that need the sweep most (verified: a 2354-message thread with
  // images, zero of them in its window). image_preview_url is stamped whenever
  // any image lands and is never cleared, so it means "this session has images".
  // The window check stays as a second trigger for rows that predate it.
  const backfillConversationImages = useMutation(api.messages.backfillConversationImages);
  const imagesBackfilledRef = useRef<string | null>(null);
  useEffect(() => {
    const cid = conversation?._id?.toString();
    if (!cid || !isConvexId(cid) || !serverSessionImages || conversation?.is_own === false) return;
    if (imagesBackfilledRef.current === cid) return;
    const known = new Set(serverSessionImages.map((e: SessionImageEntry) => e.key));
    // data: entries are never materialized — comparing them would re-trigger forever.
    const windowHasUnknown = windowImageEntries.some(
      (e) => !e.src?.startsWith("data:") && !known.has(e.key)
    );
    const rowHasImages = !!useInboxStore.getState().sessions[cid]?.image_preview_url;
    if (!windowHasUnknown && !rowHasImages) return;
    imagesBackfilledRef.current = cid;
    backfillConversationImages({ conversation_id: cid as Id<"conversations"> }).catch(() => {});
  }, [conversation?._id, conversation?.is_own, serverSessionImages, windowImageEntries, backfillConversationImages]);

  const taskSubjectMap = useMemo(() => {
    const createInputs: Record<string, string> = {};
    const idMap: Record<string, string> = {};
    if (conversation?.messages) {
      for (const msg of conversation.messages) {
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.name === "TaskCreate") {
              try {
                const inp = JSON.parse(tc.input);
                if (inp.subject) createInputs[tc.id] = String(inp.subject);
              } catch {}
            }
          }
        }
        if (msg.tool_results) {
          for (const tr of msg.tool_results) {
            if (createInputs[tr.tool_use_id]) {
              const m = tr.content.match(/Task #(\d+)/);
              if (m) idMap[m[1]] = createInputs[tr.tool_use_id];
            }
          }
        }
      }
    }
    return idMap;
  }, [conversation?.messages]);

  const conversationTasks = useQuery(
    api.tasks.webListByConversation,
    deferredQueriesEnabled && conversation?._id && isConvexId(conversation._id) ? { conversationId: conversation._id } : "skip"
  );

  const taskRecordMap = useMemo(() => {
    const byTitle: Record<string, TaskRecord> = {};
    const byLocalId: Record<string, TaskRecord> = {};
    if (conversationTasks) {
      for (const t of conversationTasks) {
        byTitle[t.title] = t;
      }
    }
    if (taskSubjectMap) {
      for (const [localId, title] of Object.entries(taskSubjectMap)) {
        if (byTitle[title]) byLocalId[localId] = byTitle[title];
      }
    }
    return { byTitle, byLocalId };
  }, [conversationTasks, taskSubjectMap]);

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
  const assistantRowCacheRef = useRef(new WeakMap<Message, { timeline: TimelineItem[]; showThinking: boolean; isFirstInSequence: boolean; runMessageIds: string[] }>());
  const assistantRowDerived = (msg: Message, index: number) => {
    const cache = assistantRowCacheRef.current;
    const hit = cache.get(msg);
    if (hit && hit.timeline === timeline && hit.showThinking === showThinking) return hit;
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
    const isFirstInSequence = !prevMsg || prevMsg.role !== "assistant";
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
    const entry = { timeline, showThinking, isFirstInSequence, runMessageIds };
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

    const msg = item.data as Message;
    if (msg.role === "system") {
      return <SystemBlock key={msg._id} content={msg.content || ""} subtype={msg.subtype} timestamp={msg.timestamp} messageUuid={msg.message_uuid} messageId={msg._id} conversationId={conversation?._id} onStartShareSelection={handleStartShareSelection} />;
    }

    if (msg.role === "user") {
      const kind = userMsgKindMap.get(msg._id) ?? { kind: 'normal' as const };
      switch (kind.kind) {
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
          return <MachineMoveDivider key={msg._id} content={msg.content || ""} destination={kind.destination} machineChanged={kind.machineChanged} timestamp={msg.timestamp} />;
        case 'agent_switch':
          if (commandExpansionMap.consumed.has(msg._id)) return null;
          return <AgentSwitchDivider key={msg._id} toLabel={kind.toLabel} fromLabel={kind.fromLabel} content={msg.content || ""} timestamp={msg.timestamp} />;
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
          return <SessionMessageBlock key={msg._id} from={kind.from} name={kind.name} body={kind.body} timestamp={msg.timestamp} pendingStatus={(msg as any)._serverPendingStatus} recipientActive={conversation?.status === "active"} />;
        case 'huddle_summary':
          return <HuddleSummaryBlock key={msg._id} huddle={kind.huddle} timestamp={msg.timestamp} />;
        case 'chat_wake':
          return <ChatWakeBlock key={msg._id} wake={kind.wake} timestamp={msg.timestamp} />;
        case 'task_prompt':
          return null;
        case 'compaction_summary':
          return <CompactionSummaryBlock key={msg._id} content={msg.content!} />;
        case 'plan':
          return <PlanBlock key={msg._id} content={kind.planContent} timestamp={msg.timestamp} collapsed={false} messageId={msg._id} conversationId={conversation?._id} onStartShareSelection={handleStartShareSelection} />;
        case 'teammate_events':
          return <TeammateEventsBlock key={msg._id} content={msg.content || ""} timestamp={msg.timestamp} spawnedByConversationId={(conversation as any)?.spawned_by_conversation_id} />;
        case 'decision_answer':
        case 'normal': {
          if (!msg.content?.trim() && !msg.images?.some(img => !img.tool_use_id)) return null;
          const msgSender = resolveMsgSender(msg);
          const userName = msgSender?.name || conversation?.user?.name || conversation?.user?.email?.split("@")[0];
          // A decision answer is a normal user bubble whose body is the chosen
          // option; the footer carries the question and the way back to the ask.
          const decision = kind.kind === 'decision_answer' ? kind.decision : undefined;
          return <UserPrompt key={msg._id} content={decision ? decision.answer : (msg.content || "")} decision={decision} images={msg.images} timestamp={msg.timestamp} messageId={msg._id} messageUuid={msg.message_uuid} conversationId={conversation?._id} collapsed={false} userName={userName} avatarUrl={msgSender ? msgSender.avatar_url : conversation?.user?.avatar_url} isHighlighted={highlightedMessageId === msg._id} shareSelectionMode={shareSelectionMode} isSelectedForShare={selectedMessageIds.has(msg._id)} onToggleShareSelection={handleToggleMessageSelection} onStartShareSelection={handleStartShareSelection} onForkFromMessage={forkHandler} forkChildren={msg.message_uuid ? forkPointMap[msg.message_uuid] : undefined} onBranchSwitch={handleBranchSwitch} activeBranchId={activeBranchId} loadingBranchId={loadingBranchId} isPending={!!msg._isOptimistic} isQueued={!!msg._isQueued} agentStatus={isSessionDisconnected || conversation?.status !== "active" ? undefined : (managedSession?.agent_status as LiveAgentStatus | undefined)} mainMessageCount={msg.message_uuid ? conversation?.main_message_counts_by_fork?.[msg.message_uuid] : undefined} mainDivergentPreview={msg.message_uuid ? conversation?.main_divergent_previews_by_fork?.[msg.message_uuid] : undefined} />;
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
      if (feedDensity === "compact" && turnKey && !turnExpanded) {
        const lastText = turnAggregates.lastTextOf.get(turnKey);
        if (lastText) {
          if (msg._id !== lastText) return null;
          return <CompactCollapsedTurn key={msg._id} content={msg.content || ""} onExpand={() => toggleGroup(turnKey)} />;
        }
        if (turnAggregates.firstAssistOf.get(turnKey) !== msg._id) return null;
        const stats = turnAggregates.statsOf.get(turnKey);
        return (
          <CompactTurnCard
            key={msg._id}
            preview={stats?.preview || ""}
            messageCount={stats?.messages || 0}
            toolCount={stats?.tools || 0}
            onExpand={() => toggleGroup(turnKey)}
          />
        );
      }
      // Condensed: a tool-only message folded into an earlier segment's receipt
      // never renders on its own — its tools show inside the owner's group.
      if (feedDensity === "condensed" && turnAggregates.absorbed.has(msg._id)) return null;
      // An expanded compact turn renders at full density (nothing clipped); the
      // collapse control sits on its first message.
      const effectiveDensity: MessageFeedDensity = feedDensity === "compact" ? "full" : feedDensity;
      const isTurnFirst = turnKey ? turnAggregates.firstAssistOf.get(turnKey) === msg._id : false;
      // Condensed: this message's segment tools fold into one receipt rendered
      // inline right after its text — where the activity happened. Opening it
      // reveals the group under the chip, inside this same row.
      const receiptEntries = feedDensity === "condensed" ? (turnAggregates.receiptOf.get(msg._id) ?? EMPTY_RECEIPT_ENTRIES) : EMPTY_RECEIPT_ENTRIES;
      const condensedReceipt = condensedReceiptFor(msg, receiptEntries, expandedGroups.has(msg._id));
      const onCollapseTurn = feedDensity === "compact" && turnKey && isTurnFirst ? collapseTurnHandlerFor(msg, turnKey) : undefined;

      const relevantToolResults = relevantToolResultsFor(msg);

      return (
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
          agentType={conversation?.agent_type}
          taskSubjectMap={taskSubjectMap}
          taskRecordMap={taskRecordMap}
          onForkFromMessage={forkHandler}
          forkChildren={msg.message_uuid ? forkPointMap[msg.message_uuid] : undefined}
          onBranchSwitch={handleBranchSwitch}
          activeBranchId={activeBranchId}
          loadingBranchId={loadingBranchId}
          mainMessageCount={msg.message_uuid ? conversation?.main_message_counts_by_fork?.[msg.message_uuid] : undefined}
          mainDivergentPreview={msg.message_uuid ? conversation?.main_divergent_previews_by_fork?.[msg.message_uuid] : undefined}
          model={msg.model ?? conversation?.model}
          onSendInlineMessage={handleSendInlineMessage}
          isConversationActive={conversation?.status === "active"}
          globalImageMap={globalImageMap}
        />
      );
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

  return (
    <HighlightContext.Provider value={highlightQuery}>
    <FilePathContext.Provider value={filePathCtx}>
    <CastBrowserRowContext.Provider value={browserRowMap}>
    <ChatWakeContext.Provider value={chatWakeMap}>
    <ImageGalleryProvider>
    <ReviewComposerContext.Provider value={reviewComposer}>
    <main className="relative flex flex-col bg-sol-bg h-full overflow-x-clip" onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-sol-bg/80 backdrop-blur-sm" style={{ animation: "fadeIn 150ms ease-out" }}>
          <div className="border-2 border-dashed border-sol-cyan rounded-xl p-12 text-center">
            <svg className="w-10 h-10 mx-auto mb-3 text-sol-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
            <p className="text-sol-cyan text-sm font-medium">Drop images to attach</p>
          </div>
        </div>
      )}
      <header ref={headerRef} data-sv-convhead className={`cq-container shrink-0 relative ${embedded ? "sticky top-0 z-20 bg-sol-bg-alt" : ""} ${!embedded ? deskClass : ""} ${isImageLightboxActive ? "invisible" : ""} ${hideHeader ? "hidden" : ""}`}>
        <div>
          <div ref={titlebarHeadRef} className="cc-panel__head cc-panel__head--flow gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0 overflow-hidden flex-1">
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

            {isSessionDisconnected && (managedSession?.agent_status === "starting" || managedSession?.agent_status === "resuming" || managedSession?.agent_status === "connected") ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] flex-shrink-0 bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30">
                <span className="w-1.5 h-1.5 rounded-full bg-sol-cyan animate-pulse" />
                <span className="hidden sm:inline">{managedSession?.agent_status === "starting" ? "Starting" : managedSession?.agent_status === "resuming" ? "Resuming" : "Delivering"}</span>
                <span className="sm:hidden">{managedSession?.agent_status === "starting" ? "Start" : managedSession?.agent_status === "resuming" ? "Rsum" : "Dlvr"}</span>
              </span>
            ) : isSessionDisconnected ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] flex-shrink-0 bg-sol-text-dim/5 text-sol-text-dim/50 border border-sol-text-dim/10">
                <span className="w-1.5 h-1.5 rounded-full bg-sol-text-dim/30" />
                <span className="hidden sm:inline">Disconnected</span>
                <span className="sm:hidden">Disc</span>
              </span>
            ) : null}

            {!isSessionDisconnected && (managedSession?.agent_status === "working" || managedSession?.agent_status === "thinking" || managedSession?.agent_status === "compacting" || managedSession?.agent_status === "waiting" || managedSession?.agent_status === "permission_blocked" || managedSession?.agent_status === "connected" || managedSession?.agent_status === "starting" || managedSession?.agent_status === "resuming" || (!managedSession?.agent_status && isConversationLive)) && (
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] flex-shrink-0 ${
                managedSession?.agent_status === "thinking" ? "bg-sol-violet/10 text-sol-violet border border-sol-violet/30" :
                managedSession?.agent_status === "compacting" ? "bg-amber-500/10 text-amber-400 border border-amber-500/30" :
                managedSession?.agent_status === "waiting" ? "bg-sol-blue/10 text-sol-blue border border-sol-blue/30" :
                managedSession?.agent_status === "permission_blocked" ? "bg-sol-orange/10 text-sol-orange border border-sol-orange/30" :
                managedSession?.agent_status === "connected" || managedSession?.agent_status === "starting" || managedSession?.agent_status === "resuming" ? "bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30" :
                "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                  managedSession?.agent_status === "thinking" ? "bg-sol-violet" :
                  managedSession?.agent_status === "compacting" ? "bg-amber-400" :
                  managedSession?.agent_status === "waiting" ? "bg-sol-blue" :
                  managedSession?.agent_status === "permission_blocked" ? "bg-sol-orange" :
                  managedSession?.agent_status === "connected" || managedSession?.agent_status === "starting" || managedSession?.agent_status === "resuming" ? "bg-sol-cyan" :
                  "bg-emerald-400"
                }`} />
                <span className="hidden sm:inline">{managedSession?.agent_status === "thinking" ? "Thinking" :
                 managedSession?.agent_status === "compacting" ? "Compacting" :
                 managedSession?.agent_status === "waiting" ? "Waiting" :
                 managedSession?.agent_status === "permission_blocked" ? "Needs Input" :
                 managedSession?.agent_status === "starting" ? "Starting" :
                 managedSession?.agent_status === "resuming" ? "Resuming" :
                 managedSession?.agent_status === "connected" ? "Connected" :
                 "Working"}</span>
                <span className="sm:hidden">{managedSession?.agent_status === "thinking" ? "Think" :
                 managedSession?.agent_status === "compacting" ? "Compact" :
                 managedSession?.agent_status === "waiting" ? "Wait" :
                 managedSession?.agent_status === "permission_blocked" ? "Input" :
                 managedSession?.agent_status === "starting" ? "Start" :
                 managedSession?.agent_status === "resuming" ? "Rsum" :
                 managedSession?.agent_status === "connected" ? "Conn" :
                 "Work"}</span>
              </span>
            )}

            {conversation && (
              // Simple view keeps the metadata cluster functional (it owns the
              // model picker) but pulls it back visually; the plan/task badges
              // drop away entirely.
              <span data-simple-dim className="cq-header-collapse contents [.simple-view_&]:flex [.simple-view_&]:items-center [.simple-view_&]:gap-1">
                <ConversationMetadata
                  agentType={conversation.agent_type}
                  model={conversation.model}
                  effort={(conversation as any).effort}
                  startedAt={conversation.started_at}
                  messageCount={conversation.message_count}
                  shortId={conversation.short_id}
                  conversationId={conversation._id}
                  canEditModel={effectiveIsOwner}
                />
              </span>
            )}

            {(conversation as any)?.active_plan && (
              <span data-simple-hide className="cq-header-collapse contents">
                <PlanBadge plan={(conversation as any).active_plan} />
              </span>
            )}
            {(conversation as any)?.active_task && (
              <span data-simple-hide className="cq-header-collapse contents">
                <TaskBadge task={(conversation as any).active_task} />
              </span>
            )}
            {/* A workflow run in flight inside this session. The launch card
                sits wherever the run was armed — often far above the tail —
                so the header carries the standing signal, linking to the run's
                live view. Server truth via the conversation's stamped run. */}
            {(conversation as any)?.is_workflow_primary && (conversation as any)?.workflow_run_id &&
              ["pending", "running", "paused"].includes((conversation as any)?.workflow_run_status) && (
              <span data-simple-hide className="cq-header-collapse contents">
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

            {conversation && (
              <TooltipProvider delayDuration={300}>
              <div className="flex items-center gap-1 flex-shrink-0 overflow-hidden ml-auto">

                {(() => {
                  // Subagents carry parent_conversation_id; visible children
                  // (agent-team teammates, spawns) carry spawned_by_conversation_id.
                  // Same chip, same click-through.
                  const parentLinkId = conversation.parent_conversation_id
                    || (conversation as any).spawned_by_conversation_id;
                  if (!parentLinkId) return null;
                  return (
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
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/20 transition-colors"
                    title="View parent conversation"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                    </svg>
                    Parent
                  </Link>
                  );
                })()}

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
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border transition-colors ${
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

                {conversation.git_branch && (
                  <span
                    data-simple-hide
                    className="cq-header-collapse hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/5 text-emerald-400/80 border border-emerald-500/20 max-w-[150px] cursor-default"
                    title={conversation.git_branch}
                    onClick={() => {
                      if (conversation.git_remote_url) {
                        const match = conversation.git_remote_url.match(/github\.com[:/](.+?)(?:\.git)?$/);
                        if (match) {
                          window.open(`https://github.com/${match[1]}/tree/${conversation.git_branch}`, '_blank');
                        }
                      }
                    }}
                    style={conversation.git_remote_url ? { cursor: 'pointer' } : undefined}
                  >
                    <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
                    </svg>
                    <span className="truncate">{conversation.git_branch}</span>
                  </span>
                )}

                {/* Simple view keeps the assignment pill but drops the names —
                    device icon + dot + avatar still say where it runs and whose
                    it is; the popover carries the detail. */}
                {isOwner && (
                  <AssignmentBadge
                    conversationId={conversation._id}
                    ownerDeviceId={(conversation as any).owner_device_id}
                    compact={simpleViewPref}
                  />
                )}

                {!isOwner && conversation.user && (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-sol-violet/10 text-sol-violet border border-sol-violet/30">
                    <AvatarImg
                      src={conversation.user.avatar_url}
                      alt={conversation.user.name || "User"}
                      className="w-4 h-4 rounded-full"
                      fallback={
                        <span className="w-4 h-4 rounded-full bg-sol-violet/20 flex items-center justify-center text-[8px]">
                          {(conversation.user.name || conversation.user.email || "?").charAt(0).toUpperCase()}
                        </span>
                      }
                    />
                    {conversation.user.name || conversation.user.email?.split("@")[0] || "Teammate"}
                  </span>
                )}

                {/* Huddle about this session: a live chip when occupied, a
                    quiet start affordance otherwise (hidden when calling is
                    unconfigured — SessionHuddleButton gates itself). */}
                {conversation._id && !guest && (
                  <SessionHuddleButton conversationId={String(conversation._id)} />
                )}

                {/* Kept in simple view (dimmed, copy sub-button hidden inside
                    the pill): the live tmux badge is how you reach the
                    terminal split, which simple view users still want. */}
                <span data-simple-dim className="contents [.simple-view_&]:inline-flex [.simple-view_&]:items-center">
                  <TmuxAttachPill tmuxSession={managedSession?.tmux_session} isLive={isSessionLive} conversationKey={conversation?._id.toString()} />
                </span>

                {/* Runs on a remote host whose daemon is struggling: say so
                    here, on the session it actually affects — the header
                    fleet chip deliberately ignores remote machines. */}
                {conversation?._id && !guest && <SessionDaemonChip conversationId={String(conversation._id)} />}

                {sessionGallerySrcs.length > 0 && <SessionGalleryButton srcs={sessionGallerySrcs} />}

                {/* The project's files, one click away regardless of what the
                    transcript happens to mention. Opens beside on surfaces
                    that can hold a second pane. */}
                {filePathBase && !guest && <SessionFilesButton projectPath={filePathBase} />}

                {/* Hairline between the identity/status pills and the plain
                    icon actions — the two families read as one soup without it. */}
                <span aria-hidden className="w-px h-3.5 bg-sol-border/60 mx-0.5 flex-shrink-0" />

                {(highlightQuery || isLocalSearchOpen) && (
                  <div className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-amber-200/50 dark:bg-amber-800/30 text-amber-800 dark:text-amber-200">
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
                    {matchInstances.length > 0 && (
                      <>
                        <span className="text-[10px] opacity-70 ml-1">
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
                    {matchInstances.length === 0 && highlightQuery && (
                      <span className="text-[10px] opacity-70 ml-1">0 matches</span>
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
                    className={`p-1 rounded hover:bg-sol-bg-alt transition-colors ${isLocalSearchOpen ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text-secondary"}`}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </button>
                </ShortcutTooltip>

                <DropdownMenu>
                  <ShortcutTooltip label={`View density: ${DENSITY_OPTIONS.find(o => o.value === density)!.label}`} action="conv.cycleDensity" hint="cycles" side="bottom">
                    <DropdownMenuTrigger asChild>
                      <button className={`p-1 rounded hover:bg-sol-bg-alt transition-colors ${density !== "full" ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text-secondary"}`}>
                        {(() => { const Icon = DENSITY_OPTIONS.find(o => o.value === density)!.icon; return <Icon className="w-3.5 h-3.5" />; })()}
                      </button>
                    </DropdownMenuTrigger>
                  </ShortcutTooltip>
                  <DropdownMenuContent align="end" className="w-72">
                    <DensityMenuOptions density={density} setDensity={setDensity} guest={guest} />
                  </DropdownMenuContent>
                </DropdownMenu>

                <ShortcutTooltip label="Copy link" action="conv.copyLink" side="bottom">
                  <button
                    onClick={() => { copyToClipboard(`${shareOrigin()}/conversation/${conversation?._id}`).then(() => toast.success("Link copied")).catch(() => toast.error("Failed to copy")); }}
                    className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                  </button>
                </ShortcutTooltip>

                {chatOn && (
                  <button
                    onClick={() => openForwardToChat({ url: `${shareOrigin()}/conversation/${conversation?._id}`, label: "session" })}
                    className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors"
                    title="Send to chat"
                  >
                    <Forward className="w-3.5 h-3.5" />
                  </button>
                )}

                {headerExtra}

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                      </svg>
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
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
                    {/* Simple view strips the header's copy affordances (the
                        pill's copy sub-button, the branch chip) — resurface
                        them here so the hamburger stays the full command
                        surface in that mode. */}
                    {simpleViewPref && managedSession?.tmux_session && (
                      <DropdownMenuItem onSelect={() => { setTimeout(() => copyTmuxAttach()); }}>
                        <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        Copy tmux attach
                      </DropdownMenuItem>
                    )}
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
                      <DropdownMenuItem onSelect={() => {
                        const pinned = !!conversation.profile_pinned_at;
                        setTimeout(async () => {
                          try {
                            if (pinned) {
                              await unpinFromProfile({ conversation_id: conversation._id as any });
                              toast.success("Removed from your public profile");
                            } else {
                              await pinToProfile({ conversation_id: conversation._id as any });
                              toast.success("Pinned — this session is now public on your profile");
                            }
                          } catch (e: any) {
                            toast.error(e?.message?.replace(/^.*Error:\s*/, "") || "Failed to update profile pin");
                          }
                        });
                      }}>
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
                    {conversation.git_branch && (
                      <DropdownMenuItem onClick={() => setDiffExpanded(!diffExpanded)}>
                        {diffExpanded ? "Hide git diff" : "Show git diff"}
                        <MenuKeyCaps action="conv.toggleDiff" />
                      </DropdownMenuItem>
                    )}
                    {conversation.parent_conversation_id && (
                      <DropdownMenuItem asChild>
                        <Link href={convLink(conversation.parent_conversation_id)}>
                          View parent conversation
                        </Link>
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
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <svg className="w-3 h-3 mr-1.5 text-sol-violet" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 5H4m0 0l4 4m-4-4l4-4" />
                            </svg>
                            Switch agent
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {AGENT_LAUNCH_OPTIONS
                              .map((a) => a.convexType)
                              .filter((t) => t !== conversation.agent_type)
                              .map((t) => (
                                <DropdownMenuItem
                                  key={`switch-${t}`}
                                  onClick={() => {
                                    const id = conversation._id.toString();
                                    useInboxStore.getState().setConversationAgent(id, t);
                                    convCommand(id, "switchSessionAgent", { agent_type: t }).catch((err) => {
                                      if (isParkedDispatchError(err)) return;
                                      useInboxStore.getState().setConversationAgent(id, conversation.agent_type || "claude_code");
                                      toast.error(err instanceof Error ? err.message : "Failed to switch agent");
                                    });
                                  }}
                                >
                                  <AgentTypeIcon agentType={t} />
                                  <span className="ml-1.5">{formatAgentType(t)}</span>
                                </DropdownMenuItem>
                              ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <Split className="w-3 h-3 mr-1.5 text-sol-cyan" />
                            Fork as
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {AGENT_LAUNCH_OPTIONS
                              .map((a) => a.convexType)
                              .filter((t) => t !== conversation.agent_type)
                              .map((t) => (
                                <DropdownMenuItem
                                  key={`fork-${t}`}
                                  onClick={() => {
                                    const parentId = conversation._id.toString();
                                    const forkSessionId =
                                      typeof crypto !== "undefined" && crypto.randomUUID
                                        ? crypto.randomUUID()
                                        : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
                                            const r = (Math.random() * 16) | 0;
                                            return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
                                          });
                                    const now = Date.now();
                                    const store = useInboxStore.getState();
                                    store.syncRecord("conversations", forkSessionId, {
                                      _id: forkSessionId,
                                      session_id: forkSessionId,
                                      title: conversation.title,
                                      agent_type: t,
                                      project_path: conversation.project_path ?? undefined,
                                      git_root: conversation.git_root ?? undefined,
                                      started_at: now,
                                      updated_at: now,
                                      status: "active",
                                      message_count: 0,
                                      forked_from: parentId,
                                      parent_conversation_id: parentId,
                                      parent_message_uuid: "agent-switch",
                                      fork_status: "copying",
                                      _forkTargetAgentType: t,
                                    });
                                    seedForkSession(forkSessionId, {
                                      session_id: forkSessionId,
                                      title: conversation.title,
                                      started_at: now,
                                      agent_type: t,
                                      forked_from: parentId,
                                      parent_conversation_id: parentId,
                                      parent_message_uuid: "agent-switch",
                                      _forkTargetAgentType: t,
                                    } as any);
                                    moveDraft(parentId, forkSessionId);

                                    const ready = convCommand(parentId, "forkFromMessage", {
                                      target_agent_type: t,
                                      session_id: forkSessionId,
                                    }).then((result) => {
                                      resolveForkSessionId(forkSessionId, result.conversation_id);
                                      return result.conversation_id as string;
                                    });
                                    store.trackSessionCreate(forkSessionId, ready);
                                    ready.catch((err) => {
                                      if (isParkedDispatchError(err)) return;
                                      // Ordinary failures never consume the original
                                      // draft or strand a navigated local fork.
                                      useInboxStore.getState().moveDraft(forkSessionId, parentId);
                                      useInboxStore.getState().discardForkStub(forkSessionId, parentId);
                                      toast.error(err instanceof Error ? err.message : "Failed to fork");
                                    });
                                  }}
                                >
                                  <AgentTypeIcon agentType={t} />
                                  <span className="ml-1.5">{formatAgentType(t)}</span>
                                </DropdownMenuItem>
                              ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
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
              currentMessageId={activeStickyMsg?.id ?? null}
              scrollProgress={navScrollProgress}
              onScrollToMessage={(messageId) => {
                const itemIndex = timeline.findIndex(item =>
                  item.type === 'message' && item.data._id === messageId
                );
                if (itemIndex >= 0) {
                  setUserScrolled(true);
                  virtualizer.scrollToIndex(itemIndex, { align: "center", behavior: "smooth" });
                  setHighlightedMessageId(messageId);
                  setTimeout(() => setHighlightedMessageId(null), 2000);
                } else if (conversation?._id) {
                  useInboxStore.getState().requestNavigate(conversation._id, { scrollToMessageId: messageId });
                }
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
            <ConversationTerminalSplit convKey={conversation._id.toString()} tmuxSession={managedSession?.tmux_session} />
            <BrowserWatchSplit convKey={conversation._id.toString()} sessionUuid={managedSession?.session_id} tmuxSession={managedSession?.tmux_session} />
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
              <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
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
              <div className="flex items-center gap-2 mb-1">
                {(() => {
                  const stickySender = activeStickyMsg.fromUserId ? senderById.get(String(activeStickyMsg.fromUserId)) : undefined;
                  return (
                    <>
                      <UserIcon avatarUrl={stickySender ? stickySender.avatar_url : conversation?.user?.avatar_url} />
                      <span className="text-sol-blue text-xs font-medium">{stickySender?.name || conversation?.user?.name || conversation?.user?.email?.split("@")[0] || "You"}</span>
                    </>
                  );
                })()}
              </div>
              <div
                ref={stickyTextRef}
                className={`text-sm text-sol-text whitespace-pre-wrap break-words pl-8 pr-4 ${stickyExpanded ? "max-h-[50vh] overflow-y-auto cursor-auto select-text" : "line-clamp-3"}`}
                onClick={stickyExpanded ? (e) => e.stopPropagation() : undefined}
              >{cleanStickyContent(activeStickyMsg.content)}</div>
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
      <div ref={containerRef} data-sv-feed className="flex-1 min-h-0 overflow-y-auto" style={{ overflowAnchor: "none" }}>
        <div className="flex flex-col min-h-full">
        {(!conversation || timeline.length === 0) ? (
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
          {conversation?.parent_conversation_id && !hasMoreAbove && (
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
          {conversation?.stable_context && !hasMoreAbove && !isLoadingOlder && (
            <StableContextCards stableContext={conversation.stable_context} />
          )}
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
            style={{
              height: virtualizer.getTotalSize(),
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
              const isSearchDimmed = highlightQuery && allMatchingMessageIds.length > 0 && item.type === 'message' && !allMatchingMessageIds.includes((item.data as Message)._id);
              const itemId = item.type === 'message' ? (item.data as Message)._id : item.type === 'commit' ? `commit-${(item.data as any).sha || (item.data as any)._id}` : `pr-${(item.data as any)._id}`;
              const isNew = newItemIdsRef.current.has(itemId);
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
                    transform: `translateY(${virtualItem.start}px)`,
                    ...(content ? {} : { height: 0, overflow: "hidden" }),
                  }}
                >
                  {content && (
                    <div className={`conv-col mx-auto px-4 sm:px-5 md:px-6 ${condensedFeed ? "py-px" : "py-0.5 sm:py-1"} ${isNew ? "animate-message-in" : ""} ${isForkSelected ? "ring-2 ring-sol-cyan/60 bg-sol-cyan/5 rounded-lg" : ""} ${isBelowForkSelection ? "opacity-30 pointer-events-none" : ""} transition-opacity`}>
                      {virtualItem.index === firstUnseenIndex && (
                        <TimelineRule color="var(--sol-orange)" label="New messages">
                          <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-sol-orange">New</span>
                        </TimelineRule>
                      )}
                      {virtualItem.index === handoffIndex && handoffRule}
                      {content}
                      {virtualItem.index === timeline.length - 1 && !hasMoreBelow && (now - lastActivityAt) > 5 * 60 * 1000 && (
                        <TimelineRule color="var(--sol-border)" className="mt-5 mb-1" faint>
                          <span className="text-[11px] text-sol-text-dim/60">{formatRelativeTime(lastActivityAt)}</span>
                        </TimelineRule>
                      )}
                      {virtualItem.index === timeline.length - 1 && !hasMoreBelow && handoffIndex === timeline.length && handoffRule}
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
          onRewindCurrent={handleRewindCurrent}
        />
      )}

      </div>

      {/* The pinned thread state sits between the feed and the composer, outside
          data-sv-feed so it can't perturb the virtualizer, and outside the
          composer's own condition so it stays readable while a permission
          prompt owns the input. It renders nothing when the agent has not
          pinned a state. */}
      {conversation && (
        <ThreadStatePanel
          conversationId={conversation._id.toString()}
          threadState={conversation.thread_state}
          threadStateAt={conversation.thread_state_at}
          threadStateMsgCount={conversation.thread_state_msg_count}
          threadStateStatus={conversation.thread_state_status}
          messageCount={conversation.message_count}
          canClear={effectiveIsOwner}
        />
      )}

      {decisionItem && conversation && (
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
              {conversation.share_token && (
                <OwnerComposerPresence conversationId={conversation._id.toString()} />
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
              <MessageInput key={conversation.session_id || conversation._id} conversationId={conversation._id} status={conversation.status} embedded={embedded} onSendAndAdvance={onSendAndAdvance} onSendAndDismiss={onSendAndDismiss ?? sendAndStashFallback} autoFocusInput={autoFocusInput} initialDraft={conversation.draft_message} isWaitingForResponse={isWaitingForResponse} isThinking={isThinking} isConversationLive={isConversationLive} workingSinceTs={lastActivityAt} workingTool={workingTool} isSessionDisconnected={conversation.is_workflow_primary ? false : isSessionDisconnected} isSessionStarting={isSessionStarting} isSessionReady={isSessionReady} sessionId={conversation.session_id} agentType={conversation.agent_type} agentStatus={isSessionDisconnected || conversation.status !== "active" ? undefined : managedSession?.agent_status as any} deliveryStatus={managedSession?.agent_status as any} pendingPermissionsCount={pendingPermissions?.length ?? 0} hasAskUserQuestion={hasAskUserQuestion} selectedMessageContent={selectedMessageContent} selectedMessageUuid={selectedMessageUuid} onClearSelection={handleClearSelection} onForkFromMessage={forkHandler} onForkSend={forkSendHandler} onSendEscape={handleSendEscape} onOpenNavigator={handleOpenNavigator} onPopulateInput={populateInputRef} permissionMode={effectiveMode} onCycleMode={handleCycleMode} onMessageSent={handleMessageSent} onLightboxChange={setIsImageLightboxActive} onDropFiles={dropFilesRef} onWorkflowLaunch={showWorkflow && selectedWorkflowId ? handleWorkflowLaunch : undefined} onGateSend={workflowRun?.status === "paused" ? handleGateRespond : undefined} skills={sessionSkills} filePaths={sessionFilePaths} mentionItemsRef={mentionItemsRef} onMentionQuery={handleMentionQuery} onSubmitWithIntent={onSubmitWithIntent} branchMapNode={treePopoverOpen ? (
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
                  onRewindCurrent={handleRewindCurrent}
                />
              ) : null} />
            </>
          )}
        </div>
      )}

      {timeline.length > 0 && (
        <div className="absolute right-3 sm:right-8 z-30 flex items-stretch gap-2.5" style={{ bottom: Math.max(messageInputHeight + 16, 115), transform: commentRailW ? `translateX(-${commentRailW}px)` : undefined, transition: "transform 160ms ease" }}>
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
                    onJumpToEnd();
                  } else {
                    setUserScrolled(false);
                    paginationCooldownRef.current = Date.now() + 1000;
                    scrollToEdgeRef.current('bottom');
                  }
                }}
                className={`group p-1.5 sm:p-2 rounded-full bg-sol-bg-alt border border-sol-border shadow-lg hover:bg-sol-cyan hover:text-white transition-all ${((userScrolled && !isNearBottom && isScrollable) || hasMoreBelow || jumpPending === 'end') ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
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
      <SelectionQuoteToolbar conversationId={conversation?._id ?? ""} />
      {conversation && (
        <CommentDock conversationId={conversation._id.toString()} />
      )}
    </main>
    </ReviewComposerContext.Provider>
    </ImageGalleryProvider>
    </ChatWakeContext.Provider>
    </CastBrowserRowContext.Provider>
    </FilePathContext.Provider>
    </HighlightContext.Provider>
  );
}
);

// memo: the parents (InboxConversation, ConversationDiffLayout) re-run several
// times per session switch on their own hooks; without memo every one of those
// passes re-ran this 5k-line body (measured 44 body executions per switch).
export const ConversationView = memo(forwardRef<ConversationViewHandle, ConversationViewProps>(
  function ConversationView(props, ref) {
    const t0 = performance.now();
    const el = ConversationViewInner(props, ref);
    devCountElements("ConversationView2", el, performance.now() - t0);
    return el;
  },
));
