import { StyleSheet } from 'react-native';
import { useSyncExternalStore } from 'react';

export const SolarizedLight = {
  bg: '#FBF5E2',
  bgAlt: '#eee8d5',
  // Inset panel surface (tool output, code blocks) — web --sol-bg-inset,
  // the color-mix(bg 40%, bg-alt) result baked to a hex.
  bgInset: '#f3edda',
  bgHighlight: '#e4ddc8',
  // Elevated card surface — web --sol-card: pure white lifts pills/cards off
  // the cream page background.
  card: '#ffffff',
  cardHover: '#fffdf6',
  border: '#93a1a1',
  borderLight: '#c5c8c6',

  text: '#002b36',
  textSecondary: '#073642',
  textMuted: '#586e75',
  textDim: '#657b83',
  textMuted0: '#839496',

  accent: '#b58900',
  accentAmber: '#d97706',

  userBubble: '#268bd2',
  userBubbleText: '#ffffff',

  assistantBubble: '#073642',
  assistantBubbleText: '#fdf6e3',

  green: '#859900',
  greenBright: '#10b981',
  yellow: '#b58900',
  cyan: '#2aa198',
  magenta: '#d33682',
  violet: '#6c71c4',
  orange: '#cb4b16',
  red: '#dc322f',
  blue: '#268bd2',

  activeBadge: '#10b981',
  activeBadgeText: '#ffffff',

  tabActive: '#002b36',
  tabInactive: '#839496',

  cardBg: '#eee8d5',
  cardBorder: '#c5c8c6',

  inputBg: '#FBF5E2',
  inputBorder: '#93a1a1',
  inputPlaceholder: '#839496',

  headerBg: '#eee8d5',
  footerBg: '#eee8d5',
};

export const SolarizedDark = {
  bg: '#002b36',
  bgAlt: '#073642',
  bgInset: '#04323d',
  bgHighlight: '#094959',
  card: '#08404e',
  cardHover: '#0a4c5d',
  border: '#586e75',
  borderLight: '#094959',

  text: '#fdf6e3',
  textSecondary: '#eee8d5',
  textMuted: '#93a1a1',
  textDim: '#657b83',
  textMuted0: '#839496',

  accent: '#b58900',
  accentAmber: '#d97706',

  userBubble: '#268bd2',
  userBubbleText: '#fdf6e3',

  assistantBubble: '#073642',
  assistantBubbleText: '#fdf6e3',

  green: '#859900',
  greenBright: '#10b981',
  yellow: '#b58900',
  cyan: '#2aa198',
  magenta: '#d33682',
  violet: '#6c71c4',
  orange: '#cb4b16',
  red: '#dc322f',
  blue: '#268bd2',

  activeBadge: '#10b981',
  activeBadgeText: '#fdf6e3',

  tabActive: '#fdf6e3',
  tabInactive: '#657b83',

  cardBg: '#073642',
  cardBorder: '#586e75',

  inputBg: '#073642',
  inputBorder: '#586e75',
  inputPlaceholder: '#657b83',

  headerBg: '#073642',
  footerBg: '#073642',
};

export type Palette = typeof SolarizedLight;
export type ColorScheme = 'light' | 'dark';

export const Palettes: Record<ColorScheme, Palette> = {
  light: SolarizedLight,
  dark: SolarizedDark,
};

// The active scheme is a tiny external store. The root layout publishes the
// resolved preference (Settings choice, else the OS setting) into it, and
// every screen subscribes through useTheme() so a flip re-renders the tree.
let activeScheme: ColorScheme = 'light';
const listeners = new Set<() => void>();

export function getActiveScheme(): ColorScheme {
  return activeScheme;
}

export function setActiveScheme(next: ColorScheme) {
  if (next === activeScheme) return;
  activeScheme = next;
  listeners.forEach((listener) => listener());
}

function subscribeScheme(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A frozen view whose every property resolves against the current scheme at
// read time. Module-scope code can hold a reference forever; the value it
// reads is always the active palette's.
function liveView<T extends object>(resolve: () => T, keys: (keyof T)[]): T {
  const view = {} as T;
  for (const key of keys) {
    Object.defineProperty(view, key, {
      enumerable: true,
      get: () => resolve()[key],
    });
  }
  return Object.freeze(view);
}

// Live palette: `Theme.bg` is the active scheme's background at the moment
// the expression runs. Reads inside a render body follow the scheme as long as
// the component re-renders on a flip — call useTheme() for that.
export const Theme: Palette = liveView(
  () => Palettes[activeScheme],
  Object.keys(SolarizedLight) as (keyof Palette)[],
);

// Module-scope style sheets capture colour values when the module evaluates,
// so a plain StyleSheet.create({ color: Theme.text }) would bake the light
// palette forever. themedStyles builds one sheet per scheme (lazily) and hands
// back a live view, so `styles.row` read during render is the active scheme's
// row style. Name the factory parameter `Theme` to keep the body unchanged.
export function themedStyles<T extends StyleSheet.NamedStyles<T>>(build: (theme: Palette) => T): T {
  const sheets: Partial<Record<ColorScheme, T>> = {};
  const sheetFor = (scheme: ColorScheme): T => (sheets[scheme] ??= build(Palettes[scheme]));
  return liveView(() => sheetFor(activeScheme), Object.keys(sheetFor('light')) as (keyof T)[]);
}

export function useActiveScheme(): ColorScheme {
  return useSyncExternalStore(subscribeScheme, getActiveScheme, getActiveScheme);
}

// Subscribes the calling component to scheme flips and returns the live
// palette. Every component that reads Theme or a themedStyles sheet in its
// render calls this, otherwise it repaints in the new scheme only when
// something else re-renders it.
export function useTheme(): Palette {
  useActiveScheme();
  return Theme;
}

// The tab bar's fixed height (its own paddingBottom absorbs the home
// indicator, so this is the full box). Overlays that float above the tab bar
// (the in-call pill) offset by THIS, not by insets.bottom + a guess.
export const TAB_BAR_HEIGHT = 84;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const FontSize = {
  xs: 10,
  sm: 12,
  md: 14,
  lg: 16,
  xl: 18,
  xxl: 20,
  title: 24,
};

export const BorderRadius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  pill: 999,
};

// Chrome text (headers, footers, chips) caps Dynamic Type scaling so large
// accessibility text sizes don't blow up the app shell; message content still
// scales freely. Pass as maxFontSizeMultiplier on chrome <Text> nodes.
export const CHROME_FONT_CAP = 1.2;

// One shell for every metadata chip in the app chrome (session header strip,
// device chip, model switcher, footer status): identical fixed height, radius,
// padding, border weight and text size — only the tint changes. The fixed
// height keeps mixed content (icons, text, dots) on one optical line.
export const CHIP_HEIGHT = 22;
export const chipShell = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 4,
  height: CHIP_HEIGHT,
  borderWidth: StyleSheet.hairlineWidth,
  borderRadius: 6,
  paddingHorizontal: 7,
  maxWidth: 160,
} as const;
export const chipText = {
  fontSize: 11,
  fontWeight: '600',
} as const;
export const chipTint = (color: string) => ({ borderColor: color + '40', backgroundColor: color + '14' });
