// Hosted mode's small parts on the phone: the rise each block enters with,
// buttons, the working dots, pills, callouts, section heads, list rows and
// the empty line. The conversation, its approvals, the plan and the mail
// connection are built from them (hostedTheme.ts names their colours).
import { useEffect, type ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, FadeInDown, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { MOTION_CURVE } from '@platform/design';
import { Text } from '@/components/Themed';
import { HOSTED_RADIUS_SM, useHostedTheme } from './hostedTheme';

/** The family's curve (@platform/design MOTION_CURVE), shared with the web and Whisk. */
export const HOSTED_EASE = Easing.bezier(...MOTION_CURVE);

/** One block entering: up and in, each a beat after the one before. */
export function Rise({ i = 0, style, children }: { i?: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  return (
    <Animated.View entering={FadeInDown.duration(420).delay(Math.min(i, 8) * 60).easing(HOSTED_EASE)} style={style}>
      {children}
    </Animated.View>
  );
}

export type ButtonTone = 'yes' | 'plain' | 'no' | 'danger';

export function HostedButton({
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
  const { c } = useHostedTheme();
  const look = {
    yes: { bg: c.accent, fg: c.onSolid, border: 'transparent', pressed: c.accentPressed },
    plain: { bg: c.sheet, fg: c.ink, border: c.lineStrong, pressed: c.hover },
    no: { bg: 'transparent', fg: c.soft, border: 'transparent', pressed: c.wash },
    danger: { bg: 'transparent', fg: c.danger, border: 'transparent', pressed: c.dangerWash },
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
          minHeight: small ? 34 : 42,
          paddingHorizontal: small ? 12 : 16,
          borderRadius: HOSTED_RADIUS_SM,
          borderWidth: 1,
          borderColor: look.border,
          backgroundColor: pressed ? look.pressed : look.bg,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.45 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
        style,
      ]}
    >
      <Text style={{ color: look.fg, fontSize: small ? 13 : 14, fontWeight: '600' }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** The assistant at work: three quiet dots hopping in turn. */
export function WorkingDots() {
  const { c } = useHostedTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {[0, 1, 2].map((n) => <Hop key={n} delay={n * 150} color={c.working} />)}
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

/** A small state word; `off` when the thing it names is not on. */
export function Pill({ label, off = false }: { label: string; off?: boolean }) {
  const { s } = useHostedTheme();
  return (
    <View style={s.pill}>
      <Text style={[s.pillText, off && s.pillOffText]}>{label}</Text>
    </View>
  );
}

/** A note on the page; `attention` when it needs the person. */
export function Callout({ icon, attention = false, children, style }: { icon?: ReactNode; attention?: boolean; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { s } = useHostedTheme();
  return (
    <View style={[s.callout, attention && s.calloutAttention, style]}>
      {icon ? <View style={{ marginTop: 1 }}>{icon}</View> : null}
      <Text style={s.calloutText}>{children}</Text>
    </View>
  );
}

export function SectionHead({ title, count }: { title: string; count?: number }) {
  const { s } = useHostedTheme();
  return (
    <View style={s.sectionHead}>
      <Text style={s.sectionTitle} accessibilityRole="header">{title}</Text>
      {count !== undefined ? <Text style={s.count}>{count}</Text> : null}
    </View>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  const { s } = useHostedTheme();
  return (
    <View style={s.empty}>
      <Text style={s.emptyText}>{children}</Text>
    </View>
  );
}

/** A row in a list card: pressable, with a hairline above every row but the first. */
export function HostedRow({ first, onPress, children, label }: { first: boolean; onPress?: () => void; children: ReactNode; label?: string }) {
  const { c, s } = useHostedTheme();
  if (!onPress) return <View style={[s.row, !first && s.rowRule]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [s.row, !first && s.rowRule, pressed && { backgroundColor: c.hover }]}
    >
      {children}
    </Pressable>
  );
}
