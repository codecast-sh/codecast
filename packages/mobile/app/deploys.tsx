// The team's deploy targets on the phone, the twin of web's /deploys rail: what
// runs on each (its live deploy, a press away), and the uncommitted work a dev
// watcher pushed on top of it. A deploy_dropped_work notice about a dev push
// lands here, and so does production_paused: a repository's standing pause
// (deploys.md DP17) leads the screen, with who paused it, why, how long ago,
// the rollback and task that end it and what lifts it, and Lift for whoever
// may. The data and its rules are lib/deploys/targets, fed by the same feeder
// the web page mounts; Lift is the web's (lib/deploys/press sendLift).
import { useMemo } from 'react';
import { ScrollView, View as RNView, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useDeployTargets } from '@codecast/web/hooks/useSyncDeployTargets';
import { teamWorkspaceKey } from '@codecast/web/lib/workspaceScope';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { orderTargets, productionOf, targetNow, type DeployProductionRow } from '@codecast/web/lib/deploys/targets';
import { sendLift } from '@codecast/web/lib/deploys/press';
import { compactAge } from '@codecast/web/lib/threadState';
import { devPushWords } from '@codecast/web/components/deploys/deployRecord';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { useActiveTeamId } from '@/hooks/useWorkspaceArgs';
import { ActionButton, FactRow, Facts, LinkRow, ObjectMissing, SectionLabel, objectStyles } from '@/components/objects/ObjectParts';

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '—');

export default function DeploysScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(30_000);
  const teamId = useActiveTeamId() ?? null;
  const { targets, deploys, productions, ready } = useDeployTargets(teamWorkspaceKey(teamId));
  const ordered = useMemo(() => orderTargets(targets, deploys), [targets, deploys]);
  const paused = productions.filter((p) => p.pause);
  const repos = new Set(targets.map((t) => t.repository));

  if (!ordered.length) return <ObjectMissing what="Deploy targets" loading={!!teamId && !ready} />;
  return (
    <>
      <Stack.Screen options={{ title: 'Deploys' }} />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content} testID="deploys-screen">
        {paused.map((p) => <PausedBlock key={p._id} p={p} now={now} named={repos.size > 1} />)}
        <RNView style={objectStyles.list}>
          {ordered.map((t) => {
            const live = targetNow(t, deploys).live;
            const pause = productionOf(productions, t)?.pause;
            return (
              <RNView key={t._id} testID={`deploys-target-${t.name}`}>
                <LinkRow
                  icon={pause ? 'pause-circle' : live ? 'check-circle' : 'circle-thin'}
                  color={pause ? Theme.orange : live ? Theme.green : Theme.textDim}
                  title={t.name}
                  meta={live ? `${short(live.sha)} · ${compactAge(Math.max(0, now - (live.live_at ?? live.created_at)))}` : 'nothing live'}
                  onPress={live?.short_id ? () => router.push(`/deploy/${live.short_id}` as never) : undefined}
                />
                {t.dev_push ? <RNText style={styles.devPush} testID={`deploys-dev-push-${t.name}`}>{devPushWords(t.dev_push, now)}</RNText> : null}
              </RNView>
            );
          })}
        </RNView>
      </ScrollView>
    </>
  );
}

/** A repository's standing pause: nothing but the rollback that paused it is sent until it lifts. */
function PausedBlock({ p, now, named }: { p: DeployProductionRow; now: number; named: boolean }) {
  const Theme = useTheme();
  const router = useRouter();
  const pause = p.pause!;
  const u = pause.until;
  return (
    <RNView testID={`deploys-paused-${p.repository}`}>
      <SectionLabel>Production paused</SectionLabel>
      <Facts>
        {named ? <FactRow label="Repository">{p.repository}</FactRow> : null}
        <FactRow label="Paused" icon="pause-circle" tone={Theme.orange}>{`${pause.by} · ${compactAge(Math.max(0, now - pause.at))} ago`}</FactRow>
        <FactRow label="Why">{pause.reason}</FactRow>
        {pause.rollback ? <FactRow label="Rollback" onPress={() => router.push(`/deploy/${pause.rollback}` as never)}>{pause.rollback}</FactRow> : null}
        {u?.task ? <FactRow label="Task" onPress={() => router.push(`/task/${u.task}` as never)}>{u.task}</FactRow> : null}
        <FactRow label="Lifts">{pause.lifts}</FactRow>
        {u?.migrations.length ? <FactRow label="Migrations" tone={Theme.red}>{`No revert: fix forward past ${u.migrations.join(', ')}`}</FactRow> : null}
      </Facts>
      {p.can_lift ? (
        <RNView style={objectStyles.verbs}>
          <ActionButton icon="play" label="Lift" color={Theme.orange} filled onPress={() => sendLift(p)} testID={`deploys-lift-${p.repository}`} />
        </RNView>
      ) : null}
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  devPush: { fontSize: 12.5, color: Theme.orange, paddingHorizontal: Spacing.md, paddingTop: 2, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.bgHighlight },
}));
