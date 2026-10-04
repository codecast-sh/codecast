import { useMemo } from 'react';
import { FlatList, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Text } from '@/components/Themed';
import { Spacing, BorderRadius, themedStyles, useTheme } from '@/constants/Theme';
import { useDecisionQueue } from '@codecast/web/hooks/useDecisionQueue';
import { waitingOnPerson, type QueueItem } from '@codecast/web/lib/decisionQueue';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { QueueChip, askingSessionLine } from '@/components/decisions/QueueMeta';

// Every open decision, in the queue's order (lib/decisionQueue: blocked and
// reachable first, oldest first within a tier). A `cast decide` row opens the
// one-at-a-time screen; a terminal prompt (an AskUserQuestion, a permission)
// has no authored payload and is answered inside its session.
export default function DecisionsScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const queue = useDecisionQueue();
  const now = useCoarseNow(60_000);
  const mine = waitingOnPerson(queue).length;
  const withLead = queue.length - mine;
  const firstDecide = useMemo(() => queue.find((i) => i.source === 'decide' && !i.heldByRole), [queue]);

  const open = (item: QueueItem) => {
    if (item.source === 'decide' && item.decisionId) router.push(`/decisions/${item.decisionId}`);
    else router.push(`/session/${item.conversationId}`);
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Decisions' }} />
      <FlatList
        style={{ backgroundColor: Theme.bg }}
        contentContainerStyle={styles.list}
        data={queue}
        keyExtractor={(i) => i.key}
        ListHeaderComponent={queue.length > 0 ? (
          <View style={styles.header}>
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
        ) : null}
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
      />
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  list: { padding: Spacing.lg, gap: Spacing.md, flexGrow: 1 },
  header: { gap: Spacing.md, marginBottom: Spacing.xs },
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
