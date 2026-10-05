// The phone's search beyond sessions, Cmd-K's groups: tasks, plans and docs
// answer instantly from the local index (lib/universalSearch), chat message
// hits land when the server answers (hooks/useRemoteSearch, run by the caller
// with the session search). Rendered under the session results.
import { useMemo } from 'react';
import { StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { matchMentionGroups, type MentionRecord } from '@codecast/web/lib/universalSearch';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { mobileEntityRoute } from '@/lib/linkRoutes';
import { openLink } from '@/lib/links';

const CAP = 5;

type IconName = React.ComponentProps<typeof FontAwesome>['name'];

export function ObjectSearchSections({ query, chatHits }: { query: string; chatHits: any[] }) {
  const router = useRouter();
  const index = useInboxStore((s) => s.mentionIndex);
  const teamId = useInboxStore((s) => s.clientState.ui?.active_team_id ?? undefined);
  const groups = useMemo(() => matchMentionGroups(index as any, query, teamId as any, CAP), [index, query, teamId]);

  const open = (type: 'task' | 'plan' | 'doc', r: MentionRecord) => {
    const route = mobileEntityRoute(type, type === 'doc' ? r._id : r.short_id ?? r._id);
    if (route) router.push(route as any);
  };

  return (
    <>
      <Group title="Tasks" icon="check-square-o" rows={groups.tasks} onPress={(r) => open('task', r)} />
      <Group title="Plans" icon="map-o" rows={groups.plans} onPress={(r) => open('plan', r)} />
      <Group title="Docs" icon="file-text-o" rows={groups.docs} onPress={(r) => open('doc', r)} />
      {chatHits.length > 0 && (
        <Section title="Chat">
          {chatHits.map((h) => (
            <Row
              key={h._id}
              icon="comment-o"
              title={h.snippet ?? ''}
              sub={h.channel_kind === 'dm' ? 'direct message' : `#${h.channel_name}`}
              onPress={() => void openLink(h.permalink)}
            />
          ))}
        </Section>
      )}
    </>
  );
}

function Group({ title, icon, rows, onPress }: { title: string; icon: IconName; rows: MentionRecord[]; onPress: (r: MentionRecord) => void }) {
  if (rows.length === 0) return null;
  return (
    <Section title={title}>
      {rows.map((r) => (
        <Row key={r._id} icon={icon} title={r.title} sub={r.short_id} onPress={() => onPress(r)} />
      ))}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  useTheme();
  return (
    <RNView style={styles.section}>
      <RNText style={styles.sectionTitle}>{title}</RNText>
      {children}
    </RNView>
  );
}

function Row({ icon, title, sub, onPress }: { icon: IconName; title: string; sub?: string; onPress: () => void }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={title}>
      <FontAwesome name={icon} size={14} color={Theme.textMuted} style={styles.icon} />
      <RNText style={styles.title} numberOfLines={1}>{title}</RNText>
      {sub ? <RNText style={styles.sub} numberOfLines={1}>{sub}</RNText> : null}
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  section: { marginTop: Spacing.md },
  sectionTitle: { fontSize: 11, fontWeight: '600', color: Theme.textMuted0, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.lg, paddingVertical: 11 },
  icon: { width: 16 },
  title: { flex: 1, fontSize: 14, color: Theme.text },
  sub: { fontSize: 11, color: Theme.textMuted0, maxWidth: 110 },
}));
