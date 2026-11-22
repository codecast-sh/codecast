// One product source's screen (src-N: an SDK, Sentry, PostHog, an app, CI),
// the phone twin of the web's source overview at /ops?source=<name>: its
// health in one word with the reason, the numbers a person checks first, the
// last two weeks of volume, what is failing now (its open issues, newest
// first, each opening to its stack and occurrences), its watches and its
// newest recordings. Pause and resume act on it in place.
//
// Every list is a store row fed here; health is the web's one reading
// (components/ops/sourceHealth), computed from the same rows.
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { isCiRunRecord } from '@codecast/shared/contracts/signalFingerprint';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme, type Palette } from '@/constants/Theme';
import { appAlert } from '@/lib/popups';
import { openWebPage, WEB_ORIGIN } from '@/lib/links';
import { ObjectHeader, ObjectMissing, SectionLabel, FactChip, objectStyles } from '@/components/objects/ObjectParts';
import { GroupRow, ReplayRow, Vital, ago, opsStyles } from '@/components/ops/OpsRows';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useOpsGroups, useOpsReplays, useOpsSources, useOpsWatches, useSyncOpsGroups, useSyncOpsReplays, useSyncOpsSourceOpenGroups, useSyncOpsSources, useSyncOpsWatches } from '@codecast/web/hooks/useSyncOps';
import { sourceActivity, sourceHealth, type HealthTone } from '@codecast/web/components/ops/sourceHealth';
import { formatValue } from '@codecast/web/components/ops/metricModel';
import type { OpsGroup, OpsSource, OpsWatch } from '@codecast/web/components/ops/opsTypes';

const PROVIDER: Record<string, string> = { sdk: 'SDK', http: 'HTTP', app: 'App', sentry: 'Sentry', posthog: 'PostHog', github: 'GitHub' };
const ISSUES_SHOWN = 10;

const toneColor = (tone: HealthTone, t: Palette) => (tone === 'ok' ? t.green : tone === 'warn' ? t.orange : tone === 'bad' ? t.red : tone === 'calm' ? t.textMuted : t.textMuted0);

/** An open group that is a problem now: not a passing check or metric, not a superseded CI run record (the web's isOpenProblem). */
const isOpenProblem = (g: OpsGroup) => g.status === 'open' && !((g.kind === 'check' || g.kind === 'metric') && g.meta?.ok === true) && !isCiRunRecord(g);

export default function SourceScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const ref = rawId?.trim() ?? null;
  const feed = useSyncOpsSources();
  const sources = useOpsSources();
  const source = ref ? sources.find((s) => s.short_id === ref.toLowerCase() || s._id === ref || s.name === ref) : undefined;
  if (!source) return <ObjectMissing what="Source" id={ref ?? undefined} loading={!feed.ready && !feed.error} />;
  return <SourceBody source={source} />;
}

function SourceBody({ source }: { source: OpsSource }) {
  const Theme = useTheme();
  useSyncOpsSourceOpenGroups(source._id);
  useSyncOpsGroups();
  useSyncOpsReplays();
  useSyncOpsWatches();
  const now = useCoarseNow(60_000);
  const groups = useOpsGroups();
  const replays = useOpsReplays();
  const watches = useOpsWatches();
  const [allIssues, setAllIssues] = useState(false);

  const health = useMemo(() => sourceHealth(source, sourceActivity(source, { groups, replays, watches }, now), { now, watches }), [source, groups, replays, watches, now]);
  const open = useMemo(() => groups.filter((g) => g.source_id === source._id && isOpenProblem(g)).sort((a, b) => b.last_seen - a.last_seen), [groups, source._id]);
  const mine = useMemo(() => replays.filter((r) => r.source_id === source._id).slice(0, 5), [replays, source._id]);
  const myWatches = useMemo(() => watches.filter((w) => w.source_id === source._id).sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'alert' ? -1 : 1)), [watches, source._id]);
  const color = toneColor(health.tone, Theme);
  const paused = source.status === 'paused';
  const ref = source.short_id || source._id;
  const vsNormal = health.normal ? Math.round((health.today / health.normal) * 100) : null;

  const setStatus = (status: 'active' | 'paused') => useInboxStore.getState().setOpsSourceStatus(source._id, status);
  const confirmPause = () => appAlert(`Pause ${source.name}?`, 'Events it sends while paused are dropped, and its polls stop until you resume it.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Pause', style: 'destructive', onPress: () => setStatus('paused') },
  ]);

  return (
    <>
      <ObjectHeader
        type="source"
        shortId={source.short_id}
        title={source.name}
        menu={[{ label: 'Open on the web', onPress: () => { void openWebPage(`${WEB_ORIGIN}/ops?source=${encodeURIComponent(source.name)}`); } }]}
      />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content}>
        <RNText style={objectStyles.title} selectable>{source.name}</RNText>
        <RNView style={objectStyles.chips}>
          <FactChip icon="circle" label={health.label} color={color} testID="source-health" />
          <FactChip icon="plug" label={PROVIDER[source.provider] ?? source.provider} color={Theme.textMuted} />
          {open.length > 0 && <FactChip icon="bug" label={`${open.length} open`} color={Theme.red} />}
        </RNView>

        {health.reason ? (
          <RNView style={[styles.banner, { borderColor: color + '44', borderLeftColor: color, backgroundColor: color + '10' }]}>
            <RNText style={[styles.bannerTitle, { color }]}>{health.label}{health.since ? ` · since ${ago(health.since, now).replace(' ago', '')}` : ''}</RNText>
            <RNText style={styles.bannerBody} numberOfLines={5}>{health.reason}</RNText>
          </RNView>
        ) : null}

        <RNView style={styles.verbs}>
          {paused
            ? <Verb icon="play" label="Resume" color={Theme.green} onPress={() => setStatus('active')} />
            : <Verb icon="pause" label="Pause" color={Theme.textMuted} onPress={confirmPause} />}
        </RNView>

        <RNView style={opsStyles.vitals}>
          <Vital label="Last event" value={ago(health.lastAt, now)} sub={health.lastAt ? new Date(health.lastAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null} />
          <Vital
            label="Last 24h"
            value={health.today.toLocaleString()}
            sub={vsNormal !== null ? `${vsNormal}% of a usual day` : null}
            subColor={vsNormal === null ? undefined : vsNormal >= 300 ? Theme.orange : vsNormal <= 33 ? Theme.yellow : undefined}
          />
          <Vital label="Open issues" value={String(open.length)} color={open.length ? Theme.red : undefined} sub={source.group_counts ? `${source.group_counts.resolved} resolved` : null} />
          {health.polledAt
            ? <Vital label="Last poll" value={ago(health.polledAt, now)} sub={source.dropped_today ? `${source.dropped_today} dropped today` : null} subColor={Theme.orange} />
            : <Vital label="Dropped today" value={String(source.dropped_today ?? 0)} color={source.dropped_today ? Theme.orange : undefined} />}
        </RNView>

        <RNView style={objectStyles.section}>
          <SectionLabel right={<RNText style={styles.dim}>{health.normal ? `usual ${health.normal.toLocaleString()}/day` : ''}</RNText>}>14 days</SectionLabel>
          <RNView style={[opsStyles.card, styles.chartCard]}>
            <DayBars days={health.days} color={Theme.blue} />
          </RNView>
        </RNView>

        <RNView style={objectStyles.section}>
          <SectionLabel>{`Failing now · ${open.length}`}</SectionLabel>
          <RNView style={opsStyles.card}>
            {open.length === 0 ? (
              <RNText style={opsStyles.empty}>Nothing open.</RNText>
            ) : (
              (allIssues ? open : open.slice(0, ISSUES_SHOWN)).map((g, i) => <GroupRow key={g._id} g={g} now={now} first={i === 0} />)
            )}
          </RNView>
          {open.length > ISSUES_SHOWN && (
            <TouchableOpacity style={styles.more} onPress={() => setAllIssues((v) => !v)} activeOpacity={0.6}>
              <RNText style={styles.moreText}>{allIssues ? 'Show fewer' : `${open.length - ISSUES_SHOWN} more`}</RNText>
              <FontAwesome name={allIssues ? 'angle-up' : 'angle-down'} size={13} color={Theme.textMuted0} />
            </TouchableOpacity>
          )}
        </RNView>

        {myWatches.length > 0 && (
          <RNView style={objectStyles.section}>
            <SectionLabel>{`Watches · ${myWatches.length}`}</SectionLabel>
            <RNView style={opsStyles.card}>
              {myWatches.map((w, i) => <WatchRow key={w._id} w={w} now={now} first={i === 0} />)}
            </RNView>
          </RNView>
        )}

        {mine.length > 0 && (
          <RNView style={objectStyles.section}>
            <SectionLabel>Recent recordings</SectionLabel>
            <RNView style={opsStyles.card}>
              {mine.map((r, i) => <ReplayRow key={r._id} r={r} now={now} first={i === 0} />)}
            </RNView>
          </RNView>
        )}
      </ScrollView>
    </>
  );
}

function DayBars({ days, color }: { days: number[]; color: string }) {
  const max = Math.max(1, ...days);
  return (
    <RNView style={styles.bars} testID="source-days">
      {days.map((d, i) => (
        <RNView key={i} style={styles.barCol}>
          <RNView style={[styles.bar, { height: d ? Math.max(3, (d / max) * 56) : 2, backgroundColor: i === days.length - 1 ? color : d ? color + '99' : color + '26' }]} />
        </RNView>
      ))}
    </RNView>
  );
}

function WatchRow({ w, now, first }: { w: OpsWatch; now: number; first: boolean }) {
  const Theme = useTheme();
  const alert = w.state === 'alert';
  const c = w.status === 'paused' ? Theme.textMuted0 : alert ? Theme.red : w.last_error ? Theme.orange : Theme.green;
  const line = w.threshold !== undefined ? `${w.direction} ${formatValue(w.threshold, w.unit)}` : null;
  return (
    <TouchableOpacity style={[styles.watch, !first && styles.rule]} onPress={() => { void openWebPage(`${WEB_ORIGIN}/ops/metrics/${w.short_id}`); }} activeOpacity={0.6}>
      <RNView style={[styles.dot, { backgroundColor: c }]} />
      <RNView style={{ flex: 1, minWidth: 0 }}>
        <RNText style={styles.watchName} numberOfLines={1}>{w.name}</RNText>
        <RNText style={styles.dim} numberOfLines={1}>
          {w.status === 'paused' ? 'paused' : alert ? 'alerting' : w.last_error ? 'read failing' : 'ok'}{line ? ` · alert ${line}` : ''}{w.last_at ? ` · ${ago(w.last_at, now)}` : ''}
        </RNText>
      </RNView>
      <RNText style={[styles.watchValue, { color: alert ? Theme.red : Theme.text }]}>{w.last_value !== null ? formatValue(w.last_value, w.unit) : '—'}</RNText>
    </TouchableOpacity>
  );
}

function Verb({ icon, label, color, onPress }: { icon: React.ComponentProps<typeof FontAwesome>['name']; label: string; color: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={[styles.verb, { borderColor: color + '55' }]} testID={`source-${label.toLowerCase()}`}>
      <FontAwesome name={icon} size={12} color={color} />
      <RNText style={[styles.verbText, { color }]}>{label}</RNText>
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  banner: { marginBottom: Spacing.lg, borderWidth: 1, borderLeftWidth: 3, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  bannerTitle: { fontSize: 13, fontWeight: '600' },
  bannerBody: { marginTop: 4, fontSize: 13, lineHeight: 19, color: Theme.textMuted },
  verbs: { flexDirection: 'row', gap: 8, marginBottom: Spacing.lg },
  verb: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  verbText: { fontSize: 13, fontWeight: '600' },
  chartCard: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 10 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', height: 58, gap: 4 },
  barCol: { flex: 1, justifyContent: 'flex-end' },
  bar: { borderRadius: 2 },
  dim: { fontSize: 12, color: Theme.textMuted0 },
  more: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 2 },
  moreText: { fontSize: 12.5, fontWeight: '600', color: Theme.textMuted },
  watch: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  dot: { width: 8, height: 8, borderRadius: 4 },
  watchName: { fontSize: 14, fontWeight: '500', color: Theme.text },
  watchValue: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
}));
