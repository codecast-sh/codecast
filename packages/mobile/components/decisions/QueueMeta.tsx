import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/Themed';
import { useTheme, chipShell, chipText, chipTint, CHROME_FONT_CAP } from '@/constants/Theme';
import { getProjectName } from '@codecast/web/store/inboxStore';
import { formatTimeAgo } from '@codecast/web/lib/messageNavigator';
import type { QueueItem } from '@codecast/web/lib/decisionQueue';

// The asking session in one line: its project, then its title.
export function askingSessionLine(item: QueueItem): string {
  const s = item.session;
  if (!s) return '';
  const project = s.git_root || s.project_path ? getProjectName(s.git_root, s.project_path) : '';
  return [project, s.title].filter(Boolean).join(' · ');
}

// What the ask costs the agent while it waits: parked on you, going ahead on
// its default, or a terminal prompt (answered inside the session).
export function QueueChip({ item, now }: { item: QueueItem; now: number }) {
  const Theme = useTheme();
  const terminal = item.source !== 'decide';
  const color = terminal ? Theme.violet : item.blocking ? Theme.orange : Theme.textMuted0;
  const label = terminal ? (item.source === 'permission' ? 'permission' : 'in a terminal') : item.blocking ? 'waiting' : 'advisory';
  return (
    <View style={styles.row}>
      <View style={[chipShell, chipTint(color)]}>
        <Text style={[chipText, { color }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{label}</Text>
      </View>
      {item.shortId ? <Text style={[styles.dim, { color: Theme.textMuted0 }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{item.shortId}</Text> : null}
      <Text style={[styles.dim, { color: Theme.textMuted0 }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{formatTimeAgo(item.createdAt, now)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dim: { fontSize: 11 },
});
