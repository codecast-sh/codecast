import { StyleSheet, FlatList, ActivityIndicator, ScrollView, TouchableOpacity, Keyboard, KeyboardAvoidingView, Platform, Share, View as RNView, Image, ActionSheetIOS, Alert, Pressable, Clipboard, Modal, Animated, Easing, Dimensions, useWindowDimensions, InteractionManager, type TextInput as NativeTextInput, type LayoutChangeEvent } from 'react-native';
import { TextInput, Text as RNText } from '@/components/Themed';
import { useLocalSearchParams, Stack, useRouter, useFocusEffect } from 'expo-router';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { Id } from '@codecast/convex/convex/_generated/dataModel';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import * as Haptics from 'expo-haptics';
let ImagePicker: typeof import('expo-image-picker') | null = null;
try { ImagePicker = require('expo-image-picker'); } catch {}
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Feather from '@expo/vector-icons/Feather';
import { AgentLogoSvg } from '@/components/AgentLogo';
import { useInboxStore, isConvexId } from '@codecast/web/store/inboxStore';
import { extractSessionImages, mergeSessionImages, type SessionImageEntry } from '@codecast/web/lib/sessionImages';
import { insertImagePlaceholder, dropImagePlaceholder } from '@codecast/web/lib/imagePlaceholder';
import { isTrustedImageSrc } from '@/lib/convex';
import { parseInboundSessionMessage, isScheduledTaskMessage, parseChatWakePrompt, parseHuddleSummaryTag, type ChatWakePrompt } from '@codecast/web/components/sessionMessage';
import { buildNavigatorRows, sampleTicks, isStickyEligible, pickStickyFallbackFromLoaded, resolveStickyPrompt, countCommentsByMessage, type NavigatorRow } from '@codecast/web/lib/messageNavigator';
import { resolveSessionTitle } from '@codecast/web/lib/sessionTitle';
import { MessageNavigatorSheet } from '@/components/session/MessageNavigatorSheet';
import { MessageTickRail, MessageListButton } from '@/components/session/MessageTickRail';
import { StickyPromptBanner, type StickyPrompt } from '@/components/session/StickyPromptBanner';
import { useConversationMessages } from '@codecast/web/hooks/useConversationMessages';
import { useEnsureDispatch } from '@codecast/web/hooks/useEnsureDispatch';
import { PermissionCard } from '@/components/PermissionCard';
import { SuggestionPills } from '@/components/SuggestionPills';
import { PulsingDot } from '@/components/SessionItem';
import { AssignmentChip, AssignedToYouBanner } from '@/components/AssignmentChip';
import { SessionHuddleButton } from '@/components/calls/SessionHuddleButton';
import { ModelSwitcherChip } from '@/components/ModelSwitcherChip';
import { agentSupportsFork, ACTIVE_AGENT_STATUSES, DECISION_ANSWER_TAG_RE } from '@codecast/shared/contracts';
import { renderInlineMarkdown, MarkdownContent, MarkdownTextBlock, CodeBlockWithCopy, HighlightedCodeText, linkifyPlainText } from '@/components/MarkdownRenderer';
import { openLink } from '@/lib/links';
import { EntityPill } from '@/components/EntityPill';
import { CastCanvas, canvasAvailable, looksLikeHtmlMessage } from '@/components/CastCanvas';
import { useSessionRestart, ghostRestartContextFor } from '@codecast/web/hooks/useSessionRestart';
import { Theme, Spacing, chipShell, chipText, chipTint, CHROME_FONT_CAP } from '@/constants/Theme';
import {
  extractNestedActions,
  toolSummary,
  formatToolName,
  mcpToolNames,
  stripLineNumbers,
  isPlanWriteToolCall,
  toolIcon,
  type ToolColorToken,
} from '@codecast/shared/render';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// A real gradient WITHOUT a native module: expo-linear-gradient's native side
// ("ExpoLinearGradient") isn't linked into the dev/standalone binaries, so importing
// it crashes. Instead we fake a smooth vertical fade with a stack of thin views whose
// color interpolates from colors[0] (top) to the last color (bottom). This is what
// makes clipped content and image previews fade INTO the background (web-like) rather
// than getting capped by a hard solid block — the old stub just painted colors[last].
function parseColor(c: string): [number, number, number, number] {
  if (c?.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  const m = c?.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s.trim()));
    return [p[0] || 0, p[1] || 0, p[2] || 0, p[3] ?? 1];
  }
  return [0, 0, 0, 0];
}

// The solid colour a translucent tint actually shows once it is drawn over an
// opaque background. A fade overlay has to be painted in the colour the user
// sees, and these cards are an accent at ~5% over the page background, so the
// tint and the page have to be composited before the gradient can target it.
function blendOver(tint: string, base: string): string {
  const [r1, g1, b1, a] = parseColor(tint);
  const [r2, g2, b2] = parseColor(base);
  const mix = (t: number, b: number) => Math.round(b + (t - b) * a);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(mix(r1, r2))}${hex(mix(g1, g2))}${hex(mix(b1, b2))}`;
}

const GRADIENT_STEPS = 14;
const LinearGradient = ({ colors, style, children, pointerEvents }: { colors: string[]; style?: any; children?: any; pointerEvents?: string }) => {
  const [r1, g1, b1, a1] = parseColor(colors?.[0] ?? 'transparent');
  const [r2, g2, b2, a2] = parseColor(colors?.[colors.length - 1] ?? 'transparent');
  return (
    <RNView style={style} pointerEvents={pointerEvents as any}>
      <RNView style={StyleSheet.absoluteFill}>
        {Array.from({ length: GRADIENT_STEPS }).map((_, i) => {
          const t = i / (GRADIENT_STEPS - 1);
          const r = Math.round(r1 + (r2 - r1) * t);
          const g = Math.round(g1 + (g2 - g1) * t);
          const b = Math.round(b1 + (b2 - b1) * t);
          const a = a1 + (a2 - a1) * t;
          return <RNView key={i} style={{ flex: 1, backgroundColor: `rgba(${r},${g},${b},${a})` }} />;
        })}
      </RNView>
      {children}
    </RNView>
  );
};

function Toast({ message, visible }: { message: string; visible: boolean }) {
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
  subtype?: string;
  message_uuid?: string;
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

const COMMAND_PATTERNS = [
  /^<command-name>([^<]*)<\/command-name>/,
  /^<command-message>([^<]*)<\/command-message>/,
  /^<local-command-stdout>/,
  /^<local-command-stderr>/,
  /^Caveat:/,
];

function isCommandMessage(content: string): boolean {
  const trimmed = content.trim();
  return COMMAND_PATTERNS.some(pattern => pattern.test(trimmed));
}

// Synthetic truncation notice the CLI injects into imported sessions for the
// model's context only — never user-facing.
function isImportNotice(content?: string | null): boolean {
  return !!content && content.trimStart().startsWith('[Codecast import]');
}

function getCommandType(content: string): string {
  const trimmed = content.trim();
  if (/^<command-name>/.test(trimmed)) return 'cmd';
  if (/^<command-message>/.test(trimmed)) return 'msg';
  if (/^<local-command-stdout>/.test(trimmed)) return 'output';
  if (/^<local-command-stderr>/.test(trimmed)) return 'error';
  if (trimmed.startsWith('Caveat:')) return 'caveat';
  return 'status';
}

function cleanCommandContent(content: string): string {
  return content
    .replace(/<command-name>[^<]*<\/command-name>\s*/g, '')
    .replace(/<command-message>[^<]*<\/command-message>\s*/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s*Caveat:.*$/gm, '')
    .trim();
}

function stripSystemTags(content: string): string {
  return content
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<\/?(?:command-(?:name|message|args)|antml:[a-z_]+)[^>]*>/g, '')
    // A `cast decide` answer's trailer tag (web renders it as a footer).
    .replace(DECISION_ANSWER_TAG_RE, '')
    .replace(/^\s*Caveat:.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

type ForkChild = {
  _id: string;
  title: string;
  short_id?: string;
  parent_message_uuid?: string;
  started_at?: number;
  username?: string;
};

type TreeNode = {
  id: string;
  short_id?: string;
  title: string;
  message_count: number;
  parent_message_uuid?: string;
  started_at: number;
  status: string;
  is_current: boolean;
  children: TreeNode[];
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

// --- Markdown rendering ---
// The red/green wrapped diff rows, shared between the inline preview and the
// fullscreen view so both render the edit identically.
function DiffRows({ oldLines, newLines }: { oldLines: string[]; newLines: string[] }) {
  return (
    <RNView style={{ borderRadius: 4, overflow: 'hidden' }}>
      {oldLines.map((line, i) => (
        <RNView key={`o${i}`} style={{ flexDirection: 'row', backgroundColor: Theme.red + '12', paddingHorizontal: 6, paddingVertical: 1 }}>
          <RNText style={{ fontSize: 11, fontFamily: 'SpaceMono', lineHeight: 16, color: Theme.red, width: 14 }}>-</RNText>
          <HighlightedCodeText content={line || ' '} style={{ flex: 1, fontSize: 11, fontFamily: 'SpaceMono', lineHeight: 16, color: Theme.textSecondary }} />
        </RNView>
      ))}
      {newLines.map((line, i) => (
        <RNView key={`n${i}`} style={{ flexDirection: 'row', backgroundColor: Theme.green + '12', paddingHorizontal: 6, paddingVertical: 1 }}>
          <RNText style={{ fontSize: 11, fontFamily: 'SpaceMono', lineHeight: 16, color: Theme.green, width: 14 }}>+</RNText>
          <HighlightedCodeText content={line || ' '} style={{ flex: 1, fontSize: 11, fontFamily: 'SpaceMono', lineHeight: 16, color: Theme.textSecondary }} />
        </RNView>
      ))}
    </RNView>
  );
}

// Fullscreen, vertically scrollable view of a whole edit — same wrapped colored
// rows as inline, so long diffs are readable instead of clipped in the transcript.
function DiffFullscreen({ oldStr, newStr, filePath, visible, onClose }: { oldStr: string; newStr: string; filePath: string; visible: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  if (!visible) return null;
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const handleCopy = () => {
    Clipboard.setString(newStr);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <RNView style={styles.planFullscreen}>
        <RNView style={styles.planFullscreenHeader}>
          <FontAwesome name="pencil" size={14} color={Theme.orange} style={{ marginRight: 8 }} />
          <RNText style={styles.planFullscreenTitle} numberOfLines={1}>{filePath.split('/').pop() || 'Edit'}</RNText>
          <TouchableOpacity onPress={handleCopy} style={{ padding: 6 }} activeOpacity={0.7}>
            {copied ? <FontAwesome name="check" size={16} color={Theme.green} /> : <FontAwesome name="clipboard" size={16} color={Theme.textMuted} />}
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={{ padding: 6 }} activeOpacity={0.7}>
            <FontAwesome name="close" size={18} color={Theme.textMuted} />
          </TouchableOpacity>
        </RNView>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 60 }}>
          <DiffRows oldLines={oldLines} newLines={newLines} />
        </ScrollView>
      </RNView>
    </Modal>
  );
}

function DiffBlock({ oldStr, newStr, filePath }: { oldStr: string; newStr: string; filePath: string }) {
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  const handleCopy = () => {
    Clipboard.setString(newStr);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const totalDiffLines = oldLines.length + newLines.length;
  const isTall = totalDiffLines > 15;
  const displayOldLines = isTall ? oldLines.slice(0, Math.min(oldLines.length, 6)) : oldLines;
  const displayNewLines = isTall ? newLines.slice(0, Math.min(newLines.length, 6)) : newLines;

  return (
    <RNView style={{ marginVertical: 2 }}>
      {/* Diff lines WRAP rather than scroll horizontally: on a phone a horizontal
          ScrollView clipped long edits at the screen edge (unreadable without a
          tiny scrub) and — nested in the message list with nestedScrollEnabled —
          reserved a tall empty vertical band. Wrapping shows the whole edit, fills
          the row background full width, and removes that phantom gap. */}
      <DiffRows oldLines={displayOldLines} newLines={displayNewLines} />
      <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 2 }}>
        {isTall && (
          <TouchableOpacity onPress={() => setFullscreen(true)} activeOpacity={0.6} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <FontAwesome name="expand" size={10} color={Theme.textDim} />
            <RNText style={{ fontSize: 9, color: Theme.textDim }}>{totalDiffLines} lines</RNText>
          </TouchableOpacity>
        )}
        {!isTall && (
          <TouchableOpacity onPress={() => setFullscreen(true)} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <FontAwesome name="expand" size={10} color={Theme.textDim} />
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={handleCopy} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          {copied ? <FontAwesome name="check" size={10} color={Theme.green} /> : <FontAwesome name="clipboard" size={11} color={Theme.textDim} />}
        </TouchableOpacity>
      </RNView>
      <DiffFullscreen oldStr={oldStr} newStr={newStr} filePath={filePath} visible={fullscreen} onClose={() => setFullscreen(false)} />
    </RNView>
  );
}

// --- Message components ---

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });
}

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
  if (!agentType) return 'Unknown';
  if (agentType === 'claude_code') return 'Claude';
  if (agentType === 'codex') return 'Codex';
  if (agentType === 'cursor') return 'Cursor';
  if (agentType === 'gemini') return 'Gemini';
  if (agentType === 'opencode') return 'OpenCode';
  if (agentType === 'pi') return 'pi';
  if (agentType === 'grok') return 'Grok';
  return agentType.charAt(0).toUpperCase() + agentType.slice(1);
}

function agentTypeColor(agentType?: string): string {
  if (agentType === 'codex') return '#10b981';
  if (agentType === 'cursor') return '#60a5fa';
  if (agentType === 'gemini') return '#1a73e8';
  if (agentType === 'opencode') return '#f97316';
  if (agentType === 'pi') return '#14b8a6';
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

function hasRichMarkdown(text: string): boolean {
  const markers = [
    /^#{1,3}\s+\S/m,
    /\|.+\|.+\|/,
    /^```\w*/m,
    /^\d+\.\s+\*\*[^*]+\*\*/m,
    /^-\s+\[[ x]\]/im,
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

function AskUserQuestionBlock({ tool, result, conversationId }: { tool: ToolCall; result?: ToolResult; conversationId?: string }) {
  let parsedInput: { questions?: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string; preview?: string }>; multiSelect?: boolean; isConfirmation?: boolean }>; answers?: Record<string, string> } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const [sentLabel, setSentLabel] = useState<string | undefined>(() => _askUserSentState.get(tool.id));

  const questions = parsedInput.questions || [];
  if (questions.length === 0) return null;

  let answers: Record<string, string> = {};
  if (parsedInput.answers && typeof parsedInput.answers === 'object') {
    answers = parsedInput.answers;
  } else if (result?.content) {
    const regex = /"([^"]+)"="([^"]+)"/g;
    let match;
    while ((match = regex.exec(result.content)) !== null) {
      answers[match[1]] = match[2];
    }
  }

  // Interactive while the agent is still waiting: no answer yet, a live
  // conversation to send into, and the user hasn't already tapped. Confirmation
  // questions map to Enter/Escape; everything else to the 1-based option index
  // (matches web's poll-key contract that drives the live /poll picker).
  const isConfirmation = questions[0]?.isConfirmation;
  const isInteractive = !result && !!conversationId && sentLabel === undefined;

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
    store.sendMessage(conversationId, content, undefined, clientId);
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
    </RNView>
  );
}

function TodoWriteBlock({ tool }: { tool: ToolCall }) {
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

function useImageSrc(image: ImageData) {
  const storageUrl = useQuery(
    api.images.getImageUrl,
    image.storage_id ? { storageId: image.storage_id as Id<"_storage"> } : "skip"
  );
  return image.storage_id
    ? storageUrl ?? undefined
    : image.url
      ? image.url
      : image.data
        ? `data:${image.media_type};base64,${image.data}`
        : undefined;
}

// Identity of an image across the raw message shape and the gallery's scanned
// entries (extractSessionImages keys the same way).
function imageKeyOf(image: ImageData): string | undefined {
  return image.storage_id
    || image.url
    || (image.data ? `data:${image.media_type};base64,${image.data}` : undefined);
}

function ImageBlock({ image, onPress }: { image: ImageData; onPress?: () => void }) {
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

function getDistance(touches: { pageX: number; pageY: number }[]) {
  const dx = touches[0].pageX - touches[1].pageX;
  const dy = touches[0].pageY - touches[1].pageY;
  return Math.sqrt(dx * dx + dy * dy);
}

function getMidpoint(touches: { pageX: number; pageY: number }[]) {
  return {
    x: (touches[0].pageX + touches[1].pageX) / 2,
    y: (touches[0].pageY + touches[1].pageY) / 2,
  };
}

function GalleryImage({ image, screenWidth, screenHeight, onZoomChange, onRequestClose }: { image: ImageData; screenWidth: number; screenHeight: number; onZoomChange?: (zoomed: boolean) => void; onRequestClose?: () => void }) {
  const src = useImageSrc(image);

  const scaleVal = useRef(new Animated.Value(1)).current;
  const translateXVal = useRef(new Animated.Value(0)).current;
  const translateYVal = useRef(new Animated.Value(0)).current;

  const pinchState = useRef({ startDist: 0, startScale: 1, scale: 1 });
  const panState = useRef({ startX: 0, startY: 0, startTx: 0, startTy: 0, tx: 0, ty: 0, isPanning: false });
  const lastTap = useRef(0);
  // Swipe-down-to-dismiss, armed only while un-zoomed (so it never fights pan).
  const dismiss = useRef({ startY: 0, dy: 0, active: false });

  const setZoomed = useCallback((scale: number) => {
    onZoomChange?.(scale > 1.05);
  }, [onZoomChange]);

  const resetTransform = useCallback(() => {
    Animated.parallel([
      Animated.spring(scaleVal, { toValue: 1, useNativeDriver: true, tension: 100, friction: 10 }),
      Animated.spring(translateXVal, { toValue: 0, useNativeDriver: true, tension: 100, friction: 10 }),
      Animated.spring(translateYVal, { toValue: 0, useNativeDriver: true, tension: 100, friction: 10 }),
    ]).start();
    pinchState.current.scale = 1;
    panState.current.tx = 0;
    panState.current.ty = 0;
    setZoomed(1);
  }, [scaleVal, translateXVal, translateYVal, setZoomed]);

  const handleTouchStart = useCallback((e: any) => {
    const touches = e.nativeEvent.touches;
    if (touches.length === 2) {
      pinchState.current.startDist = getDistance(touches);
      pinchState.current.startScale = pinchState.current.scale;
      const mid = getMidpoint(touches);
      panState.current.startX = mid.x;
      panState.current.startY = mid.y;
      panState.current.startTx = panState.current.tx;
      panState.current.startTy = panState.current.ty;
      panState.current.isPanning = false;
    } else if (touches.length === 1) {
      const now = Date.now();
      if (now - lastTap.current < 300) {
        if (pinchState.current.scale > 1) {
          resetTransform();
        } else {
          Animated.spring(scaleVal, { toValue: 3, useNativeDriver: true, tension: 100, friction: 10 }).start();
          pinchState.current.scale = 3;
          setZoomed(3);
        }
        lastTap.current = 0;
      } else {
        lastTap.current = now;
        if (pinchState.current.scale > 1.05) {
          panState.current.startX = touches[0].pageX;
          panState.current.startY = touches[0].pageY;
          panState.current.startTx = panState.current.tx;
          panState.current.startTy = panState.current.ty;
          panState.current.isPanning = true;
        } else {
          dismiss.current.active = true;
          dismiss.current.startY = touches[0].pageY;
          dismiss.current.dy = 0;
        }
      }
    }
  }, [scaleVal, resetTransform, setZoomed]);

  const handleTouchMove = useCallback((e: any) => {
    const touches = e.nativeEvent.touches;
    if (touches.length === 2) {
      const dist = getDistance(touches);
      const newScale = Math.min(5, Math.max(0.5, pinchState.current.startScale * (dist / pinchState.current.startDist)));
      scaleVal.setValue(newScale);
      pinchState.current.scale = newScale;
      setZoomed(newScale);

      const mid = getMidpoint(touches);
      const newTx = panState.current.startTx + (mid.x - panState.current.startX);
      const newTy = panState.current.startTy + (mid.y - panState.current.startY);
      translateXVal.setValue(newTx);
      translateYVal.setValue(newTy);
      panState.current.tx = newTx;
      panState.current.ty = newTy;
    } else if (touches.length === 1 && panState.current.isPanning) {
      const newTx = panState.current.startTx + (touches[0].pageX - panState.current.startX);
      const newTy = panState.current.startTy + (touches[0].pageY - panState.current.startY);
      translateXVal.setValue(newTx);
      translateYVal.setValue(newTy);
      panState.current.tx = newTx;
      panState.current.ty = newTy;
    } else if (touches.length === 1 && dismiss.current.active) {
      // Follow the finger downward; ignore upward drag so it can't push the image up.
      const dy = touches[0].pageY - dismiss.current.startY;
      dismiss.current.dy = dy;
      translateYVal.setValue(dy > 0 ? dy : 0);
    }
  }, [scaleVal, translateXVal, translateYVal, setZoomed]);

  const handleTouchEnd = useCallback(() => {
    panState.current.isPanning = false;
    if (dismiss.current.active) {
      const dy = dismiss.current.dy;
      dismiss.current.active = false;
      dismiss.current.dy = 0;
      if (dy > 120) {
        onRequestClose?.();
        return;
      }
      // Not far enough — snap the image back into place.
      Animated.spring(translateYVal, { toValue: 0, useNativeDriver: true, tension: 100, friction: 10 }).start();
    }
    if (pinchState.current.scale < 1) {
      resetTransform();
    }
  }, [resetTransform, onRequestClose, translateYVal]);

  if (!src) return <RNView style={{ width: screenWidth, justifyContent: 'center', alignItems: 'center' }}><ActivityIndicator color="#fff" /></RNView>;
  return (
    <RNView
      style={{ width: screenWidth, height: screenHeight, justifyContent: 'center', alignItems: 'center' }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <Animated.View style={{ transform: [{ translateX: translateXVal }, { translateY: translateYVal }, { scale: scaleVal }] }}>
        <Image source={{ uri: src }} style={{ width: screenWidth, height: screenHeight * 0.85 }} resizeMode="contain" />
      </Animated.View>
    </RNView>
  );
}

// One thumb in the gallery's bottom filmstrip. Dimmed unless current; a
// storage-backed entry shows a placeholder square until its URL resolves.
function GalleryThumb({ image, active, onPress }: { image: ImageData; active: boolean; onPress: () => void }) {
  const src = useImageSrc(image);
  if (!src) return <RNView style={[styles.galleryThumb, styles.galleryThumbPlaceholder]} />;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8}>
      <Image
        source={{ uri: src }}
        style={[styles.galleryThumb, active ? styles.galleryThumbActive : styles.galleryThumbInactive]}
        resizeMode="cover"
      />
    </TouchableOpacity>
  );
}

const GALLERY_THUMB_STEP = 46; // 40px thumb + 6px gap, for strip auto-centering

function ImageGallery({ images, initialIndex, visible, onClose }: {
  images: ImageData[];
  initialIndex: number;
  visible: boolean;
  onClose: () => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [isZoomed, setIsZoomed] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const thumbStripRef = useRef<FlatList>(null);
  const insets = useSafeAreaInsets();
  const { width: deviceWidth, height: deviceHeight } = useWindowDimensions();

  // Keep the active thumb centered as swipes/taps move the selection.
  useEffect(() => {
    if (!visible || images.length < 2) return;
    thumbStripRef.current?.scrollToOffset({
      offset: Math.max(0, currentIndex * GALLERY_THUMB_STEP - deviceWidth / 2 + GALLERY_THUMB_STEP / 2),
      animated: true,
    });
  }, [visible, currentIndex, images.length, deviceWidth]);

  const screenWidth = isLandscape ? deviceHeight : deviceWidth;
  const screenHeight = isLandscape ? deviceWidth : deviceHeight;

  useEffect(() => {
    if (visible) {
      setCurrentIndex(initialIndex);
      setIsZoomed(false);
      setIsLandscape(false);
      setTimeout(() => flatListRef.current?.scrollToIndex({ index: initialIndex, animated: false }), 50);
    }
  }, [visible, initialIndex]);

  const handleZoomChange = useCallback((zoomed: boolean) => {
    setIsZoomed(zoomed);
  }, []);

  const toggleLandscape = useCallback(() => {
    setIsLandscape(prev => !prev);
    setIsZoomed(false);
  }, []);

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']}>
      <RNView style={styles.fullscreenOverlay}>
        <RNView style={[styles.galleryContent, isLandscape && { transform: [{ rotate: '90deg' }], width: deviceHeight, height: deviceWidth }]}>
          <FlatList
            ref={flatListRef}
            data={images}
            horizontal
            pagingEnabled
            scrollEnabled={!isZoomed}
            showsHorizontalScrollIndicator={false}
            keyExtractor={(_, i) => String(i)}
            renderItem={({ item }) => <GalleryImage image={item} screenWidth={screenWidth} screenHeight={screenHeight} onZoomChange={handleZoomChange} onRequestClose={onClose} />}
            onMomentumScrollEnd={(e) => {
              const idx = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
              setCurrentIndex(idx);
            }}
            getItemLayout={(_, index) => ({ length: screenWidth, offset: screenWidth * index, index })}
            initialScrollIndex={initialIndex}
          />
        </RNView>
        <TouchableOpacity style={styles.fullscreenClose} onPress={onClose} activeOpacity={0.7}>
          <FontAwesome name="close" size={20} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.landscapeToggle} onPress={toggleLandscape} activeOpacity={0.7}>
          <FontAwesome name="rotate-right" size={18} color={isLandscape ? Theme.accent : '#fff'} />
        </TouchableOpacity>
        <RNText style={styles.galleryCounter}>{currentIndex + 1} / {images.length}</RNText>
        {images.length > 1 && (
          <RNView style={[styles.galleryThumbStrip, { bottom: insets.bottom + 16 }]} pointerEvents="box-none">
            <FlatList
              ref={thumbStripRef}
              data={images}
              horizontal
              showsHorizontalScrollIndicator={false}
              keyExtractor={(_, i) => String(i)}
              contentContainerStyle={styles.galleryThumbStripContent}
              renderItem={({ item, index }) => (
                <GalleryThumb
                  image={item}
                  active={index === currentIndex}
                  onPress={() => {
                    setCurrentIndex(index);
                    flatListRef.current?.scrollToIndex({ index, animated: false });
                  }}
                />
              )}
            />
          </RNView>
        )}
      </RNView>
    </Modal>
  );
}

function CompactionSummaryBlock({ content }: { content: string }) {
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
            <RNText key={i} style={{ fontFamily: 'SpaceMono', fontSize: 11, color, backgroundColor: bg, lineHeight: 16 }}>
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

// Mobile port of web's CollapsibleBody: a machine-delivered body (trigger prompt,
// message from another session) is often a long briefing, so it starts clipped
// behind a fade with an Expand toggle. Web masks the content; RN has no mask, so
// the fade is an overlay and the caller passes the color it fades into.
const COLLAPSED_BODY_HEIGHT = 160;

function CollapsibleBody({ fadeColor, children }: { fadeColor: string; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // The tallest height this content has ever reported. Unlike the web, Yoga
  // pushes the clipping parent's maxHeight down into the child, so once clipped
  // the child re-reports the CLIPPED height — which reads as "fits", removes the
  // clip, restores the full height, and re-clips, forever. Latching the maximum
  // breaks that loop: the first layout is always unclipped and therefore true,
  // and later shrunken readings are ignored. Growth (streaming text) still wins.
  const naturalHeight = useRef(0);
  const onLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h <= naturalHeight.current) return;
    naturalHeight.current = h;
    setOverflows(h > COLLAPSED_BODY_HEIGHT + 8);
  };
  const clipped = overflows && !expanded;
  return (
    <RNView>
      <RNView style={clipped ? { maxHeight: COLLAPSED_BODY_HEIGHT, overflow: 'hidden' } : undefined}>
        <RNView onLayout={onLayout}>{children}</RNView>
        {clipped && (
          <LinearGradient colors={[fadeColor + '00', fadeColor]} style={styles.collapsibleFade} pointerEvents="none" />
        )}
      </RNView>
      {overflows && (
        <TouchableOpacity onPress={() => setExpanded((e) => !e)} style={styles.collapsibleToggle} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={11} color={Theme.textDim} />
          <RNText style={styles.collapsibleToggleText}>{expanded ? 'Collapse' : 'Expand'}</RNText>
        </TouchableOpacity>
      )}
    </RNView>
  );
}

// Mobile port of web's SessionMessageBlock: a cross-session `cast send` message
// is machine-delivered, not typed by the human, so it renders as a cyan-accented
// card naming the sender instead of a user bubble full of raw XML.
function SessionMessageBlock({ from, name, body, timestamp }: { from: string; name?: string; body: string; timestamp?: number }) {
  const hasRealSender = !!from && from !== 'unknown';
  return (
    <RNView style={styles.sessionMessageBlock}>
      <RNView style={styles.sessionMessageHeader}>
        <Feather name="corner-down-right" size={13} color={Theme.cyan + 'b3'} />
        <RNText style={styles.sessionMessageLabel}>Message from</RNText>
        {hasRealSender ? (
          // Resolves the sender's title server-side and taps through to the
          // session — same as web's EntityIdPill in this header.
          <EntityPill shortId={from} />
        ) : (
          <RNView style={styles.sessionMessageBadge}>
            <RNText style={styles.sessionMessageBadgeText}>{name || 'another session'}</RNText>
          </RNView>
        )}
        {timestamp != null && timestamp > 0 && (
          <RNText style={styles.sessionMessageTime}>{formatRelativeTime(timestamp)}</RNText>
        )}
      </RNView>
      <CollapsibleBody fadeColor={blendOver(Theme.cyan + '0d', Theme.bg)}>
        <MarkdownContent text={body} baseStyle={styles.sessionMessageBody} isUser={false} />
      </CollapsibleBody>
    </RNView>
  );
}

// Mobile port of web's ChatWakeBlock: a team-chat mention waking the anchor.
// Shows the channel, who asked, and the quoted thread by speaker; the briefing
// around the quote is for the agent, not the reader.
function ChatWakeBlock({ wake, timestamp }: { wake: ChatWakePrompt; timestamp?: number }) {
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
          <RNText style={[styles.sessionMessageBadgeText, { color: Theme.magenta }]}>#{wake.channelName}</RNText>
        </TouchableOpacity>
        <RNText style={styles.sessionMessageTitle} numberOfLines={1}>{wake.askerName}{wake.addressed ? ' mentioned you' : ' replied in a thread'}</RNText>
        {timestamp != null && timestamp > 0 && (
          <RNText style={styles.sessionMessageTime}>{formatRelativeTime(timestamp)}</RNText>
        )}
      </RNView>
      <CollapsibleBody fadeColor={blendOver(Theme.magenta + '0d', Theme.bg)}>
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

// Mobile port of web's ScheduledTaskBlock: a `cast trigger` prompt injection.
// (<scheduled-task> is the frozen pre-rename wire tag; old transcripts carry it.)
function ScheduledTaskBlock({ content: rawContent, timestamp }: { content: string; timestamp?: number }) {
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

function parseApiErrorContent(content?: string | null): { statusCode: number; message: string; errorType?: string; requestId?: string } | null {
  if (!content) return null;
  const trimmed = content.trim();
  const match = trimmed.match(/^API Error:\s*(\d{3})\s*([\s\S]*)$/i);
  if (!match) return null;
  const statusCode = Number(match[1]);
  const payloadText = (match[2] || '').trim();
  let message = '';
  let errorType: string | undefined;
  let requestId: string | undefined;
  if (payloadText.startsWith('{')) {
    try {
      const parsed = JSON.parse(payloadText);
      if (typeof parsed.request_id === 'string') requestId = parsed.request_id;
      const parsedError = parsed.error;
      if (parsedError && typeof parsedError === 'object') {
        if (typeof parsedError.type === 'string') errorType = parsedError.type;
        if (typeof parsedError.message === 'string') message = parsedError.message;
      }
    } catch {}
  }
  if (!requestId) requestId = trimmed.match(/\b(req_[A-Za-z0-9]+)\b/)?.[1];
  if (!message) message = statusCode === 500 ? 'Internal server error' : 'API request failed';
  return { statusCode, message, errorType, requestId };
}

function ApiErrorCard({ statusCode, message, errorType, requestId }: { statusCode: number; message: string; errorType?: string; requestId?: string }) {
  const isServer = statusCode >= 500;
  const color = isServer ? Theme.red : Theme.orange;
  return (
    <RNView style={[styles.apiErrorCard, { borderColor: color + '60' }]}>
      <RNView style={styles.apiErrorHeader}>
        <RNText style={[styles.apiErrorCode, { color }]}>{statusCode}</RNText>
        {errorType && <RNText style={[styles.apiErrorType, { color: color + 'cc' }]}>{errorType}</RNText>}
      </RNView>
      <RNText style={styles.apiErrorMessage}>{message}</RNText>
      {requestId && <RNText style={styles.apiErrorRequestId}>{requestId}</RNText>}
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
  const config = contextTypeConfig[ctx.type] || contextTypeConfig.doc;
  return (
    <RNView style={[styles.contextPill, { borderColor: config.color + '40' }]}>
      <FontAwesome name={config.icon} size={9} color={config.color} />
      <RNText style={[styles.contextPillText, { color: config.color }]} numberOfLines={1}>{ctx.title}</RNText>
      {ctx.id && <RNText style={styles.contextPillId}>{ctx.id}</RNText>}
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
    if (toolCall.name === 'Bash' && parsed.command) {
      // For Bash, just show the command
      inputDisplay = parsed.command;
    } else if (toolCall.name === 'StructuredOutput') {
      // The input IS the payload (a workflow subagent's typed return) — the
      // key/value flattening below drops nested objects, which is all of it.
      inputDisplay = JSON.stringify(parsed, null, 2);
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

  const isRead = toolCall.name === 'Read' || toolCall.name === 'file_read';
  const processedResult = result?.content ? (isRead ? stripLineNumbers(result.content) : result.content) : '';
  // StructuredOutput's success result is boilerplate ("Structured output
  // provided successfully") — the payload shown above it is the content.
  const hideResult = toolCall.name === 'StructuredOutput' && !result?.is_error;
  const resultDisplay = hideResult
    ? undefined
    : result && expanded && processedResult.length > 2000
      ? processedResult.slice(0, 2000) + '\n... (truncated)'
      : (processedResult || undefined);

  // Compute result summary like web does
  const getResultSummary = () => {
    if (!result) return null;
    if (result.is_error) return '(error)';
    const isEditOrWrite = toolCall.name === 'Edit' || toolCall.name === 'Write' || toolCall.name === 'file_edit' || toolCall.name === 'file_write' || toolCall.name === 'apply_patch';
    const isGlobGrep = toolCall.name === 'Glob' || toolCall.name === 'Grep' || toolCall.name === 'code_search' || toolCall.name === 'code_analysis';
    if (isEditOrWrite) {
      const match = result.content.match(/with (\d+) additions? and (\d+) removals?/);
      if (match) return `(+${match[1]} -${match[2]})`;
      return result.content.includes('has been updated') ? '(ok)' : '';
    }
    if (isRead) {
      const lines = result.content.split('\n').length;
      return `(${lines} lines)`;
    }
    if (isGlobGrep) {
      const lines = result.content.trim().split('\n').filter((l: string) => l.trim()).length;
      return `(${lines} matches)`;
    }
    if (isBash && result.content) {
      const lines = result.content.trim().split('\n').length;
      if (lines > 1) return `(${lines} lines)`;
    }
    if (toolCall.name === 'TaskList') {
      const taskLines = result.content.split('\n').filter((l: string) => l.match(/#\d+\s+\[/));
      if (taskLines.length > 0) return `(${taskLines.length} tasks)`;
    }
    return null;
  };
  const resultSummary = getResultSummary();

  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(toolCall.input); } catch {}

  const isBash = toolCall.name === 'Bash' || toolCall.name === 'shell_command' || toolCall.name === 'shell' || toolCall.name === 'exec_command' || toolCall.name === 'container.exec';
  const isEdit = toolCall.name === 'Edit' || toolCall.name === 'file_edit' || toolCall.name === 'apply_patch';
  const toolImage = images?.find(img => img.tool_use_id === toolCall.id)
    || globalImageMap?.[toolCall.id];
  const hasToolImage = !!toolImage;

  const isWrite = toolCall.name === 'Write' || toolCall.name === 'file_write';
  const filePath = String(parsedInput.file_path || parsedInput.path || '');
  const language = filePath ? getFileExtension(filePath) : undefined;
  const isCodeResult = result && (
    isBash ||
    toolCall.name === 'Read' ||
    toolCall.name === 'Write' ||
    toolCall.name === 'Edit' ||
    toolCall.name === 'Grep' ||
    toolCall.name === 'Glob' ||
    toolCall.name === 'file_read' ||
    toolCall.name === 'file_write' ||
    toolCall.name === 'file_edit' ||
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
  const [diffFullscreen, setDiffFullscreen] = useState(false);
  const [toolContentOverflowing, setToolContentOverflowing] = useState(false);
  const [toolContentFullExpanded, setToolContentFullExpanded] = useState(false);

  // Tools that shouldn't show their input (just noise)
  // Command is shown in summary, no need to repeat
  const shouldHideInput = [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'file_edit',
    'file_read',
    'file_write',
    'apply_patch',
    'TaskOutput',
    'TaskList',
    'TaskGet',
    'TaskStop',
    'TeamDelete',
    'ExitPlanMode',
    'EnterPlanMode',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    'web_search',
    'web_fetch',
    'code_search',
    'code_analysis',
    'shell_command',
    'shell',
    'exec_command',
    'container.exec',
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
      {hasToolImage && toolImage && (
        <RNView style={styles.toolImagesSection}>
          <ImageBlock image={toolImage} onPress={() => openGallery?.(toolImage)} />
        </RNView>
      )}
      {expanded && (
        <RNView
          onLayout={(e) => { if (!toolContentFullExpanded) setToolContentOverflowing(e.nativeEvent.layout.height >= TOOL_CONTENT_MAX_HEIGHT - 1); }}
          style={[styles.toolCallContent, result?.is_error && styles.toolCallContentError, !toolContentFullExpanded && { maxHeight: TOOL_CONTENT_MAX_HEIGHT, overflow: 'hidden' as const }]}>

          {language && !isBash && !(isEdit && parsedInput.old_string && parsedInput.new_string) && (
            <RNView style={styles.languageLabelRow}>
              <RNText style={styles.languageLabel}>{language}</RNText>
              {isPlan && (
                <RNView style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, backgroundColor: Theme.bgHighlight }}>
                  <RNText style={{ fontSize: 9, color: Theme.textMuted, fontWeight: '600', fontFamily: 'JetBrainsMono' }}>PLAN</RNText>
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
            <DiffBlock oldStr={String(parsedInput.old_string)} newStr={String(parsedInput.new_string)} filePath={filePath} />
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
          ) : toolCall.name === 'apply_patch' && (parsedInput.input || parsedInput.patch) ? (
            <CodeBlockWithCopy content={String(parsedInput.input || parsedInput.patch)} language="diff" />
          ) : null}
          {result && resultDisplay && resultDisplay.trim() && !(isEdit && parsedInput.old_string && parsedInput.new_string && !result.is_error) ? (
            <RNView style={styles.toolResultBox}>
              {canToggleViewMode && viewMode === 'rendered' ? (
                <MarkdownContent text={stripLineNumbers(resultDisplay)} baseStyle={styles.toolCallResult} isUser={false} />
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
          {/* Edits expand into a fullscreen scrollable modal instead of inline:
              a long diff expanded in place makes the transcript unscannable. */}
          <TouchableOpacity onPress={() => hasDiff ? setDiffFullscreen(true) : setToolContentFullExpanded(!toolContentFullExpanded)} activeOpacity={0.7}>
            <RNText style={{ fontSize: 11, color: Theme.cyan, fontWeight: '600' }}>{!hasDiff && toolContentFullExpanded ? 'Collapse' : 'Expand'}</RNText>
          </TouchableOpacity>
        </RNView>
      )}
      {hasDiff && (
        <DiffFullscreen
          oldStr={String(parsedInput.old_string)}
          newStr={String(parsedInput.new_string)}
          filePath={filePath}
          visible={diffFullscreen}
          onClose={() => setDiffFullscreen(false)}
        />
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

function SystemMessage({ message }: { message: Message }) {
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

  if (message.subtype === 'plan' && message.content) {
    return <PlanBlock content={message.content} timestamp={message.timestamp} />;
  }

  if (message.subtype === 'pull_request' && message.content) {
    const prContent = message.content;
    const prMatch = prContent.match(/^#(\d+)\s+(.*)/);
    const prNum = prMatch ? prMatch[1] : '';
    const prTitle = prMatch ? prMatch[2] : prContent;
    return (
      <RNView style={styles.prCard}>
        <FontAwesome name="code-fork" size={11} color={Theme.violet} style={{ marginRight: 6 }} />
        <RNText style={styles.prNumber}>#{prNum}</RNText>
        <RNText style={styles.prTitle} numberOfLines={1}>{prTitle}</RNText>
        <RNText style={styles.commitTime}>{formatTimestamp(message.timestamp)}</RNText>
      </RNView>
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

  if (message.subtype === 'stop_hook_summary' || message.subtype === 'local_command') {
    const label = message.subtype === 'stop_hook_summary' ? 'hook' : 'command';
    const content = message.content?.slice(0, 200) || '';
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

  return (
    <RNView style={styles.systemMessage}>
      {message.subtype && (
        <RNText style={styles.systemSubtypeLabel}>{message.subtype.replace(/_/g, ' ')}</RNText>
      )}
      <RNText style={styles.systemMessageText} numberOfLines={2}>{content}</RNText>
    </RNView>
  );
}

function assistantLabel(agentType?: string): string {
  if (agentType === 'codex') return 'Codex';
  if (agentType === 'cursor') return 'Cursor';
  if (agentType === 'gemini') return 'Gemini';
  if (agentType === 'opencode') return 'OpenCode';
  if (agentType === 'pi') return 'pi';
  if (agentType === 'grok') return 'Grok';
  return 'Claude';
}

function formatTokenCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

function UsageBar({ usage }: { usage: UsageData }) {
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

function CommandStatusLine({ content, timestamp }: { content: string; timestamp: number }) {
  const cmdType = getCommandType(content);
  const displayText = cleanCommandContent(content).slice(0, 100) || content.replace(/<[^>]+>/g, '').slice(0, 100);

  return (
    <RNView style={styles.commandStatusLine}>
      <RNText style={styles.commandStatusTime}>{formatRelativeTime(timestamp)}</RNText>
      <RNView style={styles.commandStatusBadge}>
        <RNText style={styles.commandStatusBadgeText}>{cmdType}</RNText>
      </RNView>
      <RNText style={styles.commandStatusText} numberOfLines={1}>{displayText}</RNText>
    </RNView>
  );
}

// --- Workflow events (mobile twin of web's WorkflowEventBlock) ---
// The server posts workflow lifecycle anchors as JSON message content
// (convex/workflow_runs.ts). Fork/resume can round-trip them without the
// workflow_event subtype, so detect by content shape, matching web.
function parseWorkflowEventContent(content: string | undefined): Record<string, any> | null {
  if (!content || !content.startsWith('{"__wf"')) return null;
  try { return JSON.parse(content); } catch { return null; }
}

const WF_NODE_COLORS: Record<string, string> = {
  agent: Theme.green,
  command: Theme.accent,
  human: Theme.magenta,
  prompt: Theme.violet,
};

function WorkflowGateCard({ event }: { event: Record<string, any> }) {
  const runId = typeof event.run_id === 'string' ? event.run_id : null;
  const run = useQuery(
    api.workflow_runs.get,
    runId && isConvexId(runId) ? { id: runId as Id<'workflow_runs'> } : 'skip'
  ) as { _id: string; status: string } | null | undefined;
  const respondToGate = useMutation(api.workflow_runs.respondToGate);
  const [responding, setResponding] = useState(false);

  const choices = (event.choices ?? []) as Array<{ key: string; label: string }>;
  const waiting = run?.status === 'paused';

  const choose = async (key: string) => {
    if (!run || responding) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setResponding(true);
    try { await respondToGate({ id: run._id as Id<'workflow_runs'>, response: key }); }
    catch { /* stays waiting; user can retry */ }
    finally { setResponding(false); }
  };

  return (
    <RNView style={styles.wfGateCard}>
      <RNView style={styles.wfGateHeader}>
        <FontAwesome name="question-circle" size={12} color={Theme.magenta} />
        <RNText style={styles.wfGateHeaderText}>HUMAN GATE</RNText>
        <RNText style={[styles.wfGateStatus, { color: waiting ? Theme.magenta : Theme.green }]}>
          {waiting ? 'waiting…' : 'responded'}
        </RNText>
      </RNView>
      {!!event.prompt && <RNText style={styles.wfGatePrompt}>{event.prompt}</RNText>}
      {waiting && choices.length > 0 && (
        <RNView style={styles.wfGateChoices}>
          {choices.map((c) => (
            <TouchableOpacity
              key={c.key}
              style={[styles.wfGateChoice, responding && { opacity: 0.4 }]}
              onPress={() => choose(c.key)}
              disabled={responding}
              activeOpacity={0.7}
            >
              <RNText style={styles.wfGateChoiceKey}>[{c.key}]</RNText>
              <RNText style={styles.wfGateChoiceLabel}>{String(c.label ?? '').replace(/^\[.\]\s*/, '')}</RNText>
            </TouchableOpacity>
          ))}
        </RNView>
      )}
    </RNView>
  );
}

function WorkflowEventBlock({ event }: { event: Record<string, any> }) {
  const router = useRouter();
  const wf = event.__wf as string;

  if (wf === 'started') {
    return (
      <RNView style={styles.wfStartedRow}>
        <FontAwesome name="bolt" size={11} color={Theme.violet} />
        <RNText style={styles.wfStartedText} numberOfLines={2}>
          Workflow started{event.goal ? ` — ${event.goal}` : ''}
        </RNText>
      </RNView>
    );
  }

  if (wf === 'node_start' || wf === 'node_done' || wf === 'node_failed') {
    const color = WF_NODE_COLORS[event.node_type as string] || WF_NODE_COLORS.agent;
    const label = event.node_label || event.node_id;
    return (
      <RNView style={styles.wfNodeRow}>
        {wf === 'node_done' && <FontAwesome name="check" size={10} color={Theme.greenBright} />}
        {wf === 'node_failed' && <FontAwesome name="times" size={10} color={Theme.red} />}
        {wf === 'node_start' && <RNView style={styles.wfNodePulse} />}
        <RNView style={[styles.wfNodeTypeBadge, { backgroundColor: color + '20', borderColor: color + '50' }]}>
          <RNText style={[styles.wfNodeTypeText, { color }]}>{event.node_type || 'agent'}</RNText>
        </RNView>
        <RNText style={styles.wfNodeLabel} numberOfLines={1}>{label}</RNText>
        {!!event.session_id && (
          <TouchableOpacity onPress={() => router.push(`/session/${event.session_id}`)} hitSlop={8}>
            <RNText style={styles.wfNodeLink}>view</RNText>
          </TouchableOpacity>
        )}
      </RNView>
    );
  }

  if (wf === 'workflow_run') {
    return (
      <RNView style={styles.wfRunCard}>
        <FontAwesome name="sitemap" size={12} color={Theme.violet} />
        <RNView style={{ flex: 1, minWidth: 0 }}>
          <RNText style={styles.wfRunName} numberOfLines={1}>{event.name || 'Workflow run'}</RNText>
          {!!event.external_run_id && (
            <RNText style={styles.wfRunId} numberOfLines={1}>{event.external_run_id}</RNText>
          )}
        </RNView>
      </RNView>
    );
  }

  if (wf === 'gate') return <WorkflowGateCard event={event} />;

  return null;
}

function MessageBubble({ message, agentType, model, showHeader = true, forkChildren, conversationId, onFork, taskSubjectMap, globalToolResultMap, globalImageMap, openGallery, userName, showToast, collapsed: globalCollapsed, childConversationMap, bookmarkedSet }: {
  message: Message;
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
  const router = useRouter();
  const [expandedTools, setExpandedTools] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    message.tool_calls?.forEach(tc => {
      if (tc.name === 'Edit' || tc.name === 'Write' || tc.name === 'file_edit' || tc.name === 'file_write' || tc.name === 'apply_patch') {
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
  const toggleBookmark = useMutation(api.bookmarks.toggleBookmark);
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
        try {
          const result = await toggleBookmark({
            conversation_id: conversationId as Id<"conversations">,
            message_id: message._id as Id<"messages">,
          });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          showToast?.(result ? 'Bookmarked' : 'Bookmark removed');
        } catch {}
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
    return <SystemMessage message={message} />;
  }

  const isUser = message.role === 'user';
  const hasToolResults = message.tool_results && message.tool_results.length > 0;

  if (hasToolResults && !message.content) {
    return null;
  }

  if (isUser && message.content && isCommandMessage(message.content)) {
    return <CommandStatusLine content={message.content} timestamp={message.timestamp} />;
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

  const handleTapToExpand = () => {
    if (globalCollapsed && !localExpanded) {
      setLocalExpanded(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  return (
    <Pressable onLongPress={handleLongPress} onPress={globalCollapsed && !localExpanded ? handleTapToExpand : undefined}>
      <RNView
        style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble, showHeader && !isUser && styles.assistantBubbleFirst, isToolCallOnly && styles.toolCallOnlyBubble]}>
        {showHeader && !isToolCallOnly && (
        <RNView style={styles.bubbleHeader}>
          {isUser ? (
            <RNView style={styles.userAvatar}>
              <RNText style={styles.userAvatarText}>{(userName || 'Y')[0].toUpperCase()}</RNText>
            </RNView>
          ) : agentType ? (
            <RNView style={[styles.agentDot, { backgroundColor: agentTypeColor(agentType) }]} />
          ) : null}
          <RNText style={[styles.bubbleRole, isUser ? styles.userRole : styles.assistantRole]}>
            {isUser ? (userName || 'You') : assistantLabel(agentType)}
          </RNText>
          {!isUser && model && showHeader && (
            <RNText style={styles.modelBadge}>{formatModel(model)}</RNText>
          )}
          <Pressable onPress={() => { Clipboard.setString(formatFullTimestamp(message.timestamp)); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); showToast?.('Timestamp copied'); }}>
            <RNText style={[styles.bubbleTime, isUser ? styles.userTime : styles.assistantTime]}>{formatRelativeTime(message.timestamp)}</RNText>
          </Pressable>
          {isBookmarked && (
            <FontAwesome name="bookmark" size={10} color="#d97706" style={{ marginLeft: 2 }} />
          )}
        </RNView>
      )}

      {/* Collapsed feed hides thinking to cut noise — EXCEPT a pure-reasoning turn,
          where thinking is the only content and hiding it leaves an empty bubble. */}
      {hasThinking && (!effectiveCollapsed || (!content.trim() && !hasToolCalls && !hasImages)) && (
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
            styles.bubbleContent,
            isLongContent && !contentExpanded && styles.bubbleContentCollapsed,
            !isUser && !contentExpanded && !isLongContent && estimatedOverflow && { maxHeight: ASSISTANT_CONTENT_MAX_HEIGHT, overflow: 'hidden' as const },
            isUser && !userContentExpanded && !isLongContent && estimatedOverflow && { maxHeight: ASSISTANT_CONTENT_MAX_HEIGHT, overflow: 'hidden' as const },
          ]}
        >
          {(() => {
            if (typeof content !== 'string') {
              return <MarkdownContent text={content} baseStyle={[styles.bubbleText, isUser ? styles.userText : styles.assistantText]} isUser={isUser} />;
            }
            const apiError = parseApiErrorContent(content);
            if (apiError) {
              return <ApiErrorCard {...apiError} />;
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
                  : <MarkdownContent key={idx} text={part.content} baseStyle={[styles.bubbleText, isUser ? styles.userText : styles.assistantText]} isUser={isUser} />
              );
            }
            if (content.includes('<teammate-message')) {
              return parseTeammateMessages(content).map((part, idx) =>
                part.type === 'text'
                  ? <MarkdownContent key={idx} text={part.content} baseStyle={[styles.bubbleText, isUser ? styles.userText : styles.assistantText]} isUser={isUser} />
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
            return <MarkdownContent text={content} baseStyle={[styles.bubbleText, isUser ? styles.userText : styles.assistantText]} isUser={isUser} />;
          })()}
          {((isLongContent && !contentExpanded) || (!isUser && estimatedOverflow && !contentExpanded) || (isUser && estimatedOverflow && !userContentExpanded)) && (
            <LinearGradient
              colors={[isUser ? Theme.violet + '00' : Theme.bg + '00', isUser ? Theme.violet + '26' : Theme.bg]}
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

      {hasToolCalls && (
        <RNView style={isToolCallOnly ? styles.toolCallsCompact : styles.toolCallsContainer}>
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
            if (tc.name === 'Task') {
              return <TaskToolBlock key={tc.id} tool={tc} result={result} childConversationId={message.message_uuid && childConversationMap ? childConversationMap[message.message_uuid] : undefined} />;
            }
            if (tc.name === 'AskUserQuestion') {
              return <AskUserQuestionBlock key={tc.id} tool={tc} result={result} conversationId={conversationId} />;
            }
            if (tc.name === 'TodoWrite') {
              return <TodoWriteBlock key={tc.id} tool={tc} />;
            }
            if (tc.name === 'TaskList' && result) {
              return <TaskListBlock key={tc.id} result={result} />;
            }
            if (tc.name === 'TaskCreate' || tc.name === 'TaskUpdate' || tc.name === 'TaskGet') {
              return <TaskCreateUpdateBlock key={tc.id} tool={tc} result={result} taskSubjectMap={taskSubjectMap} />;
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
            if (tc.name === 'EnterPlanMode') {
              return (
                <RNView key={tc.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2 }}>
                  <FontAwesome name="map-o" size={10} color={Theme.violet} />
                  <RNText style={{ fontSize: 11, fontFamily: 'JetBrainsMono', color: Theme.violet, fontWeight: '600' }}>Plan Mode</RNText>
                  <RNView style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: 'rgba(108, 113, 196, 0.15)', borderWidth: 0.5, borderColor: 'rgba(108, 113, 196, 0.3)' }}>
                    <RNText style={{ fontSize: 9, color: Theme.violet, fontFamily: 'JetBrainsMono' }}>enter</RNText>
                  </RNView>
                </RNView>
              );
            }
            if (tc.name === 'ExitPlanMode') {
              return (
                <RNView key={tc.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2 }}>
                  <FontAwesome name="map-o" size={10} color={Theme.violet} />
                  <RNText style={{ fontSize: 11, fontFamily: 'JetBrainsMono', color: Theme.violet, fontWeight: '600' }}>Plan Mode</RNText>
                  <RNView style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: 'rgba(108, 113, 196, 0.15)', borderWidth: 0.5, borderColor: 'rgba(108, 113, 196, 0.3)' }}>
                    <RNText style={{ fontSize: 9, color: Theme.violet, fontFamily: 'JetBrainsMono' }}>exit</RNText>
                  </RNView>
                </RNView>
              );
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
        </RNView>
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
              <RNText style={styles.messageFullscreenRole}>{isUser ? (userName || 'You') : assistantLabel(agentType)}</RNText>
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

// Agent statuses surfaced in the composer, with their tint and label. Statuses
// not listed here (idle, disconnected) render nothing.
const AGENT_STATUS_META: Record<string, { color: string; label: string }> = {
  working: { color: Theme.greenBright, label: 'Working' },
  thinking: { color: Theme.violet, label: 'Thinking' },
  compacting: { color: '#f59e0b', label: 'Compacting' },
  waiting: { color: Theme.blue, label: 'Waiting' },
  permission_blocked: { color: Theme.orange, label: 'Needs Input' },
  connected: { color: Theme.cyan, label: 'Connected' },
};

function MessageInput({ conversationId, isActive, draft, autoFocus }: { conversationId: Id<"conversations">; isActive: boolean; draft?: string | null; autoFocus?: boolean }) {
  const insets = useSafeAreaInsets();
  const { height: winHeight } = useWindowDimensions();
  const inputRef = useRef<NativeTextInput>(null);
  const [expanded, setExpanded] = useState(false);
  // Content height of the inline input; the fullscreen affordance only appears
  // once the text actually wraps, so a one-liner keeps the card minimal.
  const [inputHeight, setInputHeight] = useState(0);

  // Focus after the push animation settles — focusing mid-transition on iOS
  // either drops the keyboard or stutters the navigation.
  useEffect(() => {
    if (!autoFocus) return;
    const task = InteractionManager.runAfterInteractions(() => inputRef.current?.focus());
    return () => task.cancel();
  }, [autoFocus]);
  // Seed from the local-first store draft first (survives the stub→real rekey on
  // freshly-created sessions), then fall back to the server-synced draft prop.
  const [message, setMessage] = useState<string>(
    () => useInboxStore.getState().getDraft(conversationId)?.draft_message ?? draft ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const [selectedImages, setSelectedImages] = useState<{ uri: string; storageId?: string; uploading: boolean }[]>([]);
  // Mirrors the web composer's pastedImagesRef: the `[Image N]` token paths
  // need each image's current position, and a state read inside an async
  // callback or a state updater would be stale (or double-fire in StrictMode).
  const selectedImagesRef = useRef(selectedImages);
  selectedImagesRef.current = selectedImages;
  const managedSessionQ = useQuery(
    api.managedSessions.isSessionManaged,
    isConvexId(conversationId as string) ? { conversation_id: conversationId } : "skip"
  );
  // The design-mock session fakes a working agent so the footer status chip is
  // reviewable without server data (see DESIGN_MOCK_CONVO).
  const managedSession = (conversationId as string) === '__designmock__'
    ? { managed: true as const, agent_status: 'working' }
    : managedSessionQ;

  const patchConversation = useMutation(api.conversations.patchConversation);
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);

  const draftRef = useRef(useInboxStore.getState().getDraft(conversationId)?.draft_message ?? draft ?? '');
  // The debounced server write of the draft. handleSend cancels it directly:
  // the effect cleanup only runs on the next React commit, and on a streaming
  // session a contended JS thread can let the timer fire first — persisting the
  // just-sent text AFTER the send's clear, so it reappears on the next mount.
  const draftPatchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!message && !draftRef.current) return;
    if (message === draftRef.current) return;
    draftRef.current = message;
    // Local-first draft: write through the store so it survives the stub→real
    // rekey on a freshly-created session (the id is a non-Convex stub for ~1s).
    // setDraft/clearDraft resolve stub ids; patchConversation would throw an
    // ArgumentValidationError on a stub id (v.id) and silently lose the draft.
    const store = useInboxStore.getState();
    if (message) store.setDraft(conversationId, { draft_message: message });
    else store.clearDraft(conversationId);
    clearTimeout(draftPatchTimerRef.current);
    draftPatchTimerRef.current = setTimeout(() => {
      // Server persistence only once the id is real; the store-resolved draft
      // is dispatched through the outbox on rekey regardless.
      if (isConvexId(conversationId as string)) {
        patchConversation({ id: conversationId, fields: { draft_message: message || null } }).catch(() => {});
      }
    }, 1000);
    return () => clearTimeout(draftPatchTimerRef.current);
  }, [message, conversationId]);

  const uploadToStorage = async (uri: string) => {
    const uploadUrl = await generateUploadUrl({});
    const response = await fetch(uri);
    const blob = await response.blob();
    const uploadResult = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": blob.type || "image/jpeg" },
      body: blob,
    });
    const { storageId } = await uploadResult.json();
    return storageId as string;
  };

  // Drops the image and its `[Image N]` token, renumbering the tokens above it
  // so what's left still points at the attachments the agent will receive.
  const removeImage = (uri: string) => {
    const index = selectedImagesRef.current.findIndex(img => img.uri === uri);
    if (index < 0) return;
    selectedImagesRef.current = selectedImagesRef.current.filter(img => img.uri !== uri);
    setSelectedImages(selectedImagesRef.current);
    setMessage(m => dropImagePlaceholder(m, index + 1));
  };

  const pickImage = async () => {
    if (!ImagePicker) {
      Alert.alert('Not available', 'Image uploads require a development build with expo-image-picker.');
      return;
    }
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Please grant photo library access to attach images');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 0.8,
      });
      if (!result.canceled && result.assets) {
        for (const asset of result.assets) {
          const uri = asset.uri;
          // Ref-first so a multi-pick batch numbers sequentially: the state
          // updates are async, so `selectedImages` is still the old array here.
          selectedImagesRef.current = [...selectedImagesRef.current, { uri, uploading: true }];
          setSelectedImages(selectedImagesRef.current);
          // Token numbers follow attach order, which is the order the agent
          // receives the images in — so `[Image 2]` is a real reference.
          setMessage(m => insertImagePlaceholder(m, m.length, selectedImagesRef.current.length).text);
          uploadToStorage(uri).then(storageId => {
            setSelectedImages(prev => prev.map(img => img.uri === uri ? { ...img, storageId, uploading: false } : img));
          }).catch(() => {
            removeImage(uri);
            Alert.alert('Upload failed', 'Could not upload image');
          });
        }
      }
    } catch (err) {
      console.error('Image picker error:', err);
    }
  };

  // The optimistic-send core, shared by the composer's send button and the
  // suggestion pills (which send fixed text with no attachments): pending row
  // in the store instantly, fire-and-forget delivery via the outbox.
  const dispatchSend = (content: string, storageIds?: string[]) => {
    const store = useInboxStore.getState();
    const images = storageIds?.length
      ? storageIds.map(sid => ({ media_type: 'image/jpeg', storage_id: sid }))
      : undefined;
    const clientId = store.addOptimisticMessage(conversationId, content, images);
    store.sendMessage(conversationId, content, storageIds?.length ? storageIds : undefined, clientId);
  };

  // Optimistic, non-blocking send (mirrors web ContextChatInput). The message
  // is added to the store as pending and rendered instantly; sendMessage is
  // fire-and-forget (rides the store outbox, dedups on client_id). The input
  // clears synchronously — no await, no spinner, no lock.
  const handleSend = () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && selectedImages.length === 0) return;

    if (selectedImages.some(img => img.uploading)) {
      setError('Images still uploading...');
      return;
    }
    setError(null);

    const storageIds = selectedImages.filter(img => img.storageId).map(img => img.storageId!);
    const content = trimmedMessage || (storageIds.length > 0 ? '[image]' : '');

    // Clear the input immediately so the screen never feels blocked.
    clearTimeout(draftPatchTimerRef.current);
    setMessage('');
    draftRef.current = '';
    setSelectedImages([]);
    // Clear the draft both locally and on the server. Without the local clear,
    // a restart-right-after-send would re-hydrate the stale draft (cache-first).
    // clearDraft resolves stub ids; the server patch is gated on a real id.
    // clearDraftFinal (not clearDraft) — the web send path: it dispatches the
    // clear through the outbox (client_state draft + the durable conversation
    // row), so a cached-row push can't re-seed the composer on the next mount.
    // syncRecord covers stub ids, which clearDraftFinal's row-clear skips.
    const store = useInboxStore.getState();
    store.clearDraftFinal(conversationId);
    store.syncRecord('conversations', conversationId, { draft_message: null });
    if (isConvexId(conversationId as string)) {
      patchConversation({ id: conversationId, fields: { draft_message: null } }).catch(() => {});
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Sending is a completed gesture — give the conversation the screen back.
    setExpanded(false);
    Keyboard.dismiss();

    dispatchSend(content, storageIds);
  };

  const canSend = !!message.trim() || selectedImages.length > 0;

  // Shared between the inline card and the fullscreen editor so both modes show
  // the same attachments/errors and drive the same send.
  const errorBannerEl = error ? (
    <RNView style={styles.errorBanner}>
      <RNText style={styles.errorBannerText}>{error}</RNText>
      <TouchableOpacity onPress={() => setError(null)}>
        <RNText style={styles.errorBannerDismiss}>x</RNText>
      </TouchableOpacity>
    </RNView>
  ) : null;

  const imageStripEl = selectedImages.length > 0 ? (
    <ScrollView horizontal style={styles.imagePreviewContainer} showsHorizontalScrollIndicator={false}>
      {selectedImages.map((img, index) => (
        <RNView key={index} style={styles.imagePreview}>
          <Image source={{ uri: img.uri }} style={styles.previewImage} />
          {img.uploading && (
            <RNView style={styles.imageUploadingOverlay}>
              <ActivityIndicator size="small" color="#fff" />
            </RNView>
          )}
          <TouchableOpacity
            style={styles.removeImageButton}
            onPress={() => removeImage(img.uri)}
            activeOpacity={0.7}
          >
            <FontAwesome name="times-circle" size={20} color={Theme.red} />
          </TouchableOpacity>
        </RNView>
      ))}
    </ScrollView>
  ) : null;

  // Status lives in the otherwise-empty middle of the button row: zero extra
  // height, and it can never overlap the conversation.
  const statusMeta = managedSession?.managed
    ? AGENT_STATUS_META[managedSession.agent_status ?? '']
    : undefined;

  const actionsRowEl = (
    <RNView style={styles.composerActions}>
      <TouchableOpacity style={styles.imageButton} onPress={pickImage} activeOpacity={0.7}>
        <FontAwesome name="plus" size={18} color={Theme.textMuted} />
      </TouchableOpacity>
      <RNView style={styles.composerSpacer}>
        {statusMeta && (
          <RNView style={styles.composerStatus}>
            <PulsingDot color={statusMeta.color} />
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.composerStatusText, { color: statusMeta.color }]}>
              {statusMeta.label}
            </RNText>
          </RNView>
        )}
      </RNView>
      <TouchableOpacity
        style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
        onPress={handleSend}
        disabled={!canSend}
        activeOpacity={0.7}
      >
        <FontAwesome name="arrow-up" size={14} color="#fff" />
      </TouchableOpacity>
    </RNView>
  );

  const placeholder = isActive ? "Type a message..." : "Send to resume session...";

  // Suggestion pills (off-by-default pref, same stamped key as web). Idle =
  // the agent is not actively producing; a pill tap sends its text directly
  // through the shared dispatch, long-press fills the composer instead.
  const suggestionsEnabled = useInboxStore((s) => s.clientState?.ui?.composer_suggestions === true);
  const agentStatus = managedSession?.managed ? managedSession.agent_status : undefined;

  return (
    <RNView style={[styles.inputContainer, { paddingBottom: insets.bottom || 12 }]}>
      {errorBannerEl}
      {imageStripEl}
      {suggestionsEnabled && (
        <SuggestionPills
          conversationId={conversationId}
          idle={!(agentStatus && ACTIVE_AGENT_STATUSES.has(agentStatus))}
          hidden={!!message.trim() || selectedImages.length > 0}
          onSend={(t) => dispatchSend(t)}
          onEdit={(t) => { setMessage(t); inputRef.current?.focus(); }}
        />
      )}
      <RNView style={styles.composerCard}>
        <TextInput
          ref={inputRef}
          style={[
            styles.textInput,
            // Grow with the text up to a third of the screen; beyond that it scrolls.
            { maxHeight: Math.round(winHeight * 0.33) },
            inputHeight > 44 && styles.textInputWithExpand,
          ]}
          value={message}
          onChangeText={setMessage}
          placeholder={placeholder}
          placeholderTextColor={Theme.textMuted0}
          multiline
          maxLength={10000}
          blurOnSubmit={false}
          maxFontSizeMultiplier={CHROME_FONT_CAP}
          onContentSizeChange={(e) => setInputHeight(e.nativeEvent.contentSize.height)}
        />
        {inputHeight > 44 && (
          <TouchableOpacity
            style={styles.expandButton}
            onPress={() => setExpanded(true)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Expand composer to full screen"
          >
            <FontAwesome name="expand" size={12} color={Theme.textMuted} />
          </TouchableOpacity>
        )}
        {actionsRowEl}
      </RNView>

      <Modal visible={expanded} animationType="slide" onRequestClose={() => setExpanded(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.expandedContainer}
        >
          <RNView style={[styles.expandedInner, { paddingTop: insets.top + 6, paddingBottom: insets.bottom || 12 }]}>
            <RNView style={styles.expandedHeader}>
              <TouchableOpacity
                style={styles.expandButtonStatic}
                onPress={() => setExpanded(false)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Collapse composer"
              >
                <FontAwesome name="compress" size={13} color={Theme.textMuted} />
              </TouchableOpacity>
            </RNView>
            {errorBannerEl}
            {imageStripEl}
            <TextInput
              style={styles.expandedInput}
              value={message}
              onChangeText={setMessage}
              placeholder={placeholder}
              placeholderTextColor={Theme.textMuted0}
              multiline
              autoFocus
              maxLength={10000}
              blurOnSubmit={false}
              maxFontSizeMultiplier={CHROME_FONT_CAP}
            />
            {actionsRowEl}
          </RNView>
        </KeyboardAvoidingView>
      </Modal>
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
const HEADER_BAR_HEIGHT = 40;

function TreeNodeView({ node, depth, router, currentId, onClose }: { node: TreeNode; depth: number; router: any; currentId: string; onClose: () => void }) {
  const isCurrent = node.id === currentId || node.is_current;
  const date = new Date(node.started_at);
  const timeStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <>
      <Pressable onPress={() => { if (!isCurrent) { onClose(); router.push(`/session/${node.id}`); } }} style={[styles.treeNode, { paddingLeft: depth * 16 + 12 }, isCurrent && styles.treeNodeCurrent]}>
        {depth > 0 && <RNText style={styles.treeNodePrefix}>+-</RNText>}
        {isCurrent && <FontAwesome name="circle" size={6} color={Theme.violet} style={{ marginRight: 4 }} />}
        <RNText style={[styles.treeNodeTitle, isCurrent && { color: Theme.violet }]} numberOfLines={1}>{node.title}</RNText>
        <RNText style={styles.treeNodeMeta}>{node.message_count} msgs</RNText>
        <RNText style={styles.treeNodeMeta}>{timeStr}</RNText>
      </Pressable>
      {node.children.map(child => (<TreeNodeView key={child.id} node={child} depth={depth + 1} router={router} currentId={currentId} onClose={onClose} />))}
    </>
  );
}

export default function SessionDetailScreen() {
  const { id, message: highlightMessageParam, focus: focusParam } = useLocalSearchParams<{ id: string; message?: string; focus?: string }>();
  // Wire the store's server dispatch (idempotent — just sets a ref). The inbox
  // tab mounts useSyncInboxSessions and stays mounted under this pushed screen,
  // so dispatch is usually already wired; but a cold deep-link can reach this
  // screen before any tab mounts, and without this store.sendMessage would
  // dispatch to a no-op. We wire ONLY dispatch here (not the inbox
  // subscriptions/soundIdle that useSyncInboxSessions owns) to avoid duplicate
  // subscriptions and double-firing idle sounds.
  useEnsureDispatch();

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

  const flatListRef = useRef<FlatList>(null);
  const loadCooldownRef = useRef(false);
  const [initialScrollDone, setInitialScrollDone] = useState(false);
  const [userScrolled, setUserScrolled] = useState(false);
  const [isNearTop, setIsNearTop] = useState(true);
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
  const activePulse = useRef(new Animated.Value(1)).current;
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

  const conversation = (storeConversation as ConversationData | null)
    ?? (id === DESIGN_MOCK_ID ? DESIGN_MOCK_CONVO : undefined);

  // Gate every server query that takes a v.id("conversations") on isConvexId. A
  // freshly created session navigates here under a local stub id (see
  // beginOptimisticSession) BEFORE the real Convex id exists; firing these with
  // the stub throws an ArgumentValidationError server-side and crashes the
  // screen. The shared useConversationMessages hook already gates itself this
  // way — these screen-local queries need the same guard. Once the create
  // resolves and rekeys the URL to the real id, they activate automatically.
  const isReal = typeof id === "string" && isConvexId(id);

  // git_diff blobs live off the conversation doc now; fetch them lazily (only
  // when the diff panel is open) via the dedicated side-table query.
  const gitDiffData = useQuery(
    api.conversations.getConversationGitDiff,
    diffExpanded && isReal ? { conversation_id: id as Id<"conversations"> } : "skip"
  );

  const pendingPermissions = useQuery(
    api.permissions.getPendingPermissions,
    isReal ? { conversation_id: id as Id<"conversations"> } : "skip"
  );

  const bookmarkedMessageIds = useQuery(
    api.bookmarks.getConversationBookmarks,
    isReal ? { conversation_id: id as Id<"conversations"> } : "skip"
  );
  const bookmarkedSet = useMemo(() => new Set(bookmarkedMessageIds?.map(id => id.toString()) || []), [bookmarkedMessageIds]);

  const commits = useQuery(
    api.commits.getCommitsForConversation,
    isReal ? { conversation_id: id as Id<"conversations"> } : "skip"
  ) as Array<{
    _id: string; sha: string; message: string; timestamp: number;
    files_changed: number; insertions: number; deletions: number;
  }> | undefined;

  const pullRequests = useQuery(
    api.pull_requests.getPRsForConversation,
    isReal ? { conversation_id: id as Id<"conversations"> } : "skip"
  ) as Array<{
    _id: string; number: number; title: string; state: string;
    repository: string; additions?: number; deletions?: number;
    created_at: number; merged_at?: number;
  }> | undefined;

  const treeResult = useQuery(
    api.conversations.getConversationTree,
    isReal ? { conversation_id: id as string } : "skip"
  ) as { tree: TreeNode } | { error: string } | null | undefined;

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
        });
      }
    }
    if (synthetic.length === 0) return msgs;
    const merged = [...msgs, ...synthetic];
    merged.sort((a, b) => a.timestamp - b.timestamp);
    return merged;
  }, [conversation?.messages, commits, pullRequests]);

  const invertedMessages = useMemo(() => [...allMessages].reverse(), [allMessages]);

  const forkFromMessage = useMutation(api.conversations.forkFromMessage);
  const router = useRouter();
  const insets = useSafeAreaInsets();

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

  const taskSubjectMap = useMemo(() => {
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
  }, [allMessages]);

  const globalToolResultMap = useMemo(() => {
    const map: Record<string, ToolResult> = {};
    for (const msg of allMessages) {
      if (msg.role === 'user' && msg.tool_results) {
        for (const tr of msg.tool_results) {
          map[tr.tool_use_id] = tr;
        }
      }
    }
    return map;
  }, [allMessages]);

  const globalImageMap = useMemo(() => {
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
  }, [allMessages]);

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
  const openGallery = useCallback((image: ImageData) => {
    const key = imageKeyOf(image);
    const idx = key ? allSessionImages.findIndex(img => imageKeyOf(img) === key) : -1;
    setGalleryIndex(Math.max(0, idx));
    setGalleryVisible(true);
  }, [allSessionImages]);

  const handleForkFromMessage = useCallback(async (messageUuid: string) => {
    if (!id) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const result = await forkFromMessage({
        conversation_id: id as string,
        message_uuid: messageUuid,
      });
      if (result?.conversation_id) {
        router.push(`/session/${result.conversation_id}`);
      }
    } catch (e: any) {
      Alert.alert('Fork failed', e?.message || 'Could not fork conversation');
    }
  }, [id, forkFromMessage, router]);

  const [treeModalVisible, setTreeModalVisible] = useState(false);

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
              const url = `https://codecast.sh/share/${token}`;
              Clipboard.setString(url);
              showToast('Share link copied');
            }
          } else if (label === 'Share Link via...') {
            const url = `https://codecast.sh/share/${conversation.share_token}`;
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

  // Comment counts per message, the same enrichment the web popover shows.
  // Plain useQuery gated on isReal, matching every other enrichment query on
  // this screen; rows render without counts until it lands.
  const commentSummary = useQuery(
    api.comments.getConversationCommentSummary,
    isReal ? { conversation_id: id as Id<"conversations"> } : "skip"
  );
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
    const indices: number[] = [];
    for (let i = 0; i < allMessages.length; i++) {
      const m = allMessages[i];
      if (m.role === 'user' && m.content && isStickyEligible(m.content)) indices.push(i);
    }
    return indices;
  }, [allMessages]);
  const stickyIndicesRef = useRef(stickyIndices);
  stickyIndicesRef.current = stickyIndices;

  // The latest prompt ABOVE the loaded window, for when the reader scrolled
  // past every loaded prompt (web's serverStickyFallback).
  const stickyFallback = useMemo(() => {
    if (!hasMoreAbove) return null;
    return pickStickyFallbackFromLoaded(navSourceMessages, allMessages);
  }, [hasMoreAbove, allMessages, navSourceMessages]);

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
    const next = resolved ? { id: msgs[resolved.index]._id, hidden: resolved.hidden } : null;
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
  }, [allMessages, resolveStickyFromViewable]);

  // Active prompt: the resolution inside the window when one lands, else the prompt
  // above the loaded window. Also the navigator's current row.
  const activeStickyId = stickyActive?.id ?? stickyFallback?.id ?? null;

  const stickyPrompt = useMemo<StickyPrompt | null>(() => {
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
  }, [userScrolled, promptCount, pendingScrollId, highlightedMessageId, stickyActive, activeStickyId, dismissedStickyVersion, navRowById]);

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

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Copy whole conversation', 'Select messages', 'Cancel'],
          cancelButtonIndex: 2,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) {
            handleCopyAll();
            return;
          }
          if (buttonIndex === 1) {
            openMessageSelect();
          }
        }
      );
      return;
    }

    Alert.alert('Copy', undefined, [
      { text: 'Copy whole conversation', onPress: handleCopyAll },
      { text: 'Select messages', onPress: openMessageSelect },
      { text: 'Cancel', style: 'cancel' },
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
  });

  const handleMoreActions = useCallback(() => {
    const options: string[] = [];
    options.push(conversation?.is_favorite ? 'Unfavorite' : 'Favorite');
    options.push('Share');
    options.push('Search');
    options.push('Messages');
    options.push('Copy');
    if (conversation?.session_id) options.push('Copy Resume Command');
    if (conversation && isConvexId(conversation._id)) {
      options.push(isRestarting ? 'Restarting…' : 'Restart Session');
    }
    options.push(collapsed ? 'Expand Messages' : 'Collapse Messages');
    // git_diff lives off the conversation doc now and is fetched lazily on
    // expand; surface "View Diff" whenever there's a branch (panel stays empty
    // if there turns out to be no diff).
    const hasDiff = !!conversation?.git_branch;
    if (hasDiff) options.push(diffExpanded ? 'Hide Diff' : 'View Diff');
    const hasTree = treeResult && !('error' in treeResult) && treeResult.tree && treeResult.tree.children.length > 0;
    if (hasTree) options.push('Fork Tree');
    options.push('Dismiss');
    options.push('Cancel');

    const destructiveIndex = options.indexOf('Dismiss');

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: options.length - 1,
          destructiveButtonIndex: destructiveIndex,
        },
        (idx) => {
          const label = options[idx];
          if (label === 'Favorite' || label === 'Unfavorite') handleToggleFavorite();
          else if (label === 'Share') handleShareConversation();
          else if (label === 'Search') setSearchVisible(v => !v);
          else if (label === 'Messages') setNavSheetVisible(true);
          else if (label === 'Copy') handleCopyMenu();
          else if (label === 'Copy Resume Command') handleCopyResume();
          else if (label === 'Restart Session') restartSession();
          else if (label === 'Expand Messages' || label === 'Collapse Messages') setCollapsed(c => !c);
          else if (label === 'View Diff' || label === 'Hide Diff') setDiffExpanded(d => !d);
          else if (label === 'Fork Tree') setTreeModalVisible(true);
          else if (label === 'Dismiss') handleDismiss();
        }
      );
      return;
    }

    Alert.alert('Actions', undefined, [
      ...options.slice(0, -1).map(label => ({
        text: label,
        style: (label === 'Dismiss' ? 'destructive' : 'default') as any,
        onPress: () => {
          if (label === 'Favorite' || label === 'Unfavorite') handleToggleFavorite();
          else if (label === 'Share') handleShareConversation();
          else if (label === 'Search') setSearchVisible(v => !v);
          else if (label === 'Messages') setNavSheetVisible(true);
          else if (label === 'Copy') handleCopyMenu();
          else if (label === 'Copy Resume Command') handleCopyResume();
          else if (label === 'Restart Session') restartSession();
          else if (label === 'Expand Messages' || label === 'Collapse Messages') setCollapsed(c => !c);
          else if (label === 'View Diff' || label === 'Hide Diff') setDiffExpanded(d => !d);
          else if (label === 'Fork Tree') setTreeModalVisible(true);
          else if (label === 'Dismiss') handleDismiss();
        },
      })),
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [conversation, collapsed, diffExpanded, treeResult, handleToggleFavorite, handleShareConversation, handleCopyMenu, handleCopyResume, handleDismiss, restartSession, isRestarting]);

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

  useEffect(() => {
    if (isActive) {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(activePulse, { toValue: 0.3, duration: 1000, useNativeDriver: true }),
          Animated.timing(activePulse, { toValue: 1, duration: 1000, useNativeDriver: true }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    }
  }, [isActive]);

  if (conversation === undefined) {
    return (
      <RNView style={styles.container}>
        <Stack.Screen options={{ headerShown: false }} />
        <RNView style={[styles.pinnedHeader, { paddingTop: insets.top, height: insets.top + HEADER_BAR_HEIGHT, position: 'relative' }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerIconBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 4 }} activeOpacity={0.6}>
            <FontAwesome name="chevron-left" size={18} color={Theme.text} />
          </TouchableOpacity>
          <RNText style={styles.headerTitleText} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>Conversation</RNText>
        </RNView>
        <RNView style={styles.skeletonContainer}>
          <RNView style={styles.skeletonHeader}>
            <RNView style={[styles.skeletonBlock, { width: '60%', height: 18 }]} />
            <RNView style={[styles.skeletonBlock, { width: '30%', height: 12, marginTop: 8 }]} />
          </RNView>
          {[1, 2, 3].map(i => (
            <RNView key={i} style={styles.skeletonMessage}>
              <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <RNView style={[styles.skeletonBlock, { width: 18, height: 18, borderRadius: 9 }]} />
                <RNView style={[styles.skeletonBlock, { width: 60, height: 12 }]} />
                <RNView style={[styles.skeletonBlock, { width: 40, height: 10 }]} />
              </RNView>
              <RNView style={[styles.skeletonBlock, { width: '90%', height: 12, marginBottom: 6 }]} />
              <RNView style={[styles.skeletonBlock, { width: '70%', height: 12, marginBottom: 6 }]} />
              <RNView style={[styles.skeletonBlock, { width: '50%', height: 12 }]} />
            </RNView>
          ))}
        </RNView>
      </RNView>
    );
  }

  if (!conversation) {
    return (
      <RNView style={styles.errorContainer}>
        <RNText style={styles.errorText}>Conversation not found</RNText>
      </RNView>
    );
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        style={styles.container}
        // 'padding' on both platforms. Edge-to-edge Android does NOT resize the
        // window for the IME (with no KAV behavior the composer sits hidden under
        // the keyboard), and 'height' — which re-derives the container height
        // from a cached initial frame on every layout — oscillated by about a
        // row while the list re-laid out during streaming.
        behavior="padding"
        keyboardVerticalOffset={0}
      >
        {/* Compact custom title bar — back + title + actions in one slim band,
            replacing the tall native nav bar so the top is minimal. It stays
            pinned while the metadata strip below it collapses on scroll. */}
        <RNView style={[styles.pinnedHeader, { paddingTop: insets.top, height: insets.top + HEADER_BAR_HEIGHT }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerIconBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 4 }} activeOpacity={0.6}>
            <FontAwesome name="chevron-left" size={18} color={Theme.text} />
          </TouchableOpacity>
          <RNText style={styles.headerTitleText} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{conversation.title || 'Conversation'}</RNText>
          {conversation?._id && <SessionHuddleButton conversationId={String(conversation._id)} teamId={conversation.team_id ? String(conversation.team_id) : null} />}
          {allSessionImages.length > 0 && (
            <TouchableOpacity
              onPress={() => { setGalleryIndex(Math.max(0, allSessionImages.length - 1)); setGalleryVisible(true); }}
              style={styles.headerIconBtn}
              hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
              activeOpacity={0.6}
            >
              <Feather name="image" size={17} color={Theme.textMuted} />
            </TouchableOpacity>
          )}
          {navigatorRows.length > 0 && (
            <MessageListButton count={promptCount} onPress={openNavigatorSheet} />
          )}
          <TouchableOpacity onPress={handleMoreActions} style={styles.headerIconBtn} hitSlop={{ top: 12, bottom: 12, left: 4, right: 12 }} activeOpacity={0.6}>
            <Feather name="more-horizontal" size={18} color={Theme.textMuted} />
          </TouchableOpacity>
        </RNView>
        <Animated.View
          style={[styles.floatingSessionHeader, { top: insets.top + HEADER_BAR_HEIGHT, opacity: floatingHeaderOpacity, transform: [{ translateY: floatingHeaderY }] }]}
          onLayout={(event) => handleFloatingHeaderLayout(event.nativeEvent.layout.height)}
        >
            <RNView style={styles.floatingSessionCard}>
            <RNView style={styles.metaRow}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.sessionMeta}
              >
                {conversation.agent_type && (
                  <RNView style={styles.metaBadgeIcon}>
                    <AgentLogoSvg agentType={conversation.agent_type} size={13} />
                    <RNText style={[styles.metaBadge, { color: agentTypeColor(conversation.agent_type) }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>
                      {formatAgentType(conversation.agent_type)}
                    </RNText>
                  </RNView>
                )}
                {activityAt > 0 && (
                  <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.messageCountText}>{conversation.agent_type ? '\u00B7 ' : ''}{formatRelativeTime(activityAt)}</RNText>
                )}
                {isActive && (
                  <Animated.View style={[styles.activeDot, { opacity: activePulse }]} />
                )}
                <ModelSwitcherChip
                  conversationId={conversation._id}
                  agentType={conversation.agent_type}
                  model={conversation.model}
                  effort={conversation.effort}
                  messageCount={conversation.message_count}
                  canEdit={!!conversation.is_own}
                  showToast={showToast}
                />
                {(conversation.fork_count ?? 0) > 0 && (
                  <Pressable onPress={() => setTreeModalVisible(true)} style={[styles.metaChip, chipTint(Theme.violet)]}>
                    <FontAwesome name="code-fork" size={10} color={Theme.violet} />
                    <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.metaChipText, { color: Theme.violet }]}>{conversation.fork_count}</RNText>
                  </Pressable>
                )}
                {conversation.git_branch && (
                  <Pressable
                    onPress={() => {
                      if (conversation.git_remote_url) {
                        const match = conversation.git_remote_url.match(/github\.com[:/](.+?)(?:\.git)?$/);
                        if (match) {
                          void openLink(`https://github.com/${match[1]}/tree/${conversation.git_branch}`);
                        }
                      }
                    }}
                    style={[styles.metaChip, chipTint(Theme.green)]}
                  >
                    <FontAwesome name="code-fork" size={10} color={Theme.green} />
                    <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.metaChipText, { color: Theme.green }]} numberOfLines={1}>{conversation.git_branch}</RNText>
                  </Pressable>
                )}
                <AssignmentChip
                  conversationId={isConvexId(conversation._id) ? conversation._id : null}
                  ownerDeviceId={(conversation as any).owner_device_id}
                  showToast={showToast}
                />
                {latestUsage && (
                  <RNView style={[styles.metaChip, chipTint(Theme.textDim)]}>
                    <FontAwesome name="bar-chart" size={10} color={Theme.textDim} />
                    <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.metaChipText, { color: Theme.textDim }]}>
                      {Math.round((latestUsage.contextSize / 200000) * 100)}%
                    </RNText>
                  </RNView>
                )}
                {conversation.parent_conversation_id && (
                  <Pressable
                    onPress={() => router.push(`/session/${conversation.parent_conversation_id}`)}
                    style={[styles.metaChip, chipTint(Theme.violet)]}
                  >
                    <FontAwesome name="level-up" size={10} color={Theme.violet} />
                    <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.metaChipText, { color: Theme.violet }]}>Parent</RNText>
                  </Pressable>
                )}
                {conversation.forked_from_details && (
                  <Pressable
                    onPress={() => {
                      const details = conversation.forked_from_details!;
                      if (details.share_token) {
                        void openLink(`https://codecast.sh/share/${details.share_token}`);
                      } else {
                        router.push(`/session/${details.conversation_id}`);
                      }
                    }}
                    style={[styles.metaChip, chipTint(Theme.cyan)]}
                  >
                    <FontAwesome name="code-fork" size={10} color={Theme.cyan} />
                    <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.metaChipText, { color: Theme.cyan }]}>@{conversation.forked_from_details.username}</RNText>
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
            {diffExpanded && (gitDiffData?.git_diff?.trim() || gitDiffData?.git_diff_staged?.trim()) && (
              <RNView style={[styles.gitDiffPanel, { marginTop: 6, marginBottom: 2 }]}>
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
              </RNView>
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
        <FlatList
          ref={flatListRef}
          style={{ flex: 1 }}
          data={invertedMessages}
          inverted={true}
          removeClippedSubviews={false}
          windowSize={21}
          initialNumToRender={50}
          maxToRenderPerBatch={50}
          updateCellsBatchingPeriod={50}
          onLayout={(e) => {
            flatListLayoutHeightRef.current = e.nativeEvent.layout.height;
          }}
          onContentSizeChange={(_w, h) => {
            lastContentHeightRef.current = h;
          }}
          ListHeaderComponent={null}
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
            // In inverted list, index 0 = newest. Convert to original order for prev-message logic.
            const originalIndex = invertedMessages.length - 1 - index;
            let prevNonToolResult: Message | null = null;
            for (let i = originalIndex - 1; i >= 0; i--) {
              const prev = allMessages[i];
              if (prev.role === 'user' && prev.tool_results && prev.tool_results.length > 0) continue;
              if (prev.role === 'user' && prev.content && isCommandMessage(prev.content)) continue;
              prevNonToolResult = prev;
              break;
            }
            const showHeader = !prevNonToolResult || prevNonToolResult.role !== item.role;

            // Hide standalone tool result messages (they're shown inline with tool calls)
            if (item.role === 'user' && item.tool_results && item.tool_results.length > 0 && !item.content?.trim()) {
              return null;
            }

            // Detect plan content in user messages (like web)
            if (item.role === 'user' && item.content) {
              const planContent = extractPlanContent(item.content);
              if (planContent) {
                return <PlanBlock content={planContent} timestamp={item.timestamp} />;
              }
              if (prevNonToolResult?.role === 'system' && prevNonToolResult?.subtype === 'compact_boundary') {
                return <CompactionSummaryBlock content={item.content} />;
              }
            }

            // Machine-delivered turns (cast send, cast trigger) render as
            // dedicated cards, not user bubbles of raw XML — mirrors web's
            // classifyUserMessage → SessionMessageBlock / ScheduledTaskBlock.
            if (item.role === 'user' && item.content) {
              const sessionMsg = parseInboundSessionMessage(item.content);
              if (sessionMsg) {
                // A huddle digest rides the session-message rail: show the
                // summary under the call's title, never the wire tag.
                const huddle = parseHuddleSummaryTag(sessionMsg.body);
                if (huddle) {
                  return <SessionMessageBlock from="unknown" name={`Huddle — ${huddle.title}`} body={huddle.body} timestamp={item.timestamp} />;
                }
                return <SessionMessageBlock from={sessionMsg.from} name={sessionMsg.name} body={sessionMsg.body} timestamp={item.timestamp} />;
              }
              if (isScheduledTaskMessage(item.content)) {
                return <ScheduledTaskBlock content={item.content} timestamp={item.timestamp} />;
              }
              const chatWake = parseChatWakePrompt(item.content);
              if (chatWake) {
                return <ChatWakeBlock wake={chatWake} timestamp={item.timestamp} />;
              }
            }

            if (item.role === 'user' && item.content && isTaskNotification(item.content)) {
              const stripped = item.content.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '').trim();
              if (!stripped || stripped.length < 4 || stripped.startsWith('Read the output file to retrieve the result:') || stripped.startsWith('Full transcript available at:')) {
                return <TaskNotificationLine content={item.content} timestamp={item.timestamp} childConversationMap={conversation.child_conversation_map} />;
              }
            }

            if (item.role === 'user' && item.content) {
              const t = item.content.trim();
              if (t.includes('Your task is to create a detailed summary') ||
                  t.startsWith('Read the output file to retrieve the result:') ||
                  t.startsWith('Full transcript available at:')) {
                return null;
              }
            }

            const isSearchDimmed = searchMatchIds && !searchMatchIds.has(item._id);
            const isCurrentSearchMatch = searchMatchList.length > 0 && searchMatchList[currentMatchIndex] === item._id;
            const isHighlighted = highlightedMessageId === item._id;
            // Optimistic-send affordances: pending (optimistic/queued) renders
            // dimmed with a "Sending"/"Queued" indicator; failed renders dimmed
            // with a distinct "Failed to send" indicator.
            const isPending = item._isOptimistic || item._isQueued;
            const isFailed = item._isFailed;
            return (
              <RNView style={[
                isSearchDimmed ? { opacity: 0.25 } : undefined,
                (isCurrentSearchMatch || isHighlighted) && styles.searchHighlight,
                shareSelectionMode && { paddingLeft: 28 },
                (isPending || isFailed) && { opacity: 0.55 },
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
                <MessageBubble
                  message={item}
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
                  userName={conversation.user?.name || conversation.user?.email?.split('@')[0]}
                  showToast={showToast}
                  collapsed={collapsed}
                  childConversationMap={conversation.child_conversation_map}
                  bookmarkedSet={bookmarkedSet}
              />
                {isPending && (
                  <RNView style={styles.pendingStatusRow}>
                    <ActivityIndicator size="small" color={Theme.textDim} />
                    <RNText style={styles.pendingStatusText}>
                      {item._isQueued ? 'Queued' : 'Sending'}
                    </RNText>
                  </RNView>
                )}
                {isFailed && (
                  <RNView style={styles.pendingStatusRow}>
                    <FontAwesome name="exclamation-circle" size={11} color={Theme.red} />
                    <RNText style={[styles.pendingStatusText, { color: Theme.red }]}>
                      Failed to send
                    </RNText>
                  </RNView>
                )}
              </RNView>
            );
          }}
          keyExtractor={(item) => item._id}
          contentContainerStyle={[
            styles.messageList,
            { paddingBottom: 12 },
            allMessages.length === 0 && { flex: 1 },
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
                <RNText style={styles.emptyStateSubtext}>Messages will appear here as the session progresses</RNText>
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
        />
        </Animated.View>
        <MessageTickRail
          ticks={navTicks}
          promptCount={promptCount}
          activeMessageId={activeStickyId}
          visible={userScrolled}
          onOpen={openNavigatorSheet}
          onScrub={handleRailScrub}
          onScrubEnd={handleRailScrubEnd}
        />

        <RNView>
          <MessageInput
            conversationId={id as Id<"conversations">}
            isActive={isActive}
            draft={conversation?.draft_message}
            autoFocus={focusParam === '1'}
          />
        </RNView>

        {/* Jump arrows */}
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
                  top: insets.top + HEADER_BAR_HEIGHT + floatingHeaderHeight + 4,
                  transform: [{ translateY: floatingHeaderY }, { translateY: stickyOffsetY }],
                },
              ]}
            >
              <TouchableOpacity
                onPress={handleJumpToStart}
                style={styles.jumpButton}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Jump to first message"
              >
                {jumpingToStart ? (
                  <ActivityIndicator size="small" color={Theme.textDim} />
                ) : (
                  <FontAwesome name="angle-up" size={18} color={Theme.textDim} />
                )}
              </TouchableOpacity>
            </Animated.View>
          )}
          {userScrolled && (
            <RNView style={styles.jumpBottomButtonWrap} pointerEvents="box-none">
              <TouchableOpacity
                onPress={handleJumpToEnd}
                style={styles.jumpButton}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Jump to latest message"
              >
                {jumpingToEnd ? (
                  <ActivityIndicator size="small" color={Theme.textDim} />
                ) : (
                  <FontAwesome name="angle-down" size={18} color={Theme.textDim} />
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
      <Modal visible={treeModalVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setTreeModalVisible(false)}>
        <RNView style={styles.treeModal}>
          <RNView style={styles.treeModalHeader}>
            <RNText style={styles.treeModalTitle}>Fork Tree</RNText>
            <TouchableOpacity onPress={() => setTreeModalVisible(false)}>
              <FontAwesome name="times" size={18} color={Theme.textMuted} />
            </TouchableOpacity>
          </RNView>
          <ScrollView style={styles.treeModalContent}>
            {treeResult && !('error' in treeResult) && treeResult.tree ? (
              <TreeNodeView node={treeResult.tree} depth={0} router={router} currentId={id as string} onClose={() => setTreeModalVisible(false)} />
            ) : (
              <RNText style={{ color: Theme.textMuted, padding: 16 }}>No fork tree available</RNText>
            )}
          </ScrollView>
        </RNView>
      </Modal>
      <ImageGallery
        images={allSessionImages}
        initialIndex={galleryIndex}
        visible={galleryVisible}
        onClose={() => setGalleryVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
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
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 70,
    backgroundColor: Theme.bgAlt,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    gap: 2,
  },
  headerIconBtn: {
    width: 34,
    height: 34,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitleText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: Theme.text,
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
    backgroundColor: Theme.bgAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  sessionMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'nowrap',
    paddingRight: 8,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Shared shell for every metadata chip (fork, branch, device, usage, links).
  metaChip: chipShell,
  metaChipText: chipText,
  metaBadge: chipText,
  messageCountText: {
    fontSize: 11,
    color: Theme.textMuted,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.greenBright,
    shadowColor: Theme.greenBright,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },
  messageList: {
    padding: 16,
  },
  permissionsContainer: {
    marginBottom: 16,
  },
  messageBubble: {
    marginBottom: 2,
    borderRadius: 12,
    overflow: 'hidden',
  },
  userBubble: {
    backgroundColor: Theme.userBubble + '26',
    borderWidth: 1,
    borderColor: Theme.userBubble + '66',
    alignSelf: 'stretch',
    maxWidth: '100%',
    marginTop: 12,
    marginBottom: 4,
  },
  assistantBubble: {
    backgroundColor: 'transparent',
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  assistantBubbleFirst: {
    marginTop: 8,
  },
  bubbleHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 4,
  },
  bubbleRole: {
    fontSize: 12,
    fontWeight: '500',
  },
  userRole: {
    color: Theme.userBubble,
  },
  assistantRole: {
    color: Theme.textMuted0,
  },
  bubbleTime: {
    fontSize: 11,
  },
  userTime: {
    color: Theme.textDim,
  },
  assistantTime: {
    color: Theme.textDim,
  },
  bubbleContent: {
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
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
  bubbleText: {
    fontSize: 14,
    lineHeight: 20,
  },
  userText: {
    color: Theme.text,
  },
  assistantText: {
    color: Theme.text,
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
    fontFamily: 'SpaceMono',
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
  systemSubtypeLabel: {
    fontSize: 10,
    color: Theme.textDim,
    marginTop: 1,
  },
  systemMessageText: {
    fontSize: 12,
    color: Theme.textMuted0,
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
  },
  systemCommandText: {
    fontSize: 11,
    color: Theme.textDim,
    flex: 1,
  },
  commandStatusLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 4,
    marginBottom: 2,
  },
  commandStatusTime: {
    fontSize: 10,
    color: Theme.textDim,
  },
  commandStatusBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: Theme.bgHighlight + '80',
  },
  commandStatusBadgeText: {
    fontSize: 10,
    color: Theme.textMuted,
    fontFamily: 'SpaceMono',
  },
  commandStatusText: {
    fontSize: 11,
    color: Theme.textDim,
    fontFamily: 'SpaceMono',
    flex: 1,
  },
  toolCallOnlyBubble: {
    marginBottom: 1,
  },
  toolCallsCompact: {
    paddingHorizontal: 14,
    paddingVertical: 2,
    gap: 1,
  },
  toolCallsContainer: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 2,
  },
  toolCallContainer: {
    marginVertical: 0,
  },
  toolCallHeader: {
    fontSize: 12,
    lineHeight: 18,
  },
  toolCallName: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'SpaceMono',
  },
  toolCallSummary: {
    fontSize: 12,
    color: Theme.textMuted,
    fontFamily: 'SpaceMono',
  },
  toolCallResultHint: {
    fontSize: 11,
    color: Theme.textDim,
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
  },
  toolInputSection: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  toolCallInput: {
    fontSize: 12,
    color: Theme.textSecondary,
    fontFamily: 'SpaceMono',
  },
  toolCallResult: {
    fontSize: 12,
    color: Theme.textSecondary,
    fontFamily: 'SpaceMono',
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
  errorBanner: {
    backgroundColor: Theme.red,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorBannerText: {
    color: '#fff',
    fontSize: 13,
    flex: 1,
  },
  errorBannerDismiss: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    paddingLeft: 12,
  },
  imagePreviewContainer: {
    paddingHorizontal: 12,
    paddingTop: 10,
    maxHeight: 120,
  },
  imagePreview: {
    position: 'relative',
    marginRight: 8,
  },
  previewImage: {
    width: 80,
    height: 80,
    borderRadius: 8,
  },
  imageUploadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 8,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },
  removeImageButton: {
    position: 'absolute',
    top: -8,
    right: -8,
    backgroundColor: Theme.bg,
    borderRadius: 10,
  },
  imageButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // One rounded card: full-width input on top, action row underneath. Buttons
  // living below the text (not beside it) is what gives the input the whole
  // screen width, matching the web/reference composer.
  composerCard: {
    marginHorizontal: 10,
    marginTop: 6,
    backgroundColor: Theme.bg,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  composerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 8,
    paddingTop: 2,
  },
  composerSpacer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  composerStatusText: chipText,
  textInput: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 4,
    color: Theme.text,
    fontSize: 15,
    minHeight: 38,
    // maxHeight is set inline from the window height (grows to ~1/3 screen).
  },
  // Keeps wrapped text clear of the floating expand button in the top-right.
  textInputWithExpand: {
    paddingRight: 44,
  },
  expandButton: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Theme.bgHighlight,
  },
  expandButtonStatic: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Theme.bgHighlight,
  },
  expandedContainer: {
    flex: 1,
    backgroundColor: Theme.bgAlt,
  },
  expandedInner: {
    flex: 1,
    paddingHorizontal: 6,
  },
  expandedHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 6,
    paddingBottom: 2,
  },
  expandedInput: {
    flex: 1,
    paddingHorizontal: 10,
    paddingTop: 6,
    color: Theme.text,
    fontSize: 16,
    lineHeight: 24,
    textAlignVertical: 'top',
  },
  sendButton: {
    backgroundColor: Theme.blue,
    minWidth: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 9,
  },
  sendButtonDisabled: {
    backgroundColor: Theme.bgHighlight,
  },
  // Workflow event anchors
  wfStartedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.violet + '40',
    backgroundColor: Theme.violet + '14',
    marginVertical: 4,
  },
  wfStartedText: {
    flex: 1,
    fontSize: 12,
    color: Theme.textMuted,
  },
  wfNodeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
  },
  wfNodePulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.accent,
  },
  wfNodeTypeBadge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  wfNodeTypeText: {
    fontSize: 9,
    fontWeight: '600',
  },
  wfNodeLabel: {
    flex: 1,
    fontSize: 12,
    color: Theme.textSecondary,
  },
  wfNodeLink: {
    fontSize: 10,
    fontWeight: '600',
    color: Theme.cyan,
    textDecorationLine: 'underline',
  },
  wfRunCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.violet + '40',
    backgroundColor: Theme.violet + '0d',
    marginVertical: 4,
  },
  wfRunName: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.text,
  },
  wfRunId: {
    fontSize: 10,
    fontFamily: 'SpaceMono',
    color: Theme.textDim,
    marginTop: 1,
  },
  wfGateCard: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.magenta + '55',
    backgroundColor: Theme.magenta + '0d',
    marginVertical: 4,
    overflow: 'hidden',
  },
  wfGateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.magenta + '30',
  },
  wfGateHeaderText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    color: Theme.magenta,
  },
  wfGateStatus: {
    marginLeft: 'auto',
    fontSize: 10,
    fontWeight: '600',
  },
  wfGatePrompt: {
    fontSize: 13,
    color: Theme.text,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  wfGateChoices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  wfGateChoice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border + '60',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  wfGateChoiceKey: {
    fontSize: 11,
    fontFamily: 'SpaceMono',
    color: Theme.magenta,
  },
  wfGateChoiceLabel: {
    fontSize: 12,
    color: Theme.text,
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
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
  },
  specialToolMeta: {
    fontSize: 10,
    color: Theme.textDim,
    fontFamily: 'SpaceMono',
  },
  specialToolDesc: {
    fontSize: 11,
    color: Theme.textMuted,
  },
  specialToolContent: {
    fontSize: 11,
    color: Theme.textSecondary,
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
  },
  todoStats: {
    fontSize: 12,
    color: Theme.textDim,
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
  },
  taskOpId: {
    fontSize: 10,
    color: Theme.textMuted0,
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
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
  galleryCounter: {
    position: 'absolute',
    top: 64,
    left: 0,
    right: 0,
    textAlign: 'center',
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    fontWeight: '500',
    zIndex: 10,
  },
  galleryThumbStrip: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 10,
  },
  galleryThumbStripContent: {
    paddingHorizontal: 12,
    gap: 6,
    alignItems: 'center',
    flexGrow: 1,
    justifyContent: 'center',
  },
  galleryThumb: {
    width: 40,
    height: 40,
    borderRadius: 6,
  },
  galleryThumbActive: {
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.9)',
  },
  galleryThumbInactive: {
    opacity: 0.45,
  },
  galleryThumbPlaceholder: {
    backgroundColor: 'rgba(255,255,255,0.12)',
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
    position: 'absolute',
    top: 6,
    left: 0,
    right: 0,
    bottom: 116,
    zIndex: 100,
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
    backgroundColor: Theme.bgAlt + 'B3',
    opacity: 0.72,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.03,
    shadowRadius: 2,
    elevation: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight + '99',
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
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
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
  agentDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
  // Table
  // Code copy button
  // Model badge in header
  modelBadge: {
    fontSize: 9,
    color: Theme.textDim,
    fontFamily: 'SpaceMono',
    marginLeft: 4,
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
    fontFamily: 'SpaceMono',
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
  fullscreenOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullscreenClose: {
    position: 'absolute',
    top: 60,
    right: 20,
    zIndex: 10,
    padding: 8,
  },
  landscapeToggle: {
    position: 'absolute',
    top: 60,
    left: 20,
    zIndex: 10,
    padding: 8,
  },
  galleryContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Thinking label
  // User avatar
  userAvatar: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Theme.userBubble + '40',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 4,
  },
  userAvatarText: {
    fontSize: 10,
    fontWeight: '700',
    color: Theme.userBubble,
  },
  // Skeleton loading
  skeletonContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  skeletonHeader: {
    height: 12,
    width: '40%',
    backgroundColor: Theme.bgHighlight,
    borderRadius: 4,
  },
  skeletonBlock: {
    height: 60,
    backgroundColor: Theme.bgHighlight,
    borderRadius: 6,
  },
  skeletonMessage: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
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
    fontFamily: 'SpaceMono',
    color: Theme.violet,
    fontWeight: '600',
  },
  prTitle: {
    fontSize: 11,
    color: Theme.textMuted,
    flex: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
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
  metaBadgeIcon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
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
    fontFamily: 'SpaceMono',
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
    fontFamily: 'SpaceMono',
  },
  searchCount: {
    fontSize: 10,
    color: Theme.textDim,
    fontFamily: 'SpaceMono',
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
    maxHeight: 300,
  },
  gitDiffContent: {
    marginHorizontal: 12,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight + '30',
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
    fontFamily: 'JetBrainsMono',
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
    fontFamily: 'JetBrainsMono',
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
  collapsibleFade: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 44,
  },
  collapsibleToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 4,
  },
  collapsibleToggleText: {
    fontSize: 11,
    color: Theme.textDim,
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
    fontFamily: 'JetBrainsMono',
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
    fontFamily: 'JetBrainsMono',
    fontWeight: '700',
  },
  apiErrorType: {
    fontSize: 11,
    fontFamily: 'JetBrainsMono',
  },
  apiErrorMessage: {
    fontSize: 12,
    color: Theme.textSecondary,
    lineHeight: 17,
  },
  apiErrorRequestId: {
    fontSize: 9,
    fontFamily: 'JetBrainsMono',
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
    fontFamily: 'JetBrainsMono',
    color: Theme.textDim,
  },
});
