"use client";

import { useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";

type Theme = "dark" | "light";

interface ThemeSyncProps {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

export default function ThemeSyncWithServer({ theme, setTheme }: ThemeSyncProps) {
  const serverThemeApplied = useRef(false);
  const user = useQuery(api.users.getCurrentUser);
  const setThemeMutation = useMutation(api.users.setTheme);

  useEffect(() => {
    if (user !== undefined && !serverThemeApplied.current) {
      serverThemeApplied.current = true;
      if (user?.theme && user.theme !== theme) {
        setTheme(user.theme);
        localStorage.setItem("codecast-theme", user.theme);
      }
    }
  }, [user, theme, setTheme]);

  useEffect(() => {
    if (user && theme) {
      const currentUserTheme = user.theme;
      if (currentUserTheme !== theme) {
        setThemeMutation({ theme });
      }
    }
  }, [theme, user, setThemeMutation]);

  return null;
}
