import { createContext, useContext, useState, ReactNode, useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";

type Theme = "dark" | "light";
export type VisualStyle = "classic" | "minimal";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  visualStyle: VisualStyle;
  setVisualStyle: (style: VisualStyle) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem("codecast-theme") as Theme | null;
  return stored || "light";
}

function normalizeVisualStyle(value: string | null | undefined): VisualStyle {
  return value === "minimal" || value === "codex" ? "minimal" : "classic";
}

function getInitialVisualStyle(): VisualStyle {
  if (typeof window === "undefined") return "classic";
  return normalizeVisualStyle(localStorage.getItem("codecast-visual-style"));
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [visualStyle, setVisualStyleState] = useState<VisualStyle>(getInitialVisualStyle);
  const [mounted, setMounted] = useState(false);
  const serverTheme = useInboxStore((s) => s.clientState.ui?.theme);
  const serverVisualStyle = useInboxStore((s) => s.clientState.ui?.visual_style);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);

  useMountEffect(() => { setMounted(true); });

  useWatchEffect(() => {
    if (!mounted || !serverTheme || serverTheme === theme) return;
    const stored = localStorage.getItem("codecast-theme");
    if (!stored) {
      setTheme(serverTheme);
    } else if (stored !== serverTheme) {
      updateClientUI({ theme: stored as Theme });
    }
  }, [serverTheme, mounted]);

  useWatchEffect(() => {
    if (mounted) {
      localStorage.setItem("codecast-theme", theme);
      document.documentElement.classList.remove("dark", "light");
      document.documentElement.classList.add(theme);
    }
  }, [theme, mounted]);

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
    if (!mounted) return;
    localStorage.setItem("codecast-visual-style", visualStyle);
    document.documentElement.classList.remove("codex-style");
    document.documentElement.classList.toggle("minimal-style", visualStyle === "minimal");
  }, [visualStyle, mounted]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === "dark" ? "light" : "dark";
      updateClientUI({ theme: next });
      return next;
    });
  }, [updateClientUI]);

  const setVisualStyle = useCallback((style: VisualStyle) => {
    setVisualStyleState(style);
    updateClientUI({ visual_style: style });
  }, [updateClientUI]);

  if (!mounted) return null;

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, visualStyle, setVisualStyle }}>
      {children}
    </ThemeContext.Provider>
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
