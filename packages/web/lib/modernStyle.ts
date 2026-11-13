// Modern is the default style. It is off only where the person turned it off
// (`modern_style: false`), or chose Minimal before Modern existed and so never
// wrote `modern_style` at all. Web (ThemeProvider, the store) and the phone
// (packages/mobile/lib/mobileLook.ts) decide it here.
export function prefersModern(ui: { modern_style?: unknown; visual_style?: unknown } | null | undefined): boolean {
  const own = ui?.modern_style;
  if (own === true || own === false) return own;
  return ui?.visual_style !== "minimal" && ui?.visual_style !== "codex";
}
