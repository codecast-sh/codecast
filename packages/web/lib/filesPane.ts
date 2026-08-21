// Opening the Files surface FROM somewhere else — a file link in a
// conversation, the header's Files action, the selection toolbar. One rule for
// where it goes: beside the conversation when the stage can hold a second
// pane (slotPolicyFor(...).files), otherwise the tab navigates. Cmd-click and
// "open in new tab" never come here; the Link compat handles those.

import { useInboxStore } from "../store/inboxStore";
import { slotPolicyFor, surfaceForPath } from "../store/workspace";
import { tabNavigate } from "../src/compat/tabRouting";

/** The route the user is looking at: the active tab's path, or the URL. */
function currentSurfacePath(): string {
  const st = useInboxStore.getState();
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  const path = tab?.path ?? (typeof window !== "undefined" ? window.location.pathname : "");
  return path.split("?")[0].split("#")[0];
}

/** True when a Files pane may open beside what's on stage right now. */
export function canOpenFilesBeside(): boolean {
  if (typeof window === "undefined" || window.innerWidth < 900) return false;
  return slotPolicyFor(surfaceForPath(currentSurfacePath())).files;
}

/** Show `href` (a /files URL) in the secondary slot. */
export function openFilesBeside(href: string): void {
  useInboxStore.getState().wsShow("secondary", { kind: "files", ref: href }, { presentation: "split" });
}

/** Beside if the stage allows it, else navigate the tab. */
export function openFiles(href: string): void {
  if (canOpenFilesBeside()) openFilesBeside(href);
  else tabNavigate(href, "push");
}
