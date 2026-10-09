import { captureException } from "@sentry/react";
import { awaitingOkIds } from "../lib/decisionQueue";
import { hostedComposerWords, hostedLastExchange, type HostedLast } from "../lib/hostedComposer";
import { HostedStatusLine } from "./conversation/HostedStatusLine";
import { useIsHostedConversation } from "../hooks/useConversationAgentType";
import { MODE_WORDS, useSurface } from "../lib/surfaces";
import { useAllowanceOut } from "./simple/usePlanFigures";
import { useContext, useLayoutEffect, useRef, useState, useMemo, useCallback, memo, lazy, Suspense } from "react";
import { RevealInBandCtx } from "../lib/revealHost";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { isMac, hasOpenModal, altChordDirection } from "../shortcuts";
import { armJointSend, jointSendReady, takeJointSend } from "../lib/jointSend";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { createPortal } from "react-dom";
import { compressImage } from "../lib/compressImage";
import { captureError } from "../lib/analytics";
import { uploadBlobToStorage } from "../lib/uploadBlob";
import { textareaCaretRect } from "../lib/textareaCaret";
import { classifyApiErrorBanner, ACTIVE_AGENT_STATUSES, isHostedAgentType, type AgentStatus } from "@codecast/shared/contracts";
import { useRunnerSilence } from "../hooks/useRunnerSilence";
import { HOSTED_IMAGE_REFUSAL } from "@codecast/shared/contracts/assistant";
import { useLimitRecovery } from "../hooks/useLimitRecovery";
import { useCoarseNow, useNowWhen } from "../hooks/useCoarseNow";
import { formatCountdown, HIBERNATED_COPY } from "@codecast/shared/contracts";
import { parseLimitResetAt } from "../lib/limitReset";
import { pendingImageUploads, persistDraftImages, restoreDraftImages, settleDraftImageUpload } from "../lib/draftImages";
import { cancelPendingSend } from "../lib/cancelPendingSend";
import { cancelDraftWrite, scheduleDraftWrite } from "../lib/pendingDraftWrites";
import { isResentCopyOfSentMessage } from "../lib/staleDraft";
import type { SkillItem } from "../lib/conversationProcessor";
import { KeyCap, ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { toast } from "sonner";
import { appendToDraft } from "../lib/quoteFormat";
import { imagePlaceholderToken, insertImagePlaceholder, dropImagePlaceholder } from "../lib/imagePlaceholder";
import { attachReviewToMessage, batchSendWords, quotedImages } from "../lib/reviewActions";
import { useShallow } from "zustand/react/shallow";
import { uploadMarkedImage } from "../lib/markedImage";
import { enterReviewFromComposer } from "../lib/reviewNav";
import { ReviewBar } from "./ReviewBar";
import { useReviewComposer } from "./reviewContext";
import { ComposerFoot, ComposerSendButton, ComposerShell, ComposerTextarea, ComposerTextRow } from "./ComposerShell";
import { composerColumn, FIELD_SIZING_SUPPORTED } from "./composerLayout";
import { ComposerSuggestion, ComposerSuggestionHandle } from "./ComposerSuggestion";
import { useMutation, useConvex } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { HandoffPicker, useOwnersFromStore } from "./OwnersBadge";
import { usePendingMessageStatus } from "../hooks/useSyncPendingPermissions";
import { useInboxStore, isConvexId, convHasPendingSend, type OptimisticImage } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { soundSend } from "../lib/sounds";
import type { MentionItem } from "./editor/MentionList";
import { MentionMenu } from "./editor/MentionMenu";
import { mergeMentionSuggestions, mentionViewTimes, orderMentionItems } from "../lib/mentionRanking";
import { Maximize2, Minimize2, Split, Archive, ArrowRightLeft } from "lucide-react";
import type { ComposeEditorHandle } from "./editor/ComposeEditor";
import { useMentionQuery, useMentionServerSearch, sessionMentionTeamId, SERVER_MENTION_TYPES, matchScore, filterMentionItems, channelMentionItems } from "../hooks/useMentionQuery";
import { mentionContextFor } from "../lib/mentionContext";
import { parseChatDraftKey } from "../lib/chatDraftKey";
import { inFlightPending, isAliveIdleStatus, pendingRowHoldReason, type LiveAgentStatus } from "../lib/pendingBanner";
import { expandEntityMentions } from "../lib/mentionExpansion";
import { identityLine } from "../lib/sessionIdentity";
import { personifyAllNow } from "../hooks/usePersonifyAll";
import { ghostRestartContextFor, deriveRestartStage, restartPhaseOf } from "../hooks/useSessionRestart";
import { useConversationCommands } from "../hooks/useSessionCommands";
import { latestRestartRow, requestSessionRestart } from "../lib/sessionCommands";
import { useSwipeToDismiss } from "../hooks/useSwipeToDismiss";
import { WorkingStatusLine } from "./conversation/sessionChrome";
import { LiveCompactionCard } from "./conversation/CompactionProgressCard";
import { followRestoredConversation } from "../lib/followRestoredConversation";
import { SLASH_QUERY_RE, SLASH_TRIGGER_RE, matchSlashSkills } from "../lib/sessionSkills";

const api = _typedApi as any;
const ComposeEditor = lazy(() => import("./editor/ComposeEditor").then((m) => ({ default: m.ComposeEditor })));

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
// Growth stops at --composer-max-h and the field scrolls inside from there.
// The default is a share of the viewport; a host that boxes the composer in
// a frame of its own (ComposeView's modal and dock) sets the variable to what
// that frame can spare, so a long draft never pushes the host's other rows
// out of its clip. The element that carries the cap (the textarea, or the
// expanded editor's box) wears data-composer-field so a host can measure it.
// Chat's caret-anchored @ and # popup. Wide enough that a session row's name,
// its meta run, its id and its age share one line.
const CHAT_AC_WIDTH = 560;

const MENTION_TRIGGER_RE = /@([\w./\\-]*(?: [\w./\\-]+){0,4} ?)$/;
const MENTION_QUERY_RE = /^[\w./\\-]*(?: [\w./\\-]+){0,4} ?/;
// A channel reference opens after whitespace or "(" and takes the slug
// alphabet channel names are normalized to (convex chatText
// normalizeChannelName), so "##" headings and "a#b" stay prose.
const CHANNEL_TRIGGER_RE = /(?:^|[\s(])#([a-z0-9_-]*)$/i;
const CHANNEL_QUERY_RE = /^[a-z0-9_-]*/i;


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
const EMPTY_QUEUE: string[] = [];

const ForkReplyInput = memo(function ForkReplyInput({ userName, userAvatar, onForkReply, autoFocusInput }: { userName: string; userAvatar?: string | null; onForkReply: (content: string) => void; autoFocusInput?: boolean }) {
  const [message, setMessage] = useState("");
  const [isForking, setIsForking] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useMountEffect(() => { if (autoFocusInput && textareaRef.current && !hasOpenModal(textareaRef.current)) textareaRef.current.focus(); });
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

export const MessageInput = memo(function MessageInput({ conversationId, status, embedded, onSendAndAdvance, onSendAndDismiss, autoFocusInput, initialDraft, isWaitingForResponse, isThinking, isConversationLive, isSessionDisconnected, isSessionStarting, isSessionReady, sessionId, agentType, agentStatus, deliveryStatus, pendingPermissionsCount, hasAskUserQuestion, selectedMessageContent, selectedMessageUuid, onClearSelection, onForkFromMessage, onForkSend, onSendEscape, onOpenNavigator, onPopulateInput, clearInputRef, permissionMode, permissionModePending, onCycleMode, onMessageSent, onLightboxChange, onDropFiles, onWorkflowLaunch, onGateSend, skills, filePaths, mentionItemsRef, onMentionQuery, onSubmitWithIntent, onDidSend, branchMapNode, threadStateNode, composerNode, composerFoot, bareComposer, inline, chatMentionMode, mentionTeamId, composerPlaceholder, workingSinceTs, workingPhrase, escapeOwnedRef, escapeCloses }: { conversationId: string; status?: string; embedded?: boolean; onSendAndAdvance?: () => void; onSendAndDismiss?: () => void; autoFocusInput?: boolean; initialDraft?: string; isWaitingForResponse?: boolean; isThinking?: boolean; isConversationLive?: boolean; isSessionDisconnected?: boolean; isSessionStarting?: boolean; isSessionReady?: boolean; sessionId?: string; agentType?: string; agentStatus?: AgentStatus; deliveryStatus?: string; pendingPermissionsCount?: number; hasAskUserQuestion?: boolean; selectedMessageContent?: string | null; selectedMessageUuid?: string | null; onClearSelection?: () => void; onForkFromMessage?: (uuid: string) => void; onForkSend?: (content: string) => void; onSendEscape?: () => void; onOpenNavigator?: () => void; onPopulateInput?: React.MutableRefObject<((text: string, opts?: { append?: boolean }) => void) | null>; /** Filled with a function that empties the composer and deletes its draft: text, images and the stored row. */ clearInputRef?: React.MutableRefObject<(() => void) | null>; permissionMode?: string; permissionModePending?: boolean; onCycleMode?: () => void; onMessageSent?: () => void; onLightboxChange?: (active: boolean) => void; onDropFiles?: React.MutableRefObject<((files: File[]) => void) | null>; onWorkflowLaunch?: (goal: string) => Promise<void>; onGateSend?: (content: string, images?: Array<{ storageId?: string; previewUrl: string; mime: string; uploading: boolean }>) => void | Promise<void>; skills?: SkillItem[]; filePaths?: string[]; mentionItemsRef?: React.MutableRefObject<MentionItem[]>; onMentionQuery?: (q: string) => void; onSubmitWithIntent?: (navigate: boolean) => void; onDidSend?: (info: { conversationId: string; content: string; clientId: string }) => void; branchMapNode?: React.ReactNode; threadStateNode?: React.ReactNode; composerNode?: React.ReactNode; /** The framed surface's toolbar (attach, voice, options). Renders as a row under the field, and send moves into it. */ composerFoot?: React.ReactNode; bareComposer?: boolean; /** The full session composer laid out inside another surface (a Threads card): full width, not pinned to the bottom, tighter. */ inline?: boolean; chatMentionMode?: boolean; mentionTeamId?: string; composerPlaceholder?: string; workingSinceTs?: number; workingPhrase?: string; escapeOwnedRef?: React.MutableRefObject<boolean>; /** Escape closes the surface around the composer (the compose sheet), so the status line offers no Escape hint. */ escapeCloses?: boolean }) {
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
  // Hand-off: the composed text becomes the note that travels with the
  // assignment (OwnersBadge.HandoffPicker). Real sessions only — a comment
  // box, a workflow gate and a chat room have nobody to hand to.
  const [handoffOpen, setHandoffOpen] = useState(false);
  const owners = useOwnersFromStore(conversationId);
  const handoffShown = useSurface("composer.handoff");
  // Send and stash is a triage verb, so it follows the triage bar's surface.
  const triageShown = useSurface("triageBar");
  const canHandoff = handoffShown && !bareComposer && !onGateSend && !onWorkflowLaunch && !chatMentionMode && isConvexId(conversationId) && !!owners.currentUser && owners.canManage !== false;
  // Narrowed: MessageInput only needs the session's team_id (for mention scope), which
  // never changes on a heartbeat. Subscribing to the whole row re-rendered the input
  // (and its draft textarea) ~1×/s for a live session.
  const composeTeamId = useInboxStore((s) => s.sessions[conversationId]?.team_id);
  // A new session has no team until the server stamps it: mention from the
  // team its directory files into meanwhile (sessionMentionTeamId).
  const composePath = useInboxStore((s) => {
    const row = s.sessions[conversationId];
    return row && !row.team_id ? row.git_root || row.project_path || null : null;
  });
  // Parked on a usage limit: the status line says so instead of "Ready", with
  // the reset counted down from the park stamp's banner (a primitive
  // signature, so heartbeats never re-render the composer for it).
  const limitParkedAt = useInboxStore((s) => {
    const row = s.sessions[conversationId];
    return row?.pending_api_error && row.pending_api_error_kind === "limit" ? (row.pending_api_error_at ?? 0) : null;
  });
  const limitResetAt = useInboxStore((s) => {
    if (limitParkedAt == null) return undefined;
    const msgs = s.messages[conversationId];
    for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
      const m = msgs![i];
      if (m.role === "assistant" && m.content && classifyApiErrorBanner(m.content.trim()) === "limit") {
        return parseLimitResetAt(m.content, m.timestamp);
      }
    }
    return undefined;
  });
  // A recovery acting on the park (the same phase the park card shows): the
  // status line follows it instead of counting down a window nobody waits on.
  const { phase: limitPhase } = useLimitRecovery(conversationId, limitParkedAt || undefined, limitParkedAt != null);
  // Re-render only when the countdown's printed minutes change.
  const limitNow = useNowWhen(
    (t) => (limitParkedAt == null ? "" : limitResetAt != null ? formatCountdown(limitResetAt - t) + (t >= limitResetAt ? "!" : "") : "parked"),
    30_000,
  );
  // Suggestion pills pref — off by default; the strip mounts only when on.
  const suggestionShown = useSurface("composer.suggestion");
  const suggestionsEnabled = useInboxStore((s) => s.clientState?.ui?.composer_suggestions === true) && suggestionShown;
  const memberTeams = useInboxStore((s) => s.teams);
  const mentionScope = useMemo(() => {
    const teamId = mentionTeamId
      ? String(mentionTeamId)
      : sessionMentionTeamId(useInboxStore.getState(), { team_id: composeTeamId, project_path: composePath });
    const isMember = teamId
      ? (memberTeams || []).some((t: any) => String(t._id) === teamId)
      : false;
    if (teamId && isMember) return { kind: "team" as const, teamId };
    const uid = mentionUser?._id ? String(mentionUser._id) : "";
    return uid ? { kind: "personal" as const, userId: uid } : { kind: "any" as const };
  }, [mentionTeamId, composeTeamId, composePath, memberTeams, mentionUser?._id]);
  const composeMentionQuery = useMentionQuery(mentionScope);
  const [pendingMessageId, setPendingMessageId] = useState<Id<"pending_messages"> | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  // A hosted conversation has no machine to resume or restart: its turn
  // engine owns delivery, so the stuck banner and the resumes it drives never
  // apply to it.
  // The stub of a conversation being started already carries its agent
  // (beginOptimisticSession), so hosted wording applies from the first frame.
  const storeHosted = useIsHostedConversation(conversationId);
  const hostedConversation = isHostedAgentType(agentType) || storeHosted;
  // A hosted conversation whose month is used up says so at rest and holds
  // Send, rather than letting a message travel only to come back refused.
  const allowanceOut = useAllowanceOut(hostedConversation);
  // A pending decision row waits on the person (awaitingOkIds, the one home
  // the inbox and the card read too): the composer points at the card only
  // while there is one, and clears with the optimistic answer.
  const hostedAwaitsOk = useInboxStore((s) => hostedConversation && awaitingOkIds(s.sessionDecisions).has(conversationId));
  // Where the conversation stands, from its last words: the assistant just
  // asked the person something (the composer invites the answer), it has
  // answered (a follow-up belongs here), the person said no to its card
  // since their last message (it invites a change), or something was sent
  // and nothing answered yet. Only an empty conversation invites a new chore.
  // A stop notice (an error, an outage) points at its own Try again; a no
  // invites a change only for DECLINE_HINT_MS, so a cold revisit reads as
  // an answered conversation rather than an ask still pending.
  const hostedLast = useInboxStore((s): HostedLast => (hostedConversation ? hostedLastExchange(s.messages[conversationId], s.sessionDecisions, conversationId, Date.now()) : null));
  const [stuckBannerRaised, setShowStuckBanner] = useState(false);
  const showStuckBanner = stuckBannerRaised && !hostedConversation;
  const [isResuming, setIsResuming] = useState(false);
  // Distinct from isResuming: true only while a destructive kill+restart is in flight, so the
  // footer can say "Killing & restarting" instead of the gentler "Waiting for connection".
  // A restart of this conversation in flight, from its sessionCommands row
  // (whoever asked: this footer, the header, the inbox row).
  const restartRow = useInboxStore((s) => latestRestartRow(s.sessionCommands, conversationId));
  const restartNow = useCoarseNow(restartRow && !restartRow.confirmed_at ? 1_000 : 60_000);
  const isRestarting = restartPhaseOf(restartRow, restartNow).phase === "restarting";
  const hasPendingSend = useInboxStore((s) => convHasPendingSend(s.pendingMessages[conversationId]));
  const [showModeLabel, setShowModeLabel] = useState(false);
  const [modeTooltip, setModeTooltip] = useState(false);
  const modeLabelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoResumeTriggeredRef = useRef(false);
  // Guards the one allowed automatic kill+restart: fires once when the daemon has declared a
  // sent message undeliverable (delivery genuinely failed over many minutes), reset per message.
  const autoRestartTriggeredRef = useRef(false);
  // MessageInput is reused when the inbox selection changes. A footer
  // "Killing & restarting" from the previous conversation must not follow.
  const restartBoundIdRef = useRef(conversationId);
  if (restartBoundIdRef.current !== conversationId) {
    restartBoundIdRef.current = conversationId;
    if (isResuming) setIsResuming(false);
    autoRestartTriggeredRef.current = false;
    autoResumeTriggeredRef.current = false;
  }
  const convCommand = useInboxStore((s) => s.convCommand);
  // Live kill→resume ladder while a recovery is in flight: the daemon stamps
  // each command row (executed_at + result/error), so the footer can show what
  // is actually happening instead of an indefinite spinner. Fed only during
  // recovery, so it costs nothing otherwise.
  const recoveryRows = useConversationCommands(conversationId, isRestarting || isResuming);
  const restartProgress = useMemo(
    () => recoveryRows.filter((c) => c.command === "kill_session" || c.command === "resume_session"),
    [recoveryRows],
  );
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
  const addOptimistic = useInboxStore((s) => s.addOptimisticMessage);
  const markAsQueued = useInboxStore((s) => s.markOptimisticAsQueued);
  const sentContentRef = useRef<string | null>(null);

  type AutocompleteTrigger = { type: "/" | "@" | "#"; startPos: number } | null;
  type AcItem = Omit<MentionItem, "id"> & { id?: string; description?: string };
  const [acTrigger, setAcTrigger] = useState<AutocompleteTrigger>(null);
  const [acIndex, setAcIndex] = useState(0);
  const acRef = useRef<HTMLDivElement>(null);
  // Chat mode anchors the popup at the @ itself. The zero-height div right
  // above the form is the positioning context; this is the popup's left within
  // it, measured from the @'s pixel position inside the textarea. A composer
  // narrower than the popup (a reply thread) caps it at the composer's width.
  const acAnchorRef = useRef<HTMLDivElement>(null);
  const [acCaretLeft, setAcCaretLeft] = useState(0);
  // The popup grows upward from the anchor, so a composer near the top of the
  // viewport (the palette's send step) caps it at the room above, or its top
  // rows render offscreen.
  const [acRoomAbove, setAcRoomAbove] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!chatMentionMode || !acTrigger) return;
    const ta = textareaRef.current;
    const host = acAnchorRef.current;
    if (!ta || !host) return;
    setAcRoomAbove(Math.max(160, host.getBoundingClientRect().top - 18));
    if (acTrigger.type === "/") return;
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
  const [, setLocalMentionTick] = useState(0);
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
    const queryRe = acTrigger.type === "@" ? MENTION_QUERY_RE : acTrigger.type === "#" ? CHANNEL_QUERY_RE : SLASH_QUERY_RE;
    return (rawQuery.match(queryRe)?.[0] ?? "").trim().toLowerCase();
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

  // What this session or chat thread already names leads the @ and # lists
  // (lib/mentionContext). Read once per opened trigger, not per keystroke:
  // the transcript does not change while a mention is being typed.
  const acTriggerKey = acTrigger && acTrigger.type !== "/" ? `${acTrigger.type}${acTrigger.startPos}` : null;
  const acContext = useMemo(() => {
    if (!acTriggerKey) return undefined;
    const st = useInboxStore.getState();
    return mentionContextFor(st, conversationId, st.currentUser?._id ? String(st.currentUser._id) : undefined);
  }, [acTriggerKey, conversationId]);

  const mentionState = useInboxStore.getState();
  const localMentionItems = effectiveMentionItemsRef.current;
  const mentionRoles = chatMentionMode ? mentionState.orgTree?.roles : undefined;
  const recentMentionVisits = mentionState.recentVisits;
  const lastMentionViews = mentionState._lastViewedAt;
  const acCandidates = useMemo(() => {
    if (acTrigger?.type !== "@") return [];
    const roleItems: MentionItem[] = (mentionRoles ?? [])
      .filter((r: any) => r.status !== "retired")
      .map((r: any) => ({
        id: String(r._id), type: "role", label: r.name, sublabel: `@${r.handle}`,
        handle: r.handle, shortId: r.short_id, updatedAt: r.updated_at,
      }));
    return mergeMentionSuggestions(
      [...roleItems, ...(localMentionItems ?? [])], acServerItems,
      mentionViewTimes({ recentVisits: recentMentionVisits, _lastViewedAt: lastMentionViews }), Infinity, "", false, acContext,
    );
  }, [acTrigger?.type, mentionRoles, localMentionItems, acServerItems, recentMentionVisits, lastMentionViews, acContext]);

  const acItems: AcItem[] = useMemo(() => {
    if (!acTrigger) return [];
    if (acTrigger.type === "#") {
      const channels = channelMentionItems(useInboxStore.getState(), mentionScope)
        .filter((c) => matchScore(c.label, acQuery) !== Infinity || (!!c.sublabel && matchScore(c.sublabel, acQuery) !== Infinity));
      return orderMentionItems(mergeMentionSuggestions(channels, [], new Map(), 12, acQuery, false, acContext));
    }
    if (acTrigger.type === "/") {
      return matchSlashSkills(skills, acQuery)
        .map(s => ({ label: s.name, description: s.description, type: "skill" as string }));
    }
    if (acTrigger.type === "@") {
      // Chat mode's own vocabulary (docs/architecture/agent-channels.md C2):
      // the org roles of the active workspace answer to @handle, and a
      // session is inserted as its short id (chatMentionOffers decides which
      // ones the room is offered).
      const candidates = filterMentionItems(acCandidates, acQuery, chatMentionMode);
      const items: AcItem[] = mergeMentionSuggestions(candidates, [], new Map(), acQuery ? 10 : 6, acQuery, personifyAllNow());

      const fileMatches = (filePathsRef.current || [])
        .filter(p => {
          const name = p.split("/").pop() || p;
          return matchScore(name, acQuery) !== Infinity || matchScore(p, acQuery) !== Infinity;
        })
        .slice(0, 8)
        .map(p => ({ label: p, description: undefined, type: "file" as string }));
      items.push(...fileMatches);

      return orderMentionItems(items);
    }
    return [];
  }, [acTrigger, acQuery, skills, acCandidates, chatMentionMode, acContext, mentionScope]);

  const clampedAcIndex = acItems.length > 0 ? Math.min(acIndex, acItems.length - 1) : 0;

  // A multi-word @ query that has settled on zero matches is prose, not a
  // mention: every word must hit, so typing more can never bring matches back.
  // Close the trigger and remember where it died; handleMessageChange keeps it
  // closed while the query only grows, and lets it reopen once the user
  // deletes back past that point. Without this every further keystroke would
  // reopen the popup on a spinner and fire another server search.
  const mentionDeadEndRef = useRef<{ startPos: number; len: number } | null>(null);
  useWatchEffect(() => {
    if (!acTrigger || acTrigger.type !== "@" || acServerLoading) return;
    if (acItems.length > 0 || !acQuery.includes(" ")) return;
    mentionDeadEndRef.current = { startPos: acTrigger.startPos, len: acQuery.length };
    setAcTrigger(null);
  }, [acTrigger, acItems, acServerLoading, acQuery]);

  const applyAutocomplete = useCallback((item: AcItem) => {
    if (!acTrigger) return;
    const before = message.slice(0, acTrigger.startPos);
    const cursorPos = textareaRef.current?.selectionStart ?? message.length;
    // A slash command replaces its whole token, so picking one with the
    // caret mid-word leaves no stray tail behind.
    const after = acTrigger.type === "/"
      ? message.slice(acTrigger.startPos + 1).replace(SLASH_QUERY_RE, "").replace(/^ /, "")
      : message.slice(cursorPos);

    let inserted: string;
    if (acTrigger.type === "/") {
      inserted = `/${item.label} `;
    } else if (acTrigger.type === "#") {
      inserted = `#${item.label} `;
    } else if (chatMentionMode && (item.type === "person" || item.type === "role") && item.handle) {
      // The handle the server resolves, at the @ the user typed. The ref form
      // (`@[Name id]`) is the session vocabulary; for people in chat it only
      // notified when the label happened to contain the handle — and the
      // anchor's label never did, which is how "@[Anchor] hi" woke nothing.
      // A role is the same shape: `@growth` wakes it, `@[Growth or-3]` is prose.
      inserted = `@${item.handle} `;
    } else if (chatMentionMode && item.type === "session" && item.shortId) {
      // Only the bare 7-char short id resolves to a session in chat.
      inserted = `@${item.shortId} `;
    } else if (item.type === "file" || item.type === "skill") {
      inserted = `@${item.label} `;
    } else {
      // A session that wears a character or a role is named as that person:
      // the reference reads "@[Ember jx7abcd]" and renders as its face and
      // name (session-characters.md S3). A plain session keeps its title.
      const persona = item.type === "session" && item.identity
        ? identityLine(item.identity, item.label, personifyAllNow()).name
        : null;
      const refTitle = persona ?? item.label;
      const truncTitle = refTitle.length > 30 ? refTitle.slice(0, 30) + "..." : refTitle;
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
  // In-flight only: the query's settled fallback row is for the transcript bubble.
  const existingPending = inFlightPending(usePendingMessageStatus(canQueryServer ? conversationId : null));
  // A message waiting with no agent to answer usually waits on the machine
  // the session runs on; when that machine is silent, the status line names
  // it instead of "Processing...", which read as live for days while a
  // teammate's laptop was off.
  const runnerSilence = useRunnerSilence(conversationId, canQueryServer && !hostedConversation && !agentStatus && !!(pendingMessageId || existingPending));

  // The send is fire-and-forget through the store sync, so we no longer get the
  // message id back. Recover precise per-message status tracking from the
  // conversation-scoped pending row once the server has it — keeps the stuck
  // banner and the live-session kill-protection (messageReachedSession) intact.
  // The row's `_id` is the CONVERSATION id (it is the store key of a
  // per-conversation singleton); the pending_messages id lives in `message_id`.
  useWatchEffect(() => {
    if (pendingMessageId || !sentAt || !existingPending?.message_id) return;
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
  // The floor (no agent status reported at all) is 30s: a slow inject or a
  // heartbeat that has not propagated yet routinely takes 15-20s, and reading
  // that as "Disconnected" was the most common false alarm in the composer.
  const stuckThresholdMs = isAgentResuming ? 120_000 : isSessionStarting || isAgentStarting || isAgentDelivering || isAgentAliveIdle ? 60_000 : 30_000;

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
  const resolvedImageUrls = useQueryNoThrow(
    api.images.getImageUrls,
    staleImageIds ? { storageIds: staleImageIds as Id<"_storage">[] } : "skip"
  ).data;
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
        handleRestartResult(await requestSessionRestart(conversationId, ghostRestartContext()));
      } else {
        await convCommand(conversationId, "resumeSession");
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
          handleRestartResult(await requestSessionRestart(conversationId, ghostRestartContext()));
          return;
        } catch (err2) {
          if (isParkedDispatchError(err2)) return;
          useInboxStore.getState().markServerDeleted(conversationId);
          toast.error("This conversation no longer exists on the server", { description: "It couldn't be restored automatically." });
          setIsResuming(false);
          return;
        }
      }
      toast.error(msg || "Failed to resume session");
      setIsResuming(false);
    }
  }, [conversationId, convCommand, isResuming, isExistingMessageDead, messageStatus?.status, ghostRestartContext, handleRestartResult, serverDeleted]);

  // Stop the (otherwise indefinite) retry loop for a message that genuinely can't land. Resolve
  // the id from either the precise tracker or the conversation-scoped pending row, since a reload
  // mid-send leaves us with only the latter.
  const handleCancelMessage = useCallback(async () => {
    if (!conversationId) return;
    const ref = pendingMessageId
      ? { messageId: pendingMessageId, clientId: existingPending?.client_id as string | undefined }
      : existingPending?.message_id
        ? { messageId: existingPending.message_id as string, clientId: existingPending.client_id as string | undefined }
        : null;
    if (!ref) return;
    try {
      await cancelPendingSend(conversationId, ref, existingPending?.content ?? sentContentRef.current);
      setPendingMessageId(null);
      setSentAt(null);
      setShowStuckBanner(false);
      setIsResuming(false);
      sentContentRef.current = null;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel message");
    }
  }, [conversationId, pendingMessageId, existingPending]);

  useWatchEffect(() => {
    // Clear the spinner/banner the moment the session shows life. isAgentActive (daemon
    // heartbeat) is the fast, authoritative signal that the agent is alive — working,
    // thinking, compacting, or waiting on input — so there's nothing to recover.
    if (isResuming && (isConversationLive || isThinking || isAgentActive || messageReachedSession)) {
      setIsResuming(false);
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
    if (autoRestartTriggeredRef.current || hostedConversation) return;
    if (messageStatus?.status !== "undeliverable") return;
    if (isAgentActive || messageReachedSession) return;
    if (!conversationId || !isConvexId(conversationId)) return;
    autoRestartTriggeredRef.current = true;
    toast("Message couldn't be delivered — restarting session…");
    requestSessionRestart(conversationId, ghostRestartContext())
      .then((res) => { handleRestartResult(res); setIsResuming(true); })
      .catch((err) => {
        if (isParkedDispatchError(err)) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (/conversation_deleted/i.test(msg)) {
          useInboxStore.getState().markServerDeleted(conversationId);
          toast.error("This conversation no longer exists on the server", { description: "Use Restore to bring its session back." });
        } else {
          captureError(err instanceof Error ? err : new Error(msg), { source: "auto-restart-undeliverable", conversationId });
          toast.error(`Session restart failed: ${msg}`);
        }
      });
  }, [messageStatus?.status, isAgentActive, messageReachedSession, conversationId, ghostRestartContext, handleRestartResult, hostedConversation]);

  // The draft id with a debounced write in flight (lib/pendingDraftWrites).
  const draftPendingIdRef = useRef<string | null>(null);
  const cancelPendingDraft = useCallback(() => {
    if (draftPendingIdRef.current) cancelDraftWrite(draftPendingIdRef.current);
    draftPendingIdRef.current = null;
  }, []);

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
      cancelPendingDraft();
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
      cancelPendingDraft();
      if (staleRecheckTimerRef.current) clearTimeout(staleRecheckTimerRef.current);
      saveDraftSnapshot(convIdRef.current);
    };
  });

  const handleMessageChange = useCallback((val: string) => {
    setMessage(val);
    if (savedDraftRef.current !== null) {
      isSelectionEditedRef.current = true;
    }
    const cursorPos = textareaRef.current?.selectionStart ?? val.length;
    const textBefore = val.slice(0, cursorPos);
    const slashMatch = (skills?.length ?? 0) > 0 ? textBefore.match(SLASH_TRIGGER_RE) : null;
    const hashMatch = slashMatch ? null : textBefore.match(CHANNEL_TRIGGER_RE);
    if (slashMatch) {
      setAcTrigger({ type: "/", startPos: cursorPos - slashMatch[1].length - 1 });
      setAcIndex(0);
    } else if (hashMatch) {
      setAcTrigger({ type: "#", startPos: cursorPos - hashMatch[1].length - 1 });
      setAcIndex(0);
    } else {
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
      cancelPendingDraft();
      draftPendingIdRef.current = conversationId;
      scheduleDraftWrite(conversationId, () => {
        if (draftPendingIdRef.current === conversationId) draftPendingIdRef.current = null;
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
      });
    }
  }, [conversationId, skills, queryMentions, cancelPendingDraft]);

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

  // "Message to resume" speaks of a process; a hosted conversation has none.
  const isInactive = status && status !== "active" && !pendingMessageId && !hostedConversation;
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
  // The ghost suggestion in the empty composer (components/ComposerSuggestion):
  // the composer drives it through this handle from its keydown (Tab accepts,
  // ↑/↓ cycle) and blanks its own placeholder while the ghost is showing.
  const suggestionRef = useRef<ComposerSuggestionHandle | null>(null);
  const [ghostVisible, setGhostVisible] = useState(false);
  // Tell the host (compose popup) when Escape is spoken for by inner UI — the
  // lightbox, an image/queue chip selection, or the slash-command menu — so its
  // document-capture Escape listener stands down and the textarea handler above
  // gets to unwind that state instead of the whole dialog closing.
  useWatchEffect(() => {
    if (escapeOwnedRef) {
      escapeOwnedRef.current = acTrigger !== null || selectedImageIndex !== null || selectedQueueIndex !== null || lightboxImageIndex !== null || handoffOpen;
    }
  }, [escapeOwnedRef, acTrigger, selectedImageIndex, selectedQueueIndex, lightboxImageIndex, handoffOpen]);
  const setSessionHasQueuedMessages = useInboxStore((s) => s.setSessionHasQueuedMessages);
  useWatchEffect(() => {
    setSessionHasQueuedMessages(conversationId, queuedMessages.length > 0);
    return () => setSessionHasQueuedMessages(conversationId, false);
  }, [conversationId, queuedMessages.length, setSessionHasQueuedMessages]);
  // Pending review quotes and proposal answers (S39) count as sendable content:
  // handleSubmit auto-attaches them (attachReviewToMessage), so a bare Enter
  // with an empty input is a valid send. batchSendWords is the one home for
  // the counting; its flat object under useShallow keeps re-renders quiet.
  const batchWords = useInboxStore(useShallow((s) => batchSendWords(s.reviewComments[conversationId] ?? [])));
  const reviewCount = batchWords.applies + batchWords.answers + batchWords.quotes;
  // Hand this composer's send to the review bridge while mounted, so a
  // proposal ledger in the thread can press it. Only the conversation's own
  // composer attaches: a comment composer inside the same view never does.
  const reviewComposer = useReviewComposer();
  const attachSend = reviewComposer?.conversationId === conversationId ? reviewComposer.attachSend : undefined;
  const handleSubmitRef = useRef<((e: React.FormEvent) => Promise<unknown>) | null>(null);
  useWatchEffect(() => {
    if (!attachSend) return;
    attachSend(() => { void handleSubmitRef.current?.({ preventDefault: () => {} } as unknown as React.FormEvent); });
    return () => attachSend(null);
  }, [attachSend]);
  const hasContent = (composeMode ? composeHasContent : message.trim().length > 0) || pastedImages.length > 0 || queuedMessages.length > 0;
  // A showing ghost suggestion is content too: it can run several lines, and
  // the collapsed pill (narrow, fully rounded) bends that into an ellipse.
  const isExpanded = composeMode || !!onSubmitWithIntent || !!onSendAndAdvance || isFocused || message.length > 0 || ghostVisible || pastedImages.length > 0 || queuedMessages.length > 0 || reviewCount > 0 || !!branchMapNode;

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
  useWatchEffect(() => {
    const el = textareaRef.current;
    if (!FIELD_SIZING_SUPPORTED || !el) return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.borderBoxSize[0]?.blockSize;
      if (height !== undefined) setIsMultiline(Math.round(height) > 36);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [composeMode]);

  // Where the send controls sit. Beside a short draft they share its line;
  // once the draft would wrap against them, the whole cluster drops to its own
  // right-aligned row under the text, so the field gets the full width instead
  // of a gutter as tall as the box. The trigger measures the draft's text
  // width against the room beside the controls rather than reading the
  // rendered height: tucking widens the field, which can make the same text
  // fit on one line again, and a height check would then pull the controls
  // back up, wrap the text, and repeat forever. A measurement that undershoots
  // (an unparsed font, say) only leaves the text wrapping beside the controls
  // as before; it can never oscillate.
  const controlsRowRef = useRef<HTMLDivElement>(null);
  const [fitsBesideControls, setFitsBesideControls] = useState(true);
  const measureCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const measureFitsBesideControls = useCallback(() => {
    const ta = textareaRef.current;
    const row = controlsRowRef.current;
    if (!ta || !row) return;
    const text = messageRef.current;
    let fits = !text.includes("\n");
    if (fits && text) {
      const ctx = (measureCtxRef.current ??= document.createElement("canvas").getContext("2d"));
      if (ctx) {
        const font = getComputedStyle(ta);
        ctx.font = `${font.fontStyle} ${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
        // The cluster's own box is useless here: tucked, it spans the row.
        // Sum the buttons instead (gap-1 between them), so the reading is
        // the same in either state. gap-x-2 sits between the field and the
        // cluster, plus one character of slack so subpixel rounding never
        // lets the browser wrap text we measured as fitting.
        const buttons = Array.from(sendRef.current?.children ?? []) as HTMLElement[];
        const controls = buttons.reduce((w, b) => w + b.offsetWidth, 0) + Math.max(0, buttons.length - 1) * 4;
        const room = row.clientWidth - controls - 8 - ctx.measureText("M").width;
        fits = ctx.measureText(text).width <= room;
      }
    }
    setFitsBesideControls(fits);
  }, []);
  // isMultiline is a dep because it adds and removes the expand button, and
  // that flag lands from the textarea's ResizeObserver one render after the
  // text: shortening a long draft would otherwise measure against a button
  // that is about to leave, decide it does not fit, and never look again.
  useLayoutEffect(measureFitsBesideControls, [message, isMultiline, measureFitsBesideControls]);
  useWatchEffect(() => {
    const row = controlsRowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(measureFitsBesideControls);
    observer.observe(row);
    return () => observer.disconnect();
  }, [composeMode, measureFitsBesideControls]);
  const controlsTucked = !fitsBesideControls;

  const resetTextareaHeight = () => {
    if (FIELD_SIZING_SUPPORTED) return;
    const el = textareaRef.current;
    if (!el) return;
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
  // A conversation opened inline in a reveal band keeps its composer folded
  // (globals.css folds it until focused), so it never takes focus by itself.
  const inRevealBand = useContext(RevealInBandCtx);
  useWatchEffect(() => {
    // An open dialog owns focus — never yank it down to the composer behind it.
    if (hasOpenModal(textareaRef.current) || inRevealBand) return;
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

  useWatchEffect(() => {
    if (!clearInputRef) return;
    clearInputRef.current = () => {
      cancelPendingDraft();
      setMessage("");
      messageRef.current = "";
      clearAllImages(true);
      useInboxStore.getState().clearDraftFinal(convIdRef.current);
      textareaRef.current?.focus();
    };
    return () => { clearInputRef.current = null; };
  }, [clearInputRef, cancelPendingDraft, setMessage, clearAllImages]);

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
      // Shrink large pastes before they hit the wire (preview above already
      // rendered from the original blob, so this stays invisible to the user).
      // The shared helper retries a transient failure; a paste that reaches
      // the composer is sacred input and one dropped connection must not lose
      // it. It never throws — null means every attempt failed.
      const uploaded = await compressImage(file);
      const storageId = await uploadBlobToStorage(convex, uploaded, uploaded.type) as Id<"_storage"> | null;
      if (storageId) {
        // Draft first — it lands even if this composer instance has unmounted
        // (a state updater on a dead instance is a silent no-op).
        settleDraftImageUpload(previewUrl, storageId as string);
        setPastedImages(prev => prev.map(img => img.previewUrl === previewUrl ? { ...img, storageId, uploading: false } : img));
        return storageId as string;
      }
      console.error("[uploadImage] failed after retries");
      captureError(new Error("image upload failed after retries"), { source: "uploadImage", conversationId, bytes: uploaded.size, type: uploaded.type });
      toast.error("Failed to upload image");
      settleDraftImageUpload(previewUrl, null);
      clearImageByPreview(previewUrl);
      return null;
    })();
    pendingImageUploads.set(previewUrl, promise);
    return previewUrl;
  }, [convex, conversationId, addImagePlaceholder, clearImageByPreview]);

  // Every way an image reaches the composer (paste, drop, the compose
  // editor's paste) goes through here. A hosted assistant reads text only, so
  // there the image is turned away at once, in the server's own words, rather
  // than sent and refused after it shows as sent.
  const takeImage = useCallback((file: File) => {
    if (hostedConversation) {
      toast.error(HOSTED_IMAGE_REFUSAL, { id: "hosted-image-refusal" });
      return;
    }
    uploadImage(file);
  }, [hostedConversation, uploadImage]);

  useWatchEffect(() => {
    if (onDropFiles) {
      onDropFiles.current = (files: File[]) => {
        files.forEach(f => { if (f.type.startsWith("image/")) takeImage(f); });
      };
      return () => { if (onDropFiles) onDropFiles.current = null; };
    }
  }, [onDropFiles, takeImage]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let hasImage = false;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        if (!hasImage) { e.preventDefault(); hasImage = true; }
        const file = items[i].getAsFile();
        if (file) takeImage(file);
      }
    }
  }, [takeImage]);

  // Set when a submit could not commit its send (the optimistic row + outbox
  // enqueue refused). Read synchronously right after handleSubmit() is called:
  // everything up to the commit runs before its first await, so a caller that
  // dismisses its host on send (the compose popup) can tell a committed send
  // from a refused one without waiting for delivery.
  const submitRefusedRef = useRef(false);
  // The hosted assistant reads no images. Intake already refuses a new one,
  // but a restored draft can still carry some: a send holding any is refused
  // whole and the composer keeps everything, so nothing is dropped silently.
  const refuseHostedImages = (count: number): boolean => {
    if (!hostedConversation || count === 0) return false;
    toast.error(HOSTED_IMAGE_REFUSAL, { id: "hosted-image-refusal" });
    submitRefusedRef.current = true;
    return true;
  };
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (allowanceOut) return false;
    submitRefusedRef.current = false;
    setAcTrigger(null);
    // In compose mode, read content from the TipTap editor
    let message = composeMode && composeRef.current
      ? composeRef.current.getMarkdown()
      : messageRef.current;
    suggestionRef.current?.settleSend(message);
    if (onGateSend) {
      // The pending batch rides a gate send the way it rides the main one:
      // the quotes, and a proposal's answers (org-staffing.md S39), lead the
      // text and are taken here, so a bare Enter with answers waiting is a
      // send. The gate's host receives the whole body and takes nothing.
      const text = attachReviewToMessage(conversationId, message).trim();
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
      if (refuseHostedImages(gateImages.length)) return;
      sendingRef.current = true;
      cancelPendingDraft();
      setMessage("");
      messageRef.current = "";
      // In-flight uploads go to the receiver with their blob and registry
      // entry (it releases them once settled); the settled ones are done with
      // theirs.
      pastedImagesRef.current.forEach(img => {
        if (img.uploading) return;
        pendingImageUploads.delete(img.previewUrl);
        URL.revokeObjectURL(img.previewUrl);
      });
      clearAllImages(false);
      useInboxStore.getState().clearDraftFinal(conversationId);
      sendingRef.current = false;
      await onGateSend(text, gateImages);
      return;
    }
    if (onWorkflowLaunch) {
      const goal = message.trim();
      sendingRef.current = true;
      cancelPendingDraft();
      setMessage("");
      messageRef.current = "";
      useInboxStore.getState().clearDraftFinal(conversationId);
      sendingRef.current = false;
      await onWorkflowLaunch(goal);
      return;
    }
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
    if (refuseHostedImages(submitImages.length)) return false;
    // Auto-attach any pending review quotes/comments so a plain send carries them —
    // no separate "add to message" step. They prepend the typed reply and the batch
    // is cleared. (The gate path above takes it the same way; workflow does not.) Images
    // quoted from the gallery ride along as attachments after the composer's own,
    // and each quote names its picture by that attachment number. A fork from a
    // selection sends text only, so its image quotes point by address instead.
    const forkingFromSelection = !!(isSelectionActive && selectedMessageUuid && onForkFromMessage);
    // Each quoted picture is sent as a copy with its notes' points drawn on as
    // numbered markers; the bubble shows the original until that copy lands.
    const quoted = forkingFromSelection ? [] : quotedImages(conversationId);
    message = attachReviewToMessage(conversationId, message, quoted.length ? submitImages.length + 1 : undefined);
    // "Send together" (lib/jointSend): others' live drafts fold in as named parts.
    if (!forkingFromSelection) message = takeJointSend(conversationId, message);
    const quotedOriginals: OptimisticImage[] = quoted.map(q => ({ media_type: "image/png", storage_id: q.storageId }));
    const quotedUploads = quoted.map(q => uploadMarkedImage(convex, q));
    const hasUploadingImages = submitImages.some(img => img.uploading) || quotedUploads.length > 0;
    const canSend = message.trim() || submitImages.length > 0;
    if (!canSend) return;

    // If a message is selected, fork from it then send the new content
    if (forkingFromSelection) {
      sendingRef.current = true;
      cancelPendingDraft();
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
    const optimisticImages: OptimisticImage[] = [...submitImages.map((img): OptimisticImage =>
      img.storageId
        ? { media_type: img.file.type, storage_id: img.storageId as string }
        : { media_type: img.file.type, preview_url: img.previewUrl, uploading: true }
    ), ...quotedOriginals];
    sendingRef.current = true;
    let clientId: string;
    try {
      clientId = addOptimistic(targetConvId, trimmed, optimisticImages.length > 0 ? optimisticImages : undefined);
    } catch (error) {
      captureException(error);
      sendingRef.current = false;
      setMessage(message);
      messageRef.current = message;
      if (composeMode) composeRef.current?.setMarkdown(message);
      toast.error(error instanceof Error ? error.message : "Could not save your message. Please try again.");
      submitRefusedRef.current = true;
      return false;
    }
    cancelPendingDraft();
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
        setSentAt(Date.now());
        sentContentRef.current = trimmed;
        setShowStuckBanner(false);
      } catch (error) {
        // `parked` means createSession is already in the durable outbox. Keep
        // the optimistic bubble pending; the rekey continuation sends it with
        // the same clientId once the real conversation row arrives.
        if (isParkedDispatchError(error)) {
          return;
        }
        toast.error(error instanceof Error ? error.message : "Failed to send message");
        useInboxStore.getState().markOptimisticAsFailed(targetConvId, clientId);
      }
    };

    if (hasUploadingImages) {
      // Detached: finish the in-flight uploads (the composer's and the marked
      // copies of quoted pictures), swap the bubble's previews for
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
        const resolvedImages: OptimisticImage[] = [...settled
          .filter(t => t.storageId)
          .map(t => ({ media_type: t.mediaType, storage_id: t.storageId as string })),
          ...(await Promise.all(quotedUploads)).map(storage_id => ({ media_type: "image/png", storage_id }))];
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
    let queued: { content: string; clientId: string } | undefined;
    try {
      queued = useInboxStore.getState().takeQueuedMessage(queueTargetConvId);
    } catch (error) {
      captureException(error);
      queueDrainingRef.current = false;
      toast.error(error instanceof Error ? error.message : "Could not save the queued message.");
      return;
    }
    if (!queued) { queueDrainingRef.current = false; return; }
    const { content: next, clientId } = queued;
    setSelectedQueueIndex(null);
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
    void handleSubmit({ preventDefault: () => {} } as unknown as React.FormEvent).then(saved => { if (saved !== false) onSendAndDismiss(); });
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
    cancelPendingDraft();
    composeRef.current?.clear();
    setMessage("");
    messageRef.current = "";
    useInboxStore.getState().clearDraftFinal(conversationId);
    sendingRef.current = false;
    onForkSend(text);
    onMessageSent?.();
  };

  // Hand off: the box empties the moment a teammate is picked (the marker is
  // drawn optimistically), and the text comes back only if the server refuses.
  const handleHandoffPick = (target: { id: string; name: string }, keepSelf: boolean) => {
    const raw = composeMode && composeRef.current ? composeRef.current.getMarkdown() : message;
    const text = raw.trim();
    sendingRef.current = true;
    cancelPendingDraft();
    composeRef.current?.clear();
    setMessage("");
    messageRef.current = "";
    useInboxStore.getState().clearDraftFinal(conversationId);
    sendingRef.current = false;
    textareaRef.current?.focus();
    void owners.handoffTo(target.id, text, { keepSelf }).then((ok) => {
      if (ok) { onMessageSent?.(); return; }
      if (composeMode && composeRef.current) composeRef.current.setMarkdown?.(text);
      setMessage(text);
      messageRef.current = text;
    });
  };
  const openHandoff = (open: boolean) => {
    setHandoffOpen(open);
    if (!open) requestAnimationFrame(() => textareaRef.current?.focus());
  };

  // The image strip and the queue take keys while the caret stays in the
  // textarea, so any sign the user is back on the text (a click in it, an
  // edit) ends that selection before a key meant for words reaches it. The
  // lightbox stays up so the image can be read while typing about it.
  const leaveStripSelection = () => {
    setSelectedImageIndex(null);
    setSelectedQueueIndex(null);
  };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (canHandoff && e.altKey && e.shiftKey && e.code === "KeyH") {
      e.preventDefault();
      setHandoffOpen(true);
      return;
    }
    if (acTrigger && acItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcIndex(i => Math.min(i + 1, acItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
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

    // The ghost suggestion in an empty composer: Tab takes it, ↓ steps through
    // the alternatives (it wraps). Typing anything replaces it, so no key is
    // spent on dismissing. ↑ is not the ghost's: from the input it climbs into
    // the transcript (climbIntoTranscript below).
    const ghost = suggestionRef.current;
    if (ghost?.visible() && !message) {
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        ghost.accept();
        return;
      }
      if (e.key === "ArrowDown" && ghost.count() > 1) {
        e.preventDefault();
        ghost.cycle(1);
        return;
      }
    }

    // Leave the input for the transcript: the last reply becomes the review
    // target at its last chunk, and the same ↑/↓ (or ⌥K/⌥J) then walk the
    // quotable chunks across replies; ↓ past the last one lands back here.
    // Reached from the top rung of whatever sits above the text — the image
    // strip, then the queue — and from the caret at the very start of the
    // text (matching how those rungs take ↑). ⌥K / ⌥↑ climb from anywhere.
    const climbIntoTranscript = () => {
      if (!enterReviewFromComposer()) return false;
      leaveStripSelection();
      setLightboxImageIndex(null);
      return true;
    };
    // Only a bare Backspace/Delete removes a queue item. ⌥/⌘/Ctrl+Backspace
    // are word and line deletes in the text, so they leave the queue alone.
    // Images have no delete key: a Backspace meant for words would lose one,
    // so only the thumbnail's × removes an image.
    const isStripDelete = (e.key === "Backspace" || e.key === "Delete") && !e.altKey && !e.metaKey && !e.ctrlKey;
    if (altChordDirection(e.nativeEvent) === "up" && climbIntoTranscript()) {
      e.preventDefault();
      return;
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
        // ↑ from the image strip climbs to the queue row above it, or on into
        // the transcript when there is no queue.
        if (queuedMessages.length > 0) {
          setSelectedImageIndex(null);
          setLightboxImageIndex(null);
          setSelectedQueueIndex(queuedMessages.length - 1);
        } else {
          climbIntoTranscript();
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedImageIndex(null);
        setLightboxImageIndex(null);
        return;
      }
    }

    if (selectedQueueIndex !== null && queuedMessages.length > 0) {
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        // ↑ from the top queue row climbs on into the transcript.
        if (selectedQueueIndex === 0 && e.key === "ArrowUp") climbIntoTranscript();
        else setSelectedQueueIndex(Math.max(0, selectedQueueIndex - 1));
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
      if (isStripDelete) {
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

    if (e.key === "ArrowUp" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      const textarea = textareaRef.current;
      if (textarea && textarea.selectionStart === 0 && textarea.selectionEnd === 0 && climbIntoTranscript()) {
        e.preventDefault();
        return;
      }
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (lightboxImageIndex !== null) {
        setLightboxImageIndex(null);
        return;
      }
      const hasText = messageRef.current.trim().length > 0;
      // A hosted conversation has no agent to send Escape to: an empty
      // composer hands the keys back to the app, so its single-key layer
      // (?, j/k, c) works without the mouse.
      if (hostedConversation && !hasText && queuedMessages.length === 0) {
        textareaRef.current?.blur();
        return;
      }
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
      // A REFUSED commit (the row could not be saved) must not dismiss: the
      // popup would close over an unsent message and its error toast, and the
      // typed text would be gone with it. Keep the popup up so the toast is
      // seen and Enter can be pressed again.
      void handleSubmit(e);
      if (submitRefusedRef.current) return;
      onSubmitWithIntent(navigate);
      return;
    }
    // Send together: my draft and everyone else's in this composer, one turn.
    if (e.key === "Enter" && e.altKey && (isMac ? e.metaKey : e.ctrlKey && e.shiftKey) && jointSendReady(conversationId)) {
      e.preventDefault();
      armJointSend(conversationId);
      void handleSubmit(e);
      return;
    }
    // Fork-and-send: branch the session from its latest message and deliver the
    // composed text into the fork, leaving the parent thread untouched.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && onForkSend) {
      e.preventDefault();
      handleForkSend();
      return;
    }
    // ⌘↵ QUEUES for a busy session, and the queue drains when the agent frees
    // up. A gated composer — a comment on a commit, a thread on a diff line —
    // has no session behind it, so nothing ever drains that queue and the same
    // chord swallowed the comment with no error. There it posts instead, which
    // is what the composer's own hint promised and what anyone arriving from
    // GitHub presses.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (onGateSend) { void handleSubmit(e); return; }
      const text = message.trim();
      if (text) {
        sendingRef.current = true;
        try {
          // A real session queues on the server, in the line everyone in it
          // sees and steers (SharedQueue). A session still being created, or
          // a hosted one (its turn engine takes input its own way), keeps the
          // queue in this window.
          if (canQueryServer && !hostedConversation) useInboxStore.getState().queueMessage(conversationId, text, `queued_${Date.now()}_${Math.random().toString(36).slice(2)}`);
          else setQueuedMessages(prev => [...prev, text]);
        } catch (error) {
          captureException(error);
          sendingRef.current = false;
          toast.error(error instanceof Error ? error.message : "Could not save the queued message.");
          return;
        }
        cancelPendingDraft();
        setMessage("");
        messageRef.current = "";
        useInboxStore.getState().clearDraftFinal(conversationId);
        sendingRef.current = false;
        setSelectedQueueIndex(null);
      }
      return;
    }
    if (e.key === "Enter" && e.altKey && e.shiftKey && onSendAndDismiss && triageShown) {
      e.preventDefault();
      handleSubmit(e).then(saved => { if (saved !== false) onSendAndDismiss(); });
      return;
    }
    if (e.key === "Enter" && e.altKey && !e.shiftKey && onSendAndAdvance) {
      e.preventDefault();
      handleSubmit(e).then(saved => { if (saved !== false) onSendAndAdvance(); });
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
    if (submitRefusedRef.current) return;
    onSubmitWithIntent?.(false);
  };

  handleSubmitRef.current = handleSubmit;
  const canSubmit = (hasContent || reviewCount > 0) && !allowanceOut;
  // When the send is carried entirely by attached quotes, tint the button cyan to
  // match the tray so it reads as "this sends the quotes".
  const quotesOnlySend = !hasContent && reviewCount > 0;
  const { colWidth, colClass } = composerColumn({ inline, expanded: isExpanded });
  // A hosted turn at work with an empty box: the disc is the visible Stop
  // (store stopHostedTurn), so stopping never rests on a key a person who
  // does not code would not know.
  const hostedStop = hostedConversation && (agentStatus === "working" || agentStatus === "thinking") && !canSubmit
    ? { label: MODE_WORDS.hosted.stopWorking, onStop: () => useInboxStore.getState().stopHostedTurn(conversationId) }
    : undefined;
  const sendButton = <ComposerSendButton canSubmit={canSubmit} bare={bareComposer} quotesOnly={quotesOnlySend} title={allowanceOut ?? undefined} label={batchWords.button ?? undefined} stop={hostedStop} />;
  // Expand, stash, hand off and fork: beside the text, or in the surface's foot
  // row next to send when it brings one.
  const rowActions = (
    <>
      {composeMode ? (
        <button
          type="button"
          onClick={toggleCompose}
          className="w-7 h-7 rounded-full transition-colors flex items-center justify-center text-sol-text-dim hover:text-sol-text hover:bg-sol-bg/50"
          title="Collapse editor (Cmd+Shift+E)"
        >
          <Minimize2 className="w-3.5 h-3.5" />
        </button>
      ) : isMultiline && (
        // A hosted conversation's phone composer is the text and Send alone.
        <button
          type="button"
          onClick={toggleCompose}
          className={`w-7 h-7 rounded-full transition-colors flex items-center justify-center text-sol-text-dim/30 hover:text-sol-text-dim hover:bg-sol-bg/50 ${hostedConversation ? "max-md:hidden" : ""}`}
          title="Expand editor (Cmd+Shift+E)"
        >
          <Maximize2 className="w-3 h-3" />
        </button>
      )}
      {onSendAndDismiss && triageShown && canSubmit && !onGateSend && !onWorkflowLaunch && (
        <ShortcutTooltip label="Send and stash" action="msg.sendDismiss" hint="the agent keeps running out of the inbox" side="top">
          <button
            type="button"
            onClick={handleSendAndStash}
            className="w-7 h-7 rounded-full transition-colors flex items-center justify-center text-[color-mix(in_srgb,var(--sol-text-dim)_40%,transparent)] hover:text-sol-yellow hover:bg-sol-yellow/10"
            aria-label="Send and stash"
          >
            <Archive className="w-3.5 h-3.5" />
          </button>
        </ShortcutTooltip>
      )}
      {canHandoff && (
        <HandoffPicker owners={owners} conversationId={conversationId} note={composeMode && composeRef.current ? composeRef.current.getMarkdown() : message} open={handoffOpen} onOpenChange={openHandoff} onPick={handleHandoffPick}>
          <ShortcutTooltip label="Hand off to a teammate" action="msg.handoff" hint="your message goes along as the note" side="top">
          <button
            type="button"
            className={`w-7 h-7 rounded-full transition-colors flex items-center justify-center ${handoffOpen ? "text-sol-violet bg-sol-violet/15" : "text-[color-mix(in_srgb,var(--sol-text-dim)_40%,transparent)] hover:text-sol-violet hover:bg-sol-violet/10"}`}
            aria-label="Hand off to a teammate"
            onClick={() => openHandoff(!handoffOpen)}
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
          </button>
          </ShortcutTooltip>
        </HandoffPicker>
      )}
      {onForkSend && !hostedConversation && canSubmit && !onGateSend && !onWorkflowLaunch && (
        <button
          type="button"
          onClick={handleForkSend}
          className="w-7 h-7 rounded-full transition-colors flex items-center justify-center text-[color-mix(in_srgb,var(--sol-text-dim)_40%,transparent)] hover:text-sol-cyan hover:bg-sol-cyan/10"
          title={`Fork and send (${navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+Shift+Enter)`}
        >
          <Split className="w-3.5 h-3.5" />
        </button>
      )}
    </>
  );

  return (
    <ComposerShell
      rootRef={composerRootRef}
      inline={inline}
      bare={bareComposer}
      expanded={isExpanded}
      lightboxOpen={lightboxImageIndex !== null}
      composeMode={composeMode}
      selectionActive={isSelectionActive}
      onSubmit={handleFormSubmit}
      foot={composerFoot && !composeMode ? <ComposerFoot start={composerFoot} end={<>{rowActions}{sendButton}</>} /> : undefined}
      before={<>
          {serverDeleted && !isRestarting && (
            <div className={`mx-auto mb-2 ${inline ? "" : "px-4"} ${colWidth} ${lightboxImageIndex !== null ? "hidden" : ""}`}>
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
          {!bareComposer && lightboxImageIndex === null && agentStatus === "compacting" && (
            <LiveCompactionCard conversationId={conversationId} expanded={isExpanded} />
          )}
      </>}
      meta={hostedConversation ? (
                  <HostedStatusLine
                    conversationId={conversationId}
                    agentStatus={agentStatus}
                    phrase={workingPhrase}
                    sending={!!(pendingMessageId || existingPending || hasPendingSend)}
                    allowanceOut={allowanceOut}
                    escapeHint={!escapeCloses && isFocused && message.length === 0}
                    awaitsOk={hostedAwaitsOk}
                    stopInDisc={!!hostedStop && !bareComposer}
                  />
                ) : ((isSessionStarting && !agentStatus) || isAgentStarting) && !showStuckBanner ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    Starting session...
                  </span>
                ) : pendingRowHoldReason(existingPending) ? (
                  // Held on purpose: the message's bubble says why, and nothing is being processed.
                  null
                ) : (pendingMessageId || existingPending) && !showStuckBanner && (isAgentStarting || isAgentDelivering) ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    {agentStatus === "resuming" ? "Resuming session..." : isAgentStarting ? "Starting session..." : "Delivering..."}
                  </span>
                ) : (pendingMessageId || existingPending) && !showStuckBanner && !agentStatus ? (
                  runnerSilence ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-sol-text-dim/50" />
                      Waiting for {runnerSilence}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                      Processing...
                    </span>
                  )
                ) : limitPhase.phase === "recovering" && !showStuckBanner ? (
                  <span className="flex items-center gap-1.5 text-sol-cyan">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan animate-pulse" />
                    {limitPhase.step === "resuming"
                      ? "Recovering · picking up where it left off"
                      : `Recovering · restarting on ${limitPhase.action.target ?? "an account with room"}`}
                  </span>
                ) : limitParkedAt != null && !showStuckBanner && (!agentStatus || agentStatus === "idle" || agentStatus === "connected") ? (
                  <span className="flex items-center gap-1.5 text-amber-500">
                    <span className="w-2 h-2 rounded-full bg-amber-500" />
                    {limitResetAt != null && limitResetAt > limitNow
                      ? `Usage limit · resets in ${formatCountdown(limitResetAt - limitNow)}`
                      : limitResetAt != null
                        ? "Usage limit · window open — send continue"
                        : "Usage limit · parked until the window resets"}
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
                ) : agentStatus === "hibernated" ? (
                  /* The parked session's one home in the conversation: the
                     header and the inbox row stay quiet about it. */
                  <span data-hibernated-marker className="flex items-center gap-1.5 text-sol-blue">
                    <span className="w-2 h-2 rounded-full bg-sol-blue/70" />
                    {HIBERNATED_COPY}
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
                  <WorkingStatusLine startedAt={workingSinceTs} phrase={workingPhrase} conversationId={conversationId} stopHint={!!onSendEscape && !message.trim() && queuedMessages.length === 0} />
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
                  <WorkingStatusLine startedAt={workingSinceTs} phrase={workingPhrase} conversationId={conversationId} stopHint={!!onSendEscape && !message.trim() && queuedMessages.length === 0} />
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
                ) : hasPendingSend ? (
                  <span className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-sol-cyan/50 animate-pulse" />
                    {hostedConversation ? "Sending…" : "Resuming session..."}
                  </span>
                ) : isInactive ? "Session idle — message to resume" : "\u00A0"}
      // A hosted conversation has no Claude Code permission mode to cycle: its
      // status line owns the whole meta row.
      metaEnd={permissionMode && !hostedConversation && (
                  <div className="relative" data-composer-mode={permissionMode}>
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { onCycleMode?.(); flashModeLabel(); }}
                      onMouseEnter={() => setModeTooltip(true)}
                      onMouseLeave={() => setModeTooltip(false)}
                      className="flex items-center gap-1.5"
                    >
                      {/* The dot pulses while the daemon walks the session's
                          cycle and reads the landing mode back off the pane;
                          it settles the moment the observed mode arrives. */}
                      <div className={`w-2 h-2 rounded-full transition-colors ${permissionModePending ? "animate-pulse" : ""} ${
                        permissionMode === "plan" ? "bg-sol-blue" :
                        permissionMode === "acceptEdits" ? "bg-emerald-400" :
                        permissionMode === "bypassPermissions" ? "bg-orange-500" :
                        permissionMode === "auto" ? "bg-sol-violet" :
                        permissionMode === "dontAsk" ? "bg-sol-yellow" :
                        "bg-sol-base00/50"
                      }`} />
                      {/* The mode label appears for a beat when the mode
                          cycles, then collapses back to the dot. Hover the
                          dot for the full name. */}
                      {permissionMode !== "default" && (
                        <span
                          className={`text-[10px] font-mono transition-[opacity,transform] duration-150 ease-out overflow-hidden whitespace-nowrap ${
                            showModeLabel ? "max-w-[80px] opacity-100 translate-x-0" : "max-w-0 opacity-0 -translate-x-1"
                          } ${
                            permissionMode === "plan" ? "text-sol-blue" :
                            permissionMode === "acceptEdits" ? "text-emerald-400" :
                            permissionMode === "bypassPermissions" ? "text-orange-500" :
                            permissionMode === "auto" ? "text-sol-violet" :
                            "text-sol-yellow"
                          }`}
                        >
                          {permissionMode === "plan" ? "plan" :
                           permissionMode === "acceptEdits" ? "accept edits" :
                           permissionMode === "bypassPermissions" ? "bypass" :
                           permissionMode === "auto" ? "auto" :
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
                          permissionMode === "auto" ? "text-sol-violet" :
                          permissionMode === "dontAsk" ? "text-sol-yellow" :
                          "text-sol-text-dim"
                        }>
                          {permissionMode === "default" ? "default" :
                           permissionMode === "plan" ? "plan mode" :
                           permissionMode === "acceptEdits" ? "accept edits" :
                           permissionMode === "bypassPermissions" ? "bypass permissions" :
                           permissionMode === "auto" ? "auto mode" :
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
      between={<>
          {/* The pinned thread state slots between the status line and the
              box: the status line says what the session is doing right now,
              the pinned state says where the work stands, the box is where you
              answer. Reading top to bottom, that is the order a person needs
              them in. */}
          {threadStateNode}
          {composerNode}
          {acTrigger && (acItems.length > 0 || (acTrigger.type === "@" && acServerLoading && !acQuery.includes(" "))) && (() => {
            const chatKey = parseChatDraftKey(conversationId);
            const dropdown = (
              <div
                ref={acRef}
                className={chatMentionMode
                  ? "absolute bottom-0 mb-1.5 z-30"
                  : `mx-auto mb-1.5 ${colClass}`}
                style={chatMentionMode ? { left: acCaretLeft, width: CHAT_AC_WIDTH, maxWidth: "min(100%, calc(100vw - 24px))" } : undefined}
              >
                <MentionMenu
                  style={chatMentionMode ? { maxHeight: acRoomAbove } : undefined}
                  items={acItems}
                  selectedIndex={clampedAcIndex}
                  onHover={setAcIndex}
                  onPick={(index) => applyAutocomplete(acItems[index])}
                  query={acQuery}
                  loading={acTrigger.type === "@" && acServerLoading}
                  heading={acTrigger.type === "/" ? "Commands" : undefined}
                  contextTitle={chatKey ? (chatKey.threadRootId ? "In this thread" : "In this channel") : "In this conversation"}
                />
              </div>
            );
            if (!chatMentionMode) return dropdown;
            // Zero height on purpose: it contributes no layout, only the
            // positioning context the caret-anchored popup hangs from.
            return <div ref={acAnchorRef} className="relative h-0">{dropdown}</div>;
          })()}
      </>}
      fieldTop={<>
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
                      <span className="inline-flex items-center gap-1"><KeyCap size="xs">Esc</KeyCap> exit</span>
                    </span>
                  )}
                </div>
              )}
      </>}
      after={lightboxImageIndex !== null && pastedImages[lightboxImageIndex] && createPortal(
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
        composerRootRef.current?.closest<HTMLElement>('[role="dialog"][aria-modal="true"]') ?? document.body
      )}
    >
              {composeMode ? (
                <div className="flex flex-col flex-1 min-h-0">
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <Suspense fallback={null}>
                      <ComposeEditor
                        ref={composeRef}
                        initialContent={message}
                        onMentionQuery={composeMentionQuery}
                        onImagePaste={takeImage}
                        onSubmit={() => handleFormSubmit({ preventDefault: () => {} } as any)}
                        onExit={toggleCompose}
                        onContentChange={setComposeHasContent}
                        placeholder="Compose your message... / for commands, @ to mention"
                      />
                    </Suspense>
                  </div>
                  <div className="flex items-center justify-between pt-2 mt-1 border-t border-sol-border/20">
                    <span className="text-[10px] text-sol-text-dim/50 select-none">
                      {navigator.platform?.includes("Mac") ? "Cmd" : "Ctrl"}+Enter send &middot; Esc collapse
                    </span>
                    <div ref={sendRef} className="flex items-center gap-1.5">
                      {rowActions}
                      {sendButton}
                    </div>
                  </div>
                </div>
              ) : (
                <ComposerTextRow
                  rowRef={controlsRowRef}
                  sendRef={sendRef}
                  tucked={controlsTucked}
                  send={composerFoot ? undefined : sendButton}
                  actions={composerFoot ? undefined : rowActions}
                >
                  <ComposerTextarea
                    ref={textareaRef}
                    data-chat-input
                    data-composer-field
                    data-draft-conv={conversationId}
                    value={message}
                    onChange={(e) => { leaveStripSelection(); handleMessageChange(e.target.value); }}
                    onMouseDown={leaveStripSelection}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => { setIsFocused(false); setAcTrigger(null); }}
                    placeholder={ghostVisible ? "" : composerPlaceholder ?? (bareComposer ? "Comment…" : onGateSend ? "Send a message to continue the workflow..." : onWorkflowLaunch ? "Goal override (optional) — press send to run workflow..." : reviewCount > 0 ? (batchWords.placeholder ?? `Send ${batchWords.quotes} quote${batchWords.quotes !== 1 ? "s" : ""} as-is, or add a reply first...`) : hostedConversation ? (allowanceOut ? allowanceOut : hostedComposerWords(hostedLast, hostedAwaitsOk)) : agentStatus === "permission_blocked" ? ((pendingPermissionsCount ?? 0) > 0 ? MODE_WORDS.developer.composerApproval : hasAskUserQuestion ? "Answer the question to continue..." : MODE_WORDS.developer.composerPlaceholder) : MODE_WORDS.developer.composerPlaceholder)}
                    dim={isSelectionActive && !isSelectionEditedRef.current}
                  />
                  {!bareComposer && suggestionsEnabled && !onGateSend && !onWorkflowLaunch && !hasAskUserQuestion && (
                    <ComposerSuggestion
                      ref={suggestionRef}
                      conversationId={conversationId}
                      idle={!isWaitingForResponse && !isThinking && !(agentStatus && ACTIVE_AGENT_STATUSES.has(agentStatus))}
                      hidden={!!message || pastedImages.length > 0}
                      onAccept={(t) => {
                        setMessage(t);
                        messageRef.current = t;
                        const ta = textareaRef.current;
                        if (ta) { ta.focus(); requestAnimationFrame(() => ta.setSelectionRange(t.length, t.length)); }
                      }}
                      onVisibleChange={setGhostVisible}
                    />
                  )}
                </ComposerTextRow>
              )}
    </ComposerShell>
  );
});
