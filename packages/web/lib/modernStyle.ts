// Modern is the default style. It is off only where the person turned it off
// (`modern_style: false`), or chose Minimal before Modern existed and so never
// wrote `modern_style` at all. Web (ThemeProvider, the store) and the phone
// (packages/mobile/lib/mobileLook.ts) decide it here.
export function prefersModern(ui: { modern_style?: unknown; visual_style?: unknown } | null | undefined): boolean {
  const own = ui?.modern_style;
  if (own === true || own === false) return own;
  return ui?.visual_style !== "minimal" && ui?.visual_style !== "codex";
}

// The style a web device draws is its own: Modern and the base style each
// have a localStorage key (ThemeProvider writes them, index.html replays them
// at boot), and the account's synced values only fill in where this device
// never chose.
export const MODERN_STYLE_KEY = "codecast-modern-style";
export const VISUAL_STYLE_KEY = "codecast-visual-style";

function readDevice(key: string): string | null {
  return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
}

/** This device's own Modern choice, or undefined where it never chose. */
export function storedModern(): boolean | undefined {
  const v = readDevice(MODERN_STYLE_KEY);
  return v === null ? undefined : v === "1";
}

/** Whether this device draws Modern. The same answer ThemeProvider paints, so
 *  store code that cannot read its context (worker nesting, the board) agrees
 *  with the screen. */
export function showsModern(ui: { modern_style?: unknown; visual_style?: unknown } | null | undefined): boolean {
  const own = storedModern();
  if (own !== undefined) return own;
  return prefersModern({ modern_style: ui?.modern_style, visual_style: readDevice(VISUAL_STYLE_KEY) ?? ui?.visual_style });
}
