// One file in two editor groups is one document: what is typed in either
// appears in both at once, and there is one undo history. This is
// CodeMirror's split-view pattern (codemirror.net/examples/split) laid over
// the buffer manager.
//
// The buffer's own view (buffer.view, set by EditorHost.show) is the primary:
// it holds the buffer's state, with its undo history, and saving, disk sync
// and dirty tracking all follow it as before. Every other group showing the
// file is a mirror: its view starts from a copy of the primary's state and the
// two forward each other's changes, marked so neither sends them back. A
// mirror records no history of its own; its undo and redo run on the primary,
// whose result comes back to it like any other change.
//
// When the primary's group moves to another file (or closes), the first mirror
// is promoted: it takes over the buffer, keeping its own cursor and scroll.
//
// What is not a text change (the vault turning read-only, a merge with disk
// starting or ending) is configuration, which a mirror cannot take over by
// forwarding. A mirror is built again from the primary's state when either
// changes, and stays read-only while a merge is open: the merge is resolved
// in the primary's group.

import { Annotation, EditorState, Prec, StateEffect, StateField, Transaction, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { bufferKey, codeBuffers, setFileFormat, setSavedDoc, type CodeBuffer } from "../buffers";
import { editorFeatureCompartment, featureContext, syncEditorFeatures } from "../features";
import { readOnlyEffect } from "../setup";
import { revealTarget, type CursorTarget, type EditorHost } from "../editorHost";

/** Marks a change forwarded from another view of the same buffer. */
const synced = Annotation.define<true>();

/** Mirror hosts and the buffer each one shows. */
const mirrors = new Map<EditorHost, CodeBuffer>();
const mirrorViews = new WeakMap<EditorView, CodeBuffer>();
/** What each mirror was built against: rebuilt when either changes. */
const builtAgainst = new WeakMap<EditorHost, { readOnly: boolean; merging: boolean }>();

/** The buffer a view shows, as primary or mirror. */
function bufferOfView(view: EditorView): CodeBuffer | undefined {
  const mirrored = mirrorViews.get(view);
  if (mirrored) return mirrors.has(hostOf(view)!) ? mirrored : undefined;
  const ctx = view.state.facet(featureContext);
  const b = ctx ? codeBuffers.get(bufferKey(ctx.vaultId, ctx.path)) : undefined;
  return b && b.view === view ? b : undefined;
}

function hostOf(view: EditorView): EditorHost | undefined {
  for (const h of mirrors.keys()) if (h.view === view) return h;
  return undefined;
}

/** Every view showing `b`, primary first. */
function viewsOf(b: CodeBuffer): EditorView[] {
  const out: EditorView[] = b.view ? [b.view] : [];
  for (const [h, mb] of mirrors) if (mb === b) out.push(h.view);
  return out;
}

/** The view that holds the history for a mirror view; null for any other. */
export function primaryOf(view: EditorView): EditorView | null {
  const b = mirrorViews.get(view);
  return b && b.view && b.view !== view && mirrors.has(hostOf(view)!) ? b.view : null;
}

/** Effects every view of a buffer must see (what disk holds, the format). */
function forwardedEffects(tr: Transaction): StateEffect<unknown>[] {
  return tr.effects.filter((e) => e.is(setSavedDoc) || e.is(setFileFormat));
}

const forward = EditorView.updateListener.of((u) => {
  if (!u.docChanged && !u.transactions.some((tr) => tr.effects.length)) return;
  const b = bufferOfView(u.view);
  if (!b) return;
  const peers = viewsOf(b).filter((v) => v !== u.view);
  if (!peers.length) return;
  // The buffer's bookkeeping (b.merging) settles after the dispatch.
  if (b.view === u.view && u.transactions.some((tr) => tr.reconfigured)) queueMicrotask(() => rebuildMirrorsOf(b));
  for (const tr of u.transactions) {
    if (tr.annotation(synced)) continue;
    const effects = forwardedEffects(tr);
    if (tr.changes.empty && !effects.length) continue;
    const userEvent = tr.annotation(Transaction.userEvent);
    const spec: TransactionSpec = {
      changes: tr.changes,
      effects,
      annotations: [synced.of(true), ...(userEvent ? [Transaction.userEvent.of(userEvent)] : [])],
    };
    for (const peer of peers) peer.dispatch(spec);
  }
});

const installed = StateField.define<true>({ create: () => true, update: (v) => v });

/** In every view of a shared buffer: forward changes to the others. */
const syncExtension: Extension = [installed, forward];

/** Run undo or redo where the history lives. */
export function runHistory(view: EditorView, side: "undo" | "redo"): boolean {
  const target = primaryOf(view) ?? view;
  return (side === "undo" ? undo : redo)(target);
}

// The LSP document is synced from the primary. A mirror's own LSP plugin would
// compose every change it sees for the life of the split and never be told
// they were sent, so it is cleared after each one. The client library is
// already loaded wherever an LSP plugin runs.
let lspPlugin: { get(view: EditorView): { clear(): void } | null } | null = null;
let lspLoading = false;
const hasLsp = (view: EditorView) => {
  const ext = editorFeatureCompartment("lsp")?.get(view.state);
  return Array.isArray(ext) ? ext.length > 0 : ext != null;
};
const quietLsp = ViewPlugin.define(() => ({
  update(u) {
    if (!u.docChanged) return;
    if (lspPlugin) lspPlugin.get(u.view)?.clear();
    else if (!lspLoading && hasLsp(u.view)) {
      lspLoading = true;
      void import("@codemirror/lsp-client").then((m) => (lspPlugin = m.LSPPlugin));
    }
  },
}));

/** Only in a mirror: no history of its own, and its undo keys run on the primary. */
const mirrorExtension: Extension = [
  quietLsp,
  EditorState.transactionExtender.of(() => ({ annotations: Transaction.addToHistory.of(false) })),
  Prec.highest(
    keymap.of([
      { key: "Mod-z", run: (v) => runHistory(v, "undo"), preventDefault: true },
      { key: "Mod-Shift-z", run: (v) => runHistory(v, "redo"), preventDefault: true },
      { key: "Mod-y", run: (v) => runHistory(v, "redo"), preventDefault: true },
    ]),
  ),
];

function ensureSync(view: EditorView): void {
  if (view.state.field(installed, false)) return;
  view.dispatch({ effects: StateEffect.appendConfig.of(syncExtension) });
}

/** The buffer a host shows, as primary or mirror. */
export function hostBuffer(host: EditorHost): CodeBuffer | null {
  return host.buffer ?? mirrors.get(host) ?? null;
}

export function isMirror(host: EditorHost): boolean {
  return mirrors.has(host);
}

/**
 * Show a buffer in a host: the ordinary `show` when no other view has it,
 * otherwise a mirror of the view that does. `target` puts the cursor.
 */
export function showInHost(host: EditorHost, buffer: CodeBuffer, target?: CursorTarget | null): void {
  if (mirrors.get(host) === buffer || host.buffer === buffer) {
    if (target) revealTarget(host.view, target);
    if (host.buffer === buffer) codeBuffers.touch(buffer);
    return;
  }
  releaseHost(host);
  const primary = buffer.view;
  if (!primary || primary === host.view || !primary.dom.isConnected) {
    host.show(buffer, target);
    return;
  }
  host.hide();
  ensureSync(primary);
  mountMirror(host, buffer, primary);
  codeBuffers.touch(buffer);
  if (target) revealTarget(host.view, target);
  else host.view.dispatch({ effects: EditorView.scrollIntoView(host.view.state.selection.main.head, { y: "center" }) });
}

/** Build a mirror's state from the primary's. */
function mountMirror(host: EditorHost, buffer: CodeBuffer, primary: EditorView): void {
  const merging = !!buffer.merging;
  host.view.setState(primary.state);
  host.view.dispatch({
    effects: [StateEffect.appendConfig.of(mirrorExtension), ...(merging && !primary.state.readOnly ? [readOnlyEffect(true)] : [])],
  });
  mirrors.set(host, buffer);
  mirrorViews.set(host.view, buffer);
  builtAgainst.set(host, { readOnly: primary.state.readOnly, merging });
  syncEditorFeatures(host.view);
}

/** Rebuild the mirrors of `b` whose primary changed read-only or merge state,
 *  keeping each one's cursor and scroll. */
function rebuildMirrorsOf(b: CodeBuffer): void {
  const primary = b.view;
  if (!primary || !primary.dom.isConnected) return;
  for (const [host, mb] of mirrors) {
    const built = builtAgainst.get(host);
    if (mb !== b || (built && built.readOnly === primary.state.readOnly && built.merging === !!b.merging)) continue;
    const selection = host.view.state.selection;
    const scroll = host.view.scrollSnapshot();
    mountMirror(host, b, primary);
    const len = host.view.state.doc.length;
    host.view.dispatch({ selection: selection.ranges.every((r) => r.to <= len) ? selection : undefined, effects: scroll });
  }
}

/**
 * Let go of whatever a host shows before it shows something else or goes
 * away. A mirror just stops; a primary with mirrors hands the buffer to the
 * first of them, which keeps its cursor and scroll.
 */
export function releaseHost(host: EditorHost): void {
  if (mirrors.delete(host)) {
    mirrorViews.delete(host.view);
    return;
  }
  const b = host.buffer;
  if (!b) return;
  const heir = [...mirrors].find(([, mb]) => mb === b)?.[0];
  if (!heir) return;
  host.hide();
  const selection = heir.view.state.selection;
  const scroll = heir.view.scrollSnapshot();
  mirrors.delete(heir);
  mirrorViews.delete(heir.view);
  heir.show(b);
  if (mirrors.size && [...mirrors.values()].includes(b)) ensureSync(heir.view);
  heir.view.dispatch({ selection, effects: scroll });
}

/** Tests: how many mirrors are live. */
export function _mirrorCount(): number {
  return mirrors.size;
}
