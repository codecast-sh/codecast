// The Modern look's palette: the web's default theme, Verdigris, under the
// app's palette names. Under Modern the web paints Verdigris over Solarized
// ("Modern was not drawn for Solarized", packages/web/components/ThemeProvider
// .tsx), so the phone does too. The values are imported, never copied: when
// the web retunes Verdigris, the phone follows on its next update.
//
// Derived surfaces use the mixes the web's lib/theme/themeVars.ts makes over
// the same tokens, so a surface here is the colour the web computes.
import { DEFAULT_THEME } from '@codecast/web/lib/theme/builtinThemes';
import type { ThemePalette } from '@codecast/shared/contracts/theme';
import { mixHex } from './colorMix';
import type { ColorScheme, Palette } from './Theme';

type Token = keyof ThemePalette;

// Verdigris declares every token in both modes (modernPalette.test.ts holds
// that). A missing one falls back to a neutral rather than throwing: this
// module evaluates at boot, where a throw would roll an update back.
function tokens(p: ThemePalette | undefined, fallback: string): (t: Token) => string {
  return (t) => p?.[t] ?? fallback;
}

function modernPalette(scheme: ColorScheme): Palette {
  const dark = scheme === 'dark';
  const v = tokens(DEFAULT_THEME[scheme], dark ? '#000000' : '#ffffff');
  // The call pill and the recording notice sit on a dark surface in both
  // schemes (Classic gives them Solarized's base02 in both), with light text.
  const night = tokens(DEFAULT_THEME.dark, '#000000');
  const bg = v('bg');
  const bgAlt = v('bg-alt');
  const card = v('card');
  const border = v('border');
  const text = v('text');
  return {
    bg,
    bgAlt,
    // --sol-bg-inset and --sol-bg-highlight (themeVars DIRECT['bg-alt']).
    bgInset: mixHex(bg, 40, bgAlt),
    bgHighlight: mixHex(text, 6, bgAlt),
    card,
    // --sol-card-hover.
    cardHover: mixHex(text, 3, card),
    // Modern draws one hairline, --sol-border, for every rule.
    border,
    borderLight: border,
    text,
    // --sol-text-secondary.
    textSecondary: mixHex(text, 88, bg),
    // The web sets --sol-text-muted0 from text-muted as well.
    textMuted: v('text-muted'),
    textDim: v('text-dim'),
    textMuted0: v('text-muted'),
    // The one accent is the theme's cyan (--sol-class-cyan, app/globals.css
    // "the one accent"); amber keeps its own name.
    accent: v('cyan'),
    accentAmber: v('amber'),
    // Your own messages are a quiet tinted block, as on the web
    // (--cc-m-tint). The bubble draws this colour at 0x30 alpha over the page
    // (USER_BUBBLE_ALPHA in app/session/[id].tsx), about 6% ink in all; the
    // colour itself stays dark enough for the link icon drawn in it.
    userBubble: mixHex(text, 30, bg),
    userBubbleText: text,
    assistantBubble: night('bg-alt'),
    assistantBubbleText: night('text'),
    green: v('green'),
    greenBright: v('green'),
    yellow: v('yellow'),
    cyan: v('cyan'),
    magenta: v('magenta'),
    violet: v('violet'),
    orange: v('orange'),
    red: v('red'),
    blue: v('blue'),
    activeBadge: v('green'),
    activeBadgeText: dark ? bg : card,
    tabActive: text,
    tabInactive: v('text-dim'),
    // Near-white page, white cards.
    cardBg: card,
    cardBorder: border,
    inputBg: card,
    inputBorder: border,
    inputPlaceholder: v('text-dim'),
    headerBg: bgAlt,
    footerBg: bgAlt,
  };
}

export const ModernPalettes: Record<ColorScheme, Palette> = {
  light: modernPalette('light'),
  dark: modernPalette('dark'),
};
