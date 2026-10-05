// The assistant lane on the phone (plan pl-840, docs/architecture/
// hosted-assistant.md "The simple lane"): its own stack, typeface and look,
// on the same store and feeders as the rest of the app (StoreSyncBridge,
// mounted once in the root AuthGate). The lane's tabs sit at /simple, and a
// conversation at /simple/c/<id> opens above them without the tab bar, the
// web lane's own addresses, so a shared link lands on the same surface.
import { Stack } from 'expo-router';
import { useFonts } from 'expo-font';
import { FaceContext } from '@/constants/fonts';
import { LANE_FACES, LANE_FONT_ASSETS, useLaneTheme } from '@/components/simple/laneTheme';

export default function SimpleLaneLayout() {
  const { c } = useLaneTheme();
  // Local assets, read in a few milliseconds. A face that fails to load
  // leaves the lane in the app's own face rather than blank.
  const [loaded, error] = useFonts(LANE_FONT_ASSETS);
  if (!loaded && !error) return null;
  return (
    <FaceContext.Provider value={loaded ? LANE_FACES : null}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.paper } }}>
        <Stack.Screen name="simple/(lane)" />
        <Stack.Screen name="simple/c/[id]" />
      </Stack>
    </FaceContext.Provider>
  );
}
