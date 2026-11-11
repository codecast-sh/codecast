// The color themes codecast ships, in the same shape a mod declares them
// (shared/contracts/theme.ts), so the picker, the provider and the boot
// script treat both alike. Stored as `codecast/<id>`; they are listed ahead
// of every mod's themes, so a mod named "codecast" cannot shadow one.
//
// Verdigris is the default: a person who never chose sees it. Original puts
// no variables on the root, so it is whatever the stylesheet paints for the
// style on screen (Solarized in Classic, the neutrals in Minimal).

// Type-only imports: the vite config loads this file to inline the default
// theme (plugins/colorThemeBoot.ts), and Node cannot run the shared package's
// TypeScript there. Keys and lookups live in colorTheme.ts.
import type { ModTheme, ThemePalette } from "@codecast/shared/contracts/theme";

export const BUILTIN_THEME_SOURCE = "codecast";

export const BUILTIN_THEMES: readonly ModTheme[] = [
  {
    id: "verdigris",
    title: "Verdigris",
    light: {
      // Near-white surfaces with a faint cool tint, and a white card. The
      // earlier sage (#edf3ee) read as warm paper next to the teal ink.
      bg: "#f6f9f8", "bg-alt": "#ecf1ef", card: "#ffffff", border: "#d2ddd9",
      text: "#1a2d29", "text-muted": "#3e564f", "text-dim": "#50655e", link: "#0d7865",
      red: "#c3352b", orange: "#a95219", amber: "#8e630c", yellow: "#746c0e",
      green: "#337425", cyan: "#107771", blue: "#2a66b4", violet: "#694ebf", magenta: "#ae3977",
    },
    dark: {
      bg: "#0e1918", "bg-alt": "#13221f", card: "#172925", border: "#233f39",
      text: "#d6e5dd", "text-muted": "#93afa5", "text-dim": "#7d988e", link: "#5fd6b9",
      red: "#f0645a", orange: "#f08a4b", amber: "#e3ad4a", yellow: "#d8cd6b",
      green: "#7ec76b", cyan: "#4ccac0", blue: "#6aa8e8", violet: "#a28ee6", magenta: "#e27aa9",
    },
  },
  { id: "original", title: "Original" },
  {
    id: "fjord",
    title: "Fjord",
    light: {
      bg: "#eef1f5", "bg-alt": "#e4e9ef", card: "#f8fafc", border: "#cdd5df",
      text: "#232a35", "text-muted": "#465262", "text-dim": "#606a78", link: "#2d6a8c",
      red: "#b0414c", orange: "#9e5129", amber: "#895f0c", yellow: "#75660d",
      green: "#497131", cyan: "#217082", blue: "#3a5f94", violet: "#7a4f86", magenta: "#9a4577",
    },
    dark: {
      bg: "#20252e", "bg-alt": "#252b35", card: "#2b323d", border: "#3a4351",
      text: "#e5e9f0", "text-muted": "#aeb7c6", "text-dim": "#909aa7", link: "#88c0d0",
      red: "#d77b84", orange: "#d8936f", amber: "#e2b86f", yellow: "#ebcb8b",
      green: "#a3be8c", cyan: "#88c0d0", blue: "#81a1c1", violet: "#b48ead", magenta: "#c896b8",
    },
  },
  {
    id: "vellum",
    title: "Vellum",
    light: {
      bg: "#f4ecd8", "bg-alt": "#ece2c9", card: "#faf5e8", border: "#d9cba8",
      text: "#3a2f22", "text-muted": "#5b4c38", "text-dim": "#73634c", link: "#8a4b12",
      red: "#b23a2a", orange: "#9a5016", amber: "#855c07", yellow: "#71640e",
      green: "#456f25", cyan: "#2a6e67", blue: "#345f9a", violet: "#6c4f94", magenta: "#9c3d6b",
    },
    dark: {
      bg: "#1d1913", "bg-alt": "#241f17", card: "#2a241b", border: "#3d3427",
      text: "#e9dfc8", "text-muted": "#b3a588", "text-dim": "#968a73", link: "#e0a35a",
      red: "#e0715e", orange: "#e3914f", amber: "#d9ad55", yellow: "#cfc06a",
      green: "#a3bf6a", cyan: "#7fbfb0", blue: "#86a8d6", violet: "#b39bd6", magenta: "#d98fae",
    },
  },
  {
    id: "kiln",
    title: "Kiln",
    light: {
      bg: "#f7eedd", "bg-alt": "#eee2c6", card: "#fcf6e8", border: "#d8c8a4",
      text: "#3c3836", "text-muted": "#564e49", "text-dim": "#6e635a", link: "#af3a03",
      red: "#b8261a", orange: "#a7490a", amber: "#8b5a06", yellow: "#73650a",
      green: "#5f6c10", cyan: "#386f50", blue: "#2f6a72", violet: "#7b4b8f", magenta: "#9a3d63",
    },
    dark: {
      bg: "#1f1c1a", "bg-alt": "#262220", card: "#2c2724", border: "#403833",
      text: "#ebdbb2", "text-muted": "#bdae93", "text-dim": "#9a8c78", link: "#f0b232",
      red: "#f2594b", orange: "#f28534", amber: "#f0b232", yellow: "#d8c048",
      green: "#a9b83a", cyan: "#7fbfa6", blue: "#83a598", violet: "#b38bc4", magenta: "#d3869b",
    },
  },
  {
    id: "rosewood",
    title: "Rosewood",
    light: {
      bg: "#faf4f0", "bg-alt": "#f2e9e4", card: "#fffaf7", border: "#e2d4d0",
      text: "#3a2f45", "text-muted": "#5c4e69", "text-dim": "#72657d", link: "#a24e66",
      red: "#ae455c", orange: "#9c562f", amber: "#8e600d", yellow: "#766910",
      green: "#3a7553", cyan: "#2c727d", blue: "#3f619a", violet: "#7752a8", magenta: "#a8457e",
    },
    dark: {
      bg: "#1b1723", "bg-alt": "#211c2b", card: "#262033", border: "#3a3149",
      text: "#e6deef", "text-muted": "#ada3bf", "text-dim": "#8f859f", link: "#ebbcba",
      red: "#eb6f92", orange: "#f0a07a", amber: "#f6c177", yellow: "#e8d38a",
      green: "#9ccfa0", cyan: "#9ccfd8", blue: "#7fa6d6", violet: "#c4a7e7", magenta: "#e58fc0",
    },
  },
  {
    id: "midnight",
    title: "Midnight",
    light: {
      bg: "#eef0f8", "bg-alt": "#e4e7f3", card: "#f8f9fd", border: "#ccd1e6",
      text: "#1f2340", "text-muted": "#484e72", "text-dim": "#626784", link: "#3451b8",
      red: "#b6384e", orange: "#a04f19", amber: "#875f0d", yellow: "#716712",
      green: "#417228", cyan: "#156d93", blue: "#3451b8", violet: "#6a44b8", magenta: "#a03c94",
    },
    dark: {
      bg: "#13151f", "bg-alt": "#181a27", card: "#1c1f2e", border: "#2b2f45",
      text: "#d4d9f2", "text-muted": "#9aa1c4", "text-dim": "#7f85a6", link: "#7aa2f7",
      red: "#f7768e", orange: "#ff9e64", amber: "#e0af68", yellow: "#e3cf7a",
      green: "#9ece6a", cyan: "#7dcfff", blue: "#7aa2f7", violet: "#bb9af7", magenta: "#e48bd2",
    },
  },
  {
    id: "contrast",
    title: "Contrast",
    light: {
      bg: "#ffffff", "bg-alt": "#f2f2f2", card: "#ffffff", border: "#b8b8b8",
      text: "#000000", "text-muted": "#363636", "text-dim": "#626262", link: "#0040c0",
      red: "#b00020", orange: "#a84300", amber: "#8a5a00", yellow: "#6f6500",
      green: "#1d6b2a", cyan: "#006b78", blue: "#0047b3", violet: "#5a2db3", magenta: "#9c1f73",
    },
    dark: {
      bg: "#000000", "bg-alt": "#0b0b0b", card: "#121212", border: "#4a4a4a",
      text: "#ffffff", "text-muted": "#d0d0d0", "text-dim": "#9a9a9a", link: "#7ab4ff",
      red: "#ff6b6b", orange: "#ff9a4d", amber: "#ffc44d", yellow: "#f0e060",
      green: "#6fe08a", cyan: "#5fe0ec", blue: "#7ab4ff", violet: "#b79bff", magenta: "#ff85cf",
    },
  },
];

/** Verdigris, the theme a person who never chose sees. */
export const DEFAULT_THEME: ModTheme = BUILTIN_THEMES[0]!;

/**
 * What Original looks like, for its swatch only: the stylesheet's own values
 * (app/globals.css) for each style and mode. Applying Original sets nothing.
 */
const SOLARIZED_ACCENTS: ThemePalette = {
  red: "#dc322f", orange: "#cb4b16", amber: "#b66f20", yellow: "#b58900",
  green: "#859900", cyan: "#2aa198", blue: "#268bd2", violet: "#6c71c4", magenta: "#d33682",
};
export const ORIGINAL_PREVIEW: Record<"classic" | "minimal" | "modern", Record<"light" | "dark", ThemePalette>> = {
  classic: {
    light: { bg: "#fbf5e2", "bg-alt": "#eee8d5", card: "#ffffff", border: "#93a1a1", text: "#002b36", "text-muted": "#586e75", ...SOLARIZED_ACCENTS },
    dark: { bg: "#002b36", "bg-alt": "#073642", card: "#08404e", border: "#586e75", text: "#fdf6e3", "text-muted": "#93a1a1", ...SOLARIZED_ACCENTS },
  },
  minimal: {
    light: {
      bg: "#ffffff", "bg-alt": "#f7f7f5", card: "#ffffff", border: "#d9d9d5", text: "#1f1f1f", "text-muted": "#595957",
      red: "#d34b4b", orange: "#d85d38", amber: "#b36b22", yellow: "#a86f13", green: "#5f7f38", cyan: "#2f7168", blue: "#3f76c4", violet: "#7667b6", magenta: "#b44b7f",
    },
    dark: {
      bg: "#161615", "bg-alt": "#1c1c1b", card: "#252523", border: "#393936", text: "#e7e5e0", "text-muted": "#a19f98",
      red: "#e8787a", orange: "#e88a64", amber: "#d9a05e", yellow: "#dcb25a", green: "#9bb873", cyan: "#73b2a8", blue: "#7ea7e2", violet: "#a99ce6", magenta: "#d185ad",
    },
  },
  // Modern has no Solarized: with Original chosen it paints Verdigris, the
  // palette it was drawn against (components/ThemeProvider.tsx applies it).
  modern: { light: BUILTIN_THEMES[0].light!, dark: BUILTIN_THEMES[0].dark! },
};
