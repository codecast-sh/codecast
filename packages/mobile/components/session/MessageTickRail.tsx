// Tick rail on the right edge of the session list: one hairline tick per
// prompt (already sampled by `sampleTicks`), the active prompt wider. Tap opens
// the navigator sheet; drag along the rail scrubs between prompts and jumps on
// release. The header list button lives here too so the screen wires both
// entry points from one import.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, TouchableOpacity, View, type AccessibilityActionEvent } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/Themed';
import { CHROME_FONT_CAP, Theme } from '@/constants/Theme';
import { MACHINE_KIND_LABEL, type HiddenKind, type NavigatorRow, type NavigatorTick } from '@codecast/web/lib/messageNavigator';

export const TICK_RAIL_WIDTH = 12;
const TICK_PITCH = 7;
const TICK_HEIGHT = 2;
const TICK_WIDTH = 6;
const ACTIVE_TICK_WIDTH = 12;
const SCRUB_THRESHOLD = 6;
// Keep the touch strip narrow (20pt total): the responder claims every
// vertical drag inside it, and the right edge is common thumb scroll space.
const RAIL_HIT_SLOP = { top: 16, bottom: 16, left: 8, right: 8 };

type Props = {
  ticks: NavigatorTick<NavigatorRow>[];
  // True prompt count from the full rows list: `ticks` is sampled to 24, so
  // counting its user rows undercounts the thread for the VoiceOver label.
  promptCount: number;
  activeMessageId: string | null;
  visible: boolean;
  onOpen: () => void;
  onScrub: (id: string | null) => void;
  onScrubEnd: (id: string) => void;
};

// Which tick a finger offset (relative to the rail's top) lands on.
function tickIndexAt(offsetY: number, count: number): number {
  if (count <= 0) return -1;
  return Math.max(0, Math.min(count - 1, Math.floor(offsetY / TICK_PITCH)));
}

function tickColor(row: NavigatorRow, active: boolean): string {
  if (active) return Theme.text;
  if (row.commentCount > 0) return Theme.cyan;
  if (row.kind !== 'user') return Theme.textMuted0 + '66';
  return Theme.textMuted;
}

export function MessageTickRail({ ticks, promptCount, activeMessageId, visible, onOpen, onScrub, onScrubEnd }: Props) {
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [scrubIndex, setScrubIndex] = useState(-1);
  const scrubIndexRef = useRef(-1);
  const scrubbingRef = useRef(false);
  const ticksRef = useRef(ticks);
  ticksRef.current = ticks;
  const callbacks = useRef({ onOpen, onScrub, onScrubEnd });
  callbacks.current = { onOpen, onScrub, onScrubEnd };

  useEffect(() => {
    Animated.timing(opacity, { toValue: visible ? 1 : 0, duration: visible ? 150 : 300, useNativeDriver: true }).start();
  }, [visible, opacity]);

  const setScrub = useCallback((index: number) => {
    if (index === scrubIndexRef.current) return;
    scrubIndexRef.current = index;
    setScrubIndex(index);
    const row = index >= 0 ? ticksRef.current[index]?.row : undefined;
    if (row) Haptics.selectionAsync();
    callbacks.current.onScrub(row ? row._id : null);
  }, []);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          scrubbingRef.current = false;
        },
        onPanResponderMove: (evt, gesture) => {
          if (!scrubbingRef.current && Math.abs(gesture.dy) < SCRUB_THRESHOLD) return;
          scrubbingRef.current = true;
          setScrub(tickIndexAt(evt.nativeEvent.locationY, ticksRef.current.length));
        },
        onPanResponderRelease: () => {
          const index = scrubIndexRef.current;
          const row = index >= 0 ? ticksRef.current[index]?.row : undefined;
          if (scrubbingRef.current && row) {
            callbacks.current.onScrubEnd(row._id);
          } else if (!scrubbingRef.current) {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            callbacks.current.onOpen();
          }
          scrubbingRef.current = false;
          setScrub(-1);
        },
        onPanResponderTerminate: () => {
          scrubbingRef.current = false;
          setScrub(-1);
        },
      }),
    [setScrub],
  );

  const activeIdRef = useRef(activeMessageId);
  activeIdRef.current = activeMessageId;

  // VoiceOver's adjust gesture (swipe up/down on the adjustable rail) steps to
  // the next/previous tick's prompt; increment moves toward the newest.
  const handleAccessibilityAction = useCallback((e: AccessibilityActionEvent) => {
    const name = e.nativeEvent.actionName;
    if (name !== 'increment' && name !== 'decrement') return;
    const list = ticksRef.current;
    if (list.length === 0) return;
    const current = list.findIndex((t) => t.active || t.row._id === activeIdRef.current);
    const next = name === 'increment'
      ? Math.min(list.length - 1, current < 0 ? list.length - 1 : current + 1)
      : Math.max(0, current < 0 ? 0 : current - 1);
    const row = list[next]?.row;
    if (row) callbacks.current.onScrubEnd(row._id);
  }, []);

  if (ticks.length < 2) return null;

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[styles.rail, { opacity, transform: [{ translateY: -(ticks.length * TICK_PITCH) / 2 }] }]}
      hitSlop={RAIL_HIT_SLOP}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={`${promptCount} prompts, open message list`}
      accessibilityHint="Drag to scrub between prompts"
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={handleAccessibilityAction}
      {...panResponder.panHandlers}
    >
      {ticks.map((tick, i) => {
        const active = scrubIndex >= 0 ? i === scrubIndex : tick.active || tick.row._id === activeMessageId;
        return (
          <View
            key={tick.row._id}
            // Never a hit target: the scrub reads locationY relative to the
            // touch TARGET, so a grab landing on a tick would report offsets
            // inside that tiny tick and pin the scrub to index 0.
            pointerEvents="none"
            style={[
              styles.tick,
              { backgroundColor: tickColor(tick.row, active), width: active ? ACTIVE_TICK_WIDTH : TICK_WIDTH },
            ]}
          />
        );
      })}
      {scrubIndex >= 0 && ticks[scrubIndex] && (
        <ScrubLabel row={ticks[scrubIndex].row} top={scrubIndex * TICK_PITCH - 12} />
      )}
    </Animated.View>
  );
}

// Floating callout while scrubbing: the target row is almost always outside
// the viewport (that is the point of the rail), so this is the only readable
// position feedback the finger gets. Anchored left of the rail at the active
// tick's y, inside the rail's Animated.View so it inherits the fade. No entry
// animation (it must track the finger instantly); it disappears with the
// scrub state on release.
function ScrubLabel({ row, top }: { row: NavigatorRow; top: number }) {
  const hidden = row.kind !== 'user';
  return (
    <View pointerEvents="none" style={[styles.scrubLabel, { top }]}>
      {hidden ? (
        <Text style={styles.scrubKind} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>
          {MACHINE_KIND_LABEL[row.kind as HiddenKind]}
        </Text>
      ) : (
        <>
          <Text style={styles.scrubOrdinal} maxFontSizeMultiplier={CHROME_FONT_CAP}>
            {`#${row.originalIndex + 1}`}
          </Text>
          {row.display.length > 0 && (
            <Text style={styles.scrubText} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>
              {row.display.slice(0, 24)}
            </Text>
          )}
        </>
      )}
    </View>
  );
}

// Header entry point: 34x34 like the screen's `headerIconBtn`. No visual
// badge — a count on a header icon reads as an unread indicator; the count
// only enriches the accessibility label.
export function MessageListButton({ count, onPress }: { count?: number; onPress: () => void }) {
  const label = count ? `${count} messages, open message list` : 'Open message list';
  return (
    <TouchableOpacity
      onPress={onPress}
      style={styles.headerBtn}
      hitSlop={{ top: 12, bottom: 12, left: 4, right: 4 }}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Feather name="list" size={17} color={Theme.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  rail: {
    position: 'absolute',
    right: 0,
    top: '50%',
    width: TICK_RAIL_WIDTH,
    alignItems: 'flex-end',
    // Each tick owns TICK_PITCH of height; the inline translateY shifts the
    // rail up by half its height so it sits centered on the list.
  },
  tick: {
    height: TICK_HEIGHT,
    marginVertical: (TICK_PITCH - TICK_HEIGHT) / 2,
    borderRadius: 1,
  },
  headerBtn: {
    width: 34,
    height: 34,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrubLabel: {
    position: 'absolute',
    right: TICK_RAIL_WIDTH + 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: 200,
    backgroundColor: Theme.bgAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  scrubOrdinal: {
    fontSize: 11,
    color: Theme.blue,
    fontVariant: ['tabular-nums'],
  },
  scrubText: {
    fontSize: 11,
    color: Theme.text,
    flexShrink: 1,
  },
  scrubKind: {
    fontSize: 11,
    color: Theme.violet,
  },
});
