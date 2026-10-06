// Long text that starts folded: clipped to a few lines behind a fade, with one
// toggle to read the rest. A phone shows little at once, so a long briefing
// (a decision's context, a machine-delivered message) should never push the
// thing to act on below the fold.
import { useRef, useState, type ReactNode } from 'react';
import { StyleSheet, TouchableOpacity, View as RNView, type LayoutChangeEvent } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';

function parseColor(c: string): [number, number, number, number] {
  if (c?.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
  }
  const m = c?.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s.trim()));
    return [p[0] || 0, p[1] || 0, p[2] || 0, p[3] ?? 1];
  }
  return [0, 0, 0, 0];
}

const GRADIENT_STEPS = 14;

/**
 * A vertical fade from the first color to the last, without a native module:
 * expo-linear-gradient's native side is missing from older binaries, and an
 * OTA bundle must run on them, so the fade is a stack of thin views.
 */
export function FadeGradient({ colors, style, children, pointerEvents }: { colors: string[]; style?: any; children?: ReactNode; pointerEvents?: 'none' | 'auto' | 'box-none' | 'box-only' }) {
  const [r1, g1, b1, a1] = parseColor(colors?.[0] ?? 'transparent');
  const [r2, g2, b2, a2] = parseColor(colors?.[colors.length - 1] ?? 'transparent');
  return (
    <RNView style={style} pointerEvents={pointerEvents}>
      <RNView style={StyleSheet.absoluteFill}>
        {Array.from({ length: GRADIENT_STEPS }).map((_, i) => {
          const t = i / (GRADIENT_STEPS - 1);
          const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
          return <RNView key={i} style={{ flex: 1, backgroundColor: `rgba(${mix(r1, r2)},${mix(g1, g2)},${mix(b1, b2)},${a1 + (a2 - a1) * t})` }} />;
        })}
      </RNView>
      {children}
    </RNView>
  );
}

/**
 * Children clipped to `height` behind a fade into `fadeColor`, with a toggle
 * when they overflow. Yoga pushes the clip's maxHeight down into the child, so
 * once clipped the child re-reports the clipped height; latching the tallest
 * height ever measured keeps that from flipping the clip on and off.
 */
export function CollapsibleBody({ fadeColor, height = 160, labels = ['Show all', 'Show less'], children }: {
  fadeColor: string;
  height?: number;
  labels?: [string, string];
  children: ReactNode;
}) {
  const Theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const naturalHeight = useRef(0);
  const onLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h <= naturalHeight.current) return;
    naturalHeight.current = h;
    setOverflows(h > height + 8);
  };
  const clipped = overflows && !expanded;
  return (
    <RNView>
      <RNView style={clipped ? { maxHeight: height, overflow: 'hidden' } : undefined}>
        <RNView onLayout={onLayout}>{children}</RNView>
        {clipped && <FadeGradient colors={[fadeColor + '00', fadeColor]} style={styles.fade} pointerEvents="none" />}
      </RNView>
      {overflows && (
        <TouchableOpacity onPress={() => setExpanded((e) => !e)} style={styles.toggle} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Feather name={expanded ? 'chevron-up' : 'chevron-down'} size={12} color={Theme.textDim} />
          <RNText style={styles.toggleText}>{expanded ? labels[1] : labels[0]}</RNText>
        </TouchableOpacity>
      )}
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  fade: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 44 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  toggleText: { fontSize: 12, color: Theme.textDim },
}));
