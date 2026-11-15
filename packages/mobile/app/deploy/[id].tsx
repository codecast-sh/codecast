// One deploy (dp-N) on the phone: where it went and whether it worked, what it
// carried out (each commit openable, under the session that wrote it), who
// sent it and when, its steps and its own log, and the deploys either side of
// it on the same target. The web draws the same row inside /deploys; the data
// and its rules are lib/deploys/targets, fed by the Deploys page's feeders.
import { useMemo } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { useDeployTargets } from '@codecast/web/hooks/useSyncDeployTargets';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { deploysOf, sessionWords, sessionsOf, sourceWord, targetNow, type TeamDeployRow } from '@codecast/web/lib/deploys/targets';
import { fmtClock, fmtDuration } from '@codecast/web/components/triggerCadence';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme, type Palette } from '@/constants/Theme';
import { codeFont } from '@/constants/fonts';
import { copyToClipboard } from '@/lib/clipboard';
import { ObjectHeader, ObjectMissing, SectionLabel, LinkRow, FactChip, objectStyles } from '@/components/objects/ObjectParts';

const api = _api as any;

type IconName = React.ComponentProps<typeof FontAwesome>['name'];
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '—');
const HISTORY_SHOWN = 6;

function statusVisual(status: TeamDeployRow['status'], t: Palette): { icon: IconName; label: string; color: string } {
  switch (status) {
    case 'live': return { icon: 'check-circle', label: 'Live', color: t.green };
    case 'failed': return { icon: 'times-circle', label: 'Failed', color: t.red };
    case 'cancelled': return { icon: 'minus-circle', label: 'Cancelled', color: t.textDim };
    case 'running': return { icon: 'circle-o-notch', label: 'Going out', color: t.accent };
    default: return { icon: 'clock-o', label: 'Asked for', color: t.accent };
  }
}

const STEP_ICON: Record<string, IconName> = { completed: 'check', failed: 'times', running: 'circle-o-notch', pending: 'circle-thin' };

function actionWords(d: TeamDeployRow): string {
  if (d.action === 'rollback') return `Rolled back ${d.target}`;
  if (d.action === 'redeploy') return `Redeployed ${d.target}`;
  return d.status === 'live' || d.status === 'failed' || d.status === 'cancelled' ? `Deployed to ${d.target}` : `Deploying to ${d.target}`;
}

export default function DeployScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = (rawId ?? '').trim().toLowerCase();
  const now = useCoarseNow(30_000);

  // The cache names the deploy (and so its team) on the first frame; whereIs
  // answers for one this phone has never held.
  const cached = useInboxStore((s) => Object.values((s as any).teamDeploys ?? {}).find((d: any) => d?.short_id === id) as TeamDeployRow | undefined);
  const where = useQueryNoThrow(api.deployRefs.whereIs, id ? { ref: id } : 'skip');
  const served = where.data as { team_id: string | null } | null | undefined;
  const teamId = served?.team_id ?? (cached?.workspace?.startsWith('team:') ? cached.workspace.slice(5) : null);
  const { deploys, ready } = useDeployTargets(teamId);
  const d = deploys.find((x) => x.short_id === id) ?? cached;

  const history = useMemo(() => (d ? deploysOf({ name: d.target, repository: d.repository }, deploys) : []), [d, deploys]);
  const live = useMemo(() => (d ? targetNow({ name: d.target, repository: d.repository }, deploys).live : null), [d, deploys]);

  if (!d) {
    const settled = served === null || where.error || (teamId && ready);
    return <ObjectMissing what="Deploy" id={id || undefined} loading={!settled} />;
  }

  const status = statusVisual(d.status, Theme);
  const by = d.started_by ?? sourceWord(d);
  const isLiveNow = live?._id === d._id;
  const sessions = sessionsOf(d);
  const titles = new Map(sessions.map((x) => [x.conversation_id, sessionWords(x)]));
  const groups = new Map<string, NonNullable<TeamDeployRow['commit_rows']>>();
  for (const c of d.commit_rows ?? []) {
    const k = c.conversation_id ?? '';
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const ordered = [...groups].sort(([a], [b]) => (a ? 0 : 1) - (b ? 0 : 1));
  const listedSessions = new Set(groups.keys());
  const otherSessions = sessions.filter((x) => !listedSessions.has(x.conversation_id));
  const moreCommits = (d.commits ?? 0) - (d.commit_rows?.length ?? 0);
  const tasks = (d.tasks ?? []).filter((x) => x.short_id);
  const after = d.after;
  const openCommit = (sha: string) => router.push(`/commit/${d.repository}/${sha}` as never);
  const openSession = (cid: string) => router.push(`/session/${cid}` as never);
  const index = history.findIndex((x) => x._id === d._id);
  const start = Math.max(0, Math.min(index - 2, history.length - HISTORY_SHOWN));
  const nearby = history.slice(start, start + HISTORY_SHOWN);
  const logLabel = `${sourceWord(d)} log`;

  return (
    <>
      <ObjectHeader
        type="deploy"
        shortId={d.short_id}
        title={actionWords(d)}
        menu={[
          ...(d.url ? [{ label: `Open ${logLabel}`, onPress: () => void WebBrowser.openBrowserAsync(d.url!) }] : []),
          ...(d.sha ? [{ label: 'Copy sha', onPress: () => { void copyToClipboard(d.sha!); } }] : []),
        ]}
      />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content} testID="deploy-screen">
        <RNText style={styles.repo} numberOfLines={1}>{d.repository}</RNText>
        <RNText style={objectStyles.title}>{actionWords(d)}</RNText>
        <RNView style={objectStyles.chips}>
          <FactChip icon={status.icon} label={status.label} color={status.color} testID={`deploy-status-${d.status}`} />
          {isLiveNow && <FactChip icon="bolt" label="Live now" color={Theme.green} />}
          {d.version && !(d.sha ?? '').startsWith(d.version.slice(0, 7)) ? <FactChip icon="tag" label={d.version} color={Theme.textMuted} /> : null}
        </RNView>

        {d.status === 'failed' && (
          <RNView style={[styles.banner, { borderColor: Theme.red + '55', backgroundColor: Theme.red + '12' }]}>
            <FontAwesome name="times-circle" size={14} color={Theme.red} />
            <RNText style={styles.bannerText}>{d.note || 'This deploy failed.'}</RNText>
          </RNView>
        )}

        <RNView style={[objectStyles.list, styles.facts]}>
          <Fact label="Sent">
            <RNView style={styles.shas}>
              {d.previous_sha ? (
                <TouchableOpacity onPress={() => openCommit(d.previous_sha!)} activeOpacity={0.6}>
                  <RNText style={styles.shaLink}>{short(d.previous_sha)}</RNText>
                </TouchableOpacity>
              ) : <RNText style={styles.shaDim}>—</RNText>}
              <FontAwesome name="long-arrow-right" size={12} color={Theme.textDim} />
              {d.sha ? (
                <TouchableOpacity onPress={() => openCommit(d.sha!)} activeOpacity={0.6} testID="deploy-sha">
                  <RNText style={styles.shaLink}>{short(d.sha)}</RNText>
                </TouchableOpacity>
              ) : <RNText style={styles.shaDim}>—</RNText>}
            </RNView>
          </Fact>
          <Fact label="By"><RNText style={styles.factValue} numberOfLines={1}>{by || '—'}</RNText></Fact>
          <Fact label="When">
            <RNText style={styles.factValue}>
              {fmtClock(d.created_at, now)}
              <RNText style={styles.factDim}>{`  ${fmtDuration(Math.max(0, now - d.created_at))} ago`}</RNText>
            </RNText>
          </Fact>
          {d.live_at && d.live_at - d.created_at >= 60_000 ? (
            <Fact label="Live after"><RNText style={styles.factValue}>{fmtDuration(d.live_at - d.created_at)}</RNText></Fact>
          ) : null}
          {after?.open && d.status !== 'failed' ? (
            <Fact label="Since">
              <RNText style={[styles.factValue, { color: after.quiet ? Theme.green : Theme.red }]}>
                {after.quiet ? 'Quiet' : [after.new_errors ? `${after.new_errors} new ${after.new_errors === 1 ? 'error' : 'errors'}` : null, after.regressions ? `${after.regressions} came back` : null].filter(Boolean).join(' · ') || 'Quiet'}
              </RNText>
            </Fact>
          ) : null}
          {d.note && d.status !== 'failed' ? <Fact label="Note" last><RNText style={styles.factValue}>{d.note}</RNText></Fact> : null}
        </RNView>

        {d.steps?.length ? (
          <RNView style={objectStyles.section}>
            <SectionLabel>Steps</SectionLabel>
            <RNView style={objectStyles.list}>
              {d.steps.map((s) => {
                const tint = s.status === 'completed' ? Theme.green : s.status === 'failed' ? Theme.red : s.status === 'running' ? Theme.accent : Theme.textDim;
                return (
                  <RNView key={s.id} style={styles.step}>
                    <FontAwesome name={STEP_ICON[s.status] ?? 'circle-thin'} size={12} color={tint} style={styles.stepIcon} />
                    <RNText style={styles.stepText} numberOfLines={1}>{s.id}</RNText>
                    <RNText style={[styles.stepStatus, { color: tint }]}>{s.status}</RNText>
                  </RNView>
                );
              })}
            </RNView>
          </RNView>
        ) : null}

        <RNView style={objectStyles.section}>
          <SectionLabel>{d.commits ? `Carried · ${d.commits} ${d.commits === 1 ? 'commit' : 'commits'}` : 'Carried'}</SectionLabel>
          {ordered.length === 0 && otherSessions.length === 0 ? (
            <RNText style={objectStyles.empty}>
              {d.action !== 'deploy' ? `Back to ${d.rollback_of ?? short(d.sha)}` : d.status === 'live' && !d.commits ? 'Rebuilt, nothing new' : d.commits ? `${d.commits} commits, none named` : 'Not recorded'}
            </RNText>
          ) : null}
          {ordered.map(([k, rows]) => (
            <RNView key={k || 'none'} style={[objectStyles.list, styles.group]}>
              {k ? (
                <TouchableOpacity style={styles.groupHead} onPress={() => openSession(k)} activeOpacity={0.6} testID="deploy-session">
                  <FontAwesome name="comments-o" size={13} color={Theme.blue} style={styles.stepIcon} />
                  <RNText style={styles.groupTitle} numberOfLines={1}>{titles.get(k) ?? k.slice(0, 7)}</RNText>
                  <FontAwesome name="angle-right" size={14} color={Theme.textDim} />
                </TouchableOpacity>
              ) : (
                <RNView style={styles.groupHead}>
                  <FontAwesome name="user-o" size={12} color={Theme.textDim} style={styles.stepIcon} />
                  <RNText style={[styles.groupTitle, { color: Theme.textMuted }]}>Not from a session</RNText>
                </RNView>
              )}
              {rows.map((c) => (
                <TouchableOpacity key={c.sha} style={styles.commit} onPress={() => openCommit(c.sha)} activeOpacity={0.6} testID="deploy-commit">
                  <RNText style={styles.commitSha}>{short(c.sha)}</RNText>
                  <RNText style={styles.commitSubject} numberOfLines={2}>{c.subject}</RNText>
                </TouchableOpacity>
              ))}
            </RNView>
          ))}
          {otherSessions.length > 0 && (
            <RNView style={[objectStyles.list, styles.group]}>
              {otherSessions.map((x) => (
                <LinkRow key={x.conversation_id} icon="comments-o" color={Theme.blue} title={sessionWords(x)} onPress={() => openSession(x.conversation_id)} />
              ))}
            </RNView>
          )}
          {moreCommits > 0 && ordered.length > 0 ? <RNText style={objectStyles.empty}>{moreCommits} more {moreCommits === 1 ? 'commit' : 'commits'}</RNText> : null}
        </RNView>

        {tasks.length > 0 && (
          <RNView style={objectStyles.section}>
            <SectionLabel>{`Tasks · ${tasks.length}`}</SectionLabel>
            <RNView style={objectStyles.list}>
              {tasks.map((t) => (
                <LinkRow key={t.short_id!} icon="circle-o" color={Theme.violet} title={t.title || t.short_id!} meta={t.short_id!} onPress={() => router.push(`/task/${t.short_id}` as never)} />
              ))}
            </RNView>
          </RNView>
        )}

        {d.url ? (
          <TouchableOpacity style={styles.log} onPress={() => void WebBrowser.openBrowserAsync(d.url!)} activeOpacity={0.6} testID="deploy-log">
            <FontAwesome name="file-text-o" size={14} color={Theme.text} />
            <RNText style={styles.logText}>{logLabel}</RNText>
          </TouchableOpacity>
        ) : null}

        {nearby.length > 1 && (
          <RNView style={objectStyles.section}>
            <SectionLabel>{`${d.target} deploys`}</SectionLabel>
            <RNView style={objectStyles.list}>
              {nearby.map((x) => {
                const v = statusVisual(x.status, Theme);
                const here = x._id === d._id;
                return (
                  <TouchableOpacity
                    key={x._id}
                    disabled={here || !x.short_id}
                    style={[styles.hist, here && { backgroundColor: Theme.bgHighlight }]}
                    onPress={() => router.push(`/deploy/${x.short_id}` as never)}
                    activeOpacity={0.6}
                  >
                    <FontAwesome name={v.icon} size={12} color={v.color} style={styles.stepIcon} />
                    <RNText style={[styles.histId, here && { color: Theme.text }]}>{x.short_id || '…'}</RNText>
                    <RNText style={styles.histSha}>{short(x.sha)}</RNText>
                    <RNText style={styles.histBy} numberOfLines={1}>{x.started_by ?? sourceWord(x)}</RNText>
                    {x._id === live?._id ? <RNText style={[styles.histAge, { color: Theme.green }]}>live</RNText> : null}
                    <RNText style={styles.histAge}>{fmtDuration(Math.max(0, now - (x.live_at ?? x.created_at)))}</RNText>
                  </TouchableOpacity>
                );
              })}
            </RNView>
          </RNView>
        )}
      </ScrollView>
    </>
  );
}

function Fact({ label, children, last }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <RNView style={[styles.fact, last && { borderBottomWidth: 0 }]}>
      <RNText style={styles.factLabel}>{label}</RNText>
      <RNView style={styles.factBody}>{children}</RNView>
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  repo: { ...codeFont, fontSize: 12, color: Theme.textMuted, marginBottom: 6 },
  banner: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderWidth: 1, borderRadius: 8, padding: Spacing.md, marginBottom: Spacing.lg },
  bannerText: { flex: 1, fontSize: 13.5, lineHeight: 19, color: Theme.text },
  facts: { marginBottom: Spacing.xl },
  fact: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: Spacing.md, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.bgHighlight },
  factLabel: { width: 84, fontSize: 12.5, color: Theme.textMuted0 },
  factBody: { flex: 1, minWidth: 0 },
  factValue: { fontSize: 14, color: Theme.text },
  factDim: { fontSize: 12.5, color: Theme.textMuted },
  shas: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  shaLink: { ...codeFont, fontSize: 13.5, color: Theme.blue },
  shaDim: { ...codeFont, fontSize: 13.5, color: Theme.textDim },
  step: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.md, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.bgHighlight },
  stepIcon: { width: 16, textAlign: 'center' },
  stepText: { flex: 1, ...codeFont, fontSize: 13, color: Theme.text },
  stepStatus: { fontSize: 12 },
  group: { marginBottom: Spacing.sm },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.md, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.bgHighlight },
  groupTitle: { flex: 1, fontSize: 14, fontWeight: '600', color: Theme.text },
  commit: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: Spacing.md, paddingVertical: 8, paddingLeft: Spacing.md + 26 },
  commitSha: { ...codeFont, fontSize: 12, color: Theme.blue, marginTop: 1 },
  commitSubject: { flex: 1, fontSize: 13.5, lineHeight: 18, color: Theme.text },
  log: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, marginBottom: Spacing.xl,
    paddingVertical: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border,
  },
  logText: { fontSize: 14, fontWeight: '600', color: Theme.text },
  hist: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: Spacing.md, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.bgHighlight },
  histId: { ...codeFont, fontSize: 12.5, color: Theme.textMuted, width: 64 },
  histSha: { ...codeFont, fontSize: 12, color: Theme.textMuted0 },
  histBy: { flex: 1, fontSize: 12.5, color: Theme.textMuted },
  histAge: { fontSize: 12, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
}));
