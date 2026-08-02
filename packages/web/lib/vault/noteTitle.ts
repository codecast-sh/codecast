// The display title of a vault note tab: its own H1 or frontmatter title, with
// the filename as the fallback. Kept in its own module so TabBar — which every
// user renders — pulls in nothing from the vault index unless a vault tab is
// actually open.

import { vaultIndex } from "./indexSingleton";

/** Title for a `/vault?f=<path>` tab path, or null when it isn't one (or the
 *  note isn't indexed yet, in which case the caller's filename fallback is
 *  still the honest answer). */
export function vaultNoteTitle(tabPath: string): string | null {
  if (!tabPath.startsWith("/vault?") && !tabPath.startsWith("/vault/")) return null;
  const query = tabPath.split("?")[1];
  if (!query) return null;
  let notePath: string | null = null;
  try {
    notePath = new URLSearchParams(query).get("f");
  } catch {
    return null;
  }
  if (!notePath) return null;
  const title = vaultIndex.note(decodeURIComponent(notePath))?.title;
  return title && title.trim() ? title : null;
}
