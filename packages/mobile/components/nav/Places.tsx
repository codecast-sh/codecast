import { View } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/constants/Theme';
import { DrawerHeading, DrawerRow } from '@/components/nav/DrawerRow';
import { LivePulse, useCallsOn, useLiveRooms } from '@/components/calls/LiveRooms';
import { useWorkspaceFeatureState } from '@/lib/teamFeatures';
import { useOwnedDecisionCount } from '@codecast/web/hooks/useDecisionRows';
import { useModeWords, useSurfaceMode } from '@codecast/web/lib/surfaces';

/** The app's places that are not tabs, as slide-out rows: the questions
 *  you own, calls, plans, docs, routines and the org. Each names its
 *  page as the web's rail does in this mode, and hides where the mode has no
 *  such page. `onLeave` closes the panel the rows sit in. */
export function Places({ onLeave }: { onLeave: () => void }) {
  const Theme = useTheme();
  const router = useRouter();
  const mode = useSurfaceMode();
  const words = useModeWords();
  const orgOn = useWorkspaceFeatureState('org');
  const callsOn = useCallsOn();
  const live = useLiveRooms(callsOn).length > 0;
  const waiting = useOwnedDecisionCount();

  const go = (route: string) => {
    void Haptics.selectionAsync();
    onLeave();
    router.navigate(route as never);
  };
  const icon = (name: keyof typeof Feather.glyphMap) => <Feather name={name} size={17} color={Theme.textMuted} />;
  const rows: Array<{ page: string; name: string; icon: keyof typeof Feather.glyphMap; route: string; count?: number; live?: boolean }> = [
    { page: '/decisions', name: mode.page('/decisions', 'Decisions'), icon: 'help-circle', route: '/decisions', count: waiting || undefined },
    { page: '/calls', name: 'Calls', icon: 'phone', route: '/calls', live },
    { page: '/plans', name: mode.page('/plans', 'Plans'), icon: 'map', route: '/(tabs)/tasks?segment=plans' },
    { page: '/docs', name: mode.page('/docs', 'Docs'), icon: 'file-text', route: '/(tabs)/tasks?segment=docs' },
    { page: '/triggers', name: words.triggers, icon: 'clock', route: '/(tabs)/tasks?segment=routines' },
    ...(orgOn === true ? [{ page: '/org', name: 'Org', icon: 'users' as const, route: '/org' }] : []),
  ];

  return (
    <View>
      <DrawerHeading>Go to</DrawerHeading>
      {rows.filter((r) => mode.showsPage(r.page)).map((r) => (
        <DrawerRow
          key={r.page}
          icon={icon(r.icon)}
          name={r.name}
          count={r.count}
          trailing={r.live ? <LivePulse color={Theme.green} size={7} /> : undefined}
          onPress={() => go(r.route)}
        />
      ))}
    </View>
  );
}
