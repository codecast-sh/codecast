// Opening a file or directory in the viewed conversation's own diff pane when
// that conversation recorded changes there. Lives in lib/ so FilePathLink.tsx
// exports only its component (Fast Refresh boundary guard).

import { matchSessionChangedFile, type FilePathContextValue } from "./filePathLinks";
import { useDiffViewerStore } from "../store/diffViewerStore";
import { useInboxStore } from "../store/inboxStore";

export function openSessionChangedPath(path: string, ctx: FilePathContextValue | null | undefined): boolean {
  if (!ctx?.conversationId) return false;
  const dv = useDiffViewerStore.getState();
  if (dv.conversationId !== ctx.conversationId || dv.changes.length === 0) return false;
  const hit = matchSessionChangedFile(path, dv.changes, ctx);
  if (!hit) return false;
  if (useInboxStore.getState()?.clientState?.ui?.diff_base?.[ctx.conversationId]) {
    dv.setDiffBase(ctx.conversationId, "session");
  } else {
    dv.clearSelection();
  }
  dv.setDiffPanelOpen(true);
  if (hit.kind === "file") dv.selectFile(hit.filePath);
  return true;
}
