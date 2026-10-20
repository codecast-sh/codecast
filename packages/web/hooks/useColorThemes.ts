import { useInboxStore } from "../store/inboxStore";
import { useModRows } from "../lib/mods/useMods";
import { availableThemes, DEFAULT_COLOR_THEME, resolveColorThemeKey } from "../lib/theme/colorTheme";

/** The themes on offer, the one on screen, and choosing one. */
export function useColorThemes() {
  const rows = useModRows();
  const installed = useInboxStore((s) => s.clientState?.ui?.mods_installed);
  const stored = useInboxStore((s) => s.clientState?.ui?.color_theme);
  const updateUI = useInboxStore((s) => s.updateClientUI);
  const themes = availableThemes(rows, installed ?? []);
  const key = resolveColorThemeKey(stored);
  // A theme whose mod is gone shows the default, as ThemeProvider does.
  const current = themes.some((t) => t.key === key) ? key : DEFAULT_COLOR_THEME;
  return { themes, current, choose: (k: string) => updateUI({ color_theme: k }) };
}
