import { useSyncExternalStore } from "react";
import { useTabContext } from "../lib/tabParams";

// Is the reader actually HERE — this tab on screen, the window focused, the
// document visible? Read marks (chat channels, the Threads page) must follow
// this, never mere mount: a chat tab hidden behind Inbox is not being read.

/** document.hasFocus() is not state React can see, so it is subscribed to. */
function subscribePresence(fn: () => void): () => void {
  window.addEventListener("focus", fn);
  window.addEventListener("blur", fn);
  document.addEventListener("visibilitychange", fn);
  return () => {
    window.removeEventListener("focus", fn);
    window.removeEventListener("blur", fn);
    document.removeEventListener("visibilitychange", fn);
  };
}

function readPresence(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** Is this page the tab pane on screen? No tab shell (a standalone window, a
 *  test) means the page IS the view. */
export function useTabActive(): boolean {
  const tab = useTabContext();
  return tab ? tab.isActive : true;
}

/** True while this page is the active tab pane AND the window is focused and
 *  visible. */
export function usePagePresence(): boolean {
  const tabActive = useTabActive();
  const windowPresent = useSyncExternalStore(subscribePresence, readPresence, () => false);
  return tabActive && windowPresent;
}
