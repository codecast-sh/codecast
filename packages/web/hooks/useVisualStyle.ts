import { useTheme, type VisualStyle } from "../components/ThemeProvider";
import { useInboxStore } from "../store/inboxStore";

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

/** True while the person has Modern on with its Focused switch (settings,
 *  Appearance; inboxStore.isModernFocused). The trims branch on this. */
export function useIsModernFocused(): boolean {
  const modern = useIsModernStyle();
  const minimal = useInboxStore((s) => s.clientState.ui?.modern_focused === true);
  return modern && minimal;
}
