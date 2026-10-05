// The lane's frame on the phone (web src/layouts/SimpleShell.tsx): a calm
// top line with the mark and the menu, and the floating tab bar.
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import Svg, { Circle } from 'react-native-svg';
import type { ComponentProps } from 'react';
import type { Tabs } from 'expo-router';
import { Text } from '@/components/Themed';
import { useActiveScheme } from '@/constants/Theme';
import { showActionSheet } from '@/lib/actionSheet';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { LANE_COPY, LANE_SECTIONS, type LaneSectionKey } from '@codecast/web/components/simple/lane';
import { moveToLane } from './laneRoute';
import { LANE_BRAND_FACE, LANE_RADIUS, LANE_RADIUS_SM, useLaneTheme } from './laneTheme';

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

const ICONS: Record<LaneSectionKey, ComponentProps<typeof Feather>['name']> = {
  home: 'home',
  approvals: 'check-circle',
  routines: 'clock',
  connections: 'link-2',
  plan: 'pie-chart',
};

/** The lane's tabs (lane.ts LANE_SECTIONS), each with its route name under
 *  app/(simple)/simple/(lane) and its icon. */
export const LANE_TABS = LANE_SECTIONS.map((t) => ({ ...t, name: t.key === 'home' ? 'index' : t.key, icon: ICONS[t.key] }));

/** How far the floating tab bar reaches up from the bottom edge, so a page
 *  can keep its last line clear of it. */
export function useTabBarClearance(): number {
  return useSafeAreaInsets().bottom + 86;
}

/** The family's ring mark in the accent (web .sl-brand-mark, the lane's boot
 *  screen): a thin vermilion ring on the paper. */
function BrandMark({ size = 20 }: { size?: number }) {
  const { c } = useLaneTheme();
  const r = size / 2;
  return (
    <Svg width={size} height={size}>
      <Circle cx={r} cy={r} r={size * 0.27} stroke={c.accent} strokeWidth={size * 0.11} fill="none" />
    </Svg>
  );
}

function openMenu(dark: boolean) {
  showActionSheet(undefined, [
    {
      label: dark ? LANE_COPY.menu.light : LANE_COPY.menu.dark,
      onPress: () => useInboxStore.getState().updateClientUI({ theme: dark ? 'light' : 'dark' }),
    },
    { label: LANE_COPY.menu.full, onPress: () => moveToLane('full') },
  ]);
}

/** The top of a lane page: the mark and the menu. It scrolls with the page. */
export function LaneTop() {
  const { c } = useLaneTheme();
  const dark = useActiveScheme() === 'dark';
  const top = useSafeAreaInsets().top;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingTop: top + 6, height: top + 54 }}>
      <BrandMark />
      <Text style={{ fontFamily: LANE_BRAND_FACE, fontSize: 19.5, letterSpacing: 0.1, color: c.ink }}>codecast</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={LANE_COPY.menu.more}
        onPress={() => openMenu(dark)}
        hitSlop={8}
        style={({ pressed }) => ({
          marginLeft: 'auto',
          width: 38,
          height: 38,
          borderRadius: 19,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? c.hover : 'transparent',
        })}
      >
        <Feather name="more-horizontal" size={20} color={c.soft} />
      </Pressable>
    </View>
  );
}

/** The floating tab bar (web .sl-tabs), with the open approvals on its badge. */
export function LaneTabBar({ state, navigation, approvals }: BottomTabBarProps & { approvals: number }) {
  const { c } = useLaneTheme();
  const bottom = useSafeAreaInsets().bottom;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: Math.max(bottom, 10) + 2, alignItems: 'center' }}>
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: 'row',
          width: '94%',
          maxWidth: 420,
          padding: 5,
          borderRadius: LANE_RADIUS,
          backgroundColor: c.sheet,
          borderWidth: 1,
          borderColor: c.line,
          shadowColor: c.ink,
          shadowOffset: { width: 0, height: 14 },
          shadowOpacity: 0.16,
          shadowRadius: 24,
          elevation: 6,
        }}
      >
        {state.routes.map((route, i) => {
          const tab = LANE_TABS.find((t) => t.name === route.name);
          if (!tab) return null;
          const focused = state.index === i;
          const badge = tab.name === 'approvals' ? approvals : 0;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={LANE_COPY.tabs.label(tab.label, badge)}
              onPress={() => {
                const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!focused && !event.defaultPrevented) navigation.navigate(route.name, route.params);
              }}
              style={{
                flex: 1,
                alignItems: 'center',
                gap: 2,
                paddingTop: 8,
                paddingBottom: 7,
                borderRadius: LANE_RADIUS_SM,
                backgroundColor: focused ? c.hover : 'transparent',
              }}
            >
              <Feather name={tab.icon} size={19} color={focused ? c.mark : c.faint} style={{ transform: [{ translateY: focused ? -1 : 0 }] }} />
              <Text numberOfLines={1} style={{ fontSize: 10.5, fontWeight: '500', letterSpacing: 0.05, color: focused ? c.ink : c.faint }}>
                {tab.label}
              </Text>
              {badge > 0 ? (
                <View style={{ position: 'absolute', top: 3, left: '56%', minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 10.5, fontWeight: '600', color: c.onSolid, fontVariant: ['tabular-nums'] }}>{badge > 99 ? '99+' : badge}</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
