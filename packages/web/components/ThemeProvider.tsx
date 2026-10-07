import { createContext, useContext, useState, ReactNode, useCallback } from "react";
import { useInboxStore, resolveVisualStyle } from "../store/inboxStore";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { BUBBLE_HUE_VAR, resolveBubbleHue } from "../lib/bubbleColor";
import { lockedAtBoot } from "../lib/themeBootLock";
import { isHostedMode } from "../lib/surfaces";
import { HOSTED_BOOT_ATTR } from "./simple/laneBoot";
// The family's faces and token sheet, for hosted mode's look. The faces are
// fetched only once a rule uses them.
import "./simple/laneLook";

export type Theme = "dark" | "light";
export type VisualStyle = "classic" | "minimal";

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

function normalizeVisualStyle(value: string | null | undefined): VisualStyle {
  return value === "minimal" || value === "codex" ? "minimal" : "classic";
}

function getInitialVisualStyle(): VisualStyle {
  if (typeof window === "undefined") return "classic";
  return normalizeVisualStyle(localStorage.getItem("codecast-visual-style"));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [initialTheme] = useState<Theme>(getInitialTheme);
  const [visualStyle, setVisualStyleState] = useState<VisualStyle>(getInitialVisualStyle);
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
  // Hosted mode is always Minimal (resolveVisualStyle); the developer pick is
  // left alone, so leaving hosted mode restores it.
  // Hosted mode as the shell reads it: the preference, or until it is known
  // the device's last known mode (lib/surfaces isHostedMode).
  const hosted = useInboxStore(isHostedMode);
  const lane = hosted ? "simple" : "full";
  const shownStyle: VisualStyle = lock ? "classic" : resolveVisualStyle({ visual_style: visualStyle, lane });

  // One custom property on the root; the stylesheet mixes the fill from it.
  useWatchEffect(() => {
    if (lock) document.documentElement.style.removeProperty(BUBBLE_HUE_VAR);
    else document.documentElement.style.setProperty(BUBBLE_HUE_VAR, bubbleHue);
  }, [bubbleHue, lock]);

  useMountEffect(() => { setMounted(true); });
  // The style and hosted classes read the hosted-mode preference, which is
  // unknown until the client state hydrates from the cache. Until then the
  // boot script's classes (index.html, from the codecast-hosted-look flag)
  // stay as they are: correcting them from a half-read state undid the
  // family's paper for the seconds hydration took and wrote the flag back
  // as "0". A lock (the marketing pages) never reads the preference.
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

  useWatchEffect(() => {
    if (!styleReady) return;
    document.documentElement.classList.remove("codex-style");
    document.documentElement.classList.toggle("minimal-style", shownStyle === "minimal");
  }, [shownStyle, styleReady]);

  // Hosted mode wears the family's paper, ink and type (@platform/design,
  // the same tokens Whisk and /welcome use) over the Minimal style: one class
  // on the root, so portaled surfaces (settings, menus) take it too. The
  // mapping is globals.css's html.hosted-mode block. A lock (the marketing
  // pages) shows Classic, so the class comes off with it.
  const hostedLook = hosted && !lock;
  useWatchEffect(() => {
    if (!styleReady) return;
    document.documentElement.classList.toggle("hosted-mode", hostedLook);
  }, [hostedLook, styleReady]);
  // index.html's boot script reads this, so a cold load paints the family's
  // paper from its first frame. A lock (the marketing pages) leaves it alone.
  // Written only once someone is signed in: a client state that hydrated with
  // nobody (a lapsed token, an empty cache) says nothing about their mode and
  // must not clear the flag for the next cold load.
  const signedIn = useInboxStore((s) => !!s.currentUser);
  useWatchEffect(() => {
    if (!styleReady || !signedIn || lock) return;
    localStorage.setItem("codecast-hosted-look", hosted ? "1" : "0");
    // The boot's guess (laneBoot.ts markLanePage) has served its purpose:
    // from here the hosted-mode class says the mode.
    document.documentElement.removeAttribute(HOSTED_BOOT_ATTR);
  }, [hosted, styleReady, signedIn, lock]);

  const toggleTheme = useCallback(() => {
    const current = useInboxStore.getState().clientState.ui?.theme ?? initialTheme;
    updateClientUI({ theme: current === "dark" ? "light" : "dark" });
  }, [initialTheme, updateClientUI]);

  const setVisualStyle = useCallback((style: VisualStyle) => {
    if (hosted) return;
    setVisualStyleState(style);
    updateClientUI({ visual_style: style });
  }, [updateClientUI, hosted]);

  if (!mounted) return null;

  return (
    <ThemeLockContext.Provider value={acquireLock}>
      <ThemeContext.Provider value={{ theme: shownTheme, toggleTheme, visualStyle: shownStyle, setVisualStyle }}>
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
