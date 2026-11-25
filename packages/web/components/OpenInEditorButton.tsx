"use client";

// The compact "Open in editor" action a tool card, a diff file header or a
// blob page carries: one icon button that opens a local file in the code
// editor beside the stage at the place the surface is about
// (lib/filesPane openInEditor). The conversation it sits in, if any,
// resolves a relative path and becomes the editor's linked session.

import { useContext } from "react";
import { Code2 } from "lucide-react";
import { FilePathContext } from "../lib/filePathLinks";
import { openInEditor, type EditorTarget, type OpenInEditorOptions } from "../lib/filesPane";
import { useTabContext } from "../lib/tabParams";
import { cn } from "../lib/utils";

export function OpenInEditorButton({
  target,
  diffAgainst,
  label,
  className,
}: {
  /** `ctx` resolves a relative path; the conversation's own when absent. */
  target: EditorTarget;
  diffAgainst?: OpenInEditorOptions["diffAgainst"];
  /** Shown beside the icon; icon only when absent. */
  label?: string;
  className?: string;
}) {
  const ctx = useContext(FilePathContext);
  const fromLeaf = useTabContext()?.leafId ?? null;
  const where = target.line ? `:${target.line}${target.endLine ? `-${target.endLine}` : ""}` : "";
  const title = diffAgainst ? `Edit ${target.path}${where} with its diff against ${diffAgainst.label ?? diffAgainst.ref}` : `Open ${target.path}${where} in the editor`;
  return (
    <button
      type="button"
      data-open-in-editor
      title={title}
      aria-label={label ? undefined : "Open in editor"}
      onClick={(e) => {
        e.stopPropagation();
        openInEditor({ ...target, ctx: target.ctx ?? ctx }, { fromLeaf, diffAgainst });
      }}
      className={cn(
        "inline-flex items-center gap-1 shrink-0 rounded px-0.5 text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors",
        className,
      )}
    >
      <Code2 className="w-3.5 h-3.5" />
      {label && <span className="text-meta">{label}</span>}
    </button>
  );
}
