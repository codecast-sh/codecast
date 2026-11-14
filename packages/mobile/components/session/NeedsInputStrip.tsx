// In the session header: how many OTHER sessions wait on you, one segment per
// session up to a cap, and a dim count of those working. Fed by the inbox's own
// placement (hooks/useInboxPlacement), so it never disagrees with the inbox it
// opens. Draws nothing while nobody waits on you.
import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';
import { useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { useTheme } from '@/constants/Theme';
import { Mono } from '@/constants/fonts';
import { useInboxPlacement } from '@/hooks/useInboxPlacement';
import { NEEDS_YOU_FILTER, needsInputGlance } from '@/lib/needsInputGlance';

// Only the screen on top computes it: every session screen in the stack
// would otherwise re-run the inbox placement on each change.
export const NeedsInputStrip = memo(function NeedsInputStrip({ currentId }: { currentId: string }) {
  return useIsFocused() ? <Strip currentId={currentId} /> : null;
});

function Strip({ currentId }: { currentId: string }) {
  const Theme = useTheme();
  const router = useRouter();
  const { placed } = useInboxPlacement();
  const glance = useMemo(() => needsInputGlance(placed, currentId), [placed, currentId]);
  if (glance.needs.length === 0) return null;
  const label = `${glance.needs.length} ${glance.needs.length === 1 ? 'session needs' : 'sessions need'} you${glance.working ? `, ${glance.working} working` : ''}: ${glance.needs.slice(0, 3).map((s) => s.title).join(', ')}`;
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        // navigate, not push: the tabs already exist under this screen, and a
        // push would stack a second copy of them with its own feeders.
        router.navigate({ pathname: '/(tabs)/inbox', params: { only: NEEDS_YOU_FILTER } } as never);
      }}
      hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
      style={({ pressed }) => [styles.strip, pressed && { opacity: 0.6 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the inbox showing only sessions that need you"
      testID="needs-input-strip"
    >
      <Feather name="user" size={11} color={Theme.accent} />
      <RNView style={styles.segments}>
        {glance.needs.slice(0, glance.segments).map((s) => (
          <RNView key={s.id} style={[styles.segment, { backgroundColor: Theme.accent }]} />
        ))}
      </RNView>
      <RNText style={[styles.count, { color: Theme.accent }]} maxFontSizeMultiplier={1.2}>{glance.needs.length}</RNText>
      {glance.working > 0 && (
        <>
          <Feather name="loader" size={10} color={Theme.textDim} style={styles.workingIcon} />
          <RNText style={[styles.working, { color: Theme.textDim }]} maxFontSizeMultiplier={1.2}>{glance.working}</RNText>
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', alignItems: 'center', height: 28, paddingHorizontal: 6, gap: 4 },
  segments: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  segment: { width: 3, height: 12, borderRadius: 1.5 },
  count: { fontSize: 12, fontFamily: Mono.semiBold, marginLeft: 1 },
  working: { fontSize: 11, fontFamily: Mono.regular },
  workingIcon: { marginLeft: 4 },
});
