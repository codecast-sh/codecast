// Brand: everything the renderer and the generic templates need to know about
// the app that sends the email. Apps pass one Brand object; nothing in this
// package reads app specific values from anywhere else.

/** Colors the renderer inlines. The default is codecast's Solarized warm set. */
export interface BrandPalette {
  // Light (default) theme
  bodyBg: string;
  cardBg: string;
  border: string;
  text: string;
  textMuted: string;
  textDim: string;
  insetBg: string;
  insetBorder: string;
  accent: string;
  /** Accent darkened so link text keeps 4.5:1 contrast on the card. */
  accentDark: string;
  buttonText: string;
  // The terminal block is dark in BOTH themes, so it needs no dark override.
  termBg: string;
  termText: string;
  termPrompt: string;
  termMuted: string;
  /** Dark theme overrides (applied via classes in the <style> block). */
  dark: {
    bodyBg: string;
    cardBg: string;
    border: string;
    text: string;
    textMuted: string;
    textDim: string;
    insetBg: string;
    insetBorder: string;
    accent: string;
    /** Links lighten, not darken, on dark. */
    accentLight: string;
  };
}

/** Solarized warm light palette, mirrored from codecast's web globals.css. */
export const palette: BrandPalette = {
  bodyBg: "#eee8d5",
  cardBg: "#fdf6e3",
  border: "#d9d2bc",
  text: "#002b36",
  textMuted: "#586e75",
  textDim: "#839496",
  insetBg: "#e7e0ca",
  insetBorder: "#c9c2a9",
  accent: "#e86c5d",
  accentDark: "#c2543f",
  buttonText: "#ffffff",
  termBg: "#002b36",
  termText: "#eee8d5",
  termPrompt: "#859900",
  termMuted: "#586e75",
  dark: {
    bodyBg: "#00212b",
    cardBg: "#073642",
    border: "#0e4a5a",
    text: "#fdf6e3",
    textMuted: "#93a1a1",
    textDim: "#657b83",
    insetBg: "#002b36",
    insetBorder: "#0e4a5a",
    accent: "#e86c5d",
    accentLight: "#f08b7e",
  },
};

/** JetBrains Mono first; the stack degrades to system monos. */
export const monoStack =
  "'JetBrains Mono','SF Mono',SFMono-Regular,ui-monospace,Menlo,Consolas,'Liberation Mono',monospace";

export interface Brand {
  /** Product name as written in copy and the From header, e.g. "Codecast". */
  name: string;
  /** Product URL without a trailing slash, e.g. "https://codecast.sh". */
  url: string;
  /** One line under the footer and in the plain text part. */
  tagline: string;
  /** Support address: reply-to, From mailbox, and the "write us" copy. */
  supportEmail: string;
  /**
   * The text logo shown above the card. It is text, never an image: it
   * survives image blocking and flips correctly in dark mode. `glyph` is an
   * HTML entity or character drawn in the accent color (default a play
   * triangle); `text` defaults to the lowercased name.
   */
  logo?: { glyph?: string; text?: string };
  /** Colors. Defaults to the Solarized warm palette. */
  palette?: BrandPalette;
  /** CSS font-family stack. Defaults to the mono stack. */
  fontStack?: string;
}

/** A Brand with every optional field filled in. */
export interface ResolvedBrand extends Required<Brand> {
  logo: { glyph: string; text: string };
  /** Host of `url`, e.g. "codecast.sh"; the footer link label and sign up site. */
  host: string;
}

export function resolveBrand(brand: Brand): ResolvedBrand {
  return {
    ...brand,
    url: brand.url.replace(/\/$/, ""),
    host: new URL(brand.url).host,
    logo: {
      glyph: brand.logo?.glyph ?? "&#9656;",
      text: brand.logo?.text ?? brand.name.toLowerCase(),
    },
    palette: brand.palette ?? palette,
    fontStack: brand.fontStack ?? monoStack,
  };
}

/** The From header value: `Name <support@host>`. */
export function senderAddress(brand: Pick<Brand, "name" | "supportEmail">): string {
  return `${brand.name} <${brand.supportEmail}>`;
}
