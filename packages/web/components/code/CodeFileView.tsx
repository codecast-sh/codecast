// A text file in Files, open in the code editor. This is the editor chunk's
// entry point (VaultFileView loads it lazily and prewarms it on idle), so
// CodeMirror, its languages and the editor engine stay out of every other
// bundle. Above the editor sits the strip for the one state that needs a
// person: disk and the buffer disagree.

import { useMemo, useRef, useState, type ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useVaultStore } from "../../store/vaultStore";
import { useCodeStore, type CodeConflict } from "../../store/codeStore";
import { bufferKey, codeBuffers, currentState, diskLockField, type CodeBuffer } from "../../lib/code/buffers";
import { registerCodeCommands, runCodeCommand, type CodeCommandContext, type CodeCommandId } from "../../lib/code/commands";
import { featureContext, focusedEditorView } from "../../lib/code/features";
import { formatAcceleratorParts } from "../../shortcuts";
import { KeyCap } from "../KeyCap";
import { parseCursorTarget, type EditorHost } from "../../lib/code/editorHost";
import { diskRemoved, keepMine, mergeWithDisk, overwriteLocked, recreateFile, saveBuffer, takeDisk } from "../../lib/code/fileSync";
import { loadMergeKit, stepMerge } from "../../lib/code/merge";
import { loadHotExit } from "../../lib/code/hotExit";
import { useIsNewFile } from "../../lib/code/newFiles";
import { CodeEditor } from "./CodeEditor";
import { BlameCardHost } from "./blame/BlameCardHost";
import { modernButton } from "../ui/modernLook";
import { ConflictWriter } from "./agent/ConflictWriter";
import { DaemonReconnecting, useStalled } from "../vault/FileUnavailable";
import { LoadingBar } from "../ui/LoadingBar";
import { Lock, WifiOff } from "lucide-react";
import { OverwriteReview } from "./OverwriteReview";

const stripButton = modernButton({ variant: "outline", size: "xs" });

// The strip's verbs as commands, so the palette and the keys reach them with
// focus in the editor: each acts on the buffer of the editor the person was
// in (contract 9) and declines when that buffer has no change to settle.
registerCodeCommands(
  Object.fromEntries(
    (
      [
        ["merge.withDisk", ["stale"], (b) => b.stale && mergeWithDisk(b, b.stale)],
        ["merge.takeDisk", ["stale", "merge"], (b) => takeDisk(b)],
        ["merge.keepMine", ["stale", "merge"], (b) => keepMine(b)],
        ["merge.next", ["merge"], (_b, view) => loadMergeKit().then((kit) => stepMerge(kit, view, 1))],
        ["merge.prev", ["merge"], (_b, view) => loadMergeKit().then((kit) => stepMerge(kit, view, -1))],
      ] as [CodeCommandId, CodeConflict["kind"][], (b: CodeBuffer, view: EditorView) => unknown][]
    ).map(([id, kinds, verb]) => [
      id,
      (_args: unknown, ctx: CodeCommandContext) => {
        const view = ctx.view ?? focusedEditorView();
        const at = view?.state.facet(featureContext);
        if (!view || !at) return false;
        const key = bufferKey(at.vaultId, at.path);
        const b = codeBuffers.get(key);
        const kind = useCodeStore.getState().conflicts[key]?.kind;
        if (!b || !kind || !kinds.includes(kind)) return false;
        void verb(b, view);
        view.focus();
      },
    ]),
  ),
);

/** A strip button that runs its command, and shows the key when it has one. */
function StripAction({ id, label, keys, name, view }: { id: CodeCommandId; label: ReactNode; keys?: string; name?: string; view: () => EditorView | undefined }) {
  const parts = keys ? formatAcceleratorParts(keys) : null;
  return (
    <button type="button" className={`${stripButton} gap-1`} aria-label={name} onClick={() => runCodeCommand(id, undefined, { view: view(), source: "menu" })}>
      {label}
      {parts?.map((k, i) => (
        <KeyCap key={i} size="xs">
          {k}
        </KeyCap>
      ))}
    </button>
  );
}

const STRIP_TITLE: Record<CodeConflict["kind"], string> = {
  error: "Save failed",
  deleted: "Deleted on disk",
  stale: "Changed on disk",
  merge: "Changed on disk",
  readonly: "Read-only on disk",
  offline: "Not saved",
};

function ConflictStrip({ conflict, bufferId, hostRef, onOverwrite }: { conflict: CodeConflict; bufferId: string; hostRef: React.MutableRefObject<EditorHost | null>; onOverwrite: () => void }) {
  const run = (fn: (b: NonNullable<ReturnType<typeof codeBuffers.get>>) => unknown) => () => {
    const b = codeBuffers.get(bufferId);
    if (b) void fn(b);
    hostRef.current?.view.focus();
  };
  const view = () => hostRef.current?.view;

  const alarm = conflict.kind === "error" || conflict.kind === "deleted";
  const tone = alarm ? "border-sol-red/40 bg-sol-red/10" : "border-sol-yellow/40 bg-sol-yellow/10";
  return (
    <div role="status" data-conflict={conflict.kind} className={`flex items-center gap-3 border-b px-3 py-1.5 text-meta ${tone}`}>
      {conflict.kind === "readonly" && <Lock aria-hidden className="h-3.5 w-3.5 shrink-0 text-sol-yellow" />}
      {conflict.kind === "offline" && <WifiOff aria-hidden className="h-3.5 w-3.5 shrink-0 text-sol-yellow" />}
      <span className="font-medium text-sol-text">{STRIP_TITLE[conflict.kind]}</span>
      {conflict.kind === "readonly" && <span className="tabular-nums text-sol-text-muted">{conflict.mode}</span>}
      {conflict.kind === "offline" && (
        <span className="flex items-center gap-1.5 text-sol-text-muted">
          <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-sol-yellow" />
          Reconnecting
        </span>
      )}
      {(conflict.kind === "stale" || conflict.kind === "merge") && <ConflictWriter bufferKey={bufferId} />}
      {conflict.kind === "merge" && (
        <span className="flex items-center gap-1.5 tabular-nums text-sol-text-muted">
          {conflict.conflicts > 0 && (
            <span data-merge-conflicts className="text-sol-red">
              {conflict.conflicts} {conflict.conflicts === 1 ? "conflict" : "conflicts"}
            </span>
          )}
          {conflict.conflicts > 0 && <span className="text-sol-text-dim">·</span>}
          <span>
            {conflict.remaining} {conflict.remaining === 1 ? "difference" : "differences"}
          </span>
        </span>
      )}
      {conflict.kind === "error" && (
        <span className="truncate rounded bg-sol-red/15 px-1.5 text-sol-red" title={conflict.message}>
          {conflict.message}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {conflict.kind === "merge" && (
          <>
            <StripAction id="merge.prev" view={view} label="↑" keys="Shift+Alt+F5" name={conflict.conflicts > 0 ? "Previous conflict" : "Previous difference"} />
            <StripAction id="merge.next" view={view} label="↓" keys="Alt+F5" name={conflict.conflicts > 0 ? "Next conflict" : "Next difference"} />
          </>
        )}
        {conflict.kind === "stale" && <StripAction id="merge.withDisk" view={view} label="Merge" />}
        {(conflict.kind === "stale" || conflict.kind === "merge") && <StripAction id="merge.takeDisk" view={view} label="Take disk" />}
        {(conflict.kind === "stale" || conflict.kind === "merge") && <StripAction id="merge.keepMine" view={view} label="Keep mine" />}
        {conflict.kind === "deleted" && (
          <button type="button" className={stripButton} onClick={run(recreateFile)}>
            Recreate
          </button>
        )}
        {conflict.kind === "readonly" && (
          <button type="button" className={stripButton} aria-haspopup="dialog" onClick={onOverwrite}>
            Overwrite
          </button>
        )}
        {(conflict.kind === "merge" || conflict.kind === "error") && (
          <button type="button" className={stripButton} onClick={run(saveBuffer)}>
            {conflict.kind === "error" ? "Retry" : conflict.conflicts > 0 ? "Save merge" : "Save"}
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

  // A cached boot reads the file once the daemon answers. When that takes
  // longer than a beat, the wait turns into the read-failure state, with a
  // Retry that reconnects, rather than an empty editor with no end.
  const reconnecting = useVaultStore((s) => s.connection === "cached" && !s.endpoint && !s.isRemote);
  const [stalled, retryStalled] = useStalled(waiting && preview === null && reconnecting, key);

  // Writing a file its mode refuses asks first: the strip's Overwrite, and
  // vim's `:w!` (file.overwrite) from this editor. On a writable file `:w!` is
  // a plain save.
  const [overwriting, setOverwriting] = useState<string | null>(null);
  const askOverwrite = () => {
    const b = codeBuffers.get(key);
    if (!b) return;
    const mode = conflict?.kind === "readonly" ? conflict.mode : currentState(b).field(diskLockField);
    if (mode) setOverwriting(mode);
    else void saveBuffer(b);
  };
  const askRef = useRef(askOverwrite);
  askRef.current = askOverwrite;
  useWatchEffect(() => {
    if (!key) return;
    return registerCodeCommands({
      "file.overwrite": (_args, ctx) => {
        const view = ctx.view ?? focusedEditorView();
        if (!view || view !== hostRef.current?.view) return false;
        askRef.current();
      },
    });
  }, [key]);

  if (!vaultId) return null;
  // While the file's text is on its way the editor stays mounted, empty, so
  // opening a file never rebuilds the view or jumps the layout.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {conflict && <ConflictStrip conflict={conflict} bufferId={key} hostRef={hostRef} onOverwrite={askOverwrite} />}
      {overwriting && (
        <OverwriteReview
          path={path}
          mode={overwriting}
          onClose={() => {
            setOverwriting(null);
            hostRef.current?.view.focus();
          }}
          onConfirm={() => {
            setOverwriting(null);
            const b = codeBuffers.get(key);
            if (b) void overwriteLocked(b);
            hostRef.current?.view.focus();
          }}
        />
      )}
      <div className="relative min-h-0 flex-1">
        {waiting && !preview && (
          <LoadingBar className="absolute inset-x-0 top-0 z-10" />
        )}
        {stalled && (
          <div className="absolute inset-0 z-20 bg-sol-bg">
            <DaemonReconnecting path={path} onRetry={retryStalled} />
          </div>
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
