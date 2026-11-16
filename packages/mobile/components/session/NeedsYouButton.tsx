// In the session header: the inbox, badged with how many OTHER sessions wait
// on you. A tap opens the inbox filtered to them. Fed by the inbox's own
// placement (hooks/useInboxPlacement), so the badge never disagrees with the
// list it opens. Draws nothing while nobody else waits on you.
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
export const NeedsYouButton = memo(function NeedsYouButton({ currentId }: { currentId: string }) {
  return useIsFocused() ? <Badged currentId={currentId} /> : null;
});

function Badged({ currentId }: { currentId: string }) {
  const Theme = useTheme();
  const router = useRouter();
  const { placed } = useInboxPlacement();
  const needs = useMemo(() => needsInputGlance(placed, currentId), [placed, currentId]);
  if (needs.length === 0) return null;
  const label = `${needs.length} other ${needs.length === 1 ? 'session needs' : 'sessions need'} you: ${needs.slice(0, 3).map((s) => s.title).join(', ')}`;
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        // navigate, not push: the tabs already exist under this screen, and a
        // push would stack a second copy of them with its own feeders.
        router.navigate({ pathname: '/(tabs)/inbox', params: { only: NEEDS_YOU_FILTER } } as never);
      }}
      hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }}
      style={({ pressed }) => [styles.button, pressed && { opacity: 0.6 }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the inbox showing only sessions that need you"
      testID="needs-you-button"
    >
      <Feather name="inbox" size={18} color={Theme.textMuted} />
      <RNView style={[styles.badge, { backgroundColor: Theme.accent, borderColor: Theme.bg }]}>
        <RNText style={[styles.count, { color: Theme.bg }]} maxFontSizeMultiplier={1}>
          {needs.length > 99 ? '99+' : needs.length}
        </RNText>
      </RNView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { width: 34, height: 34, justifyContent: 'center', alignItems: 'center' },
  badge: {
    position: 'absolute',
    top: 1,
    left: 17,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 8.5,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  count: { fontSize: 10, lineHeight: 12, fontFamily: Mono.bold },
});
