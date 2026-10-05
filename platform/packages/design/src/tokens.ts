// The family's design tokens: the one home of the palette, the faces, the
// shape and the motion that Whisk and codecast's simple lane share, so a
// person moving between them feels one product. "The reading room": paper
// warm light, ink warm dark, one vermilion accent spent only where attention
// goes. Each app maps its own names onto these (Whisk's --m-*, the lane's
// --sl-*) and keeps its own metrics; a value lives here only when both apps
// mean the same thing by it.

export type Theme = "light" | "dark";

export type Palette = {
  /** The page. */
  bg: string;
  /** A sheet lifted off the page (cards, the composer, menus). */
  bgRaised: string;
  /** A well pressed into the page (quoted text, a draft). */
  bgSunken: string;
  bgHover: string;
  ink: string;
  inkMuted: string;
  /** Still readable: about 4.6:1 on bg in both themes. */
  inkFaint: string;
  rule: string;
  ruleStrong: string;
  accent: string;
  /** Text on an accent fill. */
  accentInk: string;
  accentSoft: string;
  /** Marked as important (a star, a flag). */
  star: string;
  ok: string;
  danger: string;
  shadow: string;
  shadowHigh: string;
  selection: string;
};

export const PALETTE: Record<Theme, Palette> = {
  light: {
    bg: "#f6f3ec",
    bgRaised: "#fdfbf6",
    bgSunken: "#efebe1",
    bgHover: "#f0ecdf",
    ink: "#201c17",
    inkMuted: "#6b6355",
    inkFaint: "#8a806c",
    rule: "#e4ddce",
    ruleStrong: "#cfc6b2",
    accent: "#c93a0e",
    accentInk: "#fdfbf6",
    accentSoft: "#c93a0e14",
    star: "#c98a0e",
    ok: "#3d7a44",
    danger: "#b3261e",
    shadow: "0 1px 2px rgba(32, 28, 23, 0.06), 0 8px 32px rgba(32, 28, 23, 0.09)",
    shadowHigh: "0 2px 6px rgba(32, 28, 23, 0.1), 0 20px 60px rgba(32, 28, 23, 0.18)",
    selection: "#c93a0e26",
  },
  dark: {
    bg: "#161310",
    bgRaised: "#1e1a15",
    bgSunken: "#100e0b",
    bgHover: "#241f19",
    ink: "#ece5d8",
    inkMuted: "#a49a8a",
    inkFaint: "#8f8676",
    rule: "#2b261f",
    ruleStrong: "#3d372d",
    accent: "#ef5a24",
    accentInk: "#161310",
    accentSoft: "#ef5a241f",
    star: "#d9a940",
    ok: "#6aa872",
    danger: "#e05b52",
    shadow: "0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 32px rgba(0, 0, 0, 0.45)",
    shadowHigh: "0 2px 6px rgba(0, 0, 0, 0.5), 0 20px 60px rgba(0, 0, 0, 0.6)",
    selection: "#ef5a2433",
  },
};

/** The three faces. Each stack names the bundled (fontsource "Variable")
 *  family that `@platform/design/fonts` loads first, then the plain family
 *  name, for a host that registers the faces under it. */
export const FONTS = {
  /** Interface words: labels, buttons, rows. */
  ui: '"Instrument Sans Variable", "Instrument Sans", system-ui, sans-serif',
  /** Reading: titles, letters, what the assistant writes. */
  read: '"Newsreader Variable", "Newsreader", Georgia, serif',
  /** Figures and counts. */
  mono: '"Fragment Mono", ui-monospace, monospace',
} as const;

export const SHAPE = {
  radius: "6px",
  radiusLg: "10px",
} as const;

export const MOTION = {
  /** A view arriving. */
  view: "150ms cubic-bezier(0.3, 0.9, 0.3, 1)",
  /** A control answering a hover or press. */
  fast: "90ms ease-out",
  /** The curve both are drawn on, for motion with its own duration. */
  ease: "cubic-bezier(0.3, 0.9, 0.3, 1)",
} as const;

/** Where the dark palette applies: Whisk marks dark as
 *  `html[data-theme="dark"]`, codecast as `html.dark`. */
export const DARK_SELECTOR = ':root[data-theme="dark"], :root.dark';
