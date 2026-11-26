import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Easing, PanResponder, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { Text as RNText } from '@/components/Themed';
import { Spacing, TAB_BAR_HEIGHT, themedStyles, useTheme } from '@/constants/Theme';
import { bindUndoBarOpen, dismissUndoBar, leaveUndoBar, setAppActive, UNDO_BAR_EXIT_MS, undoBarLift, useUndoBar, type UndoBarItem } from '@/lib/undoBar';

/** Mounted once at the root: the bar for whatever lib/undoBar is showing. */
export function UndoBarHost() {
  const item = useUndoBar((s) => s.item);
  // Leaving the foreground runs a held kill and puts a card back in the queue;
  // coming back shows it again.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => sub.remove();
  }, []);
  // Close advice's Open: the session's own screen, at its last message.
  useEffect(() => {
    bindUndoBarOpen((id, messageId) => router.push(`/session/${id}${messageId ? `?message=${messageId}` : ''}`));
    return () => bindUndoBarOpen(null);
  }, []);
  // The bar's own frame, measured in the window: its bottom is where `bottom`
  // counts from, which on Android edge-to-edge sits above the window's own
  // bottom by the navigation bar.
  const hostRef = useRef<RNView>(null);
  const [hostBottom, setHostBottom] = useState<number | null>(null);
  const measure = () => hostRef.current?.measureInWindow((_x, y, _w, h) => { if (h > 0) setHostBottom(y + h); });
  return (
    <RNView ref={hostRef} onLayout={measure} style={StyleSheet.absoluteFill} pointerEvents="box-none" collapsable={false}>
      {item ? <UndoBar key={item.key} item={item} hostBottom={hostBottom} /> : null}
    </RNView>
  );
}

function UndoBar({ item, hostBottom }: { item: UndoBarItem; hostBottom: number | null }) {
  const Theme = useTheme();
  // Above a conversation's composer and its owner lines, so Undo never covers
  // the control it takes back.
  const dockTop = useUndoBar((s) => s.dockTop);
  const lift = dockTop != null && hostBottom != null ? undoBarLift(hostBottom, dockTop) : 0;
  const enter = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const left = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // An earlier gesture's card can show as a bar of its own (lib/undoBar offerCard).
    if (item.ask) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    else Haptics.impactAsync(item.tone === 'kill' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    AccessibilityInfo.announceForAccessibility(item.ask ? `${item.title}. ${item.ask}` : item.title);
    Animated.timing(enter, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one bar per key
  }, []);

  // The countdown, restarted when the bar's life changes under the same key
  // (lib/undoBar relive): a close advice card starts a full one, a verdict
  // that asked nothing drains what is left of the receipt's.
  useEffect(() => {
    if (item.life > 0 && item.ask) {
      left.setValue(1);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      AccessibilityInfo.announceForAccessibility(`${item.title}. ${item.ask}`);
    }
    const drain = Animated.timing(left, { toValue: 0, duration: item.durationMs, easing: Easing.linear, useNativeDriver: true });
    drain.start(({ finished }) => { if (finished) leave(); });
    return () => drain.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- item.life names each life of the bar
  }, [item.life]);

  const leave = () => {
    // A card leaving is finished: a bar that shows during the exit must not
    // put it back in the queue.
    leaveUndoBar(item.key);
    Animated.timing(enter, { toValue: 0, duration: UNDO_BAR_EXIT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true })
      .start(() => dismissUndoBar(item.key));
  };

  const undo = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    item.onUndo?.();
    dismissUndoBar(item.key);
  };

  const act = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    item.action?.onPress();
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
      style={[styles.bar, lift > 0 && { bottom: lift + Spacing.sm }, { opacity: enter, transform: [{ translateY }] }]}
      accessibilityLiveRegion="polite"
    >
      <RNView style={styles.words}>
        <RNText style={styles.title} numberOfLines={1}>{item.title}</RNText>
        {item.ask ? <RNText style={styles.ask} numberOfLines={2}>{item.ask}</RNText> : null}
        {item.note ? <RNText style={styles.note} numberOfLines={1}>{item.note}</RNText> : null}
      </RNView>
      {item.onUndo ? (
        <TouchableOpacity onPress={undo} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }} activeOpacity={0.6} accessibilityRole="button" style={styles.button}>
          <RNText style={styles.undo}>Undo</RNText>
        </TouchableOpacity>
      ) : null}
      {item.action ? (
        <TouchableOpacity onPress={act} hitSlop={{ top: 12, bottom: 12, left: 6, right: 12 }} activeOpacity={0.6} accessibilityRole="button" style={[styles.button, styles.action]}>
          <RNText style={styles.actionLabel}>{item.action.label}</RNText>
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
  ask: { color: Theme.bg, opacity: 0.85, fontSize: 13, lineHeight: 18, marginTop: 4 },
  // The answers never give up width to a long title: the words truncate instead.
  button: { flexShrink: 0 },
  undo: { color: Theme.bg, fontSize: 14, fontWeight: '700' },
  action: { backgroundColor: Theme.bg, borderRadius: 8, paddingHorizontal: Spacing.md, paddingVertical: 6 },
  actionLabel: { color: Theme.text, fontSize: 14, fontWeight: '700' },
  drain: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    transformOrigin: 'left',
  },
}));
