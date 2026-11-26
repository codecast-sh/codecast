// Language intelligence in the code editor, loaded by register.ts the first
// time a file that could have a language server opens: the "lsp" feature's
// extension (a buffer whose language has a server installed for its folder
// gets the server's plugin, completion, hover, signature help and
// diagnostics), the two status items, and the language commands vim and the
// keymap run (lsp.*, diagnostic.next/prev, goto.symbol, goto.workspaceSymbol).
//
// One LSPClient per (folder, server) is shared by every buffer of the
// languages it answers for (pool.ts); each buffer's document stays open while
// its buffer does (workspace.ts). Large files (over 1.5 MB) opt out. Nothing
// here runs per keystroke beyond lsp-client's own change tracking and a
// debounced sync.

import type * as lsp from "./protocol";
import DOMPurify from "dompurify";
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { lintGutter, nextDiagnostic, previousDiagnostic } from "@codemirror/lint";
import { hoverTooltips, signatureHelp, LSPPlugin, type LSPClient } from "@codemirror/lsp-client";
import { featureContext, reconfigureEditorFeature, registerStatusItem, type EditorFeatureContext } from "../features";
import { registerCodeCommands, runCodeCommand, type CodeCommandContext, type CodeCommandHandler, type CodeCommandId } from "../commands";
import { codeBuffers, type CodeBuffer } from "../buffers";
import { saveAllBuffers, saveBuffer, type SaveOutcome } from "../fileSync";
import type { LspCommandId } from "./register";
import { editorSetting } from "../editorSettings";
import { configureLspPool, getLspClient, lspClientsFor } from "./pool";
import { lspCompletion } from "./completion";
import { forgetClientDiagnostics, handlePublishDiagnostics } from "./diagnostics";
import { applyWorkspaceEdit, offsetIn } from "./edits";
import { activeView, editTarget, workspaceHost } from "./host";
import {
  closeCursorHover,
  codeActions,
  findReferences,
  formatDocument,
  formatFile,
  formatTargetOf,
  formatTargetOfBuffer,
  goToDefinition,
  gotoSymbol,
  gotoWorkspaceSymbol,
  hoverAtCursor,
  pluginOf,
  reportEdit,
  startRename,
} from "./navigation";
import { CodecastWorkspace } from "./workspace";
import { vaultFileUri } from "./uri";
import { lspTheme } from "./ui/theme";
import { closePeek } from "./ui/peek";
import { diagnosticsItem, serverChip } from "./ui/status";

/** Capabilities beyond @codemirror/lsp-client's own: everything the commands
 *  here answer. */
const CAPABILITIES = {
  general: { positionEncodings: ["utf-16"] },
  window: { workDoneProgress: true },
  workspace: {
    applyEdit: true,
    workspaceEdit: { documentChanges: true },
    symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
    executeCommand: {},
    configuration: true,
    workspaceFolders: true,
  },
  textDocument: {
    completion: {
      completionItem: { resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] }, labelDetailsSupport: true },
      completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
    },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
    rename: { prepareSupport: true },
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"] },
      },
      isPreferredSupport: true,
      disabledSupport: true,
      dataSupport: true,
      resolveSupport: { properties: ["edit"] },
    },
    publishDiagnostics: { versionSupport: true, tagSupport: { valueSet: [1, 2] } },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    implementation: { linkSupport: true },
  },
};

/** Push the person's edits to the server once typing pauses, so diagnostics
 *  follow without a request to carry them. */
const autoSync = ViewPlugin.fromClass(
  class {
    timer: ReturnType<typeof setTimeout> | null = null;
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      if (!u.docChanged) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        LSPPlugin.get(this.view)?.client.sync();
      }, 400);
    }
    destroy() {
      if (this.timer) clearTimeout(this.timer);
    }
  },
);

const run = (fn: (view: EditorView) => boolean) => (view: EditorView) => fn(view);

/** Keys a person coming from VS Code or Zed expects. */
const lspKeymap = keymap.of([
  { key: "F12", run: run((v) => goToDefinition(v)), preventDefault: true },
  { key: "Shift-F12", run: run(findReferences), preventDefault: true },
  { key: "F2", run: run(startRename), preventDefault: true },
  { key: "Mod-.", run: run(codeActions), preventDefault: true },
  { key: "Shift-Alt-f", run: (v) => formatDocument(v) !== null, preventDefault: true },
  { key: "Mod-Shift-o", run: run(gotoSymbol), preventDefault: true },
  { key: "Mod-Alt-o", run: (v) => gotoWorkspaceSymbol(v, workspaceClients(v)), preventDefault: true },
  { key: "F8", run: nextDiagnostic, preventDefault: true },
  { key: "Shift-F8", run: previousDiagnostic, preventDefault: true },
  { key: "Escape", run: (v) => closeCursorHover(v) || closePeek(v) },
]);

/** Every server running for the folder this editor's file is in. */
function workspaceClients(view: EditorView): LSPClient[] {
  const vaultId = view.state.facet(featureContext)?.vaultId;
  return vaultId ? lspClientsFor(vaultId) : [];
}

const sanitize = (html: string) => DOMPurify.sanitize(html, { FORBID_TAGS: ["style", "form", "input", "img"], FORBID_ATTR: ["style"] });

/** The extension a buffer gets while its server is attached. */
function attached(client: LSPClient, uri: string, languageId: string): Extension {
  return [
    client.plugin(uri, languageId),
    lspCompletion(),
    hoverTooltips({ hoverTime: 350 }),
    signatureHelp(),
    lintGutter({ hoverTime: 250 }),
    autoSync,
    Prec.high(lspKeymap),
    lspTheme,
  ];
}

// ── format on save ──────────────────────────────────────────────────────────

/** Format the file a save was asked for, then save that same buffer. Both are
 *  fixed at the press: a tab switch while the server works never moves the
 *  edits or the write to the file shown next. */
function formatAndSave(ctx: CodeCommandContext): { buffer: CodeBuffer; view: EditorView; saved: Promise<SaveOutcome> } | null {
  if (!editorSetting("formatOnSave")) return null;
  const view = ctx.view ?? activeView();
  const target = view && formatTargetOf(view);
  const buffer = target?.file.buffer();
  if (!view || !target || !buffer) return null;
  const saved = formatFile(target)
    .catch(() => false)
    .then(() => saveBuffer(buffer));
  return { buffer, view, saved };
}

const saveHooks: Partial<Record<CodeCommandId, CodeCommandHandler>> = {
  "file.save": (_args, ctx) => !!formatAndSave(ctx),
  // vim's :wq / :x: close once the formatted file is written, and only while
  // it is still the file shown in that editor.
  "file.saveAndClose": (_args, ctx) => {
    const run = formatAndSave(ctx);
    if (!run) return false;
    void run.saved.then((outcome) => {
      if ((outcome === "saved" || outcome === "unchanged") && run.buffer.view === run.view) runCodeCommand("file.close", undefined, { ...ctx, view: run.view });
    });
    return true;
  },
  // Save all formats every unsaved buffer a server holds, on screen or not.
  "file.saveAll": (_args, ctx) => {
    if (!editorSetting("formatOnSave")) return false;
    // Another surface's own Save all (search results) keeps its meaning.
    if (ctx.view && !ctx.view.state.facet(featureContext)) return false;
    const targets = codeBuffers
      .dirty()
      .filter((b) => !b.merging)
      .map((b) => formatTargetOfBuffer(b, lspClientsFor(b.vaultId)))
      .filter((t) => t !== null);
    if (!targets.length) return false;
    void Promise.all(targets.map((t) => formatFile(t).catch(() => false))).then(() => saveAllBuffers());
    return true;
  },
};

/** The registry runs the newest handler first and has no priorities, so the
 *  hooks re-register each time a buffer gains a server, to stay ahead of an
 *  editor (and its save handlers) mounted after them. */
let unregisterSaveHooks: (() => void) | null = null;
function keepSaveHooksFirst(): void {
  unregisterSaveHooks?.();
  unregisterSaveHooks = registerCodeCommands(saveHooks);
}

// ── activation ──────────────────────────────────────────────────────────────

const onView =
  (fn: (view: EditorView) => boolean | null | Promise<unknown>): CodeCommandHandler =>
  (_args, ctx: CodeCommandContext) => {
    const view = ctx.view ?? activeView();
    if (!view) return false;
    const r = fn(view);
    return r === null ? false : r instanceof Promise ? true : r;
  };

/** The language commands, as register.ts routes them once this module loads. */
export const lspCommandHandlers: Record<LspCommandId, CodeCommandHandler> = {
  "lsp.definition": onView((v) => goToDefinition(v)),
  "lsp.references": onView(findReferences),
  "lsp.hover": onView(hoverAtCursor),
  "lsp.rename": onView(startRename),
  "lsp.format": onView(formatDocument),
  "lsp.codeAction": onView(codeActions),
  "diagnostic.next": onView(nextDiagnostic),
  "diagnostic.prev": onView(previousDiagnostic),
  "goto.symbol": onView(gotoSymbol),
  "goto.workspaceSymbol": onView((v) => gotoWorkspaceSymbol(v, workspaceClients(v))),
};

let active = false;

/** Configure the pool and add the status items; once, when the first file
 *  that could have a server opens. */
export function activateLsp(): void {
  if (active) return;
  active = true;
  configureLspPool({
    workspaceHost,
    // A buffer whose saved state holds a disposed client, or that found no
    // server, builds its "lsp" extension again when next shown.
    reattach: () => reconfigureEditorFeature("lsp"),
    onClientDown: (client) => forgetClientDiagnostics(client),
    clientConfig: () => ({
      sanitizeHTML: sanitize,
      extensions: [{ clientCapabilities: CAPABILITIES }],
      notificationHandlers: { "textDocument/publishDiagnostics": handlePublishDiagnostics },
    }),
    serverRequests: (client) => ({
      "workspace/applyEdit": async (params: lsp.ApplyWorkspaceEditParams) => {
        const ws = client.workspace;
        if (!(ws instanceof CodecastWorkspace)) return { applied: false, failureReason: "no workspace" };
        client.sync();
        const report = await applyWorkspaceEdit(params.edit, editTarget(ws.host.vaultId, ws.rootPath), { document: (u) => ws.getFile(u) });
        reportEdit(activeView(), report, params.label ?? "Changed");
        const failed = report.conflicts.length + report.skipped.length;
        return failed ? { applied: false, failureReason: `${failed} file(s) not changed` } : { applied: true };
      },
      // typescript-language-server, after an extract refactoring: put the
      // person in a rename of the name it just made up.
      "_typescript.rename": (params: lsp.TextDocumentPositionParams) => {
        const ws = client.workspace;
        const view = ws instanceof CodecastWorkspace ? ws.getFile(params.textDocument.uri)?.getView() : null;
        if (!view) return null;
        const pos = offsetIn(view.state.doc, params.position);
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        startRename(view);
        return null;
      },
    }),
  });
  registerStatusItem({ id: "lsp.diagnostics", side: "right", order: 40, priority: 70, needsVault: true, create: diagnosticsItem });
  registerStatusItem({ id: "lsp.server", side: "right", order: 45, priority: 40, needsVault: true, create: serverChip });
}

/** The "lsp" feature's extension for a file: its server attached, or only the
 *  theme (for the status chip and problems list) when no server for its
 *  language is installed or it could not start. */
/** Whether `lspExtension` attached a server (it returns the bare theme when
 *  no server runs for the file). */
export function lspAttached(ext: Extension | null): boolean {
  return !!ext && ext !== lspTheme;
}

export async function lspExtension(ctx: EditorFeatureContext): Promise<Extension | null> {
  activateLsp();
  const client = await getLspClient(ctx.vaultId, ctx.languageId);
  const ws = client?.workspace;
  const root = ws instanceof CodecastWorkspace ? ws.rootPath : null;
  if (!client || !root) return lspTheme;
  keepSaveHooksFirst();
  return attached(client, vaultFileUri(root, ctx.path), ctx.languageId);
}

// Development only: drive the language commands from the console or a test
// browser (`__codeLsp.hover(view)`), the way `__inboxStore` exposes the store.
if (import.meta.env?.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__codeLsp = {
    hover: hoverAtCursor,
    definition: goToDefinition,
    references: findReferences,
    rename: startRename,
    format: formatDocument,
    codeActions,
    symbols: gotoSymbol,
    workspaceSymbols: (v: EditorView) => gotoWorkspaceSymbol(v, workspaceClients(v)),
    run: (id: LspCommandId, view: EditorView) => lspCommandHandlers[id](undefined, { view, source: "api" }),
  };
}
