import { useMemo, type CSSProperties } from "react";
import { useTheme } from "../components/ThemeProvider";
import { terminalIslandVars } from "../lib/terminal/theme";

/**
 * What a terminal's frame wears so its chrome matches the terminal inside it.
 * In Modern on a light page that is the dark palette (lib/terminal/theme.ts):
 * the `dark` class plus the dark variables on the frame itself, so every
 * `sol-*` class under it resolves dark. Elsewhere, nothing.
 */
export function useTerminalIsland(): { className: string; style: CSSProperties | undefined } {
  const { theme, visualStyle } = useTheme();
  return useMemo(() => {
    const vars = visualStyle === "modern" && theme === "light" ? terminalIslandVars() : null;
    return vars ? { className: "dark", style: vars as CSSProperties } : { className: "", style: undefined };
  }, [theme, visualStyle]);
}
