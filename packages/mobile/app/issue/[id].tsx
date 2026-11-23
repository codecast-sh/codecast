// One Ops issue (an event group, eg-N): what failed, how often and for how
// many people, its last day, and its occurrences with their stack, page,
// person and recording, each one tap away. Resolve, ignore and reopen ask
// first and paint at once (store action setOpsGroupStatus). The phone twin
// of the web's /ops/issues/<eg-N>, opened from a source's or a replay's rows
// and from issue links.
import { useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { isCiRunRecord } from '@codecast/shared/contracts/signalFingerprint';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { Mono, uiFace } from '@/constants/fonts';
import { appAlert } from '@/lib/popups';
import { WEB_ORIGIN } from '@/lib/links';
import { CollapsibleBody } from '@/components/CollapsibleBody';
import { ActionButton, LinkRow, ObjectHeader, ObjectMissing, SectionLabel, FactChip, objectStyles } from '@/components/objects/ObjectParts';
import { HourStrip, Vital, ago, clock, groupKindLook, groupStatusColor, opsStyles } from '@/components/ops/OpsRows';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { STATUS_CONFIG } from '@/components/TaskItem';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { sampleWho, shortUrl } from '@codecast/web/components/ops/sampleText';
import { detailGone, useOpsGroup, useOpsReplay, useOpsSamples, useOpsSources, useSyncOpsGroup, useSyncOpsReplay, useSyncOpsSources } from '@codecast/web/hooks/useSyncOps';
import { replayOffset } from '@codecast/web/components/ops/issueSamples';
import { replayRefId } from '@codecast/shared/entities';
import type { OpsGroup, OpsSample } from '@codecast/web/components/ops/opsTypes';

const KIND_WORD: Record<string, string> = { error: 'error', replay_issue: 'replay issue', job: 'failed job', check: 'check', metric: 'metric' };

export default function IssueScreen() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = rawId?.trim() || null;
  const feed = useSyncOpsGroup(id);
  useSyncOpsSources();
  const g = useOpsGroup(id);
  if (!g) return <ObjectMissing what="Issue" id={id ?? undefined} loading={!detailGone(feed) && !feed.error} />;
  return <IssueBody g={g} />;
}

function IssueBody({ g }: { g: OpsGroup }) {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(60_000);
  const samples = useOpsSamples(g._id);
  const sources = useOpsSources();
  const source = sources.find((s) => s._id === g.source_id);
  const [pickedAt, setPicked] = useState<number | null>(null);
  const scroller = useRef<ScrollView>(null);
  const { fontScale } = useWindowDimensions();
  const atCol = { width: Math.ceil(64 * Math.min(fontScale, KEY_MAX_SCALE)) };
  const occurrencesTop = useRef(0);
  // A picked row redraws the detail card above the list, so the card comes into view.
  const pick = (at: number) => {
    setPicked(at);
    scroller.current?.scrollTo({ y: Math.max(0, occurrencesTop.current - Spacing.md), animated: true });
  };
  const sample = useMemo(() => samples.find((s) => s.at === pickedAt) ?? samples[0], [samples, pickedAt]);
  const look = groupKindLook(g.kind, Theme);
  const statusColor = groupStatusColor(g.status, Theme);
  const ref = g.short_id || g._id;
  // The problem task filed for this issue, as the store holds it; a task from
  // another workspace opens by its id and names itself there.
  const taskSig = useInboxStore((st) => {
    const t = g.signal_task_id ? (st.tasks as Record<string, any>)[g.signal_task_id] : undefined;
    return t ? `${t.short_id}\u0000${t.status}\u0000${t.title}` : '';
  });
  const [taskShort, taskStatus, taskTitle] = taskSig ? taskSig.split('\u0000') : [];
  const taskLook = STATUS_CONFIG[taskStatus as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.open;
  // A row tells occurrences apart the way the web's does: page, person, release.
  const rowText = (s: OpsSample) => [shortUrl(s.url), sampleWho(s), s.release?.slice(0, 12)].filter(Boolean).join(' · ') || s.message || g.title;

  const setStatus = (status: 'resolved' | 'ignored' | 'open') => useInboxStore.getState().setOpsGroupStatus(g._id, status);
  const confirm = (status: 'resolved' | 'ignored' | 'open') => {
    const words = status === 'resolved'
      ? { title: 'Resolve this issue?', body: 'A later occurrence reopens it as a regression.', ok: 'Resolve' }
      : status === 'ignored'
        ? { title: 'Ignore this issue?', body: 'It stops announcing new occurrences.', ok: 'Ignore' }
        : { title: 'Reopen this issue?', body: 'It goes back on the open list.', ok: 'Reopen' };
    appAlert(words.title, `${g.title}\n\n${words.body}`, [{ text: 'Cancel', style: 'cancel' }, { text: words.ok, onPress: () => setStatus(status) }]);
  };

  return (
    <>
      <ObjectHeader
        type={null}
        shortId={g.short_id}
        title={g.title}
        link={`${WEB_ORIGIN}/ops/issues/${ref}`}
      />
      <ScrollView ref={scroller} style={objectStyles.container} contentContainerStyle={objectStyles.content}>
        <RNText style={objectStyles.title} selectable>{g.title}</RNText>
        <RNView style={objectStyles.chips}>
          <FactChip icon={look.icon} label={KIND_WORD[g.kind] ?? g.kind} color={look.color} />
          <FactChip label={g.regressed_at && g.status === 'open' ? 'regressed' : g.status} color={g.regressed_at && g.status === 'open' ? Theme.orange : statusColor} />
          {g.level && g.level !== g.kind ? <FactChip label={g.level} color={Theme.textMuted} /> : null}
          {source ? <FactChip icon="plug" label={source.name} color={Theme.cyan} onPress={() => router.push(`/source/${source.short_id || source._id}` as never)} testID="issue-source" /> : null}
        </RNView>

        {g.culprit ? <RNText style={styles.culprit} selectable numberOfLines={2}>{g.culprit}</RNText> : null}

        <RNView style={objectStyles.verbs}>
          {g.status === 'open' ? (
            <>
              <ActionButton icon="check" label="Resolve" color={Theme.green} onPress={() => confirm('resolved')} />
              <ActionButton icon="eye-slash" label="Ignore" color={Theme.textMuted} onPress={() => confirm('ignored')} />
            </>
          ) : (
            <ActionButton icon="undo" label="Reopen" color={Theme.orange} onPress={() => confirm('open')} />
          )}
          {g.fix_conversation_id ? <ActionButton icon="comment-o" label="Fix session" color={Theme.cyan} onPress={() => router.push(`/session/${g.fix_conversation_id}` as never)} /> : null}
        </RNView>

        <RNView style={opsStyles.vitals}>
          <Vital label="Events" value={g.count.toLocaleString()} sub={`${(g.buckets ?? []).filter((b) => b.hour > now - 86_400_000).reduce((n, b) => n + b.count, 0)} in 24h`} color={look.color} />
          <Vital label="People" value={g.users ? String(g.users) : '—'} sub={g.users_since ? `since ${new Date(g.users_since).toLocaleDateString()}` : null} />
          <Vital label="Last seen" value={ago(g.last_seen, now)} sub={g.last_release && g.last_release !== 'unknown' ? `release ${g.last_release.slice(0, 12)}` : null} />
          <Vital label="First seen" value={ago(g.first_seen, now)} sub={g.first_release && g.first_release !== 'unknown' ? `release ${g.first_release.slice(0, 12)}` : null} />
        </RNView>

        {g.signal_task_id ? (
          <RNView style={objectStyles.section}>
            <SectionLabel>Task</SectionLabel>
            <RNView style={opsStyles.card}>
              <LinkRow
                icon={taskLook.icon}
                color={taskLook.color}
                title={taskTitle && taskTitle !== g.title ? taskTitle : taskShort || 'Open its task'}
                meta={taskShort ? (taskTitle && taskTitle !== g.title ? `${taskShort} · ${taskLook.label}` : taskLook.label) : undefined}
                onPress={() => router.push(`/task/${taskShort || g.signal_task_id}` as never)}
                testID="issue-task"
              />
            </RNView>
          </RNView>
        ) : null}

        <RNView style={objectStyles.section}>
          <SectionLabel>Last 48 hours</SectionLabel>
          <RNView style={[opsStyles.card, styles.chart]}>
            {(g.buckets ?? []).some((b) => b.hour > now - 48 * 3_600_000)
              ? <HourStrip buckets={g.buckets ?? []} now={now} color={look.color} height={44} hours={48} fill />
              : <RNText style={styles.quiet}>{`Nothing since ${ago(g.last_seen, now)}`}</RNText>}
          </RNView>
        </RNView>

        <RNView style={objectStyles.section} onLayout={(e) => { occurrencesTop.current = e.nativeEvent.layout.y; }}>
          <SectionLabel>{samples.length ? `Occurrences · ${samples.length}` : 'Occurrences'}</SectionLabel>
          {sample ? <SampleDetail s={sample} now={now} /> : (
            <RNView style={opsStyles.card}><RNText style={opsStyles.empty}>{g.sample_count === 0 ? 'No occurrences kept.' : 'Reading occurrences…'}</RNText></RNView>
          )}
          {samples.length > 1 && (
            <RNView style={[opsStyles.card, { marginTop: 10 }]}>
              {samples.map((s, i) => {
                const on = s.at === sample?.at;
                return (
                  <TouchableOpacity key={`${s.at}-${i}`} style={[styles.sampleRow, i > 0 && styles.rule, on && { backgroundColor: Theme.accent + '1a' }]} onPress={() => pick(s.at)} activeOpacity={0.6}>
                    <RNText style={[styles.sampleAt, atCol]} maxFontSizeMultiplier={KEY_MAX_SCALE} numberOfLines={1}>{ago(s.at, now)}</RNText>
                    <RNText style={styles.sampleMsg} numberOfLines={1}>{rowText(s)}</RNText>
                    {s.replay_id ? <FontAwesome name="play-circle-o" size={13} color={Theme.cyan} /> : null}
                  </TouchableOpacity>
                );
              })}
            </RNView>
          )}
        </RNView>

        {isCiRunRecord(g) ? null : g.messages && g.messages.length > 1 ? (
          <RNView style={objectStyles.section}>
            <SectionLabel>What it said</SectionLabel>
            <RNView style={opsStyles.card}>
              {g.messages.slice(0, 8).map((m, i) => (
                <RNView key={m.key} style={[styles.sampleRow, i > 0 && styles.rule]}>
                  <RNText style={[styles.sampleAt, atCol, { color: look.color }]} maxFontSizeMultiplier={KEY_MAX_SCALE} numberOfLines={1}>×{m.count}</RNText>
                  <RNText style={styles.sampleMsg} numberOfLines={2}>{m.key}</RNText>
                </RNView>
              ))}
            </RNView>
          </RNView>
        ) : null}
      </ScrollView>
    </>
  );
}

// The fact labels grow with the text size up to this much, so "When" never breaks.
const KEY_MAX_SCALE = 1.6;

function SampleDetail({ s, now }: { s: OpsSample; now: number }) {
  const Theme = useTheme();
  const router = useRouter();
  const { fontScale } = useWindowDimensions();
  // The recording opens at the moment this occurrence happened in it.
  useSyncOpsReplay(s.replay_id ?? null);
  const replay = useOpsReplay(s.replay_id ?? null);
  const t = replayOffset(s.at, replay);
  const replayRef = replay?.short_id ? replayRefId(replay.short_id, t) : s.replay_id;
  const who = sampleWho(s);
  const facts = [
    { k: 'When', v: `${new Date(s.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${ago(s.at, now)}` },
    who ? { k: 'Who', v: who } : null,
    s.url ? { k: 'Page', v: s.url, mono: true } : null,
    s.release ? { k: 'Release', v: s.release, mono: true } : null,
    s.environment ? { k: 'Env', v: s.environment } : null,
  ].filter((x): x is { k: string; v: string; mono?: boolean } => !!x);
  return (
    <RNView style={[opsStyles.card, styles.sample]} testID="issue-sample">
      {s.message ? <RNText style={styles.message} selectable numberOfLines={8}>{s.message.replace(/\n\s*\n+/g, '\n').trim()}</RNText> : null}
      {facts.map((f) => (
        <RNView key={f.k} style={styles.fact}>
          <RNText style={[styles.factK, { width: Math.ceil(58 * Math.min(fontScale, KEY_MAX_SCALE)) }]} maxFontSizeMultiplier={KEY_MAX_SCALE} numberOfLines={1}>{f.k}</RNText>
          <RNText style={[styles.factV, f.mono && styles.mono]} numberOfLines={f.mono ? 2 : 3} selectable>{f.v}</RNText>
        </RNView>
      ))}
      {s.replay_id ? (
        <TouchableOpacity style={styles.replayBtn} onPress={() => router.push(`/replay/${encodeURIComponent(replayRef!)}` as never)} activeOpacity={0.7} testID="issue-sample-replay">
          <FontAwesome name="play-circle-o" size={15} color={Theme.cyan} />
          <RNText style={styles.replayText}>{t !== null ? `Watch the recording at ${clock(t)}` : 'Watch the recording'}</RNText>
          <FontAwesome name="angle-right" size={14} color={Theme.cyan} />
        </TouchableOpacity>
      ) : null}
      {s.stack ? (
        <RNView style={styles.stackBox}>
          <CollapsibleBody fadeColor={Theme.bgAlt} height={200}>
            <RNText style={styles.stack} selectable>{s.stack}</RNText>
          </CollapsibleBody>
        </RNView>
      ) : null}
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  culprit: { marginTop: -4, marginBottom: Spacing.md, fontSize: 12.5, color: Theme.textMuted, fontFamily: uiFace(Mono.regular) },
  chart: { padding: 12 },
  quiet: { fontSize: 13, color: Theme.textMuted0 },
  sample: { padding: 12, gap: 8 },
  message: { fontSize: 14, lineHeight: 20, color: Theme.text, fontWeight: '500' },
  fact: { flexDirection: 'row', gap: 10 },
  factK: { fontSize: 12, color: Theme.textMuted0 },
  factV: { flex: 1, fontSize: 12.5, color: Theme.text },
  mono: { fontFamily: uiFace(Mono.regular) },
  replayBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: Theme.cyan + '55', backgroundColor: Theme.cyan + '12' },
  replayText: { flex: 1, fontSize: 13, fontWeight: '600', color: Theme.cyan },
  stackBox: { borderRadius: 8, backgroundColor: Theme.bgAlt, padding: 10 },
  stack: { fontSize: 11.5, lineHeight: 16, color: Theme.text, fontFamily: uiFace(Mono.regular) },
  sampleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  sampleAt: { fontSize: 12, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  sampleMsg: { flex: 1, fontSize: 13, color: Theme.text },
}));
