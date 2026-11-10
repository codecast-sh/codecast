import { useTheme, type VisualStyle } from "../components/ThemeProvider";

/** The interface style on screen: Classic, Minimal or the opt-in Modern. */
export function useVisualStyle(): VisualStyle {
  return useTheme().visualStyle;
}

/** True while the person has the Modern style on. Structural differences
 *  (the rail, the page header) branch on this; looks use the `modern:`
 *  Tailwind variant or a `.modern-style` selector instead. */
export function useIsModernStyle(): boolean {
  return useTheme().visualStyle === "modern";
}
