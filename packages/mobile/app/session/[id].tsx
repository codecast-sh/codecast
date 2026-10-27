import { captureError } from '@/lib/analytics';
import { MOVE_VERBS, moveAgentOptions, sessionMoveVerbs } from '@codecast/web/lib/sessionControl';
import { forkSessionAsAgent, sessionRowFor, switchSessionAgent } from '@codecast/web/lib/sessionAgentActions';
import { usePinnedAgentIds } from '@codecast/web/hooks/usePinnedAgents';
import { AccountRecoveryBanner } from '@/components/AccountRecoveryBanner';
import { ConversationSlideOut, useConversationDrawer } from '@/components/inbox/ConversationSlideOut';
import { StyleSheet, FlatList, ActivityIndicator, ScrollView, TouchableOpacity, Keyboard, KeyboardAvoidingView, Platform, Share, View as RNView, Image, ActionSheetIOS, Alert, Pressable, Clipboard, Modal, Animated, Easing, Dimensions, InteractionManager, type LayoutChangeEvent } from 'react-native';
import { TextInput, Text as RNText } from '@/components/Themed';
import { useLocalSearchParams, Stack, useRouter, useFocusEffect, router } from 'expo-router';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { Id } from '@codecast/convex/convex/_generated/dataModel';
import { memo, useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Feather from '@expo/vector-icons/Feather';
import { mixColor } from '@/lib/solColor';
import { AgentLogoSvg } from '@/components/AgentLogo';
import { ConversationSkeleton } from '@/components/SkeletonLoader';
import { MobileAgentSpeaker, MobileIdentityFace, MobileSessionIdentityLine, useSessionIdentityRow } from '@/components/identity';
import { RoleFace } from '@/components/org/RoleFace';
import { useInboxStore, isConvexId, retryPendingSend } from '@codecast/web/store/inboxStore';
import { CODECAST_BASE_URL, sharePath } from '@codecast/shared/entities';
import { sessionIdentity } from '@codecast/web/lib/sessionIdentity';
import { extractSessionImages, mergeSessionImages, type SessionImageEntry } from '@codecast/web/lib/sessionImages';
import { isResentCopyOfSentMessage } from '@codecast/web/lib/staleDraft';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { parsePollAnswers, pollClosedLabel, pollDeadline, POLL_TIMED_OUT } from '@codecast/web/lib/pollPayload';
import { useComposerField, nativeComposerText } from '@/lib/composerField';
import { ImageGallery } from '@/components/ImageGallery';
import { isTrustedImageSrc } from '@/lib/convex';
import { foldToolRuns, type ToolRun } from '@/lib/toolRuns';
import { FreshRows } from '@/lib/freshRows';
import { ROW_LAYOUT, arriveEntering, sendEntering } from '@/lib/transcriptMotion';
import { messageRowKey, uniqueRowKeys } from '@codecast/web/lib/messageRowKey';
import Reanimated, { Easing as ReEasing, FadeIn, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { chatWakePlace, chatWakeAction, isToolResultCarrier, type ChatWakePrompt } from '@codecast/web/components/sessionMessage';
import { buildNavigatorRows, sampleTicks, stickyEligibleIds, pickStickyFallback, resolveStickyPrompt, countCommentsByMessage, type NavigatorRow } from '@codecast/web/lib/messageNavigator';
import { resolveSessionTitle } from '@codecast/web/lib/sessionTitle';
import { hasRichMarkdown } from '@codecast/web/lib/richMarkdown';
import { isCommandMessage, isHiddenSystemNotice, isWarningSystemNotice } from '@codecast/web/lib/conversationProcessor';
import { MessageNavigatorSheet } from '@/components/session/MessageNavigatorSheet';
import { SentFileBlock, type SentFileData } from '@/components/session/SentFileBlock';
import { StructuredResultBlock } from '@/components/session/StructuredResultBlock';
import { WorkflowEventBlock, parseWorkflowEventContent } from '@/components/session/WorkflowEventBlock';
import { MessageTickRail, MessageListButton } from '@/components/session/MessageTickRail';
import { StickyPromptBanner, type StickyPrompt } from '@/components/session/StickyPromptBanner';
import { useConversationMessages } from '@codecast/web/hooks/useConversationMessages';
import { useStorageImageUrl } from '@codecast/web/hooks/useStorageImageUrl';
import { usePendingPermissions } from '@codecast/web/hooks/useSyncPendingPermissions';
import { useConversationCommits, useConversationPullRequests, useSyncConversationCommits, useSyncConversationPullRequests } from '@codecast/web/hooks/useSyncTimeline';
import { useForkTree, type FlatForkNode } from '@codecast/web/hooks/useForkTree';
import { useConversationCommentsSync, useConversationCommentRows } from '@codecast/web/hooks/useConversationCommentsSync';
import { useManagedSessionFields } from '@codecast/web/hooks/useManagedSessionFields';
import { beginLocalFork } from '@codecast/web/store/beginLocalFork';
import { useMissingSessionLookup } from '@codecast/web/hooks/useMissingSessionRow';
import { useAckActiveSession } from '@/hooks/useAckActiveSession';
import { PermissionCard } from '@/components/PermissionCard';
import { useComposerSuggestion } from '@codecast/web/hooks/useComposerSuggestion';
import { SlashCommandPills } from '@/components/session/SlashCommandPills';
import { AssignmentChip, AssignedToYouBanner } from '@/components/AssignmentChip';
import { useSessionHuddle } from '@/components/calls/SessionHuddleButton';
import { RenameSessionSheet } from '@/components/session/RenameSessionSheet';
import { showActionSheet, type SheetItem } from '@/lib/actionSheet';
import { ComposeButton } from '@/components/session/ComposeButton';
import { MessageComposer, dispatchComposerSend, useComposerImages, IMAGE_ONLY_CONTENT, type ComposerStatus } from '@/components/session/MessageComposer';
import { sessionLanded } from '@/lib/compose';
import { mobileEntityRoute } from '@/lib/linkRoutes';
import { SessionActionsSheet, type SessionRow, type SessionTile } from '@/components/session/SessionActionsSheet';
import { ModelSwitcherChip } from '@/components/ModelSwitcherChip';
import { ApprovalCard, ApprovalPending, ApprovalSettled } from '@/components/hosted/ApprovalCard';
import { hostedApprovalAnswer, hostedApprovalState, type HostedApprovalState } from '@codecast/web/lib/hostedApproval';
import { HostedSources, HostedStep } from '@/components/hosted/Steps';
import { ReplyChips } from '@/components/hosted/ReplyChips';
import { searchedSources } from '@codecast/web/lib/hostedReceipt';
import { HostedNoticeRow } from '@/components/hosted/Notice';
import { foldHostedRetries, hostedNoticeKind, lastAskOf } from '@codecast/web/lib/hostedNotice';
import { Serif } from '@/constants/fonts';
import { useHostedTheme } from '@/components/hosted/hostedTheme';
import { hostedComposerWords, hostedLastExchange } from '@codecast/web/lib/hostedComposer';
import { useAllowanceOut } from '@codecast/web/components/simple/usePlanFigures';
import { hostedConnectionWords } from '@codecast/web/components/conversation/HostedConnection';
import { useLinkDown } from '@/hooks/useLinkDown';
import { answerNote, conversationTitle } from '@codecast/web/components/simple/lane';
import { useConversationApprovals, useConversationWorking } from '@codecast/web/components/simple/useLane';
import { useModeWords, useSurface } from '@codecast/web/lib/surfaces';
import { agentDisplayName, agentSupportsFork, isHostedAgentType, parseDecisionAnswer, ACTIVE_AGENT_STATUSES, DECISION_ANSWER_TAG_RE, SAFETY_BLOCK_HINT, CLOUD_AGENT_ACTION_SUBTYPE, parseScheduledTask, sessionEscalationCaption, stripPastedContent, isPollResponsePayload, type VaultReadyMessage } from '@codecast/shared/contracts';
import { DELIVERY_FAILED_SUBTYPE, parseDeliveryFailedNotice } from '@codecast/shared/contracts/deliveryFailed';
import { MarkdownContent, CodeBlockWithCopy, linkifyPlainText } from '@/components/MarkdownRenderer';
import { AnsiText } from '@/components/CodeText';
import { stripAnsiCodes } from '@codecast/web/lib/ansi';

const ANSI_RE = /\x1b\[[0-9;]*m/;
import { ApplyPatchDiff, CastDiff, EditDiff } from '@/components/CastDiff';
import { getToolPatchInputs } from '@codecast/convex/convex/fileChanges/embeddedPatch';
import { BashModeBlock, FoldedPromptRow, SessionHandoffCard } from '@/components/session/UserRows';
import { classifyUserRows, pairCommandExpansions } from '@codecast/web/lib/userRowKinds';
import { parseJointMessage } from '@codecast/shared/contracts/jointMessage';
import { parseCommandInvocation, cleanCommandExpansion, parseCastCommand, parseApiErrorContent, stripSystemTags as stripTagsShared } from '@codecast/web/components/conversation/classify';
import type { ParsedApiError } from '@codecast/web/components/conversation/types';
import { compactionProgressMessage, type CompactionProgress } from '@codecast/web/lib/compactionProgress';
import { CastCommandBlock } from '@/components/session/CastCommandBlock';
import { openLink } from '@/lib/links';
import { PERF_PROBE, probeRender } from '@/lib/perfProbe';
import { useShallowStable } from '@/hooks/useShallowStable';
import { RelativeTime } from '@/components/RelativeTime';
import { EntityPill } from '@/components/EntityPill';
import { CastCanvas, canvasAvailable, looksLikeHtmlMessage } from '@/components/CastCanvas';
import { useSessionRestart, ghostRestartContextFor } from '@codecast/web/hooks/useSessionRestart';
import { Theme, Spacing, chipShell, chipText, chipQuiet, CHROME_FONT_CAP, themedStyles, useActiveLook, useTheme } from '@/constants/Theme';
import { MOBILE_AGENT_TINT, MOBILE_COMPOSER_PLACEHOLDER, MOBILE_COMPOSER_STATUS, MOBILE_SESSION_HEADER_HEIGHT, MOBILE_SESSION_STYLE as S, mobileRelativeTime } from '@codecast/shared/render/mobileSessionStyle';
import {
  extractNestedActions,
  toolSummary,
  formatToolName,
  mcpToolNames,
  stripLineNumbers,
  isPlanWriteToolCall,
  isReadTool,
  isShellTool,
  isEditTool,
  isWriteTool,
  isGrepTool,
  isGlobTool,
  isTodoTool,
  isAgentTool,
  isAskTool,
  isPlanModeTool,
  toolPathFromInput,
  toolIcon,
  toolResultHint,
  type ToolColorToken,
} from '@codecast/shared/render';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CollapsibleBody, FadeGradient as LinearGradient, blendOver } from '@/components/CollapsibleBody';

function Toast({ message, visible }: { message: string; visible: boolean }) {
  const Theme = useTheme();
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
        Animated.delay(1200),
        Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, message]);

  if (!visible) return null;

  return (
    <Animated.View style={[styles.toast, { opacity }]} pointerEvents="none">
      <RNText style={styles.toastText}>{message}</RNText>
    </Animated.View>
  );
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
  // Ready-to-render src (a trusted markdown image URL or a prebuilt data: URI)
  // for gallery entries that aren't storage-backed message attachments.
  url?: string;
  // The local file an optimistic attachment paints while it uploads.
  preview_url?: string;
};

type Message = {
  _id: string;
  role: string;
  content?: string;
  timestamp: number;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_results?: ToolResult[];
  images?: ImageData[];
  files?: SentFileData[];
  subtype?: string;
  message_uuid?: string;
  /** A synthetic pull request row: the PR it opens. */
  pr?: { repository: string; number: number };
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  // Optimistic-send markers merged in by useConversationMessages.
  _isOptimistic?: true;
  _isQueued?: true;
  _isFailed?: true;
  _clientId?: string;
};

type UsageData = {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  contextSize: number;
};

// Synthetic truncation notice the CLI injects into imported sessions for the
// model's context only — never user-facing.
function isImportNotice(content?: string | null): boolean {
  return !!content && content.trimStart().startsWith('[Codecast import]');
}

// Web's tag strip, plus a `cast decide` answer's trailer tag (web draws it
// as a footer; the phone shows the answer alone).
function stripSystemTags(content: string): string {
  return stripTagsShared(content).replace(DECISION_ANSWER_TAG_RE, '');
}

type ForkChild = {
  _id: string;
  title: string;
  short_id?: string;
  parent_message_uuid?: string;
  started_at?: number;
  username?: string;
};

type ConversationData = {
  _id: string;
  title: string;
  status: string;
  updated_at?: number;
  is_favorite?: boolean;
  share_token?: string | null;
  is_private?: boolean;
  team_visibility?: string | null;
  team_id?: string | null;
  session_id?: string;
  messages: Message[];
  has_more_above?: boolean;
  oldest_timestamp?: number | null;
  model?: string;
  effort?: string | null;
  is_own?: boolean;
  agent_type?: string;
  started_at?: number;
  message_count?: number;
  fork_count?: number;
  compaction_count?: number;
  fork_children?: ForkChild[];
  parent_conversation_id?: string | null;
  forked_from?: string;
  forked_from_details?: {
    conversation_id: string;
    username: string;
    share_token?: string;
  };
  user?: { name?: string; email?: string } | null;
  git_branch?: string | null;
  git_remote_url?: string | null;
  git_status?: string | null;
  git_diff?: string | null;
  git_diff_staged?: string | null;
  loaded_start_index?: number;
  child_conversation_map?: Record<string, string>;
  child_conversations?: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>;
  short_id?: string;
  draft_message?: string | null;
};

// --- Message components ---

const formatRelativeTime = (ts: number): string => mobileRelativeTime(ts);

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatFullTimestamp(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatModel(model?: string): string {
  if (!model) return '';
  if (model.includes('claude-sonnet')) {
    return model.replace('claude-sonnet-', 'sonnet-').replace('-20', "-'");
  }
  if (model.includes('claude-opus')) {
    return model.replace('claude-opus-', 'opus-').replace('-20', "-'");
  }
  if (model.includes('claude-haiku')) {
    return model.replace('claude-haiku-', 'haiku-').replace('-20', "-'");
  }
  return model;
}

function formatAgentType(agentType?: string): string {
  return agentType ? agentDisplayName(agentType) : 'Unknown';
}

function agentTypeColor(agentType?: string): string {
  const tint = agentType ? MOBILE_AGENT_TINT[agentType] : undefined;
  if (tint) return tint;
  if (agentType === 'grok') return Theme.text;
  return Theme.accent;
}

function agentTypeIcon(agentType?: string): string {
  if (agentType === 'codex') return 'terminal';
  if (agentType === 'cursor') return 'mouse-pointer';
  if (agentType === 'gemini') return 'star';
  if (agentType === 'opencode') return 'code';
  if (agentType === 'pi') return 'bolt';
  if (agentType === 'grok') return 'times';
  return 'bolt';
}

function formatDuration(startTs: number): string {
  const diff = Date.now() - startTs;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  if (hours < 24) return remainMin ? `${hours}h ${remainMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// Concrete hex for each semantic color token the shared tool visuals return.
const toolColorHex: Record<ToolColorToken, string> = {
  green: Theme.green,
  blue: Theme.blue,
  violet: Theme.violet,
  orange: Theme.orange,
  cyan: Theme.cyan,
  magenta: Theme.magenta,
  red: Theme.red,
  textDim: Theme.textDim,
  emerald: Theme.greenBright,
  amber: '#f59e0b',
};

// Uncurated mcp__server__method labels get clipped to fit the collapsed row.
function toolLabel(name: string): string {
  const label = formatToolName(name);
  return name.startsWith('mcp__') && !mcpToolNames[name] ? label.slice(0, 12) : label;
}


const PLAN_PREFIXES = [
  /^implement\s+the\s+following\s+plan\s*:\s*/i,
  /^implement\s+this\s+plan\s*:\s*/i,
  /^here(?:'s| is)\s+the\s+plan\s*:\s*/i,
  /^plan\s*:\s*\n/i,
];

function isPlanFile(filePath: string, content: string): boolean {
  const fileName = filePath.split('/').pop()?.toLowerCase() || '';
  if (fileName.includes('plan') || fileName === 'plan.md') return true;
  if (filePath.includes('.claude/plans/')) return true;
  const planPatterns = [
    /^#\s*(implementation\s+)?plan/im,
    /^##\s*(goals?|objectives?|overview)/im,
    /^##\s*(steps?|phases?|tasks?|approach)/im,
    /^\d+\.\s+\*\*[^*]+\*\*/m,
    /^-\s+\[[ x]\]/im,
  ];
  let matches = 0;
  for (const pattern of planPatterns) {
    if (pattern.test(content)) {
      matches++;
      if (matches >= 2) return true;
    }
  }
  return false;
}

function getFileExtension(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp', cs: 'csharp',
    json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
    html: 'html', css: 'css', scss: 'scss', sql: 'sql',
    sh: 'bash', bash: 'bash', zsh: 'bash', swift: 'swift', kt: 'kotlin',
  };
  return ext ? langMap[ext] : undefined;
}

// Specialized tool rendering components

function TaskToolBlock({ tool, result, childConversationId }: { tool: ToolCall; result?: ToolResult; childConversationId?: string }) {
  const Theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const router = useRouter();

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const subagentType = String(parsedInput.subagent_type || 'unknown');
  const description = String(parsedInput.description || '');
  const prompt = String(parsedInput.prompt || '');
  const model = parsedInput.model ? String(parsedInput.model) : null;
  const name = parsedInput.name ? String(parsedInput.name) : null;

  const runInBackground = Boolean(parsedInput.run_in_background);

  const subagentColors: Record<string, string> = {
    Explore: Theme.green,
    Plan: Theme.blue,
    implementor: Theme.accent,
    'general-purpose': Theme.textMuted,
    'claude-code-guide': Theme.violet,
    'code-reviewer': Theme.orange,
    'code-explorer': Theme.cyan,
    'code-architect': Theme.magenta,
    'code-simplifier': Theme.cyan,
  };

  const color = subagentColors[subagentType] || Theme.textMuted;
  const truncatedPrompt = prompt.length > 300 && !expanded ? prompt.slice(0, 300) + '...' : prompt;

  return (
    <TouchableOpacity
      onPress={() => setExpanded(!expanded)}
      style={[styles.specialToolBlock, { backgroundColor: color + '15', borderColor: color + '40' }]}
      activeOpacity={0.7}
    >
      <RNView style={styles.specialToolHeader}>
        <RNText style={[styles.specialToolName, { color }]}>Task</RNText>
        <RNView style={[styles.specialToolBadge, { backgroundColor: color + '20', borderColor: color + '40' }]}>
          <RNText style={[styles.specialToolBadgeText, { color }]}>{subagentType}</RNText>
        </RNView>
        {description && (
          <RNText style={[styles.specialToolDesc, { flex: 1, marginBottom: 0 }]} numberOfLines={1}>{description}</RNText>
        )}
        {model && (
          <RNText style={styles.specialToolMeta}>{formatModel(model)}</RNText>
        )}
        {name && (
          <RNText style={styles.specialToolMeta}>{name}</RNText>
        )}
        {runInBackground && (
          <RNText style={styles.specialToolMeta}>background</RNText>
        )}
        {childConversationId && (
          <Pressable onPress={() => router.push(`/session/${childConversationId}`)}>
            <RNText style={[styles.specialToolMeta, { color: Theme.cyan, textDecorationLine: 'underline' }]}>view</RNText>
          </Pressable>
        )}
        <RNText style={[styles.specialToolMeta, { marginLeft: 'auto' }]}>{expanded ? 'collapse' : 'expand'}</RNText>
      </RNView>
      <RNText style={styles.specialToolContent} selectable numberOfLines={expanded ? 50 : 3}>{linkifyPlainText(truncatedPrompt, 'sp')}</RNText>
      {!expanded && prompt.length > 300 && (
        <RNText style={{ fontSize: 10, color: Theme.textDim, marginTop: 2 }}>show more</RNText>
      )}
      {expanded && result && (
        <RNView style={styles.specialToolResult}>
          <RNText style={styles.specialToolResultLabel}>Result</RNText>
          <RNText style={[styles.specialToolResultText, result.is_error && { color: Theme.red }]} selectable numberOfLines={20}>
            {linkifyPlainText(result.content, 'sr')}
          </RNText>
        </RNView>
      )}
    </TouchableOpacity>
  );
}

// Remembers, per tool-call id, the option the user tapped — so the pill stays
// selected (and locked) across re-renders/remounts before the agent's answer
// echoes back. Mirrors web's _askUserSentState.
const _askUserSentState = new Map<string, string>();

type AskUserQuestionProps = { tool: ToolCall; result?: ToolResult; conversationId?: string };
type AskUserQuestionInput = { questions?: Array<{ question: string; header?: string; detail?: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect?: boolean; isConfirmation?: boolean }>; answers?: Record<string, string>; deniesAt?: number };

function AskUserQuestionBlock(props: AskUserQuestionProps) {
  let parsedInput: AskUserQuestionInput = {};
  try { parsedInput = JSON.parse(props.tool.input); } catch {}
  // Only a terminal dialog still counting down holds a ticking clock.
  return typeof parsedInput.deniesAt === 'number' && !props.result
    ? <TimedAskUserQuestion {...props} parsedInput={parsedInput} deniesAt={parsedInput.deniesAt} />
    : <AskUserQuestionCard {...props} parsedInput={parsedInput} />;
}

function TimedAskUserQuestion({ deniesAt, ...props }: AskUserQuestionProps & { parsedInput: AskUserQuestionInput; deniesAt: number }) {
  const now = useCoarseNow(1000);
  return <AskUserQuestionCard {...props} deadline={pollDeadline(deniesAt, now)} />;
}

function AskUserQuestionCard({ tool, result, conversationId, parsedInput, deadline }: AskUserQuestionProps & { parsedInput: AskUserQuestionInput; deadline?: ReturnType<typeof pollDeadline> }) {
  const Theme = useTheme();

  const [sentLabel, setSentLabel] = useState<string | undefined>(() => _askUserSentState.get(tool.id));

  const questions = parsedInput.questions || [];
  if (questions.length === 0) return null;

  let answers: Record<string, string> = {};
  if (parsedInput.answers && typeof parsedInput.answers === 'object') {
    answers = parsedInput.answers;
  } else {
    answers = parsePollAnswers(questions, result?.content);
  }

  // Interactive while the agent is still waiting: no answer yet, a live
  // conversation to send into, and the user hasn't already tapped. Confirmation
  // questions map to Enter/Escape; everything else to the 1-based option index
  // (matches web's poll-key contract that drives the live /poll picker).
  const isConfirmation = questions[0]?.isConfirmation;
  const expired = !!deadline?.expired;
  const isInteractive = !result && !!conversationId && sentLabel === undefined && !expired;
  const closedLabel = expired ? POLL_TIMED_OUT : pollClosedLabel(result, answers);

  const handlePick = (j: number, cleanLabel: string) => {
    if (!conversationId) return;
    const pollKey = isConfirmation ? (j === 0 ? 'Enter' : 'Escape') : String(j + 1);
    _askUserSentState.set(tool.id, cleanLabel);
    setSentLabel(cleanLabel);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Local-first: add the optimistic poll message, then dispatch it through the
    // outbox with that clientId (same two-step the composer uses). This drives
    // the live /poll picker on the daemon to advance the blocked agent.
    const content = JSON.stringify({ __cc_poll: true, keys: [pollKey], display: cleanLabel });
    const store = useInboxStore.getState();
    const clientId = store.addOptimisticMessage(conversationId, content);
    store.sendMessageWhenReady(conversationId, content, undefined, clientId);
  };

  return (
    <RNView style={styles.askQuestionBlock}>
      {questions.map((q, i) => {
        const answer = answers[q.question];
        const hasDescriptions = q.options.some(o => o.description) || q.options.some(o => o.preview);
        const isCustom = answer !== undefined && !q.options.some(
          o => o.label === answer || o.label.replace(' (Recommended)', '') === answer
        );
        return (
          <RNView key={i} style={styles.questionItem}>
            {q.header && (
              <RNView style={styles.questionHeaderBadge}>
                <RNText style={styles.questionHeaderText}>{q.header}</RNText>
              </RNView>
            )}
            <RNText style={styles.questionText}>{q.question}</RNText>
            {!!q.detail && <RNText style={styles.optionDescription}>{q.detail}</RNText>}
            <RNView style={[styles.optionsRow, hasDescriptions && styles.optionsColumn]}>
              {q.options.map((opt, j) => {
                const cleanLabel = opt.label.replace(' (Recommended)', '');
                const isSelected = (answer !== undefined && (opt.label === answer || cleanLabel === answer)) || sentLabel === cleanLabel;
                // The option's `preview` is the ASCII/mockup box the terminal
                // shows — surface it while interactive (read before tapping,
                // one tap submits) and on the chosen option once answered.
                const showPreview = !!opt.preview && (isInteractive || isSelected);
                // Horizontal ScrollView won't hug multiline text height — size
                // the box from the line count so it fits the mockup exactly.
                const previewHeight = showPreview
                  ? Math.min(opt.preview!.split('\n').length * 15 + 18, 240)
                  : 0;
                const previewBox = showPreview ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={[styles.auqPreviewBox, { height: previewHeight }]}
                  >
                    <RNText style={styles.auqPreviewText}>{opt.preview}</RNText>
                  </ScrollView>
                ) : null;
                const pill = (
                  <RNView
                    style={[
                      styles.optionPill,
                      isInteractive && styles.optionPillInteractive,
                      isSelected && styles.optionPillSelected,
                    ]}
                  >
                    {isSelected && (
                      <FontAwesome name="check" size={10} color={Theme.green} style={{ marginRight: 4 }} />
                    )}
                    <RNText style={[
                      styles.optionPillText,
                      isInteractive && styles.optionPillTextInteractive,
                      isSelected && styles.optionPillTextSelected,
                    ]}>
                      {opt.label}
                    </RNText>
                  </RNView>
                );
                const wrapped = isInteractive ? (
                  <Pressable key={j} onPress={() => handlePick(j, cleanLabel)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                    {opt.description || previewBox ? (
                      <RNView style={styles.optionItem}>
                        {pill}
                        {!!opt.description && <RNText style={styles.optionDescription}>{opt.description}</RNText>}
                        {previewBox}
                      </RNView>
                    ) : pill}
                  </Pressable>
                ) : !opt.description && !previewBox ? (
                  <RNView key={j}>{pill}</RNView>
                ) : (
                  <RNView key={j} style={styles.optionItem}>
                    {pill}
                    {!!opt.description && <RNText style={styles.optionDescription}>{opt.description}</RNText>}
                    {previewBox}
                  </RNView>
                );
                return wrapped;
              })}
              {isCustom && (
                <RNView style={styles.optionPillCustom}>
                  <FontAwesome name="comment-o" size={10} color={Theme.blue} style={{ marginRight: 4 }} />
                  <RNText style={styles.optionPillCustomText}>{answer}</RNText>
                </RNView>
              )}
            </RNView>
          </RNView>
        );
      })}
      {closedLabel ? (
        <RNText style={styles.optionDescription}>{closedLabel}</RNText>
      ) : isInteractive && deadline ? (
        <RNText style={[styles.optionDescription, { color: Theme.yellow, fontVariant: ['tabular-nums'] }]}>Auto-denies in {deadline.left}</RNText>
      ) : null}
    </RNView>
  );
}

function TodoWriteBlock({ tool }: { tool: ToolCall }) {
  const Theme = useTheme();
  let parsedInput: { todos?: Array<{ content: string; status: string; activeForm?: string }> } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const todos = parsedInput.todos || [];
  if (todos.length === 0) return null;

  const completed = todos.filter(t => t.status === 'completed').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;

  return (
    <RNView style={styles.todoBlock}>
      <RNView style={styles.todoHeader}>
        <RNView style={[styles.todoDot, { backgroundColor: Theme.magenta }]} />
        <RNText style={styles.todoTitle}>TodoWrite</RNText>
        <RNText style={styles.todoStats}>
          {completed}/{todos.length} done{inProgress > 0 && `, ${inProgress} in progress`}
        </RNText>
      </RNView>
      <RNView style={styles.todoList}>
        {todos.map((todo, i) => (
          <RNView key={i} style={styles.todoItem}>
            {todo.status === 'completed' ? (
              <FontAwesome name="check-circle" size={14} color={Theme.green} style={{ marginRight: 6 }} />
            ) : todo.status === 'in_progress' ? (
              <FontAwesome name="clock-o" size={14} color={Theme.accent} style={{ marginRight: 6 }} />
            ) : (
              <FontAwesome name="circle-o" size={14} color={Theme.textMuted0} style={{ marginRight: 6 }} />
            )}
            <RNText style={[
              styles.todoItemText,
              todo.status === 'completed' && { color: Theme.textDim, textDecorationLine: 'line-through' as const },
              todo.status === 'in_progress' && { color: Theme.textSecondary },
            ]}>
              {todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content}
            </RNText>
          </RNView>
        ))}
      </RNView>
    </RNView>
  );
}

function TaskListBlock({ result }: { result?: ToolResult }) {
  const Theme = useTheme();
  if (!result) return null;

  const lines = result.content.split('\n');
  const items: Array<{ id: string; status: string; subject: string; owner?: string; blockedBy?: string[] }> = [];
  for (const line of lines) {
    const match = line.match(/#(\d+)\s+\[(\w+)]\s+(.+?)(?:\s+\(([^)]+)\))?(?:\s+\[blocked by ([^\]]+)])?$/);
    if (match) {
      items.push({
        id: match[1],
        status: match[2],
        subject: match[3].trim(),
        owner: match[4]?.trim(),
        blockedBy: match[5]?.split(',').map((s: string) => s.trim().replace('#', '')),
      });
    }
  }
  if (items.length === 0) return null;

  const completed = items.filter(t => t.status === 'completed').length;
  const inProgress = items.filter(t => t.status === 'in_progress').length;

  return (
    <RNView style={styles.todoBlock}>
      <RNView style={styles.todoHeader}>
        <RNView style={[styles.todoDot, { backgroundColor: Theme.green }]} />
        <RNText style={[styles.todoTitle, { color: Theme.green }]}>TaskList</RNText>
        <RNText style={styles.todoStats}>
          {completed}/{items.length} done{inProgress > 0 && `, ${inProgress} active`}
        </RNText>
      </RNView>
      <RNView style={styles.todoList}>
        {items.map((task, i) => {
          const isBlocked = task.blockedBy && task.blockedBy.length > 0;
          return (
            <RNView key={i} style={[styles.todoItem, isBlocked && { opacity: 0.5 }]}>
              {task.status === 'completed' ? (
                <FontAwesome name="check-circle" size={14} color={Theme.green} style={{ marginRight: 6 }} />
              ) : task.status === 'in_progress' ? (
                <FontAwesome name="clock-o" size={14} color={Theme.accent} style={{ marginRight: 6 }} />
              ) : isBlocked ? (
                <FontAwesome name="lock" size={12} color={Theme.textDim} style={{ marginRight: 7, marginLeft: 1 }} />
              ) : (
                <FontAwesome name="circle-o" size={14} color={Theme.textMuted0} style={{ marginRight: 6 }} />
              )}
              <RNText style={[styles.todoId, task.status === 'completed' && { textDecorationLine: 'line-through' }]}>#{task.id}</RNText>
              <RNText style={[
                styles.todoItemText,
                task.status === 'completed' && { color: Theme.textDim, textDecorationLine: 'line-through' },
                task.status === 'in_progress' && { color: Theme.textSecondary },
              ]} numberOfLines={2}>
                {task.subject}
              </RNText>
              {task.owner ? (
                <RNView style={styles.todoOwnerBadge}>
                  <RNText style={styles.todoOwnerText}>@{task.owner}</RNText>
                </RNView>
              ) : null}
              {isBlocked ? (
                <RNText style={styles.todoBlockedText}>blocked by {task.blockedBy!.map(id => `#${id}`).join(', ')}</RNText>
              ) : null}
            </RNView>
          );
        })}
      </RNView>
    </RNView>
  );
}

function SkillCard({ tool }: { tool: ToolCall }) {
  const Theme = useTheme();
  let parsedInput: { skill?: string; args?: string } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const skillName = parsedInput.skill || 'skill';

  return (
    <RNView style={styles.skillCard}>
      <RNText style={styles.skillName}>/{skillName}</RNText>
      {parsedInput.args && <RNText style={{ fontSize: 11, color: Theme.textMuted, marginLeft: 6 }}>{parsedInput.args}</RNText>}
    </RNView>
  );
}

function TaskCreateUpdateBlock({ tool, result, taskSubjectMap }: { tool: ToolCall; result?: ToolResult; taskSubjectMap?: Record<string, string> }) {
  const Theme = useTheme();
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const isCreate = tool.name === 'TaskCreate';
  const subject = parsedInput.subject;
  const taskId = parsedInput.taskId;
  const status = parsedInput.status;
  const owner = parsedInput.owner;
  const activeForm = parsedInput.activeForm;

  let resultId = '';
  if (result) {
    const idMatch = result.content.match(/Task #(\d+)/);
    if (idMatch) resultId = idMatch[1];
  }

  const resolvedSubject = subject || (taskId && taskSubjectMap?.[taskId]);

  const statusColors: Record<string, string> = {
    completed: Theme.green,
    in_progress: Theme.accent,
    deleted: Theme.red,
    pending: Theme.textMuted0,
  };

  if (!isCreate && resolvedSubject) {
    return (
      <RNView style={styles.taskOpBlock}>
        <RNText style={styles.taskOpText} numberOfLines={1}>{String(resolvedSubject).slice(0, 60)}</RNText>
        {status && (
          <RNView style={[styles.taskOpBadge, { backgroundColor: (statusColors[status] || Theme.textMuted0) + '20', borderColor: (statusColors[status] || Theme.textMuted0) + '40' }]}>
            <RNText style={[styles.taskOpBadgeText, { color: statusColors[status] || Theme.textMuted0 }]}>{status}</RNText>
          </RNView>
        )}
        {owner && (
          <RNView style={[styles.taskOpBadge, { backgroundColor: Theme.blue + '20', borderColor: Theme.blue + '40' }]}>
            <RNText style={[styles.taskOpBadgeText, { color: Theme.blue }]}>@{owner}</RNText>
          </RNView>
        )}
      </RNView>
    );
  }

  return (
    <RNView style={styles.taskOpBlock}>
      <RNText style={[styles.taskOpName, { color: Theme.green }]}>{tool.name}</RNText>
      {isCreate ? (
        <>
          {resultId ? <RNText style={styles.taskOpId}>#{resultId}</RNText> : null}
          {subject ? <RNText style={styles.taskOpText} numberOfLines={1}>{subject}</RNText> : null}
          {activeForm ? <RNText style={{ fontSize: 10, color: Theme.textDim, fontStyle: 'italic' }}>({activeForm})</RNText> : null}
        </>
      ) : (
        <>
          {taskId ? <RNText style={styles.taskOpId}>#{taskId}</RNText> : null}
          {status && (
            <RNView style={[styles.taskOpBadge, { backgroundColor: (statusColors[status] || Theme.textMuted0) + '20', borderColor: (statusColors[status] || Theme.textMuted0) + '40' }]}>
              <RNText style={[styles.taskOpBadgeText, { color: statusColors[status] || Theme.textMuted0 }]}>{status}</RNText>
            </RNView>
          )}
          {owner && (
            <RNView style={[styles.taskOpBadge, { backgroundColor: Theme.blue + '20', borderColor: Theme.blue + '40' }]}>
              <RNText style={[styles.taskOpBadgeText, { color: Theme.blue }]}>@{owner}</RNText>
            </RNView>
          )}
        </>
      )}
    </RNView>
  );
}

function SendMessageBlock({ tool }: { tool: ToolCall }) {
  const Theme = useTheme();
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const type = parsedInput.type || 'message';
  const recipient = parsedInput.recipient;
  const summary = parsedInput.summary;

  return (
    <RNView style={styles.taskOpBlock}>
      <RNText style={[styles.taskOpName, { color: '#f59e0b' }]}>SendMessage</RNText>
      {type === 'broadcast' ? (
        <RNView style={[styles.taskOpBadge, { backgroundColor: Theme.red + '20', borderColor: Theme.red + '40' }]}>
          <RNText style={[styles.taskOpBadgeText, { color: Theme.red }]}>broadcast</RNText>
        </RNView>
      ) : type === 'shutdown_request' ? (
        <RNView style={[styles.taskOpBadge, { backgroundColor: Theme.red + '20', borderColor: Theme.red + '40' }]}>
          <RNText style={[styles.taskOpBadgeText, { color: Theme.red }]}>shutdown</RNText>
        </RNView>
      ) : recipient ? (
        <RNView style={[styles.taskOpBadge, { backgroundColor: '#f59e0b20', borderColor: '#f59e0b33' }]}>
          <RNText style={[styles.taskOpBadgeText, { color: '#f59e0b' }]}>@{recipient}</RNText>
        </RNView>
      ) : null}
      {summary && (
        <RNText style={styles.taskOpText} numberOfLines={1}>{summary}</RNText>
      )}
    </RNView>
  );
}

function TeamCreateBlock({ tool }: { tool: ToolCall }) {
  const Theme = useTheme();
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  return (
    <RNView style={styles.taskOpBlock}>
      <RNText style={[styles.taskOpName, { color: Theme.cyan }]}>{tool.name}</RNText>
      {parsedInput.team_name && (
        <RNView style={[styles.taskOpBadge, { backgroundColor: Theme.cyan + '20', borderColor: Theme.cyan + '40' }]}>
          <RNText style={[styles.taskOpBadgeText, { color: Theme.cyan }]}>{parsedInput.team_name}</RNText>
        </RNView>
      )}
      {parsedInput.description && (
        <RNText style={[styles.taskOpText, { color: Theme.textDim }]} numberOfLines={1}>{String(parsedInput.description).slice(0, 60)}</RNText>
      )}
    </RNView>
  );
}

const IMAGE_COLLAPSED_HEIGHT = 80;

// Storage ids resolve through the shared URL cache, which
// useConversationMessages warms the moment messages land, so an image that
// scrolls into view (or remounts) has its URL on the first frame.
function useImageSrc(image: ImageData) {
  const storageUrl = useStorageImageUrl(image.storage_id);
  return image.storage_id
    ? storageUrl ?? undefined
    : image.url || image.preview_url
      ? image.url || image.preview_url
      : image.data
        ? `data:${image.media_type};base64,${image.data}`
        : undefined;
}

// Identity of an image across the raw message shape and the gallery's scanned
// entries (extractSessionImages keys the same way).
function imageKeyOf(image: ImageData): string | undefined {
  return image.storage_id
    || image.url
    || image.preview_url
    || (image.data ? `data:${image.media_type};base64,${image.data}` : undefined);
}

function ImageBlock({ image, onPress }: { image: ImageData; onPress?: () => void }) {
  const Theme = useTheme();
  const src = useImageSrc(image);

  if (!src) {
    return (
      <RNView style={styles.imageLoading}>
        <ActivityIndicator size="small" color={Theme.textMuted} />
      </RNView>
    );
  }

  return (
    <Pressable onPress={onPress} style={styles.imageContainer}>
      <RNView style={{ height: IMAGE_COLLAPSED_HEIGHT, overflow: 'hidden' }}>
        <Image
          source={{ uri: src }}
          style={{ width: '100%', height: IMAGE_COLLAPSED_HEIGHT * 2.5 }}
          resizeMode="cover"
        />
      </RNView>
      {/* Fade the clipped preview INTO the page background (cream), not to black —
          a black fade read as a dark smudge on the light theme. */}
      <LinearGradient colors={[Theme.bg + '00', Theme.bg]} style={styles.imageFadeOverlay} pointerEvents="none" />
      <RNView style={styles.imageExpandHint}>
        <FontAwesome name="expand" size={10} color="rgba(255,255,255,0.8)" />
      </RNView>
    </Pressable>
  );
}

function CompactionSummaryBlock({ content }: { content: string }) {
  const Theme = useTheme();
  const [expanded, setExpanded] = useState(false);

  return (
    <RNView style={styles.compactionBlock}>
      <TouchableOpacity
        onPress={() => setExpanded(!expanded)}
        style={styles.compactionHeader}
        activeOpacity={0.7}
      >
        <FontAwesome
          name={expanded ? "chevron-down" : "chevron-right"}
          size={10}
          color="#d97706"
          style={{ marginRight: 6 }}
        />
        <RNText style={styles.compactionTitle}>Previous context summary</RNText>
      </TouchableOpacity>
      {expanded && (
        <RNView style={styles.compactionContentWrap}>
          <MarkdownContent text={content} baseStyle={styles.compactionContent} isUser={false} />
        </RNView>
      )}
    </RNView>
  );
}

function GitDiffView({ diff }: { diff: string }) {
  return <CastDiff raw={diff} fallback={<RawDiffLines diff={diff} />} />;
}

// A diff with no hunks to parse, shown line by line.
function RawDiffLines({ diff }: { diff: string }) {
  const Theme = useTheme();
  const lines = diff.split('\n');
  return (
    <ScrollView horizontal style={styles.hScroll} nestedScrollEnabled>
      <RNView style={{ padding: 8 }}>
        {lines.map((line, i) => {
          let color = Theme.textMuted;
          let bg = 'transparent';
          if (line.startsWith('+') && !line.startsWith('+++')) {
            color = Theme.green;
            bg = Theme.green + '12';
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            color = Theme.red;
            bg = Theme.red + '12';
          } else if (line.startsWith('@@')) {
            color = Theme.blue;
          } else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
            color = Theme.textSecondary;
          }
          return (
            <RNText key={i} style={{ fontFamily: 'JetBrainsMono-Regular', fontSize: 11, color, backgroundColor: bg, lineHeight: 16 }}>
              {line}
            </RNText>
          );
        })}
      </RNView>
    </ScrollView>
  );
}

const PLAN_MAX_HEIGHT = 1800;

function PlanBlock({ content, timestamp, collapsed: collapsedProp }: { content: string; timestamp?: number; collapsed?: boolean }) {
  const Theme = useTheme();
  const [expanded, setExpanded] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [contentExpanded, setContentExpanded] = useState(false);

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1] : 'Plan';

  if (collapsedProp) {
    return (
      <RNView style={[styles.planBlock, { paddingVertical: 6, paddingHorizontal: 10, marginBottom: 4 }]}>
        <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <FontAwesome name="clipboard" size={10} color={Theme.cyan} />
          <RNText style={{ fontSize: 11, color: Theme.textMuted, fontWeight: '500' }} numberOfLines={1}>{title}</RNText>
        </RNView>
      </RNView>
    );
  }

  return (
    <>
    <RNView style={styles.planBlock}>
      <RNView style={styles.planHeader}>
        <TouchableOpacity
          onPress={() => setExpanded(!expanded)}
          style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
          activeOpacity={0.7}
        >
          <FontAwesome name="clipboard" size={12} color={Theme.cyan} style={{ marginRight: 6 }} />
          <RNText style={styles.planTitle}>{title}</RNText>
          {timestamp && <RNText style={{ fontSize: 10, color: Theme.textDim, marginLeft: 4 }}>{formatRelativeTime(timestamp)}</RNText>}
          <FontAwesome name={expanded ? "chevron-down" : "chevron-right"} size={10} color={Theme.textDim} style={{ marginLeft: 'auto' }} />
        </TouchableOpacity>
        {expanded && (
          <TouchableOpacity onPress={() => setFullscreen(true)} style={{ padding: 4, marginLeft: 8 }} activeOpacity={0.6}>
            <FontAwesome name="expand" size={12} color={Theme.textDim} />
          </TouchableOpacity>
        )}
      </RNView>
      {expanded && (
        <RNView
          style={[styles.planContent, !contentExpanded && { maxHeight: PLAN_MAX_HEIGHT, overflow: 'hidden' }]}
          onLayout={(e) => setIsOverflowing(e.nativeEvent.layout.height >= PLAN_MAX_HEIGHT)}
        >
          <MarkdownContent text={content} baseStyle={styles.planText} isUser={false} />
          {!contentExpanded && isOverflowing && (
            <LinearGradient
              colors={[Theme.bgAlt + '00', Theme.bgAlt]}
              style={styles.planGradientOverlay}
              pointerEvents="none"
            />
          )}
        </RNView>
      )}
      {expanded && (isOverflowing || contentExpanded) && (
        <RNView style={styles.planActions}>
          <TouchableOpacity onPress={() => setContentExpanded(!contentExpanded)} activeOpacity={0.7}>
            <RNText style={styles.planActionText}>{contentExpanded ? 'Collapse' : 'Expand'}</RNText>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setFullscreen(true)} activeOpacity={0.7}>
            <RNText style={styles.planActionText}>Fullscreen</RNText>
          </TouchableOpacity>
        </RNView>
      )}
    </RNView>
    <Modal visible={fullscreen} animationType="slide" onRequestClose={() => setFullscreen(false)}>
      <RNView style={styles.planFullscreen}>
        <RNView style={styles.planFullscreenHeader}>
          <FontAwesome name="clipboard" size={14} color={Theme.cyan} style={{ marginRight: 8 }} />
          <RNText style={styles.planFullscreenTitle}>{title}</RNText>
          <TouchableOpacity onPress={() => setFullscreen(false)} style={{ padding: 6 }} activeOpacity={0.7}>
            <FontAwesome name="close" size={18} color={Theme.textMuted} />
          </TouchableOpacity>
        </RNView>
        <ScrollView style={styles.planFullscreenContent} contentContainerStyle={{ paddingBottom: 60 }}>
          <MarkdownContent text={content} baseStyle={styles.planFullscreenText} isUser={false} />
        </ScrollView>
      </RNView>
    </Modal>
    </>
  );
}

type TeammateMessagePart = { type: 'text'; content: string } | { type: 'teammate'; teammateId: string; color?: string; summary?: string; content: string };

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

const agentColors: Record<string, string> = {
  blue: Theme.blue,
  red: Theme.red,
  green: Theme.green,
  yellow: '#b58900',
  purple: Theme.violet,
  cyan: Theme.cyan,
  orange: Theme.orange,
  pink: '#ec4899',
};

function TeammateMessageCard({ teammateId, color, summary, content }: { teammateId: string; color?: string; summary?: string; content: string }) {
  const Theme = useTheme();
  const [expanded, setExpanded] = useState(false);

  const safeContent = content || '';
  let parsed: any = null;
  try { if (safeContent) parsed = JSON.parse(safeContent); } catch {}

  const borderColor = agentColors[color || 'blue'] || Theme.blue;
  const isLong = safeContent.length > 200;

  // Idle notification
  if (parsed?.type === 'idle_notification') {
    const idleSummary = parsed.summary;
    return (
      <RNView style={[styles.teammateIdle, !idleSummary && { opacity: 0.5 }]}>
        <RNView style={[styles.teammateBadge, { backgroundColor: borderColor + '20', borderColor: borderColor + '60' }]}>
          <RNText style={[styles.teammateBadgeText, { color: borderColor }]}>{teammateId}</RNText>
        </RNView>
        <RNText style={styles.teammateIdleText}>{idleSummary || 'idle'}</RNText>
      </RNView>
    );
  }

  // Task assignment
  if (parsed?.type === 'task_assignment') {
    return (
      <RNView style={styles.teammateIdle}>
        <RNView style={[styles.teammateBadge, { backgroundColor: borderColor + '20', borderColor: borderColor + '60' }]}>
          <RNText style={[styles.teammateBadgeText, { color: borderColor }]}>{parsed.assignedBy || teammateId}</RNText>
        </RNView>
        <RNText style={styles.teammateIdleText}>
          assigned #{parsed.taskId} {parsed.subject}
        </RNText>
      </RNView>
    );
  }

  // Shutdown request
  if (parsed?.type === 'shutdown_request') {
    return (
      <RNView style={styles.teammateIdle}>
        <RNView style={[styles.teammateBadge, { backgroundColor: Theme.red + '20', borderColor: Theme.red + '60' }]}>
          <RNText style={[styles.teammateBadgeText, { color: Theme.red }]}>{teammateId}</RNText>
        </RNView>
        <RNText style={[styles.teammateIdleText, { color: Theme.red, fontStyle: 'italic' }]}>shutdown request</RNText>
      </RNView>
    );
  }

  // Regular message - render markdown if rich content
  const hasMarkdown = safeContent.includes('```') || safeContent.includes('**') || safeContent.includes('###');

  return (
    <RNView style={[styles.teammateMessage, { borderLeftColor: borderColor }]}>
      <RNView style={styles.teammateHeader}>
        <RNView style={[styles.teammateBadge, { backgroundColor: borderColor + '20', borderColor: borderColor + '60' }]}>
          <RNText style={[styles.teammateBadgeText, { color: borderColor }]}>{teammateId}</RNText>
        </RNView>
        {summary && <RNText style={styles.teammateSummary}>{summary}</RNText>}
      </RNView>
      {hasMarkdown && (expanded || !isLong) ? (
        <MarkdownContent text={safeContent} baseStyle={styles.teammateContent} isUser={false} />
      ) : (
        <RNText
          style={styles.teammateContent}
          numberOfLines={!expanded && isLong ? 4 : undefined}
          selectable
        >
          {safeContent}
        </RNText>
      )}
      {isLong && (
        <TouchableOpacity onPress={() => setExpanded(!expanded)} activeOpacity={0.7}>
          <RNText style={styles.teammateExpand}>{expanded ? 'Show less' : 'Show more'}</RNText>
        </TouchableOpacity>
      )}
    </RNView>
  );
}

type SkillBlockPart = { type: 'text' | 'skill'; content: string; skillName?: string; skillDesc?: string; skillPath?: string };

function parseSkillBlocks(text: string): SkillBlockPart[] {
  if (!text || typeof text !== 'string') {
    return [{ type: 'text', content: String(text || '') }];
  }
  const parts: SkillBlockPart[] = [];
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
  return parts;
}

function SkillBlockCard({ name, description, path }: { name?: string; description?: string; path?: string }) {
  const Theme = useTheme();
  const shortPath = path ? path.replace(/^\/Users\/[^/]+\//, "~/") : undefined;
  return (
    <RNView style={styles.skillBlockCard}>
      <RNText style={styles.skillBlockName}>/{name || "skill"}</RNText>
      {description && <RNText style={styles.skillBlockDesc}>{description}</RNText>}
      {shortPath && <RNText style={styles.skillBlockPath}>{shortPath}</RNText>}
    </RNView>
  );
}

function isTaskNotification(content: string): boolean {
  return content.trim().startsWith('<task-notification>');
}

function parseTaskNotification(content: string): { taskId: string; status: string; summary: string; outputFile?: string } | null {
  const match = content.match(/<task-notification>([\s\S]*?)<\/task-notification>/);
  if (!match) return null;
  const inner = match[1];
  const taskId = inner.match(/<task-id>(.*?)<\/task-id>/)?.[1] || '';
  const status = inner.match(/<status>(.*?)<\/status>/)?.[1] || '';
  const summary = inner.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || '';
  const outputFile = inner.match(/<output-file>(.*?)<\/output-file>/)?.[1];
  return { taskId, status, summary, outputFile };
}

const taskStatusConfig: Record<string, { icon: string; color: string; bg: string }> = {
  completed: { icon: '\u2713', color: Theme.green, bg: Theme.green + '1a' },
  killed: { icon: '\u25A0', color: Theme.orange, bg: Theme.orange + '1a' },
  failed: { icon: '\u2717', color: Theme.red, bg: Theme.red + '1a' },
  running: { icon: '\u25B6', color: Theme.blue, bg: Theme.blue + '1a' },
};

function TaskNotificationLine({ content, timestamp, childConversationMap }: { content: string; timestamp?: number; childConversationMap?: Record<string, string> }) {
  const Theme = useTheme();
  const router = useRouter();
  const parsed = parseTaskNotification(content);
  if (!parsed) return null;
  const config = taskStatusConfig[parsed.status] || taskStatusConfig.running;

  let childId: string | undefined;
  const nameMatch = parsed.summary.match(/['\u201c\u201d"](.*?)['\u201c\u201d"]/);
  const agentName = nameMatch?.[1];
  if (agentName && childConversationMap) {
    childId = childConversationMap[agentName];
  }

  return (
    <TouchableOpacity
      onPress={childId ? () => router.push(`/session/${childId}`) : undefined}
      activeOpacity={childId ? 0.7 : 1}
      style={[styles.taskNotificationRow, { backgroundColor: config.bg }]}
    >
      <RNText style={[styles.taskNotificationIcon, { color: config.color }]}>{config.icon}</RNText>
      <RNText style={styles.taskNotificationSummary} numberOfLines={2}>{parsed.summary}</RNText>
      <RNText style={styles.taskNotificationId}>{parsed.taskId}</RNText>
      {timestamp != null && <RNText style={styles.taskNotificationTime}>{formatRelativeTime(timestamp)}</RNText>}
    </TouchableOpacity>
  );
}

// Mobile port of web's SessionMessageBlock: a cross-session `cast send` message
// is machine-delivered, not typed by the human, so it renders as a cyan-accented
// card naming the sender instead of a user bubble full of raw XML.
// `variant: 'agent'` is a subagent's report to the session that launched it
// (<agent-message from="…">) — the same card in violet, and a sender that is an
// agent name rather than a session short id, so it stays a badge.
function SessionMessageBlock({ from, name, body, timestamp, variant }: { from: string; name?: string; body: string; timestamp?: number; variant?: 'agent' }) {
  const Theme = useTheme();
  const isAgentReport = variant === 'agent';
  const accent = isAgentReport ? Theme.violet : Theme.cyan;
  const hasRealSender = !isAgentReport && !!from && from !== 'unknown';
  return (
    <RNView style={[styles.sessionMessageBlock, isAgentReport && { borderLeftColor: accent + '99', backgroundColor: accent + '0d' }]}>
      <RNView style={styles.sessionMessageHeader}>
        <Feather name={isAgentReport ? 'cpu' : 'corner-down-right'} size={13} color={accent + 'b3'} />
        <RNText style={[styles.sessionMessageLabel, isAgentReport && { color: accent + 'b3' }]}>{isAgentReport ? 'Report from' : 'Message from'}</RNText>
        {hasRealSender ? (
          // Resolves the sender's title server-side and taps through to the
          // session — same as web's EntityIdPill in this header.
          <EntityPill shortId={from} />
        ) : (
          <RNView style={[styles.sessionMessageBadge, isAgentReport && { borderColor: accent + '4d', backgroundColor: accent + '1a' }]}>
            <RNText style={[styles.sessionMessageBadgeText, isAgentReport && { color: accent }]}>{(isAgentReport ? from : name) || 'another session'}</RNText>
          </RNView>
        )}
        {timestamp != null && timestamp > 0 && (
          <RNText style={styles.sessionMessageTime}>{formatRelativeTime(timestamp)}</RNText>
        )}
      </RNView>
      <CollapsibleBody fadeColor={blendOver(accent + '0d', Theme.bg)}>
        <MarkdownContent text={body} baseStyle={styles.sessionMessageBody} isUser={false} />
      </CollapsibleBody>
    </RNView>
  );
}

// Mobile port of web's ChatWakeBlock: a team-chat mention waking the anchor.
// Shows the channel, who asked, and the quoted thread by speaker; the briefing
// around the quote is for the agent, not the reader.
function ChatWakeBlock({ wake, timestamp }: { wake: ChatWakePrompt; timestamp?: number }) {
  const Theme = useTheme();
  const router = useRouter();
  // Land in the thread when it is known — the same route a chat push opens.
  const open = wake.channelId
    ? () => router.push((wake.threadRootId
      ? { pathname: '/chat/thread/[id]', params: { id: wake.threadRootId, channel: wake.channelId, ...(wake.placeholderId ? { m: wake.placeholderId } : {}) } }
      : { pathname: '/chat/[id]', params: { id: wake.channelId } }) as never)
    : undefined;
  return (
    <RNView style={[styles.sessionMessageBlock, { borderLeftColor: Theme.magenta + '99', backgroundColor: Theme.magenta + '0d' }]}>
      <RNView style={styles.sessionMessageHeader}>
        <Feather name="message-square" size={13} color={Theme.magenta + 'b3'} />
        <RNText style={[styles.sessionMessageLabel, { color: Theme.magenta + 'b3' }]}>Team chat</RNText>
        <TouchableOpacity disabled={!open} onPress={open} style={[styles.sessionMessageBadge, { borderColor: Theme.magenta + '4d', backgroundColor: Theme.magenta + '1a' }]}>
          <RNText style={[styles.sessionMessageBadgeText, { color: Theme.magenta }]}>{chatWakePlace(wake)}</RNText>
        </TouchableOpacity>
        <RNText style={styles.sessionMessageTitle} numberOfLines={1}>{wake.askerName} {chatWakeAction(wake)}</RNText>
        {timestamp != null && timestamp > 0 && (
          <RNText style={styles.sessionMessageTime}>{formatRelativeTime(timestamp)}</RNText>
        )}
      </RNView>
      <CollapsibleBody fadeColor={blendOver(Theme.magenta + '0d', Theme.bg)}>
        {wake.context.map((entry, i) => (
          <RNText key={`c${i}`} style={[styles.sessionMessageBody, { opacity: 0.6 }]} selectable>
            <RNText style={{ fontWeight: '600', color: entry.self ? Theme.magenta : Theme.text }}>{entry.self ? 'You' : entry.name}</RNText>
            {'  '}{entry.content}
          </RNText>
        ))}
        {wake.entries.map((entry, i) => (
          <RNText key={i} style={styles.sessionMessageBody} selectable>
            <RNText style={{ fontWeight: '600', color: entry.self ? Theme.magenta : Theme.text }}>{entry.self ? 'You' : entry.name}</RNText>
            {'  '}{entry.content}
          </RNText>
        ))}
      </CollapsibleBody>
    </RNView>
  );
}

// Mobile twin of web's VaultReadyLine: a filled vault request is a system
// line naming the secret, which opens it in the Vault. The usage text is for
// the agent.
function VaultReadyLine({ vault, timestamp }: { vault: VaultReadyMessage; timestamp?: number }) {
  const Theme = useTheme();
  const router = useRouter();
  const route = mobileEntityRoute('secret', vault.id || vault.name);
  return (
    <RNView style={styles.vaultReadyLine} testID={`vault-ready-${vault.name}`}>
      <Feather name="lock" size={12} color={Theme.yellow + 'cc'} />
      <RNText style={[styles.vaultReadyText, { color: Theme.text }]} numberOfLines={1} onPress={route ? () => router.push(route as never) : undefined}>{vault.name}</RNText>
      <RNText style={[styles.vaultReadyText, { color: Theme.green + 'cc' }]}>ready in Vault</RNText>
      {timestamp != null && timestamp > 0 && <RNText style={[styles.vaultReadyText, { color: Theme.textDim }]}>· {formatRelativeTime(timestamp)}</RNText>}
    </RNView>
  );
}

// Mobile port of web's ScheduledTaskBlock: a `cast trigger` prompt injection.
// (<scheduled-task> is the frozen pre-rename wire tag; old transcripts carry it.)
function ScheduledTaskBlock({ content: rawContent, timestamp }: { content: string; timestamp?: number }) {
  const Theme = useTheme();
  const content = rawContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  const match = content.match(/<scheduled-task\s+title="([^"]*)"(?:\s+task-id="([^"]*)")?[^>]*>([\s\S]*?)<\/scheduled-task>/);
  const title = match?.[1]?.replace(/&quot;/g, '"') || 'Trigger Run';
  const prompt = match?.[3]?.trim() || content.replace(/<[^>]+>/g, '').trim();
  return (
    <RNView style={[styles.sessionMessageBlock, { borderLeftColor: Theme.violet + '99', backgroundColor: Theme.violet + '0d' }]}>
      <RNView style={styles.sessionMessageHeader}>
        <Feather name="zap" size={13} color={Theme.violet + 'b3'} />
        <RNText style={[styles.sessionMessageLabel, { color: Theme.violet + 'b3' }]}>Trigger</RNText>
        <RNText style={styles.sessionMessageTitle} numberOfLines={1}>{title}</RNText>
        {timestamp != null && timestamp > 0 && (
          <RNText style={styles.sessionMessageTime}>{formatRelativeTime(timestamp)}</RNText>
        )}
      </RNView>
      <CollapsibleBody fadeColor={blendOver(Theme.violet + '0d', Theme.bg)}>
        <RNText style={styles.sessionMessageBody} selectable>{linkifyPlainText(prompt, 'tp')}</RNText>
      </CollapsibleBody>
    </RNView>
  );
}

// Mobile twin of web's WorkflowTaskBlock: a Workflow-tool agent's brief from
// the workflow script, authored markdown in the trigger card's shape.
function WorkflowTaskBlock({ body, timestamp }: { body: string; timestamp?: number }) {
  const Theme = useTheme();
  return (
    <RNView style={[styles.sessionMessageBlock, { borderLeftColor: Theme.cyan + '99', backgroundColor: Theme.cyan + '0d' }]}>
      <RNView style={styles.sessionMessageHeader}>
        <Feather name="git-merge" size={13} color={Theme.cyan + 'b3'} />
        <RNText style={[styles.sessionMessageLabel, { color: Theme.cyan + 'b3' }]}>Workflow task</RNText>
        {timestamp != null && timestamp > 0 && (
          <RNText style={styles.sessionMessageTime}>{formatRelativeTime(timestamp)}</RNText>
        )}
      </RNView>
      <CollapsibleBody fadeColor={blendOver(Theme.cyan + '0d', Theme.bg)}>
        <MarkdownContent text={body} baseStyle={styles.sessionMessageBody} />
      </CollapsibleBody>
    </RNView>
  );
}

// One card per way a turn can fail, the kinds web's parser
// (classify.parseApiErrorContent) tells apart: what stopped it and the one
// move that gets it going again.
function apiErrorView(error: ParsedApiError): { heading: string; hint?: string; tone: 'red' | 'orange' | 'yellow' } {
  if (error.isLimit) return { heading: 'Usage limit', hint: 'The session continues when the limit resets.', tone: 'yellow' };
  if (error.isSafety) return { heading: 'Safety review required', hint: SAFETY_BLOCK_HINT, tone: 'orange' };
  if (error.isAuth) return { heading: 'Sign in again', hint: 'Run /login in the session, then retry.', tone: 'orange' };
  if (error.isThrottle) return { heading: 'Rate limited', hint: 'Codecast retries it in about a minute. Send continue to retry now.', tone: 'yellow' };
  if (error.isContext) return { heading: 'Context full', tone: 'orange' };
  if (error.isConnection) return { heading: 'Connection dropped', hint: 'Send continue and it picks up where it stopped.', tone: 'yellow' };
  const server = (error.statusCode ?? 0) >= 500;
  return { heading: 'API error', hint: error.isFatal ? 'The agent will not retry this. Send continue to retry.' : server ? 'Provider failure. Retry; quote the request id if it repeats.' : undefined, tone: server ? 'red' : 'orange' };
}

function CompactionProgressRow({ progress }: { progress: CompactionProgress }) {
  const Theme = useTheme();
  return (
    <RNView style={{ paddingVertical: 4, gap: 6 }}>
      <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Feather name="layers" size={12} color={Theme.yellow} />
        <RNText style={{ fontSize: 12, fontWeight: '600', color: Theme.yellow }}>Compacting conversation</RNText>
        <RNView style={{ flex: 1 }} />
        {progress.percent != null && <RNText style={{ fontSize: 11, color: Theme.textMuted }}>{progress.percent}%</RNText>}
        {!!progress.elapsed && <RNText style={{ fontSize: 11, color: Theme.textDim }}>{progress.elapsed}</RNText>}
      </RNView>
      {progress.percent != null && (
        <RNView style={{ height: 3, borderRadius: 2, backgroundColor: Theme.bgHighlight, overflow: 'hidden' }}>
          <RNView style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%`, height: 3, backgroundColor: Theme.yellow }} />
        </RNView>
      )}
      {!!progress.tip && <RNText style={{ fontSize: 11, color: Theme.textDim }}>{progress.tip}</RNText>}
    </RNView>
  );
}

function ApiErrorCard({ error, conversationId }: { error: ParsedApiError; conversationId?: string }) {
  const Theme = useTheme();
  const view = apiErrorView(error);
  const color = Theme[view.tone];
  // A full context window is cleared by a slash command typed into the
  // session; the card sends it, the same way the composer would.
  const send = (command: '/compact' | '/clear') => {
    if (!conversationId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const store = useInboxStore.getState();
    store.sendMessage(conversationId, command);
    store.markBlockedReviveRequested([conversationId]);
  };
  return (
    <RNView style={[styles.apiErrorCard, { borderColor: color + '60', backgroundColor: color + '0d' }]}>
      <RNView style={styles.apiErrorHeader}>
        <RNText style={[styles.apiErrorCode, { color }]}>{view.heading}</RNText>
        {!!error.statusCode && !error.isLimit && !error.isConnection && <RNText style={[styles.apiErrorType, { color: color + 'cc' }]}>{error.statusCode}</RNText>}
        {!!error.errorType && !error.isAuth && !error.isLimit && <RNText style={[styles.apiErrorType, { color: color + 'cc' }]}>{error.errorType}</RNText>}
      </RNView>
      <RNText style={styles.apiErrorMessage}>{error.message}</RNText>
      {!!error.requestId && !error.isAuth && !error.isLimit && <RNText style={styles.apiErrorRequestId} selectable>{error.requestId}</RNText>}
      {!!view.hint && <RNText style={[styles.apiErrorRequestId, { marginTop: 4 }]}>{view.hint}</RNText>}
      {error.isContext && !!conversationId && (
        <RNView style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <TouchableOpacity onPress={() => send('/compact')} activeOpacity={0.7} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: color }}>
            <RNText style={{ fontSize: 12, fontWeight: '700', color: Theme.bg }}>Compact</RNText>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => send('/clear')} activeOpacity={0.7} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: color + '80' }}>
            <RNText style={{ fontSize: 12, fontWeight: '700', color }}>Clear</RNText>
          </TouchableOpacity>
        </RNView>
      )}
    </RNView>
  );
}

// "★ Insight ─────" parsing + card rendering live inside MarkdownContent
// (components/MarkdownRenderer.tsx, shared parser from web insightBlocks.ts)
// so every markdown surface gets them, not just the message-bubble branch.

type ParsedContextBlock = { type: string; title: string; id?: string; status?: string; priority?: string };

function parseContextBlocks(text: string): { contexts: ParsedContextBlock[]; remaining: string } {
  const contexts: ParsedContextBlock[] = [];
  const remaining = text.replace(
    /<context\s+type="([^"]+)"\s+title="([^"]+)">\s*([\s\S]*?)\s*<\/context>\s*/g,
    (_, type, title, inner) => {
      const ctx: ParsedContextBlock = { type, title };
      const idMatch = inner.match(/ID:\s*(\S+)/);
      const statusMatch = inner.match(/Status:\s*(\S+)/);
      const priorityMatch = inner.match(/Priority:\s*(\S+)/);
      if (idMatch) ctx.id = idMatch[1];
      if (statusMatch) ctx.status = statusMatch[1];
      if (priorityMatch) ctx.priority = priorityMatch[1];
      contexts.push(ctx);
      return '';
    }
  ).trim();
  return { contexts, remaining };
}

const contextTypeConfig: Record<string, { icon: 'list' | 'crosshairs' | 'file-text-o'; color: string }> = {
  task: { icon: 'list', color: Theme.accent },
  plan: { icon: 'crosshairs', color: Theme.cyan },
  doc: { icon: 'file-text-o', color: Theme.violet },
};

function ContextBlockPill({ ctx }: { ctx: ParsedContextBlock }) {
  const Theme = useTheme();
  const config = contextTypeConfig[ctx.type] || contextTypeConfig.doc;
  return (
    <RNView style={[styles.contextPill, { borderColor: config.color + '40' }]}>
      <FontAwesome name={config.icon} size={9} color={config.color} />
      <RNText style={[styles.contextPillText, { color: config.color }]} numberOfLines={1}>{ctx.title}</RNText>
      {ctx.id && <RNText style={styles.contextPillId}>{ctx.id}</RNText>}
    </RNView>
  );
}

// Every image a tool call produced (a screenshot, several viewports side by
// side), each opening the gallery.
function ToolImages({ toolId, images, globalImageMap, openGallery }: {
  toolId: string;
  images?: ImageData[];
  globalImageMap?: Record<string, ImageData>;
  openGallery?: (image: ImageData) => void;
}) {
  let list = images?.filter((img) => img.tool_use_id === toolId) ?? [];
  if (!list.length && globalImageMap?.[toolId]) list = [globalImageMap[toolId]];
  if (!list.length) return null;
  return (
    <RNView style={[styles.toolImagesSection, list.length > 1 && { flexDirection: 'row', gap: 6 }]}>
      {list.map((img, i) => (
        <RNView key={i} style={list.length > 1 ? { flex: 1, minWidth: 0 } : undefined}>
          <ImageBlock image={img} onPress={() => openGallery?.(img)} />
        </RNView>
      ))}
    </RNView>
  );
}

function ToolCallItem({ toolCall, result, expanded, onToggle, images, globalImageMap, openGallery }: {
  toolCall: ToolCall;
  result?: ToolResult;
  expanded: boolean;
  onToggle: () => void;
  images?: ImageData[];
  globalImageMap?: Record<string, ImageData>;
  openGallery?: (image: ImageData) => void;
}) {
  // A wrapper call (Codex `exec`, the extension's `browser_batch`) is named
  // after its one inner step when there is one, and summarised by its steps
  // otherwise — the same rule as the web ToolBlock.
  const nestedActions = extractNestedActions(toolCall);
  const displayToolName = nestedActions.length === 1
    ? nestedActions[0].name
    : toolCall.name;
  const color = toolColorHex[toolIcon(displayToolName).color];
  const summary = toolSummary(nestedActions.length === 1 ? nestedActions[0] : toolCall);
  const [viewMode, setViewMode] = useState<'raw' | 'rendered'>('rendered');

  // Format input nicely - parse JSON and extract relevant fields
  let inputDisplay = toolCall.input;
  try {
    const parsed = JSON.parse(toolCall.input);
    if (isShellTool(toolCall.name) && (parsed.command || parsed.cmd)) {
      // For shell tools, just show the command
      inputDisplay = parsed.command || parsed.cmd;
    } else {
      // For other tools, format as key: value pairs
      // Filter out verbose/internal fields
      const verboseFields = ['dangerouslyDisableSandbox', '_simulatedSedEdit', 'timeout', 'run_in_background'];
      inputDisplay = Object.entries(parsed)
        .filter(([key]) => !key.startsWith('_') && !verboseFields.includes(key))
        .map(([key, value]) => {
          if (typeof value === 'string' && value.length > 100) {
            return `${key}: ${value.slice(0, 100)}...`;
          }
          if (typeof value === 'object' && value !== null) {
            // Don't show complex objects
            return null;
          }
          return `${key}: ${value}`;
        })
        .filter(Boolean)
        .join('\n');
    }
  } catch {
    // If parsing fails, use raw input
  }

  if (expanded && inputDisplay.length > 2000) {
    inputDisplay = inputDisplay.slice(0, 2000) + '\n... (truncated)';
  }

  const isRead = isReadTool(toolCall.name);
  const processedResult = result?.content ? (isRead ? stripLineNumbers(result.content) : result.content) : '';
  const resultDisplay = result && expanded && processedResult.length > 2000
      ? processedResult.slice(0, 2000) + '\n... (truncated)'
      : (processedResult || undefined);

  const isBash = isShellTool(toolCall.name);
  // A Codex apply_patch, or a patch a shell command carried (`apply_patch <<'EOF'`).
  const patchInputs = useMemo(() => getToolPatchInputs({ name: toolCall.name, input: toolCall.input }), [toolCall.name, toolCall.input]);
  const isEdit = isEditTool(toolCall.name) || patchInputs.length > 0;
  const isWrite = isWriteTool(toolCall.name);

  // How the call came out, the shared hint the web's phone view reads too.
  const resultSummary = toolResultHint(toolCall, result);

  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(toolCall.input); } catch {}


  const filePath = toolPathFromInput(parsedInput);
  const language = filePath ? getFileExtension(filePath) : undefined;
  const isCodeResult = result && (
    isBash ||
    isRead ||
    isWrite ||
    isEdit ||
    isGrepTool(toolCall.name) ||
    isGlobTool(toolCall.name) ||
    toolCall.name === 'apply_patch' ||
    toolCall.name === 'code_search' ||
    toolCall.name === 'code_analysis'
  );

  // Check if result is markdown-like (contains ### or **)
  const isMarkdownResult = result && !isCodeResult && typeof result.content === 'string' && (
    result.content.includes('###') ||
    result.content.includes('**') ||
    result.content.includes('```')
  );

  const isMarkdownFile = language === 'markdown' || filePath.endsWith('.plan');
  const writeContent = isWrite ? String(parsedInput.content || '') : '';
  const readContent = isRead ? (result?.content || '') : '';
  const mdContent = isWrite ? writeContent : readContent;
  const isPlan = isMarkdownFile && isPlanFile(filePath, mdContent);
  const canToggleViewMode = isMarkdownFile && (isRead || isWrite) && result && result.content;

  const TOOL_CONTENT_MAX_HEIGHT = 350;
  const MD_COLLAPSED_HEIGHT = 350;
  const hasDiff = isEdit && !!parsedInput.old_string && !!parsedInput.new_string;
  const [mdOverflowing, setMdOverflowing] = useState(false);
  const [mdExpanded, setMdExpanded] = useState(false);
  const [mdFullscreen, setMdFullscreen] = useState(false);
  const [toolContentOverflowing, setToolContentOverflowing] = useState(false);
  const [toolContentFullExpanded, setToolContentFullExpanded] = useState(false);

  // Tools that shouldn't show their input (just noise)
  // Command is shown in summary, no need to repeat
  const shouldHideInput = isShellTool(toolCall.name)
    || isReadTool(toolCall.name)
    || isWriteTool(toolCall.name)
    || isEditTool(toolCall.name)
    || isGrepTool(toolCall.name)
    || isGlobTool(toolCall.name)
    || isTodoTool(toolCall.name)
    || [
      'apply_patch',
      'TaskOutput',
      'TaskList',
      'TaskGet',
      'TaskStop',
      'TeamDelete',
      'ExitPlanMode',
      'EnterPlanMode',
      'enter_plan_mode',
      'exit_plan_mode',
      'WebSearch',
      'WebFetch',
      'web_search',
      'web_fetch',
      'code_search',
      'code_analysis',
      'NotebookEdit',
      'Skill',
      'TeamCreate',
      'TaskCreate',
      'TaskUpdate',
    ].includes(toolCall.name) || toolCall.name.startsWith('mcp__');

  return (
    <Pressable onPress={onToggle} style={styles.toolCallContainer}>
      <RNText style={styles.toolCallHeader} numberOfLines={expanded ? undefined : 1}>
        <RNText style={[styles.toolCallName, { color }]}>{toolLabel(displayToolName)}</RNText>
        {summary ? (
          <RNText style={styles.toolCallSummary}> {summary}</RNText>
        ) : null}
        {resultSummary ? (
          <RNText style={[styles.toolCallResultHint, result?.is_error && { color: Theme.red }]}> {resultSummary}</RNText>
        ) : null}
      </RNText>
      <ToolImages toolId={toolCall.id} images={images} globalImageMap={globalImageMap} openGallery={openGallery} />
      {expanded && (
        <RNView
          onLayout={(e) => { if (!toolContentFullExpanded && !hasDiff) setToolContentOverflowing(e.nativeEvent.layout.height >= TOOL_CONTENT_MAX_HEIGHT - 1); }}
          style={[styles.toolCallContent, (hasDiff || patchInputs.length > 0) && styles.toolCallContentBare, result?.is_error && styles.toolCallContentError, !toolContentFullExpanded && !hasDiff && { maxHeight: TOOL_CONTENT_MAX_HEIGHT, overflow: 'hidden' as const }]}>

          {language && !isBash && !(isEdit && parsedInput.old_string && parsedInput.new_string) && (
            <RNView style={styles.languageLabelRow}>
              <RNText style={styles.languageLabel}>{language}</RNText>
              {isPlan && (
                <RNView style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, backgroundColor: Theme.bgHighlight }}>
                  <RNText style={{ fontSize: 9, color: Theme.textMuted, fontWeight: '600', fontFamily: 'JetBrainsMono-Regular' }}>PLAN</RNText>
                </RNView>
              )}
              {canToggleViewMode && (
                <RNView style={styles.viewModeToggle}>
                  <Pressable onPress={() => setViewMode('raw')} style={[styles.viewModeBtn, viewMode === 'raw' && styles.viewModeBtnActive]}>
                    <RNText style={[styles.viewModeBtnText, viewMode === 'raw' && styles.viewModeBtnTextActive]}>Raw</RNText>
                  </Pressable>
                  <Pressable onPress={() => setViewMode('rendered')} style={[styles.viewModeBtn, viewMode === 'rendered' && styles.viewModeBtnActive]}>
                    <RNText style={[styles.viewModeBtnText, viewMode === 'rendered' && styles.viewModeBtnTextActive]}>Rendered</RNText>
                  </Pressable>
                </RNView>
              )}
            </RNView>
          )}
          {isBash && inputDisplay ? (
            <RNView style={styles.bashCommandSection}>
              <RNText style={styles.bashPrompt} selectable>
                <RNText>$ </RNText>
                <RNText>{linkifyPlainText(inputDisplay, 'bp')}</RNText>
              </RNText>
            </RNView>
          ) : !shouldHideInput && toolCall.input && toolCall.input.length > 2 ? (
            <RNView style={styles.toolInputSection}>
              <RNText style={styles.toolCallInput} selectable>{linkifyPlainText(inputDisplay, 'ti')}</RNText>
            </RNView>
          ) : null}
          {isEdit && parsedInput.old_string && parsedInput.new_string ? (
            <EditDiff oldStr={String(parsedInput.old_string)} newStr={String(parsedInput.new_string)} filePath={filePath} />
          ) : isWrite && parsedInput.content ? (
            isMarkdownFile && viewMode === 'rendered' ? (
              <>
                <RNView
                  style={!mdExpanded && mdOverflowing ? { maxHeight: MD_COLLAPSED_HEIGHT, overflow: 'hidden' } : undefined}
                  onLayout={(e) => { if (!mdExpanded) setMdOverflowing(e.nativeEvent.layout.height >= MD_COLLAPSED_HEIGHT - 1); }}
                >
                  <MarkdownContent text={String(parsedInput.content)} baseStyle={styles.toolCallResult} isUser={false} />
                  {!mdExpanded && mdOverflowing && (
                    <LinearGradient colors={[Theme.bg + '00', Theme.bg]} style={styles.planGradientOverlay} pointerEvents="none" />
                  )}
                </RNView>
                {(mdOverflowing || mdExpanded) && (
                  <RNView style={{ flexDirection: 'row', gap: 12, paddingTop: 4, paddingHorizontal: 4 }}>
                    <TouchableOpacity onPress={() => setMdExpanded(!mdExpanded)} activeOpacity={0.7}>
                      <RNText style={styles.planActionText}>{mdExpanded ? 'Collapse' : 'Expand'}</RNText>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setMdFullscreen(true)} activeOpacity={0.7}>
                      <RNText style={styles.planActionText}>Fullscreen</RNText>
                    </TouchableOpacity>
                  </RNView>
                )}
              </>
            ) : (
              <CodeBlockWithCopy content={String(parsedInput.content)} language={language || 'plaintext'} />
            )
          ) : patchInputs.length > 0 ? (
            <ApplyPatchDiff inputs={patchInputs} fallback={<CodeBlockWithCopy content={patchInputs.join('\n')} language="diff" />} />
          ) : null}
          {result && resultDisplay && resultDisplay.trim() && !(isEdit && parsedInput.old_string && parsedInput.new_string && !result.is_error) ? (
            <RNView style={styles.toolResultBox}>
              {canToggleViewMode && viewMode === 'rendered' ? (
                <MarkdownContent text={stripLineNumbers(resultDisplay)} baseStyle={styles.toolCallResult} isUser={false} />
              ) : isBash && ANSI_RE.test(resultDisplay) ? (
                // Colored command output (a test run, `ls --color`) keeps
                // its terminal colors instead of showing escape codes.
                <AnsiText text={resultDisplay} style={styles.ansiOutput} />
              ) : isCodeResult ? (
                <CodeBlockWithCopy
                  content={resultDisplay}
                  language={result.is_error ? 'error' : (isBash ? 'bash' : (isRead || isWrite || isEdit ? (language || 'plaintext') : 'plaintext'))}
                />
              ) : isMarkdownResult ? (
                <MarkdownContent text={resultDisplay} baseStyle={styles.toolCallResult} isUser={false} />
              ) : (
                <RNText style={[styles.toolCallResult, result.is_error && { color: Theme.red }]} selectable>
                  {linkifyPlainText(resultDisplay, 'tr')}
                </RNText>
              )}
            </RNView>
          ) : null}
          {!toolContentFullExpanded && toolContentOverflowing && (
            <LinearGradient colors={[Theme.bgAlt + '00', Theme.bgAlt]} style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 60 }} pointerEvents="none" />
          )}
        </RNView>
      )}
      {expanded && toolContentOverflowing && (
        <RNView style={{ flexDirection: 'row', gap: 12, paddingTop: 4, paddingHorizontal: 4 }}>
          <TouchableOpacity onPress={() => setToolContentFullExpanded(!toolContentFullExpanded)} activeOpacity={0.7}>
            <RNText style={{ fontSize: 11, color: Theme.cyan, fontWeight: '600' }}>{toolContentFullExpanded ? 'Collapse' : 'Expand'}</RNText>
          </TouchableOpacity>
        </RNView>
      )}
      {mdFullscreen && (
        <Modal visible={mdFullscreen} animationType="slide" onRequestClose={() => setMdFullscreen(false)}>
          <RNView style={styles.planFullscreen}>
            <RNView style={styles.planFullscreenHeader}>
              <FontAwesome name="file-text-o" size={14} color={Theme.cyan} style={{ marginRight: 8 }} />
              <RNText style={styles.planFullscreenTitle} numberOfLines={1}>{filePath.split('/').pop() || 'Markdown'}</RNText>
              <TouchableOpacity onPress={() => setMdFullscreen(false)} style={{ padding: 6 }} activeOpacity={0.7}>
                <FontAwesome name="close" size={18} color={Theme.textMuted} />
              </TouchableOpacity>
            </RNView>
            <ScrollView style={styles.planFullscreenContent} contentContainerStyle={{ paddingBottom: 60 }}>
              <MarkdownContent text={String(parsedInput.content || resultDisplay || '')} baseStyle={styles.planFullscreenText} isUser={false} />
            </ScrollView>
          </RNView>
        </Modal>
      )}
    </Pressable>
  );
}

// Reasoning text, rendered whenever a message carries non-empty `thinking`.
// claude/codex redact thinking (empty → nothing renders, unchanged), but
// opencode/pi carry real reasoning that would otherwise vanish — and a
// reasoning-only turn would disappear from the transcript entirely. Faded,
// collapsed to 2 lines by default, tap to expand.
function ThinkingBlock({ content }: { content: string }) {
  const Theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const isLong = content.split('\n').length > 2 || content.length > 200;
  return (
    <TouchableOpacity
      onPress={() => isLong && setExpanded(!expanded)}
      style={styles.thinkingBlock}
      activeOpacity={isLong ? 0.7 : 1}
    >
      <RNView style={styles.thinkingHeader}>
        {isLong && (
          <FontAwesome name={expanded ? 'chevron-down' : 'chevron-right'} size={8} color={Theme.textDim} style={{ marginRight: 4, marginTop: 3 }} />
        )}
        <RNText style={styles.thinkingText} numberOfLines={expanded ? undefined : 2}>
          {content}
        </RNText>
      </RNView>
    </TouchableOpacity>
  );
}

// Mobile port of web's DeliveryFailedBlock: a message the daemon stopped
// delivering, whether the agent can have seen it, and the action that puts it
// back (a trigger runs again, anything else is sent again).
function DeliveryFailedRail({ notice, conversationId, timestamp }: { notice: ReturnType<typeof parseDeliveryFailedNotice> & {}; conversationId?: string; timestamp?: number }) {
  const Theme = useTheme();
  const [done, setDone] = useState(false);
  const frame = parseScheduledTask(notice.message);
  const neverReached = notice.submitted === false;
  const color = neverReached ? Theme.red : Theme.orange;
  const cause = neverReached ? 'never reached the agent' : 'may have run';
  const what = frame ? frame.title : notice.message.trim().split('\n')[0];
  const action = frame?.task_id
    ? { label: 'Run again', doneLabel: 'Run queued', run: () => useInboxStore.getState().triggerAction(frame.task_id!, 'runNow') }
    : notice.complete && conversationId
      ? { label: 'Send again', doneLabel: 'Sent', run: () => useInboxStore.getState().sendMessage(conversationId, notice.message) }
      : null;
  return (
    <RNView style={[styles.systemRail, { borderLeftColor: color + '99', backgroundColor: color + '0d', alignItems: 'center' }]}>
      <Feather name="alert-triangle" size={12} color={color} />
      <RNView style={{ flex: 1, minWidth: 0 }}>
        <RNText style={[styles.systemRailKicker, { color }]}>Not delivered · {notice.writes} writes · {cause}</RNText>
        <RNText style={styles.systemRailText} numberOfLines={1}>{frame?.trigger ? `${frame.trigger} · ` : ''}{what}</RNText>
      </RNView>
      {action ? (
        <Pressable disabled={done} onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); action.run(); setDone(true); }} hitSlop={8}>
          <RNText style={[styles.systemRailText, { color: done ? Theme.textDim : Theme.text }]}>{done ? action.doneLabel : action.label}</RNText>
        </Pressable>
      ) : timestamp ? <RNText style={styles.commitTime}>{formatRelativeTime(timestamp)}</RNText> : null}
    </RNView>
  );
}

function SystemMessage({ message, conversationId }: { message: Message; conversationId?: string }) {
  const Theme = useTheme();
  if (isHiddenSystemNotice(message.content, message.subtype)) return null;

  if (message.subtype === 'compact_boundary') {
    return (
      <RNView style={styles.compactBoundary}>
        <RNView style={styles.compactBoundaryLine} />
        <RNView style={styles.compactBoundaryPill}>
          <FontAwesome name="compress" size={10} color="#d97706" style={{ marginRight: 5 }} />
          <RNText style={styles.compactBoundaryText}>Context compacted</RNText>
        </RNView>
        <RNView style={styles.compactBoundaryLine} />
      </RNView>
    );
  }

  if (message.subtype === 'compaction_summary' && message.content) {
    return <CompactionSummaryBlock content={message.content} />;
  }

  // A cloud agent action's result (Create PR, Apply): codecast says it.
  if (message.subtype === CLOUD_AGENT_ACTION_SUBTYPE && message.content) {
    return (
      <RNView style={[styles.systemRail, { borderLeftColor: Theme.violet + '66', backgroundColor: Theme.violet + '0d' }]}>
        <Feather name="cloud" size={12} color={Theme.violet} style={{ marginTop: 3 }} />
        <RNView style={{ flex: 1 }}>
          <MarkdownContent text={message.content} baseStyle={styles.systemRailText} isUser={false} />
        </RNView>
        <RNText style={styles.commitTime}>{formatRelativeTime(message.timestamp)}</RNText>
      </RNView>
    );
  }

  if (message.subtype === DELIVERY_FAILED_SUBTYPE) {
    const notice = parseDeliveryFailedNotice(message.content);
    if (notice) return <DeliveryFailedRail notice={notice} conversationId={conversationId} timestamp={message.timestamp} />;
  }

  if (message.subtype === 'scheduled_task_prompt' && message.content) {
    return <ScheduledTaskBlock content={message.content} timestamp={message.timestamp} />;
  }

  // A /loop wakeup firing: the harness-side twin of a trigger run.
  if (message.subtype === 'scheduled_task_fire' && message.content) {
    return (
      <RNView style={[styles.systemRail, { borderLeftColor: Theme.violet + '99', backgroundColor: Theme.violet + '0d', alignItems: 'center' }]}>
        <Feather name="zap" size={12} color={Theme.violet} />
        <RNText style={[styles.systemRailKicker, { color: Theme.violet }]}>Wakeup fired</RNText>
        <RNText style={[styles.systemRailText, { flex: 1 }]} numberOfLines={1}>{stripAnsiCodes(message.content)}</RNText>
        <RNText style={styles.commitTime}>{formatRelativeTime(message.timestamp)}</RNText>
      </RNView>
    );
  }

  if (message.subtype === 'away_summary' && message.content) {
    return (
      <RNView style={styles.awaySummary}>
        <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <Feather name="moon" size={11} color={Theme.textDim} />
          <RNText style={styles.systemRailKicker}>While you were away</RNText>
        </RNView>
        <MarkdownContent text={stripAnsiCodes(message.content).trim()} baseStyle={styles.systemRailText} isUser={false} />
      </RNView>
    );
  }

  {
    const compaction = compactionProgressMessage(message.content);
    if (compaction) return <CompactionProgressRow progress={compaction} />;
  }

  if (message.subtype === 'plan' && message.content) {
    return <PlanBlock content={message.content} timestamp={message.timestamp} />;
  }

  if (message.subtype === 'pull_request' && message.content) {
    const prContent = message.content;
    const prMatch = prContent.match(/^#(\d+)\s+(.*)/);
    const prNum = prMatch ? prMatch[1] : '';
    const prTitle = prMatch ? prMatch[2] : prContent;
    const pr = message.pr;
    return (
      <TouchableOpacity
        style={styles.prCard}
        disabled={!pr}
        activeOpacity={0.6}
        onPress={() => pr && router.push(`/pr/${pr.repository}/${pr.number}` as any)}
        accessibilityRole="button"
      >
        <FontAwesome name="code-fork" size={11} color={Theme.violet} style={{ marginRight: 6 }} />
        <RNText style={styles.prNumber}>#{prNum}</RNText>
        <RNText style={styles.prTitle} numberOfLines={1}>{prTitle}</RNText>
        <RNText style={styles.commitTime}>{formatTimestamp(message.timestamp)}</RNText>
      </TouchableOpacity>
    );
  }

  if (message.subtype === 'commit' && message.content) {
    const sha = message.message_uuid?.slice(0, 7) || '';
    return (
      <RNView style={styles.commitCard}>
        <FontAwesome name="code-fork" size={11} color={Theme.green} style={{ marginRight: 6, transform: [{ rotate: '180deg' }] }} />
        <RNText style={styles.commitSha}>{sha}</RNText>
        <RNText style={styles.commitMessage} numberOfLines={1}>{message.content}</RNText>
        <RNText style={styles.commitTime}>{formatTimestamp(message.timestamp)}</RNText>
      </RNView>
    );
  }

  // A workflow's lifecycle anchor posted as a system row.
  if (message.subtype === 'workflow_event') {
    const event = parseWorkflowEventContent(message.content);
    return event ? <WorkflowEventBlock event={event} /> : null;
  }

  // A local slash command (/cost, /status): its name and what it printed.
  if (message.subtype === 'local_command' && message.content) {
    const c = message.content;
    const cmdName = (c.match(/<command-name>([^<]*)<\/command-name>/)?.[1] || c.match(/<command-message>([^<]*)<\/command-message>/)?.[1])?.replace(/^\//, '');
    const output = stripAnsiCodes((c.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1] || c.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/)?.[1] || '').trim());
    return (
      <RNView style={[styles.systemRail, { borderLeftColor: Theme.cyan + '4d', alignItems: 'center' }]}>
        <Feather name="chevron-right" size={12} color={Theme.cyan} />
        {!!cmdName && <RNText style={[styles.systemRailText, { color: Theme.cyan, fontWeight: '600' }]}>/{cmdName}</RNText>}
        <RNText style={[styles.systemRailText, { flex: 1 }]} numberOfLines={2}>{output || (cmdName ? '' : stripAnsiCodes(c.replace(/<[^>]+>/g, '')))}</RNText>
      </RNView>
    );
  }

  if (message.subtype === 'stop_hook_summary') {
    const label = 'hook';
    const content = stripAnsiCodes(message.content || '').slice(0, 200);
    if (!content) return null;
    return (
      <RNView style={styles.systemCommandBlock}>
        <RNView style={styles.systemCommandBadge}>
          <RNText style={styles.systemCommandBadgeText}>{label}</RNText>
        </RNView>
        <RNText style={styles.systemCommandText} numberOfLines={3}>{content}</RNText>
      </RNView>
    );
  }

  const content = (message.content || '').replace(/<[^>]+>/g, '').slice(0, 200);
  if (!content) return null;

  // Usage-limit notices share the amber warning tone of the compact boundary
  // pill; every other status line keeps the neutral system gray.
  const warning = isWarningSystemNotice(message.content, message.subtype);
  return (
    <RNView style={[styles.systemMessage, warning && styles.systemMessageWarning]}>
      {message.subtype && (
        <RNText style={[styles.systemSubtypeLabel, warning && styles.systemWarningText]}>
          {warning ? 'warning' : message.subtype.replace(/_/g, ' ')}
        </RNText>
      )}
      <RNText style={[styles.systemMessageText, warning && styles.systemWarningText]} numberOfLines={2}>{content}</RNText>
    </RNView>
  );
}

function formatTokenCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

function UsageBar({ usage }: { usage: UsageData }) {
  const Theme = useTheme();
  const CONTEXT_LIMIT = 200000;
  const contextPercent = (usage.contextSize / CONTEXT_LIMIT) * 100;
  const isWarning = contextPercent > 80;

  return (
    <RNView style={styles.usageBar}>
      <RNText style={styles.usageLabel}>In: <RNText style={styles.usageValue}>{formatTokenCount(usage.inputTokens)}</RNText></RNText>
      <RNText style={styles.usageLabel}>Out: <RNText style={styles.usageValue}>{formatTokenCount(usage.outputTokens)}</RNText></RNText>
      {(usage.cacheCreation > 0 || usage.cacheRead > 0) && (
        <RNText style={styles.usageLabel}>Cache: <RNText style={[styles.usageValue, { color: Theme.cyan }]}>{formatTokenCount(usage.cacheRead)}</RNText></RNText>
      )}
      <RNView style={styles.usageContextRow}>
        <RNText style={styles.usageLabel}>Ctx:</RNText>
        <RNView style={styles.usageContextBar}>
          <RNView style={[styles.usageContextFill, { width: `${Math.min(100, contextPercent)}%` as any, backgroundColor: isWarning ? '#ef4444' : Theme.green }]} />
        </RNView>
        <RNText style={[styles.usageValue, isWarning && { color: '#ef4444' }]}>{Math.round(contextPercent)}%</RNText>
      </RNView>
    </RNView>
  );
}

const CONTENT_TRUNCATE_LENGTH = 3000;
const ASSISTANT_CONTENT_MAX_HEIGHT = 400;

// Mobile twin of web's InterruptStatusLine: a stop is a control event, so it
// reads as a centered rule, not a bubble someone typed.
function InterruptStatusLine({ label = 'user interrupted', tone = 'sky' }: { label?: string; tone?: 'sky' | 'amber' }) {
  const Theme = useTheme();
  const color = tone === 'amber' ? Theme.yellow : Theme.textDim;
  const rule = { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: tone === 'amber' ? Theme.yellow + '66' : Theme.border };
  return (
    <RNView style={styles.interruptLine}>
      <RNView style={rule} />
      <RNText style={[styles.interruptLineText, { color }]}>{label}</RNText>
      <RNView style={rule} />
    </RNView>
  );
}

// A session's public link, in the one /share grammar (shared/entities).
const conversationShareLink = (token: string) => `${CODECAST_BASE_URL}${sharePath('conversation', token)}`;

/** Calls a run shows when opened fade in, for this long after the tap (a cell mounting late still catches it). */
const RUN_FADE_WINDOW_MS = 600;
const RUN_CALLS_ENTERING = FadeIn.duration(200);
const CHEVRON_EASE = ReEasing.bezier(0.23, 1, 0.32, 1);

/** The person's bubble: the user tint at this alpha over the screen. */
const USER_BUBBLE_ALPHA = '30';

/** A folded run of tool calls: one quiet line saying what it did; a tap opens the calls under it. */
function ToolRunRow({ run, expanded, onToggle }: { run: ToolRun; expanded: boolean; onToggle: () => void }) {
  const Theme = useTheme();
  const turn = useSharedValue(expanded ? 1 : 0);
  useEffect(() => { turn.set(withTiming(expanded ? 1 : 0, { duration: 180, easing: CHEVRON_EASE, reduceMotion: ReduceMotion.System })); }, [expanded, turn]);
  const chevronStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get() * 90}deg` }] }));
  return (
    <Pressable
      onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onToggle(); }}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${run.steps} ${run.steps === 1 ? 'step' : 'steps'}: ${run.summary}`}
      style={({ pressed }) => [styles.toolRunRow, pressed && { opacity: 0.6 }]}
    >
      <Reanimated.View style={chevronStyle}>
        <FontAwesome name="chevron-right" size={8} color={Theme.textDim} />
      </Reanimated.View>
      <RNText style={styles.toolRunText} numberOfLines={1}>{run.summary}</RNText>
    </Pressable>
  );
}

// A transcript row's message as the list shows it, cached per message so a
// screen render hands each bubble the same object and the memo below holds.
const displayCache = new WeakMap<Message, Message>();
function displayMessage(item: Message): Message {
  if (!item.content) return item;
  let out = displayCache.get(item);
  if (!out) {
    out = { ...item, content: stripPastedContent(item.content) };
    displayCache.set(item, out);
  }
  return out;
}
const directCache = new WeakMap<Message, Message>();
function directMessage(item: Message, body: string): Message {
  let out = directCache.get(item);
  if (!out || out.content !== body) {
    out = { ...item, content: body };
    directCache.set(item, out);
  }
  return out;
}

// The conversation screen re-renders on every store write it reads, and each
// bubble parses and lays out its markdown, so a bubble renders again only when
// one of its own props changes. toolRun is rebuilt inline per render and is
// compared by what it carries.
const MemoMessageBubble = memo(MessageBubble, (a, b) => {
  for (const k in b) {
    if (k !== 'toolRun' && (a as any)[k] !== (b as any)[k]) return false;
  }
  const x = a.toolRun, y = b.toolRun;
  return x === y || (!!x && !!y && x.run === y.run && x.expanded === y.expanded && x.justOpened === y.justOpened);
});

function MessageBubble({ message, agentType, model, showHeader = true, forkChildren, conversationId, onFork, taskSubjectMap, globalToolResultMap, globalImageMap, openGallery, userName, sender, showToast, collapsed: globalCollapsed, childConversationMap, bookmarkedSet, toolRun }: {
  message: Message;
  /** Someone other than the session's owner who sent this turn, named above the bubble. */
  sender?: string;
  /** The folded run of tool calls this message belongs to (lib/toolRuns). */
  toolRun?: { run: ToolRun; expanded: boolean; justOpened: boolean; onToggle: () => void };
  agentType?: string;
  model?: string;
  showHeader?: boolean;
  forkChildren?: ForkChild[];
  conversationId?: string;
  onFork?: (messageUuid: string) => void;
  taskSubjectMap?: Record<string, string>;
  globalToolResultMap?: Record<string, ToolResult>;
  globalImageMap?: Record<string, ImageData>;
  openGallery?: (image: ImageData) => void;
  userName?: string;
  showToast?: (msg: string) => void;
  collapsed?: boolean;
  childConversationMap?: Record<string, string>;
  bookmarkedSet?: Set<string>;
}) {
  if (PERF_PROBE) probeRender('MessageBubble');
  const Theme = useTheme();
  // Hosted voices are the family look's; developer mode draws a hosted
  // conversation as it draws any other.
  const familyLook = useActiveLook() === 'family';
  const router = useRouter();
  // Who the agent speaks as: its role, its character, or its product name.
  const speakerRow = useSessionIdentityRow(conversationId);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    message.tool_calls?.forEach(tc => {
      if (isEditTool(tc.name) || isWriteTool(tc.name) || tc.name === 'apply_patch') {
        initial.add(tc.id);
      }
    });
    return initial;
  });
  const [contentExpanded, setContentExpanded] = useState(false);
  const [fullscreenVisible, setFullscreenVisible] = useState(false);
  const [userContentExpanded, setUserContentExpanded] = useState(false);
  const [localExpanded, setLocalExpanded] = useState(false);
  useEffect(() => { setLocalExpanded(false); }, [globalCollapsed]);
  const isBookmarked = bookmarkedSet?.has(message._id);

  const handleLongPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const messageText = message.content || '';
    const canFork = !message.role?.startsWith('system') && message.message_uuid && onFork;
    const canBookmark = !!conversationId;
    const options = ['Copy Text', 'Copy Link', 'Share Message'];
    if (canBookmark) options.push(isBookmarked ? 'Remove Bookmark' : 'Bookmark');
    if (canFork) options.push('Fork from Here');
    options.push('Cancel');
    const cancelButtonIndex = options.length - 1;

    const handleAction = async (buttonIndex: number) => {
      const label = options[buttonIndex];
      if (label === 'Copy Text') {
        Clipboard.setString(messageText);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast?.('Copied to clipboard');
      } else if (label === 'Copy Link') {
        const url = `https://codecast.sh/conversation/${conversationId}#msg-${message._id}`;
        Clipboard.setString(url);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast?.('Link copied');
      } else if (label === 'Share Message') {
        Share.share({ message: messageText });
      } else if (label === 'Bookmark' || label === 'Remove Bookmark') {
        // Store action: the list flips now and the toggle rides the outbox.
        useInboxStore.getState().toggleBookmark(conversationId as string, message._id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast?.(isBookmarked ? 'Bookmark removed' : 'Bookmarked');
      } else if (label === 'Fork from Here' && message.message_uuid) {
        onFork!(message.message_uuid);
      }
    };

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex },
        (buttonIndex) => { handleAction(buttonIndex); }
      );
    } else {
      Alert.alert('Message Actions', undefined,
        options.slice(0, -1).map((label, i) => ({
          text: label,
          onPress: () => handleAction(i),
        })).concat([{ text: 'Cancel', onPress: async () => {} }])
      );
    }
  };

  if (message.role === 'system') {
    return <SystemMessage message={message} conversationId={conversationId} />;
  }

  const isUser = message.role === 'user';
  const hostedAgent = isHostedAgentType(agentType);
  const hasToolResults = message.tool_results && message.tool_results.length > 0;

  if (hasToolResults && !message.content) {
    return null;
  }

  const rawContentRaw = message.content || '';
  const rawContent = stripSystemTags(rawContentRaw);
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasImages = message.images && message.images.length > 0;
  const hasThinking = !isUser && !!message.thinking?.trim();
  // Skip truly empty messages (no content, no tool calls, no images, no thinking)
  if (!rawContent.trim() && !hasToolCalls && !hasImages && !hasThinking) {
    return null;
  }
  const effectiveCollapsed = globalCollapsed && !localExpanded;
  const isLongContent = rawContent.length > CONTENT_TRUNCATE_LENGTH;
  const lineCount = rawContent.split('\n').length;
  const estimatedOverflow = lineCount > 30 || rawContent.length > 1500;
  const COLLAPSED_LINES = 2;
  const isCollapseTruncated = effectiveCollapsed && rawContent.length > 150 && lineCount > COLLAPSED_LINES;
  const content = isCollapseTruncated
    ? rawContent.split('\n').slice(0, COLLAPSED_LINES).join('\n').slice(0, 200) + '...'
    : (isLongContent && !contentExpanded)
      ? rawContent.slice(0, CONTENT_TRUNCATE_LENGTH)
      : rawContent;

  const toggleTool = (toolId: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  };

  // Compact rendering for tool-call-only messages (no text, no thinking, no images)
  const isToolCallOnly = !isUser && hasToolCalls && !content.trim() && !hasImages && !hasThinking;
  const hasPlanWrite = hasToolCalls && message.tool_calls?.some(isPlanWriteToolCall);

  // When effectively collapsed, hide tool-only messages (unless they have plan writes)
  if (effectiveCollapsed && isToolCallOnly && !hasPlanWrite) {
    return null;
  }

  // A folded run shows as one row on its first message; the rest draw nothing until it opens.
  const runHead = toolRun?.run.head === message._id;
  const toolsFolded = !!toolRun && !toolRun.expanded;
  if (toolsFolded && !runHead) return null;

  // A hosted conversation reads as two voices, as on the web: the person's
  // words a quiet note in the interface face, the assistant's reply a letter
  // in the reading face, and its narration before a step in the receipt's
  // size and ink. Neither carries a name and time header.
  const hostedVoice = hostedAgent && familyLook;
  const bodyStyle = !hostedVoice
    ? [styles.bubbleText, isUser ? styles.userText : styles.assistantText]
    : isUser ? styles.hostedUserText : hasToolCalls ? styles.hostedNarration : styles.hostedReply;

  // The bubble's fill over the screen, for the fade that clips a long turn.
  const userFill = blendOver(Theme.userBubble + USER_BUBBLE_ALPHA, Theme.bg);

  const handleTapToExpand = () => {
    if (globalCollapsed && !localExpanded) {
      setLocalExpanded(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  return (
    <Pressable onLongPress={handleLongPress} onPress={globalCollapsed && !localExpanded ? handleTapToExpand : undefined}>
      {isUser && sender && !hostedVoice ? <RNText style={styles.userBubbleSender} numberOfLines={1}>{sender}</RNText> : null}
      <RNView
        style={[styles.messageBubble, isUser ? (hostedVoice ? styles.hostedUserBubble : styles.userBubble) : styles.assistantBubble, showHeader && !isUser && styles.assistantBubbleFirst, isToolCallOnly && styles.toolCallOnlyBubble]}>
        {/* The person's turn is the bubble itself; only the agent's opens with a name. */}
        {showHeader && !isToolCallOnly && !hostedVoice && !isUser && (
        <RNView style={styles.bubbleHeader}>
          <MobileAgentSpeaker
            row={speakerRow}
            agentType={agentType}
            size={16}
            mark={agentType ? <RNView style={[styles.agentDot, { backgroundColor: agentTypeColor(agentType) }]} /> : null}
            badge={agentType ? <AgentLogoSvg agentType={agentType} size={7} /> : undefined}
            nameStyle={[styles.bubbleRole, styles.assistantRole]}
          />
          {model && !hostedAgent && (
            <RNText style={styles.modelBadge}>{formatModel(model)}</RNText>
          )}
          <Pressable onPress={() => { Clipboard.setString(formatFullTimestamp(message.timestamp)); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); showToast?.('Timestamp copied'); }}>
            <RelativeTime timestamp={message.timestamp} style={[styles.bubbleTime, styles.assistantTime]} />
          </Pressable>
          {isBookmarked && (
            <FontAwesome name="bookmark" size={10} color="#d97706" style={{ marginLeft: 2 }} />
          )}
        </RNView>
      )}

      {/* Collapsed feed hides thinking to cut noise — EXCEPT a pure-reasoning turn,
          where thinking is the only content and hiding it leaves an empty bubble. */}
      {hasThinking && !(toolsFolded && !content.trim()) && (!effectiveCollapsed || (!content.trim() && !hasToolCalls && !hasImages)) && (
        <ThinkingBlock content={message.thinking!.trim()} />
      )}

      {hasImages && (
        <RNView style={styles.imagesContainer}>
          {message.images!.map((img, i) => (
            <ImageBlock key={i} image={img} onPress={() => openGallery?.(img)} />
          ))}
        </RNView>
      )}

      {content ? (
        <>
        <RNView
          style={[
            isUser && !hostedVoice ? styles.userBubbleContent : styles.bubbleContent,
            isLongContent && !contentExpanded && styles.bubbleContentCollapsed,
            !isUser && !contentExpanded && !isLongContent && estimatedOverflow && { maxHeight: ASSISTANT_CONTENT_MAX_HEIGHT, overflow: 'hidden' as const },
            isUser && !userContentExpanded && !isLongContent && estimatedOverflow && { maxHeight: ASSISTANT_CONTENT_MAX_HEIGHT, overflow: 'hidden' as const },
          ]}
        >
          {(() => {
            if (typeof content !== 'string') {
              return <MarkdownContent text={content} baseStyle={bodyStyle} isUser={isUser} />;
            }
            // Claude's compaction screen captured as a body: a progress row,
            // not the spinner and block-bar glyphs.
            const compaction = compactionProgressMessage(content);
            if (compaction) return <CompactionProgressRow progress={compaction} />;
            const apiError = parseApiErrorContent(content);
            if (apiError) {
              return <ApiErrorCard error={apiError} conversationId={conversationId} />;
            }
            const wfEvent = parseWorkflowEventContent(content);
            if (wfEvent) {
              return <WorkflowEventBlock event={wfEvent} />;
            }
            // Whole-message raw HTML (no cast-canvas fence) — render as a
            // canvas card instead of escaped tag soup, matching web.
            if (!isUser && canvasAvailable && looksLikeHtmlMessage(content)) {
              return <CastCanvas code={content} />;
            }
            if (isTaskNotification(content)) {
              return <TaskNotificationLine content={content} childConversationMap={childConversationMap} />;
            }
            if (content.includes('<skill>')) {
              return parseSkillBlocks(content).map((part, idx) =>
                part.type === 'skill'
                  ? <SkillBlockCard key={idx} name={part.skillName} description={part.skillDesc} path={part.skillPath} />
                  : <MarkdownContent key={idx} text={part.content} baseStyle={bodyStyle} isUser={isUser} />
              );
            }
            if (content.includes('<teammate-message')) {
              return parseTeammateMessages(content).map((part, idx) =>
                part.type === 'text'
                  ? <MarkdownContent key={idx} text={part.content} baseStyle={bodyStyle} isUser={isUser} />
                  : <TeammateMessageCard key={idx} teammateId={part.teammateId} color={part.color} summary={part.summary} content={part.content} />
              );
            }
            if (isUser && content.includes('<context ')) {
              const { contexts, remaining } = parseContextBlocks(content);
              if (contexts.length > 0) {
                return (
                  <>
                    <RNView style={styles.contextPillRow}>
                      {contexts.map((ctx, idx) => <ContextBlockPill key={idx} ctx={ctx} />)}
                    </RNView>
                    {remaining ? <MarkdownContent text={remaining} baseStyle={[styles.bubbleText, styles.userText]} isUser={true} /> : null}
                  </>
                );
              }
            }
            return <MarkdownContent text={content} baseStyle={bodyStyle} isUser={isUser} />;
          })()}
          {((isLongContent && !contentExpanded) || (!isUser && estimatedOverflow && !contentExpanded) || (isUser && estimatedOverflow && !userContentExpanded)) && (
            <LinearGradient
              colors={isUser ? [userFill + '00', userFill] : [Theme.bg + '00', Theme.bg]}
              style={styles.contentGradientOverlay}
              pointerEvents="none"
            />
          )}
        </RNView>
        {isUser && estimatedOverflow && (
          <RNView style={styles.contentActions}>
            <TouchableOpacity onPress={() => setUserContentExpanded(!userContentExpanded)} style={styles.showMoreButton} activeOpacity={0.7}>
              <FontAwesome name={userContentExpanded ? "chevron-up" : "chevron-down"} size={10} color={Theme.cyan} style={{ marginRight: 5 }} />
              <RNText style={styles.showMoreText}>{userContentExpanded ? 'Collapse' : 'Expand'}</RNText>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setFullscreenVisible(true)} style={styles.showMoreButton} activeOpacity={0.7}>
              <FontAwesome name="expand" size={10} color={Theme.cyan} style={{ marginRight: 5 }} />
              <RNText style={styles.showMoreText}>Fullscreen</RNText>
            </TouchableOpacity>
          </RNView>
        )}
        {!isUser && (isLongContent || estimatedOverflow) && (
          <RNView style={styles.contentActions}>
            <TouchableOpacity
              onPress={() => setContentExpanded(!contentExpanded)}
              style={styles.showMoreButton}
              activeOpacity={0.7}
            >
              <FontAwesome name={contentExpanded ? "chevron-up" : "chevron-down"} size={10} color={Theme.cyan} style={{ marginRight: 5 }} />
              <RNText style={styles.showMoreText}>
                {contentExpanded ? 'Collapse' : 'Expand'}
              </RNText>
            </TouchableOpacity>
            {rawContent.length > 500 && (
              <TouchableOpacity onPress={() => setFullscreenVisible(true)} style={styles.showMoreButton} activeOpacity={0.7}>
                <FontAwesome name="expand" size={10} color={Theme.cyan} style={{ marginRight: 5 }} />
                <RNText style={styles.showMoreText}>Fullscreen</RNText>
              </TouchableOpacity>
            )}
          </RNView>
        )}
        </>
      ) : null}

      {runHead && (
        <ToolRunRow run={toolRun!.run} expanded={!toolsFolded} onToggle={toolRun!.onToggle} />
      )}
      {hasToolCalls && !toolsFolded && (
        <Reanimated.View entering={toolRun?.justOpened ? RUN_CALLS_ENTERING : undefined} style={[isToolCallOnly ? styles.toolCallsCompact : styles.toolCallsContainer, toolRun?.run.members.at(-1) === message._id && styles.toolRunCalls]}>
          {message.tool_calls!.map((tc) => {
            const result = message.tool_results?.find(r => r.tool_use_id === tc.id) || globalToolResultMap?.[tc.id];

            // Plan writes rendered as PlanBlock
            if (isPlanWriteToolCall(tc)) {
              try {
                const p = JSON.parse(tc.input);
                if (p.content) {
                  return <PlanBlock key={tc.id} content={String(p.content)} timestamp={message.timestamp} collapsed={effectiveCollapsed} />;
                }
              } catch {}
            }
            // Specialized rendering for specific tools
            if (isAgentTool(tc.name)) {
              return <TaskToolBlock key={tc.id} tool={tc} result={result} childConversationId={message.message_uuid && childConversationMap ? childConversationMap[message.message_uuid] : undefined} />;
            }
            if (isAskTool(tc.name)) {
              return <AskUserQuestionBlock key={tc.id} tool={tc} result={result} conversationId={conversationId} />;
            }
            if (isTodoTool(tc.name)) {
              return <TodoWriteBlock key={tc.id} tool={tc} />;
            }
            if (tc.name === 'TaskList' && result) {
              return <TaskListBlock key={tc.id} result={result} />;
            }
            if (tc.name === 'TaskCreate' || tc.name === 'TaskUpdate' || tc.name === 'TaskGet') {
              return <TaskCreateUpdateBlock key={tc.id} tool={tc} result={result} taskSubjectMap={taskSubjectMap} />;
            }
            if (tc.name === 'StructuredOutput') {
              return <StructuredResultBlock key={tc.id} input={tc.input} result={result} />;
            }
            if (tc.name === 'SendUserFile') {
              return <SentFileBlock key={tc.id} files={(message.files ?? []).filter(f => f.tool_use_id === tc.id)} />;
            }
            if (tc.name === 'SendMessage') {
              return <SendMessageBlock key={tc.id} tool={tc} />;
            }
            if (tc.name === 'TeamCreate' || tc.name === 'TeamDelete') {
              return <TeamCreateBlock key={tc.id} tool={tc} />;
            }
            if (tc.name === 'Skill') {
              return <SkillCard key={tc.id} tool={tc} />;
            }
            if (isPlanModeTool(tc.name)) {
              return (
                <RNView key={tc.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2 }}>
                  <FontAwesome name="map-o" size={10} color={Theme.violet} />
                  <RNText style={{ fontSize: 11, fontFamily: 'JetBrainsMono-Regular', color: Theme.violet, fontWeight: '600' }}>Plan Mode</RNText>
                  <RNView style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: 'rgba(108, 113, 196, 0.15)', borderWidth: 0.5, borderColor: 'rgba(108, 113, 196, 0.3)' }}>
                    <RNText style={{ fontSize: 9, color: Theme.violet, fontFamily: 'JetBrainsMono-Regular' }}>{/^exit/i.test(tc.name) ? 'exit' : 'enter'}</RNText>
                  </RNView>
                </RNView>
              );
            }

            // A `cast …` command reads as what it did (a message sent, a
            // decision asked, a task made), with the shell line one tap away.
            const castCmd = !hostedAgent ? parseCastCommand(tc as any) : null;
            if (castCmd) {
              return (
                <CastCommandBlock
                  key={tc.id}
                  cast={castCmd}
                  output={result?.content || ''}
                  isError={result?.is_error}
                  image={<ToolImages toolId={tc.id} images={message.images} globalImageMap={globalImageMap} openGallery={openGallery} />}
                />
              );
            }
            // The hosted assistant's steps read as plain lines, in the words
            // the web's receipt uses; the raw call stays a developer's view.
            if (hostedAgent && conversationId) {
              return <HostedStep key={tc.id} call={tc} result={result} conversationId={conversationId} />;
            }
            // Default rendering for other tools
            return (
              <ToolCallItem
                images={message.images}
                globalImageMap={globalImageMap}
                openGallery={openGallery}
                key={tc.id}
                toolCall={tc}
                result={result}
                expanded={expandedTools.has(tc.id)}
                onToggle={() => toggleTool(tc.id)}
              />
            );
          })}
          {hostedAgent ? (
            <HostedSources sources={searchedSources(message.tool_calls!, (tc) => message.tool_results?.find(r => r.tool_use_id === tc.id) || globalToolResultMap?.[tc.id])} />
          ) : null}
        </Reanimated.View>
      )}

      {forkChildren && forkChildren.length > 0 && (
        <RNView style={styles.forkChildrenRow}>
          <FontAwesome name="code-fork" size={10} color={Theme.violet} />
          {forkChildren.map((fork) => (
            <Pressable
              key={fork._id}
              onPress={() => router.push(`/session/${fork._id}`)}
              style={styles.forkChildBadge}
            >
              <RNText style={styles.forkChildText} numberOfLines={1}>{fork.short_id ? `${fork.short_id} ${fork.title}` : fork.title}</RNText>
            </Pressable>
          ))}
        </RNView>
      )}
      </RNView>
      {fullscreenVisible && (
        <Modal visible={fullscreenVisible} animationType="slide" onRequestClose={() => setFullscreenVisible(false)}>
          <RNView style={styles.messageFullscreen}>
            <RNView style={styles.messageFullscreenHeader}>
              {isUser
                ? <RNText style={styles.messageFullscreenRole}>{userName || 'You'}</RNText>
                : <MobileAgentSpeaker row={speakerRow} agentType={agentType} size={20} badge={agentType ? <AgentLogoSvg agentType={agentType} size={9} /> : undefined} nameStyle={styles.messageFullscreenRole} />}
              <RNText style={styles.messageFullscreenTime}>{formatFullTimestamp(message.timestamp)}</RNText>
              <TouchableOpacity onPress={() => setFullscreenVisible(false)} style={{ padding: 6, marginLeft: 'auto' }} activeOpacity={0.7}>
                <FontAwesome name="close" size={18} color={Theme.textMuted} />
              </TouchableOpacity>
            </RNView>
            <ScrollView style={styles.messageFullscreenContent} contentContainerStyle={{ paddingBottom: 60 }}>
              <MarkdownContent text={stripSystemTags(rawContentRaw)} baseStyle={[styles.bubbleText, { fontSize: 15, lineHeight: 24 }, isUser ? styles.userText : styles.assistantText]} isUser={isUser} />
            </ScrollView>
          </RNView>
        </Modal>
      )}
    </Pressable>
  );
}

// --- Message input ---

// Agent statuses surfaced in the composer, with their tint and label (the
// shared spec, which the web's phone views read too).
const AGENT_STATUS_META = MOBILE_COMPOSER_STATUS;

function seedComposerDraft(conversationId: string, draftProp?: string | null): string {
  const store = useInboxStore.getState();
  const persisted = store.getDraft(conversationId)?.draft_message ?? draftProp ?? '';
  const msgs = [
    ...(store.messages[conversationId] ?? []),
    ...(store.pendingMessages[conversationId] ?? []),
  ];
  if (persisted && isResentCopyOfSentMessage(msgs, persisted)) {
    store.clearDraftFinal(conversationId);
    return '';
  }
  return persisted;
}

function MessageInput({ conversationId, isActive, isOwner, draft, autoFocus, hosted = false, waitsOnAnswer = false }: {
  conversationId: Id<"conversations">;
  isActive: boolean;
  isOwner: boolean;
  draft?: string | null;
  autoFocus?: boolean;
  /** The conversation runs on the hosted assistant: no machine status, no
   *  slash commands, no image attach (its turns take words only), and the
   *  reply box speaks in the assistant's words. */
  hosted?: boolean;
  /** An approval is open, so typing is the other way to answer it. */
  waitsOnAnswer?: boolean;
}) {
  const Theme = useTheme();
  const hostedWorking = useConversationWorking(conversationId as string) && hosted && !waitsOnAnswer;
  // The family look's wait reads in quiet ink.
  const familyLook = useActiveLook() === 'family';
  const answeredBefore = useInboxStore((s) => hosted && (s.messages[conversationId as string] ?? []).some((m: { role?: string }) => m.role === 'assistant'));
  const hostedLast = useInboxStore((s) => (hosted ? hostedLastExchange(s.messages[conversationId as string] as any, s.sessionDecisions, conversationId as string, Date.now()) : null));
  // A used-up month holds the send and says why in the box, as the web's
  // composer does (usePlanFigures useAllowanceOut).
  const allowanceOut = useAllowanceOut(hosted);
  // A dropped link is said in the status slot, with what happens to a
  // message still waiting to go (the web's HostedConnection words).
  const linkDown = useLinkDown();
  const unsent = useInboxStore((s) => hosted && (s.pendingMessages[conversationId as string] ?? []).length > 0);
  const words = useModeWords();
  const insets = useSafeAreaInsets();

  const [seed] = useState(() => seedComposerDraft(conversationId as string, draft));
  const field = useComposerField(seed);
  const {
    value: message,
    setValue: setMessage,
    inputRef,
    sendingRef,
    clearAfterSend,
  } = field;

  // Focus after the push animation settles — focusing mid-transition on iOS
  // either drops the keyboard or stutters the navigation.
  useEffect(() => {
    if (!autoFocus) return;
    const task = InteractionManager.runAfterInteractions(() => inputRef.current?.focus());
    return () => task.cancel();
  }, [autoFocus]);
  const [error, setError] = useState<string | null>(null);
  const images = useComposerImages(setMessage);
  const { selectedImages } = images;
  // The session row's live fields (synced with the inbox): is_connected is
  // the heartbeat verdict, agent_status what the agent is doing now.
  const sessionFields = useManagedSessionFields(conversationId as string);
  const managedSessionQ = sessionFields
    ? { managed: !!sessionFields.is_connected, agent_status: sessionFields.agent_status as string | undefined }
    : undefined;
  // The design-mock session fakes a working agent so the footer status chip is
  // reviewable without server data (see DESIGN_MOCK_CONVO).
  const managedSession = (conversationId as string) === '__designmock__'
    ? { managed: true as const, agent_status: 'working' }
    : managedSessionQ;

  const draftRef = useRef(seed);
  // Same store path as web MessageInput: debounce setDraft / clearDraftFinal.
  // A parallel patchConversation of conversations.draft_message is the race
  // that writes the just-sent text back after the send's clear.
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (sendingRef.current) return;
    if (!message && !draftRef.current) return;
    if (message === draftRef.current) return;
    draftRef.current = message;
    const store = useInboxStore.getState();
    clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      if (sendingRef.current) return;
      if (message) store.setDraft(conversationId, { draft_message: message });
      else store.clearDraftFinal(conversationId);
    }, 300);
    return () => clearTimeout(draftTimerRef.current);
  }, [message, conversationId, sendingRef]);

  // Web heals a resent-copy draft once the message window has loaded; the
  // seed-time check often runs against an empty store on a cold visit.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (sendingRef.current) return;
      const live = draftRef.current;
      if (!live) return;
      const store = useInboxStore.getState();
      const msgs = [
        ...(store.messages[conversationId] ?? []),
        ...(store.pendingMessages[conversationId] ?? []),
      ];
      if (!isResentCopyOfSentMessage(msgs, live)) return;
      clearAfterSend(live);
      store.clearDraftFinal(conversationId);
    }, 3000);
    return () => clearTimeout(timer);
  }, [conversationId, clearAfterSend, sendingRef]);

  // Optimistic, non-blocking send (mirrors web ContextChatInput). The message
  // is added to the store as pending and rendered instantly; sendMessage is
  // fire-and-forget (rides the store outbox, dedups on client_id). The input
  // clears synchronously — no await, no spinner, no lock.
  const handleSend = () => {
    const trimmedMessage = nativeComposerText(
      inputRef.current as { _lastNativeText?: unknown } | null,
      message,
    ).trim();
    if (!trimmedMessage && selectedImages.length === 0) return;
    if (allowanceOut) return;
    setError(null);
    suggestion.settleSend(trimmedMessage);

    const sendImages = images.optimisticImages();
    const content = trimmedMessage || IMAGE_ONLY_CONTENT;

    // The bubble lands on the next frame, in a commit of its own: written
    // inside the press, it shares the composer's commit, which Reanimated
    // lays out without animating, and the bubble would snap in instead of rising.
    requestAnimationFrame(() => {
      try {
        dispatchComposerSend(conversationId, content, sendImages);
      } catch (error) {
        captureError(error instanceof Error ? error : new Error(String(error)));
        setError(error instanceof Error ? error.message : 'Could not save your message. Please try again.');
        setMessage(trimmedMessage);
      }
    });

    // Same send-clear as web: remount the native box and ignore IME restores
    // of the just-sent text. The keyboard goes with the send, so the person
    // watches their turn land and the reply arrive over the whole screen.
    // clearDraftFinal is the only draft write (client_state + conversation row
    // via the outbox); a parallel patchConversation is what used to put the
    // sent text back.
    clearTimeout(draftTimerRef.current);
    draftRef.current = '';
    clearAfterSend(content, { keepFocus: false });
    Keyboard.dismiss();
    images.clearImages();
    useInboxStore.getState().clearDraftFinal(conversationId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const canSend = (!!message.trim() || selectedImages.length > 0) && !allowanceOut;
  const agentStatus = managedSession?.managed ? managedSession.agent_status : undefined;
  const agentWorking = !!agentStatus && ACTIVE_AGENT_STATUSES.has(agentStatus);
  // While a turn works and the box is empty, send becomes Stop. A hosted
  // turn stops through the store's stopHostedTurn, the web's visible Stop,
  // so stopping never rests on a gesture a person who does not code would
  // not know.
  const canStop = hosted ? hostedWorking : agentWorking && isOwner;

  // The interrupt is the shared store action (web's Escape); the daemon judges
  // whether the agent is mid-turn and paints the interruption line.
  const handleStop = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (hosted) {
      useInboxStore.getState().stopHostedTurn(conversationId);
      return;
    }
    useInboxStore.getState().sendEscape(conversationId).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Could not stop the agent');
    });
  };

  // Status lives in the otherwise-empty middle of the button row: zero extra
  // height, and it can never overlap the conversation.
  // A hosted wait reads as the web's one wait: "Getting started…" before
  // the first reply, "Thinking…" after, in quiet ink in the family look.
  const statusMeta: ComposerStatus | undefined = hosted && linkDown
    ? { color: Theme.textMuted, dot: Theme.textMuted0, label: hostedConnectionWords(linkDown, unsent) }
    : hostedWorking
    ? { color: familyLook ? Theme.textMuted : AGENT_STATUS_META.working.color, dot: familyLook ? Theme.text : AGENT_STATUS_META.working.color, label: answeredBefore ? 'Thinking…' : 'Getting started…' }
    : managedSession?.managed && !hosted
      ? AGENT_STATUS_META[managedSession.agent_status ?? '']
      : undefined;

  // The web composer's resting words for the same exchange (lib/hostedComposer).
  const placeholder = hosted
    ? allowanceOut ?? hostedComposerWords(hostedLast, waitsOnAnswer)
    : isActive ? MOBILE_COMPOSER_PLACEHOLDER.active : MOBILE_COMPOSER_PLACEHOLDER.idle;

  // The suggested reply (off-by-default pref, same stamped key as web) shows
  // in the empty box where the words would go; Use fills the box with it.
  // Hosted mode has no reply suggestion (surface composer.suggestion).
  const suggestionsOn = useInboxStore((s) => s.clientState?.ui?.composer_suggestions === true);
  const suggestion = useComposerSuggestion({
    conversationId: conversationId as string,
    idle: !agentWorking,
    hidden: !!message.trim() || selectedImages.length > 0,
    enabled: useSurface('composer.suggestion') && suggestionsOn,
  });

  return (
    <RNView style={[styles.inputContainer, { paddingBottom: insets.bottom || 12 }]}>
      {conversationId ? <AccountRecoveryBanner conversationId={conversationId} /> : null}
      <MessageComposer
        field={field}
        images={images}
        placeholder={placeholder}
        canSend={canSend}
        onSend={handleSend}
        stop={canStop ? { label: words.stopWorking, onPress: handleStop } : null}
        status={statusMeta}
        // The hosted assistant's turns take words only.
        attach={!hosted}
        error={error}
        onDismissError={() => setError(null)}
        suggestion={suggestion.text === null ? null : {
          text: suggestion.text,
          index: suggestion.index,
          count: suggestion.count,
          onUse: () => {
            const t = suggestion.accept();
            if (t !== null) { setMessage(t); inputRef.current?.focus(); }
          },
          onNext: () => { suggestion.cycle(1); },
        }}
        above={hosted ? null : <SlashCommandPills conversationId={conversationId as string} text={message} onPick={(t) => { setMessage(t); inputRef.current?.focus(); }} />}
      />
    </RNView>
  );
}

// --- Main screen with pagination ---

// TEMPORARY (design iteration): a fully-populated mock conversation so the header
// strip renders every chip type without depending on server data. Reached via the
// deep link codecast://session/__designmock__ . Remove before shipping.
const DESIGN_MOCK_ID = '__designmock__';
const DESIGN_MOCK_STARTED = Date.now() - 21 * 3600 * 1000;
const DESIGN_MOCK_CONVO: ConversationData = {
  _id: DESIGN_MOCK_ID,
  title: 'Counterparty matching strategy optimization',
  status: 'archived',
  is_own: true,
  agent_type: 'claude',
  model: 'opus-4-8',
  started_at: DESIGN_MOCK_STARTED,
  updated_at: DESIGN_MOCK_STARTED,
  message_count: 16,
  fork_count: 3,
  git_branch: 'ashot/apollo-include-similar-titles-fix',
  git_remote_url: 'https://github.com/ashot/codecast.git',
  messages: [
    ...Array.from({ length: 16 }, (_, i) => ({
      _id: `mock-msg-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: i % 2 === 0
        ? `Mock prompt ${i / 2 + 1}: tighten the counterparty matching heuristic and re-run the similar-titles backfill.`
        : `Acknowledged. Working on step ${Math.ceil(i / 2)} — scanning the candidate set, scoring by title overlap, and parking the cleanup behind the Phase-0 reworks. This line is padded so the bubble has enough height to make the list scrollable for verifying the header collapse behavior.`,
      timestamp: DESIGN_MOCK_STARTED + i * 60000,
      message_uuid: `mock-uuid-${i}`,
    })),
    // Exercises the CastCanvas renderer: title extraction, sol tokens, table
    // layout, chart placeholder, and the overflow -> "Show all" path.
    {
      _id: 'mock-msg-canvas',
      role: 'assistant',
      content: 'Here is the funnel summary:\n\n```cast-canvas\n<div data-canvas-title="Intro volume funnel">\n<div style="font-size:11px;letter-spacing:1px;color:var(--sol-text-dim);text-transform:uppercase">Intro volume funnel</div>\n<h2 style="margin:6px 0;color:var(--sol-text)">Weekly conversion</h2>\n<table style="width:100%;border-collapse:collapse">\n<tr style="border-bottom:1px solid var(--sol-border-light)"><th style="text-align:left;padding:6px;color:var(--sol-text-muted)">Stage</th><th style="text-align:right;padding:6px;color:var(--sol-text-muted)">Count</th></tr>\n<tr><td style="padding:6px">Intros sent</td><td style="text-align:right;padding:6px;color:var(--sol-blue)">412</td></tr>\n<tr style="background:var(--sol-bg-alt)"><td style="padding:6px">Replies</td><td style="text-align:right;padding:6px;color:var(--sol-cyan)">187</td></tr>\n<tr><td style="padding:6px">Meetings</td><td style="text-align:right;padding:6px;color:var(--sol-green)">63</td></tr>\n</table>\n<div class="cast-chart" data-spec=\'{"marks":[{"type":"barY"}]}\'></div>\n<p style="color:var(--sol-text-secondary)">Reply rate is <b style="color:var(--sol-orange)">45%</b>, up 6pts week over week. The drop from replies to meetings is the leak worth chasing.</p>\n<script>alert("must never run")</script>\n</div>\n```\n\nThe sanitizer strips the script above.',
      timestamp: DESIGN_MOCK_STARTED + 17 * 60000,
      message_uuid: 'mock-uuid-canvas',
    },
    // Exercises AskUserQuestion option previews (the ASCII mockup box the
    // terminal shows next to each option).
    {
      _id: 'mock-msg-auq',
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'mock-tool-auq',
        name: 'AskUserQuestion',
        input: JSON.stringify({
          questions: [{
            question: 'Which layout for the stats header?',
            header: 'Layout',
            options: [
              { label: 'Stacked (Recommended)', description: 'Title above the chip row', preview: '┌──────────────────┐\n│ Title            │\n│ [chip] [chip]    │\n└──────────────────┘' },
              { label: 'Inline', description: 'Title and chips share one row', preview: '┌──────────────────┐\n│ Title [chip][chip]│\n└──────────────────┘' },
            ],
          }],
        }),
      }],
      timestamp: DESIGN_MOCK_STARTED + 18 * 60000,
      message_uuid: 'mock-uuid-auq',
    },
  ] as Message[],
};

// Height of the compact custom title bar (back + title + actions), below the
// safe-area inset. The collapsing metadata strip is positioned just under it.
const HEADER_BAR_HEIGHT = MOBILE_SESSION_HEADER_HEIGHT;

/** The session screen's slim title bar: the safe-area inset, the back button
 *  and whatever the state has to show beside it (nothing while the row is
 *  unknown, a title for the skeleton, the face, title and actions once
 *  loaded). It floats over the transcript; `inFlow` sets it above content
 *  that has no transcript under it yet. A screen opened by a link has nothing
 *  to go back to, so back lands on the inbox then. */
function SessionHeaderBar({ children, inFlow = false }: { children?: ReactNode; inFlow?: boolean }) {
  const Theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  // Inside a conversation's slide-out the leading button opens it (the inbox
  // and every other area live there); a screen standing alone goes back.
  const drawer = useConversationDrawer();
  return (
    <RNView style={[styles.pinnedHeader, { paddingTop: insets.top, height: insets.top + HEADER_BAR_HEIGHT }, inFlow && { position: 'relative' }]}>
      <TouchableOpacity
        onPress={drawer ? drawer.open : () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/inbox' as never))}
        style={styles.headerIconBtn}
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 4 }}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityLabel={drawer ? 'Inbox and other areas' : 'Back'}
      >
        {drawer ? <Feather name="menu" size={20} color={Theme.text} /> : <FontAwesome name="chevron-left" size={18} color={Theme.text} />}
      </TouchableOpacity>
      {children}
    </RNView>
  );
}

// Android IME inset, driven straight from the keyboard events. KAV's Android
// path can't be trusted for this: it never resets to 0 from a hide event —
// it RE-DERIVES padding as (own frame height − getWindowVisibleDisplayFrame
// height), and under edge-to-edge the KAV spans the full window while the
// visible frame excludes the status bar and any still-animating IME slice.
// Every dismissal therefore left ~a-status-bar-plus of phantom padding, and
// IME churn right after a send strobed the composer between padded and
// unpadded (glitchy bottom on the tablet). Event-driven padding has no frame
// math: didShow carries the IME height above the system bars, didHide is an
// authoritative 0.
function useAndroidImeInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', (e) => setInset(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setInset(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return inset;
}

function ForkFamilyRow({ node, router, currentId, onClose }: { node: FlatForkNode; router: any; currentId: string; onClose: () => void }) {
  const Theme = useTheme();
  const isCurrent = node.id === currentId;
  const timeStr = new Date(node.started_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <Pressable onPress={() => { if (!isCurrent) { onClose(); router.push(`/session/${node.id}`); } }} style={[styles.treeNode, { paddingLeft: node.depth * 16 + 12 }, isCurrent && styles.treeNodeCurrent]}>
      {node.depth > 0 && <RNText style={styles.treeNodePrefix}>+-</RNText>}
      {isCurrent && <FontAwesome name="circle" size={6} color={Theme.violet} style={{ marginRight: 4 }} />}
      <RNText style={[styles.treeNodeTitle, isCurrent && { color: Theme.violet }]} numberOfLines={1}>{node.branch_label || node.title}</RNText>
      <RNText style={styles.treeNodeMeta}>{node.message_count} msgs</RNText>
      <RNText style={styles.treeNodeMeta}>{timeStr}</RNText>
    </Pressable>
  );
}

export default function SessionDetailScreen() {
  const { id, message, focus, reveal } = useLocalSearchParams<{ id: string; message?: string; focus?: string; reveal?: string }>();
  const Theme = useTheme();
  // reveal=1 only shapes the push (no transition under the closing new
  // session sheet, app/_layout); once it has landed it goes, so going back
  // slides as it does everywhere else.
  // The first render of a revealed session is what lets the sheet go: it has
  // drawn under the sheet by now (lib/compose).
  const routeNav = useRouter();
  useEffect(() => {
    if (!reveal) return;
    sessionLanded();
    const task = InteractionManager.runAfterInteractions(() => routeNav.setParams({ reveal: undefined }));
    return () => task.cancel();
  }, [reveal, routeNav]);
  // A push tapped on a closed app lands here before the cache is read back.
  // The session screen decides what it shows from the row (a conversation
  // with the hosted assistant has no machine chrome and its own reply box),
  // so until the row is known or the cache has been read it would open as a
  // developer session and then change under the person's thumbs, losing
  // anything typed meanwhile. Hold a bare header for that moment. Once the
  // cache is read, an unknown row falls through: the session screen looks a
  // session it does not hold up on the server.
  const cold = useInboxStore((s) => {
    if (s.clientStateInitialized) return false;
    const liveId = s.resolveLiveSessionId(id);
    return !(s.sessions[liveId] ?? s.conversations[liveId]);
  });
  if (cold) {
    return (
      <RNView style={{ flex: 1, backgroundColor: Theme.bg }}>
        <Stack.Screen options={{ headerShown: false }} />
        <SessionHeaderBar inFlow />
      </RNView>
    );
  }
  return (
    <ConversationSlideOut id={id}>
      {/* Keyed: a pick in the panel changes the id in place, and the
          conversation's own state (scroll, sticky prompt, drafts) starts
          over with it. */}
      <SessionScreen key={id} id={id} message={message} focus={focus} />
    </ConversationSlideOut>
  );
}

const NO_APPROVALS: ReturnType<typeof useConversationApprovals> = [];

/** The session screen for a conversation id, apart from the route that names
 *  it: a role's page (app/org/[id]) is this screen on the role's standing
 *  conversation. `boardHref` adds the header's way to the board of a scope; a
 *  role's standing session finds its own. */
export function SessionScreen({ id, message: highlightMessageParam, focus: focusParam, boardHref: boardHrefProp }: { id: string; message?: string; focus?: string; boardHref?: string }) {
  if (PERF_PROBE) probeRender('SessionScreen');
  const Theme = useTheme();
  // Hosted mode hides a local session's model and branch chips (lib/surfaces,
  // the registry the web's header reads), and speaks in its words.
  const modelPicker = useSurface('modelPicker');
  const gitChips = useSurface('gitChips');
  const internalsShown = useSurface('conversation.internals');
  const diffSurface = useSurface('diff');
  const stickyPromptShown = useSurface('conversation.stickyPrompt');
  const words = useModeWords();
  // The store's server dispatch is wired once, at the root (StoreSyncBridge
  // mounts useSyncCore above every screen), and must not be wired again here:
  // the binding is a single slot with an owner, so a screen that binds takes
  // it from the root, rejects the writes in flight (a create fired a moment
  // before this screen opened), and on closing clears it, leaving every later
  // write parked until the app restarts. A write made before the root has
  // armed waits in the outbox and drains when it binds.

  // Claim store.currentSessionId while this screen is focused (re-asserted on
  // stack pop-back). The liveness reconciler prunes a conversation's optimistic
  // sends as soon as the daemon looks active (reconcilePendingSendForSession)
  // — EXCEPT for the focused conversation, where the pending bubble must
  // survive until the real message row syncs into the local window. Web sets
  // this on every conversation open; without it the just-sent message rendered,
  // vanished on the next liveness tick, then reappeared when the row synced.
  useFocusEffect(
    useCallback(() => {
      if (typeof id === "string" && id !== DESIGN_MOCK_ID) {
        useInboxStore.getState().setCurrentSession(id);
      }
    }, [id]),
  );

  // Server-backed read mark: clears this session's unread dot on every device
  // of this viewer's, but only while the screen is focused and the app is in
  // the foreground.
  useAckActiveSession(typeof id === "string" && id !== DESIGN_MOCK_ID ? id : null);

  const flatListRef = useRef<FlatList>(null);
  const loadCooldownRef = useRef(false);
  const [initialScrollDone, setInitialScrollDone] = useState(false);
  const [userScrolled, setUserScrolled] = useState(false);
  const [isNearTop, setIsNearTop] = useState(true);
  // Whether anything sits above the visible window (the hosted top fade).
  const [hasAbove, setHasAbove] = useState(false);
  const flatListLayoutHeightRef = useRef(0);
  const lastContentHeightRef = useRef(0);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [toastMessage, setToastMessage] = useState('');
  const [toastKey, setToastKey] = useState(0);
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setToastKey(k => k + 1);
  }, []);
  const [collapsed, setCollapsed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchVisible, setSearchVisible] = useState(false);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [diffExpanded, setDiffExpanded] = useState(false);
  const [shareSelectionMode, setShareSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const scrollProgressAnim = useRef(new Animated.Value(0)).current;
  const isNearBottomRef = useRef(true);
  const prevMessageIdsRef = useRef<Set<string>>(new Set());
  const openedAtLastMessageTsRef = useRef<number | null>(null);
  // Visual 3s highlight on a message row. Separate from pendingScrollId: the
  // highlight is paint only, the pending id is a scroll that still owes.
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  // A message the list still has to scroll to once it is in the loaded window
  // (deep link ?message= or a navigator jump outside the window).
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(highlightMessageParam || null);
  // Message navigator (sheet + tick rail) and sticky prompt banner state.
  const [navSheetVisible, setNavSheetVisible] = useState(false);
  const [stickyActive, setStickyActive] = useState<{ id: string; hidden: boolean } | null>(null);
  const [stickyBannerHeight, setStickyBannerHeight] = useState(0);
  // Every prompt the reader dismissed the pill for (web keeps the same Set);
  // the version counter re-runs the memo below when the Set changes. The
  // per conversation reset below clears it.
  const dismissedStickyIdsRef = useRef<Set<string>>(new Set());
  const [dismissedStickyVersion, setDismissedStickyVersion] = useState(0);
  const dismissSticky = useCallback((stickyId: string) => {
    dismissedStickyIdsRef.current.add(stickyId);
    setDismissedStickyVersion(v => v + 1);
  }, []);
  // The overlays under the pill (jump to top button, handoff strip) ride
  // this offset so they slide with the pill's arrival and departure instead
  // of teleporting when its measured height lands.
  const stickyOffsetY = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(stickyOffsetY, { toValue: stickyBannerHeight, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [stickyBannerHeight, stickyOffsetY]);
  const [jumpingToStart, setJumpingToStart] = useState(false);
  const [jumpingToEnd, setJumpingToEnd] = useState(false);
  const [floatingHeaderHeight, setFloatingHeaderHeight] = useState(52);
  const floatingHeaderY = useRef(new Animated.Value(0)).current;
  // Opacity twin of the collapse: the metadata strip fades as it slides under
  // the pinned title bar, so it's cleanly gone (not a sliver) when collapsed.
  const floatingHeaderOpacity = useRef(new Animated.Value(1)).current;
  const floatingHeaderOffsetRef = useRef(0);
  const lastScrollYRef = useRef(0);
  const didInitialScrollRef = useRef(false);
  const initialScrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Everything comes from the shared inboxStore via the canonical web hook: the
  // pending-merged message list AND the rich conversation metadata (fork/share/
  // child/agent/git/model/draft). The hook subscribes to getConversationWithMeta
  // — which spreads the full conversation doc — and syncs it into the store, so
  // there's no need for a separate getAllMessages query. It also hydrates from
  // the local cache, subscribes to live deltas, and runs watermark recovery.
  // targetMessageId is the deep-link target (the ?message= param) so the hook
  // loads the window around it.
  const {
    conversation: storeConversation,
    hasMoreAbove: hookHasMoreAbove,
    isLoadingOlder: hookIsLoadingOlder,
    loadOlder: hookLoadOlder,
    jumpToStart: hookJumpToStart,
    jumpToEnd: hookJumpToEnd,
    jumpToTimestamp: hookJumpToTimestamp,
  } = useConversationMessages(id as string, highlightMessageParam || undefined);

  // A session the store does not hold (a deep link, a teammate's, one outside
  // the inbox window) is looked up as an inbox row and seeded, the same as
  // web's SessionPane. Only the server's answer that it is gone reads as "not
  // found"; until then the screen is honestly cold.
  const storeConv = storeConversation as ConversationData | null;
  const missingLookup = useMissingSessionLookup(!storeConv && typeof id === 'string' && isConvexId(id) ? id : null);
  useEffect(() => {
    if (missingLookup.row) useInboxStore.getState().seedSession(missingLookup.row);
  }, [missingLookup.row]);
  const conversation = storeConv
    ?? (id === DESIGN_MOCK_ID ? DESIGN_MOCK_CONVO : missingLookup.row === null && !missingLookup.failed ? null : undefined);
  // Who this session is (its character, or its role): the header wears the
  // same face and name the inbox row does.
  const identityRow = useSessionIdentityRow(conversation?._id ? String(conversation._id) : null, conversation as any);
  const seatIdentity = identityRow ? sessionIdentity(identityRow) : null;
  const boardHref = boardHrefProp ?? (seatIdentity?.kind === 'role' ? `/org/${seatIdentity.role.short_id}/board` : null);
  // A conversation with the hosted assistant runs on no machine: the header
  // drops the model, device and context chips, the menu drops restart and
  // resume, tool calls read as plain steps (HostedStep), and the approvals it
  // waits on sit at the foot of the transcript with the actual draft.
  const hosted = isHostedAgentType(conversation?.agent_type);
  const familyLook = useActiveLook() === 'family';
  // The registry decides what a mode shows on any conversation (a local
  // session opened in assistant mode too); `hosted` adds what a hosted
  // conversation never has. Internals: restart, resume, folding, token counts.
  const internals = internalsShown && !hosted;
  const diffShown = diffSurface && !hosted;
  const approvals = useConversationApprovals(String(conversation?._id ?? id));
  const hostedApprovals = hosted ? approvals : NO_APPROVALS;
  // The family look's jump arrows are solid sheet discs, as its other
  // controls are: the developer's ghost disc reads as a smudge over the
  // reading face.
  const { c: hostedColors } = useHostedTheme();
  const jumpFamily = { backgroundColor: hostedColors.sheet, opacity: 1, borderColor: hostedColors.lineStrong, shadowOpacity: 0.08, shadowRadius: 6 };
  // Where the parked approval stands, read from the transcript and the
  // decision rows (lib/hostedApproval), as the web reads it: once answered,
  // the card's place holds "You said yes. On it…" until the turn moves on;
  // before its row lands, a quiet "Getting the card ready…".
  const hostedApprovalAt = useInboxStore((st): HostedApprovalState => {
    if (!hosted) return 'none';
    const key = String(conversation?._id ?? id);
    return hostedApprovalState(st.messages[key] as any, Object.values(st.sessionDecisions) as any[], key);
  });
  const parkedStatus = useManagedSessionFields(String(conversation?._id ?? id))?.agent_status === 'permission_blocked';
  const settledAnswer = hostedApprovals.length === 0 ? hostedApprovalAnswer(hostedApprovalAt) : null;
  const hostedTurnRunning = useConversationWorking(String(conversation?._id ?? id)) && hosted;
  const linkDown = useLinkDown();
  const cardPending = hostedApprovals.length === 0 && hostedApprovalAt === 'pending' && parkedStatus;
  // A failed send tries again through the store's one retry rule
  // (retryPendingSend, which the web's failed bubble uses too, and which also
  // covers a conversation whose create never landed). This screen only
  // reports how it came out.
  const retryFailedSend = useCallback((clientId: string, text: string) => {
    void retryPendingSend(id, clientId, text).then(
      (status) => {
        if (status === 'uploading') showToast('Your attachment is still uploading');
        else if (status === 'unavailable') showToast("Couldn't send. Check your connection and try again.");
        else if (status === 'cancelled') showToast('This message was cancelled');
      },
      () => showToast("Couldn't send. Check your connection and try again."),
    );
  }, [id, showToast]);
  const title = hosted ? conversationTitle(conversation) : conversation?.title || 'Conversation';

  // Gate every server query that takes a v.id("conversations") on isConvexId. A
  // freshly created session navigates here under a local stub id (see
  // beginOptimisticSession) BEFORE the real Convex id exists; firing these with
  // the stub throws an ArgumentValidationError server-side and crashes the
  // screen. The shared useConversationMessages hook already gates itself this
  // way — these screen-local queries need the same guard. Once the create
  // resolves and rekeys the URL to the real id, they activate automatically.
  const isReal = typeof id === "string" && isConvexId(id);

  // git_diff blobs live off the conversation doc (up to 100 KB each, re-pushed
  // on every edit), so the side-table query subscribes on intent: from the
  // moment the actions menu opens, which is ahead of the "View Diff" tap.
  const [diffWanted, setDiffWanted] = useState(false);
  const gitDiffData = useQuery(
    api.conversations.getConversationGitDiff,
    (diffWanted || diffExpanded) && isReal ? { conversation_id: id as Id<"conversations"> } : "skip"
  );

  const pendingPermissions = usePendingPermissions(isReal ? (id as string) : null);

  // Bookmarks are one store list, synced with the inbox; a toggle flips it
  // locally (store.toggleBookmark) before the server hears about it.
  const bookmarks = useInboxStore((s) => s.bookmarks);
  const bookmarkedSet = useMemo(
    () => new Set((bookmarks as any[]).filter((b) => b.conversation_id === id).map((b) => String(b.message_id))),
    [bookmarks, id],
  );

  // Commits and pull requests linked to this session: the same feeders and
  // store rows as the web conversation view, so a cached session paints them
  // with its transcript.
  const gitLinkConversationId = isReal ? (id as string) : undefined;
  useSyncConversationCommits(gitLinkConversationId);
  useSyncConversationPullRequests(gitLinkConversationId);
  const commits = useConversationCommits(gitLinkConversationId) as Array<{
    _id: string; sha: string; message: string; timestamp: number;
  }>;
  const pullRequests = useConversationPullRequests(gitLinkConversationId) as Array<{
    _id: string; number: number; title: string; repository?: string;
    created_at: number; merged_at?: number;
  }>;

  // The fork family, built from the store (inbox rows plus the conversation's
  // fork fields) the moment the sheet opens; the server tree merges in any
  // branch this phone has never seen.
  const [treeModalVisible, setTreeModalVisible] = useState(false);
  const forkFamily = useForkTree(conversation as any, treeModalVisible);
  const hasForkFamily = !!conversation?.forked_from || (conversation?.fork_count ?? 0) > 0 || (conversation?.fork_children?.length ?? 0) > 0;

  const hasMoreAbove = hookHasMoreAbove;
  const loadingOlder = hookIsLoadingOlder;
  const loadOlderMessages = hookLoadOlder;

  const allMessages = useMemo(() => {
    // Store-backed, pending-merged message list from useConversationMessages.
    // Drop context-only import notices synced by older CLIs.
    const raw = conversation?.messages || [];
    const msgs = raw.some(m => m.role === 'user' && isImportNotice(m.content))
      ? raw.filter(m => !(m.role === 'user' && isImportNotice(m.content)))
      : raw;
    const synthetic: Message[] = [];
    if (commits && commits.length > 0) {
      for (const c of commits) {
        synthetic.push({
          _id: `commit-${c._id}`,
          role: 'system',
          subtype: 'commit',
          content: c.message,
          timestamp: c.timestamp,
          message_uuid: c.sha,
        });
      }
    }
    if (pullRequests && pullRequests.length > 0) {
      for (const pr of pullRequests) {
        synthetic.push({
          _id: `pr-${pr._id}`,
          role: 'system',
          subtype: 'pull_request',
          content: `#${pr.number} ${pr.title}`,
          timestamp: pr.merged_at || pr.created_at,
          message_uuid: `pr-${pr.number}`,
          pr: pr.repository ? { repository: pr.repository, number: pr.number } : undefined,
        });
      }
    }
    if (synthetic.length === 0) return msgs;
    const merged = [...msgs, ...synthetic];
    merged.sort((a, b) => a.timestamp - b.timestamp);
    return merged;
  }, [conversation?.messages, commits, pullRequests]);

  const invertedMessages = useMemo(() => [...allMessages].reverse(), [allMessages]);
  const userRowKinds = useMemo(() => {
    const timeline = allMessages.map((m) => ({ type: 'message' as const, data: m as any, timestamp: m.timestamp }));
    const kinds = classifyUserRows(timeline, allMessages as any, { agentType: conversation?.agent_type, parentConversationId: conversation?.parent_conversation_id, hasMoreAbove });
    return { kinds, expansions: pairCommandExpansions(timeline, kinds) };
  }, [allMessages, conversation?.agent_type, conversation?.parent_conversation_id, hasMoreAbove]);
  // Each run of tool calls folds to one row the person opens by tapping; a
  // hosted conversation already tells its steps in its own words.
  const toolRuns = useMemo(() => hosted ? new Map<string, ToolRun>() : foldToolRuns(allMessages, isToolResultCarrier), [allMessages, hosted]);
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => new Set());
  // When a run was last opened, so the calls it shows fade in then and not on a later remount.
  const runOpenedAt = useRef(new Map<string, number>());
  const toggleRun = useCallback((head: string) => setOpenRuns(prev => {
    const next = new Set(prev);
    if (!next.delete(head)) {
      next.add(head);
      runOpenedAt.current.set(head, Date.now());
    }
    return next;
  }), []);

  // Row keys survive the optimistic-to-server handoff (web's messageRowKey), so
  // a sent bubble keeps its cell and never animates twice.
  const rowKeysOldestFirst = useMemo(() => uniqueRowKeys(allMessages.map(messageRowKey)), [allMessages]);
  const rowKeys = useMemo(() => [...rowKeysOldestFirst].reverse(), [rowKeysOldestFirst]);
  // Only rows that just arrived animate in (lib/freshRows). Updated as the
  // keys change, before the rows below read it in this same render.
  const freshRows = useMemo(() => new FreshRows(), [id]);
  useMemo(() => freshRows.update(rowKeysOldestFirst, Date.now()), [freshRows, rowKeysOldestFirst]);
  const rowEntering = (item: Message, key: string) => {
    const now = Date.now();
    if (freshRows.isFresh(key, now)) return item.role === 'user' ? sendEntering : arriveEntering;
    const run = toolRuns.get(item._id);
    if (run && run.head !== item._id && now - (runOpenedAt.current.get(run.head) ?? 0) < RUN_FADE_WINDOW_MS) return RUN_CALLS_ENTERING;
    return undefined;
  };
  // A hosted turn that failed and was tried again reads as one turn, as on
  // the web: the earlier notices and the repeated request fold away and the
  // shown notice counts the attempts (lib/hostedNotice foldHostedRetries).
  // A person's turn is what the shared classifier reads as typed by one, so a
  // decision answer or a vault-ready line is never counted as a retry.
  const retryFold = useMemo(() => {
    if (!hosted) return null;
    const rows = allMessages.map((m) => {
      const kind = m.role === 'user' ? (userRowKinds.kinds.get(m._id)?.kind ?? 'normal') : null;
      return { ...m, person: kind === 'normal' || kind === 'direct_user' };
    });
    return { ...foldHostedRetries(rows), personTurns: rows.filter((r) => r.person).length };
  }, [hosted, allMessages, userRowKinds]);

  const router = useRouter();
  const insets = useSafeAreaInsets();
  const androidImeInset = useAndroidImeInset();

  // Self-heal a stub URL → real id. A freshly created session lands here under a
  // local stub id (beginOptimisticSession) for instant render; once the server
  // create resolves, the store rekeys the stub to the real Convex id and DELETES
  // the stub key (rekeyId). getConvexId maps the stub → real via the session_id
  // seed, flipping from null to the real id at that moment — swap the screen's
  // id param so every v.id("conversations") query activates and the screen keeps
  // live data instead of reading the now-deleted stub.
  //
  // Use setParams (NOT router.replace): replace() pushes a new entry onto the
  // native stack for the same session/[id] screen, which expo-router animates as
  // a fresh screen — the session visibly "opens a second time" ~1s after create.
  // setParams mutates the current route's params in place: no stack op, no
  // remount, no transition. Back-nav still lands on the inbox (the prior entry).
  const resolvedRealId = useInboxStore((s) =>
    isReal ? null : s.getConvexId(id as string) ?? null
  );
  useEffect(() => {
    if (resolvedRealId && resolvedRealId !== id) {
      router.setParams({ id: resolvedRealId });
    }
  }, [resolvedRealId, id, router]);

  const forkPointMap = useMemo(() => {
    const map: Record<string, ForkChild[]> = {};
    if (conversation?.fork_children) {
      for (const fork of conversation.fork_children) {
        if (fork.parent_message_uuid) {
          if (!map[fork.parent_message_uuid]) map[fork.parent_message_uuid] = [];
          map[fork.parent_message_uuid].push(fork);
        }
      }
    }
    return map;
  }, [conversation?.fork_children]);

  // Off the conversation doc, which is a new object on every heartbeat.
  const childConversationMap = useShallowStable(conversation?.child_conversation_map);
  const taskSubjectMap = useShallowStable(useMemo(() => {
    const createInputs: Record<string, string> = {};
    const idMap: Record<string, string> = {};
    for (const msg of allMessages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.name === 'TaskCreate') {
            try {
              const inp = JSON.parse(tc.input);
              if (inp.subject) createInputs[tc.id] = String(inp.subject);
            } catch {}
          }
        }
      }
      if (msg.role === 'user' && msg.tool_results) {
        for (const tr of msg.tool_results) {
          if (createInputs[tr.tool_use_id]) {
            const m = tr.content.match(/Task #(\d+)/);
            if (m) idMap[m[1]] = createInputs[tr.tool_use_id];
          }
        }
      }
    }
    return idMap;
  }, [allMessages]));

  const globalToolResultMap = useShallowStable(useMemo(() => {
    const map: Record<string, ToolResult> = {};
    for (const msg of allMessages) {
      if (msg.role === 'user' && msg.tool_results) {
        for (const tr of msg.tool_results) {
          map[tr.tool_use_id] = tr;
        }
      }
    }
    return map;
  }, [allMessages]));

  const globalImageMap = useShallowStable(useMemo(() => {
    const map: Record<string, ImageData> = {};
    for (const msg of allMessages) {
      if (msg.images) {
        for (const img of msg.images) {
          if (img.tool_use_id) {
            map[img.tool_use_id] = img;
          }
        }
      }
    }
    return map;
  }, [allMessages]));

  // Every image in the session, in transcript order — attachments, tool
  // screenshots AND trusted markdown images in prose (same scan as the web
  // header gallery; entries carry either a storage_id or a ready src).
  //
  // The server list covers the whole thread (materialized at ingest), so the
  // gallery no longer stops at the loaded message window; the window scan
  // merges in for inline base64 images and un-swept history.
  const serverSessionImages = useQuery(
    api.messages.getConversationImages,
    isReal ? { conversation_id: id as Id<"conversations"> } : "skip"
  );
  const allSessionImages = useMemo(() => {
    const entries = mergeSessionImages(
      serverSessionImages ?? [],
      extractSessionImages(allMessages, isTrustedImageSrc),
    );
    return entries.map((e): ImageData =>
      e.storage_id
        ? { media_type: "image/png", storage_id: e.storage_id }
        : { media_type: "image", url: e.src }
    );
  }, [allMessages, serverSessionImages]);

  // Sweep a pre-feature history into conversation_images once, so a thread whose
  // images all sit above the loaded window still fills the gallery. Same
  // contract as web: the server stamps the conversation and no-ops afterwards,
  // and image_preview_url on the row is the evidence that images exist at all.
  const backfillConversationImages = useMutation(api.messages.backfillConversationImages);
  const imagesBackfilledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isReal || !serverSessionImages || conversation?.is_own === false) return;
    const cid = id as string;
    if (imagesBackfilledRef.current === cid) return;
    const known = new Set(serverSessionImages.map((e: SessionImageEntry) => e.key));
    const windowHasUnknown = extractSessionImages(allMessages, isTrustedImageSrc).some(
      (e) => !e.src?.startsWith('data:') && !known.has(e.key)
    );
    const rowHasImages = !!useInboxStore.getState().sessions[cid]?.image_preview_url;
    if (!windowHasUnknown && !rowHasImages) return;
    imagesBackfilledRef.current = cid;
    backfillConversationImages({ conversation_id: cid as Id<"conversations"> }).catch(() => {});
  }, [isReal, id, conversation?.is_own, serverSessionImages, allMessages, backfillConversationImages]);

  const [galleryVisible, setGalleryVisible] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  // Read through a ref so every bubble keeps one handler as images arrive.
  const allSessionImagesRef = useRef(allSessionImages);
  allSessionImagesRef.current = allSessionImages;
  const openGallery = useCallback((image: ImageData) => {
    const key = imageKeyOf(image);
    const idx = key ? allSessionImagesRef.current.findIndex(img => imageKeyOf(img) === key) : -1;
    setGalleryIndex(Math.max(0, idx));
    setGalleryVisible(true);
  }, []);

  // Local-first fork, the same store path as web: the stub opens already
  // holding the parent's messages up to the fork point, and the screen moves
  // to the real id when the server create lands (the stub URL self-heal below).
  // Read through a ref: the conversation object changes on every heartbeat,
  // and this handler is a prop of every (memoized) bubble.
  const forkInputs = useRef({ conversation, hasMoreAbove });
  forkInputs.current = { conversation, hasMoreAbove };
  const handleForkFromMessage = useCallback((messageUuid: string) => {
    if (!id) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const fork = beginLocalFork(forkInputs.current.conversation as any, messageUuid, {
      currentUser: useInboxStore.getState().currentUser,
      hasMoreAbove: forkInputs.current.hasMoreAbove,
      onError: (message) => Alert.alert('Fork failed', message),
    });
    if (fork) router.push(`/session/${fork.forkSessionId}`);
  }, [id, router]);

  const handleCopyAll = useCallback(async () => {
    if (!allMessages.length) return;
    const formatted = allMessages
      .filter(msg => {
        if (msg.role === 'system') return false;
        if (msg.role === 'user' && msg.tool_results) return false;
        if (msg.role === 'user' && msg.content && isCommandMessage(msg.content)) return false;
        return msg.content && msg.content.trim().length > 0;
      })
      .map(msg => {
        const ts = new Date(msg.timestamp).toLocaleString();
        const label = msg.role === 'user' ? 'User' : 'Assistant';
        return `[${ts}] ${label}:\n${msg.content}\n`;
      })
      .join('\n');
    Clipboard.setString(formatted);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    showToast('Conversation copied');
  }, [allMessages, showToast]);

  const handleCopyResume = useCallback(async () => {
    if (!conversation) return;
    const agentType = conversation.agent_type;
    let cmd: string;
    if (agentType === 'codex') {
      if (!conversation.session_id) return;
      cmd = `codex resume ${conversation.session_id}`;
    } else {
      const resumeId = conversation.short_id || conversation.session_id;
      if (!resumeId) return;
      cmd = `cast resume ${resumeId}`;
    }
    Clipboard.setString(cmd);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    showToast('Resume command copied');
  }, [conversation?.short_id, conversation?.session_id, conversation?.agent_type, showToast]);

  const generateShareLink = useMutation(api.conversations.generateShareLink);
  const stashSession = useInboxStore((s) => s.stashSession);
  const toggleFavorite = useInboxStore((s) => s.toggleFavorite);
  const setPrivacy = useInboxStore((s) => s.setPrivacy);
  const setTeamVisibility = useInboxStore((s) => s.setTeamVisibility);

  const handleToggleFavorite = useCallback(() => {
    if (!id) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Local-first: the star flips synchronously in the store; the server
    // mutation rides the outbox. No await — the UI never waits on the round-trip.
    toggleFavorite(id);
  }, [id, toggleFavorite]);

  const handleShareConversation = useCallback(async () => {
    if (!conversation || !id) return;
    const convId = id as Id<"conversations">;
    const isPrivate = conversation.is_private !== false;
    const hasTeam = !!conversation.team_id;
    const vis = conversation.team_visibility || 'summary';

    const options: string[] = [];
    if (!isPrivate) options.push('Make Private');
    if (hasTeam && (isPrivate || vis !== 'summary')) options.push('Share with Team (Summary)');
    if (hasTeam && (isPrivate || vis !== 'full')) options.push('Share with Team (Full)');
    options.push(conversation.share_token ? 'Copy Share Link' : 'Generate & Copy Share Link');
    if (conversation.share_token) options.push('Share Link via...');
    options.push('Cancel');

    ActionSheetIOS.showActionSheetWithOptions(
      { options, cancelButtonIndex: options.length - 1, title: 'Sharing' },
      async (idx) => {
        const label = options[idx];
        try {
          if (label === 'Make Private') {
            // Local-first: optimistically flips is_private on the store row so
            // re-opening the share sheet immediately reflects 'private'.
            setPrivacy(convId, true);
            showToast('Made private');
          } else if (label === 'Share with Team (Summary)') {
            setTeamVisibility(convId, 'summary');
            showToast('Sharing summary with team');
          } else if (label === 'Share with Team (Full)') {
            setTeamVisibility(convId, 'full');
            showToast('Sharing full conversation with team');
          } else if (label === 'Copy Share Link' || label === 'Generate & Copy Share Link') {
            let token = conversation.share_token;
            if (!token) {
              token = await generateShareLink({ conversation_id: convId });
            }
            if (token) {
              const url = conversationShareLink(token);
              Clipboard.setString(url);
              showToast('Share link copied');
            }
          } else if (label === 'Share Link via...') {
            const url = conversationShareLink(conversation.share_token!);
            await Share.share({ message: url, url });
          }
        } catch (_e) {
          showToast('Failed to update sharing');
        }
      },
    );
  }, [conversation, id, generateShareLink, setPrivacy, setTeamVisibility, showToast]);

  const searchLower = searchQuery.toLowerCase();
  const searchMatchList = useMemo(() => {
    if (!searchLower) return [];
    return allMessages.filter(msg => msg.content && msg.content.toLowerCase().includes(searchLower)).map(m => m._id);
  }, [searchLower, allMessages]);

  const searchMatchIds = useMemo(
    () => (searchLower ? new Set(searchMatchList) : null),
    [searchLower, searchMatchList],
  );

  useEffect(() => { setCurrentMatchIndex(0); }, [searchQuery]);

  // Ref twin of allMessages so the stable jump/scroll callbacks and the
  // FlatList viewability handler (which must never change identity) read the
  // current list without re-creating per render.
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  // Retry bookkeeping for onScrollToIndexFailed: which inverted index is mid
  // retry and how many rounds it has taken. A fresh jump resets it.
  const scrollRetryRef = useRef<{ index: number; count: number }>({ index: -1, count: 0 });

  // Scroll the inverted list to a message already in the loaded window.
  // Returns false when the message is not loaded.
  const scrollToLoadedMessage = useCallback((messageId: string): boolean => {
    const msgs = allMessagesRef.current;
    const idx = msgs.findIndex(m => m._id === messageId);
    if (idx < 0) return false;
    scrollRetryRef.current = { index: -1, count: 0 };
    const invertedIdx = msgs.length - 1 - idx;
    flatListRef.current?.scrollToIndex({ index: invertedIdx, animated: true, viewPosition: 0.3 });
    return true;
  }, []);

  // Light the 3s row highlight, releasing it only if it is still ours. The ref
  // remembers the jump target so a scrollToIndex retry can restart the flash
  // when the row finally renders.
  const highlightTargetRef = useRef<string | null>(null);
  const flashHighlight = useCallback((messageId: string) => {
    highlightTargetRef.current = messageId;
    setHighlightedMessageId(messageId);
    setTimeout(() => setHighlightedMessageId(cur => (cur === messageId ? null : cur)), 3000);
  }, []);

  // Jump to any message. In the loaded window: scroll (viewPosition 0.3) and
  // highlight for 3s. Outside it: ask the hook for a window around the target's
  // timestamp — jumpToTimestamp resets the hook's target latch, so a SECOND
  // out-of-window jump (or one after a ?message= deep link) still moves the
  // window; setParams alone would be ignored once the first target loaded. The
  // param is still set so the URL carries the target. The pending scroll effect
  // below finishes the jump when the window lands.
  const jumpToMessage = useCallback((messageId: string) => {
    if (scrollToLoadedMessage(messageId)) {
      flashHighlight(messageId);
      return;
    }
    setPendingScrollId(messageId);
    const target = useInboxStore.getState().userMessages[id as string]?.find(m => m._id === messageId);
    if (target) hookJumpToTimestamp(target.timestamp);
    router.setParams({ message: messageId });
  }, [scrollToLoadedMessage, flashHighlight, router, id, hookJumpToTimestamp]);

  // A ?message= param set after mount (a jump outside the loaded window, or an
  // external deep link) owes the same scroll as the one the screen opened with.
  useEffect(() => {
    if (highlightMessageParam) setPendingScrollId(highlightMessageParam);
  }, [highlightMessageParam]);

  // A far jump waits over a second for its window while the list keeps
  // painting the old frame; dim it so the wait reads as in flight rather
  // than a stall. Restored by the landing timeout below, so the settle and
  // the fade release read as one gesture.
  const listOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!pendingScrollId) return;
    Animated.timing(listOpacity, { toValue: 0.55, duration: 120, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [pendingScrollId, listOpacity]);

  // Deep links and jumps outside the window settle here: once the target is
  // in the loaded window, scroll to it (the 250ms delay lets the inverted list
  // lay out the fresh window first; onScrollToIndexFailed retries a window
  // that lays out later) and light the highlight.
  useEffect(() => {
    if (!pendingScrollId || allMessages.length === 0) return;
    if (!allMessages.some(m => m._id === pendingScrollId)) return;
    const target = pendingScrollId;
    setPendingScrollId(null);
    // Mark the target now (no timer) so the sticky pill's landing hold takes
    // over from its pending form in the same frame the pending id clears;
    // otherwise it crossfades to a stale prompt for the 250ms below.
    highlightTargetRef.current = target;
    setHighlightedMessageId(target);
    // Flash INSIDE the timeout, with the scroll: fired at effect time the 3s
    // highlight is partly spent before the fresh window has even laid out.
    setTimeout(() => {
      scrollToLoadedMessage(target);
      flashHighlight(target);
      Animated.timing(listOpacity, { toValue: 1, duration: 150, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }, 250);
    // Depend on the ARRAY, not its length: a jump between two 50+50 target
    // windows can land a new window of identical length, and the body is a
    // cheap .some().
  }, [pendingScrollId, allMessages, scrollToLoadedMessage, flashHighlight, listOpacity]);

  const goToNextMatch = useCallback(() => {
    if (searchMatchList.length === 0) return;
    const nextIndex = (currentMatchIndex + 1) % searchMatchList.length;
    setCurrentMatchIndex(nextIndex);
    scrollToLoadedMessage(searchMatchList[nextIndex]);
  }, [searchMatchList, currentMatchIndex, scrollToLoadedMessage]);

  const goToPrevMatch = useCallback(() => {
    if (searchMatchList.length === 0) return;
    const prevIndex = currentMatchIndex === 0 ? searchMatchList.length - 1 : currentMatchIndex - 1;
    setCurrentMatchIndex(prevIndex);
    scrollToLoadedMessage(searchMatchList[prevIndex]);
  }, [searchMatchList, currentMatchIndex, scrollToLoadedMessage]);

  // =============================================
  // Message navigator (sheet + tick rail) + sticky prompt banner
  // =============================================
  // The complete user message list, independent of the paginated window. The
  // shared useConversationMessages hook keeps it in the store — the same feed
  // the web navigator reads. setUserMessages drops syncs that change nothing,
  // so this array ref is stable and safe to memo on.
  const navSourceMessages = useInboxStore(s => s.userMessages[id as string]);

  // Comment counts per message, the same enrichment the web popover shows,
  // read from the store's comments (persisted; fed by the same feeder web
  // mounts per open conversation).
  useConversationCommentsSync(isReal ? (id as string) : undefined);
  const commentSummary = useConversationCommentRows(id as string);
  const commentCountsByMessage = useMemo(() => countCommentsByMessage(commentSummary), [commentSummary]);

  const navigatorRows = useMemo(
    () => buildNavigatorRows(navSourceMessages ?? [], commentCountsByMessage, resolveSessionTitle),
    [navSourceMessages, commentCountsByMessage],
  );
  const navRowById = useMemo(() => {
    const map = new Map<string, NavigatorRow>();
    for (const r of navigatorRows) map.set(r._id, r);
    return map;
  }, [navigatorRows]);
  // The rail and the header count agree with the sheet's default view: the
  // human's prompts only, never the machine rows the chip hides.
  const promptRows = useMemo(() => navigatorRows.filter(r => r.kind === 'user'), [navigatorRows]);
  const promptCount = promptRows.length;

  // Indices (original order, LOADED window) of prompts the sticky banner may
  // show.
  const stickyIndices = useMemo(() => {
    const eligible = stickyEligibleIds(allMessages);
    const indices: number[] = [];
    for (let i = 0; i < allMessages.length; i++) {
      if (eligible.has(allMessages[i]._id)) indices.push(i);
    }
    return indices;
  }, [allMessages]);
  const stickyIndicesRef = useRef(stickyIndices);
  stickyIndicesRef.current = stickyIndices;

  // The full prompt list and the ids the window holds: a prompt the window
  // does not hold can still be the one above the reader (pickStickyFallback).
  const navSourceRef = useRef(navSourceMessages);
  navSourceRef.current = navSourceMessages;
  const navSourceEligible = useMemo(() => stickyEligibleIds(navSourceMessages ?? []), [navSourceMessages]);
  const navSourceEligibleRef = useRef(navSourceEligible);
  navSourceEligibleRef.current = navSourceEligible;
  const loadedIds = useMemo(() => new Set(allMessages.map(m => m._id)), [allMessages]);
  const loadedIdsRef = useRef(loadedIds);
  loadedIdsRef.current = loadedIds;

  // Viewability drives the active sticky prompt. The handler and its config
  // must keep ONE identity for the FlatList's lifetime, so the handler reads
  // everything through refs and sets state only when the resolved active
  // prompt (or whether its row is on screen) actually changes — scrolling
  // inside one prompt's output costs no re-render.
  const stickyActiveRef = useRef<{ id: string; hidden: boolean } | null>(null);
  // Coverage of the VIEWPORT, not the item: a single agent output taller than
  // the screen would never reach an item-percent threshold and the banner
  // would vanish mid-read. Any visible pixel counts.
  const stickyViewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 0, minimumViewTime: 32 }).current;
  // Snapshot of the last viewability event, so the resolution can re-run when
  // the LIST changes under a static viewport (see the effect below).
  const lastViewableItemsRef = useRef<Array<{ index: number | null }>>([]);
  const resolveStickyFromViewable = useCallback(() => {
    const msgs = allMessagesRef.current;
    const total = msgs.length;
    let maxInvertedIdx = -1;
    const visibleOriginal = new Set<number>();
    for (const v of lastViewableItemsRef.current) {
      if (v.index == null) continue;
      if (v.index > maxInvertedIdx) maxInvertedIdx = v.index;
      visibleOriginal.add(total - 1 - v.index);
    }
    // Inverted list: the LARGEST inverted index is the topmost visible row.
    // A snapshot pointing past the current list (the window shrank) resolves
    // to null, clearing the claim until viewability fires again.
    const topVisibleIndex = maxInvertedIdx >= 0 ? total - 1 - maxInvertedIdx : -1;
    const resolved = topVisibleIndex >= 0
      ? resolveStickyPrompt(stickyIndicesRef.current, topVisibleIndex, visibleOriginal)
      : null;
    // Before the first viewability event, the window's first row stands in
    // for the top visible one.
    const topTs = msgs[Math.max(topVisibleIndex, 0)]?.timestamp ?? Infinity;
    const above = pickStickyFallback(navSourceRef.current, loadedIdsRef.current, topTs, resolved ? msgs[resolved.index].timestamp : -Infinity, navSourceEligibleRef.current);
    const next = above ? { id: above.id, hidden: false } : resolved ? { id: msgs[resolved.index]._id, hidden: resolved.hidden } : null;
    const prev = stickyActiveRef.current;
    if (prev?.id === next?.id && prev?.hidden === next?.hidden) return;
    stickyActiveRef.current = next;
    setStickyActive(next);
  }, []);
  const handleViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
    lastViewableItemsRef.current = viewableItems;
    resolveStickyFromViewable();
  }).current;

  // FlatList emits viewability events only when the visible item SET changes.
  // When allMessages is replaced (target window lands, pager prepends, live
  // tail swap), the same inverted indices mean different messages, so the
  // stored resolution is stale and nothing re-runs it, so the pill keeps
  // claiming the old window's prompt. Re-run from the saved snapshot whenever
  // the array identity changes.
  useEffect(() => {
    resolveStickyFromViewable();
  }, [allMessages, navSourceMessages, resolveStickyFromViewable]);

  // Active prompt, also the navigator's current row.
  const activeStickyId = stickyActive?.id ?? null;

  const stickyPrompt = useMemo<StickyPrompt | null>(() => {
    // Hosted mode has no sticky prompt (surface conversation.stickyPrompt).
    if (!stickyPromptShown) return null;
    // Mid jump the window is reloading and activeStickyId churns; the claim
    // that the visible output belongs to prompt N is wrong until the target
    // message lands. The pill names the TARGET instead, in its pending form,
    // so the dimmed wait says where the list is going.
    if (pendingScrollId) {
      const target = navRowById.get(pendingScrollId);
      if (!target || target.kind !== 'user') return null;
      return { id: target._id, ordinal: target.originalIndex + 1, text: target.display, pending: true };
    }
    if (!userScrolled || promptCount < 2) return null;
    // A landed jump parks its prompt 30% down the screen, so the rows above
    // it belong to the PREVIOUS prompt and the pill would relabel itself the
    // instant the reader chose a prompt. Hold it while the jump highlight is
    // on; it returns once the reader scrolls on.
    if (highlightedMessageId && navRowById.get(highlightedMessageId)?.kind === 'user') return null;
    if (stickyActive?.hidden) return null; // the prompt row itself is on screen
    if (!activeStickyId || dismissedStickyIdsRef.current.has(activeStickyId)) return null;
    const row = navRowById.get(activeStickyId);
    if (!row || row.kind !== 'user') return null;
    return { id: row._id, ordinal: row.originalIndex + 1, text: row.display };
    // dismissedStickyVersion stands in for the Set, which mutates in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickyPromptShown, userScrolled, promptCount, pendingScrollId, highlightedMessageId, stickyActive, activeStickyId, dismissedStickyVersion, navRowById]);

  const navTicks = useMemo(() => {
    // activeStickyId is always a sticky eligible user message, so it is in
    // promptRows whenever it is in navigatorRows at all.
    const activeIndex = activeStickyId ? promptRows.findIndex(r => r._id === activeStickyId) : -1;
    return sampleTicks(promptRows, 24, activeIndex);
  }, [promptRows, activeStickyId]);

  const openNavigatorSheet = useCallback(() => setNavSheetVisible(true), []);
  const closeNavigatorSheet = useCallback(() => setNavSheetVisible(false), []);

  // Rail scrub: light the scrubbed prompt's row while the finger moves (paint
  // only, no scroll); release jumps, and the jump owns the highlight from
  // then on (the rail's trailing onScrub(null) must not clear it).
  const scrubHighlightRef = useRef<string | null>(null);
  const handleRailScrub = useCallback((messageId: string | null) => {
    if (messageId) {
      scrubHighlightRef.current = messageId;
      setHighlightedMessageId(messageId);
      return;
    }
    const last = scrubHighlightRef.current;
    scrubHighlightRef.current = null;
    if (last) setHighlightedMessageId(cur => (cur === last ? null : cur));
  }, []);
  const handleRailScrubEnd = useCallback((messageId: string) => {
    scrubHighlightRef.current = null;
    jumpToMessage(messageId);
  }, [jumpToMessage]);

  const latestUsage = useMemo(() => {
    if (id === DESIGN_MOCK_ID) return { inputTokens: 0, outputTokens: 0, cacheCreation: 0, cacheRead: 0, contextSize: 124000 };
    let latest: UsageData | null = null;
    let latestTs = 0;
    for (const msg of allMessages) {
      if (msg.role === 'assistant' && msg.usage) {
        const u = msg.usage;
        if (msg.timestamp > latestTs) {
          const cacheCreation = u.cache_creation_input_tokens || 0;
          const cacheRead = u.cache_read_input_tokens || 0;
          latest = {
            inputTokens: u.input_tokens || 0,
            outputTokens: u.output_tokens || 0,
            cacheCreation,
            cacheRead,
            contextSize: cacheCreation + cacheRead + (u.input_tokens || 0),
          };
          latestTs = msg.timestamp;
        }
      }
    }
    return latest;
  }, [allMessages]);

  const handleStartShareSelection = useCallback(() => {
    setShareSelectionMode(true);
    setSelectedMessageIds(new Set());
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleToggleMessageSelection = useCallback((msgId: string) => {
    setSelectedMessageIds(prev => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleCancelShareSelection = useCallback(() => {
    setShareSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  const handleCopyMenu = useCallback(() => {
    const openMessageSelect = () => {
      if (shareSelectionMode) return;
      handleStartShareSelection();
      showToast('Select messages to copy');
    };

    showActionSheet('Copy', [
      { label: 'Copy whole conversation', onPress: handleCopyAll },
      { label: 'Select messages', onPress: openMessageSelect },
    ]);
  }, [handleCopyAll, handleStartShareSelection, shareSelectionMode, showToast]);

  const handleDismiss = useCallback(() => {
    if (!id) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    stashSession(id);
    router.back();
  }, [id, stashSession, router]);

  const lastMessageAt = conversation?.messages?.length
    ? conversation.messages[conversation.messages.length - 1]?.timestamp
    : undefined;
  const activityAt = lastMessageAt ?? conversation?.updated_at ?? conversation?.started_at ?? 0;
  const isActive = conversation?.status === 'active' && (Date.now() - activityAt) < 5 * 60 * 1000;

  // One reliable "Restart session" from the phone — the same two-stage recovery
  // web runs (resume ladder, escalate once to a forced rebuild from history).
  const restartNotify = useCallback(
    (_kind: 'success' | 'error' | 'info', message: string) => showToast(message),
    [showToast],
  );
  const restartGhostContext = useCallback(
    () => (conversation?._id ? ghostRestartContextFor(conversation._id) : {}),
    [conversation?._id],
  );
  const { restart: restartSession, isRestarting } = useSessionRestart({
    conversationId: conversation?._id ?? '',
    isLive: !!isActive,
    ghostContext: restartGhostContext,
    notify: restartNotify,
    // The phone has no dispatch-failure toast; say a refused restart here.
    onRefused: showToast,
  });

  // The chip strip shows the model and the branch; the rest wait behind one
  // "+N" tap so the strip under the title stays a single calm line.
  const [chipsExpanded, setChipsExpanded] = useState(false);
  const extraChipCount = [
    (conversation?.fork_count ?? 0) > 0,
    !!conversation && isConvexId(conversation._id) && !hosted,
    !!latestUsage && internals,
    !!conversation?.parent_conversation_id,
    !!conversation?.forked_from_details,
  ].filter(Boolean).length;
  const huddle = useSessionHuddle(conversation?._id ? String(conversation._id) : '', conversation?.team_id ? String(conversation.team_id) : null);
  const [renameVisible, setRenameVisible] = useState(false);

  // Ordered by how often a phone user reaches for each: a live huddle first
  // (time-sensitive), then the everyday reads and shares, then recovery, then
  // the rare ones behind "More…" so the first sheet stays short.
  // Switch agent / fork as: web's session menu rules (lib/sessionControl) and
  // actions (lib/sessionAgentActions). An agent that cannot take this session
  // over is left off the list.
  const pinnedAgents = usePinnedAgentIds();
  const moveVerbs = conversation ? sessionMoveVerbs(conversation.agent_type, conversation.session_id, conversation.model) : [];
  const pickAgentFor = (verb: 'switch' | 'fork') => {
    if (!conversation) return;
    const agentType = conversation.agent_type;
    const options = moveAgentOptions(agentType, conversation.message_count, pinnedAgents)[verb].filter((o) => !o.disabledReason || o.current);
    showActionSheet(MOVE_VERBS[verb].label, options.map((o) => ({
      label: o.label,
      selected: o.current,
      onPress: () => {
        if (o.current) return;
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        const row = sessionRowFor(conversation._id as string, agentType);
        if (verb === 'switch') {
          void switchSessionAgent(row, o.type).catch((err) => Alert.alert('Could not switch agent', err instanceof Error ? err.message : undefined));
          return;
        }
        try {
          const fork = forkSessionAsAgent(row, o.type);
          router.push(`/session/${fork.sessionId}` as any);
          void fork.ready.catch((err) => Alert.alert('Could not fork', err instanceof Error ? err.message : undefined));
        } catch (err) {
          Alert.alert('Could not fork', err instanceof Error ? err.message : undefined);
        }
      },
    })));
  };

  // The "…" sheet (components/session/SessionActionsSheet). Built each render
  // so an open sheet shows live state (a favorite just toggled, a huddle
  // someone joined).
  const [actionsVisible, setActionsVisible] = useState(false);
  const hasDiff = !!conversation?.git_branch && diffShown;
  const handleMoreActions = useCallback(() => {
    Keyboard.dismiss();
    // git_diff lives off the conversation doc and is fetched lazily; asking
    // for it now has it ready by the time View Diff is tapped (the panel
    // stays empty if there turns out to be no diff).
    if (hasDiff) setDiffWanted(true);
    setActionsVisible(true);
  }, [hasDiff]);
  const isRealConversation = !!conversation && isConvexId(conversation._id);
  const actionTiles: SessionTile[] = [
    ...(allSessionImages.length > 0 ? [{ key: 'images', label: 'Images', icon: 'image' as const, count: allSessionImages.length, onPress: () => { setGalleryIndex(Math.max(0, allSessionImages.length - 1)); setGalleryVisible(true); } }] : []),
    { key: 'search', label: 'Search', icon: 'search', onPress: () => setSearchVisible(v => !v) },
    { key: 'share', label: 'Share', icon: 'share', onPress: handleShareConversation },
    { key: 'copy', label: 'Copy', icon: 'copy', onPress: handleCopyMenu },
    ...(huddle.enabled && (huddle.inRoom > 0 || !huddle.pressDisabled)
      ? [{ key: 'huddle', label: huddle.inRoom > 0 ? 'Join' : 'Huddle', icon: 'headphones' as const, count: huddle.inRoom || undefined, live: huddle.inRoom > 0, onPress: huddle.press }]
      : []),
  ];
  const actionGroups: SessionRow[][] = [
    [
      { key: 'rename', label: 'Rename', icon: 'edit-3', onPress: () => setRenameVisible(true) },
      { key: 'favorite', label: 'Favorite', icon: 'star', on: !!conversation?.is_favorite, onPress: handleToggleFavorite },
      ...(moveVerbs.includes('switch') ? [{ key: 'switch', label: 'Switch agent', icon: 'repeat' as const, value: conversation ? agentDisplayName(conversation.agent_type) : undefined, onPress: () => pickAgentFor('switch') }] : []),
      ...(moveVerbs.includes('fork') && isRealConversation ? [{ key: 'fork', label: 'Fork as…', icon: 'git-branch' as const, onPress: () => pickAgentFor('fork') }] : []),
    ],
    [
      ...(hasDiff ? [{ key: 'diff', label: diffExpanded ? 'Hide diff' : 'View diff', icon: 'git-commit' as const, onPress: () => setDiffExpanded(d => !d) }] : []),
      ...(boardHref ? [{ key: 'board', label: 'Open board', icon: 'layout' as const, onPress: () => router.push(boardHref as never) }] : []),
      ...(hasForkFamily ? [{ key: 'tree', label: 'Fork tree', icon: 'git-merge' as const, onPress: () => setTreeModalVisible(true) }] : []),
      // Folding every message to a line is a way to skim a long agent run; a
      // hosted conversation is short prose with nothing to fold.
      ...(internals ? [{ key: 'collapse', label: 'Collapse messages', icon: 'minimize-2' as const, on: collapsed, onPress: () => setCollapsed(c => !c) }] : []),
    ],
    [
      ...(isRealConversation && internals ? [{ key: 'restart', label: isRestarting ? 'Restarting…' : 'Restart session', icon: 'rotate-cw' as const, onPress: () => { if (!isRestarting) restartSession(); } }] : []),
      ...(conversation?.session_id && internals ? [{ key: 'resume', label: 'Copy resume command', icon: 'terminal' as const, onPress: handleCopyResume }] : []),
    ],
    // The inbox row's own action under the inbox row's own name. Setting a
    // conversation aside is undone from the list, so in hosted words it is
    // not drawn as a delete.
    [hosted
      ? { key: 'dismiss', label: words.stash, icon: 'archive', onPress: handleDismiss }
      : { key: 'dismiss', label: 'Dismiss', icon: 'x-circle', destructive: true, onPress: handleDismiss }],
  ];

  const handleConfirmShareSelection = useCallback(async () => {
    if (selectedMessageIds.size === 0) return;
    const selected = allMessages
      .filter(m => selectedMessageIds.has(m._id))
      .sort((a, b) => a.timestamp - b.timestamp);
    const text = selected.map(m => {
      const ts = new Date(m.timestamp).toLocaleString();
      const label = m.role === 'user' ? 'User' : 'Assistant';
      return `[${ts}] ${label}:\n${m.content || ''}`;
    }).join('\n\n');
    Clipboard.setString(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    showToast(`${selected.length} message${selected.length > 1 ? 's' : ''} copied`);
    setShareSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, [selectedMessageIds, allMessages, showToast]);

  const handleFloatingHeaderLayout = useCallback((height: number) => {
    setFloatingHeaderHeight(prev => (Math.abs(prev - height) < 1 ? prev : height));
    const maxOffset = height;
    floatingHeaderOffsetRef.current = Math.max(0, Math.min(floatingHeaderOffsetRef.current, maxOffset));
    floatingHeaderY.setValue(-floatingHeaderOffsetRef.current);
    floatingHeaderOpacity.setValue(floatingHeaderOffsetRef.current > 0 ? 0 : 1);
  }, [floatingHeaderY, floatingHeaderOpacity]);

  useEffect(() => {
    if (!conversation || allMessages.length === 0) return;
    if (openedAtLastMessageTsRef.current === null) {
      openedAtLastMessageTsRef.current = allMessages[allMessages.length - 1]?.timestamp ?? Date.now();
    }
    if (prevMessageIdsRef.current.size === 0) {
      prevMessageIdsRef.current = new Set(allMessages.map((message) => message._id));
    }
  }, [conversation?._id, allMessages]);

  useEffect(() => {
    setInitialScrollDone(false);
    didInitialScrollRef.current = false;
    if (initialScrollDebounceRef.current) {
      clearTimeout(initialScrollDebounceRef.current);
      initialScrollDebounceRef.current = null;
    }
    setUserScrolled(false);
    prevMessageIdsRef.current = new Set();
    openedAtLastMessageTsRef.current = null;
    lastScrollYRef.current = 0;
    setNavSheetVisible(false);
    stickyActiveRef.current = null;
    // The old conversation's viewability snapshot must not resolve against
    // the new one's list when the array-identity effect re-runs.
    lastViewableItemsRef.current = [];
    setStickyActive(null);
    setStickyBannerHeight(0);
    dismissedStickyIdsRef.current = new Set();
    setDismissedStickyVersion(v => v + 1);
    floatingHeaderOffsetRef.current = 0;
    floatingHeaderY.setValue(0);
    floatingHeaderOpacity.setValue(1);
    // Reset per SESSION only. floatingHeaderHeight changes at runtime (search
    // toggle, meta-row wrap); including it here re-ran this whole reset mid-session,
    // clobbering userScrolled and prevMessageIdsRef. floatingHeaderY is a stable
    // ref-held Animated.Value. handleFloatingHeaderLayout clamps the offset on
    // height change independently.
  }, [id]);

  useEffect(() => {
    return () => {
      if (initialScrollDebounceRef.current) {
        clearTimeout(initialScrollDebounceRef.current);
        initialScrollDebounceRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!searchVisible) return;
    floatingHeaderOffsetRef.current = 0;
    floatingHeaderY.setValue(0);
    floatingHeaderOpacity.setValue(1);
  }, [searchVisible, floatingHeaderY, floatingHeaderOpacity]);

  // With inverted FlatList, newest messages are at offset 0 (bottom) automatically.
  // Just mark initial scroll done once we have data.
  useEffect(() => {
    if (initialScrollDone || !conversation || allMessages.length === 0) return;
    setInitialScrollDone(true);
  }, [conversation?._id, allMessages.length > 0, initialScrollDone]);

  // Auto-scroll when new messages arrive (if near bottom)
  useEffect(() => {
    const prevIds = prevMessageIdsRef.current;
    const addedMessages = allMessages.filter((message) => !prevIds.has(message._id));
    prevMessageIdsRef.current = new Set(allMessages.map((message) => message._id));

    if (!initialScrollDone || addedMessages.length === 0) {
      return;
    }

    const openBoundaryTs = openedAtLastMessageTsRef.current ?? 0;
    const incomingMessages = addedMessages.filter(
      (message) => message.timestamp > openBoundaryTs && message.role !== 'system'
    );

    if (incomingMessages.length === 0) {
      return;
    }

    if (isNearBottomRef.current && allMessages.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToOffset({ offset: 0, animated: false }), 16);
      setUserScrolled(false);
      setNewMessageCount(0);
    } else if (!isNearBottomRef.current) {
      setNewMessageCount((prev) => prev + incomingMessages.length);
    }
  }, [allMessages, initialScrollDone]);

  // Older-message pagination is driven by the shared hook: loadOlder grows the
  // store's message window (usePaginatedQuery.loadMore) and the rendered list
  // re-derives from conversation.messages. The cooldown debounces scroll-driven
  // triggers so we don't fire loadOlder on every onScroll frame near the top.
  const handleLoadOlder = useCallback(() => {
    if (loadingOlder) return;
    loadOlderMessages();
    loadCooldownRef.current = true;
    setTimeout(() => { loadCooldownRef.current = false; }, 500);
  }, [loadingOlder, loadOlderMessages]);

  const handleJumpToEnd = useCallback(() => {
    if (!id || jumpingToEnd) return;
    setJumpingToEnd(true);
    try {
      hookJumpToEnd();
      setTimeout(() => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
        setUserScrolled(false);
        setNewMessageCount(0);
      }, 80);
    } catch {
      showToast('Failed to jump to end');
    } finally {
      setTimeout(() => setJumpingToEnd(false), 120);
    }
  }, [id, jumpingToEnd, hookJumpToEnd, showToast]);

  const handleJumpToStart = useCallback(() => {
    if (!id || jumpingToStart) return;

    if (!hasMoreAbove) {
      flatListRef.current?.scrollToEnd({ animated: true });
      return;
    }

    setJumpingToStart(true);
    try {
      // Hook loads the window at the very start of the conversation (target
      // mode); allMessages re-derives from it. Scroll to the oldest once it
      // lands — the hook's isLoadingOlder gates the spinner meanwhile.
      hookJumpToStart();
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 400);
    } catch {
      showToast('Failed to jump to start');
    } finally {
      setTimeout(() => setJumpingToStart(false), 400);
    }
  }, [id, jumpingToStart, hasMoreAbove, hookJumpToStart, showToast]);

  const handleScroll = useCallback((event: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const offset = Math.max(0, contentOffset.y);
    const scrollHeight = contentSize.height;
    const clientHeight = layoutMeasurement.height;
    const deltaY = offset - lastScrollYRef.current;
    lastScrollYRef.current = offset;

    // Inverted FlatList: offset near 0 = bottom (newest), large offset = top (oldest)
    const isNearBottom = offset < 200;
    isNearBottomRef.current = isNearBottom;

    const distanceFromTop = scrollHeight - offset - clientHeight;
    setIsNearTop(distanceFromTop < 96);
    setHasAbove(distanceFromTop > 4);

    const progress = scrollHeight > clientHeight ? 1 - (offset / (scrollHeight - clientHeight)) : 0;
    scrollProgressAnim.setValue(progress);

    if (offset > 400 && !userScrolled) {
      setUserScrolled(true);
    } else if (isNearBottom && userScrolled) {
      setUserScrolled(false);
      setNewMessageCount(0);
    }

    // Metadata strip collapse (the pinned title bar above it always stays put).
    // Position-based with hysteresis: once the user scrolls up into history the
    // strip slides away under the title bar, giving messages the full height;
    // it returns when they settle back at the newest message. The 40/96 band
    // keeps it from flickering on tiny scrolls. (Inverted list: offset 0 = newest.)
    const maxOffset = floatingHeaderHeight;
    const wantCollapsed = !searchVisible && offset > 96;
    const wantExpanded = searchVisible || offset <= 40;
    if (wantExpanded && floatingHeaderOffsetRef.current !== 0) {
      floatingHeaderOffsetRef.current = 0;
      Animated.parallel([
        Animated.timing(floatingHeaderY, { toValue: 0, duration: 160, useNativeDriver: true }),
        Animated.timing(floatingHeaderOpacity, { toValue: 1, duration: 160, useNativeDriver: true }),
      ]).start();
    } else if (wantCollapsed && floatingHeaderOffsetRef.current !== maxOffset) {
      floatingHeaderOffsetRef.current = maxOffset;
      Animated.parallel([
        Animated.timing(floatingHeaderY, { toValue: -maxOffset, duration: 160, useNativeDriver: true }),
        Animated.timing(floatingHeaderOpacity, { toValue: 0, duration: 160, useNativeDriver: true }),
      ]).start();
    }

    // Load older messages when near the top (large offset in inverted list).
    // Require userScrolled (web's shouldLoadOlder contract): without it, a short
    // first page whose bottom is also within the trigger band rips through every
    // page with no user input.
    if (distanceFromTop < 100 && userScrolled && hasMoreAbove && !loadingOlder && !loadCooldownRef.current && initialScrollDone) {
      handleLoadOlder();
    }
  }, [hasMoreAbove, loadingOlder, handleLoadOlder, initialScrollDone, floatingHeaderHeight, floatingHeaderY, searchVisible, userScrolled]);

  if (conversation === undefined) {
    return (
      <RNView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <SessionHeaderBar inFlow>
          <RNText style={styles.headerTitleText} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>Conversation</RNText>
        </SessionHeaderBar>
        <ConversationSkeleton />
      </RNView>
    );
  }

  if (!conversation) {
    return (
      <RNView style={styles.errorContainer}>
        {/* The one state with no title bar of its own: the nav header's back. */}
        <Stack.Screen options={{ headerShown: true }} />
        <RNText style={styles.errorText}>Conversation not found</RNText>
      </RNView>
    );
  }

  // One transcript row, as the list draws it; null for rows that never show.
  const renderRow = (item: Message, index: number): ReactNode => {
    item = displayMessage(item);
    // In inverted list, index 0 = newest. Convert to original order for prev-message logic.
    const originalIndex = invertedMessages.length - 1 - index;
    let prevNonToolResult: Message | null = null;
    for (let i = originalIndex - 1; i >= 0; i--) {
      const prev = allMessages[i];
      if (isToolResultCarrier(prev)) continue;
      if (prev.role === 'user' && prev.content && (isCommandMessage(prev.content) || isPollResponsePayload(prev.content))) continue;
      prevNonToolResult = prev;
      break;
    }
    const showHeader = !prevNonToolResult || prevNonToolResult.role !== item.role;

    // Hide standalone tool result messages (they're shown inline with tool calls)
    if (isToolResultCarrier(item)) {
      return null;
    }
    if (retryFold?.hidden.has(item._id)) return null;

    // A hosted turn's stop notice: one calm block with its move, and
    // only the last row's notice offers one (components/hosted/Notice).
    const notice = hosted && item.role === 'assistant' ? hostedNoticeKind(item) : null;
    if (notice) {
      return (
        <HostedNoticeRow
          kind={notice}
          content={item.content || ''}
          conversationId={String(conversation._id)}
          retryText={lastAskOf(allMessages.slice(0, originalIndex))}
          live={originalIndex === allMessages.length - 1}
          retries={(retryFold?.attempts.get(item._id) ?? 1) - 1}
        />
      );
    }

    // An approval's answer in a hosted conversation: a quiet note
    // where the card was, not a message bubble, and nothing when the
    // step already says it (lane.ts answerNote). A failed one stays
    // a bubble below, which says it failed.
    if (hosted && item.role === 'user' && !item._isFailed) {
      const answer = parseDecisionAnswer(item.content)?.answer;
      const note = answerNote(answer);
      if (answer && !note) return null;
      if (note) {
        return (
          <RNView style={{ alignSelf: 'center', marginVertical: 6, paddingVertical: 4, paddingHorizontal: 12, borderRadius: 999, backgroundColor: Theme.bgHighlight }}>
            <RNText style={{ fontSize: 12, color: Theme.textMuted }}>{note}</RNText>
          </RNView>
        );
      }
    }

    // What a user-role row is comes from web's classifier, read with its
    // neighbours (lib/userRowKinds), so both apps sort rows the same way.
    const kind = item.role === 'user' ? userRowKinds.kinds.get(item._id) : undefined;
    if (kind && userRowKinds.expansions.consumed.has(item._id)) return null;
    const divider = (label: string) => (
      <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 16, paddingHorizontal: 16 }}>
        <RNView style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: Theme.border }} />
        <RNText style={{ fontSize: 11, color: Theme.textDim }}>{label}</RNText>
        <RNView style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: Theme.border }} />
      </RNView>
    );
    switch (kind?.kind) {
      case 'tool_results_only':
      case 'compaction_prompt':
      case 'noise':
      case 'empty':
      case 'poll_response':
      case 'task_prompt':
        return null;
      case 'session_handoff':
        return <SessionHandoffCard handoff={kind.handoff} timestamp={item.timestamp} />;
      case 'context_recovery':
        return <FoldedPromptRow icon="refresh-cw" label="Context recovered" detail="continued in a fresh context" body={kind.recovery.body} timestamp={item.timestamp} />;
      case 'command': {
        const { cmdName, args } = parseCommandInvocation(item.content || '');
        const expansion = userRowKinds.expansions.byCommand.get(item._id);
        return <FoldedPromptRow icon="command" label={cmdName ? `/${cmdName}` : 'command'} detail={args} body={expansion ? cleanCommandExpansion(expansion) : undefined} timestamp={item.timestamp} />;
      }
      case 'skill_expansion':
        return <FoldedPromptRow icon="book-open" label={kind.cmdName ? `/${kind.cmdName}` : 'Skill'} detail="prompt" body={cleanCommandExpansion(item.content || '')} timestamp={item.timestamp} />;
      case 'workflow_frame':
        // Web draws the same two frames: the launching session's ask folded,
        // the agent's computed task as a brief card from the workflow.
        if (kind.frame === 'user request') return <FoldedPromptRow icon="corner-down-right" label="Request" detail={kind.body.split('\n')[0]} body={kind.body} timestamp={item.timestamp} />;
        return <WorkflowTaskBlock body={kind.body} timestamp={item.timestamp} />;
      case 'role_brief': {
        const brief = stripSystemTags(item.content || '').trim();
        return <FoldedPromptRow icon="user-check" label="Role brief" detail={brief.split('\n')[0].replace(/\*\*/g, '')} body={brief} timestamp={item.timestamp} />;
      }
      case 'bash_input': {
        const paired = userRowKinds.expansions.bashByInput.get(item._id);
        return <BashModeBlock command={kind.command} stdout={paired?.stdout} stderr={paired?.stderr} timestamp={item.timestamp} />;
      }
      case 'bash_output':
        return <BashModeBlock stdout={kind.stdout} stderr={kind.stderr} timestamp={item.timestamp} />;
      case 'interrupt':
        // A hosted conversation's stop is told by its own notice, so only
        // an aborted turn earns a line there.
        if (hosted) return kind.tone === 'amber' ? <InterruptStatusLine label="You stopped this" /> : null;
        return <InterruptStatusLine label={kind.tone === 'amber' ? 'turn aborted' : undefined} tone={kind.tone} />;
      case 'background_agent_stopped':
        return <InterruptStatusLine label={kind.agentName ? `background agent "${kind.agentName}" stopped` : 'background agent stopped'} tone="amber" />;
      case 'continuation':
        return <InterruptStatusLine label="session continued" tone="sky" />;
      case 'agent_switch':
        return divider(`now using ${kind.toLabel}`);
      case 'machine_move':
        return divider(!kind.machineChanged ? 'moved to another directory' : kind.destination ? `now running on ${kind.destination}` : 'machine switched');
      case 'session_escalation': {
        const esc = kind.escalation;
        const inChild = (conversation?.short_id ?? String(id).slice(0, 7)) === esc.session.short_id;
        const caption = sessionEscalationCaption(esc, { inChild });
        return (
          <RNView style={{ paddingVertical: 12, paddingHorizontal: 16 }} testID={`escalation-${esc.move}`}>
            <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <RNView style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: Theme.border }} />
              <RoleFace role={esc.role} size={16} />
              <RNText style={{ fontSize: 11, color: Theme.textDim }} numberOfLines={2}>{caption} · {formatRelativeTime(item.timestamp)}</RNText>
              <RNView style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: Theme.border }} />
            </RNView>
            {!!esc.line && (
              <RNView style={{ marginTop: 8, borderWidth: 1, borderColor: Theme.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 }}>
                <MarkdownContent text={esc.line} baseStyle={styles.teammateContent} isUser={false} />
              </RNView>
            )}
          </RNView>
        );
      }
      case 'session_message':
        return <SessionMessageBlock variant={kind.variant} from={kind.from} name={kind.name} body={kind.body} timestamp={item.timestamp} />;
      case 'huddle_summary':
        return <SessionMessageBlock from="unknown" name={`Huddle — ${kind.huddle.title}`} body={kind.huddle.body} timestamp={item.timestamp} />;
      case 'chat_wake':
        return <ChatWakeBlock wake={kind.wake} timestamp={item.timestamp} />;
      case 'vault_ready':
        return <VaultReadyLine vault={kind.vault} timestamp={item.timestamp} />;
      case 'scheduled_task':
        return <ScheduledTaskBlock content={item.content || ''} timestamp={item.timestamp} />;
      case 'task_notification':
        return <TaskNotificationLine content={item.content || ''} timestamp={item.timestamp} childConversationMap={conversation.child_conversation_map} />;
      case 'compaction_summary':
        return <CompactionSummaryBlock content={item.content || ''} />;
      case 'plan':
        return <PlanBlock content={kind.planContent} timestamp={item.timestamp} />;
    }

    // A person's direct send (<user-message from="Name">) is that person's
    // own bubble: the body unwrapped and the sender named. A joint turn names
    // each author over their words; a decision answer quotes its question.
    const joint = kind?.kind === 'direct_user' ? parseJointMessage(item.content) : null;
    const bubbleBody = kind?.kind === 'direct_user'
      ? (joint ? joint.map((p) => `**${p.from}:** ${p.body}`).join('\n\n') : kind.body)
      : kind?.kind === 'decision_answer' ? (kind.decision.question ? `> ${kind.decision.question}\n\n` : '') + kind.decision.answer : null;
    const sender = kind?.kind === 'direct_user' ? kind.from : undefined;
    const isSearchDimmed = searchMatchIds && !searchMatchIds.has(item._id);
    const isCurrentSearchMatch = searchMatchList.length > 0 && searchMatchList[currentMatchIndex] === item._id;
    const isHighlighted = highlightedMessageId === item._id;
    // Local-first: an optimistic bubble is the message. Web only labels
    // queued/stuck after a grace; a "Sending" chip made a landed send
    // look like it was still waiting. Queued (agent busy/offline) and
    // failed stay labeled because those are the states that need a verb.
    const isQueued = !!item._isQueued;
    const isFailed = item._isFailed;
    const isPending = item._isOptimistic || isQueued;
    const run = toolRuns.get(item._id);
    return (
      <RNView style={[
        isSearchDimmed ? { opacity: 0.25 } : undefined,
        (isCurrentSearchMatch || isHighlighted) && styles.searchHighlight,
        shareSelectionMode && { paddingLeft: 28 },
        isFailed ? { opacity: 0.55 } : isPending ? { opacity: 0.8 } : undefined,
      ]}>
        {shareSelectionMode && (
          <Pressable
            onPress={() => handleToggleMessageSelection(item._id)}
            style={styles.selectionCheckbox}
          >
            <FontAwesome
              name={selectedMessageIds.has(item._id) ? "check-square" : "square-o"}
              size={16}
              color={selectedMessageIds.has(item._id) ? Theme.cyan : Theme.textDim}
            />
          </Pressable>
        )}
        <MemoMessageBubble
          message={bubbleBody != null ? directMessage(item, bubbleBody) : item}
          agentType={conversation.agent_type}
          model={conversation.model}
          showHeader={showHeader}
          forkChildren={item.message_uuid ? forkPointMap[item.message_uuid] : undefined}
          conversationId={conversation._id}
          onFork={agentSupportsFork(conversation.agent_type) ? handleForkFromMessage : undefined}
          taskSubjectMap={taskSubjectMap}
          globalToolResultMap={globalToolResultMap}
          globalImageMap={globalImageMap}
          openGallery={openGallery}
          userName={sender || conversation.user?.name || conversation.user?.email?.split('@')[0]}
          sender={sender}
          showToast={showToast}
          collapsed={collapsed}
          childConversationMap={childConversationMap}
          bookmarkedSet={bookmarkedSet}
          toolRun={run ? { run, expanded: openRuns.has(run.head) || (!!highlightedMessageId && run.members.includes(highlightedMessageId)), justOpened: Date.now() - (runOpenedAt.current.get(run.head) ?? 0) < RUN_FADE_WINDOW_MS, onToggle: () => toggleRun(run.head) } : undefined}
      />
        {hosted && item.role === 'assistant' && originalIndex === allMessages.length - 1 ? (
          <RNView style={{ paddingHorizontal: 16 }}>
            <ReplyChips
              conversationId={String(conversation._id)}
              reply={item.content}
              asked={lastAskOf(allMessages.slice(0, originalIndex))}
              personTurns={retryFold?.personTurns ?? 0}
              working={hostedTurnRunning}
            />
          </RNView>
        ) : null}
        {isQueued && (
          <RNView style={styles.pendingStatusRow}>
            <RNText style={styles.pendingStatusText}>{hosted && linkDown ? hostedConnectionWords(linkDown, true) : 'Queued'}</RNText>
          </RNView>
        )}
        {isFailed && (
          <RNView style={styles.pendingStatusRow}>
            <FontAwesome name="exclamation-circle" size={11} color={Theme.red} />
            <RNText style={[styles.pendingStatusText, { color: Theme.red }]}>
              Failed to send
            </RNText>
            {item._clientId ? (
              <Pressable onPress={() => retryFailedSend(item._clientId!, item.content ?? '')} hitSlop={8} accessibilityRole="button">
                <RNText style={[styles.pendingStatusText, { color: hosted ? Theme.text : Theme.cyan, fontWeight: '600' }]}>Try again</RNText>
              </Pressable>
            ) : null}
          </RNView>
        )}
      </RNView>
    );
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        // iOS: KAV 'padding' (resets cleanly via keyboardWillHide). Android:
        // edge-to-edge does not resize the window for the IME, but KAV's own
        // Android path leaves phantom padding after every dismissal (see
        // useAndroidImeInset) — so the behavior is disabled there and the
        // event-driven inset pads the container instead. 'height' is no
        // better: it re-derives the container height from a cached initial
        // frame on every layout and oscillated by about a row while the list
        // re-laid out during streaming.
        style={[styles.container, Platform.OS === 'android' && androidImeInset > 0 ? { paddingBottom: androidImeInset } : null]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Compact custom title bar — back + title + actions in one slim band,
            replacing the tall native nav bar so the top is minimal. It stays
            pinned while the metadata strip below it collapses on scroll. */}
        <SessionHeaderBar>
          <MobileIdentityFace
            row={identityRow}
            size={22}
            style={styles.headerFace}
            badge={conversation.agent_type ? <AgentLogoSvg agentType={conversation.agent_type} size={10} /> : undefined}
          />
          {/* Tap the title bar to go to the top of the conversation, as on
              any iOS nav bar (the status bar's tap lands on the newest
              message in this inverted list). Hold to rename; More has it too. */}
          <Pressable
            style={styles.headerTitlePress}
            onPress={handleJumpToStart}
            onLongPress={() => setRenameVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="Go to top"
            accessibilityHint="Hold to rename"
          >
            <MobileSessionIdentityLine
              row={identityRow}
              title={title}
              style={[styles.headerTitleText, styles.headerTitleInPress]}
              maxFontSizeMultiplier={CHROME_FONT_CAP}
            />
          </Pressable>
          {/* The prompt list, More, and the compose pencil that starts the
              next session from here. Huddle, images and the board live in
              More, where a live huddle is listed first. */}
          {navigatorRows.length > 0 && (
            <MessageListButton count={promptCount} onPress={openNavigatorSheet} />
          )}
          <TouchableOpacity onPress={handleMoreActions} style={styles.headerIconBtn} hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }} activeOpacity={0.6} accessibilityLabel="More actions">
            <Feather name="more-horizontal" size={18} color={Theme.textMuted} />
            {huddle.enabled && huddle.inRoom > 0 && <RNView style={styles.moreLiveDot} />}
          </TouchableOpacity>
          <ComposeButton size={18} />
        </SessionHeaderBar>
        {/* A hosted conversation in hosted mode is named by its title alone,
            as on the web: the strip would only repeat "Codecast assistant"
            and a time, so it folds to nothing (its layout reports 0 and the
            list starts under the title bar). */}
        <Animated.View
          style={[styles.floatingSessionHeader, { top: insets.top + HEADER_BAR_HEIGHT, opacity: floatingHeaderOpacity, transform: [{ translateY: floatingHeaderY }] }, hosted && !internalsShown && styles.foldedStrip]}
          onLayout={(event) => handleFloatingHeaderLayout(event.nativeEvent.layout.height)}
        >
            <RNView style={styles.floatingSessionCard}>
            <RNView style={styles.metaRow}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.sessionMeta}
              >
                {/* Every chip wears one quiet shell; only its icon carries color. */}
                {conversation.agent_type && (
                  <RNView style={styles.metaChip}>
                    <AgentLogoSvg agentType={conversation.agent_type} size={11} />
                    <RNText style={styles.metaChipText} maxFontSizeMultiplier={CHROME_FONT_CAP}>
                      {formatAgentType(conversation.agent_type)}
                    </RNText>
                  </RNView>
                )}
                {modelPicker && !hosted ? (
                  <ModelSwitcherChip
                    conversationId={conversation._id}
                    sessionId={conversation.session_id}
                    agentType={conversation.agent_type}
                    model={conversation.model}
                    effort={conversation.effort}
                    messageCount={conversation.message_count}
                    canEdit={!!conversation.is_own}
                    showToast={showToast}
                  />
                ) : null}
                {gitChips && conversation.git_branch && (
                  <Pressable
                    onPress={() => {
                      if (conversation.git_remote_url) {
                        const match = conversation.git_remote_url.match(/github\.com[:/](.+?)(?:\.git)?$/);
                        if (match) {
                          void openLink(`https://github.com/${match[1]}/tree/${conversation.git_branch}`);
                        }
                      }
                    }}
                    style={styles.metaChip}
                  >
                    <FontAwesome name="code-fork" size={10} color={Theme.green} />
                    <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.metaChipText} numberOfLines={1}>{conversation.git_branch}</RNText>
                  </Pressable>
                )}
                {chipsExpanded ? (
                  <>
                    {(conversation.fork_count ?? 0) > 0 && (
                      <Pressable onPress={() => setTreeModalVisible(true)} style={styles.metaChip}>
                        <FontAwesome name="code-fork" size={10} color={Theme.violet} />
                        <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.metaChipText}>{conversation.fork_count}</RNText>
                      </Pressable>
                    )}
                    {!hosted && (
                      <AssignmentChip
                        conversationId={isConvexId(conversation._id) ? conversation._id : null}
                        ownerDeviceId={(conversation as any).owner_device_id}
                        showToast={showToast}
                      />
                    )}
                    {latestUsage && internals && (
                      <RNView style={styles.metaChip}>
                        <FontAwesome name="bar-chart" size={10} color={Theme.textDim} />
                        <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.metaChipText}>
                          {Math.round((latestUsage.contextSize / 200000) * 100)}%
                        </RNText>
                      </RNView>
                    )}
                    {conversation.parent_conversation_id && (
                      <Pressable
                        onPress={() => router.push(`/session/${conversation.parent_conversation_id}`)}
                        style={styles.metaChip}
                      >
                        <FontAwesome name="level-up" size={10} color={Theme.violet} />
                        <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.metaChipText}>Parent</RNText>
                      </Pressable>
                    )}
                    {conversation.forked_from_details && (
                      <Pressable
                        onPress={() => {
                          const details = conversation.forked_from_details!;
                          if (details.share_token) {
                            void openLink(conversationShareLink(details.share_token));
                          } else {
                            router.push(`/session/${details.conversation_id}`);
                          }
                        }}
                        style={styles.metaChip}
                      >
                        <FontAwesome name="code-fork" size={10} color={Theme.cyan} />
                        <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.metaChipText}>@{conversation.forked_from_details.username}</RNText>
                      </Pressable>
                    )}
                  </>
                ) : extraChipCount > 0 && (
                  <Pressable
                    onPress={() => setChipsExpanded(true)}
                    style={styles.metaChip}
                    accessibilityLabel={`Show ${extraChipCount} more details`}
                  >
                    <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.metaChipText}>+{extraChipCount}</RNText>
                  </Pressable>
                )}
              </ScrollView>
            </RNView>
            {searchVisible && (
              <RNView style={[styles.searchBar, styles.floatingSearchBar]}>
                <FontAwesome name="search" size={12} color={Theme.textDim} style={{ marginRight: 8 }} />
                <TextInput
                  style={styles.searchInput}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Search messages..."
                  placeholderTextColor={Theme.textMuted0}
                  returnKeyType="search"
                />
                {searchQuery.length > 0 && (
                  <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    {searchMatchList.length > 0 ? (
                      <>
                        <RNText style={styles.searchCount}>{currentMatchIndex + 1}/{searchMatchList.length}</RNText>
                        <TouchableOpacity onPress={goToPrevMatch} style={{ padding: 4 }} activeOpacity={0.7}>
                          <FontAwesome name="chevron-up" size={10} color={Theme.textDim} />
                        </TouchableOpacity>
                        <TouchableOpacity onPress={goToNextMatch} style={{ padding: 4 }} activeOpacity={0.7}>
                          <FontAwesome name="chevron-down" size={10} color={Theme.textDim} />
                        </TouchableOpacity>
                      </>
                    ) : (
                      <RNText style={styles.searchCount}>0 matches</RNText>
                    )}
                    <TouchableOpacity onPress={() => setSearchQuery('')} activeOpacity={0.7} style={{ padding: 4 }}>
                      <FontAwesome name="times-circle" size={14} color={Theme.textDim} />
                    </TouchableOpacity>
                  </RNView>
                )}
              </RNView>
            )}
            {diffShown && diffExpanded && (gitDiffData?.git_diff?.trim() || gitDiffData?.git_diff_staged?.trim()) && (
              <ScrollView style={[styles.gitDiffPanel, { marginTop: 6, marginBottom: 2 }]} nestedScrollEnabled>
                {gitDiffData.git_diff_staged && gitDiffData.git_diff_staged.trim().length > 0 && (
                  <RNView style={{ marginBottom: 8 }}>
                    <RNText style={{ fontSize: 10, color: Theme.green, fontWeight: '600', marginBottom: 4, paddingHorizontal: 12 }}>Staged</RNText>
                    <RNView style={styles.gitDiffContent}>
                      <GitDiffView diff={gitDiffData.git_diff_staged} />
                    </RNView>
                  </RNView>
                )}
                {gitDiffData.git_diff && gitDiffData.git_diff.trim().length > 0 && (
                  <RNView>
                    {gitDiffData.git_diff_staged && gitDiffData.git_diff_staged.trim().length > 0 && (
                      <RNText style={{ fontSize: 10, color: Theme.orange, fontWeight: '600', marginBottom: 4, paddingHorizontal: 12 }}>Unstaged</RNText>
                    )}
                    <RNView style={styles.gitDiffContent}>
                      <GitDiffView diff={gitDiffData.git_diff} />
                    </RNView>
                  </RNView>
                )}
              </ScrollView>
            )}
          </RNView>
        </Animated.View>
        {/* Unacked handoff strip — an absolute overlay pinned just below the
            floating metadata strip (both headers are absolute, so in-flow
            content would render UNDER them). Same anchor as the message nav
            pill; box-none so the empty width doesn't eat list scrolls. */}
        {/* Sticky prompt pill at the overlay anchor; the handoff strip below
            stacks under it (its top grows by the pill's reported height). */}
        <StickyPromptBanner
          prompt={stickyPrompt}
          top={insets.top + HEADER_BAR_HEIGHT + floatingHeaderHeight}
          translateY={floatingHeaderY}
          onJump={jumpToMessage}
          onDismiss={dismissSticky}
          onHeight={setStickyBannerHeight}
        />
        <Animated.View
          pointerEvents="box-none"
          style={{ position: 'absolute', top: insets.top + HEADER_BAR_HEIGHT + floatingHeaderHeight, left: 0, right: 0, zIndex: 55, transform: [{ translateY: stickyOffsetY }] }}
        >
          <AssignedToYouBanner conversationId={isConvexId(conversation._id) ? conversation._id : null} />
        </Animated.View>
        {/* The wrap carries the far jump dim (listOpacity): the overlays and
            the tick rail stay at full opacity while the stale frame fades. */}
        <Animated.View style={{ flex: 1, opacity: listOpacity }}>
        <Reanimated.FlatList
          ref={flatListRef}
          itemLayoutAnimation={ROW_LAYOUT}
          style={{ flex: 1 }}
          data={invertedMessages}
          inverted={true}
          removeClippedSubviews={false}
          // The first frame holds a screenful of bubbles (each one parses
          // and lays out markdown); later batches keep five screens ready on
          // either side, which a fling does not outrun.
          windowSize={11}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          updateCellsBatchingPeriod={50}
          onLayout={(e) => {
            flatListLayoutHeightRef.current = e.nativeEvent.layout.height;
          }}
          onContentSizeChange={(_w, h) => {
            lastContentHeightRef.current = h;
            setHasAbove(h - lastScrollYRef.current - flatListLayoutHeightRef.current > 4);
          }}
          // The list is inverted, so its header is the foot of the transcript:
          // what a hosted conversation waits on the person for.
          ListHeaderComponent={hostedApprovals.length > 0 || settledAnswer || cardPending ? (
            <RNView style={{ gap: 12, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}>
              {hostedApprovals.map((d, n) => <ApprovalCard key={d._id} decision={d} index={n} />)}
              {settledAnswer ? <ApprovalSettled label={settledAnswer} /> : cardPending ? <ApprovalPending /> : null}
            </RNView>
          ) : null}
          ListFooterComponent={
            <>
              {/* Header clearance grows by the sticky pill's height so the
                  topmost content is not hidden under it. */}
              <RNView style={{ height: insets.top + HEADER_BAR_HEIGHT + floatingHeaderHeight + stickyBannerHeight }} />
              {hasMoreAbove && allMessages.length > 0 && (
                <RNView style={styles.loadMoreIndicator}>
                  {loadingOlder ? (
                    <RNView style={styles.loadMorePill}>
                      <ActivityIndicator size="small" color={Theme.textMuted} />
                      <RNText style={styles.loadMorePillText}>Loading older messages...</RNText>
                    </RNView>
                  ) : (
                    <Pressable onPress={handleLoadOlder} style={styles.loadMorePill}>
                      <FontAwesome name="chevron-up" size={10} color={Theme.textMuted0} />
                      <RNText style={styles.loadMorePillText}>
                        {conversation.message_count && allMessages.length < conversation.message_count
                          ? `${conversation.message_count - allMessages.length} earlier messages`
                          : 'Load older messages'}
                      </RNText>
                    </Pressable>
                  )}
                </RNView>
              )}
              {conversation.parent_conversation_id && !hasMoreAbove && (
                <Pressable
                  onPress={() => router.push(`/session/${conversation.parent_conversation_id}`)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 8 }}
                >
                  <FontAwesome name="level-up" size={10} color={Theme.cyan} style={{ opacity: 0.7 }} />
                  <RNText style={{ fontSize: 11, color: Theme.cyan, opacity: 0.7 }}>Spawned from parent session</RNText>
                </Pressable>
              )}
              {pendingPermissions && pendingPermissions.length > 0 ? (
                <RNView style={styles.permissionsContainer}>
                  {pendingPermissions.map((permission) => (
                    <PermissionCard key={permission._id} permission={permission} />
                  ))}
                </RNView>
              ) : null}
            </>
          }
          renderItem={({ item, index }) => {
            const row = renderRow(item, index);
            if (row == null) return null;
            return <Reanimated.View entering={rowEntering(item, rowKeys[index])}>{row}</Reanimated.View>;
          }}
          keyExtractor={(_item, index) => rowKeys[index]}
          contentContainerStyle={[
            styles.messageList,
            { paddingBottom: 12 },
            // Grow to center the empty state, never pin to the viewport: a list
            // squeezed by the keyboard and an attachment strip shrank its text
            // frames until iOS drew half of each line.
            allMessages.length === 0 && { flexGrow: 1 },
          ]}
          ListEmptyComponent={
            (conversation.message_count ?? 0) > 0 ? (
              // Server metadata says messages exist — the window just hasn't
              // hydrated yet (IDB/live sync in flight). Show a loader, not the
              // "No messages yet" empty state.
              <RNView style={styles.emptyState}>
                <ActivityIndicator size="large" color={Theme.textMuted} />
                <RNText style={styles.emptyStateSubtext}>Loading messages…</RNText>
              </RNView>
            ) : (
              <RNView style={styles.emptyState}>
                <FontAwesome name="comments-o" size={32} color={Theme.textDim} />
                <RNText style={styles.emptyStateText}>No messages yet</RNText>
                <RNText style={styles.emptyStateSubtext}>{words.noMessages}</RNText>
              </RNView>
            )
          }
          showsVerticalScrollIndicator={false}
          onScrollToIndexFailed={(info) => {
            // scrollToIndex to an index past highestMeasuredFrameIndex fails
            // WITHOUT scrolling, so a bare retry with the same index fails the
            // same way forever and a far jump is a silent no-op. Force the
            // list to render near the target with an estimated offset first,
            // then retry the precise scrollToIndex (same viewPosition 0.3 the
            // jump asked for), capped at 3 rounds per index.
            const retry = scrollRetryRef.current;
            if (retry.index === info.index) retry.count += 1;
            else scrollRetryRef.current = { index: info.index, count: 1 };
            if (scrollRetryRef.current.count > 3) return;
            flatListRef.current?.scrollToOffset({
              offset: info.averageItemLength * info.index,
              animated: false,
            });
            setTimeout(() => {
              // Guard against the window swapping under the retry (a jump can
              // shrink the list to a 50-row target window); a stale index
              // would make scrollToIndex THROW, not fail — the pending scroll
              // effect owns the landing in that case.
              const msgs = allMessagesRef.current;
              if (info.index >= msgs.length) return;
              flatListRef.current?.scrollToIndex({
                index: info.index,
                animated: false,
                viewPosition: 0.3,
              });
              // The 3s highlight started when the jump did, so a multi retry
              // landing would arrive with it partly or fully spent. Restart it
              // with each retry; a further failure re-enters this handler, so
              // the last restart is the one that lands with the row.
              const target = msgs[msgs.length - 1 - info.index]?._id;
              if (target && highlightTargetRef.current === target) flashHighlight(target);
            }, 250);
          }}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          onViewableItemsChanged={handleViewableItemsChanged}
          viewabilityConfig={stickyViewabilityConfig}
          /* maintainVisibleContentPosition removed - was causing blank screen by fighting scroll offset */
          // Drag the transcript to put the keyboard away. The composer is
          // multiline, so the return key inserts a newline instead of
          // submitting, and persistTaps="always" means a tap on the transcript
          // never blurs either — without this the keyboard has no way down once
          // the field is focused. iOS tracks the finger (iMessage style);
          // 'interactive' is iOS-only and degrades to 'none' on Android, so
          // Android gets 'on-drag', which dismisses as soon as a drag begins.
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          keyboardShouldPersistTaps="always"
        />
        {/* The hosted transcript's top edge, as the web's: a 24px fade under
            the title once the reading has scrolled past the first line, so
            lines slide out of view rather than being cut, and the first line
            is never dimmed. */}
        {hosted && familyLook && hasAbove && (
          <LinearGradient
            colors={[Theme.bg, Theme.bg + '00']}
            style={{ position: 'absolute', left: 0, right: 0, top: insets.top + HEADER_BAR_HEIGHT, height: 24 }}
            pointerEvents="none"
          />
        )}
        <MessageTickRail
          ticks={navTicks}
          promptCount={promptCount}
          activeMessageId={activeStickyId}
          visible={userScrolled}
          onOpen={openNavigatorSheet}
          onScrub={handleRailScrub}
          onScrubEnd={handleRailScrubEnd}
        />

        {/* Jump arrows. Unmount when empty: an absolute box-none layer with
            zIndex still intercepts taps on some RN builds. */}
        {(userScrolled || hasMoreAbove || (!isNearTop && allMessages.length > 0)) && (
        <RNView style={styles.jumpButtonsOverlay} pointerEvents="box-none">
          {/* The tick rail carries the position signal when it renders; only a
              thread with no rail (fewer than 2 ticks) keeps the old track. */}
          {allMessages.length > 150 && userScrolled && navTicks.length < 2 && (
            <RNView style={styles.scrollProgressTrackWrap}>
              <RNView style={styles.scrollProgressTrack}>
                <Animated.View style={[styles.scrollProgressFill, {
                  height: scrollProgressAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0%', '100%'],
                  }),
                }]} />
              </RNView>
            </RNView>
          )}
          {((!isNearTop && allMessages.length > 0) || hasMoreAbove) && (
            <Animated.View
              // box-none: this wrap spans the full width at the sticky pill's
              // anchor; without it the invisible strip swallows the pill's taps.
              // The button also stacks BELOW the pill (stickyOffsetY, the
              // animated twin of stickyBannerHeight), or it would sit dead
              // center on the pill and eat its taps/swipes.
              pointerEvents="box-none"
              style={[
                styles.jumpTopButtonWrap,
                {
                  // The list pane starts at the screen's top edge, under the
                  // pinned title bar and the metadata strip (both stack above
                  // it), so anchor below both, where the sticky pill sits.
                  top: insets.top + HEADER_BAR_HEIGHT + floatingHeaderHeight + 8,
                  transform: [{ translateY: floatingHeaderY }, { translateY: stickyOffsetY }],
                },
              ]}
            >
              <TouchableOpacity
                onPress={handleJumpToStart}
                style={[styles.jumpButton, familyLook && jumpFamily]}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Jump to first message"
              >
                {jumpingToStart ? (
                  <ActivityIndicator size="small" color={Theme.textDim} />
                ) : (
                  <FontAwesome name="angle-up" size={18} color={familyLook ? hostedColors.ink2 : Theme.textMuted} />
                )}
              </TouchableOpacity>
            </Animated.View>
          )}
          {userScrolled && (
            <RNView style={styles.jumpBottomButtonWrap} pointerEvents="box-none">
              <TouchableOpacity
                onPress={handleJumpToEnd}
                style={[styles.jumpButton, familyLook && jumpFamily]}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Jump to latest message"
              >
                {jumpingToEnd ? (
                  <ActivityIndicator size="small" color={Theme.textDim} />
                ) : (
                  <FontAwesome name="angle-down" size={18} color={familyLook ? hostedColors.ink2 : Theme.textMuted} />
                )}
                {newMessageCount > 0 && (
                  <RNView style={styles.jumpBadge}>
                    <RNText style={styles.jumpBadgeText}>{newMessageCount > 99 ? '99+' : newMessageCount}</RNText>
                  </RNView>
                )}
              </TouchableOpacity>
            </RNView>
          )}
        </RNView>
        )}

        </Animated.View>
        {/* Composer is a sibling of the list pane, not under the jump overlay.
            That overlay used to be a full-width absolute layer on the KAV
            whose bottom inset was a guessed composer height; with the
            keyboard open the send button sat inside it and the overlay won. */}
        <RNView style={styles.composerLayer}>
          <MessageInput
            conversationId={id as Id<"conversations">}
            isActive={isActive}
            isOwner={!!conversation.is_own}
            draft={conversation?.draft_message}
            autoFocus={focusParam === '1'}
            hosted={hosted}
            waitsOnAnswer={hostedApprovals.length > 0}
          />
        </RNView>
      </KeyboardAvoidingView>
      <Toast key={toastKey} message={toastMessage} visible={!!toastMessage && toastKey > 0} />
      {shareSelectionMode && (
        <RNView style={styles.shareSelectionBar}>
          <RNText style={styles.shareSelectionCount}>
            {selectedMessageIds.size} selected
          </RNText>
          <TouchableOpacity onPress={handleCancelShareSelection} style={styles.shareSelectionCancel} activeOpacity={0.7}>
            <RNText style={{ fontSize: 13, color: Theme.textDim }}>Cancel</RNText>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleConfirmShareSelection}
            style={[styles.shareSelectionConfirm, selectedMessageIds.size === 0 && { opacity: 0.5 }]}
            activeOpacity={0.7}
            disabled={selectedMessageIds.size === 0}
          >
            <RNText style={{ fontSize: 13, color: '#fff', fontWeight: '600' }}>Copy</RNText>
          </TouchableOpacity>
        </RNView>
      )}
      <MessageNavigatorSheet
        visible={navSheetVisible}
        onClose={closeNavigatorSheet}
        rows={navigatorRows}
        currentMessageId={activeStickyId}
        onSelect={jumpToMessage}
      />
      <SessionActionsSheet
        visible={actionsVisible}
        onClose={() => setActionsVisible(false)}
        tiles={actionTiles}
        groups={actionGroups}
      />
      <RenameSessionSheet
        conversationId={String(conversation._id)}
        title={conversation.title || ''}
        visible={renameVisible}
        onClose={() => setRenameVisible(false)}
      />
      <Modal visible={treeModalVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setTreeModalVisible(false)}>
        <RNView style={styles.treeModal}>
          <RNView style={styles.treeModalHeader}>
            <RNText style={styles.treeModalTitle}>Fork Tree</RNText>
            <TouchableOpacity onPress={() => setTreeModalVisible(false)}>
              <FontAwesome name="times" size={18} color={Theme.textMuted} />
            </TouchableOpacity>
          </RNView>
          <ScrollView style={styles.treeModalContent}>
            {forkFamily.length > 0 ? (
              forkFamily.map((node) => (
                <ForkFamilyRow key={node.id} node={node} router={router} currentId={id as string} onClose={() => setTreeModalVisible(false)} />
              ))
            ) : (
              <RNText style={{ color: Theme.textMuted, padding: 16 }}>No fork tree available</RNText>
            )}
          </ScrollView>
        </RNView>
      </Modal>
      <ImageGallery
        items={allSessionImages}
        useSrc={useImageSrc}
        accent={Theme.accent}
        initialIndex={galleryIndex}
        visible={galleryVisible}
        onClose={() => setGalleryVisible(false)}
      />
    </>
  );
}

const styles = themedStyles((Theme, look) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Theme.bg,
    padding: 20,
  },
  errorText: {
    fontSize: 15,
    color: Theme.red,
    textAlign: 'center',
  },
  // Pinned compact title bar (back + title + actions). Sits above the
  // collapsing metadata strip and stays put while it scrolls away.
  pinnedHeader: {
    ...S.pinnedHeader,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 70,
    backgroundColor: Theme.bgAlt,
  },
  headerIconBtn: S.headerIconBtn,
  headerFace: { marginRight: 8 },
  // The family look names a conversation in the reading face, as the web's
  // hosted conversation header does.
  headerTitleText: {
    ...S.headerTitleText,
    ...(look === 'family' ? { fontFamily: Serif.regular, fontSize: 18, fontWeight: '500' as const } : null),
    color: Theme.text,
  },
  headerTitlePress: {
    flex: 1,
    alignSelf: 'stretch',
    justifyContent: 'center',
  },
  headerTitleInPress: {
    flex: 0,
  },
  moreLiveDot: {
    position: 'absolute',
    top: 7,
    right: 6,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.green,
  },
  floatingSessionHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 60,
    backgroundColor: Theme.bgAlt,
  },
  floatingSessionCard: {
    ...S.floatingSessionCard,
    backgroundColor: Theme.bgAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
  sessionMeta: S.sessionMeta,
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Shared shell for every metadata chip (agent, model, branch, device,
  // usage, links): one neutral outline, so the row reads as one set.
  metaChip: { ...chipShell, ...chipQuiet(Theme) },
  metaChipText: { ...chipText, color: Theme.textMuted },
  messageList: S.messageList,
  permissionsContainer: {
    marginBottom: 16,
  },
  messageBubble: S.messageBubble,
  userBubble: {
    ...S.userBubble,
    backgroundColor: Theme.userBubble + USER_BUBBLE_ALPHA,
  },
  userBubbleContent: S.userBubbleContent,
  userBubbleSender: { ...S.userBubbleSender, color: Theme.textDim },
  toolRunRow: S.toolRunRow,
  toolRunCalls: { marginBottom: 6 },
  toolRunText: { ...S.toolRunText, color: Theme.textDim },
  assistantBubble: {
    backgroundColor: 'transparent',
    // Stretch, don't shrink-wrap: a flex-start bubble sizes to its widest
    // intrinsic child — for tool calls that's the one-line header, so on wide
    // screens (tablets) the expanded tool/diff card squeezed to header width.
    alignSelf: 'stretch',
  },
  assistantBubbleFirst: S.assistantBubbleFirst,
  bubbleHeader: S.bubbleHeader,
  bubbleRole: S.bubbleRole,
  assistantRole: {
    color: Theme.textMuted0,
  },
  bubbleTime: S.bubbleTime,
  assistantTime: {
    color: Theme.textDim,
  },
  bubbleContent: S.bubbleContent,
  bubbleContentCollapsed: {
    maxHeight: 300,
    overflow: 'hidden',
  },
  showMoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    paddingVertical: 4,
    paddingHorizontal: 14,
  },
  showMoreText: {
    fontSize: 12,
    fontWeight: '500',
    color: Theme.cyan,
  },
  bubbleText: S.bubbleText,
  userText: {
    color: Theme.text,
  },
  assistantText: {
    color: Theme.text,
  },
  // Hosted voices (MessageBubble bodyStyle): the web's hosted-mode sizes,
  // 14px for the person, a 17px letter for the reply, 13.5px muted narration.
  foldedStrip: {
    height: 0,
    paddingTop: 0,
    paddingBottom: 0,
    borderBottomWidth: 0,
    overflow: 'hidden',
  },
  hostedUserBubble: {
    alignSelf: 'stretch',
    marginTop: 14,
    marginBottom: 6,
    paddingTop: 10,
    backgroundColor: Theme.userBubble,
    borderRadius: 10,
  },
  hostedUserText: {
    fontSize: 15,
    lineHeight: 22,
    color: Theme.text,
  },
  hostedReply: {
    fontFamily: Serif.regular,
    fontSize: 17,
    lineHeight: 26,
    color: Theme.text,
  },
  hostedNarration: {
    fontSize: 13.5,
    lineHeight: 20,
    color: Theme.textMuted,
  },
  thinkingBlock: {
    marginHorizontal: 14,
    marginVertical: 1,
    opacity: 0.5,
  },
  thinkingHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  thinkingText: {
    fontSize: 11,
    lineHeight: 15,
    color: Theme.textDim,
    fontFamily: 'JetBrainsMono-Regular',
    flex: 1,
  },
  compactBoundary: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
    paddingHorizontal: 8,
  },
  compactBoundaryLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(217,119,6,0.4)',
  },
  compactBoundaryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(217,119,6,0.1)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(217,119,6,0.3)',
    marginHorizontal: 8,
  },
  compactBoundaryText: {
    fontSize: 11,
    color: '#d97706',
    fontWeight: '500',
  },
  systemMessage: {
    marginVertical: 6,
    marginHorizontal: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: Theme.bgAlt + '40',
    borderLeftWidth: 2,
    borderLeftColor: Theme.borderLight,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  systemMessageWarning: {
    backgroundColor: 'rgba(217,119,6,0.1)',
    borderLeftColor: 'rgba(217,119,6,0.4)',
  },
  systemWarningText: {
    color: '#d97706',
  },
  systemSubtypeLabel: {
    fontSize: 10,
    color: Theme.textDim,
    marginTop: 1,
  },
  systemMessageText: {
    fontSize: 12,
    color: Theme.textMuted0,
    fontFamily: 'JetBrainsMono-Regular',
    flex: 1,
  },
  systemCommandBlock: {
    marginVertical: 4,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  systemCommandBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: Theme.bgHighlight,
    marginTop: 1,
  },
  systemCommandBadgeText: {
    fontSize: 9,
    color: Theme.textMuted0,
    fontWeight: '600',
    fontFamily: 'JetBrainsMono-Regular',
  },
  systemCommandText: {
    fontSize: 11,
    color: Theme.textDim,
    flex: 1,
  },
  interruptLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  interruptLineText: {
    fontSize: 11,
    fontWeight: '500',
  },
  vaultReadyLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  vaultReadyText: {
    fontSize: 12,
    flexShrink: 1,
  },
  systemRail: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginHorizontal: 14,
    marginVertical: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderLeftWidth: 2,
    borderRadius: 4,
  },
  systemRailKicker: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: Theme.textDim,
  },
  systemRailText: {
    fontSize: 12,
    lineHeight: 18,
    color: Theme.textMuted,
  },
  awaySummary: {
    marginHorizontal: 14,
    marginVertical: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
  },
  ansiOutput: {
    fontSize: 11,
    lineHeight: 16,
    color: Theme.textSecondary,
    padding: 6,
    borderRadius: 6,
    backgroundColor: Theme.bgAlt,
  },
  toolCallOnlyBubble: S.toolCallOnlyBubble,
  toolCallsCompact: S.toolCallsCompact,
  toolCallsContainer: S.toolCallsContainer,
  toolCallContainer: {
    marginVertical: 0,
  },
  toolCallHeader: S.toolCallHeader,
  toolCallName: {
    ...S.toolCallName,
    fontFamily: 'JetBrainsMono-Regular',
  },
  toolCallSummary: {
    ...S.toolCallSummary,
    color: Theme.textMuted,
    fontFamily: 'JetBrainsMono-Regular',
  },
  toolCallResultHint: {
    ...S.toolCallResultHint,
    color: Theme.textDim,
    fontFamily: 'JetBrainsMono-Regular',
  },
  toolCallContent: {
    marginTop: 4,
    padding: 6,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bgAlt,
    overflow: 'hidden',
  },
  // A diff card draws its own frame.
  toolCallContentBare: {
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  toolCallContentError: {
    borderColor: Theme.red + '40',
    backgroundColor: Theme.red + '08',
  },
  bashCommandSection: {
    marginHorizontal: -6,
    marginTop: -6,
    marginBottom: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
    backgroundColor: Theme.bgHighlight + '4D',
  },
  bashPrompt: {
    fontSize: 11,
    fontFamily: 'JetBrainsMono-Regular',
    color: Theme.textMuted,
  },
  toolResultBox: {
    flexGrow: 0,
  },
  hScroll: {
    flexGrow: 0,
  },
  languageLabel: {
    fontSize: 10,
    color: Theme.textDim,
    fontFamily: 'JetBrainsMono-Regular',
  },
  toolInputSection: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  toolCallInput: {
    fontSize: 12,
    color: Theme.textSecondary,
    fontFamily: 'JetBrainsMono-Regular',
  },
  toolCallResult: {
    fontSize: 12,
    color: Theme.textSecondary,
    fontFamily: 'JetBrainsMono-Regular',
    lineHeight: 17,
    padding: 8,
  },
  inputContainer: {
    backgroundColor: Theme.bgAlt,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight,
    // paddingBottom is set inline from safe-area insets (home indicator clearance
    // varies by device/orientation); see MessageInput.
  },
  // Specialized tool blocks
  specialToolBlock: {
    marginVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  specialToolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  specialToolName: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'JetBrainsMono-Regular',
  },
  specialToolBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  specialToolBadgeText: {
    fontSize: 10,
    fontWeight: '500',
    fontFamily: 'JetBrainsMono-Regular',
  },
  specialToolMeta: {
    fontSize: 10,
    color: Theme.textDim,
    fontFamily: 'JetBrainsMono-Regular',
  },
  specialToolDesc: {
    fontSize: 11,
    color: Theme.textMuted,
  },
  specialToolContent: {
    fontSize: 11,
    color: Theme.textSecondary,
    fontFamily: 'JetBrainsMono-Regular',
    lineHeight: 16,
    paddingHorizontal: 10,
    paddingBottom: 8,
  },
  specialToolResult: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight + '80',
  },
  specialToolResultLabel: {
    fontSize: 10,
    color: Theme.textDim,
    marginBottom: 2,
  },
  specialToolResultText: {
    fontSize: 11,
    color: Theme.textMuted,
    fontFamily: 'JetBrainsMono-Regular',
  },
  // AskUserQuestion
  askQuestionBlock: {
    marginVertical: 6,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: Theme.violet + '60',
  },
  questionItem: {
    marginBottom: 10,
  },
  auqPreviewBox: {
    // flexGrow 0 stops the horizontal ScrollView from stretching to fill the
    // cell (same quirk mdStyles.hScroll works around for tables).
    flexGrow: 0,
    marginTop: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    borderRadius: 6,
    backgroundColor: Theme.bgAlt,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  auqPreviewText: {
    fontFamily: 'JetBrainsMono-Regular',
    fontSize: 10,
    lineHeight: 15,
    color: Theme.textSecondary,
    padding: 8,
  },
  questionHeaderBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 5,
    paddingVertical: 1,
    backgroundColor: Theme.violet + '20',
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.violet + '30',
    marginBottom: 4,
  },
  questionHeaderText: {
    fontSize: 9,
    fontWeight: '600',
    color: Theme.violet + 'cc',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  questionText: {
    fontSize: 12,
    color: Theme.textMuted,
    marginBottom: 6,
  },
  optionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  optionsColumn: {
    flexDirection: 'column',
    flexWrap: 'nowrap',
    alignItems: 'flex-start',
  },
  optionItem: {
    alignItems: 'flex-start',
  },
  optionDescription: {
    fontSize: 11,
    color: Theme.textDim,
    marginTop: 2,
    marginLeft: 2,
    marginBottom: 2,
  },
  optionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight + '60',
  },
  optionPillInteractive: {
    backgroundColor: Theme.violet + '15',
    borderColor: Theme.violet + '50',
  },
  optionPillSelected: {
    backgroundColor: Theme.green + '20',
    borderColor: Theme.green + '60',
  },
  optionPillText: {
    fontSize: 12,
    color: Theme.textDim,
  },
  optionPillTextInteractive: {
    color: Theme.violet,
  },
  optionPillTextSelected: {
    color: Theme.green,
    fontWeight: '500',
  },
  optionPillCustom: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: Theme.blue + '20',
    borderColor: Theme.blue + '60',
  },
  optionPillCustomText: {
    fontSize: 12,
    color: Theme.blue,
  },
  // TodoWrite / TaskList
  todoDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  todoBlock: {
    marginVertical: 6,
  },
  todoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 2,
    gap: 2,
  },
  todoTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.magenta,
    fontFamily: 'JetBrainsMono-Regular',
  },
  todoStats: {
    fontSize: 12,
    color: Theme.textDim,
    fontFamily: 'JetBrainsMono-Regular',
  },
  todoList: {
    gap: 2,
    marginLeft: 14,
    marginTop: 4,
  },
  todoItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 4,
  },
  todoId: {
    fontSize: 10,
    color: Theme.textDim,
    fontFamily: 'JetBrainsMono-Regular',
    marginTop: 2,
  },
  todoItemText: {
    fontSize: 12,
    color: Theme.textMuted,
    flex: 1,
  },
  todoOwnerBadge: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: 'rgba(38,139,210,0.15)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(38,139,210,0.2)',
  },
  todoOwnerText: {
    fontSize: 10,
    color: Theme.blue,
    fontFamily: 'JetBrainsMono-Regular',
  },
  todoBlockedText: {
    fontSize: 10,
    color: Theme.textDim,
    marginTop: 2,
  },
  // Skill card
  skillCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 2,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight + '66',
  },
  skillName: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.violet,
    fontFamily: 'JetBrainsMono-Regular',
  },
  // Task operations (TaskCreate/Update, SendMessage, TeamCreate)
  taskOpBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginVertical: 1,
  },
  taskOpName: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'JetBrainsMono-Regular',
  },
  taskOpId: {
    fontSize: 10,
    color: Theme.textMuted0,
    fontFamily: 'JetBrainsMono-Regular',
  },
  taskOpBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  taskOpBadgeText: {
    fontSize: 9,
    fontWeight: '600',
    fontFamily: 'JetBrainsMono-Regular',
  },
  taskOpText: {
    fontSize: 11,
    color: Theme.textMuted,
    flex: 1,
  },
  // Images
  imagesContainer: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 8,
  },
  imageContainer: {
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  imageFadeOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 30,
    backgroundColor: 'transparent',
    // Gradient effect via layered semi-transparent views
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
  },
  imageLoading: {
    height: 60,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Theme.bgAlt,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  toolImagesSection: {
    marginTop: 10,
    gap: 8,
  },
  // Compaction summary
  compactionBlock: {
    marginVertical: 12,
    paddingHorizontal: 12,
  },
  compactionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  compactionTitle: {
    fontSize: 11,
    color: 'rgba(217,119,6,0.7)',
  },
  compactionContent: {
    fontSize: 11,
    color: Theme.textMuted,
    lineHeight: 16,
  },
  compactionContentWrap: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(217,119,6,0.3)',
    backgroundColor: Theme.bgAlt + '33',
  },
  // Plan block
  planBlock: {
    marginVertical: 12,
    marginHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Theme.borderLight + '99',
    backgroundColor: Theme.bgAlt + '4D',
    overflow: 'hidden',
  },
  planHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight + '66',
  },
  planTitle: {
    fontSize: 12,
    color: Theme.textMuted,
    fontWeight: '600',
    flex: 1,
  },
  planContent: {
    padding: 12,
  },
  planText: {
    fontSize: 12,
    color: Theme.text,
    lineHeight: 18,
  },
  // Jump buttons
  jumpButtonsOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
  },
  composerLayer: {
    zIndex: 200,
    elevation: 200,
  },
  jumpTopButtonWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  jumpBottomButtonWrap: {
    position: 'absolute',
    bottom: 20,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  jumpButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Theme.bgAlt,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
  },
  // Teammate messages
  teammateMessage: {
    marginVertical: 6,
    paddingLeft: 12,
    paddingVertical: 4,
    borderLeftWidth: 2,
  },
  teammateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    gap: 8,
  },
  teammateBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  teammateBadgeText: {
    fontSize: 10,
    fontFamily: 'JetBrainsMono-Regular',
    fontWeight: '500',
  },
  teammateSummary: {
    fontSize: 12,
    color: Theme.textMuted,
    fontStyle: 'italic',
    flex: 1,
  },
  teammateContent: {
    fontSize: 13,
    color: Theme.textSecondary,
    lineHeight: 19,
  },
  teammateExpand: {
    fontSize: 11,
    color: Theme.textDim,
    marginTop: 4,
    fontWeight: '500',
  },
  teammateIdle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 2,
    paddingVertical: 4,
  },
  teammateIdleText: {
    fontSize: 11,
    color: Theme.textMuted,
    fontStyle: 'italic',
  },
  // Skill block cards (in content)
  skillBlockCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight + '66',
    marginVertical: 4,
  },
  skillBlockName: {
    fontSize: 11,
    fontFamily: 'JetBrainsMono-Regular',
    color: Theme.violet,
    fontWeight: '600',
  },
  skillBlockDesc: {
    fontSize: 11,
    color: Theme.textMuted,
    flex: 1,
  },
  skillBlockPath: {
    fontSize: 9,
    color: Theme.textMuted0,
    fontFamily: 'JetBrainsMono-Regular',
  },
  // Fork UI
  forkChildrenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingBottom: 8,
    flexWrap: 'wrap',
  },
  forkChildBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: Theme.violet + '15',
    borderWidth: 1,
    borderColor: Theme.violet + '30',
    maxWidth: 160,
  },
  forkChildText: {
    fontSize: 10,
    color: Theme.violet,
    fontWeight: '500',
  },
  // Agent dot
  agentDot: S.agentDot,
  // Table
  // Code copy button
  // Model badge in header
  modelBadge: {
    ...S.modelBadge,
    color: Theme.textDim,
    fontFamily: 'JetBrainsMono-Regular',
  },
  // Commit cards
  commitCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 6,
  },
  commitSha: {
    fontSize: 11,
    fontFamily: 'JetBrainsMono-Regular',
    color: Theme.green,
    fontWeight: '600',
  },
  commitMessage: {
    fontSize: 11,
    color: Theme.textMuted,
    flex: 1,
  },
  commitTime: {
    fontSize: 9,
    color: Theme.textDim,
  },
  // Fullscreen image
  imageExpandHint: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 4,
    padding: 4,
  },
  // Thinking label
  // Skeleton loading
  // Jump badge for new messages
  jumpBadge: {
    position: 'absolute',
    top: -6,
    right: -6,
    backgroundColor: Theme.accent,
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  jumpBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#fff',
  },
  prCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 6,
  },
  prNumber: {
    fontSize: 11,
    fontFamily: 'JetBrainsMono-Regular',
    color: Theme.violet,
    fontWeight: '600',
  },
  prTitle: {
    fontSize: 11,
    color: Theme.textMuted,
    flex: 1,
  },
  emptyState: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 24,
    gap: 10,
  },
  emptyStateText: {
    fontSize: 15,
    fontWeight: '600',
    color: Theme.textMuted,
  },
  emptyStateSubtext: {
    fontSize: 12,
    color: Theme.textDim,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  toast: {
    position: 'absolute',
    bottom: 100,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.85)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    zIndex: 1000,
  },
  toastText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
  },
  contentGradientOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 80,
  },
  planFullscreen: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  planFullscreenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 60 : 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
    backgroundColor: Theme.bgAlt,
  },
  planFullscreenTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: Theme.text,
    flex: 1,
  },
  planFullscreenContent: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  planFullscreenText: {
    fontSize: 14,
    color: Theme.text,
    lineHeight: 22,
  },
  planGradientOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 80,
  },
  planActions: {
    flexDirection: 'row',
    gap: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight + '66',
  },
  planActionText: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.cyan,
  },
  treeModal: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  treeModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 60 : 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
    backgroundColor: Theme.bgAlt,
  },
  treeModalTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: Theme.text,
  },
  treeModalContent: {
    flex: 1,
    paddingVertical: 8,
  },
  treeNode: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingRight: 12,
  },
  treeNodeCurrent: {
    backgroundColor: Theme.violet + '15',
  },
  treeNodePrefix: {
    fontSize: 10,
    color: Theme.textDim,
    fontFamily: 'JetBrainsMono-Regular',
  },
  treeNodeTitle: {
    fontSize: 13,
    color: Theme.text,
    flex: 1,
  },
  treeNodeMeta: {
    fontSize: 10,
    color: Theme.textDim,
  },
  // Search bar
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: Theme.bgHighlight,
    borderRadius: 8,
    marginHorizontal: 12,
    marginBottom: 8,
  },
  floatingSearchBar: {
    marginTop: 6,
    marginHorizontal: 0,
    marginBottom: 0,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: Theme.text,
    paddingVertical: 4,
    fontFamily: 'JetBrainsMono-Regular',
  },
  searchCount: {
    fontSize: 10,
    color: Theme.textDim,
    fontFamily: 'JetBrainsMono-Regular',
  },
  // View mode toggle (Raw/Rendered)
  languageLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight + '33',
  },
  viewModeToggle: {
    flexDirection: 'row',
    borderRadius: 4,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  viewModeBtn: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  viewModeBtnActive: {
    backgroundColor: Theme.cyan + '25',
  },
  viewModeBtnText: {
    fontSize: 9,
    color: Theme.textDim,
    fontWeight: '500',
  },
  viewModeBtnTextActive: {
    color: Theme.cyan,
  },
  // Content actions row (Expand + Fullscreen)
  contentActions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingBottom: 4,
  },
  // Message fullscreen
  messageFullscreen: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  messageFullscreenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 60 : 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
    backgroundColor: Theme.bgAlt,
  },
  messageFullscreenRole: {
    fontSize: 14,
    fontWeight: '600',
    color: Theme.text,
  },
  messageFullscreenTime: {
    fontSize: 11,
    color: Theme.textDim,
    flex: 1,
  },
  messageFullscreenContent: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  gitDiffPanel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight,
    backgroundColor: Theme.bgAlt + '30',
    paddingVertical: 8,
    maxHeight: 360,
  },
  gitDiffContent: {
    marginHorizontal: 12,
  },
  loadMoreIndicator: {
    alignItems: 'center',
    paddingVertical: 10,
    marginBottom: 4,
  },
  loadMorePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  loadMorePillText: {
    fontSize: 11,
    color: Theme.textMuted0,
  },
  pendingStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 2,
    paddingBottom: 4,
  },
  pendingStatusText: {
    fontSize: 10,
    color: Theme.textDim,
    fontStyle: 'italic',
  },
  scrollProgressTrackWrap: {
    position: 'absolute',
    right: 8,
    top: '45%',
  },
  scrollProgressTrack: {
    width: 3,
    height: 48,
    borderRadius: 1.5,
    backgroundColor: Theme.bgHighlight,
    overflow: 'hidden',
    marginBottom: 6,
  },
  scrollProgressFill: {
    width: '100%',
    borderRadius: 1.5,
    backgroundColor: Theme.cyan,
  },
  selectionCheckbox: {
    position: 'absolute',
    left: 0,
    top: 8,
    width: 28,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  shareSelectionBar: {
    position: 'absolute',
    bottom: 100,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 200,
  },
  shareSelectionCount: {
    fontSize: 13,
    color: Theme.textSecondary,
    flex: 1,
  },
  shareSelectionCancel: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  shareSelectionConfirm: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: Theme.cyan,
    borderRadius: 6,
  },
  searchHighlight: {
    borderWidth: 2,
    borderColor: Theme.accent,
    borderRadius: 8,
    shadowColor: Theme.accent,
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  usageBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  usageLabel: {
    fontSize: 10,
    color: Theme.textDim,
  },
  usageValue: {
    fontSize: 10,
    fontFamily: 'JetBrainsMono-Regular',
    color: Theme.textMuted,
  },
  usageContextRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  usageContextBar: {
    width: 50,
    height: 4,
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  usageContextFill: {
    height: '100%',
    borderRadius: 2,
  },
  taskNotificationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    marginVertical: 2,
  },
  // Session-message / scheduled-task cards (mirrors web's left-accented blocks)
  sessionMessageBlock: {
    marginVertical: 4,
    marginHorizontal: 2,
    borderRadius: 6,
    borderLeftWidth: 2,
    borderLeftColor: Theme.cyan + '99',
    backgroundColor: Theme.cyan + '0d',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  sessionMessageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  sessionMessageLabel: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: Theme.cyan + 'b3',
  },
  sessionMessageBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Theme.cyan + '60',
    backgroundColor: Theme.cyan + '20',
  },
  sessionMessageBadgeText: {
    fontSize: 10,
    fontFamily: 'JetBrainsMono-Regular',
    color: Theme.cyan,
  },
  sessionMessageTitle: {
    fontSize: 12,
    color: Theme.textMuted,
    flex: 1,
  },
  sessionMessageTime: {
    fontSize: 10,
    color: Theme.textDim,
    marginLeft: 'auto',
  },
  sessionMessageBody: {
    fontSize: 13,
    color: Theme.textSecondary,
    lineHeight: 19,
  },
  taskNotificationIcon: {
    fontSize: 14,
    fontWeight: '700',
    width: 18,
    textAlign: 'center',
  },
  taskNotificationSummary: {
    fontSize: 12,
    color: Theme.text,
    flex: 1,
    lineHeight: 17,
  },
  taskNotificationId: {
    fontSize: 10,
    fontFamily: 'JetBrainsMono-Regular',
    color: Theme.textDim,
  },
  taskNotificationTime: {
    fontSize: 10,
    color: Theme.textDim,
  },
  apiErrorCard: {
    borderWidth: 1,
    borderRadius: 6,
    padding: 10,
    marginVertical: 4,
    backgroundColor: Theme.bgAlt,
  },
  apiErrorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  apiErrorCode: {
    fontSize: 14,
    fontFamily: 'JetBrainsMono-Regular',
    fontWeight: '700',
  },
  apiErrorType: {
    fontSize: 11,
    fontFamily: 'JetBrainsMono-Regular',
  },
  apiErrorMessage: {
    fontSize: 12,
    color: Theme.textSecondary,
    lineHeight: 17,
  },
  apiErrorRequestId: {
    fontSize: 9,
    fontFamily: 'JetBrainsMono-Regular',
    color: Theme.textDim,
    marginTop: 4,
  },
  contextPillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 6,
  },
  contextPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
    backgroundColor: Theme.bgAlt,
  },
  contextPillText: {
    fontSize: 10,
    fontWeight: '500',
    maxWidth: 120,
  },
  contextPillId: {
    fontSize: 9,
    fontFamily: 'JetBrainsMono-Regular',
    color: Theme.textDim,
  },
}));
