"use client";

// The compact "Open in editor" action a tool card, a diff file header or a
// blob page carries: one icon button that opens a local file in the code
// editor beside the stage at the place the surface is about
// (lib/filesPane openConversationPath). The conversation it sits in, if any,
// resolves a relative path and becomes the editor's linked session.
//
// Where this machine cannot reach the conversation's files (another person's
// or a guest's conversation, no daemon), the button opens the session's own
// changes for a file the session changed, and is not drawn otherwise.

import { useContext } from "react";
import { Code2, FileDiff } from "lucide-react";
import { FilePathContext, matchSessionChangedFile } from "../lib/filePathLinks";
import { editorReachable, openConversationPath, type EditorTarget, type OpenInEditorOptions } from "../lib/filesPane";
import { useTabContext } from "../lib/tabParams";
import { useVaultStore } from "../store/vaultStore";
import { useDiffViewerStore } from "../store/diffViewerStore";
import { cn } from "../lib/utils";

export function OpenInEditorButton({
  target,
  diffAgainst,
  peek,
  label,
  editorOnly,
  className,
}: {
  /** `ctx` resolves a relative path; the conversation's own when absent. */
  target: EditorTarget;
  diffAgainst?: OpenInEditorOptions["diffAgainst"];
  /** Peek the change at the landed line once the file shows (an edit card). */
  peek?: boolean;
  /** Shown beside the icon; icon only when absent. */
  label?: string;
  /** Not drawn when the editor cannot reach the file (a surface that already
   *  is the session's changes, such as the diff pane). */
  editorOnly?: boolean;
  className?: string;
}) {
  const conversationCtx = useContext(FilePathContext);
  const ctx = target.ctx ?? conversationCtx;
  const fromLeaf = useTabContext()?.leafId ?? null;
  const reachable = editorReachable(ctx, useVaultStore((s) => s.connection));
  const inChanges = useDiffViewerStore(
    (s) => !reachable && !editorOnly && !!ctx?.conversationId && s.conversationId === ctx.conversationId && matchSessionChangedFile(target.path, s.changes, ctx) !== null,
  );
  if (!reachable && !inChanges) return null;
  const where = target.line ? `:${target.line}${target.endLine ? `-${target.endLine}` : ""}` : "";
  const title = !reachable
    ? `Open ${target.path} in the session's changes`
    : diffAgainst
      ? `Edit ${target.path}${where} with its diff against ${diffAgainst.label ?? diffAgainst.ref}`
      : `Open ${target.path}${where} in the editor`;
  const Icon = reachable ? Code2 : FileDiff;
  return (
    <button
      type="button"
      data-open-in-editor
      title={title}
      aria-label={label ? undefined : reachable ? "Open in editor" : "Open in session changes"}
      onClick={(e) => {
        e.stopPropagation();
        openConversationPath({ ...target, ctx }, { fromLeaf, diffAgainst, peek });
      }}
      className={cn(
        "inline-flex items-center gap-1 shrink-0 rounded px-0.5 text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors",
        className,
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      {label && <span className="text-meta">{label}</span>}
    </button>
  );
}
