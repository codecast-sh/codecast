import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { goToTab, isTabAddress } from '@/lib/tabNavigation';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/constants/Theme';
import { DrawerHeading, DrawerRow } from '@/components/nav/DrawerRow';
import { LivePulse, useCallsOn, useLiveRooms } from '@/components/calls/LiveRooms';
import { useWorkspaceFeatureState } from '@/lib/teamFeatures';
import { useDecisionQueue } from '@codecast/web/hooks/useDecisionQueue';

/** What waits in the app menu: the decisions on you and whether a huddle is
 *  live. The menu's rows show them, and the ☰ that opens it carries them. */
export function useMenuSignals(): { waiting: number; live: boolean } {
  const live = useLiveRooms(useCallsOn()).length > 0;
  const waiting = useDecisionQueue().length;
  return { waiting, live };
}

/** The app's places that are not tabs, as slide-out rows: the questions
 *  you own, calls, the week, plans, docs, triggers and the org. `onLeave`
 *  closes the panel the rows sit in. */
export function Places({ onLeave }: { onLeave: () => void }) {
  const Theme = useTheme();
  const router = useRouter();
  const orgOn = useWorkspaceFeatureState('org');
  const { waiting, live } = useMenuSignals();

  const go = (route: string) => {
    void Haptics.selectionAsync();
    onLeave();
    if (isTabAddress(route)) goToTab(router, route);
    else router.navigate(route as never);
  };
  const icon = (name: keyof typeof Feather.glyphMap) => <Feather name={name} size={17} color={Theme.textMuted} />;
  const rows: Array<{ page: string; name: string; icon: keyof typeof Feather.glyphMap; route: string; count?: number; live?: boolean }> = [
    { page: '/decisions', name: 'Decisions', icon: 'help-circle', route: '/decisions', count: waiting || undefined },
    { page: '/calls', name: 'Calls', icon: 'phone', route: '/calls', live },
    { page: '/week', name: 'Week', icon: 'calendar', route: '/week' },
    { page: '/plans', name: 'Plans', icon: 'map', route: '/(tabs)/tasks?segment=plans' },
    { page: '/docs', name: 'Docs', icon: 'file-text', route: '/(tabs)/tasks?segment=docs' },
    { page: '/triggers', name: 'Triggers', icon: 'clock', route: '/(tabs)/tasks?segment=routines' },
    ...(orgOn === true ? [{ page: '/org', name: 'Org', icon: 'users' as const, route: '/org' }] : []),
  ];

  return (
    <View>
      <DrawerHeading>Go to</DrawerHeading>
      {rows.map((r) => (
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
