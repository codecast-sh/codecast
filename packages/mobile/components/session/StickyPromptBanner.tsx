/**
 * Slim sticky prompt for the iOS session screen: a one line pill under the
 * header that names the prompt the visible output belongs to. The screen
 * decides WHICH prompt (viewability + pickStickyFallback / resolveStickyPrompt
 * from @codecast/web/lib/messageNavigator); this component only paints it,
 * animates its arrival and departure, and reports its height so the screen
 * can grow the footer spacer under it.
 *
 * Gestures: tap the pill jumps to the prompt, tap the chevron expands the text
 * to six lines, a short swipe up dismisses the pill for that prompt.
 *
 * A `pending` prompt is the target of a jump whose window is still loading:
 * the pill names it with a spinner in the chevron slot and takes no gestures,
 * since the reader cannot act on a prompt that is not on screen yet.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, LayoutAnimation, PanResponder, Pressable, StyleSheet, View as RNView, type LayoutChangeEvent } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/Themed';
import { Theme, Spacing } from '@/constants/Theme';

export type StickyPrompt = { id: string; ordinal: number; text: string; pending?: boolean };

type Props = {
  prompt: StickyPrompt | null;
  // Overlay anchor below the header; the pill rides `translateY` with it.
  top: number;
  translateY: Animated.Value;
  onJump: (id: string) => void;
  onDismiss: (id: string) => void;
  onHeight: (height: number) => void;
};

const EXPANDED_LINES = 6;
// Matches the navigator sheet's row expansion so both surfaces open and close
// their clamped text with the same motion instead of snapping in one frame.
const EXPAND_ANIM_MS = 180;
function animateExpand() {
  LayoutAnimation.configureNext(
    LayoutAnimation.create(EXPAND_ANIM_MS, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity),
  );
}
const DISMISS_DISTANCE = 24;
const DISMISS_VELOCITY = 0.3; // px per ms, PanResponder units
const ENTER_MS = 180;
const EXIT_MS = 140;
const CROSSFADE_MS = 90;

// Single line pills read badly with the prompt's own line breaks; collapse
// whitespace for the collapsed state and keep the raw text once expanded.
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function StickyPromptBanner({ prompt, top, translateY, onJump, onDismiss, onHeight }: Props) {
  // The pill keeps painting the last prompt while it fades out, so the
  // rendered prompt lags the prop by one exit animation.
  const [shown, setShown] = useState<StickyPrompt | null>(prompt);
  const [expanded, setExpanded] = useState(false);
  const presence = useRef(new Animated.Value(prompt ? 1 : 0)).current;
  const textOpacity = useRef(new Animated.Value(1)).current;
  const dragY = useRef(new Animated.Value(0)).current;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const heightRef = useRef(0);

  const reportHeight = useCallback(
    (h: number) => {
      if (h === heightRef.current) return;
      heightRef.current = h;
      onHeight(h);
    },
    [onHeight],
  );

  // Arrival, departure and prompt to prompt swaps.
  useEffect(() => {
    const current = shownRef.current;
    if (prompt && !current) {
      setShown(prompt);
      setExpanded(false);
      dragY.setValue(0);
      textOpacity.setValue(1);
      Animated.timing(presence, { toValue: 1, duration: ENTER_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
      return;
    }
    if (!prompt && current) {
      const anim = Animated.timing(presence, { toValue: 0, duration: EXIT_MS, easing: Easing.in(Easing.cubic), useNativeDriver: true });
      anim.start(({ finished }) => {
        if (!finished) return;
        setShown(null);
        setExpanded(false);
        reportHeight(0);
      });
      return () => anim.stop();
    }
    if (prompt && current) {
      // A prompt that returned mid exit: bring the pill back before swapping.
      // An interrupted swipe dismiss leaves dragY partway up (its finished
      // guard skips the reset), so zero it here or the pill stays shifted.
      dragY.setValue(0);
      Animated.timing(presence, { toValue: 1, duration: ENTER_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
    if (prompt && current && prompt.id !== current.id) {
      // Crossfade the text in place: the pill stays mounted, only its copy
      // dips out and back with the new prompt.
      const anim = Animated.timing(textOpacity, { toValue: 0, duration: CROSSFADE_MS, useNativeDriver: true });
      anim.start(({ finished }) => {
        if (!finished) return;
        setShown(prompt);
        setExpanded(false);
        dragY.setValue(0);
        Animated.timing(textOpacity, { toValue: 1, duration: CROSSFADE_MS, useNativeDriver: true }).start();
      });
      return () => {
        anim.stop();
        // An interrupted fade (rapid id churn during a window load) must never
        // park the body near opacity 0; the next crossfade re-dips from 1.
        textOpacity.setValue(1);
      };
    }
    if (prompt && current && prompt.id === current.id && prompt !== current) {
      setShown(prompt);
    }
  }, [prompt, presence, textOpacity, dragY, reportHeight]);

  const dismiss = useCallback(() => {
    const id = shownRef.current?.id;
    if (!id) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Tell the parent NOW, not when the exit lands: a re-render during the
    // exit (the swipe usually also nudges the scroll) would hand the effect a
    // fresh prompt object with the same id, hit the "returned mid exit"
    // branch, and animate the pill straight back.
    onDismiss(id);
    Animated.parallel([
      Animated.timing(dragY, { toValue: -40, duration: EXIT_MS, useNativeDriver: true }),
      Animated.timing(presence, { toValue: 0, duration: EXIT_MS, useNativeDriver: true }),
    ]).start(({ finished }) => {
      if (!finished) return;
      setShown(null);
      setExpanded(false);
      dragY.setValue(0);
      reportHeight(0);
    });
  }, [dragY, presence, reportHeight, onDismiss]);

  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, gs) =>
        !shownRef.current?.pending && gs.dy < -6 && Math.abs(gs.dy) > Math.abs(gs.dx) * 1.5,
      onPanResponderMove: (_e, gs) => {
        dragY.setValue(Math.min(0, gs.dy));
      },
      onPanResponderRelease: (_e, gs) => {
        if (gs.dy < -DISMISS_DISTANCE || gs.vy < -DISMISS_VELOCITY) {
          dismissRef.current();
          return;
        }
        Animated.spring(dragY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(dragY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
      },
    }),
  ).current;

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      reportHeight(Math.round(e.nativeEvent.layout.height));
    },
    [reportHeight],
  );

  if (!shown) return null;

  const slideIn = presence.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] });
  const pending = shown.pending === true;
  const label = `${pending ? 'Loading prompt' : 'Prompt'} ${shown.ordinal}: ${shown.text}`;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        { top, opacity: presence, transform: [{ translateY }, { translateY: slideIn }, { translateY: dragY }] },
      ]}
    >
      <RNView style={styles.pillShadow} onLayout={handleLayout} {...responder.panHandlers}>
        <Pressable
          disabled={pending}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            onJump(shown.id);
          }}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={pending ? undefined : 'Jumps to this prompt'}
          accessibilityState={{ busy: pending }}
          // The pill flattens its children for VoiceOver, so the nested
          // chevron Pressable is unreachable and swipe up is the only dismiss
          // gesture; custom actions expose both on the pill itself.
          accessibilityActions={pending ? undefined : [
            { name: 'expand', label: expanded ? 'Collapse prompt' : 'Expand prompt' },
            { name: 'dismiss', label: 'Dismiss prompt' },
          ]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'expand') {
              animateExpand();
              setExpanded((v) => !v);
            } else if (e.nativeEvent.actionName === 'dismiss') dismiss();
          }}
          style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
        >
          <Animated.View style={[styles.body, { opacity: textOpacity }]}>
            <Text style={styles.ordinal}>#{shown.ordinal}</Text>
            <Text style={styles.text} numberOfLines={expanded ? EXPANDED_LINES : 1} ellipsizeMode="tail">
              {expanded ? shown.text.trim() : oneLine(shown.text)}
            </Text>
          </Animated.View>
          {pending ? (
            <RNView style={styles.chevron}>
              <ActivityIndicator size="small" color={Theme.textDim} />
            </RNView>
          ) : (
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                animateExpand();
                setExpanded((v) => !v);
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={expanded ? 'Collapse prompt' : 'Expand prompt'}
              style={styles.chevron}
            >
              <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={Theme.textDim} />
            </Pressable>
          )}
        </Pressable>
      </RNView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 56,
    paddingHorizontal: Spacing.md,
    paddingTop: 6,
  },
  pillShadow: {
    borderRadius: 12,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 7,
    // Fully opaque: message text bled through at 92% alpha; the shadow below
    // already separates the pill from the list.
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
  },
  pillPressed: {
    backgroundColor: Theme.bgHighlight,
  },
  body: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  ordinal: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
    color: Theme.blue,
  },
  text: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: Theme.text,
  },
  chevron: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
