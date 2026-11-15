// One Ops issue (an event group, eg-N): what failed, how often and for how
// many people, its last day, and its occurrences with their stack, page,
// person and recording, each one tap away. Resolve, ignore and reopen ask
// first and paint at once (store action setOpsGroupStatus). The phone twin
// of the web's /ops/issues/<eg-N>, opened from a source's or a replay's rows
// and from issue links.
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { isCiRunRecord } from '@codecast/shared/contracts/signalFingerprint';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { Mono, uiFace } from '@/constants/fonts';
import { appAlert } from '@/lib/popups';
import { openWebPage, WEB_ORIGIN } from '@/lib/links';
import { CollapsibleBody } from '@/components/CollapsibleBody';
import { ObjectHeader, ObjectMissing, SectionLabel, FactChip, objectStyles } from '@/components/objects/ObjectParts';
import { HourStrip, Vital, ago, groupKindLook, groupStatusColor, opsStyles } from '@/components/ops/OpsRows';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { detailGone, useOpsGroup, useOpsSamples, useOpsSources, useSyncOpsGroup, useSyncOpsSources } from '@codecast/web/hooks/useSyncOps';
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
  const sample = useMemo(() => samples.find((s) => s.at === pickedAt) ?? samples[0], [samples, pickedAt]);
  const look = groupKindLook(g.kind, Theme);
  const statusColor = groupStatusColor(g.status, Theme);
  const ref = g.short_id || g._id;

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
        menu={[{ label: 'Open on the web', onPress: () => { void openWebPage(`${WEB_ORIGIN}/ops/issues/${ref}`); } }]}
      />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content}>
        <RNText style={objectStyles.title} selectable>{g.title}</RNText>
        <RNView style={objectStyles.chips}>
          <FactChip icon={look.icon} label={KIND_WORD[g.kind] ?? g.kind} color={look.color} />
          <FactChip label={g.regressed_at && g.status === 'open' ? 'regressed' : g.status} color={g.regressed_at && g.status === 'open' ? Theme.orange : statusColor} />
          {g.level ? <FactChip label={g.level} color={Theme.textMuted} /> : null}
          {source ? <FactChip icon="plug" label={source.name} color={Theme.cyan} onPress={() => router.push(`/source/${source.short_id || source._id}` as never)} testID="issue-source" /> : null}
        </RNView>

        {g.culprit ? <RNText style={styles.culprit} selectable numberOfLines={2}>{g.culprit}</RNText> : null}

        <RNView style={styles.verbs}>
          {g.status === 'open' ? (
            <>
              <Verb icon="check" label="Resolve" color={Theme.green} onPress={() => confirm('resolved')} />
              <Verb icon="eye-slash" label="Ignore" color={Theme.textMuted} onPress={() => confirm('ignored')} />
            </>
          ) : (
            <Verb icon="undo" label="Reopen" color={Theme.orange} onPress={() => confirm('open')} />
          )}
          {g.fix_conversation_id ? <Verb icon="comment-o" label="Fix session" color={Theme.cyan} onPress={() => router.push(`/session/${g.fix_conversation_id}` as never)} /> : null}
        </RNView>

        <RNView style={opsStyles.vitals}>
          <Vital label="Events" value={g.count.toLocaleString()} sub={`${(g.buckets ?? []).filter((b) => b.hour > now - 86_400_000).reduce((n, b) => n + b.count, 0)} in 24h`} color={look.color} />
          <Vital label="People" value={g.users ? String(g.users) : '—'} sub={g.users_since ? `since ${new Date(g.users_since).toLocaleDateString()}` : null} />
          <Vital label="Last seen" value={ago(g.last_seen, now)} sub={g.last_release ? `release ${g.last_release.slice(0, 12)}` : null} />
          <Vital label="First seen" value={ago(g.first_seen, now)} sub={g.first_release ? `release ${g.first_release.slice(0, 12)}` : null} />
        </RNView>

        <RNView style={objectStyles.section}>
          <SectionLabel>Last 48 hours</SectionLabel>
          <RNView style={[opsStyles.card, styles.chart]}>
            <HourStrip buckets={g.buckets ?? []} now={now} color={look.color} height={44} hours={48} />
          </RNView>
        </RNView>

        <RNView style={objectStyles.section}>
          <SectionLabel>{samples.length ? `Occurrences · ${samples.length}` : 'Occurrences'}</SectionLabel>
          {sample ? <SampleDetail s={sample} now={now} /> : (
            <RNView style={opsStyles.card}><RNText style={opsStyles.empty}>{g.sample_count === 0 ? 'No occurrences kept.' : 'Reading occurrences…'}</RNText></RNView>
          )}
          {samples.length > 1 && (
            <RNView style={[opsStyles.card, { marginTop: 10 }]}>
              {samples.map((s, i) => {
                const on = s.at === sample?.at;
                return (
                  <TouchableOpacity key={`${s.at}-${i}`} style={[styles.sampleRow, i > 0 && styles.rule, on && { backgroundColor: Theme.accent + '1a' }]} onPress={() => setPicked(s.at)} activeOpacity={0.6}>
                    <RNText style={styles.sampleAt}>{ago(s.at, now)}</RNText>
                    <RNText style={styles.sampleMsg} numberOfLines={1}>{s.message ?? g.title}</RNText>
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
                  <RNText style={[styles.sampleAt, { color: look.color }]}>×{m.count}</RNText>
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

function SampleDetail({ s, now }: { s: OpsSample; now: number }) {
  const Theme = useTheme();
  const router = useRouter();
  const who = s.user?.email ?? s.user?.name ?? s.user?.id ?? null;
  const facts = [
    { k: 'When', v: `${new Date(s.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${ago(s.at, now)}` },
    who ? { k: 'Who', v: who } : null,
    s.url ? { k: 'Page', v: s.url, mono: true } : null,
    s.release ? { k: 'Release', v: s.release, mono: true } : null,
    s.environment ? { k: 'Env', v: s.environment } : null,
  ].filter((x): x is { k: string; v: string; mono?: boolean } => !!x);
  return (
    <RNView style={[opsStyles.card, styles.sample]} testID="issue-sample">
      {s.message ? <RNText style={styles.message} selectable>{s.message}</RNText> : null}
      {facts.map((f) => (
        <RNView key={f.k} style={styles.fact}>
          <RNText style={styles.factK}>{f.k}</RNText>
          <RNText style={[styles.factV, f.mono && styles.mono]} numberOfLines={2} selectable>{f.v}</RNText>
        </RNView>
      ))}
      {s.replay_id ? (
        <TouchableOpacity style={styles.replayBtn} onPress={() => router.push(`/replay/${s.replay_id}` as never)} activeOpacity={0.7} testID="issue-sample-replay">
          <FontAwesome name="play-circle-o" size={15} color={Theme.cyan} />
          <RNText style={styles.replayText}>Watch the recording</RNText>
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

function Verb({ icon, label, color, onPress }: { icon: React.ComponentProps<typeof FontAwesome>['name']; label: string; color: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={[styles.verb, { borderColor: color + '55' }]}>
      <FontAwesome name={icon} size={13} color={color} />
      <RNText style={[styles.verbText, { color }]}>{label}</RNText>
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  culprit: { marginTop: -4, marginBottom: Spacing.md, fontSize: 12.5, color: Theme.textMuted, fontFamily: uiFace(Mono.regular) },
  verbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: Spacing.lg },
  verb: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  verbText: { fontSize: 13, fontWeight: '600' },
  chart: { padding: 12 },
  sample: { padding: 12, gap: 8 },
  message: { fontSize: 14, lineHeight: 20, color: Theme.text, fontWeight: '500' },
  fact: { flexDirection: 'row', gap: 10 },
  factK: { width: 58, fontSize: 12, color: Theme.textMuted0 },
  factV: { flex: 1, fontSize: 12.5, color: Theme.text },
  mono: { fontFamily: uiFace(Mono.regular) },
  replayBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: Theme.cyan + '55', backgroundColor: Theme.cyan + '12' },
  replayText: { flex: 1, fontSize: 13, fontWeight: '600', color: Theme.cyan },
  stackBox: { borderRadius: 8, backgroundColor: Theme.bgAlt, padding: 10 },
  stack: { fontSize: 11.5, lineHeight: 16, color: Theme.text, fontFamily: uiFace(Mono.regular) },
  sampleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  sampleAt: { width: 64, fontSize: 12, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  sampleMsg: { flex: 1, fontSize: 13, color: Theme.text },
}));
