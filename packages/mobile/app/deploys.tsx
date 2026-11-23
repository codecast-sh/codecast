// The team's deploy targets on the phone, the twin of web's /deploys rail: what
// runs on each (its live deploy, a press away), and the uncommitted work a dev
// watcher pushed on top of it. A deploy_dropped_work notice about a dev push
// lands here. The data and its rules are lib/deploys/targets, fed by the same
// feeder the web page mounts.
import { useMemo } from 'react';
import { ScrollView, View as RNView, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useDeployTargets } from '@codecast/web/hooks/useSyncDeployTargets';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { orderTargets, targetNow } from '@codecast/web/lib/deploys/targets';
import { compactAge } from '@codecast/web/lib/threadState';
import { devPushWords } from '@codecast/web/components/deploys/deployRecord';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { useActiveTeamId } from '@/hooks/useWorkspaceArgs';
import { LinkRow, ObjectMissing, objectStyles } from '@/components/objects/ObjectParts';

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '—');

export default function DeploysScreen() {
  const Theme = useTheme();
  const router = useRouter();
  const now = useCoarseNow(30_000);
  const teamId = useActiveTeamId() ?? null;
  const { targets, deploys, ready } = useDeployTargets(teamId);
  const ordered = useMemo(() => orderTargets(targets, deploys), [targets, deploys]);

  if (!ordered.length) return <ObjectMissing what="Deploy targets" loading={!!teamId && !ready} />;
  return (
    <>
      <Stack.Screen options={{ title: 'Deploys' }} />
      <ScrollView style={objectStyles.container} contentContainerStyle={objectStyles.content} testID="deploys-screen">
        <RNView style={objectStyles.list}>
          {ordered.map((t) => {
            const live = targetNow(t, deploys).live;
            return (
              <RNView key={t._id} testID={`deploys-target-${t.name}`}>
                <LinkRow
                  icon={live ? 'check-circle' : 'circle-thin'}
                  color={live ? Theme.green : Theme.textDim}
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

const styles = themedStyles((Theme) => StyleSheet.create({
  devPush: { fontSize: 12.5, color: Theme.orange, paddingHorizontal: Spacing.md, paddingTop: 2, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.bgHighlight },
}));
