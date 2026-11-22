// A file a session changed, named in that session's transcript, opens in the
// conversation's own diff panel on its latest change: the panel already holds
// the current text, so the reader never leaves the conversation for it.
// ConversationDiffLayout says whether a panel sits beside this transcript
// (DiffPanelContext); without one the link opens the file in Files as before.

import { createContext } from "react";
import { useDiffViewerStore } from "../store/diffViewerStore";
import { resolveCustomPath } from "./utils";
import type { FilePathContextValue } from "./filePathLinks";

/** True inside a conversation whose diff panel can open beside it. */
export const DiffPanelContext = createContext(false);

/** Opens the diff panel on `absPath` when the session changed it, showing its
 *  latest change, and says whether it did. */
export function openChangedFileInDiff(absPath: string, ctx: FilePathContextValue | null | undefined): boolean {
  const st = useDiffViewerStore.getState();
  let latest = -1;
  for (let i = st.changes.length - 1; i >= 0; i--) {
    const c = st.changes[i];
    if (c.changeType === "commit") continue;
    if ((resolveCustomPath(c.filePath, ctx?.home, ctx?.base) ?? c.filePath) === absPath) { latest = i; break; }
  }
  if (latest < 0) return false;
  // A timeline selection that leaves this change out would hide it.
  if ((st.selectedChangeIndex !== null && st.selectedChangeIndex < latest) || (st.rangeStart !== null && st.rangeStart > latest)) st.clearSelection();
  st.setDiffPanelOpen(true);
  st.selectFile(st.changes[latest].filePath);
  return true;
}
