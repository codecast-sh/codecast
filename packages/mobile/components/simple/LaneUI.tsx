// The lane's small parts on the phone, each the native twin of a simple.css
// class: the page with its atmosphere (.sl-frame and its corner light), the
// staggered rise every block enters with (.sl-rise), buttons (.sl-btn), the
// state dot (.sl-dot), pills, callouts and section heads.
import { useEffect, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, FadeInDown, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { mixColor } from '@/lib/solColor';
import { Text } from '@/components/Themed';
import type { ConversationState } from '@codecast/web/components/simple/lane';
import { useLaneTheme, type LaneColors } from './laneTheme';

/** One block entering: up and in, each a beat after the one before. */
export function Rise({ i = 0, style, children }: { i?: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  return (
    <Animated.View entering={FadeInDown.duration(420).delay(Math.min(i, 8) * 55).easing(Easing.bezier(0.2, 0.7, 0.2, 1))} style={style}>
      {children}
    </Animated.View>
  );
}

/** A tide pool of light in one corner, a warm blush in the other. */
function Atmosphere({ c }: { c: LaneColors }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="tide" cx="0%" cy="0%" rx="95%" ry="45%">
            <Stop offset="0" stopColor={c.tide} stopOpacity={0.14} />
            <Stop offset="1" stopColor={c.tide} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="sun" cx="105%" cy="100%" rx="85%" ry="40%">
            <Stop offset="0" stopColor={c.sun} stopOpacity={0.1} />
            <Stop offset="1" stopColor={c.sun} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id="hay" cx="88%" cy="0%" rx="55%" ry="22%">
            <Stop offset="0" stopColor={c.yellow} stopOpacity={0.07} />
            <Stop offset="1" stopColor={c.yellow} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#tide)" />
        <Rect width="100%" height="100%" fill="url(#sun)" />
        <Rect width="100%" height="100%" fill="url(#hay)" />
      </Svg>
    </View>
  );
}

/** A lane page: the paper, its light, and a scroller with the lane's margins. */
export function LanePage({ children, bottomInset = 0, ...scroll }: ScrollViewProps & { bottomInset?: number }) {
  const { c, s } = useLaneTheme();
  const top = useSafeAreaInsets().top;
  return (
    <View style={s.screen}>
      <Atmosphere c={c} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        {...scroll}
        contentContainerStyle={[s.content, { paddingBottom: 28 + bottomInset }, scroll.contentContainerStyle]}
      >
        {children}
      </ScrollView>
      {/* The status bar's own strip of paper, so a scrolled page never runs under the clock. */}
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: top, backgroundColor: mixColor(c.paper, 92, 'transparent') }} />
    </View>
  );
}

/** The page's background alone, for screens that lay out their own scroller. */
export function LanePaper({ children }: { children: ReactNode }) {
  const { c, s } = useLaneTheme();
  return (
    <View style={s.screen}>
      <Atmosphere c={c} />
      {children}
    </View>
  );
}

export type ButtonTone = 'yes' | 'plain' | 'no' | 'danger';

export function LaneButton({
  label,
  tone = 'plain',
  small = false,
  disabled = false,
  onPress,
  hint,
  style,
}: {
  label: string;
  tone?: ButtonTone;
  small?: boolean;
  disabled?: boolean;
  onPress: () => void;
  /** Read aloud after the label: what the answer means. */
  hint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useLaneTheme();
  const look = {
    yes: { bg: c.tideSolid, fg: c.onTide, border: 'transparent' },
    plain: { bg: c.sheet, fg: c.ink, border: c.lineStrong },
    no: { bg: 'transparent', fg: c.soft, border: 'transparent' },
    danger: { bg: 'transparent', fg: c.rose, border: 'transparent' },
  }[tone];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        if (tone === 'yes') void Haptics.selectionAsync().catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        {
          minHeight: small ? 36 : 44,
          paddingHorizontal: small ? 14 : 18,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: look.border,
          backgroundColor: !pressed ? look.bg : tone === 'yes' ? c.tideSolidPressed : c.inkWash,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.45 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
        style,
      ]}
    >
      <Text style={{ color: look.fg, fontSize: small ? 14 : 15.5, fontWeight: '600' }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A conversation's state as a dot: apricot waits on you, teal works and ripples. */
export function StateDot({ state }: { state: ConversationState }) {
  const { c } = useLaneTheme();
  const ripple = useSharedValue(0);
  useEffect(() => {
    ripple.value = state === 'working' ? withRepeat(withTiming(1, { duration: 1800, easing: Easing.bezier(0.2, 0.7, 0.2, 1) }), -1, false) : 0;
  }, [state, ripple]);
  const ring = useAnimatedStyle(() => ({ opacity: state === 'working' ? 0.55 * (1 - ripple.value) : 0, transform: [{ scale: 1 + ripple.value * 0.9 }] }));
  const color = state === 'waiting' ? c.sun : state === 'working' ? c.tide : c.lineStrong;
  return (
    <View style={{ width: 18, height: 18, alignItems: 'center', justifyContent: 'center' }}>
      {state === 'waiting' ? <View style={{ position: 'absolute', width: 18, height: 18, borderRadius: 9, backgroundColor: c.sunWash }} /> : null}
      <Animated.View style={[{ position: 'absolute', width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: c.tide }, ring]} />
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
    </View>
  );
}

/** "On it": three teal dots hopping in turn. */
export function WorkingDots() {
  const { c } = useLaneTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {[0, 1, 2].map((n) => <Hop key={n} delay={n * 150} color={c.tide} />)}
    </View>
  );
}

function Hop({ delay, color }: { delay: number; color: string }) {
  const y = useSharedValue(0);
  useEffect(() => {
    y.value = withDelay(delay, withRepeat(withTiming(1, { duration: 600, easing: Easing.inOut(Easing.quad) }), -1, true));
  }, [delay, y]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: -3 * y.value }], opacity: 0.45 + 0.55 * y.value }));
  return <Animated.View style={[{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }, style]} />;
}

export function Pill({ label, off = false, sun = false }: { label: string; off?: boolean; sun?: boolean }) {
  const { c, s } = useLaneTheme();
  return (
    <View style={[s.pill, off && s.pillOff, sun && { backgroundColor: c.sunWash }]}>
      <Text style={[s.pillText, off && s.pillOffText, sun && { color: c.sunInk }]}>{label}</Text>
    </View>
  );
}

export function Callout({ icon, sun = false, children, style }: { icon?: ReactNode; sun?: boolean; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { s } = useLaneTheme();
  return (
    <View style={[s.callout, sun && s.calloutSun, style]}>
      {icon ? <View style={{ marginTop: 1 }}>{icon}</View> : null}
      <Text style={s.calloutText}>{children}</Text>
    </View>
  );
}

export function SectionHead({ title, count, action }: { title: string; count?: number; action?: { label: string; onPress: () => void } }) {
  const { s } = useLaneTheme();
  return (
    <View style={s.sectionHead}>
      <Text style={s.sectionTitle} accessibilityRole="header">{title}</Text>
      {count !== undefined ? <Text style={s.count}>{count}</Text> : null}
      {action ? (
        <Text style={s.sectionLink} onPress={action.onPress} accessibilityRole="link" suppressHighlighting={false}>
          {action.label}
        </Text>
      ) : null}
    </View>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  const { s } = useLaneTheme();
  return (
    <View style={s.empty}>
      <Text style={s.emptyText}>{children}</Text>
    </View>
  );
}

/** A row in a list card: pressable, with a hairline above every row but the first. */
export function LaneRow({ first, onPress, children, label }: { first: boolean; onPress?: () => void; children: ReactNode; label?: string }) {
  const { c, s } = useLaneTheme();
  if (!onPress) return <View style={[s.row, !first && s.rowRule]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [s.row, !first && s.rowRule, pressed && { backgroundColor: c.tideWash }]}
    >
      {children}
    </Pressable>
  );
}
