// The assistant lane's look on the phone (plan pl-840), the same family look
// as the web lane's simple.css and Whisk: every colour, face and radius comes
// from @platform/design, so a person moving between the lane on the web, the
// lane on the phone and their mail reads one product. Warm paper, warm ink,
// Instrument Sans for the interface, Newsreader for titles and for what the
// assistant writes, and one vermilion accent spent only on what needs the
// person and on the yes. The assistant at work moves in quiet ink. Light and
// dark follow the app's appearance switch.
import { Platform, StyleSheet } from 'react-native';
import { Easing } from 'react-native-reanimated';
import { MOTION_CURVE, PALETTE, SHAPE } from '@platform/design';
import { schemedStyles, useActiveScheme, type ColorScheme } from '@/constants/Theme';
import type { FaceSet } from '@/constants/fonts';
import { mixColor } from '@/lib/solColor';
import { resolveLaneTokens } from '@codecast/web/components/simple/laneTokens';

/** Interface words (FONTS.ui), registered under these keys by the lane layout
 *  (useFonts). Bold reads as semibold (web's prose bold is 640) and italic as
 *  regular: the interface is never set in italic. */
export const LANE_FACES: FaceSet = {
  regular: 'InstrumentSans',
  medium: 'InstrumentSans-Medium',
  semiBold: 'InstrumentSans-SemiBold',
  bold: 'InstrumentSans-SemiBold',
  italic: 'InstrumentSans',
};

/** Reading (FONTS.read): titles, the assistant's words and every draft, the
 *  way a letter reads in Whisk. Provided to a subtree by LaneUI's Reading. */
export const LANE_READ_FACES: FaceSet = {
  regular: 'Newsreader',
  medium: 'Newsreader-Medium',
  semiBold: 'Newsreader-SemiBold',
  bold: 'Newsreader-SemiBold',
  italic: 'Newsreader-Italic',
};

/** The wordmark's face (web .sl-brand: Newsreader italic). */
export const LANE_BRAND_FACE = 'Newsreader-MediumItalic';

/** Figures and counts (FONTS.mono). */
export const LANE_MONO_FACE = 'FragmentMono';

export const LANE_FONT_ASSETS = {
  [LANE_FACES.regular]: require('../../assets/fonts/InstrumentSans-Regular.ttf'),
  [LANE_FACES.medium]: require('../../assets/fonts/InstrumentSans-Medium.ttf'),
  [LANE_FACES.semiBold]: require('../../assets/fonts/InstrumentSans-SemiBold.ttf'),
  [LANE_READ_FACES.regular]: require('../../assets/fonts/Newsreader-Regular.ttf'),
  [LANE_READ_FACES.medium]: require('../../assets/fonts/Newsreader-Medium.ttf'),
  [LANE_READ_FACES.semiBold]: require('../../assets/fonts/Newsreader-SemiBold.ttf'),
  [LANE_READ_FACES.italic]: require('../../assets/fonts/Newsreader-Italic.ttf'),
  [LANE_BRAND_FACE]: require('../../assets/fonts/Newsreader-MediumItalic.ttf'),
  [LANE_MONO_FACE]: require('../../assets/fonts/FragmentMono-Regular.ttf'),
};

/** simple.css's --sl-ease, the family's curve (MOTION_CURVE): every lane
 *  motion on the phone is drawn on it, as on the web and in Whisk. */
export const LANE_EASE = Easing.bezier(...MOTION_CURVE);

/** simple.css's radii, the family's two: --sl-radius-sm (buttons, tabs,
 *  drafts) and --sl-radius (cards, lists, sheets, bubbles). */
export const LANE_RADIUS_SM = parseFloat(SHAPE.radius);
export const LANE_RADIUS = parseFloat(SHAPE.radiusLg);

/** simple.css's --sl-* names as colours native views paint, computed from
 *  the one table both lanes read (web components/simple/laneTokens.ts). */
function buildLaneColors(scheme: ColorScheme) {
  return resolveLaneTokens(PALETTE[scheme], mixColor);
}

export type LaneColors = ReturnType<typeof buildLaneColors>;

const COLORS: Record<ColorScheme, LaneColors> = { light: buildLaneColors('light'), dark: buildLaneColors('dark') };

export function laneColors(scheme: ColorScheme): LaneColors {
  return COLORS[scheme];
}

/** --sl-shadow: a hairline under a sheet and a soft drop. */
function shadow(c: LaneColors, lift = false) {
  return Platform.select({
    ios: { shadowColor: c.ink, shadowOffset: { width: 0, height: lift ? 14 : 8 }, shadowOpacity: lift ? 0.14 : 0.07, shadowRadius: lift ? 22 : 14 },
    default: { elevation: lift ? 4 : 1 },
  });
}

export const laneStyles = schemedStyles((scheme) => {
  const c = laneColors(scheme);
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.paper },
    content: { paddingHorizontal: 18 },
    hello: { fontFamily: LANE_READ_FACES.medium, fontSize: 37, lineHeight: 40, letterSpacing: -0.4, color: c.ink, marginTop: 14, marginBottom: 6 },
    pageTitle: { fontFamily: LANE_READ_FACES.semiBold, fontSize: 31, lineHeight: 35, letterSpacing: -0.25, color: c.ink, marginTop: 14, marginBottom: 5 },
    lede: { fontSize: 16.5, lineHeight: 24, color: c.soft, marginBottom: 20, maxWidth: 480 },
    section: { marginTop: 32 },
    sectionHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 12 },
    sectionTitle: { fontSize: 16.5, fontWeight: '600', letterSpacing: -0.1, color: c.ink },
    count: { fontFamily: LANE_MONO_FACE, fontSize: 12.5, color: c.faint, fontVariant: ['tabular-nums'] },
    sectionLink: { marginLeft: 'auto', fontSize: 14, fontWeight: '500', color: c.soft },
    muted: { color: c.soft },
    faint: { color: c.faint },
    card: { borderRadius: LANE_RADIUS, backgroundColor: c.sheet, borderWidth: 1, borderColor: c.line, ...shadow(c) },
    list: { borderRadius: LANE_RADIUS, backgroundColor: c.sheet, borderWidth: 1, borderColor: c.line, overflow: 'hidden', ...shadow(c) },
    row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 15, paddingHorizontal: 17 },
    rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.lineStrong },
    rowMain: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: 16, fontWeight: '500', color: c.ink },
    rowSub: { fontSize: 14, color: c.soft, marginTop: 2 },
    rowAside: { fontSize: 12.5, color: c.soft, fontVariant: ['tabular-nums'] },
    trouble: { color: c.accentText },
    empty: { paddingVertical: 22, paddingHorizontal: 19, borderWidth: 1, borderStyle: 'dashed', borderColor: c.lineStrong, borderRadius: LANE_RADIUS },
    emptyText: { color: c.soft, fontSize: 15, textAlign: 'center', lineHeight: 22 },
    callout: { flexDirection: 'row', gap: 11, paddingVertical: 14, paddingHorizontal: 16, borderRadius: LANE_RADIUS, backgroundColor: c.quiet },
    calloutAccent: { backgroundColor: c.accentWash },
    calloutText: { flex: 1, fontSize: 14.5, lineHeight: 21, color: c.ink2 },
    pill: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2, paddingHorizontal: 9, borderRadius: 999, backgroundColor: c.wash },
    pillText: { fontSize: 12, fontWeight: '600', color: c.mark },
    pillOff: { backgroundColor: c.wash },
    pillOffText: { color: c.soft },
  });
});

/** The lane's palette and shared styles, re-rendering on an appearance flip. */
export function useLaneTheme(): { c: LaneColors; s: typeof laneStyles; scheme: ColorScheme } {
  const scheme = useActiveScheme();
  return { c: laneColors(scheme), s: laneStyles, scheme };
}
