// The phone's Priorities list, the twin of web's /priorities: every priority
// the viewer can read, in every workspace they hold, in sections per
// workspace and person (web's lib/prioritySections, laid out as rows by
// lib/prioritiesList sectionItems), under one row of chips, Group by and
// Compact (components/priorities/PrioritiesToolbar). Each priority has its
// title, its ⋯ and ten days of typing, then its open critical milestones,
// each carrying its state as a session mark (needs you and New session are
// the two that act, on a teammate's as on the viewer's own), then DONE n and
// POLISH x/y. A milestone opens in place to everything it is connected to.
// Each group ends in "Done and set aside n", folded.
// Store-fed as web is: priorities.list feeds the `priorities` collection and
// the screen reads it; typing per day is an enrichment read beside it. Every
// model is web's (lib/priorityList buildModels), and every override is web's
// write (lib/priorityWrites).
import { Fragment, useCallback, useMemo, useState } from 'react';
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
import { nextPassLabel, pastBadge } from '@codecast/web/lib/priorities';
import { buildSections, pageControls, visibleCount } from '@codecast/web/lib/prioritySections';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { usePriorityList, usePrioritiesView } from '@/hooks/usePriorityList';
import { ObjectMissing, objectStyles } from '@/components/objects/ObjectParts';
import { DayStrip, Milestones, More, PendingMark, priorityMenuSheet, type OwnOf } from '@/components/priorities/PriorityParts';
import { OwnerFace, PrioritiesToolbar, WorkspaceMark } from '@/components/priorities/PrioritiesToolbar';
import { Legend } from '@/components/priorities/Legend';
import { itemRows, sectionItems, type ListItem } from '@/lib/prioritiesList';
import { showActionSheet } from '@/lib/popups';

const api = _api as any;

export default function PrioritiesScreen() {
  const Theme = useTheme();
  const { feed, rows, meta } = usePriorityList();
  const [view] = usePrioritiesView();
  // Typing per day, every workspace's in one answer, is computed on read from typed messages: an enrichment beside the rows, which paint without it.
  const history = useQueryNoThrow(
    api.priorities.history,
    { days: LIST_DAYS, tz_offset_minutes: new Date().getTimezoneOffset() },
    { remember: true },
  ).data as PriorityHistory | undefined;
  const now = useCoarseNow(30_000);
  // The count beside the title is everyone's active priorities in the sections shown.
  const listed = useMemo(() => visibleCount(rows, view.hidden), [rows, view.hidden]);

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
  if (!rows.some((r) => r.status !== 'merged')) {
    // Web's empty state: when the pass next looks.
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
  const [view, setView] = usePrioritiesView();
  const activeWorkspace = useActiveWorkspaceKey();
  const teams = useInboxStore((s) => s.teams);
  const workspaceNames = useMemo(() => Object.fromEntries((teams ?? []).map((t: any) => [`team:${t._id}`, String(t.name ?? 'Team')])), [teams]);
  const opts = useMemo(() => ({ activeWorkspace, hidden: view.hidden, workspaceNames }), [activeWorkspace, view.hidden, workspaceNames]);
  const controls = useMemo(() => pageControls(rows, opts), [rows, opts]);
  const sections = useMemo(() => buildSections(rows, { ...opts, groupBy: view.groupBy }), [rows, opts, view.groupBy]);
  const items = useMemo(() => sectionItems(sections, { headings: controls.showSectionHeadings, people: controls.showGroupBy }), [sections, controls]);
  // Every row the sections draw, open or folded: their models share one scale.
  const shown = useMemo(() => itemRows(items), [items]);
  const days = useMemo(() => lastDays(LIST_DAYS, now), [now]);
  const todayIndex = days.indexOf(localDayKey(now));
  const ids = useMemo(() => linkedSessionIds(shown), [shown]);
  // Needs you exactly when the phone's own inbox files a session under Needs You.
  const live = usePriorityLiveStates(ids, now, 'phone');
  const models = useMemo(() => buildModels(shown, history, live, days), [shown, history, live, days]);
  const peak = useMemo(() => Math.max(1, ...models.flatMap((m) => m.counts)), [models]);
  const prs = useMemo(() => linkedPrRefs(shown), [shown]);
  const lookups = usePriorityLookups(ids, prs, useMemo(() => shown.map((r) => r.workspace), [shown]));
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(new Set());
  const byId = new Map(models.map((m) => [m.row.short_id, m]));
  // The owner's active priorities per workspace, in order: where a move, a merge or a session can go.
  const ownOf = useCallback<OwnOf>((row) => effectivePriorityOrder(rows.filter((r) => r.mine && r.workspace === row.workspace && r.status === 'active')), [rows]);
  const block = (r: PriorityRow, face: boolean) => {
    const m = byId.get(r.short_id);
    return m ? <PriorityBlock key={r.short_id} model={m} days={days} todayIndex={todayIndex} peak={peak} now={now} lookups={lookups} own={ownOf} compact={view.compact} face={face} /> : null;
  };
  const toggleFold = (key: string) => setOpenFolds((s) => {
    const next = new Set(s);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const item = (i: ListItem, index: number) => {
    if (i.kind === 'priority') return block(i.row, i.face);
    if (i.kind === 'heading') return <ListHeading key={`h:${i.key}`} item={i} first={index === 0} />;
    const open = openFolds.has(i.key);
    return (
      <Fragment key={`f:${i.key}`}>
        <PastFold item={i} open={open} onToggle={() => toggleFold(i.key)} />
        {open && i.rows.map((r) => block(r, i.face))}
      </Fragment>
    );
  };

  return (
    <ScrollView style={objectStyles.container} contentContainerStyle={styles.content} testID="priorities-screen">
      <PrioritiesToolbar controls={controls} view={view} groupBy={sections.groupBy} onChange={setView} />
      {items.map(item)}
    </ScrollView>
  );
}

/** A heading: its mark centred in the rank column, its name at the titles' edge; a top one is a section's own. */
function ListHeading({ item, first }: { item: Extract<ListItem, { kind: 'heading' }>; first: boolean }) {
  const mark = item.mark == null ? null : 'workspace' in item.mark ? <WorkspaceMark workspace={item.mark.workspace} /> : <OwnerFace row={item.mark.face} size={16} />;
  return (
    <RNView style={[styles.heading, item.top ? styles.topHeading : styles.groupHeading, item.top && !first && styles.sectionGap]} testID={`priorities-heading-${item.key}`}>
      <RNView style={styles.headingMark}>{mark}</RNView>
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} numberOfLines={1} style={[item.top ? styles.topName : styles.label, styles.headingName]}>{item.top ? item.name : item.name.toUpperCase()}</RNText>
      {item.count != null && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.label, { fontWeight: '400' }]}>{item.count}</RNText>}
    </RNView>
  );
}

/** "Done and set aside n": a group's last row, starting at the titles' edge. */
function PastFold({ item, open, onToggle }: { item: Extract<ListItem, { kind: 'fold' }>; open: boolean; onToggle: () => void }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity onPress={onToggle} style={styles.pastHead} accessibilityRole="button" accessibilityState={{ expanded: open }} testID={`priorities-past-${item.key}`}>
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.label}>DONE AND SET ASIDE</RNText>
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.label, { fontWeight: '400' }]}>{item.rows.length}</RNText>
      <Feather name={open ? 'chevron-down' : 'chevron-right'} size={12} color={Theme.textDim} />
    </TouchableOpacity>
  );
}

function PriorityBlock({ model, days, todayIndex, peak, now, lookups, own, compact, face }: {
  model: PriorityModel;
  days: string[];
  todayIndex: number;
  peak: number;
  now: number;
  lookups: LinkLookups;
  own: OwnOf;
  /** One line: the head alone. */
  compact: boolean;
  /** The owner's face after the rank (Workspace grouping), over the milestones' marks. */
  face: boolean;
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
        {face && <RNView style={styles.face}><OwnerFace row={row} /></RNView>}
        <RNView style={styles.headTitle}>
          <TouchableOpacity style={styles.titlePress} onPress={openPriority} accessibilityRole="link" testID={`priorities-open-${row.short_id}`}>
            <RNText style={[styles.title, past && styles.pastTitle]} numberOfLines={2}>{row.title}</RNText>
          </TouchableOpacity>
          <More label={`More for ${row.title}`} onPress={menu} testID={`priorities-menu-${row.short_id}`} />
        </RNView>
        <DayStrip counts={model.counts} days={days} todayIndex={todayIndex} peak={peak} />
      </RNView>
      {!compact && (past || pending) && (
        <RNView style={styles.badges}>
          {past && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.dim}>{pastBadge(row)}</RNText>}
          {pending && <PendingMark />}
        </RNView>
      )}
      {!compact && (
        <RNView style={styles.milestones}>
          <Milestones model={model} now={now} lookups={lookups} own={own} />
        </RNView>
      )}
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

  // A heading's mark sits in the rank column, its name at the titles' edge (rank 18 + gap 8).
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  topHeading: { minHeight: 36, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.border },
  groupHeading: { minHeight: 30, paddingTop: 8 },
  sectionGap: { marginTop: 20 },
  headingMark: { width: 18, alignItems: 'center' },
  headingName: { flexShrink: 1 },
  topName: { fontSize: 14, fontWeight: '600', color: Theme.text },

  block: { paddingTop: 6, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.borderLight },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  rank: { width: 18, textAlign: 'center', fontSize: 13.5, fontWeight: '600', color: Theme.textDim, fontVariant: ['tabular-nums'] },
  // Centred over the milestones' 44pt mark slots (milestones' 18 margin + 22 = the face's 26 + 14).
  face: { width: 28, alignItems: 'center' },
  // The ⋯ sits right after the title, however long it runs.
  headTitle: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' },
  titlePress: { flexShrink: 1, minHeight: 44, justifyContent: 'center', paddingVertical: 4 },
  title: { fontSize: 15, fontWeight: '700', color: Theme.text, lineHeight: 20 },
  pastTitle: { color: Theme.textMuted },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 26, marginTop: -6 },
  // The marks' boxes line up under the title (each mark's 28pt box sits 8pt into its 44pt slot).
  milestones: { marginLeft: 18 },
  pastHead: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, paddingLeft: 26 },
}));
