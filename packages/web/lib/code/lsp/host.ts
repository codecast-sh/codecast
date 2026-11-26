// Where the language features meet the rest of the editor: the open buffers,
// the shell's tabs (`file.open`), and the daemon for files no buffer holds.
// Everything else in lib/code/lsp takes these through WorkspaceHost and
// EditTarget, so its tests run without a daemon or a shell.

import type * as lsp from "./protocol";
import { EditorView } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";
import { bufferKey, codeBuffers, type CodeBuffer } from "../buffers";
import { applyToBuffer } from "../fileSync";
import { runCodeCommand } from "../commands";
import { readVaultFile, writeVaultFile } from "../../vault/client";
import { filesHref } from "../../vault/vaultHref";
import { requestEndpointOf, useVaultStore } from "../../../store/vaultStore";
import type { WorkspaceHost } from "./workspace";
import type { EditTarget } from "./edits";
import { resolveUri, uriKey, type UriTarget } from "./uri";
import { showNotice } from "./ui/notice";
import { forgetClientDiagnostics } from "./diagnostics";

const endpoint = () => {
  const ep = requestEndpointOf(useVaultStore.getState());
  if (!ep) throw new Error("Files is not connected to this machine");
  return ep;
};

/** The editor the person is in, for notices about work started elsewhere. */
let lastView: EditorView | null = null;
export function noteActiveView(view: EditorView): void {
  lastView = view;
}
export function activeView(): EditorView | null {
  return lastView && lastView.dom.isConnected ? lastView : null;
}

/** Open a vault file at an LSP position through the shell's tabs. Without a
 *  shell mounted, Files' own URL does it. */
export function openVaultFile(path: string, pos?: lsp.Position): boolean {
  const line = pos ? pos.line + 1 : undefined;
  const column = pos ? pos.character + 1 : undefined;
  if (runCodeCommand("file.open", { path, line, column })) return true;
  if (typeof window === "undefined") return false;
  window.history.pushState(null, "", filesHref({ path, line }));
  window.dispatchEvent(new PopStateEvent("popstate"));
  return true;
}

/** Wait for a view showing `uri` with its language server attached. */
function viewFor(vaultId: string, path: string, uri: string, timeoutMs = 6000): Promise<EditorView | null> {
  const key = uriKey(uri);
  const started = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const view = codeBuffers.get(bufferKey(vaultId, path))?.view;
      const plugin = view && LSPPlugin.get(view);
      if (view && plugin && uriKey(plugin.uri) === key) return resolve(view);
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(check, 50);
    };
    check();
  });
}

/** Say where a location outside the folder is, since it cannot open here. */
export function showOutside(view: EditorView | null, target: UriTarget, pos?: lsp.Position): void {
  const v = view ?? activeView();
  if (!v || target.inside) return;
  const where = target.absPath ?? "another machine";
  showNotice(v, {
    tone: "warn",
    title: "Outside this folder",
    rows: [
      {
        label: where,
        hint: pos ? `L${pos.line + 1}` : undefined,
        onClick: () => void navigator.clipboard?.writeText(pos ? `${where}:${pos.line + 1}:${pos.character + 1}` : where).catch(() => {}),
      },
    ],
  });
}

export function workspaceHost(vaultId: string): WorkspaceHost {
  return {
    vaultId,
    buffer: (path) => codeBuffers.get(bufferKey(vaultId, path)),
    applyToBuffer: (b: CodeBuffer, spec) => applyToBuffer(b, spec),
    displayFile: async (uri, target) => {
      if (!target.inside) {
        showOutside(null, target);
        return null;
      }
      openVaultFile(target.path);
      return viewFor(vaultId, target.path, uri);
    },
    // The server stops reporting on a closed document; its marks go with it.
    documentClosed: (uri, client) => forgetClientDiagnostics(client, uri),
  };
}

export function editTarget(vaultId: string, rootPath: string): EditTarget {
  return {
    rootPath,
    buffer: (path) => codeBuffers.get(bufferKey(vaultId, path)),
    applyToBuffer: (b, spec) => applyToBuffer(b, spec),
    read: (path) => readVaultFile(endpoint(), vaultId, path),
    write: (path, content, etag) => writeVaultFile(endpoint(), vaultId, path, content, etag),
  };
}

/** Go to an LSP location: in this editor when it is this file, else in a tab,
 *  else say where it is. */
export function goToLocation(view: EditorView, uri: string, range: lsp.Range, rootPath: string): void {
  const plugin = LSPPlugin.get(view);
  if (plugin && uriKey(plugin.uri) === uriKey(uri)) {
    const pos = plugin.fromPosition(range.start);
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }), userEvent: "select.definition" });
    view.focus();
    return;
  }
  const target = resolveUri(rootPath, uri);
  if (target.inside) openVaultFile(target.path, range.start);
  else showOutside(view, target, range.start);
}
