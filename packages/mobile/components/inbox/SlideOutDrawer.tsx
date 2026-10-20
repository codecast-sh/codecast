import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { Extrapolation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { gestureHandler } from '@/lib/gestureHandler';
import { useTheme } from '@/constants/Theme';

// Critically damped enough to land without a wobble, quick enough to follow a flick.
const SPRING = { damping: 28, stiffness: 300, mass: 0.9 };
// A flick faster than this (pt/s) decides the direction regardless of distance.
const FLICK = 500;

/** A panel behind a screen, ChatGPT style: the whole screen slides right to
 *  uncover it. A rightward drag anywhere on the content opens it, a leftward
 *  drag or a tap on the uncovered edge of the content closes it. The owner
 *  holds the open state, so its own controls can open it too: the inbox's
 *  menu button opens its filters, and a conversation uncovers the inbox.
 *  The drawer's contents mount on first open, so a closed panel costs nothing. */
export function SlideOutDrawer({ enabled, open, setOpen, drawer, children }: {
  enabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  drawer: ReactNode;
  children: ReactNode;
}) {
  const Theme = useTheme();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(Math.round(width * 0.84), 360);
  const [mounted, setMounted] = useState(false);
  const progress = useSharedValue(0);
  const start = useSharedValue(0);
  const openRef = useRef(open);
  openRef.current = open;
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;

  useEffect(() => {
    if (open) setMounted(true);
    progress.value = withSpring(open ? 1 : 0, SPRING);
  }, [open, progress]);

  // Losing the screen (leaving the inbox tab, a pushed screen taking over)
  // closes the panel.
  useEffect(() => {
    if (!enabled) setOpenRef.current(false);
  }, [enabled]);

  const gesture = useMemo(() => {
    const G = gestureHandler?.Gesture;
    if (!G) return null;
    const settle = (next: boolean) => {
      if (next && !openRef.current) Haptics.selectionAsync();
      setOpenRef.current(next);
    };
    return G.Pan()
      .enabled(enabled)
      // Closed, only a rightward drag is ours: a leftward one belongs to the
      // row under the finger (swipe to set aside).
      .activeOffsetX(open ? [-10, 10] : 12)
      .failOffsetY([-14, 14])
      .onStart(() => {
        'worklet';
        start.value = progress.value;
      })
      .onUpdate((e: any) => {
        'worklet';
        progress.value = Math.min(1, Math.max(0, start.value + e.translationX / panelWidth));
      })
      .onEnd((e: any) => {
        'worklet';
        const next = e.velocityX > FLICK ? true : e.velocityX < -FLICK ? false : progress.value > 0.5;
        progress.value = withSpring(next ? 1 : 0, { ...SPRING, velocity: e.velocityX / panelWidth });
        runOnJS(settle)(next);
      });
  }, [enabled, open, panelWidth, progress, start]);

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * panelWidth }],
  }));
  // The shadow lives on the outer view; the rounded clip on the inner one
  // (iOS drops a shadow on a view that clips).
  const clipStyle = useAnimatedStyle(() => ({
    borderRadius: interpolate(progress.value, [0, 0.15], [0, 18], Extrapolation.CLAMP),
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value * 0.45 }));
  // The panel drifts in from a quarter of its width behind the content.
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (progress.value - 1) * panelWidth * 0.25 }],
    opacity: interpolate(progress.value, [0, 0.4], [0, 1], Extrapolation.CLAMP),
  }));

  const body = (
    <View style={[styles.root, { backgroundColor: Theme.bgAlt }]}>
      <Animated.View style={[styles.panel, { width: panelWidth }, panelStyle]} pointerEvents={open ? 'auto' : 'none'}>
        {mounted ? drawer : null}
      </Animated.View>
      <Animated.View style={[styles.content, contentStyle]}>
        <Animated.View style={[styles.clip, { backgroundColor: Theme.bg }, clipStyle]}>
          {children}
          <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]} pointerEvents={open ? 'auto' : 'none'}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} accessibilityLabel="Close menu" />
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </View>
  );

  return gesture ? <gestureHandler.GestureDetector gesture={gesture}>{body}</gestureHandler.GestureDetector> : body;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  panel: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  content: {
    flex: 1,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: -4, height: 0 },
  },
  clip: { flex: 1, overflow: 'hidden' },
  scrim: { backgroundColor: '#000' },
});
