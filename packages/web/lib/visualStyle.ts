/** Outside React: whether the Modern style is on, read from the root class
 *  ThemeProvider and the boot script set. False where there is no document. */
export function isModernStyle(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("modern-style");
}
