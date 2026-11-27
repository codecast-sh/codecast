// A priority on the phone (`pri-N`), the list's row made bigger as web's
// priority page is: its title whole, ten days of typing across the screen
// with the day under each, its plan once, then its milestones as the list
// draws them (components/priorities/PriorityParts) with every open one
// expanded to what it is connected to, and the owner's corrections to the
// pass. The header carries Share and the priority's ⋯ (Rename, the moves,
// Correct…, Copy pri-N). Store-fed: priorities.show feeds priorityDetails
// (web hooks/usePriorityDetail); the workspace list's row paints until the
// detail lands. The model is web's lib/priorityList, so states and order
// match web.
import { useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import { effectivePriorityOrder, type PriorityHistory, type PriorityRow } from '@codecast/shared/contracts/priorities';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useWorkspaceCollection } from '@codecast/web/hooks/useWorkspaceCollection';
import { linkedPrRefs, linkedSessionIds, usePriorityLookups, usePriorityModel } from '@codecast/web/hooks/usePriorityModels';
import { LIST_DAYS, lastDays, localDayKey } from '@codecast/web/lib/priorityList';
import { pastBadge, prioritySig } from '@codecast/web/lib/priorities';
import { usePriorityDetail, useSyncPriorityDetail } from '@codecast/web/hooks/usePriorityDetail';
import type { PriorityView } from '@codecast/web/lib/priorityDetail';
import { ObjectHeader, ObjectMissing, SectionLabel, objectStyles } from '@/components/objects/ObjectParts';
import { DayStrip, Milestones, PendingMark, priorityMenuSheet, type OwnOf } from '@/components/priorities/PriorityParts';

const api = _api as any;

const shortDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function PriorityScreen() {
  const Theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const ref = String(id ?? '').toLowerCase();
  const feed = useSyncPriorityDetail(ref || null);
  const row = usePriorityDetail(ref || null);
  // A refusal wins over whatever the store held: merged, rewritten, or no longer the viewer's to read.
  if (feed.refused) return <ObjectMissing what="Priority" id={ref} loading={false} />;
  if (!row) {
    if (feed.error) {
      return (
        <>
          <ObjectHeader type="priority" shortId={ref} title={ref} />
          <RNView style={styles.center} testID="priority-error">
            <Feather name="alert-triangle" size={26} color={Theme.textMuted0} />
            <RNText style={styles.centerText}>This priority didn't load</RNText>
            <TouchableOpacity onPress={feed.retry} style={styles.retry} accessibilityRole="button">
              <RNText style={styles.retryText}>Try again</RNText>
            </TouchableOpacity>
          </RNView>
        </>
      );
    }
    return <ObjectMissing what="Priority" id={ref} loading={!feed.ready} />;
  }
  return <PriorityBody key={row._id} row={row} />;
}

function PriorityBody({ row }: { row: PriorityView }) {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(30_000);
  const days = useMemo(() => lastDays(LIST_DAYS, now), [now]);
  const todayIndex = days.indexOf(localDayKey(now));
  // Typing per day is computed on read (no table to mirror): an enrichment beside the row.
  const history = useQueryNoThrow(
    api.priorities.history,
    row.workspace ? { workspace: row.workspace, days: LIST_DAYS, tz_offset_minutes: new Date().getTimezoneOffset() } : 'skip',
    { remember: true },
  ).data as PriorityHistory | undefined;
  // Needs you exactly when the phone's own inbox files a session under Needs You.
  const model = usePriorityModel(row, history, days, 'phone');
  const linked = useMemo(() => ({ ids: linkedSessionIds([row]), prs: linkedPrRefs([row]) }), [row]);
  const lookups = usePriorityLookups(linked.ids, linked.prs);
  // The owner's active priorities in this workspace, from the list the store holds: where a move, a merge or a session can go.
  const listed = useWorkspaceCollection<PriorityRow>('priorities', prioritySig);
  const own = useCallback<OwnOf>((r) => effectivePriorityOrder(listed.filter((x) => x.mine && x.workspace === r.workspace && x.status === 'active')), [listed]);
  const menu = priorityMenuSheet(row, own).items.filter((i) => i.label !== 'Copy link');
  const pending = row.correction_pending && !model.milestones.some((m) => m.correctionPending);
  const plan = model.plan;

  return (
    <>
      <ObjectHeader type="priority" shortId={row.short_id} title={row.title} menu={menu} />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content} testID={`priority-screen-${row.short_id}`}>
        <RNText style={[objectStyles.title, styles.title]}>{row.title}</RNText>
        {(row.status !== 'active' || pending) && (
          <RNView style={styles.badges}>
            {row.status !== 'active' && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.dim}>{pastBadge(row)}</RNText>}
            {pending && <PendingMark />}
          </RNView>
        )}

        <DayStrip counts={model.counts} days={days} todayIndex={todayIndex} peak={Math.max(1, ...model.counts)} page />

        {plan && (
          <TouchableOpacity style={styles.plan} onPress={() => router.push(`/plan/${plan.short_id}` as never)} activeOpacity={0.6} accessibilityRole="link" testID="priority-plan">
            <Feather name="map" size={14} color={Theme.textDim} />
            <RNText style={styles.planTitle} numberOfLines={2}>{plan.title}</RNText>
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.dim}>{plan.done}/{plan.total}</RNText>
          </TouchableOpacity>
        )}

        <RNView style={styles.milestones}>
          <Milestones model={model} now={now} lookups={lookups} own={own} expand />
        </RNView>

        {row.corrections.length > 0 && (
          <RNView style={objectStyles.section} testID="priority-corrections">
            <SectionLabel>Corrections</SectionLabel>
            <RNView style={objectStyles.list}>
              {row.corrections.map((c) => {
                const about = c.step_key ? row.steps.find((s) => s.key === c.step_key)?.title : null;
                return (
                  <RNView key={c._id} style={styles.correction}>
                    <RNText style={styles.correctionText}>{c.text}</RNText>
                    <RNText style={styles.dim} numberOfLines={1}>
                      {c.status === 'pending' ? 'Waits for the next pass' : 'Applied'} · {shortDate(c.created_at)}{about ? ` · ${about}` : ''}
                    </RNText>
                  </RNView>
                );
              })}
            </RNView>
          </RNView>
        )}
      </ScrollView>
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10, backgroundColor: Theme.bg, padding: Spacing.xxl },
  centerText: { fontSize: 14, color: Theme.textMuted, textAlign: 'center' },
  retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, backgroundColor: Theme.bgAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight },
  retryText: { fontSize: 14, fontWeight: '500', color: Theme.accent },
  title: { marginBottom: Spacing.md },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: -6, marginBottom: Spacing.md },
  dim: { fontSize: 12, color: Theme.textMuted, fontVariant: ['tabular-nums'] },
  plan: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, marginTop: Spacing.md },
  planTitle: { flex: 1, fontSize: 14, color: Theme.text, lineHeight: 19 },
  milestones: { marginTop: Spacing.sm, marginLeft: -8 },
  correction: { gap: 2, paddingHorizontal: Spacing.md, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.bgHighlight },
  correctionText: { fontSize: 14.5, color: Theme.text, lineHeight: 20 },
}));
