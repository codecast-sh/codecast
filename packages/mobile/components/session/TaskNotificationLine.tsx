import { TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Text as RNText } from '@/components/Themed';
import { Theme, themedStyles, useTheme } from '@/constants/Theme';
import { mobileRelativeTime } from '@codecast/shared/render/mobileSessionStyle';

// A background task's <task-notification> in a session transcript: one status
// row (done, killed, failed, running) that opens the agent's own session when
// the summary names one the conversation launched.

export function isTaskNotification(content: string): boolean {
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

export function TaskNotificationLine({ content, timestamp, childConversationMap }: { content: string; timestamp?: number; childConversationMap?: Record<string, string> }) {
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
      // Disabled with no child to open, so a tap on it falls through to the
      // transcript, which puts the keyboard away.
      disabled={!childId}
      onPress={childId ? () => router.push(`/session/${childId}`) : undefined}
      activeOpacity={childId ? 0.7 : 1}
      style={[styles.taskNotificationRow, { backgroundColor: config.bg }]}
    >
      <RNText style={[styles.taskNotificationIcon, { color: config.color }]}>{config.icon}</RNText>
      <RNText style={styles.taskNotificationSummary} numberOfLines={2}>{parsed.summary}</RNText>
      <RNText style={styles.taskNotificationId}>{parsed.taskId}</RNText>
      {timestamp != null && <RNText style={styles.taskNotificationTime}>{mobileRelativeTime(timestamp)}</RNText>}
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
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
    fontFamily: 'JetBrainsMono-Regular',
    color: Theme.textDim,
  },
  taskNotificationTime: {
    fontSize: 10,
    color: Theme.textDim,
  },
}));
