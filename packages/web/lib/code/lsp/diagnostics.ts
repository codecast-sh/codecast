// Diagnostics from language servers. Every publishDiagnostics lands in one
// store per vault (what the problems list and the status counts read) and is
// put on the file's editor state as lint marks: in the view when the file is
// on screen, in the buffer's saved state when it is not, so a tab coming back
// already shows its squiggles.

import type * as lsp from "./protocol";
import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import type { LSPClient } from "@codemirror/lsp-client";
import { currentState, updateBuffer } from "../buffers";
import { CodecastWorkspace } from "./workspace";
import { offsetIn } from "./edits";
import { resolveUri, uriKey } from "./uri";

export interface FileDiagnostics {
  uri: string;
  /** Vault-relative, or the absolute path for a file outside the vault. */
  path: string;
  inside: boolean;
  items: readonly lsp.Diagnostic[];
  /** The server that published them; its restart or exit clears only its own. */
  client: LSPClient;
}

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  /** Information and hints. */
  other: number;
}

const byVault = new Map<string, Map<string, FileDiagnostics>>();
const listeners = new Map<string, Set<() => void>>();

/** The diagnostics known for a vault, by URI key. */
export function vaultDiagnostics(vaultId: string): ReadonlyMap<string, FileDiagnostics> {
  return byVault.get(vaultId) ?? new Map();
}

export function countDiagnostics(files: Iterable<FileDiagnostics>): DiagnosticCounts {
  const c: DiagnosticCounts = { errors: 0, warnings: 0, other: 0 };
  for (const f of files) {
    for (const d of f.items) {
      const sev = d.severity ?? 1;
      if (sev === 1) c.errors++;
      else if (sev === 2) c.warnings++;
      else c.other++;
    }
  }
  return c;
}

export function onVaultDiagnostics(vaultId: string, fn: () => void): () => void {
  let set = listeners.get(vaultId);
  if (!set) listeners.set(vaultId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(vaultId);
  };
}

let notifyQueued = new Set<string>();
/** Servers publish in bursts (one per file as a project loads): tell
 *  listeners once per frame, never per notification. */
function notify(vaultId: string): void {
  if (notifyQueued.has(vaultId)) return;
  notifyQueued.add(vaultId);
  const flush = () => {
    const queued = notifyQueued;
    notifyQueued = new Set();
    for (const id of queued) for (const fn of [...(listeners.get(id) ?? [])]) fn();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else setTimeout(flush, 0);
}

const SEVERITY = { 1: "error", 2: "warning", 3: "info", 4: "hint" } as const;

/** One LSP diagnostic as a CodeMirror lint mark over `doc`, its positions
 *  carried through `map` (edits made since the server's version). */
export function toCmDiagnostic(d: lsp.Diagnostic, doc: Text, map: (pos: number, assoc: number) => number = (p) => p): Diagnostic {
  const from = map(offsetIn(doc, d.range.start), 1);
  const to = Math.max(from, map(offsetIn(doc, d.range.end), -1));
  const source = [d.source, d.code !== undefined ? String(d.code) : ""].filter(Boolean).join(" ");
  return {
    from,
    to,
    severity: SEVERITY[(d.severity ?? 1) as 1 | 2 | 3 | 4] ?? "error",
    message: d.message,
    ...(source ? { source } : {}),
    ...(d.tags?.includes(1) ? { markClass: "cm-lsp-unnecessary" } : {}),
  };
}

/** The publishDiagnostics handler for a client whose workspace is codecast's. */
export function handlePublishDiagnostics(client: LSPClient, params: lsp.PublishDiagnosticsParams): boolean {
  const ws = client.workspace;
  if (!(ws instanceof CodecastWorkspace)) return false;
  const file = ws.getFile(params.uri);
  // Computed for a version the editor has moved past: the next one is coming.
  if (file && params.version != null && params.version !== file.version) return true;

  const vaultId = ws.host.vaultId;
  let map = byVault.get(vaultId);
  if (!map) byVault.set(vaultId, (map = new Map()));
  const key = uriKey(params.uri);
  const where = resolveUri(ws.rootPath, params.uri);
  const had = map.has(key);
  if (params.diagnostics.length) {
    map.set(key, { uri: params.uri, path: where.inside ? where.path : (where.absPath ?? params.uri), inside: where.inside, items: params.diagnostics, client });
  } else map.delete(key);
  if (had || params.diagnostics.length) notify(vaultId);

  if (!file) return true;
  const view = file.getView();
  const plugin = view && ws.pluginFor(view, file);
  if (view && plugin) {
    const marks = params.diagnostics.map((d) => toCmDiagnostic(d, plugin.syncedDoc, (p, a) => plugin.unsyncedChanges.mapPos(p, a)));
    view.dispatch(setDiagnostics(view.state, marks));
    return true;
  }
  const buffer = file.buffer();
  if (!buffer) return true;
  const state = currentState(buffer);
  // Off screen and edited since the server saw it: wait for the next publish.
  if (!state.doc.eq(file.doc)) return true;
  updateBuffer(buffer, setDiagnostics(state, params.diagnostics.map((d) => toCmDiagnostic(d, state.doc))));
  return true;
}

/** Forget what a server published: all of it when its process went (a crash,
 *  a restart, an idle dispose), or one file's when its document closed. */
export function forgetClientDiagnostics(client: LSPClient, uri?: string): void {
  for (const [vaultId, map] of byVault) {
    let changed = false;
    for (const [key, f] of map) {
      if (f.client !== client || (uri !== undefined && key !== uriKey(uri))) continue;
      map.delete(key);
      changed = true;
    }
    if (changed) notify(vaultId);
  }
}

/** Forget a vault's diagnostics (tests). */
export function clearDiagnostics(vaultId?: string): void {
  if (vaultId === undefined) byVault.clear();
  else byVault.delete(vaultId);
}

/** Diagnostics overlapping an LSP range, for a code action request. */
export function diagnosticsAt(vaultId: string, uri: string, range: lsp.Range): lsp.Diagnostic[] {
  const f = byVault.get(vaultId)?.get(uriKey(uri));
  if (!f) return [];
  const before = (a: lsp.Position, b: lsp.Position) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  return f.items.filter((d) => before(d.range.start, range.end) && before(range.start, d.range.end));
}
