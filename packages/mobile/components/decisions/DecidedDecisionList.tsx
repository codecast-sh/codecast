import { useMemo } from 'react';
import { FlatList, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/components/Themed';
import { Spacing, BorderRadius, themedStyles, useTheme } from '@/constants/Theme';
import { useInboxStore, type SessionDecisionItem } from '@codecast/web/store/inboxStore';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useActiveWorkspaceKey } from '@codecast/web/hooks/useWorkspaceCollection';
import { useDecidedRows } from '@codecast/web/hooks/useDecisionRows';
import { useSyncTeamDecisions } from '@codecast/web/hooks/useSyncSessionDecisions';
import { answerTimeline } from '@codecast/web/lib/decisions/decisionHistory';
import { ageShort } from '@codecast/web/lib/lineFlow';
import { useAnswererName } from './SettledDecision';

// Decided on the phone: every answered or dismissed decision the store holds
// for the workspace and the viewer, newest first, each with its answer and
// who gave it. A row opens the decision, where its answer can change.
export function DecidedDecisionList({ header }: { header: React.ReactElement }) {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(60_000);
  useSyncTeamDecisions(useActiveWorkspaceKey());
  const rows = useDecidedRows();
  return (
    <FlatList
      style={{ backgroundColor: Theme.bg }}
      contentContainerStyle={styles.list}
      data={rows}
      keyExtractor={(d) => d._id}
      ListHeaderComponent={header}
      ListEmptyComponent={<View style={styles.empty}><Text style={styles.emptyTitle}>Nothing decided this week</Text></View>}
      renderItem={({ item }) => <DecidedRow d={item} now={now} onPress={() => router.push(`/decisions/${item._id}`)} />}
    />
  );
}

function DecidedRow({ d, now, onPress }: { d: SessionDecisionItem; now: number; onPress: () => void }) {
  const Theme = useTheme();
  const me = useInboxStore((s) => String(s.currentUser?._id ?? ''));
  const current = useMemo(() => answerTimeline(d)[0], [d]);
  const by = useAnswererName(d, me);
  const dismissed = d.status === 'dismissed';
  const changed = (d.answer_revision ?? 0) > 0;
  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={onPress} accessibilityRole="button">
      <View style={styles.meta}>
        <Text style={styles.by} numberOfLines={1}>{by}</Text>
        {changed ? <Text style={[styles.tag, { color: Theme.yellow }]}>Changed</Text> : null}
        <Text style={styles.age}>{d.resolved_at ? ageShort(now - d.resolved_at) : ''}</Text>
      </View>
      <Text style={styles.question} numberOfLines={2}>{d.question}</Text>
      <Text style={[styles.answer, { color: dismissed ? Theme.textMuted : Theme.green }]} numberOfLines={2}>
        {dismissed ? 'Dismissed' : current?.label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  list: { padding: Spacing.lg, gap: Spacing.md, flexGrow: 1 },
  row: { backgroundColor: Theme.card, borderRadius: BorderRadius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, padding: Spacing.lg, gap: 6 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  by: { fontSize: 12, color: Theme.textMuted, fontWeight: '600', flexShrink: 1 },
  tag: { fontSize: 12, fontWeight: '600' },
  age: { fontSize: 12, color: Theme.textMuted0, marginLeft: 'auto' },
  question: { fontSize: 15, lineHeight: 21, color: Theme.text, fontWeight: '500' },
  answer: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xxl },
  emptyTitle: { fontSize: 18, color: Theme.text, fontWeight: '600' },
}));
