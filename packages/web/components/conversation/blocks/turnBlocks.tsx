import { githubRepository } from "../../../lib/repoNavigation";
import { repoTreeHref } from "../../../lib/repoView";
import { captureException } from "@sentry/react";
import Link from "next/link";
import { LogoIcon } from "../../Logo";
import { useRouter } from "next/navigation";
import { useRef, useState, useMemo, useCallback, memo, useContext } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { createPortal } from "react-dom";
import { AvatarImg } from "../../../lib/avatarCache";
import { BrowserTabPill } from "../../browser/BrowserTabPill";
import { formatModel } from "../../../lib/conversationProcessor";
import type { DecisionAnswerMessage } from "@codecast/shared/contracts";
import { DecisionAnswerFooter } from "../../DecisionAnswerFooter";
import { describeSmallToolGroup, describeToolGroup, extractNestedActions, isAgentTool, isAskTool, isPlanModeTool, isPlanWriteToolCall, isTodoTool } from "@codecast/shared/render";
import { entityRoute } from "../../../lib/entityLinks";
import { toast } from "sonner";
import { MessageIdentityProvider } from "../../InlineDiff";
import { MessageReview } from "../../MessageReview";
import { isBackgroundBashToolCall } from "../../monitorRows";
import { useQuery, useAction } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { copyToClipboard } from "../../../lib/utils";
import { usePendingMessageStatus } from "../../../hooks/useSyncPendingPermissions";
import { stripPastedContent } from "@codecast/shared/contracts";
import { SentFileBlock, type SentFileData } from "../../tools/SentFileBlock";
import { useImageGallery, useGalleryMessageId } from "../../ImageGallery";
import { EntityIdPill, TextWithMentions } from "../../EntityIdPill";
import { entityRemarkPlugins } from "../../../lib/remarkEntityIds";
import { MESSAGE_MD_REHYPE, MESSAGE_MD_COMPONENTS, USER_MD_REMARK } from "../../messageMarkdown";
import { browserTabOf, type BrowserTabRef } from "../../castCommand";
import { useInboxStore, isConvexId, pendingRowSendArgs, type ForkChild } from "../../../store/inboxStore";
import { useMessageBookmark } from "../../../hooks/useMessageBookmark";
import { BranchSelector } from "../../BranchSelector";
import { FileText, ListChecks, Target, Maximize2, ChevronDown, ChevronRight, ChevronUp, Split, Copy as CopyIcon, Link2, Bookmark as BookmarkIcon, Share2, Forward, X } from "lucide-react";
import { useTeamFeature } from "../../../lib/teamFeatures";
import { ContextMenu, useContextMenu, CtxItem, CtxSeparator } from "../../ui/context-menu";
import { pendingBannerState, pendingRetryClientId, pendingCancelRef, pendingMessageCanRetry, pendingMessageReachedSession, isActiveAgentStatus, isBootingAgentStatus, isAliveIdleStatus, type LiveAgentStatus } from "../../../lib/pendingBanner";
import { PendingDeliveryNote } from "../../PendingDeliveryNote";
import { ghostRestartContextFor, deriveRestartStage, type RestartProgressRow } from "../../../hooks/useSessionRestart";
import { CastCommandBlock } from "./castBlocks";
import { AskUserQuestionBlock, ImageBlock, MonitorBlock, PlanModeBlock, ThinkingBlock } from "./interactiveBlocks";
import { useImageSrc } from "../../../hooks/useImageSrc";
import { AssistantIcon, UserIcon } from "./shared";
import { CastBrowserRowContext } from "../../../lib/conversationBlockContexts";
import { assistantLabel } from "../../../lib/conversationBlockStyles";
import { ScheduleWakeupBlock, TeammateMessageCard } from "./systemBlocks";
import { BrowserWatchButton, SendMessageBlock, SkillBlock, TaskCreateUpdateBlock, TaskListBlock, TaskToolBlock, TeamCreateBlock, TodoWriteBlock, ToolBlock, WorkflowToolBlock } from "./toolBlocks";
import { isAlwaysVisibleToolCall, parseApiErrorContent, parseCastCommand, parseContextBlocks, parseSkillBlocks, parseTeammateMessages, stripSystemTags } from "../classify";
import { copyMessageLink, formatFullTimestamp, formatMessagePartsForCopy, formatRelativeTime, forwardMessageToChat, safeString } from "../../../lib/conversationFormat";
import { MessageMarkdown, ReactMarkdown } from "../markdown";
import { linkifyMentions } from "../../../lib/conversationMarkdown";
import { renderAssistantBody } from "../../../lib/renderAssistantBody";
import { PENDING_BOOT_GRACE_MS, PENDING_IDLE_GRACE_MS, PENDING_RESUME_GRACE_MS, PENDING_RETRY_AFTER_MS } from "../pendingSend";
import { ApiErrorCard } from "../sessionChrome";
import { followRestoredConversation } from "../../../lib/followRestoredConversation";
import type { CondensedReceipt, ImageData, MessageFeedDensity, ParsedContextBlock, ReceiptEntry, StoryBeat, TaskRecordMaps, ToolCall, ToolCallChangeSelection, ToolResult } from "../types";
import { COMPACT_TAIL_HEIGHT } from "../../../lib/conversationTurnDefaults";

const api = _typedApi as any;

const USER_CONTENT_MAX_HEIGHT = 1800;

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

// The turn a branch was seeded with (`cast fork "<direction>"`). On the wire it
// is the human's own plain message — the agent must not see anything that
// says "fork" — so the mark comes from the fork-seed client_id stamp and the
// row's lineage, not from the content. A quiet line above the bubble: where
// this thread came from, and that this turn is where it diverged.
export function ForkSeedMark({ parentId, parentTitle, parentUsername, convLink }: { parentId: string; parentTitle?: string; parentUsername?: string; convLink: (id: string) => string }) {
  const label = parentTitle || (parentUsername ? `@${parentUsername}` : parentId.slice(0, 7));
  return (
    <div className="flex items-center gap-1.5 px-3 pt-1 text-[11px] text-sol-text-dim" data-cc-fork-seed>
      <svg className="w-3 h-3 shrink-0 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
      </svg>
      <span className="uppercase tracking-wide font-medium">Branch seed</span>
      <span aria-hidden>·</span>
      <span className="truncate">forked from <Link href={convLink(parentId)} className="text-sol-text-muted hover:underline underline-offset-2">{label}</Link></span>
    </div>
  );
}

function CancelPendingButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      data-testid="pending-message-cancel"
      className="text-[11px] text-sol-text-dim/70 hover:text-sol-orange underline underline-offset-2 transition-colors disabled:opacity-60"
      title="Stop trying to send and discard this message"
    >
      {disabled ? "Cancelling…" : "Cancel"}
    </button>
  );
}

function UserPromptImpl({ content, timestamp, messageId, conversationId, collapsed, userName, avatarUrl, onOpenComments, isHighlighted, shareSelectionMode, isSelectedForShare, onToggleShareSelection, onStartShareSelection, onForkFromMessage, forkChildren, messageUuid, images, onBranchSwitch, activeBranchId, loadingBranchId, isPending, isQueued, agentStatus, mainDivergentPreview, decision }: { content: string; decision?: DecisionAnswerMessage; timestamp: number; messageId: string; conversationId?: Id<"conversations">; collapsed?: boolean; userName?: string; avatarUrl?: string | null; onOpenComments?: (messageId: string) => void; isHighlighted?: boolean; shareSelectionMode?: boolean; isSelectedForShare?: boolean; onToggleShareSelection?: (messageId: string) => void; onStartShareSelection?: (messageId: string) => void; onForkFromMessage?: (messageUuid: string) => void; forkChildren?: ForkChild[]; messageUuid?: string; images?: ImageData[]; onBranchSwitch?: (messageUuid: string, convId: string | null) => void; activeBranchId?: string | null; loadingBranchId?: string | null; isPending?: boolean; isQueued?: boolean; agentStatus?: LiveAgentStatus; mainDivergentPreview?: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  const [contentExpanded, setContentExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const rawContent = stripPastedContent(content)
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

  const [retryVisible, setRetryVisible] = useState(false);
  const [retryState, setRetryState] = useState<"idle" | "inflight" | "sent">("idle");
  const [cancelState, setCancelState] = useState<"idle" | "inflight">("idle");
  // Set on click; drives the live progress subscription below. Never cleared
  // while the bar is mounted — delivery removes the optimistic row and the
  // whole bar (and its subscription) with it.
  const [retryClickedAt, setRetryClickedAt] = useState<number | null>(null);
  const [retryStartsSession, setRetryStartsSession] = useState(false);
  const retrying = retryState !== "idle";
  useWatchEffect(() => {
    if (retryState === "idle") return;
    const timer = setTimeout(() => setRetryState("idle"), 30_000);
    return () => clearTimeout(timer);
  }, [retryState]);
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
  const messageReachedSession = pendingMessageReachedSession(messageId, conversationPending);
  const bannerState = pendingBannerState(agentStatus, {
    retryEligible: retryVisible && pendingMessageCanRetry(content),
    restartInFlight: retrying,
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
    retrying && retryStartsSession && retryClickedAt && conversationId && isConvexId(conversationId) ? { conversation_id: conversationId } : "skip",
  );
  const retryProgress = useMemo(
    () => (retryClickedAt ? retryProgressRaw?.filter((c: RestartProgressRow) => c.created_at >= retryClickedAt - 10_000) : undefined),
    [retryProgressRaw, retryClickedAt],
  );
  const [retryWaitingLong, setRetryWaitingLong] = useState(false);
  useWatchEffect(() => {
    if (!retrying || !retryStartsSession) { setRetryWaitingLong(false); return; }
    if (retryProgress?.some((c: RestartProgressRow) => c.executed_at)) { setRetryWaitingLong(false); return; }
    const t = setTimeout(() => setRetryWaitingLong(true), 20_000);
    return () => clearTimeout(t);
  }, [retrying, retryStartsSession, retryClickedAt, retryProgress]);
  const retryStage = useMemo(
    () => retrying && retryStartsSession
      ? deriveRestartStage(retryProgress, retryWaitingLong, !!agentStatus && agentStatus !== "starting" && agentStatus !== "resuming")
      : null,
    [retrying, retryStartsSession, retryProgress, retryWaitingLong, agentStatus],
  );
  // A failed restart re-arms the button so the user can try again.
  useWatchEffect(() => {
    if (retryStage?.tone === "error" && retryState === "sent") setRetryState("idle");
  }, [retryStage?.tone, retryState]);
  const handleRetryRestart = async () => {
    if (!conversationId || retryState === "inflight" || !pendingMessageCanRetry(content)) return;
    setRetryState("inflight");
    setRetryStartsSession(!isPending || !agentStatus);
    setRetryClickedAt(Date.now());
    setRetryWaitingLong(false);
    try {
      const retryClientId = pendingRetryClientId(messageId);
      if (isPending && retryClientId && isConvexId(conversationId) && content.trim()) {
        // Replay the row's own send args (dispatched bytes + image ids): the
        // server fingerprints this client id's args, and a rebuilt payload is
        // refused as COMMAND_ID_REUSED instead of deduping. While an image is
        // still uploading the upload task owns the send; a re-send now would
        // land the message without its image.
        const pendingRow = (useInboxStore.getState().pendingMessages[conversationId] || [])
          .find((m) => m._clientId === messageId || m._id === messageId);
        const send = pendingRow ? pendingRowSendArgs(pendingRow) : { content, imageIds: undefined, uploading: false };
        if (send.uploading) {
          setRetryState("idle");
          toast.info("Your attachment is still uploading");
          return;
        }
        const status = await useInboxStore.getState().retryPendingMessage(conversationId, { clientId: retryClientId });
        if (!status) throw new Error("The retry service is unavailable. Your message is still saved.");
        if (status === "not_found") {
          useInboxStore.getState().sendMessage(conversationId, send.content || content, send.imageIds, retryClientId);
        } else if (status === "cancelled" || status === "delivered" || status === "injected") {
          setRetryState("idle");
          toast.info(status === "cancelled" ? "This message was cancelled" : "This message has already reached the session");
          return;
        }
      } else if (isPending && messageId.startsWith("serverpending_")) {
        const status = await useInboxStore.getState().retryPendingMessage(conversationId, { messageId: messageId.slice("serverpending_".length) });
        if (!status) throw new Error("The retry service is unavailable. Your message is still saved.");
        if (status !== "pending") {
          setRetryState("idle");
          toast.info(status === "not_found" || status === "cancelled" ? "This message is no longer queued" : "This message has already reached the session");
          return;
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
        return;
      }
      const res = await useInboxStore.getState().convCommand(conversationId, "restartSession", ghostRestartContextFor(conversationId));
      if (!followRestoredConversation(res, conversationId)) {
        toast.success("Restarting session — this message will be retried");
      }
      setRetryState("sent");
    } catch (err) {
      setRetryState("idle");
      captureException(err);
      toast.error(`Retry failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCancelPending = async () => {
    if (!conversationId || cancelState !== "idle") return;
    setCancelState("inflight");
    try {
      const status = await useInboxStore.getState().cancelPendingMessage(
        conversationId,
        pendingCancelRef(messageId, conversationPending),
      );
      if (status === "delivered" || status === "injected") {
        toast.info("This message has already reached the session");
      }
    } catch (err) {
      captureException(err);
      toast.error(err instanceof Error ? err.message : "Failed to cancel message");
    } finally {
      setCancelState("idle");
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
    <div data-cc-message="user" id={`msg-${messageId}`} className={`group relative scroll-mt-20 -mx-4 px-4 py-4 rounded-lg ${effectivelyCollapsed ? "mb-2" : "mb-6"} transition-all ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg rounded-lg message-highlight" : ""} ${shareSelectionMode ? "cursor-pointer" : ""} ${isSelectedForShare ? "bg-sol-cyan/15 border-2 border-sol-cyan ring-2 ring-sol-cyan/30" : "bg-sol-blue/10 border border-sol-blue/30"} ${isPending ? "opacity-80 pending-stripes" : isQueued ? "opacity-90 queued-pulse" : ""}`} style={{ '--image-fade-bg': 'color-mix(in srgb, var(--sol-blue) 10%, var(--sol-bg))' } as React.CSSProperties} onClick={shareSelectionMode ? (() => onToggleShareSelection?.(messageId)) : undefined} onContextMenu={shareSelectionMode ? undefined : (e) => ctxMenu.open(e, undefined)}>
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
            {isPending && (
              <>
                <CtxSeparator />
                <CtxItem icon={X} danger onSelect={handleCancelPending} disabled={cancelState !== "idle"}>
                  Cancel pending message
                </CtxItem>
              </>
            )}
            <CtxSeparator />
            <CtxItem icon={Maximize2} onSelect={() => setFullscreen(true)}>Fullscreen</CtxItem>
          </>
        )}
      </ContextMenu>
      <div data-cc-user-message-toolbar className={`absolute -top-2 right-0 transition-opacity duration-150 flex gap-0.5 z-10 bg-sol-bg rounded shadow-md px-0.5 ${shareSelectionMode ? "opacity-0 pointer-events-none" : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto"}`}>
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
      <div data-cc-message-who className="flex items-center gap-2 mb-2">
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
          <svg data-cc-bookmarked className="w-3 h-3 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
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
          if (effectivelyCollapsed && !hasTeammate) return <TextWithMentions text={displayContent} />;
          if (effectivelyCollapsed && hasTeammate) {
            const tmParts = parseTeammateMessages(displayContent);
            return (
              <div className="space-y-1">
                {tmParts.map((part, i) => part.type === 'teammate' ? (
                  <TeammateMessageCard key={i} teammateId={part.teammateId} color={part.color} summary={part.summary} content={part.content} />
                ) : <span key={i} className="whitespace-pre-wrap"><TextWithMentions text={part.content} /></span>)}
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
          mainDivergentPreview={mainDivergentPreview}
          onFork={onForkFromMessage ? () => onForkFromMessage(messageUuid) : undefined}
        />
      )}

      {/* Session still coming up (cold boot / resume): the daemon injects the message
          and flips to "working" once the pane is ready, so reassure rather than alarm.
          While the agent is actively processing we show nothing — the message is already
          sitting in its native input queue (see pendingBannerState). */}
      {isPending && bannerState !== "none" && (
      <PendingDeliveryNote state={bannerState} restartInFlight={retrying} conversationId={conversationId} onCancel={handleCancelPending} cancelling={cancelState !== "idle"}>
      {bannerState === "queued" && (
        <div className="flex items-center flex-wrap gap-2 mt-2 pl-8 text-xs text-sol-text-muted" data-testid="pending-message-queued">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400/70 animate-pulse flex-shrink-0" />
          {/* Cold launch/resume genuinely "starts up"; an alive-but-parked session
              (or one the daemon has claimed: "connected") is just being delivered to. */}
          <span>{agentStatus === "starting" || agentStatus === "resuming"
            ? "Starting up — your message will send once the session is ready"
            : "Queued — delivering your message to the agent"}</span>
          <CancelPendingButton onClick={handleCancelPending} disabled={cancelState !== "idle"} />
        </div>
      )}
      {bannerState === "stuck" && (
        <div className="flex items-center flex-wrap gap-2 mt-2 pl-8" data-testid="pending-message-retry">
          {!retryStage && (
            <span className="text-xs text-sol-text-muted">
              {retryState === "idle"
                ? "No confirmation from the agent yet"
                : agentStatus ? "Waiting for message delivery…" : "Restart requested…"}
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
            className="flex items-center gap-1 px-2 py-0.5 rounded border border-sol-border text-xs text-sol-text-muted hover:text-sol-text hover:border-sol-text-dim transition-colors disabled:opacity-60"
          >
            <svg className={`w-3 h-3 ${retryState !== "idle" ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {retryState === "inflight" || retryState === "sent"
              ? (agentStatus ? "Resending…" : "Restarting…")
              : retryClickedAt ? "Retry again" : (agentStatus ? "Resend message" : "Retry (kill & restart)")}
          </button>
          <CancelPendingButton onClick={handleCancelPending} disabled={cancelState !== "idle"} />
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
export const UserPrompt = memo(UserPromptImpl);

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

export function StoryTimelineView({ conversationId, userName, avatarUrl, onJump }: { conversationId?: Id<"conversations">; userName?: string; avatarUrl?: string | null; onJump?: (messageId: string, timestamp: number) => void }) {
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

export function ThreadSummaryView({ conversationId, userName, avatarUrl, onJump }: { conversationId?: Id<"conversations">; userName?: string; avatarUrl?: string | null; onJump?: (messageId: string, timestamp: number) => void }) {
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
  const { src, href, storageMissing } = useImageSrc(image);
  const gallery = useImageGallery();
  const messageId = useGalleryMessageId();
  useWatchEffect(() => {
    if (src && gallery) gallery.register({ src, href, messageId });
  }, [src, href, messageId, gallery]);
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

// One distinct receipt standing in for a segment's tool activity in the
// condensed feed. Closed, it is a faint footnote under the prose — a dashed
// outline at reduced opacity, so the eye reads the agent's text and skips the
// receipts: a busy segment counts ("read 3 files · ran 2 commands · 1 search"); one or two
// tools fit their real subject in the same space, so they say it ("ran npm
// test", "read lib/foo.ts"). Screenshots taken by the folded tools ride along as clickable
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
const CondensedToolsGroup = memo(function CondensedToolsGroup({ entries, expanded, onToggle, images, globalImageMap, resultFor, conversationId, renderTool }: {
  entries: ReceiptEntry[];
  expanded: boolean;
  onToggle: () => void;
  images?: ImageData[];
  globalImageMap?: Record<string, ImageData[]>;
  resultFor: (tc: ToolCall) => ToolResult | undefined;
  conversationId?: Id<"conversations">;
  renderTool: (tc: ToolCall, entry: ReceiptEntry) => React.ReactNode;
}) {
  const carriedBrowserRows = useContext(CastBrowserRowContext);
  const { summary, counted, screenshots, browserTabs, droveCastBrowser } = useMemo(() => {
    const counts = new Map<string, number>();
    const actions: { name: string; input: string }[] = [];
    const shots: { id: string; image: ImageData }[] = [];
    // The browser tabs the folded tools drove, one per distinct tab in the
    // order first seen, so "open tab" stays reachable without opening the
    // group — the same reason screenshots ride along as thumbnails.
    const tabs = new Map<string, BrowserTabRef>();
    let droveCastBrowser = false;
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
        const tab = browserTabOf(tc, parseCastCommand(tc), resultFor(tc)?.content, carriedBrowserRows);
        if (tab) tabs.set(`${tab.kind}:${tab.tabId}`, tab);
        if (tab?.kind === "cast") droveCastBrowser = true;
      }
    }
    const counted = [...counts.entries()].map(([name, count]) => describeToolGroup(name, count)).join(" · ");
    return {
      summary: (actions.length <= 2 && describeSmallToolGroup(actions)) || counted,
      counted,
      screenshots: shots,
      browserTabs: [...tabs.values()],
      droveCastBrowser,
    };
  }, [entries, images, globalImageMap, resultFor, carriedBrowserRows]);
  const header = (
    <div
      data-cc-tool-receipt
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
      // One box in both states — same padding, same border width, the outline
      // starting on the text column's own left edge — so only colour changes
      // when it opens and the click target never moves or resizes. The open
      // state carries a transparent border to hold that geometry.
      //
      // Closed, the dashed outline says "something is folded here" without
      // claiming the weight of a real block: no fill, dim text, and 60% opacity
      // over the WHOLE row, so the browser pills and the screenshot thumbnails
      // fade with it and the receipt reads under the reply it sits below rather
      // than beside it. The pointer brings it all back.
      //
      // Every colour here is a whole token: an opacity modifier on sol-border /
      // sol-text-dim / sol-bg-alt emits NO rule at all, because tailwind.config
      // maps those to a bare var() with no <alpha-value> slot. Only the hex
      // accents (cyan, blue…) take one, which is why the fade is an opacity on
      // the row rather than alpha on each colour.
      className={`flex items-center flex-wrap gap-x-1.5 gap-y-1 max-w-full w-fit cursor-pointer rounded-md border px-2 py-1 text-[11px] transition ${
        expanded
          ? "border-transparent text-sol-text-secondary hover:bg-[var(--cc-panel-head-bg)]"
          : "border-dashed border-sol-border text-sol-text-dim opacity-60 hover:opacity-100 hover:text-sol-text-secondary hover:border-sol-cyan/35 hover:bg-[var(--cc-panel-head-bg)]"
      }`}
      title={expanded ? "Hide tool activity" : "Show tool activity"}
    >
      <ChevronRight className={`w-3 h-3 shrink-0 opacity-60 transition-transform ${expanded ? "rotate-90 text-sol-cyan opacity-100" : ""}`} />
      <span className="truncate tracking-tight">{expanded ? counted : summary}</span>
      {!expanded && browserTabs.map((tab) => <BrowserTabPill key={`${tab.kind}:${tab.tabId}`} tab={tab} />)}
      {!expanded && droveCastBrowser && conversationId && <BrowserWatchButton conversationId={conversationId} />}
      {!expanded && screenshots.map(({ id, image }) => <CondensedImageThumb key={id} image={image} />)}
    </div>
  );
  if (!expanded) return <div className="not-prose mt-2 flex">{header}</div>;
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
export const CompactTurnCard = memo(function CompactTurnCard({ preview, messageCount, toolCount, onExpand }: { preview: string; messageCount: number; toolCount: number; onExpand: () => void }) {
  const bits: string[] = [];
  if (messageCount > 1) bits.push(`${messageCount} messages`);
  if (toolCount > 0) bits.push(`${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
  return (
    <button
      data-cc-compact-turn
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
export const CompactCollapsedTurn = memo(function CompactCollapsedTurn({ content, onExpand }: { content: string; onExpand: () => void }) {
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
  mainDivergentPreview,
  model,
  onSendInlineMessage,
  isConversationActive,
  globalImageMap,
  globalFileMap,
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
  mainDivergentPreview?: string;
  model?: string;
  onSendInlineMessage?: (content: string) => void;
  isConversationActive?: boolean;
  globalImageMap?: Record<string, ImageData[]>;
  globalFileMap?: Record<string, SentFileData[]>;
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
  // A tool's result, from this message or the conversation-wide map when the
  // result landed in a later message (the receipt chip and the folded tool
  // blocks both resolve through this one lookup).
  const resultFor = useCallback(
    (tc: ToolCall): ToolResult | undefined => toolResultMap[tc.id] ?? globalToolResultMap?.[tc.id],
    [toolResultMap, globalToolResultMap],
  );

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
    ) : tc.name === "SendUserFile" ? (
      <SentFileBlock key={tc.id} files={globalFileMap?.[tc.id] ?? []} />
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

  const chatOn = useTeamFeature("chat");
  const ctxMenu = useContextMenu<void>();

  if (!hasContent && !hasThinking && !hasToolCalls && !hasImages) {
    return null;
  }

  const handleCopy = () => {
    const text = formatMessagePartsForCopy(displayContent, toolCalls, toolResults);
    if (!text) return;
    setTimeout(() => { copyToClipboard(text).then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  const handleCopyLink = () => copyMessageLink(conversationId, messageId);
  const handleForwardToChat = () => forwardMessageToChat(conversationId, messageId);

  // Show Claude header for first message in sequence (regardless of content type)
  const shouldShowHeader = showHeader;
  const onlyToolCalls = hasToolCalls && !hasContent && !visibleThinking;
  const hasVisibleContent = hasContent || visibleThinking || hasToolCalls || hasImages;

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
    <div data-cc-message="assistant" id={`msg-${messageId}`} className={`group relative scroll-mt-20 ${onlyToolCalls ? "mb-0.5" : condensed ? "mb-2.5" : "mb-6"} transition-all ${isHighlighted ? "ring-2 ring-sol-yellow shadow-lg rounded-lg p-2 -m-2 message-highlight" : ""} ${shareSelectionMode ? "cursor-pointer" : ""} ${isSelectedForShare ? "bg-sol-cyan/10 rounded-lg p-2 -m-2 border-2 border-sol-cyan ring-2 ring-sol-cyan/30" : ""}`} onClick={shareSelectionMode ? (() => onToggleShareSelection?.(messageId)) : undefined} onContextMenu={shareSelectionMode ? undefined : (e) => ctxMenu.open(e, undefined)} title={!shouldShowHeader ? formatRelativeTime(timestamp) : undefined}>
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
        <div data-cc-assistant-message-toolbar className={`absolute ${toolbarTop} right-0 transition-opacity duration-150 flex gap-0.5 z-10 bg-sol-bg rounded shadow-md px-0.5 ${shareSelectionMode ? "opacity-0 pointer-events-none" : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto"}`}>
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
        <div data-cc-message-who className="flex items-center gap-2 mb-2 mt-4">
          <span className="flex items-center gap-2 cursor-default" title={model ? `Model: ${model}` : undefined}>
            <AssistantIcon agentType={agentType} />
            <span className="text-sol-text-secondary text-xs font-medium">{assistantLabel(agentType)}</span>
          </span>
          {model && <span className="text-sol-text-dim text-[10px] font-mono truncate" title={`Model: ${model}`}>{formatModel(model)}</span>}
          <a
            href={`#msg-${messageId}`}
            className="text-sol-text-dim hover:text-sol-text-muted text-xs transition-colors"
            title={`${formatFullTimestamp(timestamp)} (click to copy)`}
            onClick={(e) => { e.preventDefault(); setTimeout(() => { copyToClipboard(formatFullTimestamp(timestamp)).then(() => toast.success("Timestamp copied")); }); }}
          >
            {formatRelativeTime(timestamp)}
          </a>
          {isBookmarked && (
            <svg data-cc-bookmarked className="w-3 h-3 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
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
          // A delivered file reads as the end of what the agent just said, so
          // its cards go under the content rather than above it.
          if (tc.name === "SendUserFile") return null;
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
              <div data-cc-message-overflow className="flex items-center gap-1 mt-2">
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

        {hasToolCalls && toolCalls?.filter(tc => tc.name === "SendUserFile").map(tc => (
          renderToolBlock(tc, toolResultMap[tc.id], { messageId, messageUuid, timestamp })
        ))}

        {condensedReceipt && (
          <CondensedToolsGroup
            entries={condensedReceipt.entries}
            expanded={condensedReceipt.expanded}
            onToggle={condensedReceipt.onToggle}
            images={images}
            globalImageMap={globalImageMap}
            resultFor={resultFor}
            conversationId={conversationId}
            renderTool={(tc, entry) => renderToolBlock(tc, resultFor(tc), entry)}
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
          data-cc-message-action
          onClick={() => onForkFromMessage(messageUuid)}
          className="absolute right-2 -bottom-3 z-10 inline-flex items-center gap-1.5 text-[11px] font-medium pl-1.5 pr-2.5 py-1 rounded-md border border-dashed border-sol-border/60 bg-sol-bg text-sol-text-dim shadow-sm opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto hover:text-sol-cyan hover:border-sol-cyan/50 hover:bg-sol-cyan/10 transition-all duration-150"
          title="Fork the conversation from this message"
          aria-label="Fork from this message"
        >
          <Split className="w-3.5 h-3.5" />
          <span>Fork</span>
        </button>
      )}

      {forkChildren && forkChildren.length > 0 && onBranchSwitch && messageUuid && (
        <BranchSelector
          forkChildren={forkChildren}
          activeBranchId={activeBranchId ?? null}
          onSwitchBranch={(convId) => onBranchSwitch(messageUuid, convId)}
          loadingBranchId={loadingBranchId}
          mainDivergentPreview={mainDivergentPreview}
          onFork={onForkFromMessage ? () => onForkFromMessage(messageUuid) : undefined}
        />
      )}
    </div>
  );
}
export const AssistantBlock = memo(AssistantBlockImpl);

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

  // The branch opens the repository's tree at that branch inside the app.
  const repository = githubRepository(gitRemoteUrl);
  const branchHref = repository && gitBranch ? repoTreeHref(repository, gitBranch) : null;

  return (
    <button
      onClick={() => hasDiff && onToggleDiff()}
      className={`font-mono text-[11px] text-sol-text-muted flex-shrink-0 ${hasDiff ? "cursor-pointer hover:text-sol-text-secondary" : "cursor-default"}`}
      title={hasDiff ? (diffExpanded ? "hide diff" : "show diff") : undefined}
    >
      (
      {branchHref ? (
        <Link
          href={branchHref}
          className="text-sol-green hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {gitBranch}
        </Link>
      ) : (
        <span className="text-sol-green">{gitBranch}</span>
      )}
      {!isClean && <span className="text-sol-orange ml-0.5">*</span>})
    </button>
  );
}

export function GitDiffPanel({
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
