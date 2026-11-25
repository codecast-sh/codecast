// The vimrc overlay (~/.codecast/editor/vimrc) in the real code editor, vim
// on: the person edits the config that wins over their vimrc with the editor
// it configures. `:w` and Cmd-S write it through the daemon's overlay route
// and reload the config into every open editor.
//
// Loaded lazily by the settings page (it brings CodeMirror and the editor
// core), never part of the main bundle.

import { useMemo, useRef, useState } from "react";
import { CodeEditor } from "../../code/CodeEditor";
import { KeyCap } from "../../KeyCap";
import { isMac } from "../../../shortcuts/registry";
import { cn, shortenHome } from "../../../lib/utils";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useCodeStore } from "../../../store/codeStore";
import { useVaultStore } from "../../../store/vaultStore";
import { bufferKey, codeBuffers, currentState, isDirty, utf8Length } from "../../../lib/code/buffers";
import type { EditorHost } from "../../../lib/code/editorHost";
import { writeVimrcOverlay } from "../../../lib/code/daemonClient";
import { exemptFromAutosave } from "../../../lib/code/autosave";
import { registerVaultSaver, saveBuffer } from "../../../lib/code/fileSync";
import { alwaysVimFor, reloadVimConfig } from "../../../lib/code/vimFeature";
import type { VaultEndpoint } from "../../../lib/vault/client";
import { OVERLAY_VAULT, overlayEtag, saveOverlay, type OverlaySaveResult } from "./overlaySave";

/** The mounted overlay editor's endpoint, reload and result display. */
let mounted: { props: () => { ep: VaultEndpoint; reload: () => unknown }; onResult: (r: OverlaySaveResult) => void } | null = null;

// For the life of the page: the overlay always runs vim, only a deliberate
// save writes it (never autosave: a half-typed config would apply live), and
// every save of it (Cmd-S, `:w`, `:wa`, Save all in Files after this editor
// closed) goes through the overlay route rather than a vault write.
alwaysVimFor(OVERLAY_VAULT);
exemptFromAutosave(OVERLAY_VAULT);
registerVaultSaver(OVERLAY_VAULT, async (b) => {
  const target = mounted;
  const ep = target?.props().ep ?? useVaultStore.getState().endpoint;
  if (!ep) return "error";
  const r = await saveOverlay(
    b,
    (text) => writeVimrcOverlay(ep, text),
    () => (target ? target.props().reload() : reloadVimConfig(ep)),
  );
  target?.onResult(r);
  return r.kind === "saved" ? "saved" : r.kind === "unchanged" ? "unchanged" : "error";
});

export interface VimOverlayEditorProps {
  ep: VaultEndpoint;
  /** Where the daemon keeps the overlay (shown, and the buffer's name). */
  path: string;
  /** Its text now; empty when the file does not exist yet. */
  content: string;
  /** After a write: read the config again so every editor runs it. */
  reload: () => unknown;
  onClose: () => void;
}

export default function VimOverlayEditor({ ep, path, content, reload, onClose }: VimOverlayEditorProps) {
  const hostRef = useRef<EditorHost | null>(null);
  const key = bufferKey(OVERLAY_VAULT, path);
  const dirty = useCodeStore((s) => !!s.dirty[key]);
  const [result, setResult] = useState<OverlaySaveResult | null>(null);
  const [saving, setSaving] = useState(false);
  const props = useRef({ ep, reload });
  props.current = { ep, reload };

  const save = () => {
    const b = hostRef.current?.buffer;
    if (!b || saving) return;
    setSaving(true);
    void saveBuffer(b).finally(() => setSaving(false));
  };

  useMountEffect(() => {
    const self = { props: () => props.current, onResult: setResult };
    mounted = self;
    return () => {
      if (mounted === self) mounted = null;
      // A clean buffer goes, so the next visit opens what disk holds; unsaved
      // text stays (and hot exit keeps it across a reload).
      const b = codeBuffers.get(key);
      if (b && !isDirty(currentState(b))) codeBuffers.close(key);
    };
  });

  const body = useMemo(() => ({ content, etag: overlayEtag(content), mtime: 0, size: utf8Length(content) }), [content]);
  const mod = isMac ? "⌘" : "Ctrl";

  return (
    <div>
      <div className="flex items-center gap-2 px-4 py-2 sm:px-5">
        <span className="text-sm text-sol-text">Overlay</span>
        <span className="truncate font-mono text-xs text-sol-text-muted" title={path}>
          {shortenHome(path)}
        </span>
        {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sol-yellow" aria-label="Unsaved" />}
        <span className="ml-auto flex items-center gap-2">
          {result?.kind === "error" && (
            <span className="max-w-[18rem] truncate text-xs text-sol-red" title={result.message}>
              {result.message}
            </span>
          )}
          {result?.kind === "saved" && !dirty && <span className="text-xs tabular-nums text-sol-green">applied · {result.bytes} B</span>}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors",
              dirty ? "border-sol-cyan/60 bg-sol-cyan/10 text-sol-cyan hover:bg-sol-cyan/15" : "border-sol-border bg-sol-bg-alt text-sol-text-dim",
            )}
          >
            Save
            <span className="flex items-center gap-0.5">
              <KeyCap size="xs">{mod}</KeyCap>
              <KeyCap size="xs">S</KeyCap>
            </span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 items-center rounded-md border border-sol-border bg-sol-bg-alt px-2 text-xs text-sol-text-muted hover:text-sol-text"
          >
            Close
          </button>
        </span>
      </div>
      <div className="h-[260px] border-t border-sol-border/40">
        <CodeEditor vaultId={OVERLAY_VAULT} path={path} body={body} readOnly={false} hostRef={hostRef} />
      </div>
    </div>
  );
}
