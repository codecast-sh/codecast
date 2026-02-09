import { StyleSheet, FlatList, ActivityIndicator, ScrollView, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, Share, View as RNView, Text as RNText, Linking, Image, ActionSheetIOS, Alert, Pressable, Clipboard, Modal, Animated, Dimensions } from 'react-native';
import { useLocalSearchParams, Stack, useRouter } from 'expo-router';
import { useQuery, useMutation, useConvex } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { Id } from '@codecast/convex/convex/_generated/dataModel';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import * as Haptics from 'expo-haptics';
// import * as ImagePicker from 'expo-image-picker';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { PermissionCard } from '@/components/PermissionCard';
import { Theme, Spacing } from '@/constants/Theme';
import { LinearGradient } from 'expo-linear-gradient';

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

type ForkChild = {
  _id: string;
  title: string;
  short_id?: string;
  parent_message_uuid?: string;
};

type ConversationData = {
  _id: string;
  title: string;
  status: string;
  is_favorite?: boolean;
  share_token?: string | null;
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
};

// --- Markdown rendering ---

function renderInlineMarkdown(text: string, baseStyle: any, keyPrefix = '', isUser = false): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s<>\])"',]+))/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push(<RNText key={`${keyPrefix}t${key++}`}>{text.slice(lastIndex, match.index)}</RNText>);
    }

    if (match[0].startsWith('`')) {
      const code = match[0].slice(1, -1);
      result.push(
        <RNText key={`${keyPrefix}c${key++}`} style={isUser ? styles.inlineCodeUser : styles.inlineCode}>{code}</RNText>
      );
    } else if (match[2] !== undefined) {
      result.push(
        <RNText key={`${keyPrefix}b${key++}`} style={{ fontWeight: '700' }}>{match[2]}</RNText>
      );
    } else if (match[3] !== undefined) {
      result.push(
        <RNText key={`${keyPrefix}i${key++}`} style={{ fontStyle: 'italic' }}>{match[3]}</RNText>
      );
    } else if (match[4] !== undefined) {
      result.push(
        <RNText key={`${keyPrefix}s${key++}`} style={{ textDecorationLine: 'line-through', color: Theme.textMuted0 }}>{match[4]}</RNText>
      );
    } else if (match[5] && match[6]) {
      const url = match[6];
      result.push(
        <RNText key={`${keyPrefix}l${key++}`} style={isUser ? styles.linkTextUser : styles.linkText} onPress={() => Linking.openURL(url)}>
          {match[5]}
        </RNText>
      );
    } else if (match[7]) {
      const url = match[7];
      let displayUrl = url;
      if (url.length > 50) {
        try {
          const parsed = new URL(url);
          const path = parsed.pathname.length > 1 ? parsed.pathname.slice(0, 20) + '...' : '';
          displayUrl = parsed.hostname + path;
        } catch { displayUrl = url.slice(0, 40) + '...'; }
      }
      result.push(
        <RNText key={`${keyPrefix}u${key++}`} style={isUser ? styles.linkTextUser : styles.linkText} onPress={() => Linking.openURL(url)}>
          {displayUrl}
        </RNText>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push(<RNText key={`${keyPrefix}t${key++}`}>{text.slice(lastIndex)}</RNText>);
  }

  return result;
}

function CodeBlockWithCopy({ content, language }: { content: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    Clipboard.setString(content);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const lines = content.split('\n');
  const showLineNumbers = lines.length > 3;

  return (
    <RNView style={styles.codeBlock}>
      <RNView style={styles.codeHeader}>
        <RNText style={styles.codeLanguage}>{language}</RNText>
        <TouchableOpacity onPress={handleCopy} style={styles.codeCopyButton} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          {copied ? (
            <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <FontAwesome name="check" size={10} color={Theme.green} />
              <RNText style={{ fontSize: 9, color: Theme.green, fontFamily: 'SpaceMono' }}>Copied</RNText>
            </RNView>
          ) : (
            <FontAwesome name="clipboard" size={11} color={Theme.textDim} />
          )}
        </TouchableOpacity>
      </RNView>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <RNView style={styles.codeContent}>
          {showLineNumbers ? (
            <RNView style={{ flexDirection: 'row' }}>
              <RNView style={styles.lineNumberGutter}>
                {lines.map((_, i) => (
                  <RNText key={i} style={styles.lineNumber}>{i + 1}</RNText>
                ))}
              </RNView>
              <RNText style={styles.codeText} selectable>{content}</RNText>
            </RNView>
          ) : (
            <RNText style={styles.codeText} selectable>{content}</RNText>
          )}
        </RNView>
      </ScrollView>
    </RNView>
  );
}

function MarkdownContent({ text, baseStyle, isUser }: { text: string; baseStyle: any; isUser: boolean }) {
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  const blocks: Array<{ type: 'text' | 'code'; content: string; language?: string }> = [];
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const t = text.slice(lastIndex, match.index);
      if (t.trim()) blocks.push({ type: 'text', content: t });
    }
    blocks.push({ type: 'code', content: match[2], language: match[1] || 'plaintext' });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const t = text.slice(lastIndex);
    if (t.trim()) blocks.push({ type: 'text', content: t });
  }

  if (blocks.length === 0) blocks.push({ type: 'text', content: text });

  return (
    <RNView>
      {blocks.map((block, idx) => {
        if (block.type === 'code') {
          return (
            <CodeBlockWithCopy key={idx} content={block.content} language={block.language || 'plaintext'} />
          );
        }

        return <MarkdownTextBlock key={idx} text={block.content} baseStyle={baseStyle} blockKey={`b${idx}`} isUser={isUser} />;
      })}
    </RNView>
  );
}

function MarkdownTextBlock({ text, baseStyle, blockKey, isUser = false }: { text: string; baseStyle: any; blockKey: string; isUser?: boolean }) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let elKey = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    const headerMatch = trimmed.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const fontSize = level === 1 ? 18 : level === 2 ? 16 : 15;
      elements.push(
        <RNText key={`${blockKey}h${elKey++}`} style={[baseStyle, { fontSize, fontWeight: '700', marginTop: 8, marginBottom: 4 }]}>
          {renderInlineMarkdown(headerMatch[2], baseStyle, `${blockKey}h${elKey}`, isUser)}
        </RNText>
      );
      i++;
      continue;
    }

    if (trimmed.match(/^[-*]\s/) || trimmed.match(/^\d+[.)]\s/)) {
      const listItems: { text: string; ordered: boolean; num?: number; checked?: boolean }[] = [];
      while (i < lines.length) {
        const l = lines[i].trim();
        const checkMatch = l.match(/^[-*]\s+\[([ xX])\]\s+(.*)/);
        const ulMatch = l.match(/^[-*]\s+(.*)/);
        const olMatch = l.match(/^(\d+)[.)]\s+(.*)/);
        if (checkMatch) {
          listItems.push({ text: checkMatch[2], ordered: false, checked: checkMatch[1] !== ' ' });
          i++;
        } else if (ulMatch) {
          listItems.push({ text: ulMatch[1], ordered: false });
          i++;
        } else if (olMatch) {
          listItems.push({ text: olMatch[2], ordered: true, num: parseInt(olMatch[1]) });
          i++;
        } else break;
      }
      elements.push(
        <RNView key={`${blockKey}li${elKey++}`} style={styles.listContainer}>
          {listItems.map((item, j) => (
            <RNView key={j} style={styles.listItem}>
              <RNText style={[baseStyle, styles.listBullet]}>
                {item.checked !== undefined ? (item.checked ? '\u2611' : '\u2610') : item.ordered ? `${item.num}.` : '\u2022'}
              </RNText>
              <RNText style={[baseStyle, { flex: 1 }, item.checked === true && { textDecorationLine: 'line-through', color: Theme.textMuted0 }]}>
                {renderInlineMarkdown(item.text, baseStyle, `${blockKey}li${j}`, isUser)}
              </RNText>
            </RNView>
          ))}
        </RNView>
      );
      continue;
    }

    if (trimmed.match(/^[-*_]{3,}$/)) {
      elements.push(
        <RNView key={`${blockKey}hr${elKey++}`} style={styles.horizontalRule} />
      );
      i++;
      continue;
    }

    if (trimmed.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('> ')) {
        quoteLines.push(lines[i].trim().slice(2));
        i++;
      }
      elements.push(
        <RNView key={`${blockKey}q${elKey++}`} style={isUser ? styles.blockquoteUser : styles.blockquote}>
          <RNText style={[baseStyle, styles.blockquoteText]}>
            {renderInlineMarkdown(quoteLines.join('\n'), baseStyle, `${blockKey}q${elKey}`, isUser)}
          </RNText>
        </RNView>
      );
      continue;
    }

    if (trimmed.includes('|') && i + 1 < lines.length && lines[i + 1]?.trim().match(/^\|?\s*[-:]+[-| :]*$/)) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().includes('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      const headerCells = tableLines[0].split('|').map(c => c.trim()).filter(Boolean);
      const bodyRows = tableLines.slice(2).map(row => row.split('|').map(c => c.trim()).filter(Boolean));
      elements.push(
        <ScrollView key={`${blockKey}tbl${elKey++}`} horizontal showsHorizontalScrollIndicator style={{ marginVertical: 6 }}>
          <RNView>
            <RNView style={styles.tableRow}>
              {headerCells.map((cell, ci) => (
                <RNView key={ci} style={styles.tableHeaderCell}>
                  <RNText style={[baseStyle, styles.tableHeaderText]}>{cell}</RNText>
                </RNView>
              ))}
            </RNView>
            {bodyRows.map((row, ri) => (
              <RNView key={ri} style={[styles.tableRow, ri % 2 === 1 && styles.tableRowAlt]}>
                {row.map((cell, ci) => (
                  <RNView key={ci} style={styles.tableCell}>
                    <RNText style={[baseStyle, styles.tableCellText]}>
                      {renderInlineMarkdown(cell, baseStyle, `${blockKey}tbl${ri}${ci}`, isUser)}
                    </RNText>
                  </RNView>
                ))}
              </RNView>
            ))}
          </RNView>
        </ScrollView>
      );
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i].trim();
      if (!l || l.match(/^#{1,3}\s/) || l.match(/^[-*]\s/) || l.match(/^\d+[.)]\s/) || l.startsWith('> ') || (l.includes('|') && i + 1 < lines.length && lines[i + 1]?.trim().match(/^\|?\s*[-:]+[-| :]*$/))) break;
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      elements.push(
        <RNText key={`${blockKey}p${elKey++}`} style={[baseStyle, { marginBottom: 6 }]} selectable>
          {renderInlineMarkdown(paraLines.join('\n'), baseStyle, `${blockKey}p${elKey}`, isUser)}
        </RNText>
      );
    }
  }

  return <>{elements}</>;
}

// --- Message components ---

function formatTimestamp(ts: number): string {
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
  if (!agentType) return '';
  if (agentType === 'claude_code') return 'Claude Code';
  if (agentType === 'codex') return 'Codex';
  if (agentType === 'cursor') return 'Cursor';
  return agentType;
}

function agentTypeColor(agentType?: string): string {
  if (agentType === 'codex') return '#10b981';
  if (agentType === 'cursor') return '#60a5fa';
  return Theme.accent;
}

function agentTypeIcon(agentType?: string): string {
  if (agentType === 'codex') return 'terminal';
  if (agentType === 'cursor') return 'mouse-pointer';
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

function TaskToolBlock({ tool, result }: { tool: ToolCall; result?: ToolResult }) {
  const [expanded, setExpanded] = useState(false);

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
          <RNText style={styles.specialToolMeta}>{model}</RNText>
        )}
        {name && (
          <RNText style={styles.specialToolMeta}>{name}</RNText>
        )}
        {runInBackground && (
          <RNText style={styles.specialToolMeta}>background</RNText>
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

function ImageBlock({ image }: { image: ImageData }) {
  const storageUrl = useQuery(
    api.images.getImageUrl,
    image.storage_id ? { storageId: image.storage_id as Id<"_storage"> } : "skip"
  );

  const src = image.storage_id
    ? storageUrl ?? undefined
    : image.data
      ? `data:${image.media_type};base64,${image.data}`
      : undefined;

  const [fullscreen, setFullscreen] = useState(false);

  if (!src) {
    return (
      <RNView style={styles.imageLoading}>
        <ActivityIndicator size="small" color={Theme.textMuted} />
        <RNText style={styles.imageLoadingText}>Loading image...</RNText>
      </RNView>
    );
  }

  return (
    <>
      <Pressable onPress={() => setFullscreen(true)} style={styles.imageContainer}>
        <Image
          source={{ uri: src }}
          style={styles.messageImage}
          resizeMode="contain"
        />
        <RNView style={styles.imageExpandHint}>
          <FontAwesome name="expand" size={10} color="rgba(255,255,255,0.8)" />
        </RNView>
      </Pressable>
      <Modal visible={fullscreen} transparent animationType="fade" onRequestClose={() => setFullscreen(false)}>
        <Pressable style={styles.fullscreenOverlay} onPress={() => setFullscreen(false)}>
          <TouchableOpacity style={styles.fullscreenClose} onPress={() => setFullscreen(false)} activeOpacity={0.7}>
            <FontAwesome name="close" size={20} color="#fff" />
          </TouchableOpacity>
          <Image
            source={{ uri: src }}
            style={styles.fullscreenImage}
            resizeMode="contain"
          />
        </Pressable>
      </Modal>
    </>
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

const PLAN_MAX_HEIGHT = 600;

function PlanBlock({ content, timestamp }: { content: string; timestamp?: number }) {
  const [expanded, setExpanded] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [contentExpanded, setContentExpanded] = useState(false);

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1] : 'Plan';

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
          {timestamp && <RNText style={{ fontSize: 10, color: Theme.textDim, marginLeft: 4 }}>{formatTimestamp(timestamp)}</RNText>}
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

function ToolCallItem({ toolCall, result, expanded, onToggle, images }: {
  toolCall: ToolCall;
  result?: ToolResult;
  expanded: boolean;
  onToggle: () => void;
  images?: ImageData[];
}) {
  const { color } = toolIcon(toolCall.name);
  const summary = toolSummary(toolCall);

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
    const isGlobGrep = toolCall.name === 'Glob' || toolCall.name === 'Grep' || toolCall.name === 'code_search';
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
  const isScreenshotTool = toolCall.name === 'mcp__claude-in-chrome__computer' && parsedInput.action === 'screenshot';
  const hasImages = images && images.length > 0 && isScreenshotTool;

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
    toolCall.name === 'code_search'
  );

  // Check if result is markdown-like (contains ### or **)
  const isMarkdownResult = result && !isCodeResult && typeof result.content === 'string' && (
    result.content.includes('###') ||
    result.content.includes('**') ||
    result.content.includes('```')
  );

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
      {expanded && (
        <RNView style={[styles.toolCallContent, result?.is_error && styles.toolCallContentError]}>
          {language && !isBash && (
            <RNText style={styles.languageLabel}>{language}</RNText>
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
            <RNView style={styles.diffSection}>
              <RNView style={styles.diffOld}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <RNView style={{ flexDirection: 'row' }}>
                    <RNView style={styles.diffLineNumbers}>
                      {String(parsedInput.old_string).split('\n').map((_, i) => (
                        <RNText key={i} style={styles.diffLineNum}>{i + 1}</RNText>
                      ))}
                    </RNView>
                    <RNText style={styles.diffOldText} selectable>
                      {String(parsedInput.old_string).split('\n').map(l => `- ${l}`).join('\n')}
                    </RNText>
                  </RNView>
                </ScrollView>
              </RNView>
              <RNView style={styles.diffNew}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <RNView style={{ flexDirection: 'row' }}>
                    <RNView style={styles.diffLineNumbers}>
                      {String(parsedInput.new_string).split('\n').map((_, i) => (
                        <RNText key={i} style={styles.diffLineNum}>{i + 1}</RNText>
                      ))}
                    </RNView>
                    <RNText style={styles.diffNewText} selectable>
                      {String(parsedInput.new_string).split('\n').map(l => `+ ${l}`).join('\n')}
                    </RNText>
                  </RNView>
                </ScrollView>
              </RNView>
            </RNView>
          ) : isWrite && parsedInput.content ? (
            <RNView style={styles.diffSection}>
              <RNView style={styles.diffNew}>
                <RNText style={styles.diffNewText} selectable>{String(parsedInput.content)}</RNText>
              </RNView>
            </RNView>
          ) : toolCall.name === 'apply_patch' && (parsedInput.input || parsedInput.patch) ? (
            <ScrollView style={styles.toolResultScroll} nestedScrollEnabled>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <RNText style={styles.toolCodeText} selectable>{String(parsedInput.input || parsedInput.patch)}</RNText>
              </ScrollView>
            </ScrollView>
          ) : null}
          {result && resultDisplay && resultDisplay.trim() ? (
            <ScrollView style={styles.toolResultScroll} nestedScrollEnabled>
              {isCodeResult ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <RNText style={[styles.toolCodeText, result.is_error && { color: Theme.red }]} selectable>{resultDisplay}</RNText>
                </ScrollView>
              ) : isMarkdownResult ? (
                <MarkdownContent text={resultDisplay} baseStyle={styles.toolCallResult} isUser={false} />
              ) : (
                <RNText style={[styles.toolCallResult, result.is_error && { color: Theme.red }]} selectable>
                  {resultDisplay}
                </RNText>
              )}
            </ScrollView>
          ) : result && (!resultDisplay || !resultDisplay.trim()) ? (
            <RNText style={styles.noOutputText}>No output</RNText>
          ) : null}
          {hasImages && images && (
            <RNView style={styles.toolImagesSection}>
              {images.map((img, i) => (
                <ImageBlock key={i} image={img} />
              ))}
            </RNView>
          )}
        </RNView>
      )}
    </Pressable>
  );
}

function ThinkingBlock({ content, showContent = true }: { content: string; showContent?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.split('\n').slice(0, 2).join('\n');
  const isLong = content.split('\n').length > 2 || content.length > 200;

  if (!showContent) {
    return (
      <RNView style={[styles.thinkingBlock, { opacity: 0.3 }]}>
        <RNText style={[styles.thinkingText, { fontStyle: 'italic' }]}>thinking...</RNText>
      </RNView>
    );
  }

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
          {expanded ? content : preview}{!expanded && isLong ? '...' : ''}
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
  return 'Claude';
}

const CONTENT_TRUNCATE_LENGTH = 3000;

function CommandStatusLine({ content, timestamp }: { content: string; timestamp: number }) {
  const cmdType = getCommandType(content);
  const displayText = cleanCommandContent(content).slice(0, 100) || content.replace(/<[^>]+>/g, '').slice(0, 100);

  return (
    <RNView style={styles.commandStatusLine}>
      <RNText style={styles.commandStatusTime}>{formatTimestamp(timestamp)}</RNText>
      <RNView style={styles.commandStatusBadge}>
        <RNText style={styles.commandStatusBadgeText}>{cmdType}</RNText>
      </RNView>
      <RNText style={styles.commandStatusText} numberOfLines={1}>{displayText}</RNText>
    </RNView>
  );
}

function MessageBubble({ message, agentType, model, showHeader = true, forkChildren, conversationId, onFork, taskSubjectMap, globalToolResultMap, userName, showToast }: {
  message: Message;
  agentType?: string;
  model?: string;
  showHeader?: boolean;
  forkChildren?: ForkChild[];
  conversationId?: string;
  onFork?: (messageUuid: string) => void;
  taskSubjectMap?: Record<string, string>;
  globalToolResultMap?: Record<string, ToolResult>;
  userName?: string;
  showToast?: (msg: string) => void;
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
  const toggleBookmark = useMutation(api.bookmarks.toggleBookmark);

  const handleLongPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const messageText = message.content || '';
    const canFork = !message.role?.startsWith('system') && message.message_uuid && onFork;
    const canBookmark = !!conversationId;
    const options = ['Copy Text', 'Share Message'];
    if (canBookmark) options.push('Bookmark');
    if (canFork) options.push('Fork from Here');
    options.push('Cancel');
    const cancelButtonIndex = options.length - 1;

    const handleAction = async (buttonIndex: number) => {
      const label = options[buttonIndex];
      if (label === 'Copy Text') {
        Clipboard.setString(messageText);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        showToast?.('Copied to clipboard');
      } else if (label === 'Share Message') {
        Share.share({ message: messageText });
      } else if (label === 'Bookmark') {
        try {
          await toggleBookmark({
            conversation_id: conversationId as Id<"conversations">,
            message_id: message._id as Id<"messages">,
          });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          showToast?.('Bookmarked');
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
  // Strip command/system XML tags from skill prompts
  const rawContent = rawContentRaw.replace(/<\/?(?:command-(?:name|message|args)|system-reminder|antml:[a-z_]+)[^>]*>/g, '').replace(/\n{3,}/g, '\n\n');
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasImages = message.images && message.images.length > 0;
  const hasThinkingContent = !!message.thinking?.trim();

  // Skip truly empty messages (no content, no tool calls, no images, no thinking)
  if (!rawContent.trim() && !hasToolCalls && !hasImages && !hasThinkingContent) {
    return null;
  }
  const isLongContent = rawContent.length > CONTENT_TRUNCATE_LENGTH;
  const content = (isLongContent && !contentExpanded)
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

  return (
    <Pressable onLongPress={handleLongPress}>
      <RNView style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble, showHeader && !isUser && styles.assistantBubbleFirst, isToolCallOnly && styles.toolCallOnlyBubble]}>
        {showHeader && !isToolCallOnly && (
        <RNView style={styles.bubbleHeader}>
          {isUser ? (
            <RNView style={styles.userAvatar}>
              <RNText style={styles.userAvatarText}>{(userName || 'Y')[0].toUpperCase()}</RNText>
            </RNView>
          ) : agentType ? (
            <RNView style={[styles.agentDot, { backgroundColor: agentType === 'codex' ? '#10b981' : agentType === 'cursor' ? '#60a5fa' : Theme.accent }]} />
          ) : null}
          <RNText style={[styles.bubbleRole, isUser ? styles.userRole : styles.assistantRole]}>
            {isUser ? (userName || 'You') : assistantLabel(agentType)}
          </RNText>
          {!isUser && model && showHeader && (
            <RNText style={styles.modelBadge}>{formatModel(model)}</RNText>
          )}
          <Pressable onPress={() => Alert.alert('Timestamp', formatFullTimestamp(message.timestamp))}>
            <RNText style={[styles.bubbleTime, isUser ? styles.userTime : styles.assistantTime]}>{formatTimestamp(message.timestamp)}</RNText>
          </Pressable>
        </RNView>
      )}


      {hasImages && (
        <RNView style={styles.imagesContainer}>
          {message.images!.map((img, i) => (
            <ImageBlock key={i} image={img} />
          ))}
        </RNView>
      )}

      {hasThinkingContent && (
        <ThinkingBlock content={message.thinking!} />
      )}

      {content ? (
        <>
        <RNView style={[styles.bubbleContent, isLongContent && !contentExpanded && styles.bubbleContentCollapsed]}>
          {typeof content === 'string' && content.includes('<skill>') ? (
            parseSkillBlocks(content).map((part, idx) => {
              if (part.type === 'skill') {
                return (
                  <SkillBlockCard
                    key={idx}
                    name={part.skillName}
                    description={part.skillDesc}
                    path={part.skillPath}
                  />
                );
              } else {
                return (
                  <MarkdownContent
                    key={idx}
                    text={part.content}
                    baseStyle={[styles.bubbleText, isUser ? styles.userText : styles.assistantText]}
                    isUser={isUser}
                  />
                );
              }
            })
          ) : typeof content === 'string' && content.includes('<teammate-message') ? (
            parseTeammateMessages(content).map((part, idx) => {
              if (part.type === 'text') {
                return (
                  <MarkdownContent
                    key={idx}
                    text={part.content}
                    baseStyle={[styles.bubbleText, isUser ? styles.userText : styles.assistantText]}
                    isUser={isUser}
                  />
                );
              } else {
                return (
                  <TeammateMessageCard
                    key={idx}
                    teammateId={part.teammateId}
                    color={part.color}
                    summary={part.summary}
                    content={part.content}
                  />
                );
              }
            })
          ) : (
            <MarkdownContent
              text={content}
              baseStyle={[styles.bubbleText, isUser ? styles.userText : styles.assistantText]}
              isUser={isUser}
            />
          )}
          {isLongContent && !contentExpanded && (
            <LinearGradient
              colors={[isUser ? Theme.violet + '00' : Theme.bg + '00', isUser ? Theme.violet + '26' : Theme.bg]}
              style={styles.contentGradientOverlay}
              pointerEvents="none"
            />
          )}
        </RNView>
        {isLongContent && (
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
                  return <PlanBlock key={tc.id} content={String(p.content)} timestamp={message.timestamp} />;
                }
              } catch {}
            }
            // Specialized rendering for specific tools
            if (tc.name === 'Task') {
              return <TaskToolBlock key={tc.id} tool={tc} result={result} />;
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
                <RNView key={tc.id} style={styles.taskOpBlock}>
                  <RNText style={[styles.taskOpName, { color: Theme.violet }]}>EnterPlanMode</RNText>
                  <RNText style={styles.taskOpText}>Planning...</RNText>
                </RNView>
              );
            }
            if (tc.name === 'ExitPlanMode') {
              return (
                <RNView key={tc.id} style={styles.taskOpBlock}>
                  <RNText style={[styles.taskOpName, { color: Theme.violet }]}>ExitPlanMode</RNText>
                  <RNText style={styles.taskOpText}>Plan ready</RNText>
                </RNView>
              );
            }

            // Default rendering for other tools
            return (
              <ToolCallItem
                images={message.images}
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
              <RNText style={styles.forkChildText} numberOfLines={1}>{fork.title}</RNText>
            </Pressable>
          ))}
        </RNView>
      )}
      </RNView>
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

function MessageInput({ conversationId, isActive }: { conversationId: Id<"conversations">; isActive: boolean }) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);

  const sendMessage = useMutation(api.pendingMessages.sendMessageToSession);
  const retryMessage = useMutation(api.pendingMessages.retryMessage);

  const pendingMessages = useQuery(api.pendingMessages.getPendingMessages, {}) as PendingMessage[] | undefined;

  const conversationPendingMessages = pendingMessages?.filter(
    (msg) => msg.conversation_id === conversationId
  ) || [];

  const pickImage = async () => {
    Alert.alert(
      'Coming Soon',
      'Image uploads will be available in the next update.',
      [{ text: 'OK' }]
    );
    // Temporarily disabled - requires expo-image-picker in dev client
    // try {
    //   const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    //   if (status !== 'granted') {
    //     Alert.alert('Permission needed', 'Please grant photo library access to attach images');
    //     return;
    //   }

    //   const result = await ImagePicker.launchImageLibraryAsync({
    //     mediaTypes: ImagePicker.MediaTypeOptions.Images,
    //     allowsMultipleSelection: true,
    //     quality: 0.8,
    //     base64: true,
    //   });

    //   if (!result.canceled && result.assets) {
    //     const uris = result.assets.map(asset => asset.uri);
    //     setSelectedImages(prev => [...prev, ...uris]);
    //   }
    // } catch (err) {
    //   console.error('Image picker error:', err);
    // }
  };

  const removeImage = (uri: string) => {
    setSelectedImages(prev => prev.filter(img => img !== uri));
  };

  const handleSend = async () => {
    const trimmedMessage = message.trim();
    if ((!trimmedMessage && selectedImages.length === 0) || isSending) return;

    setIsSending(true);
    setError(null);

    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      // TODO: Update sendMessage to support images
      await sendMessage({ conversation_id: conversationId, content: trimmedMessage || '📷' });
      setMessage('');
      setSelectedImages([]);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <RNView style={styles.inputContainer}>
      {!isActive && (
        <RNView style={styles.resumeHint}>
          <RNText style={styles.resumeHintText}>Session inactive. Sending will auto-resume it.</RNText>
        </RNView>
      )}
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
          {selectedImages.map((uri, index) => (
            <RNView key={index} style={styles.imagePreview}>
              <Image source={{ uri }} style={styles.previewImage} />
              <TouchableOpacity
                style={styles.removeImageButton}
                onPress={() => removeImage(uri)}
                activeOpacity={0.7}
              >
                <FontAwesome name="times-circle" size={20} color={Theme.red} />
              </TouchableOpacity>
            </RNView>
          ))}
        </ScrollView>
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
          <FontAwesome name="arrow-up" size={16} color="#fff" />
        </TouchableOpacity>
      </RNView>
    </RNView>
  );
}

// --- Session actions ---

function SessionActions({ conversationId, isFavorite, shareToken }: {
  conversationId: Id<"conversations">;
  isFavorite: boolean;
  shareToken: string | null | undefined;
}) {
  const [sharing, setSharing] = useState(false);
  const toggleFavorite = useMutation(api.conversations.toggleFavorite);
  const generateShareLink = useMutation(api.conversations.generateShareLink);

  const handleFavorite = useCallback(async () => {
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await toggleFavorite({ conversation_id: conversationId });
    } catch {}
  }, [conversationId, toggleFavorite]);

  const handleShare = useCallback(async () => {
    setSharing(true);
    try {
      let token = shareToken;
      if (!token) {
        token = await generateShareLink({ conversation_id: conversationId });
      }
      if (token) {
        const url = `https://codecast.sh/share/${token}`;
        await Share.share({ message: url, url });
      }
    } catch {} finally {
      setSharing(false);
    }
  }, [conversationId, shareToken, generateShareLink]);

  return (
    <RNView style={styles.actionsRow}>
      <TouchableOpacity onPress={handleFavorite} style={styles.actionButton} activeOpacity={0.7}>
        <FontAwesome
          name={isFavorite ? "star" : "star-o"}
          size={18}
          color={isFavorite ? Theme.accent : Theme.textMuted0}
        />
      </TouchableOpacity>
      <TouchableOpacity onPress={handleShare} style={styles.actionButton} activeOpacity={0.7} disabled={sharing}>
        <FontAwesome name="share-alt" size={16} color={Theme.textMuted0} />
      </TouchableOpacity>
    </RNView>
  );
}

// --- Main screen with pagination ---

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams();
  const convex = useConvex();
  const flatListRef = useRef<FlatList>(null);
  const [olderMessages, setOlderMessages] = useState<Message[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderHasMore, setOlderHasMore] = useState(true);
  const [olderOldestTs, setOlderOldestTs] = useState<number | null>(null);
  const [initialScrollDone, setInitialScrollDone] = useState(false);
  const [userScrolled, setUserScrolled] = useState(false);
  const [isNearTop, setIsNearTop] = useState(true);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [toastMessage, setToastMessage] = useState('');
  const [toastKey, setToastKey] = useState(0);
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setToastKey(k => k + 1);
  }, []);
  const isNearBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);

  const conversation = useQuery(
    api.conversations.getAllMessages,
    id ? { conversation_id: id as Id<"conversations">, limit: 50 } : "skip"
  ) as ConversationData | null | undefined;

  const pendingPermissions = useQuery(
    api.permissions.getPendingPermissions,
    id ? { conversation_id: id as Id<"conversations"> } : "skip"
  );

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

  useEffect(() => {
    if (conversation && !initialScrollDone && allMessages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: false });
        setInitialScrollDone(true);
      }, 150);
    }
  }, [conversation?._id, allMessages.length > 0]);

  useEffect(() => {
    setOlderMessages([]);
    setOlderHasMore(true);
    setOlderOldestTs(null);
    setInitialScrollDone(false);
    setUserScrolled(false);
    prevMessageCountRef.current = 0;
  }, [id]);

  // Auto-scroll when new messages arrive (if near bottom)
  useEffect(() => {
    const delta = allMessages.length - prevMessageCountRef.current;
    const hasNewMessages = delta > 0;
    prevMessageCountRef.current = allMessages.length;

    if (hasNewMessages && initialScrollDone && isNearBottomRef.current && allMessages.length > 0) {
      flatListRef.current?.scrollToEnd({ animated: true });
      setUserScrolled(false);
      setNewMessageCount(0);
    } else if (hasNewMessages && initialScrollDone && !isNearBottomRef.current) {
      setNewMessageCount(prev => prev + delta);
    }
  }, [allMessages.length, initialScrollDone]);

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
    }
  }, [convex, id, loadingOlder, olderOldestTs, conversation?.oldest_timestamp]);

  const handleScroll = useCallback((event: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const scrollTop = contentOffset.y;
    const scrollHeight = contentSize.height;
    const clientHeight = layoutMeasurement.height;

    // Check if near bottom (within 100px like web)
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const isNearBottom = distanceFromBottom < 100;
    isNearBottomRef.current = isNearBottom;

    // Check if near top
    setIsNearTop(scrollTop < 300);

    // Set userScrolled if scrolling away from bottom
    if (!isNearBottom) {
      setUserScrolled(true);
    }

    // Load older messages when near top
    if (scrollTop < 100 && hasMoreAbove && !loadingOlder && initialScrollDone) {
      loadOlderMessages();
    }
  }, [hasMoreAbove, loadingOlder, loadOlderMessages, initialScrollDone]);

  if (conversation === undefined) {
    return (
      <RNView style={styles.container}>
        <Stack.Screen options={{ title: 'Loading...', headerBackTitle: 'Sessions', headerStyle: { backgroundColor: Theme.bgAlt }, headerTintColor: Theme.text, headerTitleStyle: { color: Theme.text, fontWeight: '600', fontSize: 17 } }} />
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

  const isActive = conversation.status === 'active';
  const totalCount = allMessages.length + (conversation.has_more_above ? '+' as any : 0);

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Conversation',
          headerBackTitle: 'Sessions',
          headerStyle: { backgroundColor: Theme.bgAlt },
          headerTintColor: Theme.text,
          headerTitleStyle: { color: Theme.text, fontWeight: '600', fontSize: 17 },
        }}
      />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <FlatList
          ref={flatListRef}
          data={allMessages}
          ListHeaderComponent={
            <>
              <RNView style={styles.sessionHeader}>
                <RNView style={styles.sessionTitleRow}>
                  <RNView style={{ flex: 1 }}>
                    <RNText style={styles.sessionTitle} numberOfLines={2}>
                      {conversation.title}
                    </RNText>
                    <RNView style={styles.sessionMeta}>
                      {conversation.agent_type && (
                        <RNView style={[styles.metaBadgeIcon, { borderColor: agentTypeColor(conversation.agent_type) + '40' }]}>
                          <FontAwesome name={agentTypeIcon(conversation.agent_type) as any} size={9} color={agentTypeColor(conversation.agent_type)} />
                          <RNText style={[styles.metaBadge, { color: agentTypeColor(conversation.agent_type) }]}>
                            {formatAgentType(conversation.agent_type)}
                          </RNText>
                        </RNView>
                      )}
                      {conversation.model && (
                        <RNText style={styles.metaBadgeModel}>
                          {formatModel(conversation.model)}
                        </RNText>
                      )}
                      {conversation.started_at && (
                        <Pressable onPress={() => Alert.alert('Started', formatFullTimestamp(conversation.started_at!))}>
                          <RNText style={styles.messageCountText}>
                            {formatTimestamp(conversation.started_at)}
                          </RNText>
                        </Pressable>
                      )}
                      <RNText style={styles.messageCountText}>
                        {conversation.message_count || allMessages.length} msgs
                      </RNText>
                      {conversation.started_at && (
                        <RNText style={styles.durationBadge}>
                          {formatDuration(conversation.started_at)}
                        </RNText>
                      )}
                      {isActive && (
                        <RNView style={styles.activeIndicator}>
                          <RNView style={styles.activeDot} />
                          <RNText style={styles.activeText}>Active</RNText>
                        </RNView>
                      )}
                      {(conversation.fork_count ?? 0) > 0 && (
                        <RNView style={styles.forkBadge}>
                          <FontAwesome name="code-fork" size={9} color={Theme.violet} />
                          <RNText style={styles.forkBadgeText}>{conversation.fork_count}</RNText>
                        </RNView>
                      )}
                      {(conversation.compaction_count ?? 0) > 0 && (
                        <RNView style={styles.compactionBadge}>
                          <FontAwesome name="compress" size={9} color="#d97706" />
                          <RNText style={styles.compactionBadgeText}>{conversation.compaction_count}</RNText>
                        </RNView>
                      )}
                    </RNView>
                    {conversation.parent_conversation_id && (
                      <Pressable
                        onPress={() => router.push(`/session/${conversation.parent_conversation_id}`)}
                        style={styles.parentLink}
                      >
                        <FontAwesome name="level-up" size={10} color={Theme.violet} />
                        <RNText style={styles.parentLinkText}>View parent conversation</RNText>
                      </Pressable>
                    )}
                    {conversation.forked_from_details && (
                      <RNText style={styles.forkedFromText}>
                        Forked from @{conversation.forked_from_details.username}
                      </RNText>
                    )}
                  </RNView>
                  <SessionActions
                    conversationId={id as Id<"conversations">}
                    isFavorite={conversation.is_favorite ?? false}
                    shareToken={conversation.share_token}
                  />
                </RNView>
              </RNView>
              {hasMoreAbove && (
                <TouchableOpacity
                  onPress={loadOlderMessages}
                  style={styles.loadMoreButton}
                  activeOpacity={0.7}
                  disabled={loadingOlder}
                >
                  {loadingOlder ? (
                    <ActivityIndicator size="small" color={Theme.textMuted} />
                  ) : (
                    <RNText style={styles.loadMoreText}>Load older messages</RNText>
                  )}
                </TouchableOpacity>
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
            // Skip tool result messages and command messages when determining header visibility
            let prevNonToolResult: Message | null = null;
            for (let i = index - 1; i >= 0; i--) {
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
              // User message following compact_boundary -> render as compaction summary
              if (prevNonToolResult?.role === 'system' && prevNonToolResult?.subtype === 'compact_boundary') {
                return <CompactionSummaryBlock content={item.content} />;
              }
            }

            return (
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
                userName={conversation.user?.name || conversation.user?.email?.split('@')[0]}
                showToast={showToast}
              />
            );
          }}
          keyExtractor={(item) => item._id}
          contentContainerStyle={[styles.messageList, allMessages.length === 0 && { flex: 1 }]}
          ListEmptyComponent={
            <RNView style={styles.emptyState}>
              <FontAwesome name="comments-o" size={32} color={Theme.textDim} />
              <RNText style={styles.emptyStateText}>No messages yet</RNText>
              <RNText style={styles.emptyStateSubtext}>Messages will appear here as the session progresses</RNText>
            </RNView>
          }
          showsVerticalScrollIndicator={false}
          onScroll={handleScroll}
          scrollEventThrottle={100}
          maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        />

        <MessageInput conversationId={id as Id<"conversations">} isActive={isActive} />

        {/* Jump arrows */}
        <RNView style={styles.jumpButtonsContainer}>
          {(!isNearTop || hasMoreAbove) && (
            <TouchableOpacity
              onPress={() => {
                if (hasMoreAbove) {
                  flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
                } else {
                  flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
                }
              }}
              style={styles.jumpButton}
              activeOpacity={0.7}
            >
              <FontAwesome name="arrow-up" size={14} color={Theme.borderLight} />
            </TouchableOpacity>
          )}
          {userScrolled && (
            <TouchableOpacity
              onPress={() => {
                flatListRef.current?.scrollToEnd({ animated: true });
                setUserScrolled(false);
                setNewMessageCount(0);
              }}
              style={styles.jumpButton}
              activeOpacity={0.7}
            >
              <FontAwesome name="arrow-down" size={14} color={Theme.borderLight} />
              {newMessageCount > 0 && (
                <RNView style={styles.jumpBadge}>
                  <RNText style={styles.jumpBadgeText}>{newMessageCount > 99 ? '99+' : newMessageCount}</RNText>
                </RNView>
              )}
            </TouchableOpacity>
          )}
        </RNView>
      </KeyboardAvoidingView>
      <Toast key={toastKey} message={toastMessage} visible={!!toastMessage && toastKey > 0} />
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
  sessionHeader: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Theme.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
  },
  sessionTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  sessionTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: Theme.text,
    marginBottom: 6,
    lineHeight: 22,
  },
  sessionMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  metaBadge: {
    fontSize: 10,
    fontWeight: '600',
  },
  metaBadgeModel: {
    fontSize: 10,
    color: Theme.textMuted,
    fontWeight: '500',
    fontFamily: 'SpaceMono',
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: Theme.bgHighlight,
    borderRadius: 4,
  },
  messageCountText: {
    fontSize: 12,
    color: Theme.textMuted,
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
    fontSize: 13,
    color: Theme.greenBright,
    fontWeight: '500',
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 12,
  },
  actionButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Theme.bgAlt,
    alignItems: 'center',
    justifyContent: 'center',
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
    paddingBottom: 120,
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
    maxHeight: 400,
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
    marginVertical: 2,
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
    paddingVertical: 4,
    gap: 2,
  },
  toolCallsContainer: {
    paddingHorizontal: 14,
    paddingBottom: 8,
    gap: 2,
  },
  toolCallContainer: {
    marginVertical: 1,
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
    padding: 10,
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
    marginHorizontal: -10,
    marginTop: -10,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
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
  toolResultScroll: {
    maxHeight: 320,
  },
  noOutputText: {
    fontSize: 12,
    color: Theme.textDim,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  languageLabel: {
    fontSize: 10,
    color: Theme.textDim,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontFamily: 'SpaceMono',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight + '33',
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
  resumeHint: {
    backgroundColor: Theme.bgAlt,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  resumeHintText: {
    color: Theme.textMuted0,
    fontSize: 12,
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
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: Theme.bgHighlight,
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
  messageImage: {
    width: '100%',
    height: 200,
  },
  imageLoading: {
    height: 120,
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
  jumpButtonsContainer: {
    position: 'absolute',
    bottom: 140,
    right: 16,
    flexDirection: 'column',
    gap: 10,
    zIndex: 100,
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
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
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
  parentLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 6,
  },
  parentLinkText: {
    fontSize: 11,
    color: Theme.violet,
    fontWeight: '500',
  },
  forkedFromText: {
    fontSize: 10,
    color: Theme.textMuted0,
    marginTop: 4,
    fontStyle: 'italic',
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
  fullscreenImage: {
    width: Dimensions.get('window').width,
    height: Dimensions.get('window').height * 0.8,
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
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: Theme.bgHighlight,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
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
});
