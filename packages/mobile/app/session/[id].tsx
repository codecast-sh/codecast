import { StyleSheet, FlatList, ActivityIndicator, ScrollView, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, Share, View as RNView, Text as RNText, Linking, Image, ActionSheetIOS, Alert, Pressable } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useQuery, useMutation, useConvex } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { Id } from '@codecast/convex/convex/_generated/dataModel';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
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
};

// --- Markdown rendering ---

function renderInlineMarkdown(text: string, baseStyle: any, keyPrefix = ''): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*(.+?)\*\*|\*(.+?)\*|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s<>\])"',]+))/g;
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
        <RNText key={`${keyPrefix}c${key++}`} style={styles.inlineCode}>{code}</RNText>
      );
    } else if (match[2] !== undefined) {
      result.push(
        <RNText key={`${keyPrefix}b${key++}`} style={{ fontWeight: '700' }}>{match[2]}</RNText>
      );
    } else if (match[3] !== undefined) {
      result.push(
        <RNText key={`${keyPrefix}i${key++}`} style={{ fontStyle: 'italic' }}>{match[3]}</RNText>
      );
    } else if (match[4] && match[5]) {
      const url = match[5];
      result.push(
        <RNText key={`${keyPrefix}l${key++}`} style={styles.linkText} onPress={() => Linking.openURL(url)}>
          {match[4]}
        </RNText>
      );
    } else if (match[6]) {
      const url = match[6];
      result.push(
        <RNText key={`${keyPrefix}u${key++}`} style={styles.linkText} onPress={() => Linking.openURL(url)}>
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

        return <MarkdownTextBlock key={idx} text={block.content} baseStyle={baseStyle} blockKey={`b${idx}`} />;
      })}
    </RNView>
  );
}

function MarkdownTextBlock({ text, baseStyle, blockKey }: { text: string; baseStyle: any; blockKey: string }) {
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
          {renderInlineMarkdown(headerMatch[2], baseStyle, `${blockKey}h${elKey}`)}
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
                {renderInlineMarkdown(item.text, baseStyle, `${blockKey}li${j}`)}
              </RNText>
            </RNView>
          ))}
        </RNView>
      );
      continue;
    }

    if (trimmed.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('> ')) {
        quoteLines.push(lines[i].trim().slice(2));
        i++;
      }
      elements.push(
        <RNView key={`${blockKey}q${elKey++}`} style={styles.blockquote}>
          <RNText style={[baseStyle, styles.blockquoteText]}>
            {renderInlineMarkdown(quoteLines.join('\n'), baseStyle, `${blockKey}q${elKey}`)}
          </RNText>
        </RNView>
      );
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i].trim();
      if (!l || l.match(/^#{1,3}\s/) || l.match(/^[-*]\s/) || l.match(/^\d+[.)]\s/) || l.startsWith('> ')) break;
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      elements.push(
        <RNText key={`${blockKey}p${elKey++}`} style={[baseStyle, { marginBottom: 6 }]} selectable>
          {renderInlineMarkdown(paraLines.join('\n'), baseStyle, `${blockKey}p${elKey}`)}
        </RNText>
      );
    }
  }

  return <>{elements}</>;
}

// --- Message components ---

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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

function getRelativePath(filePath: string): string {
  // Simple relative path - remove common prefixes
  return filePath.replace(/^\/Users\/[^/]+\//, "~/").replace(/^\/home\/[^/]+\//, "~/");
}

function toolIcon(name: string): { icon: React.ComponentProps<typeof FontAwesome>['name']; color: string } {
  if (name === 'Bash') return { icon: 'terminal', color: Theme.green };
  if (name === 'Read' || name === 'Glob' || name === 'Grep') return { icon: 'file-code-o', color: Theme.cyan };
  if (name === 'Edit' || name === 'Write') return { icon: 'pencil', color: Theme.accent };
  if (name === 'WebSearch' || name === 'WebFetch') return { icon: 'globe', color: Theme.blue };
  if (name === 'Task') return { icon: 'code-fork', color: Theme.violet };

  if (name.startsWith('mcp__')) {
    if (name.includes('computer') || name.includes('screenshot')) {
      return { icon: 'desktop', color: Theme.cyan };
    }
    if (name.includes('chrome') || name.includes('navigate') || name.includes('read_page')) {
      return { icon: 'chrome', color: Theme.blue };
    }
    if (name.includes('find') || name.includes('form')) {
      return { icon: 'search', color: Theme.accent };
    }
    return { icon: 'plug', color: Theme.magenta };
  }

  return { icon: 'cog', color: Theme.textMuted };
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
    return cmd ? truncateStr(cmd, 60) : '';
  }

  // Search tools
  if (tc.name === 'Glob' && parsedInput.pattern) return String(parsedInput.pattern);
  if (tc.name === 'Grep' && parsedInput.pattern) return String(parsedInput.pattern);
  if (tc.name === 'WebSearch') return parsedInput.query ? truncateStr(String(parsedInput.query), 40) : '';

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
  let parsedInput: { questions?: Array<{ question: string; header?: string; options: Array<{ label: string }> }>; answers?: Record<string, string> } = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const questions = parsedInput.questions || [];
  if (questions.length === 0) return null;

  let answers: Record<string, string> = {};
  if (parsedInput.answers) {
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
        return (
          <RNView key={i} style={styles.questionItem}>
            {q.header && (
              <RNText style={styles.questionHeader}>{q.header}</RNText>
            )}
            <RNText style={styles.questionText}>{q.question}</RNText>
            <RNView style={styles.optionsRow}>
              {q.options.map((opt, j) => {
                const isSelected = answer === opt.label || answer === opt.label.replace(' (Recommended)', '');
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
              todo.status === 'completed' && styles.todoItemCompleted
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
  const items: Array<{ id: string; status: string; subject: string }> = [];
  for (const line of lines) {
    const match = line.match(/#(\d+)\s+\[(\w+)]\s+(.+?)(?:\s+\(|$)/);
    if (match) {
      items.push({ id: match[1], status: match[2], subject: match[3].trim() });
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
        {items.map((task, i) => (
          <RNView key={i} style={styles.todoItem}>
            {task.status === 'completed' ? (
              <FontAwesome name="check-circle" size={14} color={Theme.green} style={{ marginRight: 6 }} />
            ) : task.status === 'in_progress' ? (
              <FontAwesome name="clock-o" size={14} color={Theme.accent} style={{ marginRight: 6 }} />
            ) : (
              <FontAwesome name="circle-o" size={14} color={Theme.textMuted0} style={{ marginRight: 6 }} />
            )}
            <RNText style={styles.todoItemText}>#{task.id} {task.subject}</RNText>
          </RNView>
        ))}
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

function TaskCreateUpdateBlock({ tool }: { tool: ToolCall }) {
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(tool.input); } catch {}

  const isCreate = tool.name === 'TaskCreate';
  const subject = parsedInput.subject;
  const taskId = parsedInput.taskId;
  const status = parsedInput.status;
  const owner = parsedInput.owner;

  const statusColors: Record<string, string> = {
    completed: Theme.green,
    in_progress: Theme.accent,
    deleted: Theme.red,
    pending: Theme.textMuted0,
  };

  return (
    <RNView style={styles.taskOpBlock}>
      <RNText style={[styles.taskOpName, { color: Theme.green }]}>{tool.name}</RNText>
      {isCreate && subject && (
        <RNText style={styles.taskOpText} numberOfLines={1}>{subject}</RNText>
      )}
      {!isCreate && taskId && (
        <RNText style={styles.taskOpId}>#{taskId}</RNText>
      )}
      {status && (
        <RNView style={[styles.taskOpBadge, { backgroundColor: statusColors[status] + '20', borderColor: statusColors[status] + '40' }]}>
          <RNText style={[styles.taskOpBadgeText, { color: statusColors[status] }]}>{status}</RNText>
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
        <RNText style={styles.compactionContent} selectable>
          {content}
        </RNText>
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
  yellow: Theme.yellow,
  purple: Theme.violet,
  cyan: Theme.cyan,
  orange: Theme.orange,
  pink: '#ec4899',
};

function TeammateMessageCard({ teammateId, color, summary, content }: { teammateId: string; color?: string; summary?: string; content: string }) {
  const [expanded, setExpanded] = useState(false);

  let parsed: any = null;
  try { parsed = JSON.parse(content); } catch {}

  const borderColor = agentColors[color || 'blue'] || Theme.blue;
  const isLong = content.length > 200;

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
        {content}
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
  const { icon, color } = toolIcon(toolCall.name);
  const summary = toolSummary(toolCall);
  const inputDisplay = expanded && toolCall.input.length > 2000
    ? toolCall.input.slice(0, 2000) + '\n... (truncated)'
    : toolCall.input;

  const resultDisplay = result && expanded && result.content.length > 2000
    ? result.content.slice(0, 2000) + '\n... (truncated)'
    : result?.content;

  // Check if this tool produces images (screenshot, etc.)
  let parsedInput: Record<string, any> = {};
  try { parsedInput = JSON.parse(toolCall.input); } catch {}
  const isScreenshotTool = toolCall.name === 'mcp__claude-in-chrome__computer' && parsedInput.action === 'screenshot';
  const hasImages = images && images.length > 0 && isScreenshotTool;

  // Check if result looks like code (for Read/Write/Edit tools)
  const isCodeResult = result && (
    toolCall.name === 'Read' ||
    toolCall.name === 'Write' ||
    toolCall.name === 'Edit' ||
    toolCall.name === 'Grep' ||
    toolCall.name === 'Glob'
  );

  // Check if result is markdown-like (contains ### or **)
  const isMarkdownResult = result && !isCodeResult && (
    result.content.includes('###') ||
    result.content.includes('**') ||
    result.content.includes('```')
  );

  return (
    <TouchableOpacity onPress={onToggle} style={styles.toolCallContainer} activeOpacity={0.7}>
      <RNView style={styles.toolCallHeader}>
        <FontAwesome name={icon} size={12} color={color} style={{ marginRight: 6 }} />
        <RNText style={[styles.toolCallName, { color }]}>{formatToolName(toolCall.name)}</RNText>
        {summary && !expanded ? (
          <RNText style={styles.toolCallSummary} numberOfLines={1}> {summary}</RNText>
        ) : null}
        <RNText style={styles.toolCallToggle}>{expanded ? '\u25BC' : '\u25B6'}</RNText>
      </RNView>
      {expanded && (
        <RNView style={styles.toolCallContent}>
          {toolCall.input && toolCall.input.length > 2 && (
            <RNView style={styles.toolInputSection}>
              <RNText style={styles.toolSectionLabel}>Input:</RNText>
              <RNText style={styles.toolCallInput} selectable>{inputDisplay}</RNText>
            </RNView>
          )}
          {result && resultDisplay && (
            <RNView style={styles.toolResultSection}>
              <RNText style={[styles.toolSectionLabel, result.is_error && { color: Theme.red }]}>
                {result.is_error ? 'Error:' : 'Result:'}
              </RNText>
              {isCodeResult ? (
                <RNView style={styles.codeBlock}>
                  <ScrollView horizontal showsHorizontalScrollIndicator>
                    <RNView style={styles.codeContent}>
                      <RNText style={styles.codeText} selectable>{resultDisplay}</RNText>
                    </RNView>
                  </ScrollView>
                </RNView>
              ) : isMarkdownResult ? (
                <MarkdownContent text={resultDisplay} baseStyle={styles.toolCallResult} isUser={false} />
              ) : (
                <RNText style={[styles.toolCallResult, result.is_error && { color: Theme.red }]} selectable>
                  {resultDisplay}
                </RNText>
              )}
            </RNView>
          )}
          {expanded && hasImages && (
            <RNView style={styles.toolImagesSection}>
              {images!.map((img, i) => (
                <ImageBlock key={i} image={img} />
              ))}
            </RNView>
          )}
        </RNView>
      )}
    </TouchableOpacity>
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
        <FontAwesome name="lightbulb-o" size={11} color={Theme.textMuted0} style={{ marginRight: 5 }} />
        <RNText style={styles.thinkingLabel}>thinking</RNText>
        {isLong && (
          <RNText style={styles.thinkingToggle}>{expanded ? '\u25BC' : '\u25B6'}</RNText>
        )}
      </RNView>
      <RNText style={styles.thinkingText} numberOfLines={expanded ? undefined : 3}>
        {expanded ? content : preview}
      </RNText>
    </TouchableOpacity>
  );
}

function SystemMessage({ message }: { message: Message }) {
  if (message.subtype === 'compact_boundary') {
    return (
      <RNView style={styles.systemDivider}>
        <RNView style={styles.systemDividerLine} />
        <RNText style={styles.systemDividerText}>context compacted</RNText>
        <RNView style={styles.systemDividerLine} />
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

const CONTENT_TRUNCATE_LENGTH = 800;

function MessageBubble({ message, agentType, showHeader = true }: { message: Message; agentType?: string; showHeader?: boolean }) {
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [contentExpanded, setContentExpanded] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  const handleLongPress = () => {
    const messageText = message.content || '';
    const options = ['Share Message', 'Copy Text', 'Cancel'];
    const cancelButtonIndex = 2;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) {
            // Share
            Share.share({ message: messageText });
          } else if (buttonIndex === 1) {
            // Copy - would need Clipboard API
            Alert.alert('Copy', 'Text copied to clipboard');
          }
        }
      );
    } else {
      // For Android, use Alert
      Alert.alert(
        'Message Actions',
        'Choose an action',
        [
          {
            text: 'Share',
            onPress: () => Share.share({ message: messageText }),
          },
          {
            text: 'Copy',
            onPress: () => Alert.alert('Copy', 'Text copied to clipboard'),
          },
          { text: 'Cancel', style: 'cancel' },
        ]
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

  const rawContent = message.content || '';
  const isLongContent = rawContent.length > CONTENT_TRUNCATE_LENGTH;
  const content = (isLongContent && !contentExpanded)
    ? rawContent.slice(0, CONTENT_TRUNCATE_LENGTH)
    : rawContent;
  const hasThinking = !!message.thinking?.trim();
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasImages = message.images && message.images.length > 0;

  const toggleTool = (toolId: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  };

  return (
    <Pressable onLongPress={handleLongPress}>
      <RNView style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        {showHeader && (
        <RNView style={styles.bubbleHeader}>
          <RNText style={[styles.bubbleRole, isUser ? styles.userRole : styles.assistantRole]}>
            {isUser ? 'You' : assistantLabel(agentType)}
          </RNText>
          <RNText style={styles.bubbleTime}>{formatTimestamp(message.timestamp)}</RNText>
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
        <RNView style={styles.bubbleContent}>
          {content.includes('<skill>') ? (
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
          ) : content.includes('<teammate-message') ? (
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
          {isLongContent && (
            <TouchableOpacity
              onPress={() => setContentExpanded(!contentExpanded)}
              style={styles.showMoreButton}
              activeOpacity={0.7}
            >
              <RNText style={styles.showMoreText}>
                {contentExpanded ? 'Show less' : `Show more (${Math.round(rawContent.length / 1000)}k chars)`}
              </RNText>
            </TouchableOpacity>
          )}
        </RNView>
      ) : null}

      {hasToolCalls && (
        <RNView style={styles.toolCallsContainer}>
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
            if (tc.name === 'TaskCreate' || tc.name === 'TaskUpdate') {
              return <TaskCreateUpdateBlock key={tc.id} tool={tc} />;
            }
            if (tc.name === 'SendMessage') {
              return <SendMessageBlock key={tc.id} tool={tc} />;
            }
            if (tc.name === 'TeamCreate') {
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
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Please grant photo library access to attach images');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 0.8,
        base64: true,
      });

      if (!result.canceled && result.assets) {
        const uris = result.assets.map(asset => asset.uri);
        setSelectedImages(prev => [...prev, ...uris]);
      }
    } catch (err) {
      console.error('Image picker error:', err);
    }
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
          <FontAwesome name="image" size={20} color={Theme.textMuted} />
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
              </RNView>
            </RNView>
            <SessionActions
              conversationId={id as Id<"conversations">}
              isFavorite={conversation.is_favorite ?? false}
              shareToken={conversation.share_token}
            />
          </RNView>
        </RNView>

        <FlatList
          ref={flatListRef}
          data={allMessages}
          renderItem={({ item, index }) => {
            const prevMessage = index > 0 ? allMessages[index - 1] : null;
            const showHeader = !prevMessage || prevMessage.role !== item.role;
            return (
              <MessageBubble
                message={item}
                agentType={conversation.agent_type}
                showHeader={showHeader}
              />
            );
          }}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.messageList}
          showsVerticalScrollIndicator={false}
          onScroll={handleScroll}
          scrollEventThrottle={100}
          maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
          ListHeaderComponent={
            <>
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
              <FontAwesome name="arrow-up" size={18} color={Theme.text} />
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
              <FontAwesome name="arrow-down" size={18} color={Theme.text} />
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
    marginBottom: 12,
    borderRadius: 12,
    overflow: 'hidden',
  },
  userBubble: {
    backgroundColor: Theme.userBubble,
    alignSelf: 'flex-end',
    maxWidth: '85%',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: Theme.assistantBubble,
    alignSelf: 'flex-start',
    maxWidth: '92%',
    borderBottomLeftRadius: 4,
  },
  bubbleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
  },
  bubbleRole: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  userRole: {
    color: 'rgba(255,255,255,0.7)',
  },
  assistantRole: {
    color: 'rgba(253,246,227,0.6)',
  },
  bubbleTime: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.5)',
  },
  bubbleContent: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  showMoreButton: {
    marginTop: 6,
    paddingVertical: 4,
  },
  showMoreText: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.cyan,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 21,
  },
  userText: {
    color: Theme.userBubbleText,
  },
  assistantText: {
    color: Theme.assistantBubbleText,
  },
  linkText: {
    color: Theme.cyan,
    textDecorationLine: 'underline',
  },
  inlineCode: {
    fontFamily: 'SpaceMono',
    fontSize: 13,
    backgroundColor: 'rgba(0,0,0,0.15)',
    paddingHorizontal: 4,
    borderRadius: 3,
    color: Theme.cyan,
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
  blockquoteText: {
    fontStyle: 'italic',
  },
  codeBlock: {
    marginVertical: 8,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#073642',
  },
  codeHeader: {
    backgroundColor: '#002b36',
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  codeLanguage: {
    fontSize: 10,
    color: Theme.textMuted0,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
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
  thinkingToggle: {
    marginHorizontal: 12,
    marginBottom: 4,
  },
  thinkingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  thinkingLabel: {
    fontSize: 11,
    fontStyle: 'italic',
    color: Theme.textMuted0,
    opacity: 0.7,
  },
  thinkingBlock: {
    marginHorizontal: 12,
    marginBottom: 6,
    padding: 8,
    backgroundColor: 'rgba(0,0,0,0.15)',
    borderRadius: 6,
  },
  thinkingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  thinkingLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: 'rgba(253,246,227,0.4)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flex: 1,
  },
  thinkingToggle: {
    fontSize: 8,
    color: 'rgba(253,246,227,0.3)',
  },
  thinkingText: {
    fontSize: 13,
    lineHeight: 18,
    color: 'rgba(253,246,227,0.5)',
    fontStyle: 'italic',
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
  toolCallsContainer: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 4,
  },
  toolCallContainer: {
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: 8,
    overflow: 'hidden',
  },
  toolCallHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
  },
  toolCallName: {
    fontSize: 12,
    fontWeight: '600',
  },
  toolCallSummary: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
    flex: 1,
    marginLeft: 2,
  },
  toolCallToggle: {
    fontSize: 8,
    color: 'rgba(255,255,255,0.4)',
    marginLeft: 6,
  },
  toolCallContent: {
    padding: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  toolInputSection: {
    marginBottom: 12,
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
    color: 'rgba(255,255,255,0.6)',
    fontFamily: 'SpaceMono',
  },
  toolCallResult: {
    fontSize: 11,
    color: Theme.text,
    fontFamily: 'SpaceMono',
    lineHeight: 16,
  },
  inputContainer: {
    backgroundColor: Theme.bgAlt,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight,
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
    marginVertical: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(0,0,0,0.15)',
    borderRadius: 8,
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
  questionHeader: {
    fontSize: 9,
    fontWeight: '700',
    color: Theme.violet + 'cc',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: Theme.violet + '20',
    borderRadius: 3,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: Theme.violet + '40',
  },
  questionText: {
    fontSize: 11,
    color: Theme.textMuted,
    marginBottom: 6,
  },
  optionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  optionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    backgroundColor: 'rgba(0,0,0,0.1)',
  },
  optionPillSelected: {
    backgroundColor: Theme.green + '20',
    borderColor: Theme.green + '60',
  },
  optionPillText: {
    fontSize: 11,
    color: Theme.textMuted0,
  },
  optionPillTextSelected: {
    color: Theme.green,
    fontWeight: '500',
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
  },
  todoItemText: {
    fontSize: 12,
    color: Theme.textMuted,
    flex: 1,
  },
  todoItemCompleted: {
    color: Theme.textMuted0,
    textDecorationLine: 'line-through',
  },
  // Skill card
  skillCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: Theme.bgAlt,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Theme.borderLight,
    marginVertical: 4,
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
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginVertical: 2,
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
    bottom: 90,
    right: 16,
    flexDirection: 'column',
    gap: 10,
    zIndex: 100,
  },
  jumpButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Theme.bgAlt,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
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
});
