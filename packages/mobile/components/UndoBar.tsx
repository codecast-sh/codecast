import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, PanResponder, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Text as RNText } from '@/components/Themed';
import { Spacing, TAB_BAR_HEIGHT, themedStyles, useTheme } from '@/constants/Theme';
import { dismissUndoBar, runHeldKill, useUndoBar, type UndoBarItem } from '@/lib/undoBar';

/** Mounted once at the root: the bar for whatever lib/undoBar is showing. */
export function UndoBarHost() {
  const item = useUndoBar((s) => s.item);
  // A kill held while the app leaves the foreground runs now, so it is never
  // stranded in a suspended timer.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => { if (state !== 'active') runHeldKill(); });
    return () => sub.remove();
  }, []);
  return item ? <UndoBar key={item.key} item={item} /> : null;
}

function UndoBar({ item }: { item: UndoBarItem }) {
  const Theme = useTheme();
  const enter = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const left = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Haptics.impactAsync(item.tone === 'kill' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    AccessibilityInfo.announceForAccessibility(item.title);
    Animated.timing(enter, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    const drain = Animated.timing(left, { toValue: 0, duration: item.durationMs, easing: Easing.linear, useNativeDriver: true });
    drain.start(({ finished }) => { if (finished) leave(); });
    return () => drain.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one bar per key
  }, []);

  const leave = () => {
    Animated.timing(enter, { toValue: 0, duration: 140, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => dismissUndoBar(item.key));
  };

  const undo = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    item.onUndo?.();
    dismissUndoBar(item.key);
  };

  // Swipe down to take it away; for a held kill that runs the kill now.
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_e, g) => drag.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_e, g) => {
      if (g.dy > 28 || g.vy > 0.8) leave();
      else Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
    },
  })).current;

  const translateY = Animated.add(enter.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }), drag);
  return (
    <Animated.View
      {...pan.panHandlers}
      style={[styles.bar, { opacity: enter, transform: [{ translateY }] }]}
      accessibilityLiveRegion="polite"
    >
      <RNView style={styles.words}>
        <RNText style={styles.title} numberOfLines={1}>{item.title}</RNText>
        {item.note ? <RNText style={styles.note} numberOfLines={1}>{item.note}</RNText> : null}
      </RNView>
      {item.onUndo ? (
        <TouchableOpacity onPress={undo} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} activeOpacity={0.6} accessibilityRole="button">
          <RNText style={styles.undo}>Undo</RNText>
        </TouchableOpacity>
      ) : null}
      <Animated.View
        style={[
          styles.drain,
          { backgroundColor: item.tone === 'kill' ? Theme.red : Theme.bg, opacity: item.tone === 'kill' ? 1 : 0.45, transform: [{ scaleX: left }] },
        ]}
      />
    </Animated.View>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  // Inverted against the page, so it reads over any screen in either theme.
  bar: {
    position: 'absolute',
    left: Spacing.md,
    right: Spacing.md,
    bottom: TAB_BAR_HEIGHT + Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingLeft: Spacing.lg,
    paddingRight: Spacing.lg,
    paddingVertical: Spacing.md,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: Theme.text,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    zIndex: 1000,
  },
  words: { flex: 1, minWidth: 0 },
  title: { color: Theme.bg, fontSize: 14, fontWeight: '500' },
  note: { color: Theme.bg, opacity: 0.65, fontSize: 12, marginTop: 2 },
  undo: { color: Theme.bg, fontSize: 14, fontWeight: '700' },
  drain: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    transformOrigin: 'left',
  },
}));
