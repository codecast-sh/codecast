import { useCallback } from "react";
import { useShortcutAction } from "../shortcuts";
import { useInboxStore } from "../store/inboxStore";
import { leavesOf } from "../store/stageSplit";
import { openBeside, stageClose, stageExpand, stageFocus, tabStageLayout } from "../lib/stage";

/** Is the active tab's stage split right now? Shared by the palette's
 *  visibility rules and the handlers below. */
export function stageIsSplit(): boolean {
  const st = useInboxStore.getState();
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  return !!tab && !!tabStageLayout(tab);
}

function focusedLeaf() {
  const st = useInboxStore.getState();
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  const layout = tab ? tabStageLayout(tab) : null;
  if (!tab || !layout) return null;
  const leaves = leavesOf(layout);
  const idx = Math.max(0, leaves.findIndex((l) => l.id === tab.focusedLeafId));
  return { leaves, idx };
}

/**
 * The pane chords (shortcuts/registry `pane.*`). Every handler returns false
 * when the stage isn't split, so the chord falls through to whatever else
 * owns it (Cmd+Shift+W to the window, say). Mounted once in the shell.
 */
export function useStageShortcuts() {
  useShortcutAction("pane.split", useCallback(() => {
    const st = useInboxStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (!tab) return false;
    return openBeside(tab.path) || false;
  }, []));

  useShortcutAction("pane.close", useCallback(() => {
    const f = focusedLeaf();
    if (!f) return false;
    stageClose(f.leaves[f.idx].id);
  }, []));

  useShortcutAction("pane.expand", useCallback(() => {
    const f = focusedLeaf();
    if (!f) return false;
    stageExpand(f.leaves[f.idx].id);
  }, []));

  useShortcutAction("pane.next", useCallback(() => {
    const f = focusedLeaf();
    if (!f) return false;
    stageFocus(f.leaves[(f.idx + 1) % f.leaves.length].id);
  }, []));

  useShortcutAction("pane.prev", useCallback(() => {
    const f = focusedLeaf();
    if (!f) return false;
    stageFocus(f.leaves[(f.idx - 1 + f.leaves.length) % f.leaves.length].id);
  }, []));
}
