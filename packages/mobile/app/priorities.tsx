// The phone's Priorities list, the twin of web's /priorities: the viewer's own
// active priorities in rank order, each with its title, its ⋯ and ten days of
// typing, then its open critical milestones, each carrying its state as a
// session mark (needs you and New session are the two that act), then DONE n
// and POLISH x/y. A milestone opens in place to everything it is connected
// to. Priorities done, quiet or set aside fold into one line at the bottom.
// Store-fed as web is: priorities.list feeds the `priorities` collection and
// the screen reads it; typing per day is an enrichment read beside it. Every
// model is web's (lib/priorityList buildModels), and every override is web's
// write (lib/priorityWrites).
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import { effectivePriorityOrder, type PriorityHistory, type PriorityRow } from '@codecast/shared/contracts/priorities';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useActiveWorkspaceKey } from '@codecast/web/hooks/useWorkspaceCollection';
import { linkedPrRefs, linkedSessionIds, usePriorityLiveStates, usePriorityLookups, type LinkLookups } from '@codecast/web/hooks/usePriorityModels';
import { LIST_DAYS, buildModels, lastDays, localDayKey, type PriorityModel } from '@codecast/web/lib/priorityList';
import { nextPassLabel, ownerGroups, pastBadge } from '@codecast/web/lib/priorities';
import { usePriorityList } from '@/hooks/usePriorityList';
import { ObjectMissing, objectStyles } from '@/components/objects/ObjectParts';
import { DayStrip, Milestones, More, PendingMark, priorityMenuSheet, type OwnOf } from '@/components/priorities/PriorityParts';
import { Legend } from '@/components/priorities/Legend';
import { showActionSheet } from '@/lib/popups';

const api = _api as any;

export default function PrioritiesScreen() {
  const Theme = useTheme();
  const workspace = useActiveWorkspaceKey();
  const { feed, rows, meta } = usePriorityList();
  // Typing per day is computed on read from typed messages: an enrichment beside the rows, which paint without it.
  const history = useQueryNoThrow(
    api.priorities.history,
    workspace ? { workspace, days: LIST_DAYS, tz_offset_minutes: new Date().getTimezoneOffset() } : 'skip',
    { remember: true },
  ).data as PriorityHistory | undefined;
  const now = useCoarseNow(30_000);
  // The count beside the title is the viewer's own active priorities, the list's rows.
  const listed = useMemo(() => rows.filter((r) => r.mine && r.status === 'active').length, [rows]);

  const header = <Stack.Screen options={{ title: rows.length ? `Priorities · ${listed}` : 'Priorities', headerRight: () => <Legend /> }} />;
  if (rows.length === 0 && feed.error) {
    return (
      <>
        {header}
        <RNView style={styles.center} testID="priorities-error">
          <Feather name="alert-triangle" size={26} color={Theme.textMuted0} />
          <RNText style={styles.centerText}>Priorities didn't load</RNText>
          <TouchableOpacity onPress={feed.retry} style={styles.control} accessibilityRole="button">
            <RNText style={styles.controlText}>Try again</RNText>
          </TouchableOpacity>
        </RNView>
      </>
    );
  }
  if (rows.length === 0 && !feed.ready) return <>{header}<ObjectMissing what="Priorities" loading /></>;
  if (!rows.some((r) => r.mine && r.status !== 'merged')) {
    // Teammates' priorities alone draw nothing here: the list is the viewer's own. Web's empty state: when the pass next looks.
    const next = nextPassLabel(meta.next_pass_at, now);
    return (
      <>
        {header}
        <RNView style={styles.center} testID="priorities-empty">
          <Feather name="target" size={26} color={Theme.textMuted0} />
          <RNText style={styles.centerText}>No priorities yet</RNText>
          {next ? <RNText style={styles.dim}>{next}</RNText> : null}
        </RNView>
      </>
    );
  }
  return (
    <>
      {header}
      <PrioritiesView rows={rows} history={history} now={now} />
    </>
  );
}

function PrioritiesView({ rows, history, now }: { rows: PriorityRow[]; history: PriorityHistory | undefined; now: number }) {
  const Theme = useTheme();
  // Only the viewer's own: active in rank order, then done, quiet and set aside.
  const own = useMemo(() => ownerGroups(rows).find((g) => g.mine) ?? { active: [], past: [] }, [rows]);
  const shown = useMemo(() => [...own.active, ...own.past], [own]);
  const days = useMemo(() => lastDays(LIST_DAYS, now), [now]);
  const todayIndex = days.indexOf(localDayKey(now));
  const ids = useMemo(() => linkedSessionIds(shown), [shown]);
  // Needs you exactly when the phone's own inbox files a session under Needs You.
  const live = usePriorityLiveStates(ids, now, 'phone');
  const models = useMemo(() => buildModels(shown, history, live, days), [shown, history, live, days]);
  const peak = useMemo(() => Math.max(1, ...models.flatMap((m) => m.counts)), [models]);
  const prs = useMemo(() => linkedPrRefs(shown), [shown]);
  const lookups = usePriorityLookups(ids, prs, useMemo(() => shown.map((r) => r.workspace), [shown]));
  const [pastOpen, setPastOpen] = useState(false);
  const byId = new Map(models.map((m) => [m.row.short_id, m]));
  // The owner's active priorities per workspace, in order: where a move, a merge or a session can go.
  const ownOf = useCallback<OwnOf>((row) => effectivePriorityOrder(rows.filter((r) => r.mine && r.workspace === row.workspace && r.status === 'active')), [rows]);
  const block = (r: PriorityRow) => {
    const m = byId.get(r.short_id);
    return m ? <PriorityBlock key={r.short_id} model={m} days={days} todayIndex={todayIndex} peak={peak} now={now} lookups={lookups} own={ownOf} /> : null;
  };

  return (
    <ScrollView style={objectStyles.container} contentContainerStyle={styles.content} testID="priorities-screen">
      {own.active.map(block)}
      {own.past.length > 0 && (
        <RNView testID="priorities-past">
          <TouchableOpacity onPress={() => setPastOpen((o) => !o)} style={styles.pastHead} accessibilityRole="button" accessibilityState={{ expanded: pastOpen }} testID="priorities-past-toggle">
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.label}>PAST</RNText>
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.label, { fontWeight: '400' }]}>{own.past.length}</RNText>
            <Feather name={pastOpen ? 'chevron-down' : 'chevron-right'} size={12} color={Theme.textDim} />
          </TouchableOpacity>
          {pastOpen && own.past.map(block)}
        </RNView>
      )}
    </ScrollView>
  );
}

function PriorityBlock({ model, days, todayIndex, peak, now, lookups, own }: {
  model: PriorityModel;
  days: string[];
  todayIndex: number;
  peak: number;
  now: number;
  lookups: LinkLookups;
  own: OwnOf;
}) {
  const router = useRouter();
  const { row } = model;
  const past = row.status !== 'active';
  // The row's own correction, when no milestone line carries it.
  const pending = row.correction_pending && !model.milestones.some((m) => m.correctionPending);
  const openPriority = () => router.push(`/priority/${row.short_id}` as never);
  const menu = () => {
    const { title, items } = priorityMenuSheet(row, own, openPriority);
    showActionSheet(title, items);
  };

  return (
    <RNView style={styles.block} testID={`priorities-row-${row.short_id}`}>
      <RNView style={styles.head}>
        <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.rank}>{row.status === 'active' ? row.rank ?? '' : ''}</RNText>
        <RNView style={styles.headTitle}>
          <TouchableOpacity style={styles.titlePress} onPress={openPriority} accessibilityRole="link" testID={`priorities-open-${row.short_id}`}>
            <RNText style={[styles.title, past && styles.pastTitle]} numberOfLines={2}>{row.title}</RNText>
          </TouchableOpacity>
          <More label={`More for ${row.title}`} onPress={menu} testID={`priorities-menu-${row.short_id}`} />
        </RNView>
        <DayStrip counts={model.counts} days={days} todayIndex={todayIndex} peak={peak} />
      </RNView>
      {(past || pending) && (
        <RNView style={styles.badges}>
          {past && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.dim}>{pastBadge(row)}</RNText>}
          {pending && <PendingMark />}
        </RNView>
      )}
      <RNView style={styles.milestones}>
        <Milestones model={model} now={now} lookups={lookups} own={own} />
      </RNView>
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: 48 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10, backgroundColor: Theme.bg, padding: Spacing.xxl },
  centerText: { fontSize: 14, color: Theme.textMuted, textAlign: 'center' },
  control: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, backgroundColor: Theme.bgAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight },
  controlText: { fontSize: 14, fontWeight: '500', color: Theme.accent },
  dim: { fontSize: 12, color: Theme.textDim },
  label: { fontSize: 11, fontWeight: '600', color: Theme.textDim, letterSpacing: 0.5, fontVariant: ['tabular-nums'] },

  block: { paddingTop: 6, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.borderLight },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  rank: { width: 18, textAlign: 'right', fontSize: 13.5, fontWeight: '600', color: Theme.textDim, fontVariant: ['tabular-nums'] },
  // The ⋯ sits right after the title, however long it runs.
  headTitle: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' },
  titlePress: { flexShrink: 1, minHeight: 44, justifyContent: 'center', paddingVertical: 4 },
  title: { fontSize: 15, fontWeight: '700', color: Theme.text, lineHeight: 20 },
  pastTitle: { color: Theme.textMuted },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 26, marginTop: -6 },
  // The marks' boxes line up under the title (each mark's 28pt box sits 8pt into its 44pt slot).
  milestones: { marginLeft: 18 },
  pastHead: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, marginTop: 4 },
}));
