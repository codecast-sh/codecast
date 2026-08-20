"use client";
import { FolderTree } from "lucide-react";
import { filesHref } from "../lib/vault/vaultHref";
import { openFiles } from "../lib/filesPane";

/** Header action: browse the session's project in Files — beside the
 *  conversation when the stage allows, otherwise in this tab. The standing
 *  route to the files, for when nothing in the transcript links there. */
export function SessionFilesButton({ projectPath }: { projectPath: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openFiles(filesHref({ localPath: projectPath }));
      }}
      className="p-1 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight/40 transition-colors flex-shrink-0"
      title="Browse project files"
      aria-label="Browse project files"
    >
      <FolderTree className="w-3.5 h-3.5" />
    </button>
  );
}
