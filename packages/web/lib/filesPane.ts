// Opening the Files surface FROM somewhere else — a file link in a
// conversation, the header's Files action, the selection toolbar. One rule for
// where it goes: beside what's on stage as a split pane when the stage can
// hold one (lib/stage.openBeside), otherwise the tab navigates. Cmd-click and
// "open in new tab" never come here; the Link compat handles those.

import { openBeside } from "./stage";
import { tabNavigate } from "../src/compat/tabRouting";

/** True when a Files pane may open beside what's on stage right now. */
export function canOpenFilesBeside(): boolean {
  return typeof window !== "undefined" && window.innerWidth >= 900;
}

/** Show `href` (a /files URL) as a pane beside the stage. */
export function openFilesBeside(href: string): void {
  if (!openBeside(href)) tabNavigate(href, "push");
}

/** Beside if the stage allows it, else navigate the tab. */
export function openFiles(href: string): void {
  if (canOpenFilesBeside()) openFilesBeside(href);
  else tabNavigate(href, "push");
}
