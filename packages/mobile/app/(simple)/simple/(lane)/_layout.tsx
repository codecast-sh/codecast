// The lane's five surfaces as tabs, under the floating tab bar (web
// SimpleShell's TabBar). Each page draws its own top line, so the tabs show
// no header.
import { Tabs } from 'expo-router';
import { useLaneData } from '@codecast/web/components/simple/useLane';
import { LANE_TABS, LaneTabBar } from '@/components/simple/LaneChrome';
import { useLaneTheme } from '@/components/simple/laneTheme';

export default function LaneTabs() {
  const { c } = useLaneTheme();
  const { approvals } = useLaneData();
  return (
    <Tabs
      tabBar={(props) => <LaneTabBar {...props} approvals={approvals.length} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: c.paper } }}
    >
      {LANE_TABS.map((t) => <Tabs.Screen key={t.name} name={t.name} options={{ title: t.label }} />)}
    </Tabs>
  );
}
