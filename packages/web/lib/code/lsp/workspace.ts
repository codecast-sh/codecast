// The language server's view of codecast's open files.
//
// @codemirror/lsp-client opens a document when an editor gains its plugin and
// closes it when the plugin goes. Codecast's editor swaps buffers through one
// view with `view.setState` (contract 2), which destroys and recreates every
// view plugin on each tab switch, so the stock workspace would send didClose
// and didOpen with the whole text on every switch. Here a document belongs to
// the codecast *buffer*: it stays open while the buffer exists, a plugin
// coming back re-binds to it, and edits made while it was off screen (a rename,
// a disk reload) reach the server as one change at the next sync. A document
// whose buffer is gone (tab closed, evicted) is closed, and detached documents
// are capped so a long session does not keep every file it ever showed open.
// A document whose buffer has unsaved changes is never closed by the cap: the
// server's positions for it (a rename, a code action) must match its text.

import { ChangeSet, type Text, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { LSPPlugin, Workspace, type LSPClient, type WorkspaceFile } from "@codemirror/lsp-client";
import { currentState, type CodeBuffer } from "../buffers";
import { hasUnsavedText } from "./edits";
import { resolveUri, uriKey, uriToFsPath } from "./uri";

/** Documents kept open with no editor showing them, beyond which the least
 *  recently shown is closed. */
export const MAX_DETACHED_DOCUMENTS = 16;

export interface WorkspaceHost {
  vaultId: string;
  /** The open codecast buffer for a vault path, if there is one. */
  buffer(path: string): CodeBuffer | undefined;
  /** Edit a buffer from outside its editor (an undoable transaction; marks it
   *  dirty like typing would). */
  applyToBuffer(buffer: CodeBuffer, spec: TransactionSpec): void;
  /** Put a file in front of the person; resolves to the view showing it. */
  displayFile(uri: string, target: ReturnType<typeof resolveUri>): Promise<EditorView | null>;
  /** A document this client opened was closed (its buffer went). */
  documentClosed?(uri: string, client: LSPClient): void;
}

export class BufferFile implements WorkspaceFile {
  readonly views = new Set<EditorView>();
  detachedAt: number | null = null;

  constructor(
    private readonly ws: CodecastWorkspace,
    readonly uri: string,
    readonly path: string,
    readonly languageId: string,
    public version: number,
    public doc: Text,
  ) {}

  /** The view showing this file with its plugin live, if any. */
  getView(main?: EditorView): EditorView | null {
    if (main && this.ws.pluginFor(main, this)) return main;
    const shown = this.buffer()?.view;
    if (shown && this.ws.pluginFor(shown, this)) return shown;
    for (const view of this.views) if (this.ws.pluginFor(view, this)) return view;
    return null;
  }

  buffer(): CodeBuffer | undefined {
    return this.ws.host.buffer(this.path);
  }

  /** The text the person has now: the view's, else the buffer's. */
  currentDoc(): Text | null {
    const view = this.getView();
    if (view) return view.state.doc;
    const b = this.buffer();
    return b ? currentState(b).doc : null;
  }
}

export class CodecastWorkspace extends Workspace {
  files: BufferFile[] = [];
  private readonly byKey = new Map<string, BufferFile>();
  private versions = new Map<string, number>();
  private reapTimer: ReturnType<typeof setTimeout> | null = null;
  private clock = 0;

  /** The vault root, from the root URI the daemon started the server in. */
  readonly rootPath: string;

  constructor(
    client: LSPClient,
    readonly host: WorkspaceHost,
    readonly rootUri: string,
  ) {
    super(client);
    this.rootPath = uriToFsPath(rootUri) ?? "";
  }

  /** Files an editor is showing right now: what keeps the client alive. */
  get liveCount(): number {
    let n = 0;
    for (const f of this.files) if (f.views.size > 0) n++;
    return n;
  }

  getFile(uri: string): BufferFile | null {
    return this.byKey.get(uriKey(uri)) ?? null;
  }

  pluginFor(view: EditorView, file: BufferFile): LSPPlugin | null {
    const plugin = LSPPlugin.get(view);
    return plugin && plugin.client === this.client && uriKey(plugin.uri) === uriKey(file.uri) ? plugin : null;
  }

  private nextVersion(uri: string): number {
    const key = uriKey(uri);
    const v = (this.versions.get(key) ?? -1) + 1;
    this.versions.set(key, v);
    return v;
  }

  syncFiles() {
    this.reap();
    const result: { file: BufferFile; prevDoc: Text; changes: ChangeSet }[] = [];
    for (const file of this.files) {
      const view = file.getView();
      const plugin = view && this.pluginFor(view, file);
      if (view && plugin) {
        if (plugin.unsyncedChanges.empty) continue;
        result.push({ file, prevDoc: file.doc, changes: plugin.unsyncedChanges });
        file.doc = view.state.doc;
        file.version = this.nextVersion(file.uri);
        plugin.clear();
        continue;
      }
      // Off screen: whatever changed it (a rename, a disk reload) goes as one
      // replacement; nothing recorded the finer steps.
      const doc = file.currentDoc();
      if (!doc || doc === file.doc || doc.eq(file.doc)) continue;
      result.push({ file, prevDoc: file.doc, changes: ChangeSet.of([{ from: 0, to: file.doc.length, insert: doc }], file.doc.length) });
      file.doc = doc;
      file.version = this.nextVersion(file.uri);
    }
    return result;
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    const path = resolveUri(this.rootPath, uri);
    let file = this.getFile(uri);
    if (!file) {
      file = new BufferFile(this, uri, path.inside ? path.path : uri, languageId, this.nextVersion(uri), view.state.doc);
      this.files.push(file);
      this.byKey.set(uriKey(uri), file);
      file.views.add(view);
      this.client.didOpen(file);
      return;
    }
    // A buffer coming back on screen: the document is still open.
    file.views.add(view);
    file.detachedAt = null;
    const doc = view.state.doc;
    if (!doc.eq(file.doc)) {
      // It changed while away. The plugin about to be built takes this text as
      // synced, so the server must have it first, and a request in flight
      // (a format) must know its positions no longer hold.
      const replaced = ChangeSet.of([{ from: 0, to: file.doc.length, insert: doc }], file.doc.length);
      for (const m of (this.client as unknown as { activeMappings?: { addChanges(uri: string, c: ChangeSet): void }[] }).activeMappings ?? []) m.addChanges(file.uri, replaced);
      file.doc = doc;
      file.version = this.nextVersion(uri);
      this.client.notification("textDocument/didChange", {
        textDocument: { uri: file.uri, version: file.version },
        contentChanges: [{ text: doc.toString() }],
      });
    }
  }

  closeFile(uri: string, view: EditorView): void {
    const file = this.getFile(uri);
    if (!file) return;
    file.views.delete(view);
    if (file.views.size > 0) return;
    file.detachedAt = ++this.clock;
    this.scheduleReap();
  }

  /** Close documents whose buffer is gone, and the oldest clean detached ones
   *  past the cap. */
  reap(): void {
    const detached = this.files.filter((f) => f.views.size === 0);
    const gone = new Set(detached.filter((f) => !f.buffer()));
    const kept = detached.filter((f) => !gone.has(f) && !hasUnsavedText(currentState(f.buffer()!))).sort((a, b) => (a.detachedAt ?? 0) - (b.detachedAt ?? 0));
    for (const f of kept.slice(0, Math.max(0, kept.length - MAX_DETACHED_DOCUMENTS))) gone.add(f);
    if (!gone.size) return;
    this.files = this.files.filter((f) => !gone.has(f));
    for (const f of gone) {
      this.byKey.delete(uriKey(f.uri));
      this.client.didClose(f.uri);
      this.host.documentClosed?.(f.uri, this.client);
    }
  }

  private scheduleReap(): void {
    if (this.reapTimer) return;
    // After the swap that detached it: a tab switch re-binds within the same task.
    this.reapTimer = setTimeout(() => {
      this.reapTimer = null;
      this.reap();
    }, 0);
  }

  /** On every (re)connect, the server is fresh: catch each document up to the
   *  text the person has, then open it. */
  connected(): void {
    for (const file of this.files) {
      const view = file.getView();
      const plugin = view && this.pluginFor(view, file);
      const doc = file.currentDoc();
      if (doc && !doc.eq(file.doc)) {
        file.doc = doc;
        file.version = this.nextVersion(file.uri);
      }
      plugin?.clear();
      this.client.didOpen(file);
    }
  }

  updateFile(uri: string, update: TransactionSpec): void {
    const b = this.getFile(uri)?.buffer();
    if (b) this.host.applyToBuffer(b, update);
  }

  displayFile(uri: string): Promise<EditorView | null> {
    return this.host.displayFile(uri, resolveUri(this.rootPath, uri));
  }

  dispose(): void {
    if (this.reapTimer) clearTimeout(this.reapTimer);
    this.reapTimer = null;
  }
}
