// The CodeMirror side of a vimrc's options: tab size, indent unit, wrap,
// scrolloff, colorcolumn, cursorline, list, iskeyword, and the line number
// flags the core's gutter reads. `:set` in the command line changes them on
// the live editor too.

import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  RectangleMarker,
  ViewPlugin,
  highlightActiveLine,
  highlightTrailingWhitespace,
  highlightWhitespace,
  layer,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { indentUnit } from "@codemirror/language";
import { Vim } from "@replit/codemirror-vim";
import { editorOptionOverrides, type CodeEditorOptions } from "../setup";
import { asVimCM, notify } from "./engine";
import { defaultOptionState, listOp, splitSetArgs, unescapeValue } from "./options";
import type { VimConfigReport, VimOptionValues } from "./types";

export interface VimEditorOptions {
  tabSize?: number;
  /** The text one indent level inserts: spaces when expandtab, else a tab. */
  indentUnit?: string;
  insertSpaces?: boolean;
  /** Raw `number` and `relativenumber`, when the config set them. */
  number?: boolean;
  relativeNumber?: boolean;
  /** Folded for a gutter: relative covers `number relativenumber` too (the
   *  cursor line shows its absolute number). Absent when neither was set. */
  lineNumbers?: "absolute" | "relative" | "off";
  wrap?: boolean;
  lineBreak?: boolean;
  scrollOff?: number;
  sideScrollOff?: number;
  /** 1-based columns. */
  colorColumns?: number[];
  cursorLine?: boolean;
  list?: boolean;
  listChars?: string;
  /** Characters beyond letters, digits and `_` that count as word characters. */
  wordChars?: string;
  textWidth?: number;
}

// ── filetypes ───────────────────────────────────────────────────────────────

/** Language names (CodeMirror's and LSP ids) to the vim filetype a vimrc's
 *  `autocmd FileType` names. Anything unlisted is tried lowercased. */
const FILETYPES: Record<string, string[]> = {
  "c++": ["cpp"],
  cpp: ["cpp"],
  "c#": ["cs"],
  csharp: ["cs"],
  "objective-c": ["objc"],
  "objective-c++": ["objcpp"],
  shell: ["sh", "bash", "zsh"],
  bash: ["sh", "bash"],
  zsh: ["zsh", "sh"],
  shellscript: ["sh", "bash"],
  jsx: ["javascriptreact", "javascript"],
  javascriptreact: ["javascriptreact", "javascript"],
  tsx: ["typescriptreact", "typescript"],
  typescriptreact: ["typescriptreact", "typescript"],
  json: ["json"],
  jsonc: ["jsonc", "json"],
  "json5": ["json5", "json"],
  markdown: ["markdown", "md"],
  yaml: ["yaml"],
  dockerfile: ["dockerfile"],
  makefile: ["make"],
  "vim script": ["vim"],
  vimscript: ["vim"],
  "protocol buffer": ["proto"],
  protobuf: ["proto"],
  "common lisp": ["lisp"],
  "emacs lisp": ["lisp"],
  scss: ["scss"],
  sass: ["sass"],
  latex: ["tex", "latex"],
  stex: ["tex"],
  html: ["html"],
  vue: ["vue"],
  svelte: ["svelte"],
  kotlin: ["kotlin"],
  "f#": ["fsharp"],
  go: ["go"],
  python: ["python"],
  rust: ["rust"],
  ruby: ["ruby"],
};

export function filetypesFor(languageId: string | undefined): string[] {
  if (!languageId) return [];
  const id = languageId.toLowerCase();
  return [...(FILETYPES[id] ?? []), id.replace(/\s+/g, "")];
}

// ── resolving ───────────────────────────────────────────────────────────────

/** The options in effect for one language: global, then that filetype's
 *  `autocmd FileType ... setlocal`, then `seed` (the person's Settings >
 *  Editor choices, which beat everything in their vimrc). A `:set` typed in
 *  the editor still sits above all of it. */
export function resolveValues(
  report: Pick<VimConfigReport, "options"> | null | undefined,
  languageId?: string,
  seed?: VimOptionValues,
): VimOptionValues {
  const out: VimOptionValues = { ...report?.options.global };
  // Most specific last: the CodeMirror/LSP name wins over its family.
  if (report) for (const ft of [...filetypesFor(languageId)].reverse()) Object.assign(out, report.options.byFiletype[ft]);
  return Object.assign(out, seed);
}

function colorColumns(spec: string | undefined, textwidth: number | undefined): number[] | undefined {
  if (spec === undefined) return undefined;
  const cols: number[] = [];
  for (const part of spec.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const rel = /^([+-])(\d+)$/.exec(p);
    if (rel) {
      if (textwidth) cols.push(textwidth + (rel[1] === "+" ? 1 : -1) * Number(rel[2]));
    } else if (/^\d+$/.test(p)) cols.push(Number(p));
  }
  return cols.filter((c) => c > 0);
}

/** iskeyword's extra characters: `@,48-57,_,192-255,-,#` gives "-#". */
export function wordCharsFromIskeyword(spec: string): string {
  const extra = new Set<string>();
  const parts = spec.match(/\^?(?:\d+-\d+|.-.|[^,]+|,)(?=,|$)/g) ?? [];
  for (const raw of parts) {
    const exclude = raw.startsWith("^") && raw.length > 1;
    const p = exclude ? raw.slice(1) : raw;
    if (p === "@") continue;
    let range: [number, number];
    const num = /^(\d+)-(\d+)$/.exec(p);
    const chr = /^(.)-(.)$/.exec(p);
    if (num) range = [Number(num[1]), Number(num[2])];
    else if (chr) range = [chr[1].charCodeAt(0), chr[2].charCodeAt(0)];
    else if (/^\d+$/.test(p)) range = [Number(p), Number(p)];
    else if (p === "@-@") range = [64, 64];
    else range = [p.charCodeAt(0), p.charCodeAt(0)];
    for (let c = range[0]; c <= range[1] && c < 128; c++) {
      const ch = String.fromCharCode(c);
      if (/[\w]/.test(ch) || c < 33) continue;
      if (exclude) extra.delete(ch);
      else extra.add(ch);
    }
  }
  return [...extra].join("");
}

export function editorOptionsFromValues(v: VimOptionValues): VimEditorOptions {
  const out: VimEditorOptions = {};
  if (v.tabstop !== undefined) out.tabSize = v.tabstop;
  if (v.shiftwidth !== undefined || v.expandtab !== undefined) {
    const width = v.shiftwidth || v.tabstop;
    out.insertSpaces = v.expandtab;
    if (v.expandtab) out.indentUnit = " ".repeat(width || 4);
    else if (v.expandtab === false) out.indentUnit = "\t";
    else if (width) out.indentUnit = " ".repeat(width);
  }
  if (v.number !== undefined) out.number = v.number;
  if (v.relativenumber !== undefined) out.relativeNumber = v.relativenumber;
  if (v.number !== undefined || v.relativenumber !== undefined) {
    out.lineNumbers = v.relativenumber ? "relative" : v.number ? "absolute" : v.number === false ? "off" : undefined;
    if (!out.lineNumbers) delete out.lineNumbers;
  }
  if (v.wrap !== undefined) out.wrap = v.wrap;
  if (v.linebreak !== undefined) out.lineBreak = v.linebreak;
  if (v.scrolloff !== undefined) out.scrollOff = v.scrolloff;
  if (v.sidescrolloff !== undefined) out.sideScrollOff = v.sidescrolloff;
  const cols = colorColumns(v.colorcolumn, v.textwidth);
  if (cols) out.colorColumns = cols;
  if (v.cursorline !== undefined) out.cursorLine = v.cursorline;
  if (v.list !== undefined) out.list = v.list;
  if (v.listchars !== undefined) out.listChars = v.listchars;
  if (v.iskeyword !== undefined) out.wordChars = wordCharsFromIskeyword(v.iskeyword);
  if (v.textwidth !== undefined) out.textWidth = v.textwidth;
  return out;
}

/** What the core reads to set up the gutter and its own option compartments. */
export function editorOptionsFromReport(report: Pick<VimConfigReport, "options"> | null | undefined, languageId?: string): VimEditorOptions {
  return editorOptionsFromValues(resolveValues(report, languageId));
}

// ── extensions ──────────────────────────────────────────────────────────────

const tabMatcher = new MatchDecorator({ regexp: /\t/g, decoration: Decoration.mark({ class: "cm-vimListTab" }) });
const listTabs = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = tabMatcher.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = tabMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

function colorColumnLayer(columns: number[]): Extension {
  return layer({
    above: false,
    class: "cm-vimColorColumns",
    update: (u) => u.geometryChanged || u.viewportChanged,
    markers(view) {
      const left = view.contentDOM.getBoundingClientRect().left - view.scrollDOM.getBoundingClientRect().left + view.scrollDOM.scrollLeft;
      const pad = parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0;
      const height = Math.max(view.contentHeight, view.scrollDOM.clientHeight);
      return columns.map((c) => new RectangleMarker("cm-vimColorColumn", left + pad + (c - 1) * view.defaultCharacterWidth, 0, 1, height));
    },
  });
}

/** `scrolloff`/`sidescrolloff`: how far the cursor stays from the edges when
 *  it scrolls into view. A cursor margin, not `scrollMargins`: those mark the
 *  edges as covered, and the editor then hides every tooltip (hover, rename,
 *  completion) anchored there. The margin is in lines and columns, so it is
 *  measured once the view has its geometry, and again when that changes. */
function scrollOffExtension(so: number, siso: number): Extension {
  const slot = new Compartment();
  const margin = (view: EditorView) => {
    // 999 means "keep the cursor centered": cap at half the viewport.
    const half = view.scrollDOM.clientHeight / 2 - view.defaultLineHeight;
    return { x: siso * view.defaultCharacterWidth, y: Math.max(0, Math.min(so * view.defaultLineHeight, half)) };
  };
  const follow = ViewPlugin.define((view) => {
    const sync = () => {
      const m = margin(view);
      const now = view.state.facet(EditorView.cursorScrollMargin);
      if (now.x === m.x && now.y === m.y) return;
      // Not inside a measure: the next microtask, if this view still carries the slot.
      queueMicrotask(() => {
        if (view.dom.isConnected && slot.get(view.state) !== undefined) view.dispatch({ effects: slot.reconfigure(EditorView.cursorScrollMargin.of(m)) });
      });
    };
    view.requestMeasure({ read: sync });
    return {
      update(u) {
        if (u.geometryChanged) view.requestMeasure({ read: sync });
      },
    };
  });
  return [slot.of([]), follow];
}

function build(o: VimEditorOptions): Extension {
  const ext: Extension[] = [];
  if (o.tabSize !== undefined) ext.push(EditorState.tabSize.of(o.tabSize));
  if (o.indentUnit !== undefined) ext.push(indentUnit.of(o.indentUnit));
  if (o.scrollOff || o.sideScrollOff) ext.push(scrollOffExtension(o.scrollOff ?? 0, o.sideScrollOff ?? 0));
  if (o.colorColumns?.length) ext.push(colorColumnLayer(o.colorColumns));
  if (o.cursorLine) ext.push(highlightActiveLine());
  if (o.list) ext.push(/(^|,)space:/.test(o.listChars ?? "") ? highlightWhitespace() : [listTabs, highlightTrailingWhitespace()]);
  if (o.wordChars) ext.push(EditorState.languageData.of(() => [{ wordChars: o.wordChars }]));
  return ext;
}

interface OptionsState {
  values: VimOptionValues;
  compartment: Compartment;
}

const setValues = StateEffect.define<VimOptionValues>();

const optionsField = StateField.define<OptionsState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setValues) && value) value = { ...value, values: e.value };
    return value;
  },
});

/** The gutter and wrap the core draws, from the options in effect now. The
 *  core's whitespace marks stay off: `list` draws vim's own. */
function coreOverrides(st: OptionsState | null): Partial<CodeEditorOptions> {
  if (!st) return {};
  const o = editorOptionsFromValues(st.values);
  const out: Partial<CodeEditorOptions> = { showWhitespace: false };
  if (o.lineNumbers) out.lineNumbers = o.lineNumbers;
  if (o.wrap !== undefined) out.softWrap = o.wrap;
  return out;
}

/** The CodeMirror half of a vimrc for one language. Its tab size, indent
 *  unit and word characters are Prec.high, so they beat the editor's own
 *  defaults wherever it is placed (the core appends features after its
 *  option compartments, and those facets take the first value). Line numbers
 *  and wrap go to the core's own compartments through editorOptionOverrides,
 *  so `nowrap` and `nonumber` turn them off and `:set rnu` reaches the gutter. */
export function vimOptionsExtension(
  report: Pick<VimConfigReport, "options"> | null | undefined,
  languageId?: string,
  seed?: VimOptionValues,
): Extension {
  const values = resolveValues(report, languageId, seed);
  const compartment = new Compartment();
  return [
    optionsField.init(() => ({ values, compartment })),
    editorOptionOverrides.compute([optionsField], (s) => coreOverrides(s.field(optionsField))),
    Prec.high(compartment.of(build(editorOptionsFromValues(values)))),
  ];
}

/** The options a live editor runs with now, `:set` changes included. */
export function readVimEditorOptions(state: EditorState): VimEditorOptions | null {
  const st = state.field(optionsField, false);
  return st ? editorOptionsFromValues(st.values) : null;
}

/** For an update listener: the new options when `:set` changed them. */
export function vimEditorOptionsChanged(update: ViewUpdate): VimEditorOptions | null {
  return update.transactions.some((tr) => tr.effects.some((e) => e.is(setValues))) ? readVimEditorOptions(update.state) : null;
}

// ── :set on a live editor ───────────────────────────────────────────────────

type Kind = "boolean" | "number" | "string";
const RUNTIME: Array<[keyof VimOptionValues, Kind, string[]]> = [
  ["tabstop", "number", ["ts"]],
  ["shiftwidth", "number", ["sw"]],
  ["softtabstop", "number", ["sts"]],
  ["expandtab", "boolean", ["et"]],
  ["number", "boolean", ["nu"]],
  ["relativenumber", "boolean", ["rnu"]],
  ["wrap", "boolean", []],
  ["linebreak", "boolean", ["lbr"]],
  ["scrolloff", "number", ["so"]],
  ["sidescrolloff", "number", ["siso"]],
  ["colorcolumn", "string", ["cc"]],
  ["cursorline", "boolean", ["cul"]],
  ["list", "boolean", []],
  ["listchars", "string", ["lcs"]],
  ["iskeyword", "string", ["isk"]],
];

let runtimeInstalled = false;

export function installRuntimeOptions(): void {
  if (runtimeInstalled) return;
  runtimeInstalled = true;
  installRuntimeSet();
  const defaults = defaultOptionState();
  for (const [name, kind, aliases] of RUNTIME) {
    const callback = (value?: unknown, cm?: unknown) => {
      const view = cm ? asVimCM(cm).cm6 : undefined;
      const st = view?.state.field(optionsField, false);
      if (value === undefined) return st?.values[name] ?? defaults.get(name);
      if (!view || !st) return undefined;
      const next = { ...st.values, [name]: kind === "number" ? Number(value) : kind === "boolean" ? !!value : String(value) };
      view.dispatch({ effects: [setValues.of(next), st.compartment.reconfigure(build(editorOptionsFromValues(next)))] });
      return undefined;
    };
    (Vim.defineOption as (n: string, d: undefined, t: Kind, a: string[], cb: typeof callback) => void)(name, undefined, kind, aliases, callback);
  }
}

/** `:set` for the command line, replacing the engine's, which reads only its
 *  first argument and knows no inv-, !, +=, -= or ^=. */
function runtimeSet(cm: unknown, argString: string, scope?: string): void {
  const cfg = scope ? { scope } : undefined;
  const say = (text: string) => notify(cm, text);
  const known = (name: string) => !(Vim.getOption(name, cm as never, cfg) instanceof Error);
  for (const arg of splitSetArgs(argString)) {
    const m = /^(no|inv)?(\w+)(!|\?|&)?(?:([-+^]?=|:)([\s\S]*))?$/.exec(arg);
    if (!m) {
      say(`Invalid argument: ${arg}`);
      continue;
    }
    let [, prefix, name] = m;
    const [, , , suffix, op, raw] = m;
    if (prefix && !known(name) && known(prefix + name)) {
      name = prefix + name;
      prefix = undefined as unknown as string;
    }
    if (!known(name)) {
      say(`Unknown option: ${name}`);
      continue;
    }
    const cur = Vim.getOption(name, cm as never, cfg);
    const isBool = typeof cur === "boolean";
    if (suffix === "?" || (!isBool && !op && !prefix && suffix !== "!")) {
      say(isBool ? `${cur ? "" : "no"}${name}` : `${name}=${cur ?? ""}`);
      continue;
    }
    let value: unknown;
    if (isBool) value = prefix === "inv" || suffix === "!" ? !cur : prefix !== "no";
    else if (op) {
      const v = unescapeValue(raw ?? "");
      if (typeof cur === "number" || /^-?\d+$/.test(String(cur ?? ""))) {
        const n = Number(v);
        const c = Number(cur ?? 0);
        value = op === "+=" ? c + n : op === "-=" ? c - n : op === "^=" ? c * n : n;
      } else value = op === "=" || op === ":" ? v : listOp(String(cur ?? ""), op, v);
    } else continue;
    const err = Vim.setOption(name, value, cm as never, cfg);
    if (err instanceof Error) say(err.message);
  }
}

let setInstalled = false;

export function installRuntimeSet(): void {
  if (setInstalled) return;
  setInstalled = true;
  Vim.defineEx("set", "se", (cm, params) => runtimeSet(cm, params.argString ?? "", (params.setCfg as { scope?: string } | undefined)?.scope));
}
