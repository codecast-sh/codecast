import { StyleSheet, FlatList, ActivityIndicator, ScrollView, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, Share, View as RNView, Text as RNText, Linking, Image, ActionSheetIOS, Alert, Pressable, Clipboard } from 'react-native';
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
      result.push(
        <RNText key={`${keyPrefix}u${key++}`} style={isUser ? styles.linkTextUser : styles.linkText} onPress={() => Linking.openURL(url)}>
          {url}
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
            <RNView key={idx} style={styles.codeBlock}>
              <RNView style={styles.codeHeader}>
                <RNText style={styles.codeLanguage}>{block.language}</RNText>
              </RNView>
              <ScrollView horizontal showsHorizontalScrollIndicator>
                <RNView style={styles.codeContent}>
                  <RNText style={styles.codeText} selectable>{block.content}</RNText>
                </RNView>
              </ScrollView>
            </RNView>
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
      const listItems: { text: string; ordered: boolean; num?: number }[] = [];
      while (i < lines.length) {
        const l = lines[i].trim();
        const ulMatch = l.match(/^[-*]\s+(.*)/);
        const olMatch = l.match(/^(\d+)[.)]\s+(.*)/);
        if (ulMatch) {
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
                {item.ordered ? `${item.num}.` : '\u2022'}
              </RNText>
              <RNText style={[baseStyle, { flex: 1 }]}>
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
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatModel(model?: string): string {
  if (!model) return '';
  if (model.includes('claude-sonnet')) {
    return model.replace('claude-sonnet-', 'sonnet-').replace('-20', '-\'').slice(0, 12);
  }
  if (model.includes('claude-opus')) {
    return model.replace('claude-opus-', 'opus-').replace('-20', '-\'').slice(0, 12);
  }
  if (model.includes('claude-haiku')) {
    return model.replace('claude-haiku-', 'haiku-').replace('-20', '-\'').slice(0, 12);
  }
  return model.slice(0, 12);
}

function formatAgentType(agentType?: string): string {
  if (!agentType) return '';
  if (agentType === 'claude_code') return 'Claude Code';
  if (agentType === 'codex') return 'Codex';
  if (agentType === 'cursor') return 'Cursor';
  return agentType;
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
    return '';
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
  if (tc.name === 'TaskList') return '';
  if (tc.name === 'TaskCreate') return parsedInput.subject ? truncateStr(String(parsedInput.subject), 40) : '';
  if (tc.name === 'TaskUpdate') {
    const id = parsedInput.taskId ? `#${parsedInput.taskId}` : '';
    const status = parsedInput.status ? String(parsedInput.status) : '';
    if (id && status) return `${id} → ${status}`;
    return id || '';
  }
  if (tc.name === 'SendMessage') {
    if (parsedInput.type === 'broadcast') return 'broadcast';
    return parsedInput.recipient ? `to ${parsedInput.recipient}` : '';
  }
  if (tc.name === 'TeamCreate') return parsedInput.team_name ? String(parsedInput.team_name) : '';
  if (tc.name === 'Skill') return `/${parsedInput.skill || ''}`;

  return '';
}

// Specialized tool rendering components

function TaskToolBlock({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const subagentType = String(parsedInput.subagent_type || 'unknown');
  const description = String(parsedInput.description || '');
  const prompt = String(parsedInput.prompt || '');
  const model = parsedInput.model ? String(parsedInput.model) : null;

  const subagentColors: Record<string, string> = {
    Explore: Theme.green,
    Plan: Theme.blue,
    implementor: Theme.accent,
    'general-purpose': Theme.textMuted,
    'claude-code-guide': Theme.violet,
  };

  const color = subagentColors[subagentType] || Theme.textMuted;
  const truncatedPrompt = prompt.length > 300 && !expanded ? prompt.slice(0, 300) + '...' : prompt;

  return (
    <TouchableOpacity
      onPress={() => setExpanded(!expanded)}
      style={[styles.specialToolBlock, { borderLeftColor: color }]}
      activeOpacity={0.7}
    >
      <RNView style={styles.specialToolHeader}>
        <FontAwesome name="code-fork" size={11} color={color} style={{ marginRight: 5 }} />
        <RNText style={[styles.specialToolName, { color }]}>Task</RNText>
        <RNView style={[styles.specialToolBadge, { backgroundColor: color + '20', borderColor: color + '40' }]}>
          <RNText style={[styles.specialToolBadgeText, { color }]}>{subagentType}</RNText>
        </RNView>
        {model && (
          <RNText style={styles.specialToolMeta}>{model}</RNText>
        )}
      </RNView>
      {description && (
        <RNText style={styles.specialToolDesc} numberOfLines={1}>{description}</RNText>
      )}
      {expanded && (
        <RNText style={styles.specialToolContent} selectable>{truncatedPrompt}</RNText>
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
        <FontAwesome name="list" size={11} color={Theme.magenta} style={{ marginRight: 5 }} />
        <RNText style={styles.todoTitle}>TodoWrite</RNText>
        <RNText style={styles.todoStats}>
          {completed}/{todos.length} done{inProgress > 0 && `, ${inProgress} active`}
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
        <FontAwesome name="list" size={11} color={Theme.green} style={{ marginRight: 5 }} />
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
  let parsedInput: { skill?: string } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const skillName = parsedInput.skill || 'skill';

  return (
    <RNView style={styles.skillCard}>
      <FontAwesome name="magic" size={12} color={Theme.violet} style={{ marginRight: 6 }} />
      <RNText style={styles.skillName}>/{skillName}</RNText>
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
      <RNText style={[styles.taskOpName, { color: Theme.accent }]}>SendMessage</RNText>
      {type === 'broadcast' && (
        <RNView style={[styles.taskOpBadge, { backgroundColor: Theme.red + '20', borderColor: Theme.red + '40' }]}>
          <RNText style={[styles.taskOpBadgeText, { color: Theme.red }]}>broadcast</RNText>
        </RNView>
      )}
      {type === 'shutdown_request' && (
        <RNView style={[styles.taskOpBadge, { backgroundColor: Theme.red + '20', borderColor: Theme.red + '40' }]}>
          <RNText style={[styles.taskOpBadgeText, { color: Theme.red }]}>shutdown</RNText>
        </RNView>
      )}
      {recipient && (
        <RNView style={[styles.taskOpBadge, { backgroundColor: Theme.accent + '20', borderColor: Theme.accent + '40' }]}>
          <RNText style={[styles.taskOpBadgeText, { color: Theme.accent }]}>@{recipient}</RNText>
        </RNView>
      )}
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
        <RNText style={styles.taskOpText} numberOfLines={1}>{parsedInput.description}</RNText>
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

  if (!src) {
    return (
      <RNView style={styles.imageLoading}>
        <ActivityIndicator size="small" color={Theme.textMuted} />
        <RNText style={styles.imageLoadingText}>Loading image...</RNText>
      </RNView>
    );
  }

  return (
    <RNView style={styles.imageContainer}>
      <Image
        source={{ uri: src }}
        style={styles.messageImage}
        resizeMode="contain"
      />
    </RNView>
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
          color={Theme.accent}
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

function PlanBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(true);

  // Extract title from first # heading
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1] : 'Plan';

  return (
    <RNView style={styles.planBlock}>
      <TouchableOpacity
        onPress={() => setExpanded(!expanded)}
        style={styles.planHeader}
        activeOpacity={0.7}
      >
        <FontAwesome
          name="clipboard"
          size={12}
          color={Theme.cyan}
          style={{ marginRight: 6 }}
        />
        <RNText style={styles.planTitle}>{title}</RNText>
        <FontAwesome
          name={expanded ? "chevron-down" : "chevron-right"}
          size={10}
          color={Theme.cyan}
          style={{ marginLeft: 'auto' }}
        />
      </TouchableOpacity>
      {expanded && (
        <RNView style={styles.planContent}>
          <MarkdownContent text={content} baseStyle={styles.planText} isUser={false} />
        </RNView>
      )}
    </RNView>
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
    return (
      <RNView style={styles.teammateIdle}>
        <RNView style={[styles.teammateBadge, { backgroundColor: borderColor + '20', borderColor: borderColor + '60' }]}>
          <RNText style={[styles.teammateBadgeText, { color: borderColor }]}>{teammateId}</RNText>
        </RNView>
        <RNText style={styles.teammateIdleText}>{parsed.summary || 'idle'}</RNText>
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

  // Regular message
  return (
    <RNView style={[styles.teammateMessage, { borderLeftColor: borderColor }]}>
      <RNView style={styles.teammateHeader}>
        <RNView style={[styles.teammateBadge, { backgroundColor: borderColor + '20', borderColor: borderColor + '60' }]}>
          <RNText style={[styles.teammateBadgeText, { color: borderColor }]}>{teammateId}</RNText>
        </RNView>
        {summary && <RNText style={styles.teammateSummary}>{summary}</RNText>}
      </RNView>
      <RNText
        style={styles.teammateContent}
        numberOfLines={!expanded && isLong ? 4 : undefined}
        selectable
      >
        {safeContent}
      </RNText>
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
    return null;
  };
  const resultSummary = getResultSummary();

  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(toolCall.input); } catch {}

  const isBash = toolCall.name === 'Bash' || toolCall.name === 'shell_command' || toolCall.name === 'shell' || toolCall.name === 'exec_command' || toolCall.name === 'container.exec';
  const isEdit = toolCall.name === 'Edit' || toolCall.name === 'file_edit';
  const isScreenshotTool = toolCall.name === 'mcp__claude-in-chrome__computer' && parsedInput.action === 'screenshot';
  const hasImages = images && images.length > 0 && isScreenshotTool;

  const isWrite = toolCall.name === 'Write' || toolCall.name === 'file_write';
  const isCodeResult = result && (
    toolCall.name === 'Read' ||
    toolCall.name === 'Write' ||
    toolCall.name === 'Edit' ||
    toolCall.name === 'Grep' ||
    toolCall.name === 'Glob' ||
    toolCall.name === 'file_read' ||
    toolCall.name === 'file_write' ||
    toolCall.name === 'file_edit'
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
          {isBash && inputDisplay ? (
            <RNView style={styles.bashCommandSection}>
              <RNText style={styles.bashPrompt} selectable>
                <RNText style={{ color: Theme.green }}>$ </RNText>
                <RNText style={styles.bashCommand}>{inputDisplay}</RNText>
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
                <RNText style={styles.diffOldText} selectable>{String(parsedInput.old_string)}</RNText>
              </RNView>
              <RNView style={styles.diffNew}>
                <RNText style={styles.diffNewText} selectable>{String(parsedInput.new_string)}</RNText>
              </RNView>
            </RNView>
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

function ThinkingBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = content.split('\n').slice(0, 2).join('\n');
  const isLong = content.split('\n').length > 2 || content.length > 200;

  return (
    <TouchableOpacity
      onPress={() => isLong && setExpanded(!expanded)}
      style={styles.thinkingBlock}
      activeOpacity={isLong ? 0.7 : 1}
    >
      <RNView style={styles.thinkingHeader}>
        {(isLong || expanded) && (
          <FontAwesome name={expanded ? "chevron-down" : "chevron-right"} size={8} color={Theme.textDim} style={{ marginRight: 4, marginTop: 3 }} />
        )}
        <RNText style={styles.thinkingText} numberOfLines={expanded ? 50 : 2}>
          {expanded ? content : preview}
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
    return <PlanBlock content={message.content} />;
  }

  const content = message.content?.slice(0, 120) || '';
  if (!content) return null;

  return (
    <RNView style={styles.systemMessage}>
      <RNText style={styles.systemMessageText} numberOfLines={2}>{content}</RNText>
    </RNView>
  );
}

function assistantLabel(agentType?: string): string {
  if (agentType === 'codex') return 'Codex';
  if (agentType === 'cursor') return 'Cursor';
  return 'Claude';
}

const CONTENT_TRUNCATE_LENGTH = 1000;

function MessageBubble({ message, agentType, showHeader = true, forkChildren, conversationId, onFork, taskSubjectMap, userName }: {
  message: Message;
  agentType?: string;
  showHeader?: boolean;
  forkChildren?: ForkChild[];
  conversationId?: string;
  onFork?: (messageUuid: string) => void;
  taskSubjectMap?: Record<string, string>;
  userName?: string;
}) {
  const router = useRouter();
  const [expandedTools, setExpandedTools] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    message.tool_calls?.forEach(tc => {
      if (tc.name === 'Edit' || tc.name === 'Write' || tc.name === 'file_edit' || tc.name === 'file_write') {
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
      } else if (label === 'Share Message') {
        Share.share({ message: messageText });
      } else if (label === 'Bookmark') {
        try {
          await toggleBookmark({
            conversation_id: conversationId as Id<"conversations">,
            message_id: message._id as Id<"messages">,
          });
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
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
          {!isUser && agentType && (
            <RNView style={[styles.agentDot, { backgroundColor: agentType === 'codex' ? '#10b981' : agentType === 'cursor' ? '#60a5fa' : Theme.accent }]} />
          )}
          <RNText style={[styles.bubbleRole, isUser ? styles.userRole : styles.assistantRole]}>
            {isUser ? (userName || 'You') : assistantLabel(agentType)}
          </RNText>
          <RNText style={[styles.bubbleTime, isUser ? styles.userTime : styles.assistantTime]}>{formatTimestamp(message.timestamp)}</RNText>
        </RNView>
      )}


      {hasImages && (
        <RNView style={styles.imagesContainer}>
          {message.images!.map((img, i) => (
            <ImageBlock key={i} image={img} />
          ))}
        </RNView>
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
        </RNView>
        {isLongContent && (
          <TouchableOpacity
            onPress={() => setContentExpanded(!contentExpanded)}
            style={[styles.showMoreButton, { paddingHorizontal: 14 }]}
            activeOpacity={0.7}
          >
            <RNText style={[styles.showMoreText, isUser && { color: 'rgba(255,255,255,0.7)' }]}>
              {contentExpanded ? 'Show less' : 'Show more...'}
            </RNText>
          </TouchableOpacity>
        )}
        </>
      ) : null}

      {hasToolCalls && (
        <RNView style={isToolCallOnly ? styles.toolCallsCompact : styles.toolCallsContainer}>
          {message.tool_calls!.map((tc) => {
            const result = message.tool_results?.find(r => r.tool_use_id === tc.id);

            // Specialized rendering for specific tools
            if (tc.name === 'Task') {
              return <TaskToolBlock key={tc.id} tool={tc} />;
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

  const hasMoreAbove = olderHasMore && (conversation?.has_more_above !== false);

  const allMessages = useMemo(() => {
    const recent = conversation?.messages || [];
    if (olderMessages.length === 0) return recent;
    const recentIds = new Set(recent.map(m => m._id));
    const uniqueOlder = olderMessages.filter(m => !recentIds.has(m._id));
    return [...uniqueOlder, ...recent];
  }, [conversation?.messages, olderMessages]);

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
    const hasNewMessages = allMessages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = allMessages.length;

    if (hasNewMessages && initialScrollDone && isNearBottomRef.current && allMessages.length > 0) {
      flatListRef.current?.scrollToEnd({ animated: true });
      setUserScrolled(false);
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
      <RNView style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Theme.textMuted} />
        <RNText style={styles.loadingText}>Loading...</RNText>
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
                        <RNText style={styles.metaBadge}>
                          {formatAgentType(conversation.agent_type)}
                        </RNText>
                      )}
                      {conversation.model && (
                        <RNText style={styles.metaBadgeModel}>
                          {formatModel(conversation.model)}
                        </RNText>
                      )}
                      <RNText style={styles.messageCountText}>
                        {conversation.message_count || allMessages.length} msgs
                      </RNText>
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
            // Skip tool result messages when determining header visibility (match web behavior)
            let prevNonToolResult: Message | null = null;
            for (let i = index - 1; i >= 0; i--) {
              const prev = allMessages[i];
              if (prev.role === 'user' && prev.tool_results && prev.tool_results.length > 0) continue;
              prevNonToolResult = prev;
              break;
            }
            const showHeader = !prevNonToolResult || prevNonToolResult.role !== item.role;

            // Hide standalone tool result messages (they're shown inline with tool calls)
            if (item.role === 'user' && item.tool_results && item.tool_results.length > 0 && !item.content?.trim()) {
              return null;
            }

            return (
              <MessageBubble
                message={item}
                agentType={conversation.agent_type}
                showHeader={showHeader}
                forkChildren={item.message_uuid ? forkPointMap[item.message_uuid] : undefined}
                conversationId={conversation._id}
                onFork={handleForkFromMessage}
                taskSubjectMap={taskSubjectMap}
                userName={conversation.user?.name || conversation.user?.email?.split('@')[0]}
              />
            );
          }}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.messageList}
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
              }}
              style={styles.jumpButton}
              activeOpacity={0.7}
            >
              <FontAwesome name="arrow-down" size={14} color={Theme.borderLight} />
            </TouchableOpacity>
          )}
        </RNView>
      </KeyboardAvoidingView>
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
    color: Theme.text,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: Theme.bgHighlight,
    borderRadius: 4,
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
    backgroundColor: Theme.userBubble,
    alignSelf: 'flex-end',
    maxWidth: '85%',
    borderBottomRightRadius: 4,
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
    color: 'rgba(255,255,255,0.8)',
  },
  assistantRole: {
    color: Theme.textMuted0,
  },
  bubbleTime: {
    fontSize: 11,
  },
  userTime: {
    color: 'rgba(255,255,255,0.5)',
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
    marginTop: 6,
    paddingVertical: 4,
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
    color: Theme.userBubbleText,
  },
  assistantText: {
    color: Theme.text,
  },
  linkText: {
    color: Theme.cyan,
    textDecorationLine: 'underline',
  },
  linkTextUser: {
    color: 'rgba(255,255,255,0.9)',
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
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    color: '#fff',
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
    alignSelf: 'center',
    marginVertical: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: Theme.bgAlt,
    borderRadius: 8,
    maxWidth: '80%',
  },
  systemMessageText: {
    fontSize: 12,
    color: Theme.textMuted0,
    textAlign: 'center',
    fontStyle: 'italic',
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
    fontSize: 11,
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
    marginBottom: 8,
  },
  diffOld: {
    backgroundColor: Theme.red + '12',
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  diffOldText: {
    fontSize: 11,
    fontFamily: 'SpaceMono',
    color: Theme.red,
  },
  diffNew: {
    backgroundColor: Theme.green + '12',
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  diffNewText: {
    fontSize: 11,
    fontFamily: 'SpaceMono',
    color: Theme.green,
  },
  toolResultScroll: {
    maxHeight: 320,
  },
  noOutputText: {
    fontSize: 12,
    color: Theme.textDim,
  },
  toolInputSection: {
    marginBottom: 8,
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
    fontSize: 11,
    color: Theme.textMuted,
    fontFamily: 'SpaceMono',
  },
  toolCallResult: {
    fontSize: 11,
    color: Theme.textSecondary,
    fontFamily: 'SpaceMono',
    lineHeight: 16,
  },
  toolCodeText: {
    fontSize: 11,
    color: Theme.textSecondary,
    fontFamily: 'SpaceMono',
    lineHeight: 16,
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
    marginVertical: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderLeftWidth: 3,
  },
  specialToolHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  specialToolName: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'SpaceMono',
    marginRight: 6,
  },
  specialToolBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    marginRight: 6,
  },
  specialToolBadgeText: {
    fontSize: 9,
    fontWeight: '600',
    fontFamily: 'SpaceMono',
  },
  specialToolMeta: {
    fontSize: 9,
    color: Theme.textMuted0,
    fontFamily: 'SpaceMono',
    marginLeft: 'auto',
  },
  specialToolDesc: {
    fontSize: 11,
    color: Theme.textMuted,
    marginBottom: 4,
  },
  specialToolContent: {
    fontSize: 11,
    color: Theme.textMuted,
    fontFamily: 'SpaceMono',
    marginTop: 4,
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
    fontSize: 11,
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
    fontSize: 11,
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
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: Theme.blue + '20',
    borderColor: Theme.blue + '60',
  },
  optionPillCustomText: {
    fontSize: 11,
    color: Theme.blue,
  },
  // TodoWrite / TaskList
  todoBlock: {
    marginVertical: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.1)',
    borderRadius: 8,
  },
  todoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  todoTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: Theme.magenta,
    fontFamily: 'SpaceMono',
    marginRight: 6,
  },
  todoStats: {
    fontSize: 10,
    color: Theme.textMuted0,
    fontFamily: 'SpaceMono',
  },
  todoList: {
    gap: 4,
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
    marginVertical: 1,
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
    color: Theme.accent + 'b0',
  },
  compactionContent: {
    fontSize: 11,
    color: Theme.textMuted,
    lineHeight: 16,
  },
  compactionContentWrap: {
    marginTop: 8,
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: Theme.accent + '60',
  },
  // Plan block
  planBlock: {
    marginVertical: 12,
    marginHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Theme.cyan + '40',
    backgroundColor: Theme.bgAlt,
    overflow: 'hidden',
  },
  planHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
  planTitle: {
    fontSize: 12,
    color: Theme.cyan,
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
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.bgHighlight,
  },
  // Teammate messages
  teammateMessage: {
    marginVertical: 8,
    padding: 10,
    backgroundColor: Theme.bgHighlight,
    borderRadius: 8,
    borderLeftWidth: 3,
  },
  teammateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
    gap: 6,
  },
  teammateBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
  },
  teammateBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  teammateSummary: {
    fontSize: 11,
    color: Theme.textMuted,
    fontStyle: 'italic',
    flex: 1,
  },
  teammateContent: {
    fontSize: 12,
    color: Theme.text,
    lineHeight: 18,
  },
  teammateExpand: {
    fontSize: 11,
    color: Theme.accent,
    marginTop: 4,
    fontWeight: '500',
  },
  teammateIdle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginVertical: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: Theme.bgHighlight,
    borderRadius: 6,
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
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
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
});
