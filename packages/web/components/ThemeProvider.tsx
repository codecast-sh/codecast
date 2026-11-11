import { createContext, useContext, useState, ReactNode, useCallback, useMemo } from "react";
import { useInboxStore, resolveVisualStyle } from "../store/inboxStore";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { BUBBLE_HUE_VAR, resolveBubbleHue } from "../lib/bubbleColor";
import { lockedAtBoot } from "../lib/themeBootLock";
import { applyThemeVars, availableThemes, cacheThemeVars, DEFAULT_COLOR_THEME, resolveColorThemeKey, themeVarsByMode } from "../lib/theme/colorTheme";
import type { ModRow } from "../lib/mods/host";
// The family's faces and token sheet, for the hosted assistant's note cards
// and the marketing pages' assistant section. The faces are fetched only once
// a rule uses them.
import "./simple/laneLook";

export type Theme = "dark" | "light";
export type VisualStyle = "classic" | "minimal";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  /** Always "minimal" in the app; "classic" only while a theme lock is held. */
  visualStyle: VisualStyle;
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/** Takes a theme lock and returns its release. */
const ThemeLockContext = createContext<((theme: Theme) => () => void) | null>(null);

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return localStorage.getItem("codecast-theme") === "dark" ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [initialTheme] = useState<Theme>(getInitialTheme);
  const [mounted, setMounted] = useState(false);
  const storedTheme = useInboxStore((s) => s.clientState.ui?.theme);
  const theme = storedTheme ?? initialTheme;
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  const bubbleHue = useInboxStore((s) => resolveBubbleHue(s.clientState.ui?.user_bubble_color));
  // A held lock (useThemeLock) renders its theme in Classic style and leaves
  // the viewer's stored preferences untouched; releasing it restores them.
  // This provider is the only writer of the root's theme classes, so a lock
  // cannot race the stored theme's own effect.
  // A route the boot script leaves unthemed starts locked (lib/themeBootLock.ts), so the stored theme never paints there before the page's own lock mounts.
  const [lock, setLock] = useState<Theme | null>(() => (typeof window !== "undefined" && lockedAtBoot(window.location.pathname) ? "light" : null));
  const acquireLock = useCallback((locked: Theme) => {
    setLock(locked);
    return () => setLock((cur) => (cur === locked ? null : cur));
  }, []);
  const shownTheme = lock ?? theme;
  const shownStyle: VisualStyle = lock ? "classic" : resolveVisualStyle();

  // One custom property on the root; the stylesheet mixes the fill from it.
  useWatchEffect(() => {
    if (lock) document.documentElement.style.removeProperty(BUBBLE_HUE_VAR);
    else document.documentElement.style.setProperty(BUBBLE_HUE_VAR, bubbleHue);
  }, [bubbleHue, lock]);

  useMountEffect(() => { setMounted(true); });
  // The style class waits for the client state to hydrate from the cache, so
  // the boot script's classes (index.html) are never corrected from a
  // half-read state. A lock (the marketing pages) never reads the preference.
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const styleReady = mounted && (hydrated || lock !== null);

  useWatchEffect(() => {
    if (mounted) localStorage.setItem("codecast-theme", theme);
  }, [theme, mounted]);

  useWatchEffect(() => {
    if (!mounted) return;
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(shownTheme);
  }, [shownTheme, mounted]);

  useWatchEffect(() => {
    if (!styleReady) return;
    document.documentElement.classList.remove("codex-style");
    document.documentElement.classList.toggle("minimal-style", shownStyle === "minimal");
  }, [shownStyle, styleReady]);

  // The color theme (lib/theme): Standard unless the person chose another,
  // its variables inline on the root for the mode on screen. A lock keeps
  // Classic's, so it shows codecast's own palette. Until a mod's theme is in the store the root keeps what
  // index.html replayed from the cache, so a cold load never flashes the
  // default; once mods are known and the theme is gone, the default takes over.
  // A choice whose mod is gone falls back to the default theme.
  const colorThemeKey = useInboxStore((s) => resolveColorThemeKey(s.clientState.ui?.color_theme));
  const modMap = useInboxStore((s) => (s as any).mods as Record<string, ModRow> | undefined);
  const installed = useInboxStore((s) => s.clientState.ui?.mods_installed);
  const modsKnown = !!modMap && Object.keys(modMap).length > 0;
  const colorTheme = useMemo(() => {
    const themes = availableThemes(Object.values(modMap ?? {}), installed ?? []);
    const chosen = themes.find((c) => c.key === colorThemeKey)?.theme;
    return chosen ?? (modsKnown ? themes.find((c) => c.key === DEFAULT_COLOR_THEME)?.theme : undefined);
  }, [colorThemeKey, modMap, installed, modsKnown]);
  const colorVars = useMemo(() => (colorTheme ? themeVarsByMode(colorTheme) : null), [colorTheme]);
  useWatchEffect(() => {
    if (!styleReady || !colorVars) return;
    applyThemeVars(!lock ? colorVars[shownTheme] : {});
    if (!lock) cacheThemeVars(colorVars);
  }, [colorVars, shownTheme, lock, styleReady]);

  const toggleTheme = useCallback(() => {
    const current = useInboxStore.getState().clientState.ui?.theme ?? initialTheme;
    updateClientUI({ theme: current === "dark" ? "light" : "dark" });
  }, [initialTheme, updateClientUI]);

  if (!mounted) return null;

  return (
    <ThemeLockContext.Provider value={acquireLock}>
      <ThemeContext.Provider value={{ theme: shownTheme, toggleTheme, visualStyle: shownStyle }}>
        {children}
      </ThemeContext.Provider>
    </ThemeLockContext.Provider>
  );
}

export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (!context) {
    // No provider mounted (e.g. SSR/boot fallback): default to light with a
    // no-op toggle so the shape matches ThemeContextType and callers like
    // ThemeToggle can read `toggleTheme` unconditionally.
    return { theme: "light", toggleTheme: () => {}, visualStyle: "classic" };
  }
  return context;
}

/**
 * Hold the page in one theme, Classic style, for as long as the caller is
 * mounted, whatever the viewer chose (the marketing pages hold light). Outside
 * a ThemeProvider (the prerender) it does nothing.
 */
export function useThemeLock(theme: Theme) {
  const acquire = useContext(ThemeLockContext);
  useWatchEffect(() => acquire?.(theme), [acquire, theme]);
}
