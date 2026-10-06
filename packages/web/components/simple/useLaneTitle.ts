// The window title of a page outside DashboardLayout in the hosted family
// (/welcome, /connect/whisk). index.html ships the marketing title and
// nothing else replaces it there, so each writes its own: "Codecast Welcome".
// Same format as the full app (appDocumentTitle), since the
// browser tab, history and the window switcher all list windows by it.
import { useLocation } from "react-router";
import { appDocumentTitle } from "../../lib/browserPane";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { laneSurfaceLabel } from "./lane";

/** Write the window title for the page at the current path, naming `thing`
 *  after the page's own name when there is one. */
export function useLaneDocumentTitle(thing: string | null = null): void {
  const { pathname } = useLocation();
  const title = appDocumentTitle(laneSurfaceLabel(pathname), thing);
  useWatchEffect(() => {
    if (document.title !== title) document.title = title;
  }, [title]);
}
