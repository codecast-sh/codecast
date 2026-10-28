import { useMemo } from 'react';
import { FlatList, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/components/Themed';
import { Spacing, BorderRadius, themedStyles, useTheme } from '@/constants/Theme';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useDecisionRows } from '@codecast/web/hooks/useDecisionRows';
import { useSyncTeamDecisions, useSyncTeamLineDecisions } from '@codecast/web/hooks/useSyncSessionDecisions';
import { arrangeDecisions, decisionOwner, decisionView, isEscalated } from '@codecast/web/lib/decisions/decisionRows';
import { ageShort } from '@codecast/web/lib/lineFlow';

const TEAM_VIEW = decisionView({ tab: 'team', group: 'none' });

// The Team view on the phone: every open decision of the workspace in the web
// list's order (lib/decisions/decisionRows), each with its owner, Unassigned
// when nobody holds it. A row opens the decision's own screen.
export function TeamDecisionList({ header }: { header: React.ReactElement }) {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(60_000);
  const rows = useDecisionRows();
  useSyncTeamDecisions(rows.workspaceKey);
  useSyncTeamLineDecisions(rows.workspaceKey ? [rows.workspaceKey] : []);
  const me = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const namesSig = useInboxStore((s) => (s.teamMembers ?? []).map((m: any) => `${m._id}\u0001${m.name ?? m.email ?? ''}`).join('\u0002'));
  const names = useMemo(() => new Map(namesSig ? namesSig.split('\u0002').map((x) => x.split('\u0001') as [string, string]) : []), [namesSig]);
  const items = useMemo(() => arrangeDecisions(rows.workspace, TEAM_VIEW, { me, now, label: () => '' }).items, [rows.workspace, me, now]);
  const ownerName = (d: (typeof items)[number]) => {
    const o = decisionOwner(d);
    if (!o) return 'Unassigned';
    if (o.kind === 'role') return 'A role';
    return o.id === me ? 'You' : names.get(o.id) || 'A teammate';
  };

  return (
    <FlatList
      style={{ backgroundColor: Theme.bg }}
      contentContainerStyle={styles.list}
      data={items}
      keyExtractor={(d) => d._id}
      ListHeaderComponent={header}
      ListEmptyComponent={<View style={styles.empty}><Text style={styles.emptyTitle}>No open decisions</Text></View>}
      renderItem={({ item: d }) => (
        <TouchableOpacity style={styles.row} activeOpacity={0.6} onPress={() => router.push(`/decisions/${d._id}`)}>
          <View style={styles.meta}>
            <Text style={[styles.owner, !decisionOwner(d) && { color: Theme.orange }]}>{ownerName(d)}</Text>
            {isEscalated(d) ? <Text style={[styles.tag, { color: Theme.red }]}>Escalated</Text> : d.blocking ? <Text style={[styles.tag, { color: Theme.yellow }]}>Blocking</Text> : null}
            <Text style={styles.age}>{ageShort(now - d.created_at)}</Text>
          </View>
          <Text style={styles.question} numberOfLines={3}>{d.question}</Text>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  list: { padding: Spacing.lg, gap: Spacing.md, flexGrow: 1 },
  row: { backgroundColor: Theme.card, borderRadius: BorderRadius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, padding: Spacing.lg, gap: Spacing.sm },
  meta: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  owner: { fontSize: 12, color: Theme.textMuted, fontWeight: '600' },
  tag: { fontSize: 12 },
  age: { fontSize: 12, color: Theme.textMuted0, marginLeft: 'auto' },
  question: { fontSize: 15, lineHeight: 21, color: Theme.text, fontWeight: '500' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xxl },
  emptyTitle: { fontSize: 18, color: Theme.text, fontWeight: '600' },
}));
