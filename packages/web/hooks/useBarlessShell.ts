// Whether the shell runs without its top bar: hosted mode on a desktop-width
// browser (lib/surfaceRules "chrome.topBar"). A phone keeps the bar for its
// menu button, and the desktop app keeps it as the window's titlebar. The
// layout drops the header on this answer and the sidebar takes the bar's
// search, bell and account, so the two read one rule.
import { useSurface } from "../lib/surfaces";
import { isElectron } from "../lib/desktop";
import { useIsPhone } from "./useIsPhone";

export function useBarlessShell(): boolean {
  const barShown = useSurface("chrome.topBar");
  const phone = useIsPhone();
  return !barShown && !phone && !isElectron();
}
