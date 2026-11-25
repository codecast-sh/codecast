// The language commands: go to definition, find references, hover at the
// cursor, rename, format, code actions, document and workspace symbols. Each
// takes the editor it was run in and declines (returns false) when no server
// is attached, so a vim fallback (gd's word search) or nothing runs instead.

import type * as lsp from "./protocol";
import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { getIndentUnit, indentUnit } from "@codemirror/language";
import { LSPPlugin, type LSPClient } from "@codemirror/lsp-client";
import { applyWorkspaceEdit, editedCount, offsetIn, type EditReport } from "./edits";
import { CodecastWorkspace, type BufferFile } from "./workspace";
import { diagnosticsAt } from "./diagnostics";
import { activeView, editTarget, goToLocation, openVaultFile } from "./host";
import { displayPath, resolveUri, uriKey, vaultFileUri } from "./uri";
import { codeFence } from "./completion";
import { capabilitiesOf, serverCan } from "./protocol";
import { flattenLspSymbols, kindGlyph, lezerSymbols, lspKindName, type OutlineSymbol } from "./symbols";
import { showPeek, type PeekRow } from "./ui/peek";
import { showNotice } from "./ui/notice";
import { openQuickPick } from "./ui/quickPick";
import { el } from "./ui/list";
import { readVaultFile } from "../../vault/client";
import { currentState, type CodeBuffer } from "../buffers";
import { useVaultStore } from "../../../store/vaultStore";

type Loc = { uri: string; range: lsp.Range };

export function pluginOf(view: EditorView | undefined): LSPPlugin | null {
  return view ? LSPPlugin.get(view) : null;
}

function workspaceOf(client: LSPClient): CodecastWorkspace | null {
  return client.workspace instanceof CodecastWorkspace ? client.workspace : null;
}

const can = (plugin: LSPPlugin, cap: keyof lsp.ServerCapabilities) => serverCan(plugin.client, cap);

function failed(view: EditorView, what: string, err: unknown): void {
  const message = (err as { message?: string })?.message ?? String(err);
  if (/cancel/i.test(message)) return;
  showNotice(view, { tone: "error", title: `${what}: ${message}` });
}

function asLocations(result: lsp.Location | lsp.Location[] | lsp.LocationLink[] | null | undefined): Loc[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((l) => ("targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : { uri: l.uri, range: l.range }));
}

// ── definition ──────────────────────────────────────────────────────────────

export function goToDefinition(view: EditorView, kind: "definition" | "typeDefinition" | "implementation" = "definition"): boolean {
  const plugin = pluginOf(view);
  if (!plugin || !can(plugin, `${kind}Provider` as keyof lsp.ServerCapabilities)) return false;
  const ws = workspaceOf(plugin.client);
  plugin.client.sync();
  const pos = view.state.selection.main.head;
  plugin.client
    .request<lsp.TextDocumentPositionParams, lsp.Location | lsp.Location[] | lsp.LocationLink[] | null>(`textDocument/${kind}`, {
      textDocument: { uri: plugin.uri },
      position: plugin.toPosition(pos),
    })
    .then(
      (result) => {
        const locs = asLocations(result);
        if (!locs.length) return showNotice(view, { tone: "warn", title: "No definition found" });
        // Several (an overload, a re-export): the list, so the person picks.
        if (locs.length > 1 && ws) return showLocations(view, plugin, locs, "Definitions");
        goToLocation(view, locs[0].uri, locs[0].range, ws?.rootPath ?? "");
      },
      (err) => failed(view, "Definition", err),
    );
  return true;
}

// ── references ──────────────────────────────────────────────────────────────

/** Line text for references in files no buffer holds, read once per file. */
const lineCache = new Map<string, Promise<string[] | null>>();

function fileLines(vaultId: string, path: string): Promise<string[] | null> {
  const key = `${vaultId}\0${path}`;
  let hit = lineCache.get(key);
  if (!hit) {
    const ep = useVaultStore.getState().endpoint;
    hit = ep ? readVaultFile(ep, vaultId, path).then((f) => (f ? f.content.split(/\r\n|\r|\n/) : null), () => null) : Promise.resolve(null);
    lineCache.set(key, hit);
    // Fresh per peek, not forever.
    setTimeout(() => lineCache.delete(key), 30_000);
  }
  return hit;
}

function lineRow(text: string | null, range: lsp.Range, open: () => void): PeekRow {
  return {
    open,
    render(dom) {
      dom.append(el("span", "cm-lsp-lineno", String(range.start.line + 1)));
      const code = el("span", "cm-lsp-code");
      if (text === null) code.textContent = "…";
      else {
        const lead = text.length - text.trimStart().length;
        const a = range.start.character;
        const b = range.start.line === range.end.line ? range.end.character : text.length;
        code.append(text.slice(lead, a));
        code.appendChild(el("strong")).textContent = text.slice(a, b);
        code.append(text.slice(b, b + 160));
      }
      dom.append(code);
    },
  };
}

/** A grouped list of locations under the editor. */
function showLocations(view: EditorView, plugin: LSPPlugin, locs: Loc[], title: string): void {
  const ws = workspaceOf(plugin.client);
  const rootPath = ws?.rootPath ?? "";
  const vaultId = ws?.host.vaultId ?? "";
  const here = uriKey(plugin.uri);
  const groups = new Map<string, Loc[]>();
  for (const l of locs) {
    const k = uriKey(l.uri);
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const ordered = [...groups.values()].sort((a, b) => (uriKey(a[0].uri) === here ? -1 : uriKey(b[0].uri) === here ? 1 : displayPath(rootPath, a[0].uri).localeCompare(displayPath(rootPath, b[0].uri))));
  for (const g of ordered) g.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
  const loaded = new Map<string, string[] | null>();
  const docLines = (uri: string): ((line: number) => string) | null => {
    const file = ws?.getFile(uri);
    const doc = file?.currentDoc();
    if (doc) return (n) => (n < doc.lines ? doc.line(n + 1).text : "");
    const lines = loaded.get(uriKey(uri));
    return lines ? (n) => lines[n] ?? "" : null;
  };
  let refresh: (() => void) | null = null;
  showPeek(view, {
    id: "references",
    title,
    count: `${locs.length} in ${groups.size} ${groups.size === 1 ? "file" : "files"}`,
    rows: () => {
      const rows: PeekRow[] = [];
      for (const g of ordered) {
        const name = displayPath(rootPath, g[0].uri);
        rows.push({ group: true, render: (dom) => dom.append(el("span", "cm-lsp-label", name), el("span", "cm-lsp-hint", String(g.length))) });
        const read = docLines(g[0].uri);
        for (const l of g) rows.push(lineRow(read ? read(l.range.start.line) : null, l.range, () => goToLocation(view, l.uri, l.range, rootPath)));
      }
      return rows;
    },
    watch: (r) => {
      refresh = r;
      return () => (refresh = null);
    },
  });
  // Fill in line text for files on disk only, a few files at a time.
  const missing = ordered.filter((g) => !docLines(g[0].uri)).slice(0, 40);
  void Promise.all(
    missing.map(async (g) => {
      const t = resolveUri(rootPath, g[0].uri);
      if (t.inside) loaded.set(uriKey(g[0].uri), await fileLines(vaultId, t.path));
    }),
  ).then(() => refresh?.());
}

export function findReferences(view: EditorView): boolean {
  const plugin = pluginOf(view);
  if (!plugin || !can(plugin, "referencesProvider")) return false;
  plugin.client.sync();
  plugin.client
    .request<lsp.ReferenceParams, lsp.Location[] | null>("textDocument/references", {
      textDocument: { uri: plugin.uri },
      position: plugin.toPosition(view.state.selection.main.head),
      context: { includeDeclaration: true },
    })
    .then(
      (locs) => {
        if (!locs?.length) return showNotice(view, { tone: "warn", title: "No references found" });
        showLocations(view, plugin, locs, "References");
      },
      (err) => failed(view, "References", err),
    );
  return true;
}

// ── hover at the cursor (K) ─────────────────────────────────────────────────

const setCursorHover = StateEffect.define<Tooltip | null>();

const cursorHover = StateField.define<Tooltip | null>({
  create: () => null,
  update(tip, tr) {
    for (const e of tr.effects) if (e.is(setCursorHover)) return e.value;
    // Vim re-asserts the selection after a command: only a cursor that
    // actually left the symbol closes it.
    if (!tip) return tip;
    return tr.docChanged || (tr.selection && tr.selection.main.head !== tip.pos) ? null : tip;
  },
  provide: (f) => showTooltip.from(f),
});

function hoverHTML(plugin: LSPPlugin, contents: lsp.Hover["contents"]): string {
  const one = (c: lsp.MarkedString | lsp.MarkupContent): string =>
    typeof c === "string" ? plugin.docToHTML(c, "markdown") : "language" in c ? plugin.docToHTML(codeFence(plugin.view, c.value, c.language), "markdown") : plugin.docToHTML(c);
  return Array.isArray(contents) ? contents.map(one).join("") : one(contents);
}

const emptyHover = (c: lsp.Hover["contents"]) => (Array.isArray(c) ? c.length === 0 : typeof c === "string" ? !c.trim() : !c.value.trim());

export function hoverAtCursor(view: EditorView): boolean {
  const plugin = pluginOf(view);
  if (!plugin || !can(plugin, "hoverProvider")) return false;
  plugin.client.sync();
  const pos = view.state.selection.main.head;
  const doc = view.state.doc;
  plugin.client
    .request<lsp.TextDocumentPositionParams, lsp.Hover | null>("textDocument/hover", { textDocument: { uri: plugin.uri }, position: plugin.toPosition(pos) })
    .then(
      (hover) => {
        if (view.state.doc !== doc || view.state.selection.main.head !== pos) return;
        const empty = !hover || emptyHover(hover.contents);
        const tip: Tooltip = {
          pos,
          above: true,
          create: () => {
            const dom = el("div", "cm-lsp-hover-tooltip cm-lsp-documentation");
            if (empty) {
              dom.textContent = "No information";
              dom.style.color = "var(--sol-text-dim)";
            } else dom.innerHTML = hoverHTML(plugin, hover!.contents);
            return { dom };
          },
        };
        const effects: StateEffect<unknown>[] =
          view.state.field(cursorHover, false) === undefined ? [StateEffect.appendConfig.of(cursorHover.init(() => tip))] : [setCursorHover.of(tip)];
        view.dispatch({ effects });
      },
      (err) => failed(view, "Hover", err),
    );
  return true;
}

export function closeCursorHover(view: EditorView): boolean {
  if (!view.state.field(cursorHover, false)) return false;
  view.dispatch({ effects: setCursorHover.of(null) });
  return true;
}

// ── workspace edits ─────────────────────────────────────────────────────────

/** Tell the person what an edit across files did, and what it could not. */
export function reportEdit(view: EditorView | null, report: EditReport, verb: string): void {
  if (!view) return;
  const n = editedCount(report);
  const rows = [
    ...report.conflicts.map((path) => ({ label: path, hint: "changed on disk", tone: "error" as const, onClick: () => openVaultFile(path) })),
    ...report.skipped.map((s) => ({ label: s.path, hint: s.reason, tone: "warning" as const })),
  ];
  if (n <= 1 && !rows.length) return;
  showNotice(view, {
    tone: report.conflicts.length ? "error" : rows.length ? "warn" : "ok",
    title: `${verb} in ${n} ${n === 1 ? "file" : "files"}${report.buffers.length > 1 ? ` · ${report.buffers.length} unsaved` : ""}`,
    rows,
  });
}

// ── rename ──────────────────────────────────────────────────────────────────

const setRename = StateEffect.define<{ from: number; to: number; text: string } | null>();

const renameField = StateField.define<{ from: number; to: number; text: string } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRename)) return e.value;
    if (value && tr.docChanged) return null;
    return value;
  },
  provide: (f) =>
    showTooltip.from(f, (r) =>
      r
        ? {
            pos: r.from,
            above: true,
            create: (view) => renameTooltip(view, r),
          }
        : null,
    ),
});

function renameTooltip(view: EditorView, r: { from: number; to: number; text: string }) {
  const dom = el("div", "cm-lsp-rename");
  const input = el("input");
  input.value = r.text;
  input.spellcheck = false;
  input.setAttribute("aria-label", "New name");
  dom.append(input);
  const close = () => {
    view.dispatch({ effects: setRename.of(null) });
    view.focus();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const name = input.value.trim();
      close();
      if (name && name !== r.text) doRename(view, r.from, name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  });
  input.addEventListener("blur", () => {
    if (view.state.field(renameField, false)) view.dispatch({ effects: setRename.of(null) });
  });
  return {
    dom,
    mount: () => {
      input.focus();
      input.select();
    },
  };
}

export function startRename(view: EditorView): boolean {
  const plugin = pluginOf(view);
  if (!plugin || !can(plugin, "renameProvider") || view.state.readOnly) return false;
  const head = view.state.selection.main.head;
  const open = (from: number, to: number, text: string) => {
    const effects: StateEffect<unknown>[] =
      view.state.field(renameField, false) === undefined
        ? [StateEffect.appendConfig.of(renameField.init(() => ({ from, to, text })))]
        : [setRename.of({ from, to, text })];
    view.dispatch({ effects });
  };
  const word = view.state.wordAt(head);
  const provider = capabilitiesOf(plugin.client)?.renameProvider;
  if (typeof provider === "object" && provider.prepareProvider) {
    plugin.client.sync();
    const doc = view.state.doc;
    plugin.client
      .request<lsp.TextDocumentPositionParams, lsp.PrepareRenameResult | null>("textDocument/prepareRename", {
        textDocument: { uri: plugin.uri },
        position: plugin.toPosition(head),
      })
      .then(
        (res) => {
          if (view.state.doc !== doc) return;
          if (!res) return showNotice(view, { tone: "warn", title: "Nothing to rename here" });
          if ("defaultBehavior" in res) return word && open(word.from, word.to, view.state.sliceDoc(word.from, word.to));
          const range = "range" in res ? res.range : res;
          const from = offsetIn(doc, range.start);
          const to = offsetIn(doc, range.end);
          open(from, to, "placeholder" in res ? res.placeholder : view.state.sliceDoc(from, to));
        },
        (err) => failed(view, "Rename", err),
      );
    return true;
  }
  if (!word) return false;
  open(word.from, word.to, view.state.sliceDoc(word.from, word.to));
  return true;
}

function doRename(view: EditorView, pos: number, newName: string): void {
  const plugin = pluginOf(view);
  const ws = plugin && workspaceOf(plugin.client);
  if (!plugin || !ws) return;
  plugin.client.sync();
  void plugin.client.withMapping((mapping) =>
    plugin.client
      .request<lsp.RenameParams, lsp.WorkspaceEdit | null>("textDocument/rename", { textDocument: { uri: plugin.uri }, position: plugin.toPosition(pos), newName })
      .then(
        async (edit) => {
          if (!edit) return showNotice(view, { tone: "warn", title: "Nothing renamed" });
          const report = await applyWorkspaceEdit(edit, editTarget(ws.host.vaultId, ws.rootPath), { mapping, document: (u) => ws.getFile(u), userEvent: "rename" });
          reportEdit(view, report, "Renamed");
        },
        (err) => failed(view, "Rename", err),
      ),
  );
}

// ── format ──────────────────────────────────────────────────────────────────

/** What formatting acts on: one file's open document in its client. Fixed when
 *  the request goes out, so a tab switch before the reply never redirects it. */
export interface FormatTarget {
  client: LSPClient;
  ws: CodecastWorkspace;
  file: BufferFile;
}

function formatTarget(client: LSPClient, uri: string): FormatTarget | null {
  const ws = workspaceOf(client);
  const file = ws?.getFile(uri);
  if (!ws || !file || !serverCan(client, "documentFormattingProvider")) return null;
  const b = file.buffer();
  return b && !currentState(b).readOnly ? { client, ws, file } : null;
}

export function formatTargetOf(view: EditorView): FormatTarget | null {
  const plugin = pluginOf(view);
  return plugin && !view.state.readOnly ? formatTarget(plugin.client, plugin.uri) : null;
}

/** The format target for an open buffer, from whichever client holds its
 *  document (Save all formats buffers that are not on screen). */
export function formatTargetOfBuffer(b: CodeBuffer, clients: LSPClient[]): FormatTarget | null {
  for (const c of clients) {
    const ws = workspaceOf(c);
    const t = ws && formatTarget(c, vaultFileUri(ws.rootPath, b.path));
    if (t) return t;
  }
  return null;
}

/**
 * Format one file; resolves true once the edits are in, false when nothing
 * changed. The edits land in the file they were computed for wherever it is
 * now: its editor while shown, its buffer (undoable, unsaved) while off screen.
 * When the person typed into a range the server rewrote, nothing is applied.
 */
export function formatFile({ client, ws, file }: FormatTarget): Promise<boolean> {
  client.sync();
  const b = file.buffer();
  const state = file.getView()?.state ?? (b ? currentState(b) : null);
  if (!state) return Promise.resolve(false);
  const startDoc = file.doc;
  return client.withMapping((mapping) =>
    client
      .request<lsp.DocumentFormattingParams, lsp.TextEdit[] | null>("textDocument/formatting", {
        textDocument: { uri: file.uri },
        options: { tabSize: getIndentUnit(state), insertSpaces: !state.facet(indentUnit).includes("\t"), trimTrailingWhitespace: true, insertFinalNewline: true },
      })
      .then(
        (edits) => {
          if (!edits?.length || ws.getFile(file.uri) !== file) return false;
          // Fold in whatever changed since, on screen or off, so the mapping
          // sees it and the document below is what the server has now.
          client.sync();
          const since = mapping.getMapping(file.uri);
          if (!since) return false;
          const changes = [];
          for (const e of edits) {
            const a = offsetIn(startDoc, e.range.start);
            const z = offsetIn(startDoc, e.range.end);
            // Typed into a range the server rewrote: formatting it now would eat that.
            if (!since.empty && since.touchesRange(a, z)) return false;
            changes.push({ from: since.mapPos(a, 1), to: since.mapPos(z, -1), insert: e.newText });
          }
          const view = file.getView();
          if (view) view.dispatch({ changes, userEvent: "format" });
          else {
            const buffer = file.buffer();
            if (!buffer) return false;
            ws.host.applyToBuffer(buffer, { changes, userEvent: "format", scrollIntoView: false });
          }
          return true;
        },
        (err) => {
          const view = file.getView() ?? activeView();
          if (view) failed(view, "Format", err);
          return false;
        },
      ),
  );
}

/** Format the file in this editor; null when it has no server that formats. */
export function formatDocument(view: EditorView): Promise<boolean> | null {
  const target = formatTargetOf(view);
  return target ? formatFile(target) : null;
}

// ── code actions ────────────────────────────────────────────────────────────

export function codeActions(view: EditorView): boolean {
  const plugin = pluginOf(view);
  const ws = plugin && workspaceOf(plugin.client);
  if (!plugin || !ws || !can(plugin, "codeActionProvider")) return false;
  plugin.client.sync();
  const sel = view.state.selection.main;
  const range = { start: plugin.toPosition(sel.from), end: plugin.toPosition(sel.to) };
  const coords = view.coordsAtPos(sel.head);
  const box = view.dom.getBoundingClientRect();
  plugin.client
    .request<lsp.CodeActionParams, (lsp.Command | lsp.CodeAction)[] | null>("textDocument/codeAction", {
      textDocument: { uri: plugin.uri },
      range,
      context: { diagnostics: diagnosticsAt(ws.host.vaultId, plugin.uri, range), triggerKind: 1 },
    })
    .then(
      (actions) => {
        const list = (actions ?? []).filter((a) => !("disabled" in a && a.disabled));
        if (!list.length) return showNotice(view, { tone: "warn", title: "No code actions here" });
        list.sort((a, b) => Number("isPreferred" in b && !!b.isPreferred) - Number("isPreferred" in a && !!a.isPreferred));
        openQuickPick(view, {
          placeholder: "Code actions",
          items: list,
          empty: "No matching action",
          maxRows: 10,
          at: coords ? { left: Math.max(8, coords.left - box.left), top: coords.bottom - box.top + 4 } : undefined,
          entry: (a) => ({
            label: a.title,
            hint: "kind" in a && typeof a.kind === "string" ? a.kind.split(".")[0] : undefined,
            kind: "isPreferred" in a && a.isPreferred ? { letter: "★", color: "var(--sol-yellow)", title: "preferred" } : { letter: "·", color: "var(--sol-text-dim)" },
          }),
          onPick: (a) => void runCodeAction(view, plugin.client, ws, a),
        });
      },
      (err) => failed(view, "Code actions", err),
    );
  return true;
}

async function runCodeAction(view: EditorView, client: LSPClient, ws: CodecastWorkspace, action: lsp.Command | lsp.CodeAction): Promise<void> {
  try {
    if (typeof (action as lsp.Command).command === "string") {
      const c = action as lsp.Command;
      await client.request("workspace/executeCommand", { command: c.command, arguments: c.arguments });
      return;
    }
    let ca = action as lsp.CodeAction;
    const provider = capabilitiesOf(client)?.codeActionProvider;
    const resolvable = typeof provider === "object" && provider.resolveProvider;
    if (!ca.edit && resolvable) ca = await client.request<lsp.CodeAction, lsp.CodeAction>("codeAction/resolve", ca);
    if (ca.edit) {
      client.sync();
      reportEdit(view, await applyWorkspaceEdit(ca.edit, editTarget(ws.host.vaultId, ws.rootPath), { document: (u) => ws.getFile(u) }), "Changed");
    }
    if (ca.command) await client.request("workspace/executeCommand", { command: ca.command.command, arguments: ca.command.arguments });
  } catch (err) {
    failed(view, action.title, err);
  }
}

// ── symbols ─────────────────────────────────────────────────────────────────

function documentSymbols(view: EditorView): Promise<OutlineSymbol[]> {
  const plugin = pluginOf(view);
  const state = view.state;
  if (!plugin || !can(plugin, "documentSymbolProvider")) return Promise.resolve(lezerSymbols(state));
  plugin.client.sync();
  return plugin.client
    .request<{ textDocument: { uri: string } }, (lsp.DocumentSymbol | lsp.SymbolInformation)[] | null>("textDocument/documentSymbol", { textDocument: { uri: plugin.uri } })
    .then(
      (res) => (view.state.doc === state.doc ? flattenLspSymbols(res, state) : lezerSymbols(view.state)),
      () => lezerSymbols(view.state),
    )
    .then((list) => (list.length ? list : lezerSymbols(view.state)));
}

/** The outline pick: type to filter, the editor follows the selection, Escape
 *  puts it back. */
export function gotoSymbol(view: EditorView): boolean {
  const start = view.state.selection;
  const scroll = view.scrollSnapshot();
  void documentSymbols(view).then((symbols) => {
    const lineOf = (s: OutlineSymbol, st: EditorState) => st.doc.lineAt(Math.min(s.nameFrom, st.doc.length)).number;
    const jump = (s: OutlineSymbol, focus: boolean) => {
      const pos = Math.min(s.nameFrom, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }), userEvent: "select.symbol" });
      if (focus) view.focus();
    };
    openQuickPick(view, {
      placeholder: symbols.length ? "Go to symbol in file" : "No symbols in this file",
      items: symbols,
      empty: "No matching symbol",
      entry: (s) => ({ label: s.name, detail: s.container ?? s.detail, hint: String(lineOf(s, view.state)), kind: kindGlyph(s.kind) }),
      onPreview: (s) => s && jump(s, false),
      onPick: (s) => jump(s, true),
      onCancel: () => view.dispatch({ selection: start, effects: scroll }),
    });
  });
  return true;
}

/** Symbols across the project, from the server attached here (or any server
 *  running for this folder). */
export function gotoWorkspaceSymbol(view: EditorView, clients: LSPClient[]): boolean {
  const own = pluginOf(view)?.client;
  const client = [own, ...clients].find((c): c is LSPClient => !!c && serverCan(c, "workspaceSymbolProvider") && !!workspaceOf(c));
  if (!client) {
    showNotice(view, { tone: "warn", title: "No language server running for this folder" });
    return true;
  }
  const ws = workspaceOf(client)!;
  type Sym = lsp.SymbolInformation | lsp.WorkspaceSymbol;
  openQuickPick<Sym>(view, {
    placeholder: "Go to symbol in project",
    empty: "No matching symbol",
    items: (query, signal) => {
      client.sync();
      const params: lsp.WorkspaceSymbolParams = { query };
      signal.addEventListener("abort", () => client.cancelRequest(params));
      return client.request<lsp.WorkspaceSymbolParams, Sym[] | null>("workspace/symbol", params).then((r) => (r ?? []).slice(0, 500));
    },
    entry: (s) => {
      const range = "range" in s.location ? s.location.range : null;
      return {
        label: s.name,
        detail: s.containerName || undefined,
        hint: `${displayPath(ws.rootPath, s.location.uri)}${range ? `:${range.start.line + 1}` : ""}`,
        kind: kindGlyph(lspKindName(s.kind)),
      };
    },
    onPick: (s) => {
      const range = "range" in s.location ? s.location.range : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
      goToLocation(view, s.location.uri, range, ws.rootPath);
    },
  });
  return true;
}
