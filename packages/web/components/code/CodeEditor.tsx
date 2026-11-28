// The code editor component: one CodeMirror view for as long as it is mounted,
// showing whichever file's buffer it is given. A new path is `setState` with
// that buffer's saved state, never a new view (contract 2), and typing reaches
// React not at all (contract 1): the document, cursor and status bar live in
// CodeMirror, and this component re-renders only when its props change.
//
// Keys: the editor is a `data-owns-keys` region, so the app's single-key
// shortcuts and every page listener that asks keyBelongsElsewhere stay out of
// it. Its Ctrl chords and Escape need a keyboard-owner entry for
// `[data-code-editor]` in shortcuts/keyOwnership.ts, because the dispatcher
// listens in window capture, ahead of anything this component can do.

import { useRef } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { codeMirrorUndoGuard } from "../vault/codeMirrorUndo";
import { bufferKey, codeBuffers, syncDiskLock } from "../../lib/code/buffers";
import { flashStatusLock } from "../../lib/code/statusBar";
import { registerCodeCommands, type CodeCommandContext } from "../../lib/code/commands";
import { EditorHost, openCodeBuffer, openNewFileBuffer, previewState, syncReadOnly, type CursorTarget } from "../../lib/code/editorHost";
import { applyDiskVersion, installCloseGuard, revertBuffer, saveAllBuffers, saveBuffer } from "../../lib/code/fileSync";
import { registerWorkspaceEditorFeatures } from "../../lib/code/workspace/editorWorkspace";
import { adoptMovedEdits } from "../../lib/code/workspace/followFiles";
import { bindGroupView, registerGroupSwitcher } from "../../lib/code/workspace/groupRegistry";
import { hostBuffer, isMirror, releaseHost, showInHost } from "../../lib/code/workspace/splitSync";
import type { VaultBody } from "../../store/vaultStore";
import { useCodeGroup } from "./workspace/groupContext";

registerWorkspaceEditorFeatures();

export interface CodeEditorProps {
  vaultId: string;
  path: string;
  /** Disk's current version, as the vault store holds it; undefined while
   *  it loads, when the editor shows nothing but stays mounted. */
  body: VaultBody | undefined;
  /** Follows the vault: an open buffer turns read-only (or writable) with it. */
  readOnly: boolean;
  /** Text to show read-only while there is no body and no buffer yet (unsaved
   *  text held for hot exit, while the daemon reconnects). */
  preview?: string | null;
  /** Where to put the cursor when this file (or this target) is shown. */
  target?: CursorTarget | null;
  /** The file does not exist: open an empty buffer under its name, which
   *  the first save creates (lib/code/newFiles.ts). */
  newFile?: boolean;
  /** Lets the surface around the editor reach it (merge controls). */
  hostRef?: React.MutableRefObject<EditorHost | null>;
}

export function CodeEditor({ vaultId, path, body, readOnly, preview, target, newFile = false, hostRef }: CodeEditorProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const host = useRef<EditorHost | null>(null);
  const group = useCodeGroup();
  // Read at the moment of showing, so a group gaining focus never re-shows.
  const groupActive = useRef(true);
  groupActive.current = group ? group.active : true;
  // A target is a one-shot request: it moves the cursor when it is new, never
  // again when something else re-shows the file (read-only flipping).
  const revealed = useRef<{ target: CursorTarget | null | undefined; path: string } | null>(null);

  useMountEffect(() => {
    const undoGuard = codeMirrorUndoGuard();
    const h = new EditorHost(parentRef.current!, undoGuard.extension);
    host.current = h;
    if (hostRef) hostRef.current = h;
    const unregisterUndo = undoGuard.register(h.view);
    installCloseGuard();
    // Commands act on the editor they came from, else the one on screen here.
    const bufferFor = (ctx: CodeCommandContext) => {
      if (ctx.view && ctx.view !== h.view) return false;
      return hostBuffer(h) ?? false;
    };
    const unregisterCommands = registerCodeCommands({
      "file.save": (_args, ctx) => {
        const b = bufferFor(ctx);
        if (!b) return false;
        // A save that wrote nothing because the file is locked shows it on the
        // lock, as vim answers E45: the key never does nothing visible.
        void saveBuffer(b).then((outcome) => {
          if ((outcome === "readonly" || outcome === "locked") && b.view) flashStatusLock(b.view);
        });
      },
      "file.saveAll": () => {
        void saveAllBuffers();
      },
      "file.revert": (_args, ctx) => {
        const b = bufferFor(ctx);
        if (!b) return false;
        void revertBuffer(b);
      },
    });
    return () => {
      unregisterCommands();
      unregisterUndo();
      releaseHost(h);
      h.destroy();
      host.current = null;
      if (hostRef) hostRef.current = null;
    };
  });

  // The file shown. `body` is read only when the buffer is first created; after
  // that the buffer is the authority and disk news reaches it by path (below).
  // A buffer already open needs no body: it is shown straight away.
  useWatchEffect(() => {
    const h = host.current;
    if (!h) return;
    const open = codeBuffers.get(bufferKey(vaultId, path));
    if (!open && !body && !newFile) {
      releaseHost(h);
      if (preview) h.showPreview(previewState({ vaultId, path, content: preview }));
      else h.showEmpty();
      return;
    }
    const buffer =
      open ??
      (body
        ? openCodeBuffer({ vaultId, path, content: body.content, etag: body.etag, sizeBytes: body.size, readOnly })
        : openNewFileBuffer({ vaultId, path, readOnly }));
    if (open) syncReadOnly(open, readOnly);
    else if (body) syncDiskLock(buffer, body.lockedMode);
    const fresh = !revealed.current || revealed.current.path !== path || revealed.current.target !== target || hostBuffer(h) !== buffer;
    revealed.current = { target, path };
    // The same file in another group is the same document (splitSync).
    showInHost(h, buffer, fresh ? target : null);
    // A renamed file's unsaved text follows it into its new buffer.
    if (!open) adoptMovedEdits(buffer);
    if (fresh && groupActive.current) h.view.focus();
  }, [vaultId, path, !!body, readOnly, preview, target, newFile]);

  // The editor's group: workspace commands and the breadcrumbs find it here.
  useWatchEffect(() => {
    const h = host.current;
    if (!h || !group) return;
    return bindGroupView(group.key, h.view);
  }, [group?.key]);

  // A tab switch shows an open buffer synchronously, from the verb itself
  // (controller.ts); the effect above then finds it already shown.
  useWatchEffect(() => {
    const h = host.current;
    if (!h || !group) return;
    return registerGroupSwitcher(vaultId, group.groupId, (next) => {
      const buffer = codeBuffers.get(bufferKey(vaultId, next));
      if (!buffer) return false;
      if (hostBuffer(h) !== buffer) showInHost(h, buffer, null);
      if (groupActive.current) h.view.focus();
      return true;
    });
  }, [vaultId, group?.groupId]);

  // Focus follows the focused group (a click on its tab, <C-w>l, Cmd-Alt-arrows).
  useWatchEffect(() => {
    const h = host.current;
    if (h && group?.active && !h.view.hasFocus && !document.activeElement?.closest("[role=dialog]")) h.view.focus();
  }, [group?.active]);

  // Disk news belongs to the path it was read for, never to whatever buffer
  // the host shows: a synchronous tab switch shows the next file before React
  // renders this component for it.
  useWatchEffect(() => {
    const h = host.current;
    if (!body || !h || isMirror(h)) return;
    const buffer = codeBuffers.get(bufferKey(vaultId, path));
    if (!buffer) return;
    syncDiskLock(buffer, body.lockedMode);
    void applyDiskVersion(buffer, body);
  }, [body]);

  return (
    <div
      ref={parentRef}
      data-owns-keys
      data-code-editor
      className="h-full min-h-0 [&_.cm-editor]:h-full"
      onKeyDown={(e) => {
        // For bubble-phase listeners only (React handlers above this pane,
        // document listeners): CodeMirror and vim have had the key, and the
        // pane around them must not close or leave on it. Window capture
        // listeners ran before this and are kept out by keyOwnership.
        if (e.key === "Escape") e.stopPropagation();
      }}
    />
  );
}

export default CodeEditor;
