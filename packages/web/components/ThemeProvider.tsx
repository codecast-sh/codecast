"use client";

import { createContext, useContext, useEffect, useState, ReactNode, useCallback, lazy, Suspense } from "react";

type Theme = "dark" | "light";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem("codecast-theme") as Theme | null;
  return stored || "light";
}

const ThemeSyncWithServer = lazy(() => import("./ThemeSyncWithServer"));

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) {
      localStorage.setItem("codecast-theme", theme);
      document.documentElement.classList.remove("dark", "light");
      document.documentElement.classList.add(theme);
    }
  }, [theme, mounted]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => prev === "dark" ? "light" : "dark");
  }, []);

  if (!mounted) {
    return null;
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      <Suspense fallback={null}>
        <ThemeSyncWithServer theme={theme} setTheme={setTheme} />
      </Suspense>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
