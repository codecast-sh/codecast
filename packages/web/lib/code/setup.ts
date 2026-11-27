// The code editor's base: what a person coming from Zed, Cursor or VS Code
// expects before any feature (vim, LSP, git) is plugged in. Every option a
// vimrc or Settings can change (line numbers, wrap, tab size, indent unit)
// sits in its own compartment, changed through setEditorOption.

import { Compartment, EditorState, Facet, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  crosshairCursor,
  drawSelection,
  dropCursor,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection,
  scrollPastEnd,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap } from "@codemirror/autocomplete";
import { bracketMatching, codeFolding, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { runCodeCommand, type CodeCommandId } from "./commands";
import type { ExplicitEditorSettings } from "./editorSettings";
import type { IndentInfo } from "./indent";
import { statusBar } from "./statusBar";

export type LineNumberMode = "absolute" | "relative" | "off";

export interface CodeEditorOptions {
  lineNumbers: LineNumberMode;
  softWrap: boolean;
  /** Display width of a tab character. */
  tabSize: number;
  /** The core's whitespace marks (Settings > Editor). Vim draws its own
   *  `list` and turns these off while it runs. */
  showWhitespace: boolean;
}

export const DEFAULT_EDITOR_OPTIONS: CodeEditorOptions = { lineNumbers: "absolute", softWrap: false, tabSize: 4, showWhitespace: false };

const compartments = {
  lineNumbers: new Compartment(),
  softWrap: new Compartment(),
  tabSize: new Compartment(),
  showWhitespace: new Compartment(),
  indent: new Compartment(),
  readOnly: new Compartment(),
};

class NumberMarker extends GutterMarker {
  constructor(readonly text: string) {
    super();
  }
  eq(other: NumberMarker) {
    return other.text === this.text;
  }
  toDOM() {
    return document.createTextNode(this.text);
  }
}

/** Vim's `number relativenumber`: distance from the cursor line, with the
 *  cursor line itself numbered absolutely. */
function relativeLineNumbers(): Extension {
  const cursorLine = (state: EditorState) => state.doc.lineAt(state.selection.main.head).number;
  return gutter({
    class: "cm-lineNumbers",
    lineMarker: (view, block) => {
      const n = view.state.doc.lineAt(block.from).number;
      const cur = cursorLine(view.state);
      return new NumberMarker(String(n === cur ? n : Math.abs(n - cur)));
    },
    lineMarkerChange: (u: ViewUpdate) => u.selectionSet || u.docChanged,
    initialSpacer: (view) => new NumberMarker(String(view.state.doc.lines)),
    updateSpacer: (spacer, u) =>
      u.docChanged && String(u.state.doc.lines).length !== (spacer as NumberMarker).text.length
        ? new NumberMarker(String(u.state.doc.lines))
        : spacer,
  });
}

function lineNumberExtension(mode: LineNumberMode): Extension {
  if (mode === "off") return [];
  return [mode === "relative" ? relativeLineNumbers() : lineNumbers(), highlightActiveLineGutter()];
}

function indentExtension(indent: IndentInfo): Extension {
  return indentUnit.of(indent.unit);
}

/** Options a feature puts over the person's own (a vimrc's `relativenumber`
 *  or `nowrap`); a later value wins per key. Taking the feature away gives
 *  the person's options back. */
export const editorOptionOverrides = Facet.define<Partial<CodeEditorOptions>, Partial<CodeEditorOptions>>({
  combine: (values) => Object.assign({}, ...values),
  compare: (a, b) => {
    const keys = Object.keys({ ...a, ...b }) as (keyof CodeEditorOptions)[];
    return keys.every((k) => a[k] === b[k]);
  },
});

interface OptionsState {
  /** The person's options (setEditorOption). */
  base: CodeEditorOptions;
  /** What the compartments hold now: base with the overrides on top. */
  shown: CodeEditorOptions;
}

const optionsChanged = StateEffect.define<OptionsState>();

const optionsField = StateField.define<OptionsState>({
  create: () => ({ base: DEFAULT_EDITOR_OPTIONS, shown: DEFAULT_EDITOR_OPTIONS }),
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(optionsChanged)) value = e.value;
    return value;
  },
});

function optionEffect<K extends keyof CodeEditorOptions>(key: K, value: CodeEditorOptions[K]): StateEffect<unknown> {
  return key === "lineNumbers"
    ? compartments.lineNumbers.reconfigure(lineNumberExtension(value as LineNumberMode))
    : key === "softWrap"
      ? compartments.softWrap.reconfigure(value ? EditorView.lineWrapping : [])
      : key === "showWhitespace"
        ? compartments.showWhitespace.reconfigure(value ? highlightWhitespace() : [])
        : compartments.tabSize.reconfigure(EditorState.tabSize.of(value as number));
}

/** The effects that bring the compartments to `base` plus the overrides;
 *  `force` reconfigures that key even when it reads as unchanged. */
function optionEffects(state: EditorState, base: CodeEditorOptions, force?: keyof CodeEditorOptions): StateEffect<unknown>[] {
  const current = state.field(optionsField, false);
  if (!current) return [];
  const shown = { ...base, ...state.facet(editorOptionOverrides) };
  const keys = (Object.keys(shown) as (keyof CodeEditorOptions)[]).filter((k) => k === force || shown[k] !== current.shown[k]);
  if (!keys.length && base === current.base) return [];
  return [...keys.map((k) => optionEffect(k, shown[k])), optionsChanged.of({ base, shown })];
}

/** Change one option on a live editor. */
export function setEditorOption<K extends keyof CodeEditorOptions>(view: EditorView, key: K, value: CodeEditorOptions[K]): void {
  const base = view.state.field(optionsField, false)?.base;
  if (!base) return view.dispatch({ effects: optionEffect(key, value) });
  view.dispatch({ effects: optionEffects(view.state, { ...base, [key]: value }, key) });
}

/** Applies a change in the overrides. A view update cannot dispatch, so it
 *  lands in a microtask: before the browser paints, so nothing flashes. */
const applyOverrides = ViewPlugin.define((view) => {
  let live = true;
  const sync = () =>
    queueMicrotask(() => {
      if (!live) return;
      const base = view.state.field(optionsField, false)?.base;
      const effects = base ? optionEffects(view.state, base) : [];
      if (effects.length) view.dispatch({ effects });
    });
  sync();
  return {
    update(u: ViewUpdate) {
      if (u.startState.facet(editorOptionOverrides) !== u.state.facet(editorOptionOverrides)) sync();
    },
    destroy() {
      live = false;
    },
  };
});

const fontThemes = new Map<string, Extension>();

/** One theme per font size and line height, reused: each EditorView.theme
 *  mounts a stylesheet that is never taken down. */
function fontTheme(fontSize: number, lineHeight: number): Extension {
  const key = `${fontSize}/${lineHeight}`;
  let theme = fontThemes.get(key);
  if (!theme) {
    theme = Prec.highest(
      EditorView.theme({
        "&": { fontSize: `${fontSize}px` },
        ".cm-scroller": { lineHeight: String(lineHeight) },
        ".cm-gutters": { fontSize: `${fontSize - 1}px` },
      }),
    );
    fontThemes.set(key, theme);
  }
  return theme;
}

/**
 * The person's Settings > Editor choices, as one extension (the
 * "core.settings" feature). Only what they set explicitly is here. Line
 * numbers, wrap, tab size and whitespace go through editorOptionOverrides at
 * the highest precedence, whose value combines first, so a feature's own
 * value beats them: vim seeds these same choices over the vimrc's global
 * options into its runtime layer (vimFeature), which keeps `:set` working on
 * top. Font size and line height have no vimrc counterpart.
 */
export function editorSettingsExtension(explicit: ExplicitEditorSettings, font: { fontSize: number; lineHeight: number }): Extension {
  const overrides: Partial<CodeEditorOptions> = {};
  if (explicit.lineNumbers !== undefined) overrides.lineNumbers = explicit.lineNumbers;
  if (explicit.softWrap !== undefined) overrides.softWrap = explicit.softWrap;
  if (explicit.tabSize !== undefined) overrides.tabSize = explicit.tabSize;
  if (explicit.renderWhitespace !== undefined) overrides.showWhitespace = explicit.renderWhitespace;
  return [Prec.highest(editorOptionOverrides.of(overrides)), fontTheme(font.fontSize, font.lineHeight)];
}

/** Change the indent unit (vim's `shiftwidth`/`expandtab`, a status bar pick). */
export function setIndent(view: EditorView, indent: IndentInfo): void {
  view.dispatch({
    effects: [
      compartments.indent.reconfigure(indentExtension(indent)),
      ...(indent.tabs ? [compartments.tabSize.reconfigure(EditorState.tabSize.of(indent.width))] : []),
    ],
  });
}

/** Make a buffer's state read-only or writable again (the vault turned into a
 *  remote mirror, or back). The file's own reasons (lossy text) are the
 *  caller's to fold in. */
export function readOnlyEffect(readOnly: boolean): StateEffect<unknown> {
  return compartments.readOnly.reconfigure(EditorState.readOnly.of(readOnly));
}

const command = (id: CodeCommandId) => (view: EditorView) => runCodeCommand(id, undefined, { view, source: "keymap" });

export interface CodeSetupConfig {
  options: CodeEditorOptions;
  indent: IndentInfo;
  readOnly: boolean;
  largeFile: boolean;
}

export function codeSetup(config: CodeSetupConfig): Extension {
  const { options, indent, largeFile } = config;
  return [
    optionsField.init(() => ({ base: options, shown: options })),
    applyOverrides,
    compartments.lineNumbers.of(lineNumberExtension(options.lineNumbers)),
    foldGutter({
      markerDOM: (open) => {
        const el = document.createElement("span");
        el.textContent = open ? "⌄" : "›";
        el.title = open ? "Fold" : "Unfold";
        return el;
      },
    }),
    codeFolding(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    search({ top: true }),
    scrollPastEnd(),
    autocompletion(),
    // Large-file mode: both of these rescan text the size of the file.
    largeFile ? [] : [highlightSelectionMatches(), EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }])],
    compartments.indent.of(indentExtension(indent)),
    compartments.tabSize.of(EditorState.tabSize.of(indent.tabs ? indent.width : options.tabSize)),
    compartments.softWrap.of(options.softWrap ? EditorView.lineWrapping : []),
    compartments.showWhitespace.of(options.showWhitespace ? highlightWhitespace() : []),
    compartments.readOnly.of(EditorState.readOnly.of(config.readOnly)),
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: command("file.save") },
      { key: "Mod-Alt-s", preventDefault: true, run: command("file.saveAll") },
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...searchKeymap,
      ...foldKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      indentWithTab,
      // Last: whatever Escape did not close (a panel, a completion, extra
      // cursors) stops here rather than reaching the app and leaving the editor.
      { key: "Escape", run: () => true },
    ]),
    statusBar(),
  ];
}
