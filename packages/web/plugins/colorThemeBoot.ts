import type { Plugin } from "vite";
import { DEFAULT_THEME } from "../lib/theme/builtinThemes";
import { themeVarsByMode } from "../lib/theme/themeVars";

/** The global index.html's boot script reads when nothing is cached. */
export const DEFAULT_THEME_GLOBAL = "__ccDefaultColorTheme";

/**
 * Puts the default color theme's variables, both modes, into index.html's
 * <head>, so a device that has never cached a theme (a first visit, a cleared
 * browser) paints the default from its first frame instead of switching to it
 * once the app mounts. The boot script beside it prefers the cache.
 */
export function colorThemeBootPlugin(): Plugin {
  const vars = JSON.stringify(themeVarsByMode(DEFAULT_THEME));
  return {
    name: "codecast-color-theme-boot",
    transformIndexHtml: {
      order: "pre",
      handler: () => [{ tag: "script", children: `window.${DEFAULT_THEME_GLOBAL}=${vars}`, injectTo: "head-prepend" }],
    },
  };
}
