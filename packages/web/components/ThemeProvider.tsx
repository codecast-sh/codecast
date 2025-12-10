"use client";

import { createContext, useContext, useEffect, useState, ReactNode, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";

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
  const serverThemeApplied = useRef(false);

  const user = useQuery(api.users.getCurrentUser);
  const setThemeMutation = useMutation(api.users.setTheme);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (user !== undefined && !serverThemeApplied.current) {
      serverThemeApplied.current = true;
      if (user?.theme) {
        setTheme(user.theme);
        localStorage.setItem("codecast-theme", user.theme);
      }
    }
  }, [user]);

  useEffect(() => {
    if (mounted) {
      localStorage.setItem("codecast-theme", theme);
      document.documentElement.classList.remove("dark", "light");
      document.documentElement.classList.add(theme);
    }
  }, [theme, mounted]);

  const toggleTheme = () => {
    const newTheme = theme === "dark" ? "light" : "dark";
    setTheme(newTheme);
    if (user) {
      setThemeMutation({ theme: newTheme });
    }
  };

  if (!mounted) {
    return null;
  }

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
