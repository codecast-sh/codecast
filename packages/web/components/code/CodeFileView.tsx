// A text file in Files, open in the code editor. This is the editor chunk's
// entry point (VaultFileView loads it lazily and prewarms it on idle), so
// CodeMirror, its languages and the editor engine stay out of every other
// bundle. Above the editor sits the strip for the one state that needs a
// person: disk and the buffer disagree.

import { useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useVaultStore } from "../../store/vaultStore";
import { useCodeStore, type CodeConflict } from "../../store/codeStore";
import { bufferKey, codeBuffers } from "../../lib/code/buffers";
import { parseCursorTarget, type EditorHost } from "../../lib/code/editorHost";
import { diskRemoved, mergeWithDisk, recreateFile, saveBuffer, takeDisk } from "../../lib/code/fileSync";
import { loadMergeKit } from "../../lib/code/merge";
import { loadHotExit } from "../../lib/code/hotExit";
import { useIsNewFile } from "../../lib/code/newFiles";
import { CodeEditor } from "./CodeEditor";
import { BlameCardHost } from "./blame/BlameCardHost";
import { modernButton } from "../ui/modernLook";
import { ConflictWriter } from "./agent/ConflictWriter";

const stripButton = modernButton({ variant: "outline", size: "xs" });

function ConflictStrip({ conflict, bufferId, hostRef }: { conflict: CodeConflict; bufferId: string; hostRef: React.MutableRefObject<EditorHost | null> }) {
  const buffer = () => codeBuffers.get(bufferId);
  const run = (fn: (b: NonNullable<ReturnType<typeof buffer>>) => unknown) => () => {
    const b = buffer();
    if (b) void fn(b);
    hostRef.current?.view.focus();
  };
  const step = (dir: 1 | -1) => () => {
    const view = hostRef.current?.view;
    if (!view) return;
    void loadMergeKit().then((kit) => (dir === 1 ? kit.goToNextChunk : kit.goToPreviousChunk)(view));
    view.focus();
  };

  const alarm = conflict.kind === "error" || conflict.kind === "deleted";
  const tone = alarm ? "border-sol-red/40 bg-sol-red/10" : "border-sol-yellow/40 bg-sol-yellow/10";
  const title = { error: "Save failed", deleted: "Deleted on disk", stale: "Changed on disk", merge: "Changed on disk" }[conflict.kind];
  return (
    <div role="status" className={`flex items-center gap-3 border-b px-3 py-1.5 text-meta ${tone}`}>
      <span className="font-medium text-sol-text">{title}</span>
      {(conflict.kind === "stale" || conflict.kind === "merge") && <ConflictWriter bufferKey={bufferId} />}
      {conflict.kind === "merge" && (
        <span className="tabular-nums text-sol-text-muted">
          {conflict.remaining} {conflict.remaining === 1 ? "difference" : "differences"}
          {conflict.conflicts > 0 && ` · ${conflict.conflicts} ${conflict.conflicts === 1 ? "conflict" : "conflicts"}`}
        </span>
      )}
      {conflict.kind === "error" && <span className="truncate text-sol-text-muted" title={conflict.message}>{conflict.message}</span>}
      <span className="ml-auto flex items-center gap-1.5">
        {conflict.kind === "merge" && (
          <>
            <button type="button" className={stripButton} onClick={step(-1)} aria-label="Previous difference">↑</button>
            <button type="button" className={stripButton} onClick={step(1)} aria-label="Next difference">↓</button>
          </>
        )}
        {conflict.kind === "stale" && (
          <button type="button" className={stripButton} onClick={run((b) => b.stale && mergeWithDisk(b, b.stale))}>
            Merge
          </button>
        )}
        {(conflict.kind === "stale" || conflict.kind === "merge") && (
          <button type="button" className={stripButton} onClick={run(takeDisk)}>
            Take disk
          </button>
        )}
        {conflict.kind === "deleted" ? (
          <button type="button" className={stripButton} onClick={run(recreateFile)}>
            Recreate
          </button>
        ) : (
          <button type="button" className={stripButton} onClick={run(saveBuffer)}>
            {conflict.kind === "merge" ? "Save merge" : conflict.kind === "error" ? "Retry" : "Keep mine"}
          </button>
        )}
      </span>
    </div>
  );
}

/** `missing`: the file is gone from disk (VaultFileView keeps an editor with
 *  unsaved edits mounted through that, so they can be recreated).
 *  `newFile`: it never existed here; an empty buffer opens, and saving
 *  creates it. */
export function CodeFileView({ path, line, missing = false, newFile: noFile = false }: { path: string; line?: string | null; missing?: boolean; newFile?: boolean }) {
  const vaultId = useVaultStore((s) => s.activeVaultId);
  const body = useVaultStore((s) => s.bodies[path]);
  const readOnly = useVaultStore((s) => s.isRemote);
  const key = vaultId ? bufferKey(vaultId, path) : "";
  const conflict = useCodeStore((s) => (key ? s.conflicts[key] : undefined));
  const hostRef = useRef<EditorHost | null>(null);
  const target = useMemo(() => parseCursorTarget(line), [line]);
  const unsaved = useCodeStore((s) => !!s.dirty[key]);
  const isNew = useIsNewFile(key);
  // Nothing on disk: a buffer already open on this path was deleted under it
  // (its strip offers Recreate); with none, this is a new file.
  const newFile = noFile && (isNew || !codeBuffers.get(key));
  const deleted = (missing || noFile) && !newFile;
  useWatchEffect(() => {
    const b = deleted ? codeBuffers.get(key) : undefined;
    if (b) diskRemoved(b, { evenIfClean: true });
  }, [deleted, unsaved, key]);

  // Until the text arrives (a cached boot waits on the daemon), unsaved text a
  // reload interrupted is shown read-only, so the person sees their work at
  // once; it becomes editable when the buffer opens and restores it.
  const waiting = !body && !codeBuffers.get(key) && !newFile;
  const [held, setHeld] = useState<{ key: string; text: string } | null>(null);
  useWatchEffect(() => {
    if (!waiting || !key) return;
    let live = true;
    void loadHotExit(key).then(
      (rec) => live && rec && setHeld({ key, text: rec.mine }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [waiting, key]);
  const preview = waiting && held?.key === key ? held.text : null;

  if (!vaultId) return null;
  // While the file's text is on its way the editor stays mounted, empty, so
  // opening a file never rebuilds the view or jumps the layout.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {conflict && <ConflictStrip conflict={conflict} bufferId={key} hostRef={hostRef} />}
      <div className="relative min-h-0 flex-1">
        {waiting && !preview && (
          <div className="pointer-events-none absolute left-14 top-2 z-10 text-meta text-sol-text-dim">Loading…</div>
        )}
        <CodeEditor
          vaultId={vaultId}
          path={path}
          body={body}
          readOnly={readOnly}
          preview={preview}
          target={target}
          newFile={newFile}
          hostRef={hostRef}
        />
        <BlameCardHost hostRef={hostRef} />
      </div>
    </div>
  );
}

export default CodeFileView;
