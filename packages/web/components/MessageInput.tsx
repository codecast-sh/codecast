import { captureException } from "@sentry/react";
import { useLayoutEffect, useRef, useState, useMemo, useCallback, memo, lazy, Suspense } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { isMac, hasOpenModal, altChordDirection } from "../shortcuts";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { createPortal } from "react-dom";
import { compressImage } from "../lib/compressImage";
import { uploadBlobToStorage } from "../lib/uploadBlob";
import { textareaCaretRect } from "../lib/textareaCaret";
import { classifyApiErrorBanner, ACTIVE_AGENT_STATUSES, type AgentStatus } from "@codecast/shared/contracts";
import { useNowWhen } from "../hooks/useCoarseNow";
import { formatCountdown } from "@codecast/shared/contracts";
import { parseLimitResetAt } from "../lib/limitReset";
import { pendingImageUploads, persistDraftImages, restoreDraftImages, settleDraftImageUpload } from "../lib/draftImages";
import { isResentCopyOfSentMessage } from "../lib/staleDraft";
import type { SkillItem } from "../lib/conversationProcessor";
import { KeyCap, ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { toast } from "sonner";
import { appendToDraft } from "../lib/quoteFormat";
import { imagePlaceholderToken, insertImagePlaceholder, dropImagePlaceholder } from "../lib/imagePlaceholder";
import { attachReviewToMessage } from "../lib/reviewActions";
import { enterReviewFromComposer } from "../lib/reviewNav";
import { ReviewBar } from "./ReviewBar";
import { ComposerSuggestion, ComposerSuggestionHandle } from "./ComposerSuggestion";
import { useMutation, useQuery, useConvex } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { HandoffPicker, useOwnersFromStore } from "./OwnersBadge";
import { usePendingMessageStatus } from "../hooks/useSyncPendingPermissions";
import { useInboxStore, isConvexId, convHasPendingSend, type OptimisticImage } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { soundSend } from "../lib/sounds";
import type { MentionItem } from "./editor/MentionList";
import { MentionSuggestion } from "./editor/MentionSuggestion";
import { mergeMentionSuggestions, mentionViewTimes } from "../lib/mentionRanking";
import { Maximize2, Minimize2, Split, Archive, ArrowRightLeft } from "lucide-react";
import type { ComposeEditorHandle } from "./editor/ComposeEditor";
import { useMentionQuery, useMentionServerSearch, SERVER_MENTION_TYPES, matchScore, mentionItemMatches } from "../hooks/useMentionQuery";
import { isAliveIdleStatus, type LiveAgentStatus } from "../lib/pendingBanner";
import { expandEntityMentions } from "../lib/mentionExpansion";
import { identityLine } from "../lib/sessionIdentity";
import { personifyAllNow } from "../hooks/usePersonifyAll";
import { ghostRestartContextFor, deriveRestartStage } from "../hooks/useSessionRestart";
import { useSwipeToDismiss } from "./conversation/blocks/interactiveBlocks";
import { WorkingStatusLine, followRestoredConversation } from "./conversation/sessionChrome";

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

export const MessageInput = memo(function MessageInput({ conversationId, status, embedded, onSendAndAdvance, onSendAndDismiss, autoFocusInput, initialDraft, isWaitingForResponse, isThinking, isConversationLive, isSessionDisconnected, isSessionStarting, isSessionReady, sessionId, agentType, agentStatus, deliveryStatus, pendingPermissionsCount, hasAskUserQuestion, selectedMessageContent, selectedMessageUuid, onClearSelection, onForkFromMessage, onForkSend, onSendEscape, onOpenNavigator, onPopulateInput, permissionMode, permissionModePending, onCycleMode, onMessageSent, onLightboxChange, onDropFiles, onWorkflowLaunch, onGateSend, skills, filePaths, mentionItemsRef, onMentionQuery, onSubmitWithIntent, onDidSend, branchMapNode, threadStateNode, composerNode, bareComposer, chatMentionMode, mentionTeamId, composerPlaceholder, workingSinceTs, workingPhrase, escapeOwnedRef }: { conversationId: string; status?: string; embedded?: boolean; onSendAndAdvance?: () => void; onSendAndDismiss?: () => void; autoFocusInput?: boolean; initialDraft?: string; isWaitingForResponse?: boolean; isThinking?: boolean; isConversationLive?: boolean; isSessionDisconnected?: boolean; isSessionStarting?: boolean; isSessionReady?: boolean; sessionId?: string; agentType?: string; agentStatus?: AgentStatus; deliveryStatus?: string; pendingPermissionsCount?: number; hasAskUserQuestion?: boolean; selectedMessageContent?: string | null; selectedMessageUuid?: string | null; onClearSelection?: () => void; onForkFromMessage?: (uuid: string) => void; onForkSend?: (content: string) => void; onSendEscape?: () => void; onOpenNavigator?: () => void; onPopulateInput?: React.MutableRefObject<((text: string, opts?: { append?: boolean }) => void) | null>; permissionMode?: string; permissionModePending?: boolean; onCycleMode?: () => void; onMessageSent?: () => void; onLightboxChange?: (active: boolean) => void; onDropFiles?: React.MutableRefObject<((files: File[]) => void) | null>; onWorkflowLaunch?: (goal: string) => Promise<void>; onGateSend?: (content: string, images?: Array<{ storageId?: string; previewUrl: string; mime: string; uploading: boolean }>) => Promise<void>; skills?: SkillItem[]; filePaths?: string[]; mentionItemsRef?: React.MutableRefObject<MentionItem[]>; onMentionQuery?: (q: string) => void; onSubmitWithIntent?: (navigate: boolean) => void; onDidSend?: (info: { conversationId: string; content: string; clientId: string }) => void; branchMapNode?: React.ReactNode; threadStateNode?: React.ReactNode; composerNode?: React.ReactNode; bareComposer?: boolean; chatMentionMode?: boolean; mentionTeamId?: string; composerPlaceholder?: string; workingSinceTs?: number; workingPhrase?: string; escapeOwnedRef?: React.MutableRefObject<boolean> }) {
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
  const canHandoff = !bareComposer && !onGateSend && !onWorkflowLaunch && !chatMentionMode && isConvexId(conversationId) && !!owners.currentUser && owners.canManage !== false;
  // Narrowed: MessageInput only needs the session's team_id (for mention scope), which
  // never changes on a heartbeat. Subscribing to the whole row re-rendered the input
  // (and its draft textarea) ~1×/s for a live session.
  const composeTeamId = useInboxStore((s) => s.sessions[conversationId]?.team_id);
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
  // Re-render only when the countdown's printed minutes change.
  const limitNow = useNowWhen(
    (t) => (limitParkedAt == null ? "" : limitResetAt != null ? formatCountdown(limitResetAt - t) + (t >= limitResetAt ? "!" : "") : "parked"),
    30_000,
  );
  // Suggestion pills pref — off by default; the strip mounts only when on.
  const suggestionsEnabled = useInboxStore((s) => s.clientState?.ui?.composer_suggestions === true);
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
  const [pendingMessageId, setPendingMessageId] = useState<Id<"pending_messages"> | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [showStuckBanner, setShowStuckBanner] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  // Distinct from isResuming: true only while a destructive kill+restart is in flight, so the
  // footer can say "Killing & restarting" instead of the gentler "Waiting for connection".
  const [isRestarting, setIsRestarting] = useState(false);
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
    if (isRestarting) setIsRestarting(false);
    if (isResuming) setIsResuming(false);
    autoRestartTriggeredRef.current = false;
    autoResumeTriggeredRef.current = false;
  }
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
  type AcItem = Omit<MentionItem, "id"> & { id?: string; description?: string };
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
      // Chat mode's own vocabulary (docs/architecture/agent-channels.md C2):
      // the org roles of the active workspace answer to @handle, and a
      // session answers to its 7-char short id — offered once the query
      // starts "jx", from the 20 most recent in the store, so a room's people
      // and roles are never buried under every session the cache holds.
      const chatState = chatMentionMode ? useInboxStore.getState() : null;
      const roleItems: MentionItem[] = (chatState?.orgTree?.roles ?? [])
        .filter((r: any) => r.status !== "retired")
        .map((r: any) => ({
          id: String(r._id), type: "role", label: r.name, sublabel: `@${r.handle}`,
          handle: r.handle, shortId: r.short_id, updatedAt: r.updated_at,
        }));
      const recentSessionIds = chatState
        ? new Set(
            Object.values(chatState.sessions)
              .filter((sess: any) => !sess.is_subagent)
              .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
              .slice(0, 20)
              .map((sess: any) => String(sess._id)),
          )
        : null;
      const candidates = mergeMentionSuggestions(
        [...roleItems, ...(effectiveMentionItemsRef.current ?? [])], acServerItems,
        mentionViewTimes(useInboxStore.getState()),
      ).filter((m) => {
        if (chatMentionMode && (m.type === "label" || (m.type === "person" && !m.handle))) return false;
        if (chatMentionMode && m.type === "session" && !(acQuery.startsWith("jx") && recentSessionIds!.has(m.id))) return false;
        return mentionItemMatches(m, acQuery);
      });
      const items: AcItem[] = mergeMentionSuggestions(candidates, [], new Map(), acQuery ? 8 : 6, acQuery, personifyAllNow())
        .map((m) => ({ ...m, description: m.sublabel }));

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
  useWatchEffect(() => {
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
      if (chatMentionMode && (item.type === "person" || item.type === "role") && item.handle) {
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
          setIsRestarting(true);
          handleRestartResult(await convCommand(conversationId, "restartSession", ghostRestartContext()));
          return;
        } catch (err2) {
          if (isParkedDispatchError(err2)) return;
          useInboxStore.getState().markServerDeleted(conversationId);
          toast.error("This conversation no longer exists on the server", { description: "It couldn't be restored automatically." });
          setIsResuming(false);
          setIsRestarting(false);
          return;
        }
      }
      toast.error(msg || "Failed to resume session");
      setIsResuming(false);
      setIsRestarting(false);
    }
  }, [conversationId, convCommand, isResuming, isExistingMessageDead, messageStatus?.status, ghostRestartContext, handleRestartResult, serverDeleted]);

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
          toast.error("This conversation no longer exists on the server", { description: "Use Restore to bring its session back." });
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
      toast.error("Failed to upload image");
      settleDraftImageUpload(previewUrl, null);
      clearImageByPreview(previewUrl);
      return null;
    })();
    pendingImageUploads.set(previewUrl, promise);
    return previewUrl;
  }, [convex, conversationId, addImagePlaceholder, clearImageByPreview]);

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

  // Set when a submit could not commit its send (the optimistic row + outbox
  // enqueue refused). Read synchronously right after handleSubmit() is called:
  // everything up to the commit runs before its first await, so a caller that
  // dismisses its host on send (the compose popup) can tell a committed send
  // from a refused one without waiting for delivery.
  const submitRefusedRef = useRef(false);
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    submitRefusedRef.current = false;
    setAcTrigger(null);
    // In compose mode, read content from the TipTap editor
    let message = composeMode && composeRef.current
      ? composeRef.current.getMarkdown()
      : messageRef.current;
    suggestionRef.current?.settleSend(message);
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
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
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
    if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
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
    if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
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

  const acScrollRef = useRef(false);
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (canHandoff && e.altKey && e.shiftKey && e.code === "KeyH") {
      e.preventDefault();
      setHandoffOpen(true);
      return;
    }
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
      setSelectedImageIndex(null);
      setLightboxImageIndex(null);
      setSelectedQueueIndex(null);
      return true;
    };
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
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        setSelectedImageIndex(null);
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
      // A REFUSED commit (the row could not be saved) must not dismiss: the
      // popup would close over an unsent message and its error toast, and the
      // typed text would be gone with it. Keep the popup up so the toast is
      // seen and Enter can be pressed again.
      void handleSubmit(e);
      if (submitRefusedRef.current) return;
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
          setQueuedMessages(prev => [...prev, text]);
        } catch (error) {
          captureException(error);
          sendingRef.current = false;
          toast.error(error instanceof Error ? error.message : "Could not save the queued message.");
          return;
        }
        if (draftTimerRef.current) { clearTimeout(draftTimerRef.current); draftTimerRef.current = null; }
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
          {/* The composer's status line: always one row tall, so focusing the
              box or the agent changing state never shifts the composer. The
              left side carries the live status (or nothing); the right side
              is the send-options "?" and the permission mode dot. */}
          {!bareComposer && (
            <div data-cc-composer-meta className={`mx-auto px-2 sm:px-4 mb-1 min-h-[18px] flex justify-between items-center ${isExpanded ? "conv-col" : "max-w-md"} ${lightboxImageIndex !== null ? "hidden" : ""}`}>
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
                  <WorkingStatusLine startedAt={workingSinceTs} phrase={workingPhrase} conversationId={conversationId} />
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
                  <WorkingStatusLine startedAt={workingSinceTs} phrase={workingPhrase} conversationId={conversationId} />
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
                    Resuming session...
                  </span>
                ) : isInactive ? "Session idle — message to resume" : "\u00A0"}
              </p>
              <div className="flex items-center gap-2">
                {permissionMode && (
                  <div className="relative">
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
                          className={`text-[10px] font-mono transition-all duration-300 ease-out overflow-hidden whitespace-nowrap ${
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
              </div>
            </div>
          )}
          {/* The pinned thread state slots between the status line and the
              box: the status line says what the session is doing right now,
              the pinned state says where the work stands, the box is where you
              answer. Reading top to bottom, that is the order a person needs
              them in. */}
          {threadStateNode}
          {composerNode}
          {acTrigger && (acItems.length > 0 || (acTrigger.type === "@" && acServerLoading && !acQuery.includes(" "))) && (() => {
            const dropdown = (
              <div
                ref={acRef}
                className={chatMentionMode
                  ? "absolute bottom-0 mb-1 z-30"
                  : `mx-auto px-2 sm:px-4 mb-1 ${isExpanded ? "conv-col" : "max-w-md"}`}
                style={chatMentionMode ? { left: acCaretLeft, width: CHAT_AC_WIDTH } : undefined}
              >
                <div role="listbox" aria-label="Suggestions" className="bg-sol-bg border border-sol-border/50 rounded-lg shadow-xl py-1.5 max-h-[320px] overflow-y-auto overflow-x-hidden">
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-sol-text-dim">
                    {acTrigger.type === "@" ? "Recently viewed · then updated" : "Commands"}
                  </div>
                  {acItems.map((item, index) => {
                    const isSelected = index === clampedAcIndex;
                    return (
                      <button
                        key={`${item.type}:${item.id || item.label}`}
                        type="button"
                        data-mention-id={item.id}
                        role="option"
                        aria-selected={isSelected}
                        ref={isSelected ? (el) => { if (el && acScrollRef.current) { el.scrollIntoView({ block: "nearest" }); acScrollRef.current = false; } } : undefined}
                        onMouseEnter={() => setAcIndex(index)}
                        onMouseDown={(e) => { e.preventDefault(); applyAutocomplete(item); }}
                        className={`w-full text-left px-3 py-2 flex items-center gap-2.5 ${isSelected ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"}`}
                      >
                        <MentionSuggestion item={item} />
                      </button>
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
                    <Suspense fallback={null}>
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
                    </Suspense>
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
                      {canHandoff && (
                        <HandoffPicker owners={owners} conversationId={conversationId} note={composeMode && composeRef.current ? composeRef.current.getMarkdown() : message} open={handoffOpen} onOpenChange={openHandoff} onPick={handleHandoffPick}>
                          <ShortcutTooltip label="Hand off to a teammate" action="msg.handoff" hint="your message goes along as the note" side="top">
                          <button
                            type="button"
                            className={`w-7 h-7 rounded-full transition-all flex items-center justify-center ${handoffOpen ? "text-sol-violet bg-sol-violet/15" : "text-[color-mix(in_srgb,var(--sol-text-dim)_40%,transparent)] hover:text-sol-violet hover:bg-sol-violet/10"}`}
                            aria-label="Hand off to a teammate"
                            onClick={() => openHandoff(!handoffOpen)}
                          >
                            <ArrowRightLeft className="w-3.5 h-3.5" />
                          </button>
                          </ShortcutTooltip>
                        </HandoffPicker>
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
                <div ref={controlsRowRef} className="flex flex-wrap items-end gap-x-2 gap-y-1">
                  {/* One grid cell for the textarea and the ghost suggestion: the
                      cell takes the taller of the two, so a wrapped suggestion
                      grows the box and the textarea stretches to cover it. */}
                  <div className="grid flex-1 min-w-0">
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
                    placeholder={ghostVisible ? "" : composerPlaceholder ?? (bareComposer ? "Comment…" : onGateSend ? "Send a message to continue the workflow..." : onWorkflowLaunch ? "Goal override (optional) — press send to run workflow..." : reviewCount > 0 ? `Send ${reviewCount} quote${reviewCount !== 1 ? "s" : ""} as-is, or add a reply first...` : agentStatus === "permission_blocked" ? ((pendingPermissionsCount ?? 0) > 0 ? "Approve or deny permission to continue..." : hasAskUserQuestion ? "Answer the question to continue..." : "Send a message...") : "Send a message...")}
                    rows={1}
                    style={FIELD_SIZING_STYLE}
                    className={`block w-full [grid-area:1/1] bg-transparent text-sm placeholder:text-sol-text-dim focus:outline-none disabled:opacity-50 resize-none overflow-hidden leading-relaxed py-1 ${isSelectionActive && !isSelectionEditedRef.current ? "text-sol-text-dim italic" : "text-sol-text"}`}
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
                  </div>
                  <div ref={sendRef} className={`shrink-0 flex items-end gap-1 ${controlsTucked ? "basis-full justify-end" : ""}`}>
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
                    {canHandoff && (
                      <HandoffPicker owners={owners} conversationId={conversationId} note={composeMode && composeRef.current ? composeRef.current.getMarkdown() : message} open={handoffOpen} onOpenChange={openHandoff} onPick={handleHandoffPick}>
                        <ShortcutTooltip label="Hand off to a teammate" action="msg.handoff" hint="your message goes along as the note" side="top">
                        <button
                          type="button"
                          className={`w-7 h-7 mb-0.5 rounded-full transition-all flex items-center justify-center ${handoffOpen ? "text-sol-violet bg-sol-violet/15" : "text-[color-mix(in_srgb,var(--sol-text-dim)_40%,transparent)] hover:text-sol-violet hover:bg-sol-violet/10"}`}
                          aria-label="Hand off to a teammate"
                          onClick={() => openHandoff(!handoffOpen)}
                        >
                          <ArrowRightLeft className="w-3.5 h-3.5" />
                        </button>
                        </ShortcutTooltip>
                      </HandoffPicker>
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
