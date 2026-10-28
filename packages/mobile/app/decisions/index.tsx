import { useMemo, useState } from 'react';
import { FlatList, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Text } from '@/components/Themed';
import { Spacing, BorderRadius, themedStyles, useTheme } from '@/constants/Theme';
import { useDecisionQueue } from '@codecast/web/hooks/useDecisionQueue';
import { waitingOnPerson, type QueueItem } from '@codecast/web/lib/decisionQueue';
import { useOwnedDecisionCount } from '@codecast/web/hooks/useDecisionRows';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { QueueChip, askingSessionLine } from '@/components/decisions/QueueMeta';
import { TeamDecisionList } from '@/components/decisions/TeamDecisionList';

// Decisions, Mine and Team as on the web's Decisions page. Mine is the
// viewer's queue, in its order (lib/decisionQueue: blocked and reachable
// first, oldest first within a tier): a `cast decide` row opens the
// one-at-a-time screen; a terminal prompt (an AskUserQuestion, a permission)
// has no authored payload and is answered inside its session. Team is every
// open decision of the workspace with its owner (TeamDecisionList).
export default function DecisionsScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const queue = useDecisionQueue();
  const now = useCoarseNow(60_000);
  // Yours as the web counts them (useOwnedDecisionCount); the queue also lists terminal prompts and asks a lead holds.
  const mine = useOwnedDecisionCount();
  const withLead = queue.length - waitingOnPerson(queue).length;
  const firstDecide = useMemo(() => queue.find((i) => i.source === 'decide' && !i.heldByRole), [queue]);
  const [view, setView] = useState<'mine' | 'team'>('mine');
  const switcher = (
    <View style={[styles.switcher, { borderColor: Theme.borderLight }]}>
      {(['mine', 'team'] as const).map((v) => (
        <TouchableOpacity key={v} style={[styles.seg, view === v && { backgroundColor: Theme.card }]} onPress={() => setView(v)} accessibilityRole="tab" accessibilityState={{ selected: view === v }}>
          <Text style={[styles.segText, view === v && { color: Theme.text }]}>{v === 'mine' ? 'Mine' : 'Team'}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  const open = (item: QueueItem) => {
    if (item.source === 'decide' && item.decisionId) router.push(`/decisions/${item.decisionId}`);
    else router.push(`/session/${item.conversationId}`);
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Decisions', headerBackTitle: 'Inbox' }} />
      {view === 'team' ? <TeamDecisionList header={switcher} /> : <FlatList
        style={{ backgroundColor: Theme.bg }}
        contentContainerStyle={styles.list}
        data={queue}
        keyExtractor={(i) => i.key}
        ListHeaderComponent={queue.length > 0 ? (
          <View style={styles.header}>
            {switcher}
            <Text style={styles.summary}>
              {mine} waiting on you{withLead ? ` · ${withLead} with a lead` : ''}
            </Text>
            {firstDecide?.decisionId ? (
              <TouchableOpacity
                style={[styles.start, { backgroundColor: Theme.blue }]}
                activeOpacity={0.8}
                onPress={() => router.push(`/decisions/${firstDecide.decisionId}`)}
              >
                <Text style={styles.startText}>Answer one at a time</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : switcher}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nothing needs you.</Text>
            <Text style={styles.emptyBody}>Your agents are working. New decisions land here the moment one asks.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => open(item)}>
            <QueueChip item={item} now={now} />
            <Text style={styles.question} numberOfLines={3}>{item.question}</Text>
            {askingSessionLine(item) ? <Text style={styles.session} numberOfLines={1}>{askingSessionLine(item)}</Text> : null}
          </TouchableOpacity>
        )}
      />}
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  list: { padding: Spacing.lg, gap: Spacing.md, flexGrow: 1 },
  header: { gap: Spacing.md, marginBottom: Spacing.xs },
  switcher: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: BorderRadius.lg, padding: 2, marginBottom: Spacing.xs },
  seg: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: BorderRadius.md },
  segText: { fontSize: 14, fontWeight: '600', color: Theme.textMuted },
  summary: { fontSize: 13, color: Theme.textMuted },
  start: { borderRadius: BorderRadius.lg, paddingVertical: 14, alignItems: 'center' },
  startText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  row: {
    backgroundColor: Theme.card,
    borderRadius: BorderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  question: { fontSize: 15, lineHeight: 21, color: Theme.text, fontWeight: '500' },
  session: { fontSize: 12, color: Theme.textMuted0 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.xxl },
  emptyTitle: { fontSize: 18, color: Theme.text, fontWeight: '600' },
  emptyBody: { fontSize: 13, color: Theme.textMuted, textAlign: 'center', lineHeight: 19 },
}));
