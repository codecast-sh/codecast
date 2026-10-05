// The assistant lane's look on the phone (plan pl-840), the same voice as the
// web lane's simple.css: one warm grotesque (Bricolage Grotesque) at every
// size, a teal that means "the assistant is on it", an apricot that means
// "this needs you", and paper surfaces with soft depth. Every colour derives
// from the app palette the way simple.css derives from the --sol-* tokens, so
// the appearance switch carries through.
import { Platform, StyleSheet } from 'react-native';
import { themedStyles, useTheme, type Palette } from '@/constants/Theme';
import type { FaceSet } from '@/constants/fonts';
import { mixColor } from '@/lib/solColor';

/** The lane's faces, registered under these keys by the lane layout
 *  (useFonts). Bricolage ships 400, 500 and 600 at text size; bold reads as
 *  semibold (web's prose bold is 640) and italic as regular. */
export const LANE_FACES: FaceSet = {
  regular: 'Bricolage',
  medium: 'Bricolage-Medium',
  semiBold: 'Bricolage-SemiBold',
  bold: 'Bricolage-SemiBold',
  italic: 'Bricolage',
};

/** The display cut (optical size 96) for the big greeting and page titles. */
export const LANE_DISPLAY_FACE = 'Bricolage-Display';

export const LANE_FONT_ASSETS = {
  [LANE_FACES.regular]: require('../../assets/fonts/BricolageGrotesque-Regular.ttf'),
  [LANE_FACES.medium]: require('../../assets/fonts/BricolageGrotesque-Medium.ttf'),
  [LANE_FACES.semiBold]: require('../../assets/fonts/BricolageGrotesque-SemiBold.ttf'),
  [LANE_DISPLAY_FACE]: require('../../assets/fonts/BricolageGrotesque-Display.ttf'),
};

/** simple.css's tokens, as hex for native views. */
export function laneColors(t: Palette) {
  return {
    paper: mixColor(t.bg, 72, t.card),
    sheet: t.card,
    sheet2: mixColor(t.card, 82, t.bg),
    ink: t.text,
    ink2: t.textSecondary,
    soft: t.textMuted,
    faint: mixColor(t.textDim, 85, 'transparent'),
    line: mixColor(t.border, 30, 'transparent'),
    lineStrong: mixColor(t.border, 55, 'transparent'),
    tide: t.cyan,
    // The fill behind words (the yes button, send, the tab badge): plain
    // tide under text stays near 3:1, so it is deepened the way simple.css's
    // --sl-tide-solid is, under the same light paper ink (--sl-on-tide).
    tideSolid: mixColor(t.cyan, 64, '#002b36'),
    tideSolidPressed: mixColor(mixColor(t.cyan, 64, '#002b36'), 86, '#002b36'),
    tideInk: mixColor(t.cyan, 78, t.text),
    tideWash: mixColor(t.cyan, 11, 'transparent'),
    tideWash2: mixColor(t.cyan, 20, 'transparent'),
    sun: t.orange,
    // The sun behind words (the tab badge), deepened like tideSolid and
    // simple.css's --sl-sun-solid: 5.3:1 under onTide, where plain sun is 4.3:1.
    sunSolid: mixColor(t.orange, 85, '#002b36'),
    sunInk: mixColor(t.orange, 82, t.text),
    sunWash: mixColor(t.orange, 10, 'transparent'),
    sunLine: mixColor(t.orange, 38, 'transparent'),
    moss: t.green,
    rose: t.red,
    roseWash: mixColor(t.red, 10, 'transparent'),
    inkWash: mixColor(t.text, 6, 'transparent'),
    onTide: '#fdf6e3',
    yellow: t.yellow,
  };
}

export type LaneColors = ReturnType<typeof laneColors>;

const RADIUS = 20;

function shadow(t: Palette, lift = false) {
  return Platform.select({
    ios: { shadowColor: t.text, shadowOffset: { width: 0, height: lift ? 14 : 8 }, shadowOpacity: lift ? 0.14 : 0.08, shadowRadius: lift ? 22 : 16 },
    default: { elevation: lift ? 4 : 1 },
  });
}

export const laneStyles = themedStyles((t) => {
  const c = laneColors(t);
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.paper },
    content: { paddingHorizontal: 18 },
    hello: { fontFamily: LANE_DISPLAY_FACE, fontSize: 36, lineHeight: 39, letterSpacing: -0.8, color: c.ink, marginTop: 14, marginBottom: 6 },
    pageTitle: { fontFamily: LANE_DISPLAY_FACE, fontSize: 30, lineHeight: 34, letterSpacing: -0.6, color: c.ink, marginTop: 14, marginBottom: 5 },
    lede: { fontSize: 16.5, lineHeight: 24, color: c.soft, marginBottom: 20, maxWidth: 480 },
    section: { marginTop: 32 },
    sectionHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 12 },
    sectionTitle: { fontSize: 16.5, fontWeight: '600', letterSpacing: -0.15, color: c.ink },
    count: { fontSize: 16.5, fontWeight: '500', color: c.faint, fontVariant: ['tabular-nums'] },
    sectionLink: { marginLeft: 'auto', fontSize: 14, fontWeight: '500', color: c.soft },
    muted: { color: c.soft },
    faint: { color: c.faint },
    card: { borderRadius: RADIUS, backgroundColor: c.sheet, borderWidth: 1, borderColor: c.line, ...shadow(t) },
    list: { borderRadius: RADIUS, backgroundColor: c.sheet, borderWidth: 1, borderColor: c.line, overflow: 'hidden', ...shadow(t) },
    row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 15, paddingHorizontal: 17 },
    rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.lineStrong },
    rowMain: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: 16, fontWeight: '500', color: c.ink, letterSpacing: -0.08 },
    rowSub: { fontSize: 14, color: c.soft, marginTop: 2 },
    rowAside: { fontSize: 12.5, color: c.soft, fontVariant: ['tabular-nums'] },
    trouble: { color: c.sunInk },
    empty: { paddingVertical: 22, paddingHorizontal: 19, borderWidth: 1, borderStyle: 'dashed', borderColor: c.lineStrong, borderRadius: RADIUS },
    emptyText: { color: c.soft, fontSize: 15, textAlign: 'center', lineHeight: 22 },
    callout: { flexDirection: 'row', gap: 11, paddingVertical: 14, paddingHorizontal: 16, borderRadius: 16, backgroundColor: c.inkWash },
    calloutSun: { backgroundColor: c.sunWash },
    calloutText: { flex: 1, fontSize: 14.5, lineHeight: 21, color: c.ink2 },
    pill: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2, paddingHorizontal: 9, borderRadius: 999, backgroundColor: c.tideWash },
    pillText: { fontSize: 12, fontWeight: '600', color: c.tideInk },
    pillOff: { backgroundColor: c.inkWash },
    pillOffText: { color: c.soft },
  });
});

/** The lane's palette and shared styles, re-rendering on an appearance flip. */
export function useLaneTheme(): { c: LaneColors; s: typeof laneStyles } {
  const t = useTheme();
  return { c: laneColors(t), s: laneStyles };
}
