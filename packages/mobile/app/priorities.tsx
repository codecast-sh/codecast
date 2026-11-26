// The phone's Priorities list, the twin of web's /priorities in its phone
// layout: one stats line (critical milestones landed in ten days, the share of
// today's messages on the top three; the chevron opens the band), the Mine and
// Hide done filters with the compact switch, what waits on the person, then
// each priority with one line per open milestone and its one trailing thing
// (the priority's action, an outlined Answer, or a state word). The compact
// view, kept per viewer in the ui prefs bag as on web, folds each priority to
// one line with its action.
// Store-fed as web is: priorities.list feeds the `priorities` collection and
// the screen reads it; typing per day is an enrichment read beside it. Every
// model is web's (lib/priorityList buildModels, waitingOf, todayOf), and every
// override is web's write (lib/priorityWrites): a milestone's box, the ⋯ of a
// priority, a milestone and a session.
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import { CODECAST_BASE_URL } from '@codecast/shared/entities';
import { asksPerson, isClosedSession } from '@codecast/shared/contracts/priorityDerive';
import { effectivePriorityOrder, type PriorityHistory, type PriorityRow, type PriorityStep } from '@codecast/shared/contracts/priorities';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useActiveWorkspaceKey } from '@codecast/web/hooks/useWorkspaceCollection';
import { linkedSessionIds, usePriorityLiveStates } from '@codecast/web/hooks/usePriorityModels';
import {
  LIST_DAYS, STATE_WORD, ago, buildModels, landedByDay, lastDays, listedRows, localDayKey, sessionWords, todayOf, waitingOf,
  type MilestoneModel, type PriorityModel, type SessionLine, type WaitingItem,
} from '@codecast/web/lib/priorityList';
import { nextPassLabel, ownerGroups, pastBadge, priorityHref } from '@codecast/web/lib/priorities';
import { usePriorityList } from '@/hooks/usePriorityList';
import { priorityWrites } from '@codecast/web/lib/priorityWrites';
import { useInboxStore, type ClientUI } from '@codecast/web/store/inboxStore';
import { ObjectMissing, objectStyles } from '@/components/objects/ObjectParts';
import { AnswerOutline, PrimaryAction, usePriorityActs } from '@/components/priorities/PriorityButtons';
import { appAlert, appPrompt, showActionSheet } from '@/lib/popups';
import { copyToClipboard } from '@/lib/clipboard';
import {
  WAITING_SHOWN, landedPerDay, lineTrail, milestoneMenu, momentumWords, moveToItems, priorityMenu, sessionMenu, sessionTargets, shownLines, statsWords,
} from '@/lib/prioritiesList';

const api = _api as any;

/** The owner's writes; a refusal puts the paint back and says the server's reason. */
const writes = priorityWrites((message) => appAlert("Couldn't save that", message));

/** The compact view rides the ui prefs bag, so it follows the viewer to every device (web reads the same key). */
type CompactPrefs = { priorities_view?: { compact?: boolean } };

type Filters = { mine: boolean; hideDone: boolean };

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
  const [filters, setFilters] = useState<Filters>({ mine: true, hideDone: true });
  const compact = useInboxStore((s) => !!(s.clientState.ui as CompactPrefs | undefined)?.priorities_view?.compact);
  const setCompact = useCallback((on: boolean) => useInboxStore.getState().updateClientUI({ priorities_view: { compact: on } } as Partial<ClientUI>), []);
  const listed = useMemo(() => listedRows(rows, filters).length, [rows, filters]);

  const header = <Stack.Screen options={{ title: rows.length ? `Priorities · ${listed}` : 'Priorities' }} />;
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
  if (rows.length === 0) {
    // Web's empty state: nothing has been found yet, and when the pass next looks.
    const next = nextPassLabel(meta.next_pass_at, now);
    return (
      <>
        {header}
        <RNView style={styles.center} testID="priorities-empty">
          <Feather name="target" size={26} color={Theme.textMuted0} />
          <RNText style={styles.centerText}>No priorities yet</RNText>
          {next ? <RNText style={styles.lineMeta}>{next}</RNText> : null}
        </RNView>
      </>
    );
  }
  return (
    <>
      {header}
      <PrioritiesView rows={rows} history={history} now={now} filters={filters} onFilters={setFilters} compact={compact} onCompact={setCompact} />
    </>
  );
}

function PrioritiesView({ rows, history, now, filters, onFilters, compact, onCompact }: {
  rows: PriorityRow[];
  history: PriorityHistory | undefined;
  now: number;
  filters: Filters;
  onFilters: (f: Filters) => void;
  compact: boolean;
  onCompact: (on: boolean) => void;
}) {
  const scoped = useMemo(() => rows.filter((r) => r.status !== 'merged' && (!filters.mine || r.mine)), [rows, filters.mine]);
  const visible = useMemo(() => listedRows(rows, filters), [rows, filters]);
  const days = useMemo(() => lastDays(LIST_DAYS, now), [now]);
  const todayIndex = days.indexOf(localDayKey(now));
  const ids = useMemo(() => linkedSessionIds(visible), [visible]);
  const live = usePriorityLiveStates(ids, now);
  const models = useMemo(() => buildModels(visible, history, live, days, now), [visible, history, live, days, now]);
  const waiting = useMemo(() => waitingOf(models), [models]);
  const landed = useMemo(() => landedByDay(scoped, days), [scoped, days]);
  const today = useMemo(() => todayOf(history, rows, now), [history, rows, now]);
  const peak = useMemo(() => Math.max(1, ...models.flatMap((m) => m.counts)), [models]);
  const byId = new Map(models.map((m) => [m.row.short_id, m]));
  // The owner's active priorities per workspace, in order: where a move or a merge can go.
  const ownOf = useCallback((row: PriorityRow) => effectivePriorityOrder(rows.filter((r) => r.mine && r.workspace === row.workspace && r.status === 'active')), [rows]);

  return (
    <ScrollView style={objectStyles.container} contentContainerStyle={styles.content} testID="priorities-screen">
      <StatsLine days={days} todayIndex={todayIndex} landed={landed} today={today} loose={history?.unassigned_today ?? []} now={now} />
      <FilterBar filters={filters} onChange={onFilters} compact={compact} onCompact={onCompact} />
      {filters.mine && <Waiting items={waiting} now={now} />}
      {ownerGroups(visible).map((g) => (
        <RNView key={g.user_id} testID={`priorities-owner-${g.mine ? 'me' : g.user_id}`}>
          {!filters.mine && <RNText style={styles.ownerHeading}>{g.mine ? 'You' : g.owner || 'Teammate'}</RNText>}
          {[...g.active, ...g.past].map((r) => {
            const m = byId.get(r.short_id);
            return m ? <PriorityBlock key={r.short_id} model={m} compact={compact} hideDone={filters.hideDone} todayIndex={todayIndex} peak={peak} now={now} own={ownOf} /> : null;
          })}
        </RNView>
      ))}
    </ScrollView>
  );
}

/** The top line: critical landed in ten days and today's share on the top three; the chevron opens the days, the shares and today's sessions outside every priority. */
function StatsLine({ days, todayIndex, landed, today, loose, now }: {
  days: string[];
  todayIndex: number;
  landed: ReturnType<typeof landedByDay>;
  today: ReturnType<typeof todayOf>;
  loose: Array<{ conversation_id: string; title: string; last_active_at: number }>;
  now: number;
}) {
  const Theme = useTheme();
  const { openSession } = usePriorityActs();
  const [open, setOpen] = useState(false);
  const words = statsWords(landed, days, today);
  const perDay = landedPerDay(landed, days);
  const peak = Math.max(1, ...perDay);
  return (
    <RNView style={styles.stats} testID="priorities-stats">
      <TouchableOpacity style={styles.statsRow} onPress={() => setOpen((o) => !o)} accessibilityRole="button" accessibilityState={{ expanded: open }} testID="priorities-stats-toggle">
        <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.statsNumber}>{words.landed}</RNText>
        <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.statsText}>landed</RNText>
        {words.today && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.statsDim}>·</RNText>}
        {words.today && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.statsText}>{words.today}</RNText>}
        <RNView style={styles.flex} />
        <Feather name={open ? 'chevron-up' : 'chevron-down'} size={16} color={Theme.textDim} />
      </TouchableOpacity>
      {open && (
        <RNView style={styles.band} testID="priorities-stats-band">
          <RNText style={styles.bandLabel}>Critical landed · 10 days</RNText>
          <RNView style={styles.bandBars}>
            {perDay.map((n, i) => (
              <RNView key={days[i]} style={styles.bandDay}>
                <RNView style={[styles.bandBar, { height: n ? Math.max(4, Math.round((n / peak) * 36)) : 2, backgroundColor: n ? Theme.green : Theme.borderLight }]} />
                <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} numberOfLines={1} style={[styles.bandDayText, i === todayIndex && { color: Theme.text, fontWeight: '600' }]}>
                  {i === todayIndex ? 'Today' : Number(days[i].slice(8))}
                </RNText>
              </RNView>
            ))}
          </RNView>
          {today.total > 0 && (
            <>
              <RNText style={styles.bandLabel}>{`Today · ${today.total} messages`}</RNText>
              <RNText style={styles.statsText}>{today.parts.map((p) => `${p.label} ${p.pct}%`).join(' · ')}</RNText>
            </>
          )}
          {loose.length > 0 && (
            <>
              <RNText style={styles.bandLabel}>No priority today</RNText>
              {loose.map((s) => (
                <TouchableOpacity key={s.conversation_id} style={styles.looseRow} onPress={() => openSession(s)} accessibilityRole="button">
                  <RNText style={[styles.lineTitle, styles.flex]} numberOfLines={1}>{s.title || 'Untitled session'}</RNText>
                  <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.lineMeta}>{ago(s.last_active_at, now)}</RNText>
                </TouchableOpacity>
              ))}
            </>
          )}
        </RNView>
      )}
    </RNView>
  );
}

function FilterBar({ filters, onChange, compact, onCompact }: { filters: Filters; onChange: (f: Filters) => void; compact: boolean; onCompact: (on: boolean) => void }) {
  const Theme = useTheme();
  const segment = (label: string, on: boolean, press: () => void, testID: string) => (
    <TouchableOpacity onPress={press} style={[styles.segment, on && styles.segmentOn]} accessibilityRole="button" accessibilityState={{ selected: on }} testID={testID}>
      {on && <Feather name="check" size={12} color={Theme.text} />}
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.segmentText, on && { color: Theme.text, fontWeight: '600' }]}>{label}</RNText>
    </TouchableOpacity>
  );
  return (
    <RNView style={styles.filters}>
      <RNView style={styles.segments}>
        {segment('Mine', filters.mine, () => onChange({ ...filters, mine: !filters.mine }), 'priorities-filter-mine')}
        {segment('Hide done', filters.hideDone, () => onChange({ ...filters, hideDone: !filters.hideDone }), 'priorities-filter-done')}
      </RNView>
      <TouchableOpacity
        onPress={() => onCompact(!compact)}
        style={[styles.compactToggle, compact && styles.segmentOn]}
        accessibilityRole="switch"
        accessibilityLabel="Compact"
        accessibilityState={{ checked: compact }}
        testID="priorities-compact"
      >
        <Feather name="list" size={16} color={compact ? Theme.text : Theme.textDim} />
      </TouchableOpacity>
    </RNView>
  );
}

/** What waits on the person: three 44px rows, the rest behind "+N more". Each opens its session. */
function Waiting({ items, now }: { items: WaitingItem[]; now: number }) {
  const Theme = useTheme();
  const { openSession } = usePriorityActs();
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, WAITING_SHOWN);
  return (
    <RNView style={styles.waiting} testID="priorities-waiting">
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.waitingLabel}>Waiting on you</RNText>
      {shown.map((w) => (
        <TouchableOpacity key={w.key} style={styles.waitingRow} onPress={() => openSession(w.session)} accessibilityRole="button" testID={`priorities-waiting-${w.session.short_id}`}>
          <RNView style={[styles.dot, { backgroundColor: Theme.yellow }]} />
          {w.rank != null && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.waitingRank}>#{w.rank}</RNText>}
          <RNText style={[styles.waitingText, styles.flex]} numberOfLines={1}>{w.label}</RNText>
          <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.lineMeta}>{ago(w.session.last_active_at, now)}</RNText>
        </TouchableOpacity>
      ))}
      {items.length > WAITING_SHOWN && (
        <TouchableOpacity style={styles.waitingRow} onPress={() => setAll((a) => !a)} accessibilityRole="button" testID="priorities-waiting-more">
          <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.waitingMore}>{all ? 'Fewer' : `+${items.length - WAITING_SHOWN} more`}</RNText>
        </TouchableOpacity>
      )}
    </RNView>
  );
}

/** Ten days of typing as small bars on the list's one scale, today outlined. */
function MiniStrip({ counts, todayIndex, peak }: { counts: number[]; todayIndex: number; peak: number }) {
  const Theme = useTheme();
  return (
    <RNView style={styles.mini} accessible={false}>
      {counts.map((c, i) => {
        const h = c <= 0 ? 1 : Math.max(2, Math.round((c / peak) * 12));
        return <RNView key={i} style={[styles.miniBar, { height: h }, i === todayIndex ? { borderWidth: 1, borderColor: Theme.green, height: Math.max(4, h) } : { backgroundColor: c > 0 ? Theme.green : Theme.borderLight }]} />;
      })}
    </RNView>
  );
}

/** A ⋯ button, 44px. */
function More({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity onPress={onPress} style={styles.more} accessibilityRole="button" accessibilityLabel={label} testID={testID}>
      <Feather name="more-horizontal" size={16} color={Theme.textDim} />
    </TouchableOpacity>
  );
}

const correctPrompt = (subject: string, save: (text: string) => void) => appPrompt('Correct', {
  message: `${subject}\nThe next pass keeps this.`,
  placeholder: 'What did it get wrong?',
  confirm: 'Save',
  accepts: (t) => t.trim().length > 0,
  onSubmit: (t) => { if (t.trim()) save(t.trim()); },
});

/** The sessions a milestone (or the whole priority) links, each once, plus the ones the rows count but do not carry. */
function linkedCount(row: Pick<PriorityRow, 'links'>, stepKey?: string): number {
  const links = (row.links ?? []).filter((l) => stepKey == null || l.key === stepKey);
  return new Set(links.flatMap((l) => l.sessions.map((s) => s.conversation_id))).size + links.reduce((n, l) => n + l.sessions_more, 0);
}

function PriorityBlock({ model, compact, hideDone, todayIndex, peak, now, own }: {
  model: PriorityModel;
  compact: boolean;
  hideDone: boolean;
  todayIndex: number;
  peak: number;
  now: number;
  own: (row: PriorityRow) => PriorityRow[];
}) {
  const Theme = useTheme();
  const router = useRouter();
  const { act } = usePriorityActs();
  const { row } = model;
  const [doneOpen, setDoneOpen] = useState(!hideDone);
  const [polishOpen, setPolishOpen] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const past = row.status !== 'active';
  const lines = shownLines(model, { done: doneOpen, polish: polishOpen });
  const polish = model.milestones.filter((m) => m.tier === 'polish');
  const { critical_done: d, critical_total: t } = row.counts;
  // A top-three priority nothing was typed into today says so ("0 today").
  const untouched = row.mine && !past && (row.rank ?? 99) <= 3 && model.today === 0;
  const pending = row.correction_pending && !model.milestones.some((m) => m.correctionPending);
  const plan = compact ? null : model.plan;
  const openPriority = () => router.push(`/priority/${row.short_id}` as never);

  const menu = () => {
    const ownRows = own(row);
    const { title, items } = priorityMenu(row, ownRows, writes, {
      open: openPriority,
      moveTo: () => showActionSheet('Move to', moveToItems(row, ownRows, writes)),
      mergeInto: () => showActionSheet('Merge into', ownRows.filter((r) => r.short_id !== row.short_id).map((into) => ({
        label: `${into.rank ?? ''} ${into.title}`.trim(),
        onPress: () => {
          const n = row.steps.length;
          const s = linkedCount(row);
          appAlert('Merge priority?', `${row.title} ends and its ${n} ${n === 1 ? 'milestone' : 'milestones'} and ${s} ${s === 1 ? 'session' : 'sessions'} move into ${into.title}. There is no undo.`, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Merge', style: 'destructive', onPress: () => writes.merge(row.short_id, into.short_id) },
          ]);
        },
      }))),
      correct: () => correctPrompt(row.title, (text) => writes.correct(row.short_id, text, null)),
      copyLink: () => { void copyToClipboard(CODECAST_BASE_URL + priorityHref(row.short_id)); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); },
    });
    showActionSheet(title, items);
  };

  const progress = past ? (
    <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.lineMeta}>{pastBadge(row)}</RNText>
  ) : t > 0 ? (
    <TouchableOpacity
      disabled={d === 0}
      onPress={() => setDoneOpen((o) => !o)}
      style={styles.progress}
      accessibilityRole="button"
      accessibilityLabel={`${d} of ${t} critical milestones done`}
      accessibilityState={{ expanded: doneOpen }}
      testID={`priorities-progress-${row.short_id}`}
    >
      <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.progressText}>{d}/{t}</RNText>
    </TouchableOpacity>
  ) : null;

  return (
    <RNView style={[styles.block, past && styles.past]} testID={`priorities-row-${row.short_id}`}>
      <RNView style={styles.head}>
        <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.rank}>{row.status === 'active' ? row.rank ?? '' : ''}</RNText>
        <TouchableOpacity style={styles.headTitle} onPress={openPriority} accessibilityRole="link" testID={`priorities-open-${row.short_id}`}>
          <RNText style={styles.title} numberOfLines={2}>{row.title}</RNText>
          {!compact && (model.today > 0 || untouched) && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.todayText}>{model.today} today</RNText>}
        </TouchableOpacity>
        {compact && (model.today > 0 || untouched) && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.todayText} accessibilityLabel={`${model.today} today`}>{model.today}</RNText>}
        {progress}
        {compact && model.stalledDays != null && <RNView accessibilityLabel={`Stalled ${model.stalledDays}d`} style={[styles.diamond, { borderColor: Theme.text }]} />}
        <MiniStrip counts={model.counts} todayIndex={todayIndex} peak={peak} />
        <More label={`More for ${row.title}`} onPress={menu} testID={`priorities-menu-${row.short_id}`} />
      </RNView>
      {/* A compact row's action sits under its title: a phone has no room beside it (web wraps it there too). */}
      {compact && model.action && (
        <RNView style={styles.compactAction}>
          <PrimaryAction action={model.action} onPress={() => act(row, model.action!)} testID={`priorities-action-${row.short_id}`} />
        </RNView>
      )}
      {(!compact || pending) && (
        <RNView style={styles.meta}>
          {polish.length > 0 && !compact && (
            <TouchableOpacity onPress={() => setPolishOpen((o) => !o)} style={styles.polish} accessibilityRole="button" accessibilityState={{ expanded: polishOpen }} testID={`priorities-polish-${row.short_id}`}>
              <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.lineMeta}>Polish {polish.filter((m) => m.done).length}/{polish.length}</RNText>
              <Feather name={polishOpen ? 'chevron-down' : 'chevron-right'} size={12} color={Theme.textDim} />
            </TouchableOpacity>
          )}
          {pending && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.pending}>correction pending</RNText>}
          <RNView style={styles.flex} />
          {!compact && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.lineMeta, model.stalledDays != null && { color: Theme.text, fontWeight: '600' }]}>{momentumWords(model)}</RNText>}
        </RNView>
      )}
      {plan && (
        <TouchableOpacity style={styles.plan} onPress={() => router.push(`/plan/${plan.short_id}` as never)} accessibilityRole="link">
          <Feather name="map" size={13} color={Theme.cyan} />
          <RNText style={[styles.lineMeta, styles.flex]} numberOfLines={1}>{plan.title}</RNText>
          <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.lineMeta}>{plan.done}/{plan.total}</RNText>
        </TouchableOpacity>
      )}
      {!compact && (
        <>
          {lines.critical.map((m) => <MilestoneLine key={m.key} model={model} m={m} open={openKey === m.key} onToggle={() => setOpenKey((k) => (k === m.key ? null : m.key))} now={now} own={own} />)}
          {lines.polish.length > 0 && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.polishLabel}>Polish</RNText>}
          {lines.polish.map((m) => <MilestoneLine key={m.key} model={model} m={m} open={openKey === m.key} onToggle={() => setOpenKey((k) => (k === m.key ? null : m.key))} now={now} own={own} />)}
        </>
      )}
    </RNView>
  );
}

function MilestoneLine({ model, m, open, onToggle, now, own }: {
  model: PriorityModel;
  m: MilestoneModel;
  open: boolean;
  onToggle: () => void;
  now: number;
  own: (row: PriorityRow) => PriorityRow[];
}) {
  const Theme = useTheme();
  const { act, openSession } = usePriorityActs();
  const { row } = model;
  const { step } = m;
  const trail = lineTrail(model, m);
  const menu = () => showActionSheet(step.title, milestoneMenu(row, step, writes, {
    rename: () => appPrompt('Rename milestone', {
      defaultValue: step.title,
      confirm: 'Rename',
      accepts: (t) => !!t.trim() && t.trim() !== step.title,
      onSubmit: (t) => { const next = t.trim(); if (next && next !== step.title) writes.renameStep(row.short_id, step.key, next); },
    }),
    drop: () => {
      const s = linkedCount(row, step.key);
      appAlert('Drop milestone?', `${step.title} leaves ${row.title}. Its ${s} linked ${s === 1 ? 'session stays' : 'sessions stay'} on the priority, and the pass never proposes it again. There is no undo.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Drop', style: 'destructive', onPress: () => writes.dropStep(row.short_id, step.key) },
      ]);
    },
    correct: () => correctPrompt(step.title, (text) => writes.correct(row.short_id, text, step.key)),
  }));

  return (
    <RNView testID={`priorities-milestone-${row.short_id}-${m.key}`}>
      {/* Each control is its own element (a pressable row would fold them into one for VoiceOver): the box, the title (which opens the line), Looks done?, the action, the ⋯. */}
      <RNView style={[styles.line, open && styles.lineOpen]}>
        {row.mine ? (
          // The owner's box is its own 44px press: Done or not, never the line's open.
          <TouchableOpacity
            onPress={() => writes.setStepDone(row.short_id, step.key, !step.done)}
            style={styles.toggle}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: step.done }}
            accessibilityLabel={step.done ? `Mark ${step.title} not done` : `Mark ${step.title} done`}
            testID={`priorities-toggle-${row.short_id}-${m.key}`}
          >
            <Feather name={step.done ? 'check-square' : 'square'} size={17} color={step.done ? Theme.green : Theme.textDim} />
          </TouchableOpacity>
        ) : (
          <RNView style={styles.toggle}>
            <Feather name={step.done ? 'check' : 'circle'} size={step.done ? 15 : 9} color={step.done ? Theme.green : Theme.textDim} accessibilityLabel={step.done ? 'Done' : 'Open'} />
          </RNView>
        )}
        <RNView style={styles.lineBody}>
          <TouchableOpacity
            onPress={onToggle}
            activeOpacity={0.6}
            style={styles.lineOpener}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityHint="Shows its sessions and tasks"
            testID={`priorities-line-${row.short_id}-${m.key}`}
          >
            <RNText style={[styles.lineTitle, step.done && styles.lineDone, m.tier === 'polish' && !step.done && { color: Theme.textMuted }]} numberOfLines={open ? undefined : 2}>{step.title}</RNText>
          </TouchableOpacity>
          {(m.looksDone || m.correctionPending) && (
            <RNView style={styles.marks}>
              {m.looksDone && (
                <TouchableOpacity disabled={!row.mine} onPress={() => writes.setStepDone(row.short_id, step.key, true)} style={styles.looksDone} accessibilityRole="button" testID={`priorities-looks-done-${m.key}`}>
                  <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.looksDoneText}>Looks done?</RNText>
                </TouchableOpacity>
              )}
              {m.correctionPending && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.pending}>correction pending</RNText>}
            </RNView>
          )}
        </RNView>
        {trail?.kind === 'action' && <PrimaryAction action={trail.action} onPress={() => act(row, trail.action)} testID={`priorities-action-${row.short_id}`} />}
        {trail?.kind === 'answer' && <AnswerOutline onPress={() => openSession(trail.session)} testID={`priorities-answer-${trail.session.short_id}`} />}
        {trail?.kind === 'state' && <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.stateWord}>{trail.word}</RNText>}
        {row.mine && <More label={`More for ${step.title}`} onPress={menu} testID={`priorities-milestone-menu-${m.key}`} />}
      </RNView>
      {open && <MilestoneDetail model={model} m={m} now={now} own={own} />}
    </RNView>
  );
}

/** An open milestone: its sessions (people's first, then workflow runs), each with the owner's ⋯, then its tasks. */
function MilestoneDetail({ model, m, now, own }: { model: PriorityModel; m: MilestoneModel; now: number; own: (row: PriorityRow) => PriorityRow[] }) {
  const Theme = useTheme();
  const router = useRouter();
  const { openSession } = usePriorityActs();
  const { row } = model;
  const sessions = [...m.sessions.filter((s) => !s.workflow), ...m.sessions.filter((s) => s.workflow)];
  const sessionActions = (s: SessionLine) => showActionSheet(sessionWords(s), sessionMenu(row, s, m.key, writes, {
    moveTo: () => {
      const targets = sessionTargets(row, own(row), m.key);
      if (targets.length === 0) return appAlert('No other milestone', 'None of your active priorities has another open milestone to move it to.');
      showActionSheet('Move to', targets.map(({ priority, step }: { priority: PriorityRow; step: PriorityStep }) => ({
        label: step.title,
        detail: priority.short_id === row.short_id ? undefined : `${priority.rank != null ? `#${priority.rank} ` : ''}${priority.title}`,
        onPress: () => writes.moveSession(s.short_id, row.short_id, priority.short_id, step.key),
      })));
    },
  }));
  // The row's open is one element and its trailing controls are siblings, so VoiceOver reaches each.
  const row_ = (key: string, body: ReactNode, onPress: () => void, trailing?: ReactNode) => (
    <RNView key={key} style={styles.detailRow}>
      <TouchableOpacity style={styles.detailOpen} onPress={onPress} activeOpacity={0.6} accessibilityRole="link">{body}</TouchableOpacity>
      {trailing}
    </RNView>
  );
  return (
    <RNView style={styles.detail} testID={`priorities-detail-${m.key}`}>
      {sessions.map((s) => row_(
        s.conversation_id,
        <>
          <Feather name={s.workflow ? 'git-merge' : 'message-square'} size={13} color={Theme.blue} />
          <RNText style={[styles.lineTitle, styles.flex]} numberOfLines={2}>{sessionWords(s)}</RNText>
          {!asksPerson(s) && (
            <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={styles.lineMeta}>
              {isClosedSession(s) ? 'Closed' : STATE_WORD[s.state]} · {ago(s.last_active_at, now)}
            </RNText>
          )}
        </>,
        () => openSession(s),
        <>
          {/* A session that asks wears an outlined Answer, as web's SessionRow; the rest say their state. */}
          {asksPerson(s) && <AnswerOutline onPress={() => openSession(s)} testID={`priorities-detail-answer-${s.short_id}`} />}
          {row.mine && s.mine && <More label={`Fix the link to ${sessionWords(s)}`} onPress={() => sessionActions(s)} testID={`priorities-session-menu-${s.short_id}`} />}
        </>,
      ))}
      {m.more > 0 && row_('more', <RNText style={styles.lineMeta}>+{m.more} older {m.more === 1 ? 'session' : 'sessions'}</RNText>, () => router.push(`/priority/${row.short_id}` as never))}
      {m.tasks.map((id) => row_(id, (
        <>
          <Feather name="check-circle" size={13} color={Theme.textMuted} />
          <RNText style={[styles.lineTitle, styles.flex]} numberOfLines={1}>{id}</RNText>
        </>
      ), () => router.push(`/task/${id}` as never)))}
      {sessions.length === 0 && m.tasks.length === 0 && <RNText style={[styles.lineMeta, styles.nothing]}>Nothing linked yet</RNText>}
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: 48 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 10, backgroundColor: Theme.bg, padding: Spacing.xxl },
  centerText: { fontSize: 14, color: Theme.textMuted, textAlign: 'center' },
  control: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 8, backgroundColor: Theme.bgAlt, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight },
  controlText: { fontSize: 14, fontWeight: '500', color: Theme.accent },

  stats: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.borderLight, marginBottom: Spacing.sm },
  statsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  statsNumber: { fontSize: 17, fontWeight: '700', color: Theme.text, fontVariant: ['tabular-nums'] },
  statsText: { fontSize: 13.5, color: Theme.text, fontVariant: ['tabular-nums'] },
  statsDim: { fontSize: 13.5, color: Theme.textDim },
  band: { gap: 6, paddingBottom: Spacing.md },
  bandLabel: { marginTop: 6, fontSize: 11, fontWeight: '600', color: Theme.textMuted0, textTransform: 'uppercase', letterSpacing: 0.5 },
  bandBars: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  bandDay: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 3, height: 54 },
  bandBar: { alignSelf: 'stretch', borderRadius: 2 },
  // Wider than its column, centred on it, so "Today" stays on one line.
  bandDayText: { width: 44, textAlign: 'center', fontSize: 10, color: Theme.textDim, fontVariant: ['tabular-nums'] },
  looseRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },

  filters: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: Spacing.md },
  segments: { flexDirection: 'row', gap: 2, padding: 2, borderRadius: 8, backgroundColor: Theme.bgAlt },
  segment: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, paddingHorizontal: 12, borderRadius: 6 },
  segmentOn: { backgroundColor: Theme.card },
  segmentText: { fontSize: 13, color: Theme.textMuted },
  compactToggle: { marginLeft: 'auto', width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },

  waiting: { marginBottom: Spacing.md, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 2, borderRadius: 10, borderWidth: 1, borderColor: Theme.yellow + '73', backgroundColor: Theme.yellow + '10' },
  waitingLabel: { paddingHorizontal: 4, fontSize: 11, fontWeight: '600', color: Theme.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingHorizontal: 4 },
  waitingRank: { fontSize: 13.5, fontWeight: '700', color: Theme.text, fontVariant: ['tabular-nums'] },
  waitingText: { fontSize: 13.5, color: Theme.text },
  waitingMore: { fontSize: 13, fontWeight: '500', color: Theme.textMuted },
  dot: { width: 7, height: 7, borderRadius: 4 },

  ownerHeading: { marginTop: Spacing.md, paddingBottom: 6, fontSize: 14, fontWeight: '600', color: Theme.text, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.borderLight },
  block: { paddingTop: 8, paddingBottom: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.borderLight },
  past: { opacity: 0.7 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  rank: { width: 18, textAlign: 'right', fontSize: 13.5, fontWeight: '600', color: Theme.textDim, fontVariant: ['tabular-nums'] },
  headTitle: { flex: 1, minWidth: 96, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, minHeight: 44, paddingVertical: 4 },
  compactAction: { alignItems: 'flex-end', paddingBottom: 2 },
  title: { flexShrink: 1, fontSize: 14.5, fontWeight: '700', color: Theme.text, lineHeight: 20 },
  todayText: { fontSize: 12, color: Theme.textDim, fontVariant: ['tabular-nums'] },
  progress: { minHeight: 44, minWidth: 36, alignItems: 'center', justifyContent: 'center' },
  progressText: { fontSize: 12.5, color: Theme.textMuted, fontVariant: ['tabular-nums'] },
  diamond: { width: 6, height: 6, borderWidth: 1, transform: [{ rotate: '45deg' }] },
  mini: { flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, height: 14, width: 30 },
  miniBar: { flex: 1, borderRadius: 1 },
  more: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -10 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 24, paddingLeft: 26 },
  polish: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 44, marginVertical: -10 },
  pending: { fontSize: 11.5, color: Theme.textDim },
  plan: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingLeft: 26 },
  polishLabel: { marginTop: 4, paddingLeft: 26, fontSize: 10.5, fontWeight: '600', color: Theme.textDim, textTransform: 'uppercase', letterSpacing: 0.5 },

  line: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingVertical: 2, borderRadius: 6 },
  lineOpen: { backgroundColor: Theme.bgAlt },
  toggle: { width: 44, height: 44, marginLeft: 4, marginRight: -8, alignItems: 'center', justifyContent: 'center' },
  lineBody: { flex: 1, minWidth: 96 },
  lineOpener: { minHeight: 44, justifyContent: 'center', paddingVertical: 4 },
  lineTitle: { fontSize: 13.5, color: Theme.text, lineHeight: 19 },
  lineDone: { color: Theme.textDim, textDecorationLine: 'line-through' },
  lineMeta: { fontSize: 12, color: Theme.textMuted, fontVariant: ['tabular-nums'] },
  stateWord: { fontSize: 12, color: Theme.textDim },
  marks: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  looksDone: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  looksDoneText: { fontSize: 11.5, color: Theme.textMuted, borderWidth: 1, borderColor: Theme.borderLight, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden' },

  detail: { marginLeft: 30, marginBottom: 6, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: Theme.borderLight },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  detailOpen: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  nothing: { paddingVertical: 10 },
}));
