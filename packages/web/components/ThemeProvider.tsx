import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";

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

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [mounted, setMounted] = useState(false);
  const serverTheme = useInboxStore((s) => s.clientState.ui?.theme);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!mounted || !serverTheme || serverTheme === theme) return;
    const stored = localStorage.getItem("codecast-theme");
    if (!stored) {
      setTheme(serverTheme);
    } else if (stored !== serverTheme) {
      updateClientUI({ theme: stored as Theme });
    }
  }, [serverTheme, mounted]);

  useEffect(() => {
    if (mounted) {
      localStorage.setItem("codecast-theme", theme);
      document.documentElement.classList.remove("dark", "light");
      document.documentElement.classList.add(theme);
    }
  }, [theme, mounted]);

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === "dark" ? "light" : "dark";
      updateClientUI({ theme: next });
      return next;
    });
  }, [updateClientUI]);

  if (!mounted) return null;

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
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
