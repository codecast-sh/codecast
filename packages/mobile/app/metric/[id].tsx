// One watched metric (mw-N), the phone twin of the web's /ops/metrics/<mw-N>,
// opened by a metric alert notification and a source's watch rows. Its value
// and health, the change and the line, the chart over a picked range with the
// line and the announced episodes, Mute, the issue's one fix action (open or
// start the fix session, reopen a dropped task, resolve a fix that held), the
// transitions, the fix as steps, and the settings that change the alert (side,
// line, warn, reads in a row, missing data, interval, name, unit, pause,
// delete). Every write is the web's store action (updateOpsWatch,
// setOpsGroupStatus, startOpsFixSession), so the screen moves at once.
//
// A watch from another workspace (an alert link) reads through metrics.getWatch
// and shows read only: its actions need the row in this workspace's store.
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { api } from '@codecast/convex/convex/_generated/api';
import { MONITOR_LIMITS } from '@codecast/shared/contracts/metricMonitor';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, Spacing, themedStyles, useTheme, type Palette } from '@/constants/Theme';
import { appAlert, appPrompt, showActionSheet } from '@/lib/popups';
import { WEB_ORIGIN } from '@/lib/links';
import { ActionButton, FactChip, FactRow, Facts, ObjectHeader, ObjectMissing, SectionLabel, objectStyles } from '@/components/objects/ObjectParts';
import { Vital, ago, opsStyles } from '@/components/ops/OpsRows';
import { MetricChart } from '@/components/ops/MetricChart';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { useOpsGroup, useOpsSources, useOpsWatches, useSyncOpsGroup, useSyncOpsGroupTransitions, useSyncOpsSources, useSyncOpsWatches } from '@codecast/web/hooks/useSyncOps';
import { useWatchSeriesLive } from '@codecast/web/hooks/useSyncOpsMetrics';
import { HEALTH_LOOK, KIND_LABEL, METRIC_RANGES, durationShort, formatMeasure, formatPct, formatValue, isMutedAt, measuresCount, rangeWindow, spanLabel, stampLabel, watchHealth, windowName, type Health, type MetricRange } from '@codecast/web/components/ops/metricModel';
import { CARD_BUCKETS, DETAIL_BUCKETS, changeRange, changeSpan, changeTone, chartPoints, rangeChange, type SeriesSpec } from '@codecast/web/components/ops/metricSeries';
import { stats } from '@codecast/web/components/ops/metricStats';
import { episodeSummary, transitionRows, watchErrorText, type TransitionRow } from '@codecast/web/components/ops/metricEvents';
import { EVAL_READS, INTERVALS, NO_DATA_AFTER, allWindow, intervalLabel, parseThreshold } from '@codecast/web/components/ops/metricEditing';
import { useWatchEpisodes } from '@codecast/web/components/ops/useWatchEpisodes';
import { useIssueFix } from '@codecast/web/components/ops/useIssueFix';
import { useReadNow } from '@codecast/web/components/ops/useReadNow';
import { fixActionLabel, fixClose, fixStage, regressedAt, taskMatchesIssue } from '@codecast/web/components/ops/issuesModel';
import { knownRelease } from '@codecast/web/components/ops/issueQuery';
import { fixFolderChoices, startOpsFixSession } from '@codecast/web/components/ops/startFix';
import { folderName } from '@codecast/web/components/ops/issueFix';
import { opsHref } from '@codecast/web/components/ops/opsPaths';
import type { OpsGroup, OpsSource, OpsWatch } from '@codecast/web/components/ops/opsTypes';

const MUTES = [
  { label: '1 hour', ms: 3600_000 },
  { label: '4 hours', ms: 4 * 3600_000 },
  { label: '1 day', ms: 24 * 3600_000 },
  { label: '7 days', ms: 7 * 24 * 3600_000 },
].filter((m) => m.ms <= MONITOR_LIMITS.mute_max_ms);

const healthColor = (h: Health, t: Palette) =>
  h === 'alert' ? t.red : h === 'error' ? t.orange : h === 'retrying' || h === 'warn' ? t.yellow : h === 'ok' ? t.green : h === 'series' ? t.blue : t.textMuted0;

export default function MetricScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const ref = rawId?.trim() || null;
  const feed = useSyncOpsWatches();
  useSyncOpsSources();
  const watches = useOpsWatches();
  const watch = ref ? watches.find((w) => w.short_id === ref.toLowerCase() || w._id === ref) : undefined;
  // A watch this workspace's list lacks: the one-watch read answers for any workspace the person can read.
  const one = useQueryNoThrow(api.metrics.getWatch, ref && !watch && feed.ready ? { watch: ref } : 'skip');
  const elsewhere = (one.data as { watch?: OpsWatch } | undefined)?.watch;
  if (watch) return <WatchBody watch={watch} />;
  if (elsewhere) return <WatchBody watch={elsewhere} readOnly />;
  return <ObjectMissing what="Metric" id={ref ?? undefined} loading={(!feed.ready && !feed.error) || (!!ref && feed.ready && !one.data && !one.error)} />;
}

function WatchBody({ watch, readOnly = false }: { watch: OpsWatch; readOnly?: boolean }) {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(30_000);
  const { width } = useWindowDimensions();
  const sources = useOpsSources();
  const source = sources.find((s) => s._id === watch.source_id);
  useSyncOpsGroup(watch.group_id ?? null);
  const group = useOpsGroup(watch.group_id ?? null);
  useSyncOpsGroupTransitions(group?.short_id ?? null, 90);
  const [range, setRange] = useState<MetricRange>('7d');

  const rangeSpec = useMemo<SeriesSpec>(() => ({ kind: 'range', range }), [range]);
  const { series, live } = useWatchSeriesLive(watch._id, rangeSpec, DETAIL_BUCKETS);
  const cRange = changeRange(range);
  const curSpec = useMemo<SeriesSpec>(() => ({ kind: 'range', range: cRange }), [cRange]);
  const prevSpec = useMemo<SeriesSpec>(() => ({ kind: 'prev', range: cRange }), [cRange]);
  const changeCur = useWatchSeriesLive(watch._id, curSpec, CARD_BUCKETS);
  const changePrev = useWatchSeriesLive(watch._id, prevSpec, CARD_BUCKETS);

  const points = useMemo(() => chartPoints(series, watch.points), [series, watch.points]);
  const step = Math.max(watch.interval_ms, series?.step_ms ?? 0);
  const { announced, episodes, since } = useWatchEpisodes(watch, group);
  const all = range === 'all' && series
    ? allWindow({ heldFrom: series.held_from ?? null, firstAnnounced: announced[0]?.at ?? null, firstSeen: group?.first_seen ?? null, points, now, step })
    : null;
  const win = all?.win ?? rangeWindow(range, points, now);
  const visible = points.filter((p) => p.at >= win.from && p.at <= win.to);
  const st = series ? stats(visible) : null;
  const integral = measuresCount(watch.points, visible);
  const fmt = (v: number) => formatMeasure(v, watch.unit, integral);
  const change = rangeChange(changeCur.series, changePrev.series, watch.points, range, now);
  const named = windowName(win, range === 'all');
  const inWin = episodeSummary(episodes, win, now);
  const health = watchHealth(watch);
  const color = healthColor(health, Theme);
  const muted = isMutedAt(watch, now);
  const paused = watch.status === 'paused';
  const hasLine = watch.threshold !== undefined;
  const error = watchErrorText(watch);
  const ref = watch.short_id || watch._id;
  const episodeBands = useMemo(() => episodes.map((e) => ({ from: e.from, to: e.to ?? now })), [episodes, now]);
  const transitions = useMemo(() => transitionRows(announced, [], 0), [announced]);

  const update = (patch: Parameters<ReturnType<typeof useInboxStore.getState>['updateOpsWatch']>[1]) => useInboxStore.getState().updateOpsWatch(watch._id, patch);
  const changeText = change ? (change.pct === null ? `${change.change >= 0 ? '+' : '-'}${fmt(Math.abs(change.change))}` : formatPct(change.pct)) : '–';
  const changeColor = change ? ((t) => (t === 'bad' ? Theme.red : t === 'good' ? Theme.green : undefined))(changeTone(watch, change.change)) : undefined;
  const lineText = hasLine ? `${watch.direction === 'above' ? '>' : '<'} ${formatValue(watch.threshold!, watch.unit)}` : 'none';

  const mute = () => showActionSheet('Hold alerts for', MUTES.map((m) => ({ label: m.label, icon: 'bell-off', onPress: () => update({ muted_until: Date.now() + m.ms }) })));

  return (
    <>
      <ObjectHeader type={null} shortId={watch.short_id} title={watch.name} link={`${WEB_ORIGIN}${opsHref.metric(ref)}`} />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content}>
        <RNText style={objectStyles.title} selectable>{watch.name}</RNText>
        <RNView style={objectStyles.chips}>
          <FactChip icon="circle" label={muted ? `${HEALTH_LOOK[health].label} · muted` : HEALTH_LOOK[health].label} color={color} testID="metric-health" />
          {source ? <FactChip icon="plug" label={source.name} color={Theme.cyan} link onPress={() => router.push(`/source/${source.short_id || source._id}` as never)} /> : null}
          <FactChip label={`${KIND_LABEL[watch.query_kind] ?? watch.query_kind} · every ${intervalLabel(watch.interval_ms)}`} color={Theme.textMuted} />
          {group ? <FactChip icon="bug" label={group.short_id} color={Theme.textMuted} link onPress={() => router.push(`/issue/${group.short_id}` as never)} /> : null}
          {readOnly ? <FactChip icon="lock" label="other workspace" color={Theme.textMuted0} /> : null}
        </RNView>

        {error && !paused ? <ReadError watch={watch} error={error} now={now} readOnly={readOnly} /> : null}

        {!readOnly && (
          <RNView style={objectStyles.verbs}>
            {group ? <FixAction group={group} source={source} now={now} /> : null}
            {hasLine && (muted
              ? <ActionButton icon="bell" label={`Unmute · ${stampLabel(watch.muted_until!)}`} color={Theme.orange} onPress={() => update({ muted_until: null })} testID="metric-unmute" />
              : <ActionButton icon="bell-slash" label="Mute" color={Theme.textMuted} onPress={mute} testID="metric-mute" />)}
            {paused
              ? <ActionButton icon="play" label="Resume" color={Theme.green} onPress={() => update({ status: 'active' })} testID="metric-resume" />
              : <ActionButton icon="pause" label="Pause" color={Theme.textMuted} onPress={() => update({ status: 'paused' })} testID="metric-pause" />}
          </RNView>
        )}

        <RNView style={opsStyles.vitals}>
          <Vital label="Now" value={watch.last_value === null ? '–' : formatValue(watch.last_value, watch.unit)} color={health === 'alert' ? Theme.red : undefined} sub={watch.last_at ? `read ${ago(watch.last_at, now)}` : 'never read'} />
          <Vital label={`Last ${spanLabel(changeSpan(range))} vs prior`} value={changeText} color={changeColor} sub={change ? `${fmt(change.now)} vs ${fmt(change.base)}` : null} />
          <Vital label="Line" value={lineText} color={hasLine ? Theme.red : undefined} sub={watch.warn !== undefined ? `warn ${formatValue(watch.warn, watch.unit)}` : null} subColor={Theme.yellow} />
          {since !== null
            ? <Vital label="This episode" value={durationShort(now - since)} color={Theme.red} sub={`since ${stampLabel(since)}`} />
            : <Vital label={`Episodes ${named.short}`} value={hasLine ? (inWin.count ? String(inWin.count) : 'none') : '–'} color={inWin.count ? Theme.red : undefined} sub={inWin.count ? `${durationShort(inWin.total)} alerting` : null} />}
        </RNView>

        <RNView style={objectStyles.section}>
          <RNView style={styles.ranges}>
            {METRIC_RANGES.map((r) => {
              const on = r.key === range;
              return (
                <TouchableOpacity key={r.key} onPress={() => setRange(r.key)} style={[styles.range, on && { backgroundColor: Theme.text }]} activeOpacity={0.7} testID={`metric-range-${r.key}`}>
                  <RNText maxFontSizeMultiplier={CHROME_FONT_CAP} style={[styles.rangeText, on && { color: Theme.bg }]}>{r.label}</RNText>
                </TouchableOpacity>
              );
            })}
            <RNView style={{ flex: 1 }} />
            {!readOnly && watch.query_kind !== 'insight' ? (
              <TouchableOpacity onPress={() => useInboxStore.getState().loadOpsWatchHistory(watch._id)} disabled={!!watch.history?.reading} hitSlop={6} testID="metric-history">
                <FontAwesome name="history" size={15} color={watch.history?.reading ? Theme.textMuted0 : Theme.textMuted} />
              </TouchableOpacity>
            ) : null}
          </RNView>
          <RNView style={[opsStyles.card, styles.chartCard]}>
            <MetricChart
              points={points}
              win={win}
              step_ms={step}
              threshold={watch.threshold}
              warn={watch.warn}
              direction={watch.direction}
              unit={watch.unit}
              episodes={hasLine ? episodeBands : undefined}
              loading={!live && !series}
              width={width - Spacing.lg * 2 - 2}
              height={220}
              testID="metric-chart"
            />
          </RNView>
          <RNView style={styles.statRow}>
            <RNText style={styles.dim} maxFontSizeMultiplier={CHROME_FONT_CAP}>{`${visible.length} values ${named.within}`}</RNText>
            <RNText style={styles.dim} maxFontSizeMultiplier={CHROME_FONT_CAP}>{st ? `${st.min === st.max ? fmt(st.min) : `${fmt(st.min)} – ${fmt(st.max)}`} · mean ${fmt(st.avg)}` : ''}</RNText>
          </RNView>
        </RNView>

        {hasLine && <TransitionsSection watch={watch} rows={transitions} now={now} />}

        {group ? <FixSteps group={group} episodes={episodes} now={now} /> : null}

        {!readOnly && <Settings watch={watch} hasLine={hasLine} paused={paused} />}
      </ScrollView>
    </>
  );
}

/** A read that failed: the error, how many in a row, and Read now. */
function ReadError({ watch, error, now, readOnly }: { watch: OpsWatch; error: string; now: number; readOnly: boolean }) {
  const Theme = useTheme();
  const { asking, readNow } = useReadNow([watch]);
  return (
    <RNView style={[styles.banner, { borderColor: Theme.orange + '44', borderLeftColor: Theme.orange, backgroundColor: Theme.orange + '10' }]} testID="metric-error">
      <RNText style={[styles.bannerTitle, { color: Theme.orange }]}>
        {`${watch.missed && watch.missed > 1 ? `${watch.missed} reads failed` : 'Last read failed'} · ${watch.last_at ? `last value ${ago(watch.last_at, now)}` : 'never read'}`}
      </RNText>
      <RNText style={styles.bannerBody} numberOfLines={5} selectable>{error}</RNText>
      {!readOnly && (
        <RNView style={{ marginTop: 8, flexDirection: 'row' }}>
          <ActionButton icon="refresh" label={asking ? 'Reading…' : 'Read now'} color={Theme.orange} onPress={() => { if (!asking) readNow(); }} testID="metric-read-now" />
        </RNView>
      )}
    </RNView>
  );
}

/**
 * The issue's one fix action, the web's FixAction read the same way
 * (useIssueFix → fixPlan): open or continue the running fix session, start
 * one (or a follow-up when a closed fix did not hold), reopen a dropped task
 * and fix, or resolve an issue whose fix held. Starting a session asks first.
 */
function FixAction({ group, source, now }: { group: OpsGroup; source?: OpsSource; now: number }) {
  const Theme = useTheme();
  const router = useRouter();
  const taskStatus = useInboxStore((s) => (group.signal_task_id ? (s.tasks as Record<string, { status?: string }>)[group.signal_task_id]?.status : undefined));
  const stage = fixStage(group, taskStatus);
  const { task, plan } = useIssueFix(group, stage, now);
  const folder = useInboxStore((s) => {
    const c = fixFolderChoices(s as any, group.source_id);
    return c.paths[0] ? folderName(c.paths[0]) ?? c.paths[0] : null;
  });
  const primary = group.status === 'ignored' ? null : plan.primary;
  if (!primary) return null;
  const mismatch = !!task?.title && !taskMatchesIssue(task.title, group.title);
  const label = fixActionLabel(primary, task?.short_id, mismatch) ?? 'Start fix';
  const start = () => {
    const reopen = primary === 'refile' && task?.short_id && !mismatch ? task.short_id : null;
    const lines = [folder ? `Folder: ${folder}` : null, task?.short_id && !mismatch ? `Task: ${task.short_id}${reopen ? ' (reopens)' : ''}` : null].filter(Boolean).join('\n');
    appAlert(primary === 'followup' ? 'Start a follow-up fix?' : 'Start a fix session?', `${group.title}${lines ? `\n\n${lines}` : ''}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Start',
        onPress: () => {
          if (reopen) void useInboxStore.getState().updateTask(reopen, { status: 'open' });
          const { stubId } = startOpsFixSession(
            { groupRefs: [group.short_id || group._id], title: group.title, culprit: group.culprit, release: knownRelease(group.last_release) },
            group.source_id ?? source?._id,
            { taskId: group.signal_task_id && !mismatch ? group.signal_task_id : null, groupIds: [group._id] },
          );
          router.push(`/session/${stubId}` as never);
        },
      },
    ]);
  };
  const press = () => {
    if ((primary === 'open' || primary === 'continue') && plan.live) router.push(`/session/${plan.live}` as never);
    else if (primary === 'resolve') {
      appAlert('Resolve this issue?', `${group.title}\n\nA later alert reopens it.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Resolve', onPress: () => useInboxStore.getState().setOpsGroupStatus(group._id, 'resolved') },
      ]);
    } else start();
  };
  const icon = primary === 'resolve' ? 'check' : primary === 'refile' ? 'undo' : primary === 'open' || primary === 'continue' ? 'comment-o' : 'magic';
  return <ActionButton icon={icon} label={label} color={primary === 'resolve' ? Theme.green : Theme.accent} filled onPress={press} testID={`metric-fix-${primary}`} />;
}

/** The announced crossings and recoveries, newest first, each crossing with how long it ran. */
function TransitionsSection({ watch, rows, now }: { watch: OpsWatch; rows: TransitionRow[]; now: number }) {
  const Theme = useTheme();
  const [all, setAll] = useState(false);
  const newest = useMemo(() => [...rows].reverse(), [rows]);
  const shown = all ? newest : newest.slice(0, 8);
  const until = (r: TransitionRow) => {
    const i = rows.indexOf(r);
    return rows.slice(i + 1).find((x) => x.kind === 'recovered')?.at ?? null;
  };
  return (
    <RNView style={objectStyles.section}>
      <SectionLabel>{`Transitions · ${rows.length}`}</SectionLabel>
      <RNView style={opsStyles.card} testID="metric-transitions">
        {shown.length === 0 ? <RNText style={opsStyles.empty}>Never past the line</RNText> : shown.map((r, i) => {
          const crossed = r.kind === 'crossed';
          const end = crossed ? until(r) : null;
          const dur = crossed ? (end ? `for ${durationShort(end - r.at)}` : watch.state === 'alert' ? `ongoing, ${durationShort(now - r.at)}` : '') : '';
          return (
            <RNView key={`${r.at}-${r.kind}`} style={[styles.row, i > 0 && styles.rule]}>
              <FontAwesome name={crossed ? 'arrow-up' : 'arrow-down'} size={11} color={crossed ? Theme.red : Theme.green} style={{ width: 14, textAlign: 'center' }} />
              <RNText style={[styles.rowKind, { color: crossed ? Theme.red : Theme.green }]}>{crossed ? 'crossed' : 'recovered'}</RNText>
              <RNText style={styles.rowValue}>{r.value === null ? '' : formatValue(r.value, watch.unit)}</RNText>
              <RNView style={{ flex: 1 }} />
              <RNText style={styles.dim} numberOfLines={1}>{dur ? `${stampLabel(r.at)} · ${dur}` : stampLabel(r.at)}</RNText>
            </RNView>
          );
        })}
      </RNView>
      {newest.length > 8 ? (
        <TouchableOpacity onPress={() => setAll((v) => !v)} style={styles.more}>
          <RNText style={styles.moreText} maxFontSizeMultiplier={CHROME_FONT_CAP}>{all ? 'Show fewer' : `${newest.length - 8} more`}</RNText>
        </TouchableOpacity>
      ) : null}
    </RNView>
  );
}

/** The issue and its fix as steps (the web's FixPanel): filed, session, shipped or closed, then resolved or recurred. Each step that happened opens its object. */
function FixSteps({ group, episodes, now }: { group: OpsGroup; episodes: { from: number; to: number | null }[]; now: number }) {
  const Theme = useTheme();
  const router = useRouter();
  const taskStatus = useInboxStore((s) => (group.signal_task_id ? (s.tasks as Record<string, { status?: string }>)[group.signal_task_id]?.status : undefined));
  const stage = fixStage(group, taskStatus);
  const { task, sessions, plan } = useIssueFix(group, stage, now);
  const session = plan.live ?? group.fix_conversation_id ?? sessions[0]?.id ?? null;
  const close = fixClose(group, task ?? undefined);
  const recurred = stage === 'recurring' ? regressedAt(group) ?? group.last_transition_at ?? group.last_seen : null;
  const sum = episodeSummary(episodes, { from: 0, to: now }, now);
  const taskRef = task?.short_id ?? group.signal_task_id;
  const openTask = taskRef ? () => router.push(`/task/${taskRef}` as never) : undefined;
  type Step = { key: string; label: string; state: 'done' | 'now' | 'todo' | 'bad'; value: string; onPress?: () => void };
  const steps: Step[] = [
    { key: 'filed', label: 'Filed', state: group.signal_task_id ? 'done' : 'todo', value: group.signal_task_id ? `${task?.short_id ?? 'task'}${task?.status ? ` · ${task.status.replace('_', ' ')}` : ''}` : '–', onPress: openTask },
    { key: 'session', label: 'Session', state: session ? (plan.live && !close ? 'now' : 'done') : 'todo', value: session ? `${plan.live ? 'running' : 'opened'}${group.fix_started_at ? ` · ${ago(group.fix_started_at, now)}` : ''}` : '–', onPress: session ? () => router.push(`/session/${session}` as never) : undefined },
    task?.landed
      ? { key: 'shipped', label: 'Shipped', state: 'done', value: `${task.landed.sha.slice(0, 7)} · ${ago(task.landed.at, now)}`, onPress: openTask }
      : close && close.how !== 'dissolved' && close.how !== 'dropped'
        ? { key: 'shipped', label: close.how === 'resolved' ? 'Resolved' : 'Closed', state: 'done', value: close.at ? ago(close.at, now) : 'yes', onPress: openTask }
        : { key: 'shipped', label: 'Shipped', state: 'todo', value: '–' },
    recurred !== null
      ? { key: 'recurred', label: 'Recurred', state: 'bad', value: ago(recurred, now) }
      : { key: 'resolved', label: 'Resolved', state: group.status === 'resolved' ? 'done' : 'todo', value: group.status === 'resolved' ? (group.resolved_in ? `in ${group.resolved_in}` : group.resolved_at ? ago(group.resolved_at, now) : 'yes') : '–' },
  ];
  const tone = (s: Step['state']) => (s === 'done' ? Theme.green : s === 'now' ? Theme.blue : s === 'bad' ? Theme.red : Theme.textMuted0);
  return (
    <RNView style={objectStyles.section}>
      <SectionLabel right={<RNText style={styles.dim} maxFontSizeMultiplier={CHROME_FONT_CAP}>{sum.count ? `${sum.count} ${sum.count === 1 ? 'episode' : 'episodes'} · ${durationShort(sum.total)}` : 'no episodes'}</RNText>}>
        {`Issue · ${group.status}`}
      </SectionLabel>
      <Facts testID="metric-fix-steps">
        {steps.map((s) => (
          <FactRow key={s.key} label={s.label} icon={s.state === 'done' ? 'check-circle' : s.state === 'bad' ? 'exclamation-triangle' : s.state === 'now' ? 'dot-circle-o' : 'circle-o'} tone={tone(s.state)} onPress={s.onPress}>
            {s.value}
          </FactRow>
        ))}
      </Facts>
    </RNView>
  );
}

/** Everything that changes the alert and the watch, each row opening its picker or field. */
function Settings({ watch, hasLine, paused }: { watch: OpsWatch; hasLine: boolean; paused: boolean }) {
  const Theme = useTheme();
  const router = useRouter();
  const update = (patch: Parameters<ReturnType<typeof useInboxStore.getState>['updateOpsWatch']>[1]) => useInboxStore.getState().updateOpsWatch(watch._id, patch);
  const numberField = (title: string, current: number | undefined, onValue: (n: number | null) => void) =>
    appPrompt(title, {
      placeholder: 'none',
      defaultValue: current === undefined ? '' : String(current),
      confirm: 'Save',
      accepts: (t) => parseThreshold(t) !== null,
      onSubmit: (t) => {
        const n = parseThreshold(t);
        if (n !== null) onValue(n ?? null);
      },
    });
  const reads = watch.eval_reads ?? 1;
  const remove = () => appAlert(`Delete ${watch.name}?`, 'Its issue and past alerts stay.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { useInboxStore.getState().removeOpsWatch(watch._id); router.back(); } },
  ]);
  return (
    <>
      <RNView style={objectStyles.section}>
        <SectionLabel>Alert when</SectionLabel>
        <Facts testID="metric-alert-rule">
          <FactRow label="Side" onPress={() => showActionSheet('Alert when the value is', (['above', 'below'] as const).map((d) => ({ label: d, selected: watch.direction === d, onPress: () => update({ direction: d }) })))}>
            {watch.direction}
          </FactRow>
          <FactRow label="Line" tone={hasLine ? Theme.red : undefined} onPress={() => numberField('Alert line', watch.threshold, (n) => update({ threshold: n }))} testID="metric-edit-line">
            {hasLine ? formatValue(watch.threshold!, watch.unit) : 'none'}
          </FactRow>
          {hasLine && (
            <FactRow label="Warn" tone={watch.warn !== undefined ? Theme.yellow : undefined} onPress={() => numberField('Warning level', watch.warn, (n) => update({ warn: n }))}>
              {watch.warn !== undefined ? formatValue(watch.warn, watch.unit) : 'none'}
            </FactRow>
          )}
          {hasLine && (
            <FactRow label="After" onPress={() => showActionSheet('Alert after', EVAL_READS.map((n) => ({ label: n === 1 ? '1 read' : `${n} reads in a row`, selected: reads === n, onPress: () => update({ eval_reads: n }) })))}>
              {`${reads === 1 ? '1 read' : `${reads} reads in a row`} · ${spanLabel(reads * watch.interval_ms)}`}
            </FactRow>
          )}
          {hasLine && (
            <FactRow label="No data" onPress={() => showActionSheet('When reads go missing', [
              { label: 'Ignore', selected: !watch.no_data_after, onPress: () => update({ no_data_after: null }) },
              ...NO_DATA_AFTER.map((n) => ({ label: `Alert after ${n} missed`, selected: watch.no_data_after === n, onPress: () => update({ no_data_after: n }) })),
            ])}>
              {watch.no_data_after ? `alert after ${watch.no_data_after} missed` : 'ignore'}
            </FactRow>
          )}
        </Facts>
      </RNView>

      <RNView style={objectStyles.section}>
        <SectionLabel>Settings</SectionLabel>
        <Facts testID="metric-settings">
          <FactRow label="Name" onPress={() => appPrompt('Name', { defaultValue: watch.name, confirm: 'Save', accepts: (t) => !!t.trim(), onSubmit: (t) => update({ name: t }) })}>{watch.name}</FactRow>
          <FactRow label="Unit" onPress={() => appPrompt('Unit', { defaultValue: watch.unit ?? '', placeholder: 'none', confirm: 'Save', accepts: () => true, onSubmit: (t) => update({ unit: t.trim() || null }) })}>{watch.unit || 'none'}</FactRow>
          <FactRow label="Every" onPress={() => showActionSheet('Read every', INTERVALS.map((i) => ({ label: i.label, selected: watch.interval_ms === i.ms, onPress: () => update({ interval_ms: i.ms }) })))}>
            {`${intervalLabel(watch.interval_ms)}${paused ? ' · paused' : ''}`}
          </FactRow>
          <FactRow label="Query">{`${KIND_LABEL[watch.query_kind] ?? watch.query_kind} · ${watch.query.length > 60 ? `${watch.query.slice(0, 60)}…` : watch.query}`}</FactRow>
        </Facts>
        <RNView style={[objectStyles.verbs, { marginTop: Spacing.md }]}>
          <ActionButton icon="trash-o" label="Delete watch" color={Theme.red} onPress={remove} testID="metric-delete" />
        </RNView>
      </RNView>
    </>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  banner: { marginBottom: Spacing.lg, borderWidth: 1, borderLeftWidth: 3, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  bannerTitle: { fontSize: 13, fontWeight: '600' },
  bannerBody: { marginTop: 4, fontSize: 13, lineHeight: 19, color: Theme.textMuted },
  ranges: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 8 },
  range: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, backgroundColor: Theme.bgAlt },
  rangeText: { fontSize: 12, fontWeight: '600', color: Theme.textMuted, fontVariant: ['tabular-nums'] },
  chartCard: { paddingVertical: 6 },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, gap: 8 },
  dim: { fontSize: 12, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  rowKind: { fontSize: 13, fontWeight: '600' },
  rowValue: { fontSize: 13, color: Theme.text, fontVariant: ['tabular-nums'] },
  more: { paddingVertical: 8, alignSelf: 'flex-start' },
  moreText: { fontSize: 13, color: Theme.textMuted0 },
}));
