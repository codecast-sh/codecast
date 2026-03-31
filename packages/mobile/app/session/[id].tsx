import { StyleSheet, FlatList, ActivityIndicator, ScrollView, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, Share, View as RNView, Text as RNText, Linking, Image, ActionSheetIOS, Alert, Pressable, Clipboard, Modal, Animated, Dimensions, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { useQuery, useMutation, useConvex } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { Id } from '@codecast/convex/convex/_generated/dataModel';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import * as Haptics from 'expo-haptics';
let ImagePicker: typeof import('expo-image-picker') | null = null;
try { ImagePicker = require('expo-image-picker'); } catch {}
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Feather from '@expo/vector-icons/Feather';
import Svg, { Path } from 'react-native-svg';
import { PermissionCard } from '@/components/PermissionCard';
import { renderInlineMarkdown, MarkdownContent, MarkdownTextBlock, CodeBlockWithCopy, CodeBlockFullscreen, HighlightedCodeText } from '@/components/MarkdownRenderer';
import { Theme, Spacing } from '@/constants/Theme';
const LinearGradient = ({ colors, style, children, pointerEvents }: { colors: string[]; style?: any; children?: any; pointerEvents?: string }) => {
  const bg = colors?.[colors.length - 1] || 'transparent';
  return <RNView style={[style, { backgroundColor: bg }]} pointerEvents={pointerEvents as any}>{children}</RNView>;
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

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean; totalLines: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, truncated: false, totalLines: lines.length };
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true, totalLines: lines.length };
}

function stripSystemTags(content: string): string {
  return content
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<\/?(?:command-(?:name|message|args)|antml:[a-z_]+)[^>]*>/g, '')
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
  session_id?: string;
  messages: Message[];
  has_more_above?: boolean;
  oldest_timestamp?: number | null;
  model?: string;
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
  child_conversations?: Array<{ _id: string; title: string }>;
  short_id?: string;
};

// --- Markdown rendering ---
function DiffBlock({ oldStr, newStr, filePath }: { oldStr: string; newStr: string; filePath: string }) {
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const lang = filePath ? (getFileExtension(filePath) || 'diff') : 'diff';
  const unifiedContent = oldLines.map(l => `- ${l}`).join('\n') + '\n' + newLines.map(l => `+ ${l}`).join('\n');

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
      <ScrollView horizontal showsHorizontalScrollIndicator nestedScrollEnabled>
        <RNView>
          {displayOldLines.map((line, i) => (
            <RNView key={`o${i}`} style={{ flexDirection: 'row', backgroundColor: Theme.red + '12', paddingHorizontal: 6, paddingVertical: 1 }}>
              <RNText style={{ fontSize: 11, fontFamily: 'SpaceMono', lineHeight: 16, color: Theme.red, width: 14 }}>-</RNText>
              <HighlightedCodeText content={line} style={{ fontSize: 11, fontFamily: 'SpaceMono', lineHeight: 16, color: Theme.textSecondary }} />
            </RNView>
          ))}
          {displayNewLines.map((line, i) => (
            <RNView key={`n${i}`} style={{ flexDirection: 'row', backgroundColor: Theme.green + '12', paddingHorizontal: 6, paddingVertical: 1 }}>
              <RNText style={{ fontSize: 11, fontFamily: 'SpaceMono', lineHeight: 16, color: Theme.green, width: 14 }}>+</RNText>
              <HighlightedCodeText content={line} style={{ fontSize: 11, fontFamily: 'SpaceMono', lineHeight: 16, color: Theme.textSecondary }} />
            </RNView>
          ))}
        </RNView>
      </ScrollView>
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
      <CodeBlockFullscreen content={unifiedContent} language={lang} visible={fullscreen} onClose={() => setFullscreen(false)} />
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
  return agentType;
}

function agentTypeColor(agentType?: string): string {
  if (agentType === 'codex') return '#10b981';
  if (agentType === 'cursor') return '#60a5fa';
  if (agentType === 'gemini') return '#1a73e8';
  return Theme.accent;
}

function agentTypeIcon(agentType?: string): string {
  if (agentType === 'codex') return 'terminal';
  if (agentType === 'cursor') return 'mouse-pointer';
  if (agentType === 'gemini') return 'star';
  return 'bolt';
}

function agentLogoBg(agentType?: string): string {
  if (agentType === 'codex') return '#0f0f0f';
  if (agentType === 'cursor') return '#1a1a2e';
  if (agentType === 'gemini') return '#1a73e8';
  return '#cb4b16';
}

function AgentLogoSvg({ agentType, size = 16 }: { agentType?: string; size?: number }) {
  const bg = agentLogoBg(agentType);
  const iconSize = size * 0.6;
  if (agentType === 'codex') {
    return (
      <RNView style={{ width: size, height: size, borderRadius: 3, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
          <Path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729z" fill="white" />
        </Svg>
      </RNView>
    );
  }
  if (agentType === 'cursor') {
    return (
      <RNView style={{ width: size, height: size, borderRadius: 3, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none">
          <Path d="M4 4l16 6-8 2-2 8z" stroke="white" strokeWidth={2} />
        </Svg>
      </RNView>
    );
  }
  if (agentType === 'gemini') {
    return (
      <RNView style={{ width: size, height: size, borderRadius: 3, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={iconSize} height={iconSize} viewBox="0 0 28 28">
          <Path d="M12 0C12 0 12 6.268 8.134 10.134C4.268 14 0 14 0 14C0 14 6.268 14 10.134 17.866C14 21.732 14 28 14 28C14 28 14 21.732 17.866 17.866C21.732 14 28 14 28 14C28 14 21.732 14 17.866 10.134C14 6.268 14 0 14 0" fill="white" />
        </Svg>
      </RNView>
    );
  }
  return (
    <RNView style={{ width: size, height: size, borderRadius: size * 0.2, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <RNText style={{ color: 'white', fontSize: size * 0.6, fontWeight: '700', lineHeight: size * 0.85, textAlign: 'center' }}>A</RNText>
    </RNView>
  );
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

const mcpToolNames: Record<string, string> = {
  "mcp__claude-in-chrome__computer": "Browser",
  "mcp__claude-in-chrome__navigate": "Navigate",
  "mcp__claude-in-chrome__read_page": "Read Page",
  "mcp__claude-in-chrome__find": "Find",
  "mcp__claude-in-chrome__form_input": "Form",
  "mcp__claude-in-chrome__javascript_tool": "JS",
  "mcp__claude-in-chrome__tabs_context_mcp": "Tabs",
  "mcp__claude-in-chrome__tabs_create_mcp": "New Tab",
  "mcp__claude-in-chrome__update_plan": "Plan",
  "mcp__claude-in-chrome__gif_creator": "GIF",
  "mcp__claude-in-chrome__read_console_messages": "Console",
  "mcp__claude-in-chrome__read_network_requests": "Network",
  "mcp__claude-in-chrome__get_page_text": "Page Text",
  "mcp__claude-in-chrome__upload_image": "Upload",
  "mcp__claude-in-chrome__resize_window": "Resize",
  "mcp__claude-in-chrome__shortcuts_list": "Shortcuts",
  "mcp__claude-in-chrome__shortcuts_execute": "Shortcut",
};

const codexToolNames: Record<string, string> = {
  shell_command: "Terminal",
  shell: "Terminal",
  exec_command: "Terminal",
  "container.exec": "Terminal",
  apply_patch: "Patch",
  file_read: "Read",
  file_write: "Write",
  file_edit: "Edit",
  web_search: "Search",
  web_fetch: "Fetch",
  code_search: "Search",
  code_analysis: "Analyze",
};

function formatToolName(name: string): string {
  if (mcpToolNames[name]) return mcpToolNames[name];
  if (codexToolNames[name]) return codexToolNames[name];
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const method = parts[2] || parts[1] || "MCP";
    return method.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).slice(0, 12);
  }
  return name.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function stripLineNumbers(content: string): string {
  return content.split("\n").map(line => line.replace(/^\s*\d+→/, "")).join("\n");
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname;
    if (path === "/" || path === "") return host;
    return host + (path.length > 25 ? path.slice(0, 22) + "..." : path);
  } catch {
    return truncateStr(url, 40);
  }
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

function isPlanWriteToolCall(tc: ToolCall): boolean {
  if (tc.name !== 'Write') return false;
  try {
    const parsed = JSON.parse(tc.input);
    return String(parsed.file_path || '').includes('.claude/plans/');
  } catch {
    return false;
  }
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

function getRelativePath(fullPath: string): string {
  const patterns = [
    /\/Users\/[^/]+\/src\/(.+)$/,
    /\/Users\/[^/]+\/(.+)$/,
    /\/home\/[^/]+\/(?:src|projects|code)\/(.+)$/,
    /\/home\/[^/]+\/(.+)$/,
  ];
  for (const pattern of patterns) {
    const match = fullPath.match(pattern);
    if (match) return match[1];
  }
  const parts = fullPath.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}

function toolIcon(name: string): { icon: React.ComponentProps<typeof FontAwesome>['name']; color: string } {
  if (name === 'Bash' || name === 'shell_command' || name === 'shell' || name === 'exec_command' || name === 'container.exec') return { icon: 'terminal', color: Theme.green };
  if (name === 'Read' || name === 'file_read') return { icon: 'file-code-o', color: Theme.blue };
  if (name === 'Glob' || name === 'Grep') return { icon: 'search', color: Theme.violet };
  if (name === 'Edit' || name === 'Write' || name === 'file_write' || name === 'file_edit' || name === 'apply_patch') return { icon: 'pencil', color: Theme.orange };
  if (name === 'WebSearch' || name === 'web_search' || name === 'code_search' || name === 'code_analysis') return { icon: 'globe', color: Theme.violet };
  if (name === 'WebFetch' || name === 'web_fetch') return { icon: 'globe', color: Theme.cyan };
  if (name === 'Task') return { icon: 'code-fork', color: Theme.cyan };
  if (name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TaskList' || name === 'TaskGet') return { icon: 'tasks', color: '#10b981' };
  if (name === 'SendMessage') return { icon: 'comment', color: '#f59e0b' };
  if (name === 'TodoWrite') return { icon: 'check-square-o', color: Theme.magenta };
  if (name === 'Skill') return { icon: 'bolt', color: Theme.cyan };
  if (name === 'EnterPlanMode' || name === 'ExitPlanMode') return { icon: 'map-o', color: Theme.violet };
  if (name === 'AskUserQuestion') return { icon: 'question-circle-o', color: Theme.blue };
  if (name === 'TeamCreate' || name === 'TeamDelete') return { icon: 'users', color: Theme.cyan };
  if (name === 'TaskOutput' || name === 'TaskStop') return { icon: 'tasks', color: '#10b981' };
  if (name === 'NotebookEdit') return { icon: 'book', color: Theme.orange };

  if (name.startsWith('mcp__')) {
    if (name.includes('tabs_context') || name.includes('tabs_create')) {
      return { icon: 'chrome', color: Theme.textDim };
    }
    if (name.includes('computer') || name.includes('screenshot')) {
      return { icon: 'desktop', color: Theme.orange };
    }
    if (name.includes('navigate')) {
      return { icon: 'chrome', color: Theme.blue };
    }
    if (name.includes('read_page') || name.includes('get_page_text')) {
      return { icon: 'chrome', color: Theme.blue };
    }
    if (name.includes('find')) {
      return { icon: 'search', color: Theme.violet };
    }
    if (name.includes('form_input') || name.includes('javascript_tool')) {
      return { icon: 'chrome', color: Theme.orange };
    }
    if (name.includes('gif_creator')) {
      return { icon: 'chrome', color: Theme.magenta };
    }
    if (name.includes('console') || name.includes('network')) {
      return { icon: 'chrome', color: Theme.green };
    }
    if (name.includes('update_plan')) {
      return { icon: 'chrome', color: Theme.cyan };
    }
    if (name.includes('upload_image')) {
      return { icon: 'upload', color: Theme.blue };
    }
    if (name.includes('resize_window')) {
      return { icon: 'arrows-alt', color: Theme.textDim };
    }
    if (name.includes('shortcuts')) {
      return { icon: 'bolt', color: Theme.violet };
    }
    return { icon: 'plug', color: Theme.cyan };
  }

  return { icon: 'cog', color: Theme.textDim };
}

function toolSummary(tc: ToolCall): string {
  let parsedInput: Record<string, any> = {};
  try {
    parsedInput = JSON.parse(tc.input);
  } catch {
    return '';
  }

  // File-based tools
  if (tc.name === 'Read' || tc.name === 'Edit' || tc.name === 'Write') {
    return getRelativePath(String(parsedInput.file_path || ''));
  }
  if (tc.name === 'file_read' || tc.name === 'file_write' || tc.name === 'file_edit') {
    return getRelativePath(String(parsedInput.file_path || parsedInput.path || ''));
  }

  // Shell/Terminal tools
  if (tc.name === 'Bash' || tc.name === 'shell_command' || tc.name === 'shell' || tc.name === 'exec_command' || tc.name === 'container.exec') {
    const cmd = String(parsedInput.command || parsedInput.cmd || '');
    return cmd ? truncateStr(cmd, 100) : '';
  }

  // Search tools
  if (tc.name === 'Glob' && parsedInput.pattern) return String(parsedInput.pattern);
  if (tc.name === 'Grep' && parsedInput.pattern) return String(parsedInput.pattern);
  if (tc.name === 'WebSearch' || tc.name === 'web_search' || tc.name === 'code_search') return parsedInput.query ? truncateStr(String(parsedInput.query), 40) : '';
  if (tc.name === 'WebFetch' || tc.name === 'web_fetch') return parsedInput.url ? shortenUrl(String(parsedInput.url)) : '';

  // Patch tool
  if (tc.name === 'apply_patch') {
    const input = String(parsedInput.input || parsedInput.patch || '');
    const fileMatch = input.match(/\*\*\* (?:Update|Add|Delete) File: (.+)/);
    if (fileMatch) return getRelativePath(fileMatch[1].trim());
    return 'Apply patch';
  }

  // MCP Browser tools
  if (tc.name === 'mcp__claude-in-chrome__computer') {
    const action = String(parsedInput.action || '');
    if (action === 'screenshot') return 'Screenshot';
    if (action === 'left_click') {
      const coord = parsedInput.coordinate as number[] | undefined;
      return coord ? `Click (${coord[0]}, ${coord[1]})` : 'Click';
    }
    if (action === 'type') return `Type "${truncateStr(String(parsedInput.text || ''), 20)}"`;
    if (action === 'key') return `Key: ${String(parsedInput.text || '')}`;
    if (action === 'scroll') return `Scroll ${String(parsedInput.scroll_direction || '')}`;
    if (action === 'wait') return `Wait ${String(parsedInput.duration || '')}s`;
    return action || '';
  }
  if (tc.name === 'mcp__claude-in-chrome__navigate') {
    const url = String(parsedInput.url || '');
    if (url === 'back') return 'Back';
    if (url === 'forward') return 'Forward';
    return url ? shortenUrl(url) : '';
  }
  if (tc.name === 'mcp__claude-in-chrome__read_page') {
    if (parsedInput.ref_id) return `Element ${String(parsedInput.ref_id)}`;
    if (parsedInput.filter === 'interactive') return 'Interactive elements';
    return 'Page content';
  }
  if (tc.name === 'mcp__claude-in-chrome__find') {
    return parsedInput.query ? `"${truncateStr(String(parsedInput.query), 30)}"` : '';
  }
  if (tc.name === 'mcp__claude-in-chrome__form_input') {
    const ref = parsedInput.ref ? String(parsedInput.ref) : '';
    const val = parsedInput.value;
    if (ref && val !== undefined) return `${ref} = "${truncateStr(String(val), 20)}"`;
    return '';
  }
  if (tc.name === 'mcp__claude-in-chrome__javascript_tool') {
    return parsedInput.text ? truncateStr(String(parsedInput.text), 40) : '';
  }
  if (tc.name === 'mcp__claude-in-chrome__tabs_context_mcp') return 'Get tabs';
  if (tc.name === 'mcp__claude-in-chrome__tabs_create_mcp') return 'Create tab';
  if (tc.name === 'mcp__claude-in-chrome__update_plan') {
    const domains = parsedInput.domains as string[] | undefined;
    if (Array.isArray(domains) && domains.length) {
      return domains.slice(0, 2).join(', ') + (domains.length > 2 ? '...' : '');
    }
    return '';
  }
  if (tc.name === 'mcp__claude-in-chrome__gif_creator') return String(parsedInput.action || '');
  if (tc.name === 'mcp__claude-in-chrome__read_console_messages') {
    return parsedInput.pattern ? `Filter: ${String(parsedInput.pattern)}` : '';
  }
  if (tc.name === 'mcp__claude-in-chrome__read_network_requests') {
    return parsedInput.urlPattern ? `Filter: ${String(parsedInput.urlPattern)}` : '';
  }
  if (tc.name === 'mcp__claude-in-chrome__get_page_text') return 'Extract text';
  if (tc.name === 'mcp__claude-in-chrome__upload_image') return parsedInput.filename ? String(parsedInput.filename) : 'Upload';
  if (tc.name === 'mcp__claude-in-chrome__resize_window') return parsedInput.width && parsedInput.height ? `${parsedInput.width}x${parsedInput.height}` : 'Resize';
  if (tc.name === 'mcp__claude-in-chrome__shortcuts_list') return 'List shortcuts';
  if (tc.name === 'mcp__claude-in-chrome__shortcuts_execute') return parsedInput.command ? `/${String(parsedInput.command)}` : 'Shortcut';

  // Task tools
  if (tc.name === 'Task') return parsedInput.description ? truncateStr(String(parsedInput.description), 40) : '';
  if (tc.name === 'AskUserQuestion') {
    const questions = parsedInput.questions as any[];
    return questions?.[0]?.question ? truncateStr(String(questions[0].question), 50) : '';
  }
  if (tc.name === 'TodoWrite') {
    const todos = parsedInput.todos as any[];
    return `${todos?.length || 0} tasks`;
  }
  if (tc.name === 'TaskGet') return parsedInput.taskId ? `#${parsedInput.taskId}` : '';
  if (tc.name === 'TaskOutput') return parsedInput.task_id ? `task ${String(parsedInput.task_id).slice(0, 8)}` : '';
  if (tc.name === 'TaskStop') return parsedInput.task_id ? `stop ${String(parsedInput.task_id).slice(0, 8)}` : '';
  if (tc.name === 'TaskList') return '';
  if (tc.name === 'TaskCreate') return parsedInput.subject ? truncateStr(String(parsedInput.subject), 40) : '';
  if (tc.name === 'TaskUpdate') {
    const id = parsedInput.taskId ? `#${parsedInput.taskId}` : '';
    const status = parsedInput.status ? String(parsedInput.status) : '';
    if (id && status) return `${id} → ${status}`;
    return id || '';
  }
  if (tc.name === 'SendMessage') {
    if (parsedInput.summary) return truncateStr(String(parsedInput.summary), 40);
    if (parsedInput.recipient) return `to ${String(parsedInput.recipient)}`;
    if (parsedInput.type === 'broadcast') return 'broadcast';
    return '';
  }
  if (tc.name === 'TeamCreate') return parsedInput.team_name ? String(parsedInput.team_name) : '';
  if (tc.name === 'TeamDelete') return 'Cleanup';
  if (tc.name === 'Skill') return `/${parsedInput.skill || ''}`;
  if (tc.name === 'NotebookEdit') {
    const path = parsedInput.notebook_path ? getRelativePath(String(parsedInput.notebook_path)) : '';
    return path;
  }

  if (tc.name.startsWith('mcp__')) {
    const parts = tc.name.split('__');
    const method = parts[2] || '';
    const displayMethod = method.replace(/_/g, ' ');
    if (parsedInput.url) return shortenUrl(String(parsedInput.url));
    if (parsedInput.query) return truncateStr(String(parsedInput.query), 30);
    return displayMethod || parts[1] || '';
  }

  return '';
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
    'code-reviewer': Theme.red,
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
      <RNText style={styles.specialToolContent} selectable numberOfLines={expanded ? 50 : 3}>{truncatedPrompt}</RNText>
      {!expanded && prompt.length > 300 && (
        <RNText style={{ fontSize: 10, color: Theme.textDim, marginTop: 2 }}>show more</RNText>
      )}
      {expanded && result && (
        <RNView style={styles.specialToolResult}>
          <RNText style={styles.specialToolResultLabel}>Result</RNText>
          <RNText style={[styles.specialToolResultText, result.is_error && { color: Theme.red }]} selectable numberOfLines={20}>
            {result.content}
          </RNText>
        </RNView>
      )}
    </TouchableOpacity>
  );
}

function AskUserQuestionBlock({ tool, result }: { tool: ToolCall; result?: ToolResult }) {
  let parsedInput: { questions?: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>; answers?: Record<string, string> } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

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

  return (
    <RNView style={styles.askQuestionBlock}>
      {questions.map((q, i) => {
        const answer = answers[q.question];
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
            <RNView style={styles.optionsRow}>
              {q.options.map((opt, j) => {
                const cleanLabel = opt.label.replace(' (Recommended)', '');
                const isSelected = answer !== undefined && (opt.label === answer || cleanLabel === answer);
                return (
                  <RNView
                    key={j}
                    style={[
                      styles.optionPill,
                      isSelected && styles.optionPillSelected
                    ]}
                  >
                    {isSelected && (
                      <FontAwesome name="check" size={10} color={Theme.green} style={{ marginRight: 4 }} />
                    )}
                    <RNText style={[
                      styles.optionPillText,
                      isSelected && styles.optionPillTextSelected
                    ]}>
                      {opt.label}
                    </RNText>
                  </RNView>
                );
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
    : image.data
      ? `data:${image.media_type};base64,${image.data}`
      : undefined;
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
      <RNView style={styles.imageFadeOverlay} pointerEvents="none">
        <RNView style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.02)' }} />
        <RNView style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.08)' }} />
        <RNView style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.2)' }} />
        <RNView style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' }} />
      </RNView>
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

function GalleryImage({ image, screenWidth, screenHeight, onZoomChange }: { image: ImageData; screenWidth: number; screenHeight: number; onZoomChange?: (zoomed: boolean) => void }) {
  const src = useImageSrc(image);

  const scaleVal = useRef(new Animated.Value(1)).current;
  const translateXVal = useRef(new Animated.Value(0)).current;
  const translateYVal = useRef(new Animated.Value(0)).current;

  const pinchState = useRef({ startDist: 0, startScale: 1, scale: 1 });
  const panState = useRef({ startX: 0, startY: 0, startTx: 0, startTy: 0, tx: 0, ty: 0, isPanning: false });
  const lastTap = useRef(0);

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
    }
  }, [scaleVal, translateXVal, translateYVal, setZoomed]);

  const handleTouchEnd = useCallback(() => {
    panState.current.isPanning = false;
    if (pinchState.current.scale < 1) {
      resetTransform();
    }
  }, [resetTransform]);

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
  const { width: deviceWidth, height: deviceHeight } = useWindowDimensions();

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
            renderItem={({ item }) => <GalleryImage image={item} screenWidth={screenWidth} screenHeight={screenHeight} onZoomChange={handleZoomChange} />}
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

type InsightPart = { type: 'text'; content: string } | { type: 'insight'; label: string; content: string };

function parseInsightBlocks(text: string): InsightPart[] {
  if (!text || typeof text !== 'string') return [{ type: 'text', content: String(text || '') }];
  const insightRegex = /`([★✦⭐☆\*])\s+([\w\s]+?)\s*─+`([\s\S]*?)`─+`/g;
  const parts: InsightPart[] = [];
  let lastIndex = 0;
  let match;
  while ((match = insightRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index).trim();
      if (before) parts.push({ type: 'text', content: before });
    }
    parts.push({ type: 'insight', label: match[2].trim(), content: match[3].trim() });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) parts.push({ type: 'text', content: remaining });
  }
  if (parts.length === 0) parts.push({ type: 'text', content: text });
  return parts;
}

function InsightCard({ label, content }: { label: string; content: string }) {
  return (
    <RNView style={styles.insightCard}>
      <RNView style={styles.insightHeader}>
        <RNText style={styles.insightStar}>{'\u2605'}</RNText>
        <RNText style={styles.insightLabel}>{label}</RNText>
      </RNView>
      <MarkdownContent text={content} baseStyle={styles.insightContent} isUser={false} />
    </RNView>
  );
}

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
  const { color } = toolIcon(toolCall.name);
  const summary = toolSummary(toolCall);
  const [viewMode, setViewMode] = useState<'raw' | 'rendered'>('rendered');

  // Format input nicely - parse JSON and extract relevant fields
  let inputDisplay = toolCall.input;
  try {
    const parsed = JSON.parse(toolCall.input);
    if (toolCall.name === 'Bash' && parsed.command) {
      // For Bash, just show the command
      inputDisplay = parsed.command;
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
  const resultDisplay = result && expanded && processedResult.length > 2000
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
  const [mdOverflowing, setMdOverflowing] = useState(false);
  const [mdExpanded, setMdExpanded] = useState(false);
  const [mdFullscreen, setMdFullscreen] = useState(false);
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
        <RNText style={[styles.toolCallName, { color }]}>{formatToolName(toolCall.name)}</RNText>
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
          onLayout={(e) => { if (!toolContentFullExpanded) setToolContentOverflowing(e.nativeEvent.layout.height >= TOOL_CONTENT_MAX_HEIGHT); }}
          style={[styles.toolCallContent, result?.is_error && styles.toolCallContentError, !toolContentFullExpanded && { maxHeight: TOOL_CONTENT_MAX_HEIGHT, overflow: 'hidden' as const }]}>

          {language && !isBash && !(isEdit && parsedInput.old_string && parsedInput.new_string) && (
            <RNView style={styles.languageLabelRow}>
              <RNText style={styles.languageLabel}>{language}</RNText>
              {isPlan && (
                <RNView style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 3, backgroundColor: Theme.bgHighlight }}>
                  <RNText style={{ fontSize: 9, color: Theme.textMuted, fontWeight: '600', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>PLAN</RNText>
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
                <RNText>{inputDisplay}</RNText>
              </RNText>
            </RNView>
          ) : !shouldHideInput && toolCall.input && toolCall.input.length > 2 ? (
            <RNView style={styles.toolInputSection}>
              <RNText style={styles.toolCallInput} selectable>{inputDisplay}</RNText>
            </RNView>
          ) : null}
          {isEdit && parsedInput.old_string && parsedInput.new_string ? (
            <DiffBlock oldStr={String(parsedInput.old_string)} newStr={String(parsedInput.new_string)} filePath={filePath} />
          ) : isWrite && parsedInput.content ? (
            isMarkdownFile && viewMode === 'rendered' ? (
              <>
                <RNView
                  style={!mdExpanded && mdOverflowing ? { maxHeight: MD_COLLAPSED_HEIGHT, overflow: 'hidden' } : undefined}
                  onLayout={(e) => { if (!mdExpanded) setMdOverflowing(e.nativeEvent.layout.height >= MD_COLLAPSED_HEIGHT); }}
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
                  {resultDisplay}
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

function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = truncateLines(content, expanded ? 50 : 2);
  const isLong = truncated.truncated || content.length > 200;

  return (
    <TouchableOpacity
      onPress={() => isLong && setExpanded(!expanded)}
      style={styles.thinkingBlock}
      activeOpacity={isLong ? 0.7 : 1}
    >
      <RNView style={styles.thinkingHeader}>
        {isLong && (
          <FontAwesome name={expanded ? "chevron-down" : "chevron-right"} size={8} color={Theme.textDim} style={{ marginRight: 4, marginTop: 3 }} />
        )}
        <RNText style={styles.thinkingText} numberOfLines={expanded ? 50 : 2}>
          {expanded ? content : truncated.text}{!expanded && truncated.truncated ? '...' : ''}
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

function MessageBubble({ message, agentType, model, showHeader = true, forkChildren, conversationId, onFork, taskSubjectMap, globalToolResultMap, globalImageMap, openGallery, userName, showToast, collapsed: globalCollapsed, showThinkingGlobal, childConversationMap, bookmarkedSet }: {
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
  showThinkingGlobal?: boolean;
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
  const hasThinkingContent = !!message.thinking?.trim();
  const visibleThinking = hasThinkingContent && (showThinkingGlobal ?? false);

  // Skip truly empty messages (no content, no tool calls, no images, no thinking)
  if (!rawContent.trim() && !hasToolCalls && !hasImages && !hasThinkingContent) {
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
  const isToolCallOnly = !isUser && hasToolCalls && !content.trim() && !hasImages;
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
            <RNView style={[styles.agentDot, { backgroundColor: agentType === 'codex' ? '#10b981' : agentType === 'cursor' ? '#60a5fa' : agentType === 'gemini' ? '#1a73e8' : Theme.accent }]} />
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


      {hasImages && (
        <RNView style={styles.imagesContainer}>
          {message.images!.map((img, i) => (
            <ImageBlock key={i} image={img} onPress={() => openGallery?.(img)} />
          ))}
        </RNView>
      )}

      {visibleThinking && (
        <ThinkingBlock content={message.thinking!} />
      )}

      {content ? (
        <>
        <RNView
          style={[
            styles.bubbleContent,
            isLongContent && !contentExpanded && styles.bubbleContentCollapsed,
            !isUser && !contentExpanded && !isLongContent && { maxHeight: ASSISTANT_CONTENT_MAX_HEIGHT, overflow: 'hidden' as const },
            isUser && !userContentExpanded && !isLongContent && { maxHeight: ASSISTANT_CONTENT_MAX_HEIGHT, overflow: 'hidden' as const },
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
            const insightParts = parseInsightBlocks(content);
            const hasInsights = insightParts.some(p => p.type === 'insight');
            if (hasInsights) {
              return insightParts.map((part, idx) =>
                part.type === 'insight'
                  ? <InsightCard key={idx} label={part.label} content={part.content} />
                  : <MarkdownContent key={idx} text={part.content} baseStyle={[styles.bubbleText, isUser ? styles.userText : styles.assistantText]} isUser={isUser} />
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
              return <AskUserQuestionBlock key={tc.id} tool={tc} result={result} />;
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
                  <RNText style={{ fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: Theme.violet, fontWeight: '600' }}>Plan Mode</RNText>
                  <RNView style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: 'rgba(108, 113, 196, 0.15)', borderWidth: 0.5, borderColor: 'rgba(108, 113, 196, 0.3)' }}>
                    <RNText style={{ fontSize: 9, color: Theme.violet, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>enter</RNText>
                  </RNView>
                </RNView>
              );
            }
            if (tc.name === 'ExitPlanMode') {
              return (
                <RNView key={tc.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2 }}>
                  <FontAwesome name="map-o" size={10} color={Theme.violet} />
                  <RNText style={{ fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: Theme.violet, fontWeight: '600' }}>Plan Mode</RNText>
                  <RNView style={{ paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, backgroundColor: 'rgba(108, 113, 196, 0.15)', borderWidth: 0.5, borderColor: 'rgba(108, 113, 196, 0.3)' }}>
                    <RNText style={{ fontSize: 9, color: Theme.violet, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>exit</RNText>
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

// --- Pending messages & input ---

type PendingMessage = {
  _id: string;
  conversation_id: string;
  content: string;
  status: 'pending' | 'delivered' | 'failed';
  created_at: number;
  retry_count: number;
};

function MessageInput({ conversationId, isActive, draft }: { conversationId: Id<"conversations">; isActive: boolean; draft?: string | null }) {
  const [message, setMessage] = useState(draft || '');
  const [isSending, setIsSending] = useState(false);
  const [lastStatus, setLastStatus] = useState<'delivered' | 'failed' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedImages, setSelectedImages] = useState<{ uri: string; storageId?: string; uploading: boolean }[]>([]);
  const managedSession = useQuery(api.managedSessions.isSessionManaged, { conversation_id: conversationId });

  const sendMessage = useMutation(api.pendingMessages.sendMessageToSession);
  const retryMessage = useMutation(api.pendingMessages.retryMessage);
  const patchConversation = useMutation(api.conversations.patchConversation);
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);

  const draftRef = useRef(draft || '');
  useEffect(() => {
    if (!message && !draftRef.current) return;
    if (message === draftRef.current) return;
    draftRef.current = message;
    const t = setTimeout(() => {
      patchConversation({ id: conversationId, fields: { draft_message: message || null } }).catch(() => {});
    }, 1000);
    return () => clearTimeout(t);
  }, [message]);

  const pendingMessages = useQuery(api.pendingMessages.getPendingMessages, {}) as PendingMessage[] | undefined;

  const conversationPendingMessages = pendingMessages?.filter(
    (msg) => msg.conversation_id === conversationId
  ) || [];

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
          setSelectedImages(prev => [...prev, { uri, uploading: true }]);
          uploadToStorage(uri).then(storageId => {
            setSelectedImages(prev => prev.map(img => img.uri === uri ? { ...img, storageId, uploading: false } : img));
          }).catch(() => {
            setSelectedImages(prev => prev.filter(img => img.uri !== uri));
            Alert.alert('Upload failed', 'Could not upload image');
          });
        }
      }
    } catch (err) {
      console.error('Image picker error:', err);
    }
  };

  const removeImage = (uri: string) => {
    setSelectedImages(prev => prev.filter(img => img.uri !== uri));
  };

  const handleSend = async () => {
    const trimmedMessage = message.trim();
    if ((!trimmedMessage && selectedImages.length === 0) || isSending) return;

    setIsSending(true);
    setError(null);

    const hasUploading = selectedImages.some(img => img.uploading);
    if (hasUploading) {
      setError('Images still uploading...');
      setIsSending(false);
      return;
    }

    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const storageIds = selectedImages.filter(img => img.storageId).map(img => img.storageId!);
      await sendMessage({
        conversation_id: conversationId,
        content: trimmedMessage || (storageIds.length > 0 ? '[image]' : ''),
        ...(storageIds.length > 0 ? { image_storage_ids: storageIds as Id<"_storage">[] } : {}),
      });
      setMessage('');
      draftRef.current = '';
      patchConversation({ id: conversationId, fields: { draft_message: null } }).catch(() => {});
      setSelectedImages([]);
      setLastStatus('delivered');
      setTimeout(() => setLastStatus(null), 2000);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
      setLastStatus('failed');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <RNView style={styles.inputContainer}>
      {error && (
        <RNView style={styles.errorBanner}>
          <RNText style={styles.errorBannerText}>{error}</RNText>
          <TouchableOpacity onPress={() => setError(null)}>
            <RNText style={styles.errorBannerDismiss}>x</RNText>
          </TouchableOpacity>
        </RNView>
      )}
      {selectedImages.length > 0 && (
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
      )}
      {managedSession?.managed && (managedSession.agent_status === "working" || managedSession.agent_status === "thinking" || managedSession.agent_status === "compacting" || managedSession.agent_status === "permission_blocked" || managedSession.agent_status === "connected") && (
        <RNView style={[styles.agentStatusBar, {
          backgroundColor: managedSession.agent_status === "thinking" ? 'rgba(108,113,196,0.12)' :
            managedSession.agent_status === "compacting" ? 'rgba(245,158,11,0.12)' :
            managedSession.agent_status === "permission_blocked" ? 'rgba(203,75,22,0.12)' :
            managedSession.agent_status === "connected" ? 'rgba(42,161,152,0.12)' :
            'rgba(16,185,129,0.12)',
          borderColor: managedSession.agent_status === "thinking" ? 'rgba(108,113,196,0.3)' :
            managedSession.agent_status === "compacting" ? 'rgba(245,158,11,0.3)' :
            managedSession.agent_status === "permission_blocked" ? 'rgba(203,75,22,0.3)' :
            managedSession.agent_status === "connected" ? 'rgba(42,161,152,0.3)' :
            'rgba(16,185,129,0.3)',
        }]}>
          <RNView style={[styles.agentStatusDot, {
            backgroundColor: managedSession.agent_status === "thinking" ? Theme.violet :
              managedSession.agent_status === "compacting" ? '#f59e0b' :
              managedSession.agent_status === "permission_blocked" ? Theme.orange :
              managedSession.agent_status === "connected" ? Theme.cyan :
              Theme.greenBright,
          }]} />
          <RNText style={[styles.agentStatusText, {
            color: managedSession.agent_status === "thinking" ? Theme.violet :
              managedSession.agent_status === "compacting" ? '#f59e0b' :
              managedSession.agent_status === "permission_blocked" ? Theme.orange :
              managedSession.agent_status === "connected" ? Theme.cyan :
              Theme.greenBright,
          }]}>
            {managedSession.agent_status === "thinking" ? "Thinking" :
             managedSession.agent_status === "compacting" ? "Compacting" :
             managedSession.agent_status === "permission_blocked" ? "Needs Input" :
             managedSession.agent_status === "connected" ? "Connected" :
             "Working"}
          </RNText>
        </RNView>
      )}
      <RNView style={styles.inputRow}>
        <TouchableOpacity
          style={styles.imageButton}
          onPress={pickImage}
          disabled={isSending}
          activeOpacity={0.7}
        >
          <FontAwesome name="plus" size={20} color={Theme.textMuted} />
        </TouchableOpacity>
        <TextInput
          style={styles.textInput}
          value={message}
          onChangeText={setMessage}
          placeholder={isActive ? "Type a message..." : "Send to resume session..."}
          placeholderTextColor={Theme.textMuted0}
          multiline
          maxLength={10000}
          editable={!isSending}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          style={[styles.sendButton, ((!message.trim() && selectedImages.length === 0) || isSending) && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={(!message.trim() && selectedImages.length === 0) || isSending}
          activeOpacity={0.7}
        >
          {isSending ? (
            <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <ActivityIndicator size="small" color="#fff" />
              <RNText style={styles.sendButtonText}>Sending</RNText>
            </RNView>
          ) : lastStatus === 'delivered' ? (
            <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <FontAwesome name="check" size={12} color="#fff" />
              <RNText style={styles.sendButtonText}>Sent</RNText>
            </RNView>
          ) : (
            <FontAwesome name="arrow-up" size={16} color="#fff" />
          )}
        </TouchableOpacity>
      </RNView>
      {!isActive && (
        <RNView style={styles.inactiveSessionBanner}>
          <RNText style={styles.inactiveSessionCompactText} numberOfLines={1}>
            Session inactive. Send to auto-resume.
          </RNText>
        </RNView>
      )}
    </RNView>
  );
}

// --- Main screen with pagination ---

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
  const { id, message: highlightMessageParam } = useLocalSearchParams<{ id: string; message?: string }>();
  const convex = useConvex();
  const flatListRef = useRef<FlatList>(null);
  const [olderMessages, setOlderMessages] = useState<Message[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadCooldownRef = useRef(false);
  const [olderHasMore, setOlderHasMore] = useState(true);
  const [olderOldestTs, setOlderOldestTs] = useState<number | null>(null);
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
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(highlightMessageParam || null);
  const [jumpingToStart, setJumpingToStart] = useState(false);
  const [jumpingToEnd, setJumpingToEnd] = useState(false);
  const [floatingHeaderHeight, setFloatingHeaderHeight] = useState(152);
  const floatingHeaderY = useRef(new Animated.Value(0)).current;
  const floatingHeaderOffsetRef = useRef(0);
  const lastScrollYRef = useRef(0);
  const activePulse = useRef(new Animated.Value(1)).current;
  const didInitialScrollRef = useRef(false);
  const initialScrollDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const conversation = useQuery(
    api.conversations.getAllMessages,
    id ? { conversation_id: id as Id<"conversations">, limit: 50 } : "skip"
  ) as ConversationData | null | undefined;

  const pendingPermissions = useQuery(
    api.permissions.getPendingPermissions,
    id ? { conversation_id: id as Id<"conversations"> } : "skip"
  );

  const bookmarkedMessageIds = useQuery(
    api.bookmarks.getConversationBookmarks,
    id ? { conversation_id: id as Id<"conversations"> } : "skip"
  );
  const bookmarkedSet = useMemo(() => new Set(bookmarkedMessageIds?.map(id => id.toString()) || []), [bookmarkedMessageIds]);

  const commits = useQuery(
    api.commits.getCommitsForConversation,
    id ? { conversation_id: id as Id<"conversations"> } : "skip"
  ) as Array<{
    _id: string; sha: string; message: string; timestamp: number;
    files_changed: number; insertions: number; deletions: number;
  }> | undefined;

  const pullRequests = useQuery(
    api.pull_requests.getPRsForConversation,
    id ? { conversation_id: id as Id<"conversations"> } : "skip"
  ) as Array<{
    _id: string; number: number; title: string; state: string;
    repository: string; additions?: number; deletions?: number;
    created_at: number; merged_at?: number;
  }> | undefined;

  const treeResult = useQuery(
    api.conversations.getConversationTree,
    id ? { conversation_id: id as string } : "skip"
  ) as { tree: TreeNode } | { error: string } | null | undefined;

  const hasMoreAbove = olderHasMore && (conversation?.has_more_above !== false);

  const allMessages = useMemo(() => {
    const recent = conversation?.messages || [];
    const msgs = olderMessages.length === 0
      ? recent
      : (() => {
          const recentIds = new Set(recent.map((m) => m._id));
          return [
            ...olderMessages.filter((m) => !recentIds.has(m._id)),
            ...recent,
          ];
        })();
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
  }, [conversation?.messages, olderMessages, commits, pullRequests]);

  const invertedMessages = useMemo(() => [...allMessages].reverse(), [allMessages]);

  const forkFromMessage = useMutation(api.conversations.forkFromMessage);
  const router = useRouter();

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

  const allSessionImages = useMemo(() => {
    const imgs: ImageData[] = [];
    for (const msg of allMessages) {
      if (msg.images) {
        for (const img of msg.images) {
          imgs.push(img);
        }
      }
    }
    return imgs;
  }, [allMessages]);

  const [galleryVisible, setGalleryVisible] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const openGallery = useCallback((image: ImageData) => {
    const idx = allSessionImages.findIndex(img =>
      (img.storage_id && img.storage_id === image.storage_id) ||
      (img.data && img.data === image.data) ||
      (img.tool_use_id && img.tool_use_id === image.tool_use_id)
    );
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
    if (!conversation?.session_id) return;
    const agentType = conversation.agent_type;
    let cmd: string;
    if (agentType === 'codex') {
      cmd = `codex resume ${conversation.session_id}`;
    } else {
      cmd = `cast resume ${conversation.session_id}`;
    }
    Clipboard.setString(cmd);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    showToast('Resume command copied');
  }, [conversation?.session_id, conversation?.agent_type, showToast]);

  const toggleFavoriteConversation = useMutation(api.conversations.toggleFavorite);
  const generateShareLink = useMutation(api.conversations.generateShareLink);

  const handleToggleFavorite = useCallback(async () => {
    if (!id) return;
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await toggleFavoriteConversation({ conversation_id: id as Id<"conversations"> });
    } catch {}
  }, [id, toggleFavoriteConversation]);

  const handleShareConversation = useCallback(async () => {
    if (!conversation || !id) return;
    try {
      let token = conversation.share_token;
      if (!token) {
        token = await generateShareLink({ conversation_id: id as Id<"conversations"> });
      }
      if (token) {
        const url = `https://codecast.sh/share/${token}`;
        await Share.share({ message: url, url });
      }
    } catch {}
  }, [conversation, id, generateShareLink]);

  const searchLower = searchQuery.toLowerCase();
  const searchMatchIds = useMemo(() => {
    if (!searchLower) return null;
    const ids = new Set<string>();
    for (const msg of allMessages) {
      if (msg.content && msg.content.toLowerCase().includes(searchLower)) ids.add(msg._id);
    }
    return ids;
  }, [searchLower, allMessages]);

  const searchMatchList = useMemo(() => {
    if (!searchLower) return [];
    return allMessages.filter(msg => msg.content && msg.content.toLowerCase().includes(searchLower)).map(m => m._id);
  }, [searchLower, allMessages]);

  useEffect(() => { setCurrentMatchIndex(0); }, [searchQuery]);

  useEffect(() => {
    if (highlightedMessageId && allMessages.length > 0) {
      const idx = allMessages.findIndex(m => m._id === highlightedMessageId);
      if (idx >= 0) {
        const invertedIdx = allMessages.length - 1 - idx;
        setTimeout(() => {
          flatListRef.current?.scrollToIndex({ index: invertedIdx, animated: true, viewPosition: 0.3 });
        }, 500);
        setTimeout(() => setHighlightedMessageId(null), 3000);
      }
    }
  }, [highlightedMessageId, allMessages.length]);

  const goToNextMatch = useCallback(() => {
    if (searchMatchList.length === 0) return;
    const nextIndex = (currentMatchIndex + 1) % searchMatchList.length;
    setCurrentMatchIndex(nextIndex);
    const idx = allMessages.findIndex(m => m._id === searchMatchList[nextIndex]);
    if (idx >= 0) {
      const invertedIdx = allMessages.length - 1 - idx;
      flatListRef.current?.scrollToIndex({ index: invertedIdx, animated: true, viewPosition: 0.3 });
    }
  }, [searchMatchList, currentMatchIndex, allMessages]);

  const goToPrevMatch = useCallback(() => {
    if (searchMatchList.length === 0) return;
    const prevIndex = currentMatchIndex === 0 ? searchMatchList.length - 1 : currentMatchIndex - 1;
    setCurrentMatchIndex(prevIndex);
    const idx = allMessages.findIndex(m => m._id === searchMatchList[prevIndex]);
    if (idx >= 0) {
      const invertedIdx = allMessages.length - 1 - idx;
      flatListRef.current?.scrollToIndex({ index: invertedIdx, animated: true, viewPosition: 0.3 });
    }
  }, [searchMatchList, currentMatchIndex, allMessages]);

  const latestUsage = useMemo(() => {
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
  }, [floatingHeaderY]);

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
    setOlderMessages([]);
    setOlderHasMore(true);
    setOlderOldestTs(null);
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
    floatingHeaderOffsetRef.current = 0;
    floatingHeaderY.setValue(0);
  }, [id, floatingHeaderHeight, floatingHeaderY]);

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
  }, [searchVisible, floatingHeaderY]);

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

  const loadOlderMessages = useCallback(async () => {
    if (loadingOlder || !id) return;

    const beforeTs = olderOldestTs ?? conversation?.oldest_timestamp;
    if (!beforeTs) return;

    setLoadingOlder(true);
    try {
      const result = await convex.query(api.conversations.getOlderMessages, {
        conversation_id: id as Id<"conversations">,
        before_timestamp: beforeTs,
        limit: 50,
      });

      if (result && result.messages.length > 0) {
        setOlderMessages(prev => {
          const existingIds = new Set(prev.map(m => m._id));
          const newMsgs = result.messages.filter((m: Message) => !existingIds.has(m._id));
          return [...newMsgs, ...prev];
        });
        setOlderOldestTs(result.oldest_timestamp);
        setOlderHasMore(result.has_more);
      } else {
        setOlderHasMore(false);
      }
    } catch {
      setOlderHasMore(false);
    } finally {
      setLoadingOlder(false);
      loadCooldownRef.current = true;
      setTimeout(() => { loadCooldownRef.current = false; }, 500);
    }
  }, [convex, id, loadingOlder, olderOldestTs, conversation?.oldest_timestamp]);

  const handleJumpToEnd = useCallback(() => {
    if (!id || jumpingToEnd) return;
    setJumpingToEnd(true);
    try {
      setOlderMessages([]);
      setOlderHasMore(true);
      setOlderOldestTs(null);
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
  }, [id, jumpingToEnd, showToast]);

  const handleJumpToStart = useCallback(async () => {
    if (!id || jumpingToStart) return;

    if (!hasMoreAbove) {
      flatListRef.current?.scrollToEnd({ animated: true });
      return;
    }

    setJumpingToStart(true);
    try {
      const existingIds = new Set<string>(allMessages.map((message) => message._id));
      const loadedMessages: Message[] = [];
      let beforeTs = olderOldestTs ?? conversation?.oldest_timestamp ?? null;
      let hasMore = true;
      let latestOldest: number | null = beforeTs;

      while (hasMore && beforeTs !== null) {
        const result = await convex.query(api.conversations.getOlderMessages, {
          conversation_id: id as Id<"conversations">,
          before_timestamp: beforeTs,
          limit: 100,
        });

        if (!result || result.messages.length === 0) {
          hasMore = false;
          break;
        }

        for (const message of result.messages) {
          if (!existingIds.has(message._id)) {
            existingIds.add(message._id);
            loadedMessages.push(message);
          }
        }

        beforeTs = result.oldest_timestamp;
        latestOldest = result.oldest_timestamp;
        hasMore = result.has_more;
      }

      if (loadedMessages.length > 0) {
        setOlderMessages((prev) => {
          const prevIds = new Set(prev.map((message) => message._id));
          const merged = [...loadedMessages.filter((message) => !prevIds.has(message._id)), ...prev];
          merged.sort((a, b) => a.timestamp - b.timestamp);
          return merged;
        });
      }

      setOlderHasMore(false);
      setOlderOldestTs(latestOldest);
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 40);
    } catch {
      showToast('Failed to jump to start');
    } finally {
      setJumpingToStart(false);
    }
  }, [id, jumpingToStart, hasMoreAbove, allMessages, olderOldestTs, conversation?.oldest_timestamp, convex, showToast]);

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

    // Floating header: in inverted list, scrolling "up" visually (toward older) increases offset
    // Invert deltaY for header hide/show since scroll direction is flipped
    const visualDelta = -deltaY;
    if (searchVisible) {
      floatingHeaderOffsetRef.current = 0;
      floatingHeaderY.setValue(0);
    } else if (offset <= 0) {
      floatingHeaderOffsetRef.current = 0;
      floatingHeaderY.setValue(0);
    } else if (Math.abs(visualDelta) > 0.5) {
      const maxOffset = floatingHeaderHeight;
      const nextOffset = Math.max(0, Math.min(floatingHeaderOffsetRef.current + visualDelta, maxOffset));
      if (Math.abs(nextOffset - floatingHeaderOffsetRef.current) > 0.1) {
        floatingHeaderOffsetRef.current = nextOffset;
        const snapped = nextOffset < maxOffset * 0.5 ? 0 : -maxOffset;
        floatingHeaderY.setValue(snapped);
      }
    }

    // Load older messages when near the top (large offset in inverted list)
    if (distanceFromTop < 100 && hasMoreAbove && !loadingOlder && !loadCooldownRef.current && initialScrollDone) {
      loadOlderMessages();
    }
  }, [hasMoreAbove, loadingOlder, loadOlderMessages, initialScrollDone, floatingHeaderHeight, floatingHeaderY, searchVisible, userScrolled]);

  const lastMessageAt = conversation?.messages?.length
    ? conversation.messages[conversation.messages.length - 1]?.timestamp
    : undefined;
  const activityAt = lastMessageAt ?? conversation?.updated_at ?? conversation?.started_at ?? 0;
  const isActive = conversation?.status === 'active' && (Date.now() - activityAt) < 5 * 60 * 1000;

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
        <Stack.Screen
          options={{
            title: 'Conversation',
            headerStyle: { backgroundColor: Theme.bgAlt },
            headerTintColor: Theme.text,
            headerTitleStyle: { color: Theme.text, fontWeight: '600', fontSize: 17 },
            headerShadowVisible: false,
            headerBackButtonDisplayMode: 'minimal',
          }}
        />
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
      <Stack.Screen
        options={{
          title: conversation.title || 'Conversation',
          headerStyle: { backgroundColor: Theme.bgAlt },
          headerTintColor: Theme.text,
          headerTitleStyle: { color: Theme.text, fontWeight: '600', fontSize: 17 },
          headerShadowVisible: false,
          headerLargeTitle: false,
          headerBackButtonDisplayMode: 'minimal',
        }}
      />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <Animated.View
          style={[styles.floatingSessionHeader, { transform: [{ translateY: floatingHeaderY }] }]}
          onLayout={(event) => handleFloatingHeaderLayout(event.nativeEvent.layout.height)}
        >
            <RNView style={styles.floatingSessionCard}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.headerToolbar}
            >
              <TouchableOpacity onPress={handleToggleFavorite} style={[styles.toolbarButton, conversation.is_favorite && styles.toolbarButtonActive]} activeOpacity={0.7}>
                <Feather name="star" size={15} color={conversation.is_favorite ? Theme.accent : Theme.textMuted} />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleShareConversation} style={styles.toolbarButton} activeOpacity={0.7}>
                <Feather name="share-2" size={15} color={Theme.textMuted} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setSearchVisible(v => !v)} style={styles.toolbarButton} activeOpacity={0.7}>
                <Feather name="search" size={15} color={searchVisible ? Theme.cyan : Theme.textMuted} />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleCopyMenu} style={[styles.toolbarButton, shareSelectionMode && styles.toolbarButtonActive]} activeOpacity={0.7}>
                <Feather name="clipboard" size={15} color={Theme.textMuted} />
              </TouchableOpacity>
              {conversation.session_id && (
                <TouchableOpacity onPress={handleCopyResume} style={styles.toolbarButton} activeOpacity={0.7}>
                  <Feather name="terminal" size={15} color={Theme.textMuted} />
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => setCollapsed(c => !c)} style={[styles.toolbarButton, collapsed && styles.toolbarButtonActive]} activeOpacity={0.7}>
                <Feather name={collapsed ? "maximize-2" : "minimize-2"} size={15} color={collapsed ? Theme.cyan : Theme.textMuted} />
              </TouchableOpacity>
              {conversation.git_branch && (conversation.git_diff?.trim() || conversation.git_diff_staged?.trim()) && (
                <TouchableOpacity onPress={() => setDiffExpanded(d => !d)} style={[styles.toolbarButton, diffExpanded && styles.toolbarButtonActive]} activeOpacity={0.7}>
                  <Feather name="git-commit" size={15} color={diffExpanded ? Theme.green : Theme.textMuted} />
                </TouchableOpacity>
              )}
              {treeResult && !('error' in treeResult) && treeResult.tree && treeResult.tree.children.length > 0 && (
                <TouchableOpacity onPress={() => setTreeModalVisible(true)} style={styles.toolbarButton} activeOpacity={0.7}>
                  <Feather name="git-branch" size={15} color={Theme.violet} />
                </TouchableOpacity>
              )}
            </ScrollView>
            <RNView style={styles.toolbarDivider} />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.sessionMeta}
              >
                {conversation.agent_type && (
                  <RNView style={styles.metaBadgeIcon}>
                    <AgentLogoSvg agentType={conversation.agent_type} size={24} />
                    <RNText style={[styles.metaBadge, { color: agentTypeColor(conversation.agent_type) }]}>
                      {formatAgentType(conversation.agent_type)}
                    </RNText>
                  </RNView>
                )}
                {activityAt > 0 && (
                  <RNText style={styles.messageCountText}>{conversation.agent_type ? '\u00B7 ' : ''}{formatRelativeTime(activityAt)}</RNText>
                )}
                {isActive && (
                  <Animated.View style={[styles.activeDot, { opacity: activePulse }]} />
                )}
                {(conversation.fork_count ?? 0) > 0 && (
                  <Pressable onPress={() => setTreeModalVisible(true)} style={styles.forkBadge}>
                    <FontAwesome name="code-fork" size={9} color={Theme.violet} />
                    <RNText style={styles.forkBadgeText}>{conversation.fork_count}</RNText>
                  </Pressable>
                )}
                {conversation.git_branch && (
                  <Pressable
                    onPress={() => {
                      if (conversation.git_remote_url) {
                        const match = conversation.git_remote_url.match(/github\.com[:/](.+?)(?:\.git)?$/);
                        if (match) {
                          Linking.openURL(`https://github.com/${match[1]}/tree/${conversation.git_branch}`);
                        }
                      }
                    }}
                    style={styles.gitBranchBadge}
                  >
                    <FontAwesome name="code-fork" size={9} color={Theme.green} />
                    <RNText style={styles.gitBranchText} numberOfLines={1}>{conversation.git_branch}</RNText>
                  </Pressable>
                )}
                {latestUsage && (
                  <RNView style={styles.usageBadge}>
                    <FontAwesome name="bar-chart" size={9} color={Theme.textDim} />
                    <RNText style={styles.usageBadgeText}>
                      {Math.round((latestUsage.contextSize / 200000) * 100)}%
                    </RNText>
                  </RNView>
                )}
                {conversation.parent_conversation_id && (
                  <Pressable
                    onPress={() => router.push(`/session/${conversation.parent_conversation_id}`)}
                    style={styles.floatingLinkPill}
                  >
                    <FontAwesome name="level-up" size={10} color={Theme.violet} />
                    <RNText style={styles.floatingLinkText}>Parent</RNText>
                  </Pressable>
                )}
                {conversation.forked_from_details && (
                  <Pressable
                    onPress={() => {
                      const details = conversation.forked_from_details!;
                      if (details.share_token) {
                        Linking.openURL(`https://codecast.sh/share/${details.share_token}`);
                      } else {
                        router.push(`/session/${details.conversation_id}`);
                      }
                    }}
                    style={styles.floatingLinkPill}
                  >
                    <FontAwesome name="code-fork" size={9} color={Theme.cyan} />
                    <RNText style={styles.floatingLinkText}>@{conversation.forked_from_details.username}</RNText>
                  </Pressable>
                )}
              </ScrollView>
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
            {diffExpanded && (conversation.git_diff?.trim() || conversation.git_diff_staged?.trim()) && (
              <RNView style={[styles.gitDiffPanel, { marginTop: 6, marginBottom: 2 }]}>
                {conversation.git_diff_staged && conversation.git_diff_staged.trim().length > 0 && (
                  <RNView style={{ marginBottom: 8 }}>
                    <RNText style={{ fontSize: 10, color: Theme.green, fontWeight: '600', marginBottom: 4, paddingHorizontal: 12 }}>Staged</RNText>
                    <RNView style={styles.gitDiffContent}>
                      <GitDiffView diff={conversation.git_diff_staged} />
                    </RNView>
                  </RNView>
                )}
                {conversation.git_diff && conversation.git_diff.trim().length > 0 && (
                  <RNView>
                    {conversation.git_diff_staged && conversation.git_diff_staged.trim().length > 0 && (
                      <RNText style={{ fontSize: 10, color: Theme.orange, fontWeight: '600', marginBottom: 4, paddingHorizontal: 12 }}>Unstaged</RNText>
                    )}
                    <RNView style={styles.gitDiffContent}>
                      <GitDiffView diff={conversation.git_diff} />
                    </RNView>
                  </RNView>
                )}
              </RNView>
            )}
          </RNView>
        </Animated.View>
        <FlatList
          ref={flatListRef}
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
          ListHeaderComponent={
            conversation.child_conversations && conversation.child_conversations.length > 0 ? (
              <RNView style={styles.subagentLinksContainer}>
                <RNText style={styles.subagentLinksLabel}>SUBAGENTS</RNText>
                <RNView style={styles.subagentLinksRow}>
                  {conversation.child_conversations.map(child => (
                    <Pressable
                      key={child._id}
                      onPress={() => router.push(`/session/${child._id}`)}
                      style={styles.subagentLink}
                    >
                      <FontAwesome name="arrow-right" size={8} color={Theme.cyan} style={{ opacity: 0.7 }} />
                      <RNText style={styles.subagentLinkText} numberOfLines={1}>{child.title}</RNText>
                    </Pressable>
                  ))}
                </RNView>
              </RNView>
            ) : null
          }
          ListFooterComponent={
            <>
              <RNView style={{ height: floatingHeaderHeight }} />
              {hasMoreAbove && (
                <RNView style={styles.loadMoreIndicator}>
                  {loadingOlder ? (
                    <RNView style={styles.loadMorePill}>
                      <ActivityIndicator size="small" color={Theme.textMuted} />
                      <RNText style={styles.loadMorePillText}>Loading older messages...</RNText>
                    </RNView>
                  ) : (
                    <Pressable onPress={loadOlderMessages} style={styles.loadMorePill}>
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
            return (
              <RNView style={[
                isSearchDimmed ? { opacity: 0.25 } : undefined,
                (isCurrentSearchMatch || isHighlighted) && styles.searchHighlight,
                shareSelectionMode && { paddingLeft: 28 },
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
                  onFork={handleForkFromMessage}
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
            <RNView style={styles.emptyState}>
              <FontAwesome name="comments-o" size={32} color={Theme.textDim} />
              <RNText style={styles.emptyStateText}>No messages yet</RNText>
              <RNText style={styles.emptyStateSubtext}>Messages will appear here as the session progresses</RNText>
            </RNView>
          }
          showsVerticalScrollIndicator={false}
          onScrollToIndexFailed={(info) => {
            setTimeout(() => {
              flatListRef.current?.scrollToIndex({
                index: info.index,
                animated: false,
                viewPosition: 1,
              });
            }, 200);
          }}
          onScroll={handleScroll}
          scrollEventThrottle={16}
          /* maintainVisibleContentPosition removed - was causing blank screen by fighting scroll offset */
        />

        <RNView>
          <MessageInput
            conversationId={id as Id<"conversations">}
            isActive={isActive}
            draft={conversation?.draft_message}
          />
        </RNView>

        {/* Jump arrows */}
        <RNView style={styles.jumpButtonsOverlay} pointerEvents="box-none">
          {allMessages.length > 150 && userScrolled && (
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
              style={[
                styles.jumpTopButtonWrap,
                {
                  top: floatingHeaderHeight + 4,
                  transform: [{ translateY: floatingHeaderY }],
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
            <RNView style={styles.jumpBottomButtonWrap}>
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
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Theme.bg,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 15,
    color: Theme.textMuted,
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
    paddingVertical: 6,
  },
  sessionMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'nowrap',
    marginBottom: 2,
    paddingRight: 8,
  },
  floatingLinksRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    flexWrap: 'wrap',
  },
  floatingLinkPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.bgHighlight,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  floatingLinkText: {
    fontSize: 11,
    color: Theme.textMuted,
    fontWeight: '500',
  },
  metaBadge: {
    fontSize: 10,
    fontWeight: '600',
  },
  metaBadgeModel: {
    fontSize: 9,
    color: Theme.textMuted,
    fontWeight: '600',
    fontFamily: 'SpaceMono',
    paddingHorizontal: 7,
    paddingVertical: 2,
    backgroundColor: Theme.bgAlt,
    borderRadius: 5,
  },
  messageCountText: {
    fontSize: 10,
    color: Theme.textMuted,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
  activeIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
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
  activeText: {
    fontSize: 12,
    color: Theme.green + 'CC',
    fontWeight: '500',
  },
  loadMoreButton: {
    alignItems: 'center',
    paddingVertical: 14,
    marginBottom: 8,
  },
  loadMoreText: {
    fontSize: 13,
    color: Theme.accent,
    fontWeight: '600',
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
  linkText: {
    color: Theme.cyan,
    textDecorationLine: 'underline',
  },
  linkTextUser: {
    color: Theme.userBubble,
    textDecorationLine: 'underline',
  },
  inlineCode: {
    fontFamily: 'SpaceMono',
    fontSize: 13,
    backgroundColor: 'rgba(0,0,0,0.07)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    color: Theme.red,
  },
  inlineCodeUser: {
    fontFamily: 'SpaceMono',
    fontSize: 13,
    backgroundColor: Theme.bgHighlight,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    color: Theme.text,
  },
  listContainer: {
    marginVertical: 4,
    paddingLeft: 4,
  },
  listItem: {
    flexDirection: 'row',
    marginBottom: 3,
  },
  listBullet: {
    width: 20,
    textAlign: 'center',
    opacity: 0.6,
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: Theme.accent,
    paddingLeft: 10,
    marginVertical: 6,
    opacity: 0.85,
  },
  blockquoteUser: {
    borderLeftWidth: 3,
    borderLeftColor: 'rgba(255,255,255,0.5)',
    paddingLeft: 10,
    marginVertical: 6,
    opacity: 0.85,
  },
  blockquoteText: {
    fontStyle: 'italic',
  },
  horizontalRule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Theme.borderLight,
    marginVertical: 12,
  },
  codeBlock: {
    marginVertical: 8,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#002b36',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  codeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(0,0,0,0.2)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  codeLanguage: {
    fontSize: 10,
    color: Theme.textDim,
    fontWeight: '500',
  },
  codeContent: {
    padding: 10,
  },
  codeText: {
    fontFamily: 'SpaceMono',
    fontSize: 12,
    lineHeight: 17,
    color: '#93a1a1',
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
  systemDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 16,
    paddingHorizontal: 8,
  },
  systemDividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: Theme.borderLight,
  },
  systemDividerText: {
    fontSize: 11,
    color: Theme.textMuted0,
    marginHorizontal: 10,
    fontStyle: 'italic',
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
  toolCallToggle: {
    fontSize: 8,
    color: Theme.textDim,
    marginLeft: 6,
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
  bashCommand: {
    fontSize: 11,
    fontFamily: 'SpaceMono',
    color: Theme.green,
  },
  diffSection: {
    gap: 2,
  },
  diffOld: {
    backgroundColor: Theme.red + '12',
    borderRadius: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  diffOldText: {
    fontSize: 12,
    fontFamily: 'SpaceMono',
    color: Theme.red,
  },
  diffNew: {
    backgroundColor: Theme.green + '12',
    borderRadius: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  diffNewText: {
    fontSize: 12,
    fontFamily: 'SpaceMono',
    color: Theme.green,
  },
  toolResultBox: {
    flexGrow: 0,
  },
  hScroll: {
    flexGrow: 0,
  },
  noOutputText: {
    fontSize: 12,
    color: Theme.textDim,
    paddingHorizontal: 8,
    paddingVertical: 2,
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
  toolResultSection: {
    marginTop: 4,
  },
  toolSectionLabel: {
    fontSize: 10,
    color: Theme.textMuted0,
    fontWeight: '600',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
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
  toolCodeText: {
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
    paddingBottom: 34,
  },
  agentStatusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
  },
  agentStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  agentStatusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  inactiveSessionBanner: {
    marginHorizontal: 12,
    marginBottom: 2,
    paddingHorizontal: 4,
    paddingTop: 2,
    paddingBottom: 4,
  },
  inactiveSessionCompactText: {
    fontSize: 11,
    color: Theme.textDim,
    textAlign: 'center',
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
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  textInput: {
    flex: 1,
    backgroundColor: Theme.bg,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    color: Theme.text,
    fontSize: 15,
    maxHeight: 100,
    minHeight: 40,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  sendButton: {
    backgroundColor: Theme.blue,
    minWidth: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  sendButtonDisabled: {
    backgroundColor: Theme.bgHighlight,
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
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
  optionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight + '60',
  },
  optionPillSelected: {
    backgroundColor: Theme.green + '20',
    borderColor: Theme.green + '60',
  },
  optionPillText: {
    fontSize: 12,
    color: Theme.textDim,
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
  messageImage: {
    width: '100%',
    height: 200,
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
  imageLoadingText: {
    fontSize: 11,
    color: Theme.textMuted0,
    marginTop: 6,
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
  forkBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: Theme.violet + '15',
    borderRadius: 4,
  },
  forkBadgeText: {
    fontSize: 10,
    color: Theme.violet,
    fontWeight: '600',
  },
  compactionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: 'rgba(217,119,6,0.1)',
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(217,119,6,0.3)',
  },
  compactionBadgeText: {
    fontSize: 10,
    color: '#d97706',
    fontWeight: '600',
  },
  // Agent dot
  agentDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
  // Table
  tableRow: {
    flexDirection: 'row',
  },
  tableRowAlt: {
    backgroundColor: Theme.bgHighlight,
  },
  tableHeaderCell: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: Theme.borderLight,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: Theme.borderLight,
    minWidth: 80,
    backgroundColor: Theme.bgAlt,
  },
  tableHeaderText: {
    fontWeight: '700',
    fontSize: 11,
  },
  tableCell: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: Theme.borderLight,
    minWidth: 80,
  },
  tableCellText: {
    fontSize: 11,
  },
  // Code copy button
  codeCopyButton: {
    padding: 4,
  },
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
  thinkingLabel: {
    fontSize: 10,
    color: Theme.textDim,
    fontWeight: '600',
    marginRight: 6,
  },
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
  durationBadge: {
    fontSize: 10,
    color: Theme.textDim,
    fontFamily: 'SpaceMono',
  },
  lineNumberGutter: {
    paddingRight: 8,
    marginRight: 8,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: Theme.borderLight,
  },
  lineNumber: {
    fontSize: 10,
    fontFamily: 'SpaceMono',
    color: Theme.textDim,
    lineHeight: 18,
    textAlign: 'right',
    minWidth: 24,
  },
  diffLineNumbers: {
    paddingRight: 6,
    marginRight: 6,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: 'rgba(255,255,255,0.1)',
  },
  diffLineNum: {
    fontSize: 9,
    fontFamily: 'SpaceMono',
    color: 'rgba(255,255,255,0.3)',
    lineHeight: 16,
    textAlign: 'right',
    minWidth: 20,
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
  toolbarDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Theme.borderLight + '80',
    marginHorizontal: 8,
    marginTop: 6,
    marginBottom: 2,
  },
  headerToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
    gap: 8,
    paddingTop: 7,
    paddingBottom: 2,
    paddingRight: 8,
    flexGrow: 1,
    minWidth: '100%',
  },
  toolbarButton: {
    flexBasis: 0,
    flexGrow: 1,
    minWidth: 32,
    height: 30,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolbarButtonActive: {
    backgroundColor: Theme.cyan + '14',
  },
  gitBranchBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: Theme.green + '12',
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.green + '30',
    maxWidth: 120,
  },
  gitBranchText: {
    fontSize: 10,
    color: Theme.green,
    fontWeight: '500',
    fontFamily: 'SpaceMono',
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
  subagentLinksContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  subagentLinksLabel: {
    fontSize: 10,
    color: Theme.textDim,
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  subagentLinksRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  subagentLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: Theme.cyan + '10',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.cyan + '20',
    maxWidth: 200,
  },
  subagentLinkText: {
    fontSize: 11,
    color: Theme.cyan,
    opacity: 0.7,
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
  usageBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(147, 161, 161, 0.1)',
    borderWidth: 0.5,
    borderColor: 'rgba(147, 161, 161, 0.2)',
  },
  usageBadgeText: {
    fontSize: 9,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: Theme.textDim,
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
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
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
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
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
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontWeight: '700',
  },
  apiErrorType: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  apiErrorMessage: {
    fontSize: 12,
    color: Theme.textSecondary,
    lineHeight: 17,
  },
  apiErrorRequestId: {
    fontSize: 9,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: Theme.textDim,
    marginTop: 4,
  },
  insightCard: {
    marginVertical: 4,
    padding: 10,
    borderRadius: 6,
    backgroundColor: Theme.violet + '12',
    borderLeftWidth: 2,
    borderLeftColor: Theme.violet,
  },
  insightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  insightStar: {
    fontSize: 12,
    color: Theme.violet,
  },
  insightLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: Theme.violet,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  insightContent: {
    fontSize: 13,
    color: Theme.textSecondary,
    lineHeight: 19,
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
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: Theme.textDim,
  },
});
