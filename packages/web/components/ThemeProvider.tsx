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
export type VisualStyle = "classic" | "minimal" | "modern";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  visualStyle: VisualStyle;
  setVisualStyle: (style: VisualStyle) => void;
}

export const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/** Takes a theme lock and returns its release. */
const ThemeLockContext = createContext<((theme: Theme) => () => void) | null>(null);

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return localStorage.getItem("codecast-theme") === "dark" ? "dark" : "light";
}

type BaseStyle = Exclude<VisualStyle, "modern">;

function normalizeVisualStyle(value: string | null | undefined): BaseStyle {
  return value === "minimal" || value === "codex" ? "minimal" : "classic";
}

function getInitialVisualStyle(): BaseStyle {
  if (typeof window === "undefined") return "classic";
  return normalizeVisualStyle(localStorage.getItem("codecast-visual-style"));
}

// Modern is stored apart from `visual_style` (its own ui key and its own
// localStorage key). A build from before Modern normalizes any style it does
// not know to Classic and writes that back, so a "modern" value in the shared
// key would be fought over by an old tab and a new one. Old builds never read
// this key, and under it they show Classic.
const MODERN_STYLE_KEY = "codecast-modern-style";
function getInitialModern(): boolean {
  return typeof window !== "undefined" && localStorage.getItem(MODERN_STYLE_KEY) === "1";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [initialTheme] = useState<Theme>(getInitialTheme);
  const [visualStyle, setVisualStyleState] = useState<BaseStyle>(getInitialVisualStyle);
  const [modernOn, setModernOn] = useState<boolean>(getInitialModern);
  const serverModern = useInboxStore((s) => s.clientState.ui?.modern_style);
  const [mounted, setMounted] = useState(false);
  const storedTheme = useInboxStore((s) => s.clientState.ui?.theme);
  const theme = storedTheme ?? initialTheme;
  const serverVisualStyle = useInboxStore((s) => s.clientState.ui?.visual_style);
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
  const shownStyle: VisualStyle = lock ? "classic" : modernOn ? "modern" : resolveVisualStyle({ visual_style: visualStyle });

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
    if (!mounted || !serverVisualStyle) return;
    const normalizedServerStyle = normalizeVisualStyle(serverVisualStyle);
    if (normalizedServerStyle === visualStyle) {
      if (serverVisualStyle !== normalizedServerStyle) updateClientUI({ visual_style: normalizedServerStyle });
      return;
    }
    const stored = localStorage.getItem("codecast-visual-style");
    if (!stored) {
      setVisualStyleState(normalizedServerStyle);
    } else if (normalizeVisualStyle(stored) !== normalizedServerStyle) {
      updateClientUI({ visual_style: normalizeVisualStyle(stored) });
    }
  }, [serverVisualStyle, mounted]);

  useWatchEffect(() => {
    if (mounted) localStorage.setItem("codecast-visual-style", visualStyle);
  }, [visualStyle, mounted]);

  // This device's own choice wins; a device that has never chosen takes the
  // stored one.
  useWatchEffect(() => {
    if (!mounted || serverModern === undefined) return;
    if (localStorage.getItem(MODERN_STYLE_KEY) === null) setModernOn(serverModern === true);
  }, [serverModern, mounted]);

  useWatchEffect(() => {
    if (!styleReady) return;
    document.documentElement.classList.remove("codex-style");
    document.documentElement.classList.toggle("minimal-style", shownStyle === "minimal");
    // Modern is the opt-in redesign: its rules and the `modern:` variant key on
    // this class, so Classic and Minimal never see them.
    document.documentElement.classList.toggle("modern-style", shownStyle === "modern");
  }, [shownStyle, styleReady]);

  // The color theme (lib/theme): Verdigris unless the person chose another,
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
  // Original sets no variables, so the stylesheet's Solarized shows through.
  // Modern was not drawn for Solarized: under it, Original means the default
  // theme's palette.
  const modernBase = useMemo(() => availableThemes([], []).find((c) => c.key === DEFAULT_COLOR_THEME)?.theme, []);
  const paintedTheme = shownStyle === "modern" && colorTheme && !colorTheme.light ? modernBase : colorTheme;
  const colorVars = useMemo(() => (paintedTheme ? themeVarsByMode(paintedTheme) : null), [paintedTheme]);
  useWatchEffect(() => {
    if (!styleReady || !colorVars) return;
    applyThemeVars(!lock ? colorVars[shownTheme] : {});
    if (!lock) cacheThemeVars(colorVars);
  }, [colorVars, shownTheme, lock, styleReady]);

  const toggleTheme = useCallback(() => {
    const current = useInboxStore.getState().clientState.ui?.theme ?? initialTheme;
    updateClientUI({ theme: current === "dark" ? "light" : "dark" });
  }, [initialTheme, updateClientUI]);

  const setVisualStyle = useCallback((style: VisualStyle) => {
    // Modern sits on Classic's rules (simple view and list density follow the
    // person's own toggles), so the base style under it is Classic.
    const modern = style === "modern";
    const base: BaseStyle = modern ? "classic" : style;
    setModernOn(modern);
    localStorage.setItem(MODERN_STYLE_KEY, modern ? "1" : "0");
    setVisualStyleState(base);
    updateClientUI({ visual_style: base, modern_style: modern });
  }, [updateClientUI]);

  // One object per real change: every session card and page header reads the
  // style from this context, and a fresh object each render would re-render
  // them all whenever this provider did.
  const themeContext = useMemo(
    () => ({ theme: shownTheme, toggleTheme, visualStyle: shownStyle, setVisualStyle }),
    [shownTheme, toggleTheme, shownStyle, setVisualStyle],
  );

  if (!mounted) return null;

  return (
    <ThemeLockContext.Provider value={acquireLock}>
      <ThemeContext.Provider value={themeContext}>
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
    return { theme: "light", toggleTheme: () => {}, visualStyle: "classic", setVisualStyle: () => {} };
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
