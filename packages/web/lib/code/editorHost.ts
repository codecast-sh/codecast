// One EditorView showing one buffer at a time: opening a file's buffer, putting
// it on screen and taking it off, without React. CodeEditor.tsx is the thin
// component around this.
//
// The theme and the file's language are registered as features like any other
// (features.ts), so a buffer that was off screen when the theme flipped, or
// whose parser was still loading, catches up the moment it is shown.

import { jumpTo } from "./jump";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { bufferFields, bufferKey, codeBuffers, currentState, decodeFileText, fileFormatField, updateBuffer, type CodeBuffer, type FileFormat } from "./buffers";
import {
  LARGE_FILE_BYTES,
  attachFeatureHost,
  featureBase,
  reconfigureEditorFeature,
  registerEditorFeature,
  syncEditorFeatures,
  type EditorFeatureContext,
} from "./features";
import { describeLanguage, languageByName, loadedLanguage, loadLanguage, lspLanguageId } from "./languages";
import { detectIndent } from "./indent";
import { codeSetup, DEFAULT_EDITOR_OPTIONS, editorSettingsExtension, readOnlyEffect, type CodeEditorOptions } from "./setup";
import { editorSetting, explicitEditorSettings, onEditorSettingsChange, registerEditorSettingsCommands } from "./editorSettings";
import { registerAutosaveFeature } from "./autosave";
import { fileSyncExtensions, hasVaultSaver, restoreHotExit } from "./fileSync";
import { observeCodeTheme, solCodeTheme } from "./theme";
import { markNewFile } from "./newFiles";
import { registerVimFeature } from "./vimFeature";
import { registerLspFeature } from "./lsp/register";
import { registerGitFeature } from "./git";
import { registerAgentFeature } from "./agent/feature";
import { registerBlameFeature } from "./blame";
import { flashLines } from "./lineFlash";

let coreRegistered = false;

/** Theme, language, the person's settings, autosave and vim, registered once
 *  for every editor. */
function registerCoreFeatures(): void {
  if (coreRegistered) return;
  coreRegistered = true;
  registerEditorFeature("core.theme", () => solCodeTheme());
  // A parser already loaded lands with the other features, in the same
  // transaction as the buffer's first paint; only a first use waits on a chunk.
  registerEditorFeature("core.language", (ctx) => {
    const desc = languageByName(ctx.languageName);
    return loadedLanguage(desc) ?? loadLanguage(desc);
  });
  observeCodeTheme(() => reconfigureEditorFeature("core.theme"));
  // Settings > Editor, live: a change (here or on another device) reaches
  // every open editor through its compartment, never a remount.
  registerEditorFeature("core.settings", () =>
    editorSettingsExtension(explicitEditorSettings(), { fontSize: editorSetting("fontSize"), lineHeight: editorSetting("lineHeight") }),
  );
  onEditorSettingsChange(() => reconfigureEditorFeature("core.settings"));
  registerAutosaveFeature();
  registerEditorSettingsCommands();
  registerVimFeature();
  registerLspFeature();
  registerGitFeature();
  registerBlameFeature();
  registerAgentFeature();
}

/** Extensions bound to the view rather than the file (the app's undo guard). */
const viewSlot = new Compartment();

export interface OpenFileInput {
  vaultId: string;
  path: string;
  content: string;
  etag: string;
  /** Bytes served with `content`, when known: it is how a BOM or a file in
   *  another encoding is noticed (buffers.decodeFileText). Never a size read
   *  separately, which can belong to another version. */
  sizeBytes?: number;
  readOnly: boolean;
  options?: CodeEditorOptions;
}

/** The file's buffer, created on first open (and its hot-exit text restored). */
export function openCodeBuffer(input: OpenFileInput): CodeBuffer {
  registerCoreFeatures();
  const isNew = !codeBuffers.get(bufferKey(input.vaultId, input.path));
  const buffer = codeBuffers.open({
    vaultId: input.vaultId,
    path: input.path,
    content: input.content,
    etag: input.etag,
    sizeBytes: input.sizeBytes,
    extensions: ({ text, format }) => bufferExtensions(input, text, format),
  });
  if (isNew && !currentState(buffer).readOnly) void restoreHotExit(buffer);
  return buffer;
}

/** An empty buffer for a file that does not exist yet; its first save creates
 *  the file (newFiles.ts, fileSync.writeBuffer). */
export function openNewFileBuffer(input: { vaultId: string; path: string; readOnly: boolean }): CodeBuffer {
  const buffer = openCodeBuffer({ ...input, content: "", etag: "" });
  markNewFile(buffer.key);
  return buffer;
}

/** Follow the vault's read-only state for a buffer already open: it was read
 *  at creation, and a vault can turn into a remote mirror (or back) while its
 *  files stay open. Text that did not decode stays read-only either way. A
 *  buffer turning writable gets its hot-exit text back, which a read-only
 *  creation skipped. */
export function syncReadOnly(buffer: CodeBuffer, readOnly: boolean): void {
  const state = currentState(buffer);
  const want = readOnly || state.field(fileFormatField).lossy;
  if (state.readOnly === want) return;
  updateBuffer(buffer, { effects: readOnlyEffect(want) });
  if (!want) void restoreHotExit(buffer);
}

/** A read-only state showing text the editor has no buffer for yet (unsaved
 *  text held for hot exit, while the daemon reconnects), dressed like the
 *  file's buffer would be. Never registered as a buffer, so nothing saves it. */
export function previewState(input: { vaultId: string; path: string; content: string }): EditorState {
  registerCoreFeatures();
  const decoded = decodeFileText(input.content);
  return EditorState.create({
    doc: decoded.text,
    extensions: [bufferFields(decoded.format), bufferExtensions({ ...input, etag: "", readOnly: true }, decoded.text, decoded.format)],
  });
}

function bufferExtensions(input: OpenFileInput, text: string, format: FileFormat): Extension {
  const nl = text.indexOf("\n");
  const firstLine = text.slice(0, nl === -1 ? 200 : Math.min(nl, 200));
  const language = describeLanguage(input.path, firstLine);
  const sizeBytes = input.sizeBytes ?? text.length;
  const largeFile = sizeBytes > LARGE_FILE_BYTES;
  // Text that did not decode cannot be written back without destroying the
  // bytes it stands in for.
  const readOnly = input.readOnly || format.lossy;
  const ctx: EditorFeatureContext = {
    vaultId: input.vaultId,
    path: input.path,
    languageId: lspLanguageId(language),
    languageName: language?.name ?? null,
    sizeBytes,
    largeFile,
    // A vault with a saver of its own holds no vault files (the vimrc overlay).
    ...(hasVaultSaver(input.vaultId) ? { isRealVault: false } : {}),
  };
  const options = input.options ?? DEFAULT_EDITOR_OPTIONS;
  return [
    featureBase(ctx),
    viewSlot.of([]),
    fileSyncExtensions(),
    codeSetup({
      options,
      indent: detectIndent(text, { languageName: ctx.languageName, tabSize: input.options?.tabSize ?? editorSetting("tabSize") }),
      readOnly,
      largeFile,
    }),
  ];
}

export interface CursorTarget {
  /** 1-based. */
  line: number;
  /** 1-based; the line's first non-blank character when absent. */
  column?: number;
  /** The last line of a range that flashes on arrival (an agent's edit). */
  endLine?: number;
  /** The line to put at the top of the view (a reload restoring where a tab
   *  was scrolled); the cursor's line is centered when absent. */
  top?: number;
}

/** `12`, `12:3`, `L12`, `12-20` / `12:3-20` (a range: cursor on its first
 *  line, the range flashed) as a cursor target. The spelling filesHref
 *  (lib/vault/vaultHref cursorParam) writes. A restored tab adds `@400`, the
 *  line at the top of its view. */
export function parseCursorTarget(raw: string | null | undefined): CursorTarget | null {
  const m = raw ? /^L?(\d+)(?:[:.,](\d+))?(?:-L?(\d+))?(?:@(\d+))?/.exec(raw.trim()) : null;
  if (!m) return null;
  const line = parseInt(m[1], 10);
  if (!(line > 0)) return null;
  const end = m[3] ? parseInt(m[3], 10) : 0;
  const top = m[4] ? parseInt(m[4], 10) : 0;
  return {
    line,
    column: m[2] ? Math.max(1, parseInt(m[2], 10)) : undefined,
    ...(end > line ? { endLine: end } : {}),
    ...(top > 0 ? { top } : {}),
  };
}

/** Put the cursor at a target and center its line. */
export function revealTarget(view: EditorView, target: CursorTarget): void {
  const doc = view.state.doc;
  const line = doc.line(Math.min(target.line, doc.lines));
  const col = target.column ? target.column - 1 : (/^\s*/.exec(line.text)?.[0].length ?? 0);
  const top = target.top ? doc.line(Math.min(target.top, doc.lines)).from : undefined;
  jumpTo(view, line.from + Math.min(col, line.length), { scrollTop: top });
  if (target.endLine) flashLines(view, line.number, target.endLine);
}

const EMPTY_STATE = EditorState.create({ extensions: EditorState.readOnly.of(true) });

/** One view, swapping buffers through it. */
export class EditorHost {
  readonly view: EditorView;
  private shown: CodeBuffer | null = null;
  private readonly detachFeatures: () => void;

  constructor(parent: HTMLElement, private readonly viewExtensions: Extension) {
    this.view = new EditorView({ parent });
    this.detachFeatures = attachFeatureHost(this.view);
  }

  get buffer(): CodeBuffer | null {
    return this.shown;
  }

  /** Show a buffer: `setState` with its saved state and scroll, never a new view. */
  show(buffer: CodeBuffer, target?: CursorTarget | null): void {
    if (this.shown === buffer) {
      if (target) revealTarget(this.view, target);
      return;
    }
    this.hide();
    // A buffer shown in another editor moves here with its live state.
    if (buffer.view && buffer.view !== this.view) {
      buffer.state = buffer.view.state;
    }
    // This host's own extensions go into the state before it is shown: a
    // reconfigure after setState would build every plugin and panel twice.
    const state = viewSlot.get(buffer.state) === this.viewExtensions ? buffer.state : buffer.state.update({ effects: viewSlot.reconfigure(this.viewExtensions) }).state;
    this.view.setState(state);
    buffer.view = this.view;
    this.shown = buffer;
    codeBuffers.touch(buffer);
    syncEditorFeatures(this.view);
    if (target) revealTarget(this.view, target);
    else if (buffer.scroll) this.view.dispatch({ effects: buffer.scroll });
    codeBuffers.evict();
  }

  /** Show nothing while the next file's text is on its way, keeping the view
   *  (and everything mounted around it) in place. */
  showEmpty(): void {
    this.hide();
    this.view.setState(EMPTY_STATE);
  }

  /** Show a read-only stand-in (previewState) until the file's buffer exists. */
  showPreview(state: EditorState): void {
    this.hide();
    this.view.setState(state);
    syncEditorFeatures(this.view);
  }

  /** Take the shown buffer off screen, keeping its live state and scroll. */
  hide(): void {
    const b = this.shown;
    if (!b) return;
    b.scroll = this.view.scrollSnapshot();
    b.state = this.view.state;
    if (b.view === this.view) b.view = null;
    this.shown = null;
  }

  destroy(): void {
    this.hide();
    this.detachFeatures();
    this.view.destroy();
  }
}
