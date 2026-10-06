// Hosted mode's parts on the phone (plan pl-840, docs/architecture/
// hosted-assistant.md "The mode"): the assistant's conversation, its
// approvals, the plan and the mail connection, drawn in codecast's own
// palette and face so they read as the same app as the inbox around them.
// Each colour here is named for what it means, once, over the app palette
// (constants/Theme): the hosted parts never name a palette colour directly.
import { StyleSheet } from 'react-native';
import { BorderRadius, Palettes, themedStyles, useActiveScheme, type ColorScheme, type Palette } from '@/constants/Theme';
import { mixColor } from '@/lib/solColor';

function buildHostedColors(t: Palette) {
  return {
    paper: t.bg,
    sheet: t.card,
    sheet2: t.bgInset,
    hover: t.bgHighlight,
    ink: t.text,
    ink2: t.textSecondary,
    soft: t.textMuted,
    faint: t.textMuted0,
    line: t.borderLight,
    lineStrong: t.border,
    // The yes, a send, a link: the app's action blue, as on the decision screen.
    accent: t.blue,
    accentPressed: mixColor(t.blue, 84, t.text),
    onSolid: '#ffffff',
    // What waits on the person: an approval's label and edge, a routine in trouble.
    attention: t.orange,
    attentionWash: mixColor(t.orange, 12, 'transparent'),
    attentionLine: mixColor(t.orange, 45, 'transparent'),
    // The assistant at work: dots and a running step, in quiet ink.
    working: t.textMuted,
    // A neutral wash (the meter's track, quiet chips) and the calmest fill (notes).
    wash: mixColor(t.text, 8, 'transparent'),
    quiet: mixColor(t.text, 5, 'transparent'),
    ok: t.green,
    danger: t.red,
    dangerWash: mixColor(t.red, 10, 'transparent'),
  };
}

export type HostedColors = ReturnType<typeof buildHostedColors>;

const COLORS: Record<ColorScheme, HostedColors> = {
  light: buildHostedColors(Palettes.light),
  dark: buildHostedColors(Palettes.dark),
};

/** The two radii the hosted parts use: buttons and drafts, cards and lists. */
export const HOSTED_RADIUS_SM = BorderRadius.md;
export const HOSTED_RADIUS = BorderRadius.lg;

export const hostedStyles = themedStyles((t) => {
  const c = buildHostedColors(t);
  return StyleSheet.create({
    lede: { fontSize: 13.5, lineHeight: 20, color: c.soft },
    section: { marginTop: 26 },
    sectionHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginBottom: 10 },
    sectionTitle: { fontSize: 13, fontWeight: '600', letterSpacing: 0.2, color: c.ink },
    count: { fontSize: 12, color: c.faint, fontVariant: ['tabular-nums'] },
    muted: { color: c.soft },
    faint: { color: c.faint },
    card: { borderRadius: HOSTED_RADIUS, backgroundColor: c.sheet, borderWidth: StyleSheet.hairlineWidth, borderColor: c.line },
    list: { borderRadius: HOSTED_RADIUS, backgroundColor: c.sheet, borderWidth: StyleSheet.hairlineWidth, borderColor: c.line, overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 15 },
    rowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    rowMain: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: 14, fontWeight: '500', color: c.ink },
    rowSub: { fontSize: 12.5, lineHeight: 18, color: c.soft, marginTop: 2 },
    rowAside: { fontSize: 12, color: c.soft, fontVariant: ['tabular-nums'] },
    trouble: { color: c.attention },
    empty: { paddingVertical: 20, paddingHorizontal: 17, borderWidth: 1, borderStyle: 'dashed', borderColor: c.lineStrong, borderRadius: HOSTED_RADIUS },
    emptyText: { color: c.soft, fontSize: 13.5, textAlign: 'center', lineHeight: 20 },
    callout: { flexDirection: 'row', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: HOSTED_RADIUS, backgroundColor: c.quiet },
    calloutAttention: { backgroundColor: c.attentionWash },
    calloutText: { flex: 1, fontSize: 13, lineHeight: 19, color: c.ink2 },
    pill: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2, paddingHorizontal: 8, borderRadius: 999, backgroundColor: c.wash },
    pillText: { fontSize: 11, fontWeight: '600', color: c.ink2 },
    pillOffText: { color: c.soft },
  });
});

/** The hosted palette and shared styles, re-rendering on an appearance flip. */
export function useHostedTheme(): { c: HostedColors; s: typeof hostedStyles } {
  return { c: COLORS[useActiveScheme()], s: hostedStyles };
}
