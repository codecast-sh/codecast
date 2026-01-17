import { useState } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Theme } from '@/constants/Theme';

interface ToolCall {
  id: string;
  name: string;
  input: string;
}

interface Props {
  toolCall: ToolCall;
  expanded: boolean;
  onToggle: () => void;
}

function parseInput(input: string): Record<string, unknown> {
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

function extractSummary(name: string, input: Record<string, unknown>): string {
  const filePath = input?.file_path as string;
  const fileName = filePath?.split('/').pop();

  switch (name) {
    case 'Edit':
      return fileName ? `Edit ${fileName}` : 'Edit file';
    case 'Write':
      return fileName ? `Write ${fileName}` : 'Write file';
    case 'Read':
      return fileName ? `Read ${fileName}` : 'Read file';
    case 'Bash':
      const cmd = (input?.command as string)?.split(' ')[0] || '';
      return cmd ? `$ ${cmd}` : 'Run command';
    case 'TodoWrite':
      const todos = input?.todos as unknown[];
      return todos?.length ? `${todos.length} tasks` : 'Update tasks';
    case 'Glob':
      return input?.pattern ? `Find ${input.pattern}` : 'Find files';
    case 'Grep':
      return input?.pattern ? `Search ${input.pattern}` : 'Search code';
    case 'Task':
      return (input?.description as string) || 'Agent task';
    default:
      return name;
  }
}

function getToolColor(name: string): { bg: string; border: string; text: string } {
  const colors: Record<string, { bg: string; border: string; text: string }> = {
    Edit: { bg: 'rgba(245, 158, 11, 0.1)', border: 'rgba(245, 158, 11, 0.25)', text: '#f59e0b' },
    Write: { bg: 'rgba(16, 185, 129, 0.1)', border: 'rgba(16, 185, 129, 0.25)', text: '#10b981' },
    Bash: { bg: 'rgba(16, 185, 129, 0.1)', border: 'rgba(16, 185, 129, 0.25)', text: '#10b981' },
    Read: { bg: 'rgba(59, 130, 246, 0.1)', border: 'rgba(59, 130, 246, 0.25)', text: '#3b82f6' },
    TodoWrite: { bg: 'rgba(139, 92, 246, 0.1)', border: 'rgba(139, 92, 246, 0.25)', text: '#8b5cf6' },
    Glob: { bg: 'rgba(139, 92, 246, 0.1)', border: 'rgba(139, 92, 246, 0.25)', text: '#8b5cf6' },
    Grep: { bg: 'rgba(236, 72, 153, 0.1)', border: 'rgba(236, 72, 153, 0.25)', text: '#ec4899' },
    Task: { bg: 'rgba(6, 182, 212, 0.1)', border: 'rgba(6, 182, 212, 0.25)', text: '#06b6d4' },
  };
  return colors[name] || { bg: 'rgba(107, 114, 128, 0.1)', border: 'rgba(107, 114, 128, 0.25)', text: '#6b7280' };
}

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const [expanded, setExpanded] = useState(false);
  const oldLines = (oldStr || '').split('\n').filter((_, i, arr) => i < arr.length - 1 || arr[i] !== '');
  const newLines = (newStr || '').split('\n').filter((_, i, arr) => i < arr.length - 1 || arr[i] !== '');
  const maxLines = 6;
  const shouldCollapse = oldLines.length > maxLines || newLines.length > maxLines;

  const displayOld = shouldCollapse && !expanded ? oldLines.slice(0, maxLines) : oldLines;
  const displayNew = shouldCollapse && !expanded ? newLines.slice(0, maxLines) : newLines;

  if (oldLines.length === 0 && newLines.length === 0) {
    return <Text style={diffStyles.emptyText}>No changes to display</Text>;
  }

  return (
    <View style={diffStyles.container}>
      {oldLines.length > 0 && (
        <View style={diffStyles.section}>
          <Text style={diffStyles.removedLabel}>- Removed ({oldLines.length} lines)</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={diffStyles.scrollContainer}>
            <View style={diffStyles.removedBox}>
              {displayOld.map((line, i) => (
                <View key={i} style={diffStyles.line}>
                  <Text style={diffStyles.lineNum}>{i + 1}</Text>
                  <Text style={diffStyles.removedText}>{line || ' '}</Text>
                </View>
              ))}
              {shouldCollapse && !expanded && oldLines.length > maxLines && (
                <Text style={diffStyles.moreLines}>... {oldLines.length - maxLines} more</Text>
              )}
            </View>
          </ScrollView>
        </View>
      )}

      {newLines.length > 0 && (
        <View style={diffStyles.section}>
          <Text style={diffStyles.addedLabel}>+ Added ({newLines.length} lines)</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={diffStyles.scrollContainer}>
            <View style={diffStyles.addedBox}>
              {displayNew.map((line, i) => (
                <View key={i} style={diffStyles.line}>
                  <Text style={diffStyles.lineNum}>{i + 1}</Text>
                  <Text style={diffStyles.addedText}>{line || ' '}</Text>
                </View>
              ))}
              {shouldCollapse && !expanded && newLines.length > maxLines && (
                <Text style={diffStyles.moreLines}>... {newLines.length - maxLines} more</Text>
              )}
            </View>
          </ScrollView>
        </View>
      )}

      {shouldCollapse && (
        <TouchableOpacity onPress={() => setExpanded(!expanded)} style={diffStyles.expandBtnContainer}>
          <Text style={diffStyles.expandBtn}>
            {expanded ? 'Show less' : 'Show all lines'}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function EditContent({ input }: { input: Record<string, unknown> }) {
  const filePath = input?.file_path as string || '';
  const fileName = filePath.split('/').pop() || 'file';
  const oldString = input?.old_string as string | undefined;
  const newString = input?.new_string as string | undefined;

  const hasOld = typeof oldString === 'string' && oldString.trim().length > 0;
  const hasNew = typeof newString === 'string' && newString.trim().length > 0;

  return (
    <View style={contentStyles.container}>
      <Text style={contentStyles.fileLabel}>{fileName}</Text>
      {(hasOld || hasNew) ? (
        <DiffView oldStr={oldString || ''} newStr={newString || ''} />
      ) : (
        <Text style={contentStyles.muted}>File modified</Text>
      )}
    </View>
  );
}

function BashContent({ input }: { input: Record<string, unknown> }) {
  const command = (input?.command as string) || '';

  return (
    <View style={contentStyles.container}>
      <View style={bashStyles.commandBox}>
        <Text style={bashStyles.prompt}>$</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text style={bashStyles.command}>{command}</Text>
        </ScrollView>
      </View>
    </View>
  );
}

function ReadContent({ input }: { input: Record<string, unknown> }) {
  const filePath = input?.file_path as string || '';
  const fileName = filePath.split('/').pop() || 'file';

  return (
    <View style={contentStyles.container}>
      <Text style={contentStyles.fileLabel}>File: {fileName}</Text>
      <Text style={contentStyles.pathText} numberOfLines={1}>{filePath}</Text>
    </View>
  );
}

function TodoContent({ input }: { input: Record<string, unknown> }) {
  const todos = (input?.todos as Array<{ content: string; status: string; activeForm?: string }>) || [];

  if (todos.length === 0) {
    return <Text style={contentStyles.muted}>No tasks</Text>;
  }

  const completed = todos.filter(t => t.status === 'completed').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;
  const pending = todos.filter(t => t.status === 'pending').length;

  return (
    <View style={contentStyles.container}>
      <View style={todoStyles.stats}>
        <Text style={todoStyles.statText}>
          <Text style={todoStyles.completedNum}>{completed}</Text> done
        </Text>
        <Text style={todoStyles.statText}>
          <Text style={todoStyles.progressNum}>{inProgress}</Text> active
        </Text>
        <Text style={todoStyles.statText}>
          <Text style={todoStyles.pendingNum}>{pending}</Text> pending
        </Text>
      </View>
      <View style={todoStyles.list}>
        {todos.map((todo, i) => (
          <View key={i} style={todoStyles.item}>
            <View style={[
              todoStyles.icon,
              todo.status === 'completed' && todoStyles.iconCompleted,
              todo.status === 'in_progress' && todoStyles.iconProgress,
            ]}>
              {todo.status === 'completed' && <Text style={todoStyles.check}>✓</Text>}
            </View>
            <Text style={[
              todoStyles.text,
              todo.status === 'completed' && todoStyles.textCompleted,
              todo.status === 'in_progress' && todoStyles.textProgress,
            ]} numberOfLines={2}>
              {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function DefaultContent({ input }: { input: Record<string, unknown> }) {
  const inputStr = JSON.stringify(input, null, 2);
  const lines = inputStr.split('\n');
  const maxLines = 10;
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = lines.length > maxLines;
  const display = shouldCollapse && !expanded ? lines.slice(0, maxLines).join('\n') : inputStr;

  return (
    <View style={contentStyles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text style={contentStyles.code}>{display}</Text>
      </ScrollView>
      {shouldCollapse && (
        <TouchableOpacity onPress={() => setExpanded(!expanded)}>
          <Text style={diffStyles.expandBtn}>{expanded ? 'Show less' : 'Show more'}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export function ToolCallView({ toolCall, expanded, onToggle }: Props) {
  const input = parseInput(toolCall.input);
  const summary = extractSummary(toolCall.name, input);
  const colors = getToolColor(toolCall.name);

  const renderContent = () => {
    switch (toolCall.name) {
      case 'Edit':
      case 'Write':
        return <EditContent input={input} />;
      case 'Bash':
        return <BashContent input={input} />;
      case 'Read':
        return <ReadContent input={input} />;
      case 'TodoWrite':
        return <TodoContent input={input} />;
      default:
        return <DefaultContent input={input} />;
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg, borderColor: colors.border }]}>
      <TouchableOpacity onPress={onToggle} style={styles.header} activeOpacity={0.7}>
        <View>
          <Text style={[styles.summary, { color: colors.text }]}>{summary}</Text>
          <Text style={styles.toolName}>{toolCall.name}</Text>
        </View>
        <Text style={[styles.arrow, { color: colors.text }]}>{expanded ? '▼' : '▶'}</Text>
      </TouchableOpacity>
      {expanded && <View style={styles.content}>{renderContent()}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  summary: {
    fontSize: 13,
    fontWeight: '600',
  },
  toolName: {
    fontSize: 11,
    color: Theme.textMuted0,
    marginTop: 2,
  },
  arrow: {
    fontSize: 10,
    fontWeight: '600',
  },
  content: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
});

const contentStyles = StyleSheet.create({
  container: {
    padding: 12,
  },
  fileLabel: {
    fontSize: 12,
    color: Theme.textMuted,
    marginBottom: 8,
  },
  pathText: {
    fontSize: 11,
    color: Theme.textMuted0,
    fontFamily: 'SpaceMono',
  },
  muted: {
    fontSize: 12,
    color: Theme.textMuted0,
    fontStyle: 'italic',
  },
  code: {
    fontSize: 10,
    color: Theme.assistantBubbleText,
    fontFamily: 'SpaceMono',
    lineHeight: 15,
  },
});

const diffStyles = StyleSheet.create({
  container: {
    gap: 10,
  },
  section: {},
  scrollContainer: {
    maxHeight: 180,
  },
  removedLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#ef4444',
    marginBottom: 4,
  },
  addedLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#10b981',
    marginBottom: 4,
  },
  removedBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.15)',
    borderLeftWidth: 2,
    borderLeftColor: '#ef4444',
    borderRadius: 4,
    padding: 8,
    minWidth: 200,
  },
  addedBox: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    borderLeftWidth: 2,
    borderLeftColor: '#10b981',
    borderRadius: 4,
    padding: 8,
    minWidth: 200,
  },
  line: {
    flexDirection: 'row',
  },
  lineNum: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.3)',
    width: 24,
    textAlign: 'right',
    marginRight: 8,
    fontFamily: 'SpaceMono',
  },
  removedText: {
    fontSize: 11,
    color: '#fca5a5',
    fontFamily: 'SpaceMono',
  },
  addedText: {
    fontSize: 11,
    color: '#6ee7b7',
    fontFamily: 'SpaceMono',
  },
  moreLines: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.4)',
    marginTop: 4,
    fontStyle: 'italic',
  },
  emptyText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.4)',
    fontStyle: 'italic',
  },
  expandBtnContainer: {
    marginTop: 8,
  },
  expandBtn: {
    fontSize: 11,
    color: '#3b82f6',
    fontWeight: '500',
  },
});

const bashStyles = StyleSheet.create({
  commandBox: {
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 6,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  prompt: {
    fontSize: 12,
    color: '#10b981',
    fontWeight: '700',
    marginRight: 8,
    fontFamily: 'SpaceMono',
  },
  command: {
    fontSize: 12,
    color: '#6ee7b7',
    fontFamily: 'SpaceMono',
  },
});

const todoStyles = StyleSheet.create({
  stats: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 10,
  },
  statText: {
    fontSize: 11,
    color: Theme.textMuted0,
  },
  completedNum: {
    color: '#10b981',
    fontWeight: '700',
  },
  progressNum: {
    color: '#3b82f6',
    fontWeight: '700',
  },
  pendingNum: {
    color: Theme.textMuted,
    fontWeight: '700',
  },
  list: {
    gap: 6,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  icon: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 2,
  },
  iconCompleted: {
    backgroundColor: '#10b981',
    borderColor: '#10b981',
  },
  iconProgress: {
    borderColor: '#3b82f6',
  },
  check: {
    fontSize: 9,
    color: '#fff',
    fontWeight: '700',
  },
  text: {
    fontSize: 12,
    color: Theme.assistantBubbleText,
    flex: 1,
  },
  textCompleted: {
    color: Theme.textMuted0,
    textDecorationLine: 'line-through',
  },
  textProgress: {
    color: '#93c5fd',
  },
});
