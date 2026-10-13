// Color themes: the public surface people restyle codecast through, declared
// by a mod's manifest (`themes`) and applied by the web app's ThemeProvider.
//
// A theme is data, never CSS: a value per named token, for light and dark.
// The token names below are the contract, so they only grow; how each one
// reaches the app's internal variables lives in one web file
// (packages/web/lib/theme/themeVars.ts), free to change with the app.

/** Colors, as hex (#rgb or #rrggbb). */
export const THEME_COLOR_TOKENS = [
  // Surfaces and text, from the page behind everything to the faintest label.
  "bg", "bg-alt", "card", "border", "text", "text-muted", "text-dim", "link",
  // Accents: status, highlights, and every Tailwind color scale of that hue.
  "red", "orange", "amber", "yellow", "green", "cyan", "blue", "violet", "magenta",
] as const;

/** Font stacks of fonts the machine already has, e.g. "Iosevka, monospace". */
export const THEME_FONT_TOKENS = ["font-ui", "font-mono"] as const;

export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number];
export type ThemeFontToken = (typeof THEME_FONT_TOKENS)[number];
export type ThemeToken = ThemeColorToken | ThemeFontToken;
export type ThemeMode = "light" | "dark";

/** Every token is optional: what a theme leaves out keeps codecast's own value. */
export type ThemePalette = Partial<Record<ThemeToken, string>>;

/** A mode the theme leaves out shows codecast's own look in that mode. */
export type ModTheme = { id: string; title: string; light?: ThemePalette; dark?: ThemePalette };

export const THEME_HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const FONT_RE = /^[\w\s"',.-]{1,200}$/;
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const TOKENS: ReadonlySet<string> = new Set([...THEME_COLOR_TOKENS, ...THEME_FONT_TOKENS]);
const FONTS: ReadonlySet<string> = new Set(THEME_FONT_TOKENS);

/** The errors in a manifest's `themes`, worded for `cast mod build`; empty when it is good. */
export function themeErrors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return ["themes must be a list"];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const t = item as Record<string, unknown>;
    const id = t?.id;
    if (typeof id !== "string" || !ID_RE.test(id)) { errors.push(`themes: id "${String(id)}" must be lowercase a-z, 0-9 and -`); continue; }
    if (seen.has(id)) errors.push(`themes: "${id}" is declared twice`);
    seen.add(id);
    if (typeof t.title !== "string" || !t.title) errors.push(`themes: "${id}" needs a title`);
    for (const key of Object.keys(t)) if (!["id", "title", "light", "dark"].includes(key)) errors.push(`themes: "${id}" has an unknown key "${key}"`);
    if (t.light === undefined && t.dark === undefined) errors.push(`themes: "${id}" needs a light or a dark palette`);
    for (const mode of ["light", "dark"] as const) {
      const p = t[mode];
      if (p === undefined) continue;
      if (!p || typeof p !== "object" || Array.isArray(p)) { errors.push(`themes: "${id}".${mode} must be an object of token -> value`); continue; }
      for (const [token, value] of Object.entries(p)) {
        if (!TOKENS.has(token)) errors.push(`themes: "${id}".${mode}: "${token}" is not a theme token (${[...TOKENS].join(", ")})`);
        else if (typeof value !== "string") errors.push(`themes: "${id}".${mode}.${token} must be a string`);
        else if (FONTS.has(token) ? !FONT_RE.test(value) : !THEME_HEX_RE.test(value)) {
          errors.push(`themes: "${id}".${mode}.${token} "${value}" must be ${FONTS.has(token) ? "a font list like \"Iosevka, monospace\"" : "a hex color like #268bd2"}`);
        }
      }
    }
  }
  return errors;
}

/** How a chosen theme is stored (clientState.ui.color_theme): the mod's name and the theme's id. */
export function themeKey(modName: string, themeId: string): string {
  return `${modName}/${themeId}`;
}
