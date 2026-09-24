"use client";

import { getRelativePath } from "@codecast/shared/render";
import { useDiffViewerStore } from "../../../store/diffViewerStore";

// Files a Bash call changed on disk, as the daemon observed them around the
// call (packages/cli/src/shellChanges.ts). The transcript itself carries no
// diff for a shell edit, so this line under the command's output is how the
// reader learns the call wrote anything; each name opens the diff panel on
// that file. Subscribes to a string signature of this call's changes, never
// the change list, so an unrelated store update re-renders nothing here.
export function ObservedChanges({ toolId }: { toolId: string }) {
  const sig = useDiffViewerStore((s) =>
    s.changes
      .filter((c) => c.toolCallId === toolId && c.id.includes(":fs:"))
      .map((c) => `${c.changeType}\t${c.filePath}`)
      .join("\n"),
  );
  if (!sig) return null;
  const files = sig.split("\n").map((line) => {
    const [changeType, filePath] = line.split("\t");
    return { changeType, filePath };
  });
  const open = (filePath: string) => {
    const st = useDiffViewerStore.getState();
    st.setDiffPanelOpen(true);
    st.selectFile(filePath);
  };
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1.5 sm:px-2 py-1 border-t border-sol-border/20 text-[11px] font-mono text-sol-text-dim">
      <span>changed</span>
      {files.map((f) => (
        <button
          key={f.filePath}
          type="button"
          onClick={(e) => { e.stopPropagation(); open(f.filePath); }}
          className={`hover:underline ${f.changeType === "delete" ? "line-through text-sol-red/80" : f.changeType === "write" ? "text-sol-text-secondary" : ""}`}
          title={f.changeType === "delete" ? "Deleted" : "Open diff"}
        >
          {getRelativePath(f.filePath)}
        </button>
      ))}
    </div>
  );
}
